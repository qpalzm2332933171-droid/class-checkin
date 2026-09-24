"""骗子酒馆（Liar's Bar）纸牌模式：4 人 · 20 张牌 · 盖牌吹牛 · 质疑开牌打俄罗斯轮盘。

规则（照 Steam 原版纸牌模式实现）：

  * 牌堆 20 张 = Q/K/A 各 6 张 + 赖子 J 2 张（J 可以当 Table 牌用）
  * 4 人各发 5 张；每轮翻开一张 Table 牌（Q/K/A 之一），全场只能"报"这张牌
  * 轮到你：盖着出 1~3 张并报数量，或者质疑上家
  * 质疑开牌：全是 Table/赖子 -> 质疑者挨枪；否则出牌者挨枪
  * 左轮：每人一把，6 个弹巢 1 颗实弹，实弹位置随机落在第 1~6 发；头顶 (x/6) 是已开枪数
  * 出完手牌：下家不质疑 -> 他就是本轮胜利者，本轮结束；下家质疑 -> 开牌判枪，本轮同样结束
  * 打光子弹的人出局，最后一个活着的人赢

状态机只有四个阶段：
  play    正常回合，可以出牌 / 质疑上家
  final   上家已经出完手牌，本轮的下家只能"质疑"或者"放过"
  reveal  开牌 + 挨枪的展示期，到点自动开下一轮
  over    对局结束
"""

import random

import db
from util import now

TABLE_RANKS = ("Q", "K", "A")
JOKER = "J"
DECK = ["Q"] * 6 + ["K"] * 6 + ["A"] * 6 + [JOKER] * 2
RANK_NAME = {"Q": "Q", "K": "K", "A": "A", JOKER: "赖子"}

HAND_SIZE = 5
MIN_PLAYERS = 4
MAX_PLAYERS = 4
MAX_PLAY = 3                 # 一手最多盖几张

TURN_SECONDS = 25            # 每回合思考时间
REVEAL_SECONDS = 7           # 开牌 + 挨枪的展示时间
CYLINDER = 6                 # 弹巢数


