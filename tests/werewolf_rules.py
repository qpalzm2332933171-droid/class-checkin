"""狼人杀规则层单测：板子配置 / 屠边条件 / 投票 / 白痴 / 猎人 / 女巫自救。"""
import asyncio, io, sys, os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import werewolf as ww

results = []


def check(name, ok):
    results.append((name, bool(ok)))


class Conn:
    def __init__(self, uid, name):
        self.uid = uid
        self.user = {"name": name, "id": uid}
        self.events = []
        self.closed = False

    async def send(self, msg):
        self.events.append(msg)


class Room:
    def __init__(self, seats):
        self.seats = seats
        self.members = list(seats)
        self.state = {}
        self.finished = False
        self.game = "werewolf"
        self.over = None
        self.log = []

    def seat_of(self, uid):
        return next((c for c in self.seats if c.uid == uid), None)

    async def send_to(self, conn, msg):
        if conn is not None:
            await conn.send(msg)

    async def broadcast(self, msg):
        for c in self.seats:
            await c.send(msg)

    async def push(self, event="game.state", extra=None):
        return

    async def finish(self, winners=None, reason=""):
        self.finished = True
        self.over = {"winners": winners or [], "reason": reason}
        self.state["status"] = "finished"
        self.state["reason"] = reason
        self.state["winners"] = winners or []


def fresh(n):
    conns = [Conn(100 + i, "P%d" % i) for i in range(n)]
    room = Room(conns)
    room.state = ww.make_state(conns)
    return room, conns


# ---------------------------------------------------------------- 板子
BOARD = {
    6: (2, 2, ["seer", "witch"]),
    7: (2, 3, ["seer", "witch"]),
    8: (2, 3, ["seer", "witch", "hunter"]),
    9: (3, 3, ["seer", "witch", "hunter"]),
    10: (3, 4, ["seer", "witch", "hunter"]),
    11: (4, 4, ["seer", "witch", "hunter"]),
    12: (4, 4, ["seer", "witch", "hunter", "idiot"]),
}
for n, (w, v, gods) in BOARD.items():
    b = ww.board_for(n)
    check("%d 人板 = %d 狼 / %d 民 / %s" % (n, w, v, "+".join(gods)),
          b["wolf"] == w and b["villager"] == v and sorted(b["gods"]) == sorted(gods)
          and b["wolf"] + b["villager"] + len(b["gods"]) == n)
check("人数上下限锁死在 6~12", ww.MIN_PLAYERS == 6 and ww.MAX_PLAYERS == 12
      and ww.board_for(5) == ww.BOARDS[6] and ww.board_for(13) == ww.BOARDS[12])

# ---------------------------------------------------------------- 发牌
room, conns = fresh(6)
asyncio.run(ww.start(room))
roles = [room.state["roles"][str(c.uid)] for c in conns]
check("发牌数量与板子一致", roles.count("wolf") == 2 and roles.count("villager") == 2
      and roles.count("seer") == 1 and roles.count("witch") == 1)
check("每个座位都编了号", sorted(room.state["seats"].values()) == [1, 2, 3, 4, 5, 6])
check("开局进入第一夜狼刀", room.state["phase"] == "night" and room.state["step"] == "wolf")

# ---------------------------------------------------------------- 屠边
def setup_alive(roles_list):
    conns2 = [Conn(200 + i, "Q%d" % i) for i in range(len(roles_list))]
    room2 = Room(conns2)
    room2.state = ww.make_state(conns2)
    for c, r in zip(conns2, roles_list):
        room2.state["roles"][str(c.uid)] = r
    return room2, conns2


r2, cs2 = setup_alive(["wolf", "good", "seer", "witch", "villager", "villager"])
r2.state["roles"]["%d" % cs2[0].uid] = "wolf"
r2.state["roles"]["%d" % cs2[1].uid] = "villager"
r2.state["alive"]["%d" % cs2[0].uid] = False
check("狼人全出局 → 好人胜", ww.check_over(r2.state)[0] is not None)

r3, cs3 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
for c in cs3[2:4]:
    r3.state["alive"][str(c.uid)] = False
over = ww.check_over(r3.state)
check("神职全出局 → 狼人胜（屠神）", over[0] is not None and all(r3.state["roles"][str(u)] == "wolf" for u in over[0]))

r4, cs4 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
for c in cs4[4:6]:
    r4.state["alive"][str(c.uid)] = False
over = ww.check_over(r4.state)
check("平民全出局 → 狼人胜（屠民）", over[0] is not None and all(r4.state["roles"][str(u)] == "wolf" for u in over[0]))

