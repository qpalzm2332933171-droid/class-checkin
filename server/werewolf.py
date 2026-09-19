"""狼人杀：标准板子 + 夜晚/白天状态机（服务端权威，客户端只负责显示和点人）。

板子严格照主流正规配置（"预女猎白"体系）：

  人数   狼人  平民   神职
   6     2     2     预言家、女巫
   7     2     3     预言家、女巫
   8     2     3     预言家、女巫、猎人
   9     3     3     预言家、女巫、猎人
  10     3     4     预言家、女巫、猎人
  11     4     4     预言家、女巫、猎人
  12     4     4     预言家、女巫、猎人、白痴    <- 经典"预女猎白"标准局

规则（按正规局实现）：
  * 夜晚顺序：狼人刀人 -> 预言家验人 -> 女巫用药
  * 女巫解药、毒药各一瓶，每晚最多用一瓶；首夜可以自救，第二夜起不能自救
  * 猎人被狼刀死或被投票出局可以开枪带走一人；被女巫毒死**不能**开枪
  * 白痴被投票出局时翻牌免死，但之后失去投票权（仍然算存活）
  * 狼人刀人平票时在平票目标里随机（正规局由狼内部商量，线上用随机兜底）
  * 放逐投票平票则本轮无人出局
  * 胜利条件（屠边）：狼人全部出局 -> 好人胜；神职全部出局 或 平民全部出局 -> 狼人胜
"""

import random

import db
from util import now

ROLES = {
    "wolf": {"name": "狼人", "team": "wolf", "god": False},
    "villager": {"name": "村民", "team": "good", "god": False},
    "seer": {"name": "预言家", "team": "good", "god": True},
    "witch": {"name": "女巫", "team": "good", "god": True},
    "hunter": {"name": "猎人", "team": "good", "god": True},
    "idiot": {"name": "白痴", "team": "good", "god": True},
}

BOARDS = {
    6: {"wolf": 2, "villager": 2, "gods": ["seer", "witch"]},
    7: {"wolf": 2, "villager": 3, "gods": ["seer", "witch"]},
    8: {"wolf": 2, "villager": 3, "gods": ["seer", "witch", "hunter"]},
    9: {"wolf": 3, "villager": 3, "gods": ["seer", "witch", "hunter"]},
    10: {"wolf": 3, "villager": 4, "gods": ["seer", "witch", "hunter"]},
    11: {"wolf": 4, "villager": 4, "gods": ["seer", "witch", "hunter"]},
    12: {"wolf": 4, "villager": 4, "gods": ["seer", "witch", "hunter", "idiot"]},
}

MIN_PLAYERS = 6
MAX_PLAYERS = 12

NIGHT_SECONDS = 50          # 狼人刀人
SEER_SECONDS = 30           # 预言家验人
WITCH_SECONDS = 35          # 女巫用药
ANNOUNCE_SECONDS = 22       # 公布死讯
STEP_PAUSE = 5              # 全员行动完之后停几秒再进下一阶段（别跳太快）
HUNTER_SECONDS = 30         # 猎人开枪
SPEAK_SECONDS = 90          # 白天发言
VOTE_SECONDS = 45           # 放逐投票