def secs(base):
    """阶段时长（秒）。db 里把 liar_speed 调大可以整体加速（测试/快节奏模式用）。"""
    try:
        speed = max(1, int(db.setting("liar_speed", 1) or 1))
    except Exception:  # noqa: BLE001  (数据库异常也不能把对局卡死)
        speed = 1
    return max(2, int(base) // speed)


# ---------------------------------------------------------------- 初始化
def make_state(seats):
    """seats: [Conn] —— 座位号就是列表顺序（1 号位在第一个）。"""
    order = [c.uid for c in seats]
    return {
        "status": "playing",
        "over": False,
        "phase": "play",
        "round": 0,
        "order": order,
        "names": {str(c.uid): c.user["name"] for c in seats},
        "seats": {str(c.uid): i + 1 for i, c in enumerate(seats)},
        "alive": {str(uid): True for uid in order},
        # 左轮：实弹落在第 bullet 发（1~6），fired 是已经扣过的扳机数。
        # bullet 对所有人保密（包括自己），只有 fired 是公开信息。
        "revolver": {str(uid): {"bullet": random.randint(1, CYLINDER), "fired": 0} for uid in order},
        "hands": {str(uid): [] for uid in order},
        "round_wins": {str(uid): 0 for uid in order},
        "table": "",
        "turn": 0,
        "pile": [],              # 本轮的盖牌堆 [{uid, n, cards}]，cards 开牌前不外泄
        "reveal": None,          # 开牌结果（reveal 阶段才有的公开信息）
        "log": [],
        "deadline": 0,
        "start_i": random.randrange(len(order)) if order else 0,   # 每轮先手往后轮一位
        "winners": [],
    }


# ---------------------------------------------------------------- 小工具
def alive_uids(state):
    return [u for u in state["order"] if state["alive"].get(str(u))]


def next_alive(state, uid):
    """uid 之后的下一个存活玩家（没有人就返回 0）。"""
    order = state["order"]
    if not order or uid not in order:
        return 0
    i = order.index(uid)
    for step in range(1, len(order) + 1):
        cand = order[(i + step) % len(order)]
        if state["alive"].get(str(cand)):
            return cand
    return 0


def hand_of(state, uid):
    return state["hands"].setdefault(str(uid), [])


def fired_of(state, uid):
    return int(state["revolver"].get(str(uid), {}).get("fired", 0))


def name_of(state, uid):
    return state["names"].get(str(uid), "有人")


def add_log(state, text, kind="info"):
    state["log"].append({"t": now(), "text": text, "kind": kind})
    state["log"] = state["log"][-60:]


def last_play(state):
    return state["pile"][-1] if state["pile"] else None


# ---------------------------------------------------------------- 视图
def can_do(state, uid):
    """这个观看者此刻能做什么（前端拿它决定按钮的可用状态）。"""
    nobody = {"play": False, "doubt": False, "pass": False, "max": 0}
    if not state or state.get("status") != "playing" or state.get("over"):
        return nobody
    if state.get("phase") not in ("play", "final"):
        return nobody
    if state.get("turn") != uid or not state["alive"].get(str(uid)):
        return nobody
    if state["phase"] == "final":
        # 上家已经出完手牌：只能质疑（赌一把）或者放过（承认他赢下本轮）
        return {"play": False, "doubt": True, "pass": True, "max": 0}
    hand = hand_of(state, uid)
    last = last_play(state)
    return {
        "play": bool(hand),
        "doubt": bool(last) and last["uid"] != uid,
        "pass": False,
        "max": min(MAX_PLAY, len(hand)),
    }


def view(state, uid):
    """按观看者裁剪过的状态：只有自己的手牌，别人的只剩张数。

    左轮的实弹位置对所有人保密（自己也看不到），只公开已开枪数。"""
    if not state or not state.get("order"):
        return {"waiting": True, "phase": "waiting"}
    me = str(uid)
    last = last_play(state)
    return {
        "status": state.get("status"),
        "reason": state.get("reason", ""),
        "phase": state["phase"],
        "round": state["round"],
        "table": state["table"],
        "order": state["order"],
        "names": state["names"],
        "seats": state["seats"],
        "alive": state["alive"],
        "turn": state["turn"],
        "deadline": state["deadline"],
        "round_wins": state["round_wins"],
        "winners": list(state.get("winners") or []),
        "revolver": {k: int(v.get("fired", 0)) for k, v in state["revolver"].items()},
        "cylinder": CYLINDER,
        "hand_count": {k: len(v) for k, v in state["hands"].items()},
        "pile": [{"uid": p["uid"], "n": p["n"]} for p in state["pile"]],
        "last": ({"uid": last["uid"], "n": last["n"]} if last else None),
        "pile_total": sum(p["n"] for p in state["pile"]),
        "reveal": state.get("reveal"),
        "log": state["log"][-40:],
        "my_uid": int(uid or 0),
        "my_hand": list(hand_of(state, uid)),
        "my_alive": bool(state["alive"].get(me)),
        "my_turn": state["turn"] == uid,
        "my_round_wins": int(state["round_wins"].get(me, 0)),
        "can": can_do(state, uid),
    }


# ---------------------------------------------------------------- 流程
async def announce(room, text, kind="info", toast=True):
    """记进战报。

    toast=True 才会额外推一条 game.event（客户端弹浮层提示）。
    这个游戏每回合有几十条动作，全弹 toast 会把牌桌糊满 ——
    所以只有"开牌 / 中枪 / 出局 / 结束 / 超时"这类高信号事件才配弹，
    常规的"谁盖了几张"只进战报，交给牌桌自己渲染。
    """
    add_log(room.state, text, kind)
    if toast:
        await room.broadcast({"t": "game.event", "text": text})
    await room.push("game.state")


async def start(room):
    """开局：建状态 -> announce -> 发第一轮牌。"""
    room.started = True
    room.finished = False
    room.state = make_state(room.seats)
    await room.push("game.state")
    await announce(room, "🎴 骗子酒馆开局：%d 人 · 每人 %d 张 · 牌堆 Q6 K6 A6 + 赖子 2"
                   % (len(room.seats), HAND_SIZE))
    await begin_round(room)


async def begin_round(room, starter=None):
    """发新一轮的牌，翻一张 Table 牌，指定先手。"""
    state = room.state
    alive = alive_uids(state)
    if len(alive) <= 1:
        await end(room, alive, "对手全部出局")
        return

    deck = list(DECK)
    random.shuffle(deck)
    state["round"] += 1
    state["hands"] = {str(u): [deck.pop() for _ in range(min(HAND_SIZE, len(deck)))] for u in alive}
    for u in state["order"]:
        state["hands"].setdefault(str(u), [])
    state["table"] = random.choice(TABLE_RANKS)
    state["pile"] = []
    state["reveal"] = None

    if starter is None:
        order = state["order"]
        n = len(order)
        start = state.get("start_i", 0) % n if n else 0
        for step in range(n):
            cand = order[(start + step) % n]
            if state["alive"].get(str(cand)):
                starter = cand
                state["start_i"] = (start + step + 1) % n
                break
    state["turn"] = starter or alive[0]
    state["phase"] = "play"
    state["deadline"] = now() + secs(TURN_SECONDS)

    await announce(room, "——— 第 %d 轮 · %d 人存活 ———" % (state["round"], len(alive)), toast=False)
    await announce(room, "🎯 本轮 Table 牌是【%s】，出牌只能报这张牌；%s 先手（%d 秒）"
                   % (RANK_NAME[state["table"]], name_of(state, state["turn"]), secs(TURN_SECONDS)),
                   toast=False)
    await room.push("game.state")


async def do_play(room, conn, cards):
    """盖牌出 1~MAX_PLAY 张，声称是 Table 牌。"""
    state = room.state
    uid = conn.uid
    hand = hand_of(state, uid)
    picks = []
    for raw in (cards or []):
        try:
            i = int(raw)
        except (TypeError, ValueError):
            continue
        if 0 <= i < len(hand) and i not in picks:
            picks.append(i)
    if not picks:
        await room.send_to(conn, {"t": "game.event", "text": "先点选要出的牌"})
        return False
    if len(picks) > MAX_PLAY:
        await room.send_to(conn, {"t": "game.event", "text": "一手最多盖 %d 张" % MAX_PLAY})
        return False

    picks.sort()
    played = [hand[i] for i in picks]
    for i in reversed(picks):
        hand.pop(i)
    state["pile"].append({"uid": uid, "n": len(played), "cards": played})
    name = name_of(state, uid)
    add_log(state, "%s 盖牌出了 %d 张，报「%s」" % (name, len(played), RANK_NAME[state["table"]]))

    if not hand:
        # 出完了：本轮不会立刻结束 —— 下家选择"质疑"或者"放过"
        nxt = next_alive(state, uid)
        state["phase"] = "final"
        state["turn"] = nxt
        state["deadline"] = now() + secs(TURN_SECONDS)
        await announce(room, "🔥 %s 出完了所有手牌！%s 必须选择质疑或放过（%d 秒）"
                       % (name, name_of(state, nxt), secs(TURN_SECONDS)))
        await room.push("game.state")
        return True

    state["turn"] = next_alive(state, uid)
    state["deadline"] = now() + secs(TURN_SECONDS)
    await room.push("game.state")
    return True


async def shoot(room, uid):
    """扣一次扳机：实弹落在第 bullet 发，扣到那一发就出局。"""
    state = room.state
    rev = state["revolver"][str(uid)]
    rev["fired"] = int(rev.get("fired", 0)) + 1
    died = rev["fired"] >= int(rev.get("bullet", CYLINDER))
    if died:
        state["alive"][str(uid)] = False
    return {"fired": rev["fired"], "died": died}


async def do_doubt(room, conn):
    """质疑上家：只翻开最后一手牌（不翻整堆）。"""
    state = room.state
    last = last_play(state)
    if not last:
        return False
    doubter = conn.uid
    target = last["uid"]
    truthful = all(c == state["table"] or c == JOKER for c in last["cards"])
    loser = doubter if truthful else target

    state["phase"] = "reveal"
    state["deadline"] = now() + secs(REVEAL_SECONDS)
    await announce(room, "😱 %s 质疑 %s：开牌！" % (name_of(state, doubter), name_of(state, target)),
                   toast=False)
    await announce(room, "🃏 %s 出的是 %s —— %s"
                   % (name_of(state, target), " ".join(RANK_NAME[c] for c in last["cards"]),
                      "确实是【%s】，质疑失败" % state["table"] if truthful else "根本不是【%s】，抓到撒谎" % state["table"]),
                   "good" if truthful else "bad", toast=False)

    shot = await shoot(room, loser)
    state["reveal"] = {
        "pass": False,
        "doubt_by": doubter, "doubt_by_name": name_of(state, doubter),
        "uid": target, "name": name_of(state, target),
        "n": last["n"],
        "cards": list(last["cards"]),
        "truthful": truthful,
        "loser": loser, "loser_name": name_of(state, loser),
        "shot": shot,
        "round_winner": 0, "round_winner_name": "",
    }
    await announce(room, "🔫 %s 把左轮对准自己……（第 %d 发 / 共 %d 发）"
                   % (name_of(state, loser), shot["fired"], CYLINDER), toast=False)
    if shot["died"]:
        add_log(state, "💥 枪响了！%s 出局，还剩 %d 人"
                % (name_of(state, loser), len(alive_uids(state))), "bad")
    else:
        add_log(state, "咔哒——空枪。%s 活下来了（%d/%d）"
                % (name_of(state, loser), shot["fired"], CYLINDER), "good")
    # 这条不再弹 toast：它跟中央面板说的是同一件事，而 toast 弹在顶部正好盖住
    # 对手卡片上的【质疑】【被质疑】标签 —— 恰恰是开牌那几秒最该看见的东西。
    # 改由客户端底栏播报（当事人看到"我个人"的结局，其他人看到一句短的），流水照旧进战报。
    await announce(room, "😱 %s 质疑 %s：%s，%s" % (
        name_of(state, doubter), name_of(state, target),
        "抓到撒谎" if not truthful else "开出来是真牌",
        ("%s 挨了第 %d 枪出局" % (name_of(state, loser), shot["fired"])) if shot["died"]
        else ("%s 是空枪，活下来了" % name_of(state, loser))), toast=False)
    await room.push("game.state")
    return True


async def do_pass(room, conn):
    """放过：承认上家出的最后一把，他成为本轮胜利者，本轮结束。"""
    state = room.state
    last = last_play(state)
    if not last:
        return False
    winner = last["uid"]
    state["round_wins"][str(winner)] = int(state["round_wins"].get(str(winner), 0)) + 1
    state["phase"] = "reveal"
    state["deadline"] = now() + secs(REVEAL_SECONDS)
    state["reveal"] = {
        "pass": True,
        "doubt_by": conn.uid, "doubt_by_name": name_of(state, conn.uid),
        "uid": winner, "name": name_of(state, winner),
        "n": last["n"],
        "cards": None,
        "truthful": None,
        "loser": 0, "loser_name": "",
        "shot": None,
        "round_winner": winner, "round_winner_name": name_of(state, winner),
    }
    await announce(room, "🤝 %s 选择了放过，%s 出完手牌赢下本轮（累计 %d 轮）"
                   % (name_of(state, conn.uid), name_of(state, winner), state["round_wins"][str(winner)]),
                   "good")
    await room.push("game.state")
    return True


async def auto_turn(room):
    """超时兜底：自动出 1 张（可能是撒谎），final 阶段则自动放过。"""
    state = room.state
    uid = state["turn"]
    conn = room.seat_of(uid)
    if conn is None:
        # 座位已经不在了，直接把回合交给下一个人，别把整局卡死
        nxt = next_alive(state, uid)
        if not nxt:
            await end(room, alive_uids(state), "有人掉线")
            return
        state["turn"] = nxt
        state["deadline"] = now() + secs(TURN_SECONDS)
        await room.push("game.state")
        return
    if state["phase"] == "final":
        await announce(room, "⏰ %s 超时，自动放过" % name_of(state, uid))
        await do_pass(room, conn)
        return
    hand = hand_of(state, uid)
    if not hand:
        nxt = next_alive(state, uid)
        state["turn"] = nxt
        state["deadline"] = now() + secs(TURN_SECONDS)
        await room.push("game.state")
        return
    await announce(room, "⏰ %s 超时，自动盖牌出 1 张" % name_of(state, uid))
    await do_play(room, conn, [random.randrange(len(hand))])


async def resolve_reveal(room):
    """展示期结束：有人被杀光就收场，否则开下一轮。"""
    state = room.state
    alive = alive_uids(state)
    if len(alive) <= 1:
        await end(room, alive, "其他人全部出局" if alive else "没有人活下来")
        return
    await begin_round(room)


async def end(room, winners, reason):
    state = room.state
    state["over"] = True
    state["status"] = "finished"
    state["phase"] = "over"
    state["winners"] = list(winners or [])
    state["deadline"] = 0
    text = "、".join(name_of(state, u) for u in (winners or [])) or "无人"
    rounds = "，".join("%s %d 轮" % (name_of(state, u), state["round_wins"].get(str(u), 0))
                      for u in state["order"] if state["alive"].get(str(u)) or u in (winners or []))
    await announce(room, "🏁 游戏结束：%s 活到了最后（%s）" % (text, reason))
    if rounds:
        await announce(room, "📊 本轮胜利次数：%s" % rounds, toast=False)
    await room.finish(winners=list(winners or []), reason=reason)


# ---------------------------------------------------------------- 玩家动作
async def act(room, conn, action, msg):
    state = room.state
    if not state.get("order") or state.get("status") != "playing" or state.get("over"):
        return True
    uid = conn.uid
    if not state["alive"].get(str(uid)):
        await room.send_to(conn, {"t": "game.event", "text": "你已经出局了，只能围观"})
        return True
    if state.get("phase") not in ("play", "final"):
        return True
    if state.get("turn") != uid:
        await room.send_to(conn, {"t": "game.event", "text": "还没轮到你"})
        return True

    if action == "play":
        if state["phase"] == "final":
            await room.send_to(conn, {"t": "game.event", "text": "上家已经出完了，你只能质疑或放过"})
            return True
        return await do_play(room, conn, msg.get("cards"))

    if action == "doubt":
        if not state["pile"]:
            await room.send_to(conn, {"t": "game.event", "text": "你是本轮第一个出牌的，没有牌可以质疑"})
            return True
        return await do_doubt(room, conn)

    if action == "pass":
        if state["phase"] != "final":
            await room.send_to(conn, {"t": "game.event", "text": "现在只能出牌或者质疑"})
            return True
        return await do_pass(room, conn)

    return False


# ---------------------------------------------------------------- 推进
async def tick(room):
    """由全局 ticker 定时调用（每 2 秒一跳）：处理回合计时与开牌展示期。"""
    state = room.state
    if not state.get("order") or state.get("status") != "playing" or state.get("over") or room.finished:
        return
    deadline = state.get("deadline", 0)
    if not deadline or now() < deadline:
        return
    phase = state.get("phase")
    if phase in ("play", "final"):
        await auto_turn(room)
    elif phase == "reveal":
        await resolve_reveal(room)


# ---------------------------------------------------------------- 中途退出
async def drop(room, uid, name):
    """中途退出/掉线判负：直接算他出局（手牌作废），可能直接分出胜负。"""
    state = room.state
    if not state.get("order") or state.get("over"):
        return False
    uid = int(uid)
    if not state["alive"].get(str(uid)):
        return False
    state["alive"][str(uid)] = False
    state["hands"][str(uid)] = []
    add_log(state, "🚪 %s 中途退出，直接出局" % name, "bad")

    if state.get("turn") == uid and state.get("phase") in ("play", "final"):
        # 他盖的牌跟着一起作废；如果整堆都没了，下一个人可以自由出牌
        state["pile"] = [p for p in state["pile"] if p["uid"] != uid]
        nxt = next_alive(state, uid)
        if not state["pile"]:
            state["phase"] = "play"
        if not nxt:
            await end(room, alive_uids(state), "%s 中途退出" % name)
            return True
        state["turn"] = nxt
        state["deadline"] = now() + secs(TURN_SECONDS)

    alive = alive_uids(state)
    if len(alive) <= 1:
        await end(room, alive, "%s 中途退出" % name)
        return True
    await room.push("game.state")
    return False