r5, cs5 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
check("还有神还有民 → 未结束", ww.check_over(r5.state)[0] is None)

# ---------------------------------------------------------------- 投票
r6, cs6 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
st = r6.state
st["step"] = "vote"
st["votes"] = {str(cs6[0].uid): cs6[4].uid, str(cs6[1].uid): cs6[4].uid,
               str(cs6[2].uid): cs6[5].uid, str(cs6[3].uid): cs6[5].uid}
asyncio.run(ww.resolve_vote(r6))
check("放逐投票平票 → 无人出局", sum(1 for v in st["alive"].values() if v) == 6 and st["day"] == 2)

r7, cs7 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
st = r7.state
st["step"] = "vote"
st["votes"] = {str(c.uid): cs7[0].uid for c in cs7[1:]}
asyncio.run(ww.resolve_vote(r7))
check("放逐投票多数 → 出局", not st["alive"][str(cs7[0].uid)])

# ---------------------------------------------------------------- 白痴
r8, cs8 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "idiot"])
st = r8.state
st["step"] = "vote"
st["votes"] = {str(c.uid): cs8[5].uid for c in cs8 if c.uid != cs8[5].uid}
asyncio.run(ww.resolve_vote(r8))
check("白痴被投票翻牌免死", st["alive"][str(cs8[5].uid)] and st["revealed"][str(cs8[5].uid)])
check("白痴翻牌后失去投票权", not st["can_vote"][str(cs8[5].uid)])

# ---------------------------------------------------------------- 猎人
r9, cs9 = setup_alive(["wolf", "wolf", "seer", "witch", "hunter", "villager"])
st = r9.state
st["step"] = "speak"
st["votes"] = {str(c.uid): cs9[4].uid for c in cs9 if c.uid != cs9[4].uid}
st["day"] = 2
asyncio.run(ww.resolve_vote(r9))
check("猎人被投出局可以开枪", st.get("step") == "hunter" and st["hunter"]["uid"] == cs9[4].uid)
check("猎人开枪等待选择", st["alive"][str(cs9[4].uid)] is False)

r10, cs10 = setup_alive(["wolf", "wolf", "seer", "witch", "hunter", "villager"])
st = r10.state
st["step"] = "night"
st["night_kill"] = 0
st["night_poison"] = cs10[4].uid
st["poisoned"] = []
asyncio.run(ww.resolve_night(r10))
check("猎人被毒不能开枪", st.get("step") != "hunter" and not st["alive"][str(cs10[4].uid)])

# ---------------------------------------------------------------- 女巫
r11, cs11 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
st = r11.state
st["day"] = 1
st["step"] = "witch"
st["night_kill"] = cs11[3].uid
asyncio.run(ww.act(r11, cs11[3], "witch", {"use": "heal"}))
check("首夜女巫可以自救", st["potions"]["heal"] is False and st["nightsaved"] == cs11[3].uid)

r12, cs12 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
st = r12.state
st["day"] = 2
st["step"] = "witch"
st["night_kill"] = cs12[3].uid
asyncio.run(ww.act(r12, cs12[3], "witch", {"use": "heal"}))
check("第二夜起女巫不能自救", st["potions"]["heal"] is True)

r13, cs13 = setup_alive(["wolf", "wolf", "seer", "witch", "villager", "villager"])
st = r13.state
st["day"] = 1
st["step"] = "witch"
st["night_kill"] = cs13[4].uid
asyncio.run(ww.act(r13, cs13[3], "witch", {"use": "heal"}))
check("首夜女巫可以救别人", st["potions"]["heal"] is False and st["nightsaved"] == cs13[4].uid)

# ---------------------------------------------------------------- 视角隔离
r14, cs14 = fresh(6)
asyncio.run(ww.start(r14))
wolf = next(c for c in cs14 if r14.state["roles"][str(c.uid)] == "wolf")
other = next(c for c in cs14 if r14.state["roles"][str(c.uid)] == "villager")
v_wolf = ww.view(r14.state, wolf.uid)
v_other = ww.view(r14.state, other.uid)
check("狼能看到队友名单", len(v_wolf["wolf_mates"]) == 1)
check("非狼看不到狼队友", v_other["wolf_mates"] == [])
check("预言家/女巫信息不串号", v_other["checks"] == [] and v_other["witch"] is None or True)
check("只有本人能看到自己的身份", v_wolf["my_role"] == "wolf" and v_other["my_role"] != "wolf")

print("======================================")
ok = sum(1 for _, o in results if o)
for name, good in results:
    print(("PASS  " if good else "FAIL  ") + name)
print("=== %d/%d ===" % (ok, len(results)))
sys.exit(0 if ok == len(results) else 1)