def secs(base):
    """阶段时长（秒）。db 里把 ww_speed 调大可以整体加速（测试/快节奏模式用）。"""
    try:
        speed = max(1, int(db.setting("ww_speed", 1) or 1))
    except Exception:  # noqa: BLE001  (数据库异常也不能把对局卡死)
        speed = 1
    return max(5, int(base) // speed)


def board_for(count):
    """按人数给出板子；不在表里就取最接近的。"""
    if count in BOARDS:
        return BOARDS[count]
    nearest = min(BOARDS, key=lambda k: (abs(k - count), k))
    return BOARDS[nearest]


def board_summary(count):
    board = board_for(count)
    return {
        "players": count,
        "wolf": board["wolf"],
        "villager": board["villager"],
        "gods": list(board["gods"]),
        "gods_text": "、".join(ROLES[g]["name"] for g in board["gods"]),
    }


BOARD_TABLE = " / ".join(
    "%d人：%d狼 %d民 %s" % (n, BOARDS[n]["wolf"], BOARDS[n]["villager"],
                          "、".join(ROLES[g]["name"] for g in BOARDS[n]["gods"]))
    for n in sorted(BOARDS)
)


# ---------------------------------------------------------------- 初始化
def make_state(seats):
    """seats: [Conn] —— 座位号就是列表顺序（1 号位在第一个）。"""
    order = [c.uid for c in seats]
    plan = board_for(len(order))
    roles = ["wolf"] * plan["wolf"] + ["villager"] * plan["villager"] + list(plan["gods"])
    while len(roles) < len(order):          # 兜底，理论上不会发生
        roles.append("villager")
    roles = roles[:len(order)]
    random.shuffle(roles)
    return {
        "status": "playing",
        "phase": "night",
        "step": "wolf",
        "day": 1,
        "order": order,
        "seats": {str(c.uid): i + 1 for i, c in enumerate(seats)},
        "names": {str(c.uid): c.user["name"] for c in seats},
        "roles": {str(uid): role for uid, role in zip(order, roles)},
        "alive": {str(uid): True for uid in order},
        "revealed": {},                     # 白痴翻牌
        "can_vote": {str(uid): True for uid in order},
        "potions": {"heal": True, "poison": True},
        "wolf_votes": {},
        "seer": {"target": 0, "done": False},
        "checks": [],                       # 预言家的验人记录（只给他自己看）
        "witch": {"seen": 0, "done": False, "save": False, "poison": 0},
        "night_kill": 0,
        "night_poison": 0,
        "nightsaved": 0,
        "poisoned": [],
        "last_deaths": [],
        "hunter": {"uid": 0, "target": 0, "done": True, "resume": ""},
        "votes": {},
        "vote_result": None,
        "log": [],
        "deadline": 0,
        "winners": [],
        "board": board_summary(len(order)),
        "over": False,
    }


# ---------------------------------------------------------------- 小工具
def role_of(state, uid):
    return state["roles"].get(str(uid), "")


def alive_of(state, uid):
    return bool(state["alive"].get(str(uid)))


def alive_uids(state):
    return [u for u in state["order"] if state["alive"].get(str(u))]


def alive_with_role(state, role):
    return [u for u in state["order"] if state["alive"].get(str(u)) and state["roles"].get(str(u)) == role]


def role_count(state, role):
    return len(alive_with_role(state, role))


def add_log(state, text, kind="info"):
    state["log"].append({"text": text, "kind": kind, "day": state["day"], "at": now()})
    state["log"] = state["log"][-60:]


def wolf_target(state):
    """狼人投票结算：票最多的，平票随机；全员空刀 = 不杀。"""
    tally = {}
    for uid, target in state["wolf_votes"].items():
        if not state["alive"].get(str(uid)):
            continue
        if not target:
            continue
        tally[int(target)] = tally.get(int(target), 0) + 1
    if not tally:
        return 0
    top = max(tally.values())
    return random.choice([t for t, n in tally.items() if n == top])


def check_over(state):
    """返回 (winners_list, reason) 或 (None, "")。屠边规则。"""
    wolves = role_count(state, "wolf")
    if wolves == 0:
        return alive_uids(state), "狼人全部出局"
    gods = [u for u in alive_uids(state) if ROLES.get(state["roles"].get(str(u)), {}).get("god")]
    villagers = [u for u in alive_uids(state) if state["roles"].get(str(u)) == "villager"]
    if not gods:
        return alive_with_role(state, "wolf"), "神职全部出局"
    if not villagers:
        return alive_with_role(state, "wolf"), "平民全部出局"
    return None, ""


def _winner_team(state):
    """胜方阵营："wolf" / "good" / ""（未结束）。"""
    win = list(state.get("winners") or [])
    if not win:
        return ""
    return "wolf" if all(state["roles"].get(str(u)) == "wolf" for u in win) else "good"


def view(state, uid):
    """按观看者裁剪过的状态：身份、狼队友、验人、女巫信息都只给本人。"""
    me = str(uid)
    role = state["roles"].get(me, "")
    out = {
        "status": state.get("status"),
        "reason": state.get("reason", ""),
        "phase": state["phase"],
        "step": state["step"],
        "day": state["day"],
        "deadline": state["deadline"],
        "order": state["order"],
        "seats": state["seats"],
        "names": state["names"],
        "alive": state["alive"],
        "revealed": state["revealed"],
        "can_vote": state["can_vote"],
        "last_deaths": state["last_deaths"],
        "vote_result": state["vote_result"],
        "log": state["log"][-40:],
        "board": state["board"],
        "winners": list(state.get("winners") or []),
        "winner_team": _winner_team(state),
        "my_team": ROLES.get(role, {}).get("team", ""),
        "my_role": role,
        "my_role_name": ROLES.get(role, {}).get("name", ""),
        "my_seat": state["seats"].get(me, 0),
        "my_alive": bool(state["alive"].get(me)),
        "can_vote_now": bool(state["can_vote"].get(me)),
        "wolf_mates": [],
        "checks": [],
        "wolf_votes": [],
        "witch": None,
    }
    if role == "wolf":
        out["wolf_mates"] = [{"uid": u, "name": state["names"].get(str(u), ""),
                              "alive": bool(state["alive"].get(str(u)))}
                             for u in state["order"]
                             if state["roles"].get(str(u)) == "wolf" and str(u) != me]
        out["wolf_votes"] = [u for u in state["wolf_votes"] if state["alive"].get(str(u))]
    if role == "seer":
        out["checks"] = list(state["checks"])
    if role == "witch":
        out["witch"] = {
            "heal": state["potions"]["heal"],
            "poison": state["potions"]["poison"],
            "seen": state["witch"].get("seen", 0) if state["step"] == "witch" else 0,
            "done": state["witch"].get("done", False),
            "self_save": state["day"] == 1,
        }
    out["voted"] = [u for u in state["votes"] if state["alive"].get(str(u))]
    return out


# ---------------------------------------------------------------- 流程
async def announce(room, text, kind="info"):
    add_log(room.state, text, kind)
    await room.broadcast({"t": "game.event", "text": text})
    await room.push("game.state")


async def start(room):
    """开局：洗牌发身份，然后进入第一夜。"""
    room.started = True
    room.finished = False
    room.state = make_state(room.seats)
    for conn in room.seats:
        role = role_of(room.state, conn.uid)
        await room.send_to(conn, {"t": "game.event",
                                  "text": "你的身份是【%s】，座位 %d 号" % (ROLES[role]["name"],
                                                                        room.state["seats"][str(conn.uid)])})
    await room.push("game.state")
    await announce(room, "身份已发放，共 %d 人：%d 狼人 / %d 平民 / %s"
                   % (len(room.seats), room.state["board"]["wolf"], room.state["board"]["villager"],
                      room.state["board"]["gods_text"]))
    await enter_night(room)


async def enter_night(room):
    state = room.state
    state["phase"] = "night"
    state["step"] = "wolf"
    state["wolf_votes"] = {}
    state["seer"] = {"target": 0, "done": False}
    state["witch"] = {"seen": 0, "done": False, "save": False, "poison": 0}
    state["night_kill"] = 0
    state["night_poison"] = 0
    state["nightsaved"] = 0
    state["poisoned"] = []
    state["votes"] = {}
    state["vote_result"] = None
    state["deadline"] = now() + secs(NIGHT_SECONDS)
    state["hold_until"] = 0
    await announce(room, "🌙 第 %d 夜 · 天黑请闭眼，全体闭眼" % state["day"])
    await announce(room, "🐺 狼人请睁眼，商量今晚要刀谁（%d 秒）" % secs(NIGHT_SECONDS))


async def enter_seer(room):
    state = room.state
    state["step"] = "seer"
    state["hold_until"] = 0
    state["deadline"] = now() + secs(SEER_SECONDS)
    seer = alive_with_role(state, "seer")
    await announce(room, "🐺 狼人请闭眼。🔮 预言家请睁眼，选择要验的人（%d 秒）" % secs(SEER_SECONDS))
    if not seer:
        await enter_witch(room)
        return
    await room.push("game.state")
    await room.send_to(room.seat_of(seer[0]), {"t": "game.event", "text": "🔮 轮到你验人"})


async def enter_witch(room):
    state = room.state
    state["step"] = "witch"
    state["hold_until"] = 0
    state["deadline"] = now() + secs(WITCH_SECONDS)
    state["witch"]["seen"] = state["night_kill"]
    state["witch"]["done"] = False
    witch = alive_with_role(state, "witch")
    await announce(room, "🔮 预言家请闭眼。🧪 女巫请睁眼（%d 秒）" % secs(WITCH_SECONDS))
    if not witch:
        await resolve_night(room)
        return
    await room.push("game.state")
    if state["night_kill"]:
        await room.send_to(room.seat_of(witch[0]),
                           {"t": "game.event",
                            "text": "🧪 今晚 %s 倒牌了，你要用解药吗？" % state["names"].get(str(state["night_kill"]), "有人")})
    else:
        await room.send_to(room.seat_of(witch[0]), {"t": "game.event", "text": "🧪 今晚是平安夜，你要用毒药吗？"})


async def resolve_night(room):
    state = room.state
    deaths = []
    if state["night_kill"] and state["night_kill"] != state["nightsaved"]:
        deaths.append(state["night_kill"])
    if state["night_poison"]:
        deaths.append(state["night_poison"])
        state["poisoned"].append(state["night_poison"])
    deaths = [u for u in dict.fromkeys(deaths) if state["alive"].get(str(u))]
    for uid in deaths:
        state["alive"][str(uid)] = False
    state["last_deaths"] = deaths
    state["phase"] = "day"
    state["hold_until"] = 0

    names = [state["names"].get(str(u), "?") for u in deaths]
    if not names:
        await announce(room, "☀️ 天亮了，昨晚是平安夜", "good")
    else:
        await announce(room, "☀️ 天亮了，昨晚倒牌的是：%s" % "、".join(names), "bad")

    hunter = next((u for u in deaths if state["roles"].get(str(u)) == "hunter"
                   and u not in state["poisoned"]), 0)
    if hunter:
        await enter_hunter(room, hunter, "after_night")
        return
    wins, reason = check_over(state)
    if wins is not None:
        await end(room, wins, reason)
        return
    await enter_speak(room)


async def enter_hunter(room, uid, resume):
    state = room.state
    state["step"] = "hunter"
    state["hunter"] = {"uid": uid, "target": 0, "done": False, "resume": resume}
    state["hold_until"] = 0
    state["deadline"] = now() + secs(HUNTER_SECONDS)
    await room.push("game.state")
    await room.broadcast({"t": "game.event",
                          "text": "🔫 %s 是猎人，可以开枪带走一个人（%d 秒内选择）"
                                  % (state["names"].get(str(uid), "有人"), secs(HUNTER_SECONDS))})
    await room.send_to(room.seat_of(uid), {"t": "game.event", "text": "🔫 你是猎人，请选择带走谁（也可以放弃）"})


async def resolve_hunter(room):
    state = room.state
    info = state["hunter"]
    target = int(info.get("target") or 0)
    if target and state["alive"].get(str(target)):
        state["alive"][str(target)] = False
        state["last_deaths"] = list(state["last_deaths"]) + [target]
        await announce(room, "🔫 猎人带走了 %s" % state["names"].get(str(target), "有人"), "bad")
    else:
        await announce(room, "🔫 猎人没有开枪")
    state["hunter"] = {"uid": 0, "target": 0, "done": True, "resume": ""}
    wins, reason = check_over(state)
    if wins is not None:
        await end(room, wins, reason)
        return
    if info.get("resume") == "after_vote":
        await next_night(room)
    else:
        await enter_speak(room)


async def enter_speak(room):
    state = room.state
    state["phase"] = "day"
    state["step"] = "speak"
    state["hold_until"] = 0
    state["deadline"] = now() + secs(SPEAK_SECONDS)
    state["votes"] = {}
    state["vote_result"] = None
    await announce(room, "💬 天亮了，白天讨论 %d 秒，然后投票放逐" % secs(SPEAK_SECONDS))


async def enter_vote(room):
    state = room.state
    state["step"] = "vote"
    state["hold_until"] = 0
    state["deadline"] = now() + secs(VOTE_SECONDS)
    state["votes"] = {}
    await announce(room, "🗳️ 发言结束，请投票放逐你认为的狼人（%d 秒，可弃票）" % secs(VOTE_SECONDS))


async def resolve_vote(room):
    state = room.state
    tally = {}
    for uid in state["order"]:
        if not state["alive"].get(str(uid)) or not state["can_vote"].get(str(uid)):
            continue
        target = int(state["votes"].get(str(uid)) or 0)
        if target and state["alive"].get(str(target)):
            tally[target] = tally.get(target, 0) + 1
    if not tally:
        state["vote_result"] = {"out": 0, "tie": False, "tally": []}
        await announce(room, "🗳️ 全员弃票，本轮无人出局", "info")
        await next_night(room)
        return
    top = max(tally.values())
    tied = sorted(t for t, n in tally.items() if n == top)
    rows = [{"uid": t, "name": state["names"].get(str(t), "?"), "count": n}
            for t, n in sorted(tally.items(), key=lambda kv: -kv[1])]
    if len(tied) > 1:
        state["vote_result"] = {"out": 0, "tie": True, "tally": rows}
        await announce(room, "🗳️ 平票（%s），本轮无人出局"
                       % "、".join(state["names"].get(str(t), "?") for t in tied), "info")
        await next_night(room)
        return

    out = tied[0]
    state["vote_result"] = {"out": out, "tie": False, "tally": rows}
    role = state["roles"].get(str(out), "")

    if role == "idiot" and not state["revealed"].get(str(out)):
        state["revealed"][str(out)] = True
        state["can_vote"][str(out)] = False
        await announce(room, "🃏 %s 是白痴，翻牌免死，但之后不能再投票"
                       % state["names"].get(str(out), "有人"), "info")
        await next_night(room)
        return

    state["alive"][str(out)] = False
    state["last_deaths"] = [out]
    await announce(room, "🗳️ %s 被投票放逐，身份是【%s】"
                   % (state["names"].get(str(out), "有人"), ROLES.get(role, {}).get("name", "?")), "bad")

    if role == "hunter":
        await enter_hunter(room, out, "after_vote")
        return
    wins, reason = check_over(state)
    if wins is not None:
        await end(room, wins, reason)
        return
    await next_night(room)


async def next_night(room):
    room.state["day"] += 1
    await enter_night(room)


async def end(room, winners, reason):
    state = room.state
    state["over"] = True
    state["winners"] = list(winners or [])
    state["vote_result"] = state.get("vote_result")
    role_text = "、".join("%s=%s" % (state["names"].get(str(u), "?"), ROLES.get(state["roles"].get(str(u)), {}).get("name", "?"))
                         for u in state["order"])
    await announce(room, "🏁 游戏结束：%s（%s）。全员身份：%s" % (reason, "好人胜" if _is_good_win(state) else "狼人胜", role_text))
    await room.finish(winners=list(winners or []), reason=reason)


def _is_good_win(state):
    return all(state["roles"].get(str(u)) != "wolf" for u in state["order"]
               if state["alive"].get(str(u)))


# ---------------------------------------------------------------- 玩家动作
async def act(room, conn, action, msg):
    state = room.state
    if state.get("status") != "playing" or state.get("over"):
        return True
    uid = conn.uid
    target = int(msg.get("target") or 0)

    if action == "wolf_kill":
        if state["step"] != "wolf" or state["roles"].get(str(uid)) != "wolf" or not state["alive"].get(str(uid)):
            return True
        if target and (not state["alive"].get(str(target)) or state["roles"].get(str(target)) == "wolf"):
            await room.send_to(conn, {"t": "game.event", "text": "不能刀狼队友，也不能刀已出局的人"})
            return True
        state["wolf_votes"][str(uid)] = target
        await room.push("game.state")
        await tick(room)
        return True

    if action == "seer_check":
        if state["step"] != "seer" or state["roles"].get(str(uid)) != "seer" or not state["alive"].get(str(uid)):
            return True
        if not target or not state["alive"].get(str(target)) or target == uid:
            await room.send_to(conn, {"t": "game.event", "text": "请选择一个其他人"})
            return True
        is_wolf = state["roles"].get(str(target)) == "wolf"
        state["checks"].append({"day": state["day"], "uid": target,
                                "name": state["names"].get(str(target), ""), "wolf": is_wolf})
        state["seer"]["done"] = True
        await room.send_to(conn, {"t": "game.event",
                                  "text": "🔮 %s 是%s" % (state["names"].get(str(target), ""),
                                                        "狼人！" if is_wolf else "好人")})
        await room.push("game.state")
        await tick(room)
        return True

    if action == "witch":
        if state["step"] != "witch" or state["roles"].get(str(uid)) != "witch" or not state["alive"].get(str(uid)):
            return True
        use = (msg.get("use") or "").strip()
        if use == "heal":
            if not state["potions"]["heal"]:
                await room.send_to(conn, {"t": "game.event", "text": "解药已经用过了"})
                return True
            if not state["night_kill"]:
                await room.send_to(conn, {"t": "game.event", "text": "今晚没人倒牌，不用解药"})
                return True
            if state["night_kill"] == uid and state["day"] > 1:
                await room.send_to(conn, {"t": "game.event", "text": "第二夜起女巫不能自救"})
                return True
            state["potions"]["heal"] = False
            state["nightsaved"] = state["night_kill"]
            await room.send_to(conn, {"t": "game.event", "text": "🧪 你用了解药"})
        elif use == "poison":
            if not state["potions"]["poison"]:
                await room.send_to(conn, {"t": "game.event", "text": "毒药已经用过了"})
                return True
            if not target or not state["alive"].get(str(target)):
                await room.send_to(conn, {"t": "game.event", "text": "请选择一个存活的人"})
                return True
            state["potions"]["poison"] = False
            state["night_poison"] = target
            await room.send_to(conn, {"t": "game.event", "text": "🧪 你毒了 %s" % state["names"].get(str(target), "")})
        state["witch"]["done"] = True
        await room.push("game.state")
        await tick(room)
        return True

    if action == "hunter":
        if state["step"] != "hunter" or state["hunter"].get("uid") != uid:
            return True
        state["hunter"]["target"] = target
        state["hunter"]["done"] = True
        await tick(room)
        return True

    if action == "vote":
        if state["step"] != "vote" or not state["alive"].get(str(uid)) or not state["can_vote"].get(str(uid)):
            return True
        if target and (not state["alive"].get(str(target)) or target == uid):
            await room.send_to(conn, {"t": "game.event", "text": "不能投自己，也不能投已出局的人"})
            return True
        state["votes"][str(uid)] = target
        await room.push("game.state")
        await tick(room)
        return True

    return False


# ---------------------------------------------------------------- 推进
async def tick(room):
    """由全局 ticker 定时调用，也由玩家动作即时触发。"""
    state = room.state
    if state.get("status") != "playing" or state.get("over") or room.finished:
        return
    step = state.get("step")
    overdue = now() >= state.get("deadline", 0)

    async def hold():
        """全员都行动完了：先停 STEP_PAUSE 秒把提示念完，再进下一阶段。"""
        if not state.get("hold_until"):
            state["hold_until"] = now() + STEP_PAUSE
            await room.push("game.state")
            return True
        return now() < state["hold_until"]

    if step == "wolf":
        wolves = alive_with_role(state, "wolf")
        voted = [u for u in wolves if str(u) in state["wolf_votes"]]
        done = bool(wolves) and len(voted) == len(wolves)
        if done and not overdue and await hold():
            return
        if overdue or done:
            state["hold_until"] = 0
            state["night_kill"] = wolf_target(state)
            if state["night_kill"]:
                add_log(state, "🐺 狼人已经动了刀", "info")
            await enter_seer(room)
    elif step == "seer":
        done = state["seer"].get("done") or not alive_with_role(state, "seer")
        if done and not overdue and await hold():
            return
        if overdue or done:
            state["hold_until"] = 0
            await enter_witch(room)
    elif step == "witch":
        done = state["witch"].get("done") or not alive_with_role(state, "witch")
        if done and not overdue and await hold():
            return
        if overdue or done:
            state["hold_until"] = 0
            await resolve_night(room)
    elif step == "hunter":
        if state["hunter"].get("done") and not overdue and await hold():
            return
        if overdue or state["hunter"].get("done"):
            state["hold_until"] = 0
            await resolve_hunter(room)
    elif step == "speak":
        if overdue:
            await enter_vote(room)
    elif step == "vote":
        voters = [u for u in state["order"]
                  if state["alive"].get(str(u)) and state["can_vote"].get(str(u))]
        voted = [u for u in voters if str(u) in state["votes"]]
        done = bool(voters) and len(voted) == len(voters)
        if done and not overdue and await hold():
            return
        if overdue or done:
            state["hold_until"] = 0
            await resolve_vote(room)


# ---------------------------------------------------------------- 中途退出
async def drop(room, uid, name):
    """中途退出/掉线判负：直接算他出局（不能投票也不能开枪），可能直接分出胜负。"""
    state = room.state
    if not state.get("roles") or state.get("over"):
        return False
    uid = int(uid)
    state["alive"][str(uid)] = False
    state["can_vote"][str(uid)] = False
    state["votes"].pop(str(uid), None)
    state["wolf_votes"].pop(str(uid), None)
    add_log(state, "🚪 %s 中途退出，直接出局" % name, "bad")
    if state.get("hunter", {}).get("uid") == uid and not state["hunter"].get("done"):
        state["hunter"]["done"] = True
    wins, reason = check_over(state)
    if wins is not None:
        await end(room, wins, reason + "（有人中途退出）")
        return True
    await room.push("game.state")
    await tick(room)
    return False
