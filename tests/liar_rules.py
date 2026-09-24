"""骗子酒馆规则层单测：牌堆 / 发牌 / 出牌 / 质疑开牌 / 左轮 / 出完手牌 / 视角隔离 / 超时。

不启服务器，用假 Room + 假 Conn 直接驱动状态机，改完逻辑几秒就能跑一遍。
用法: python tests/liar_rules.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import liar

results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))


class Conn:
    def __init__(self, uid, name):
        self.uid = uid
        self.user = {"name": name, "id": uid}
        self.events = []
        self.closed = False

    async def send(self, msg):
        self.events.append(msg)

    def said(self, needle):
        return any(needle in (m.get("text") or "") for m in self.events)


class Room:
    def __init__(self, seats):
        self.seats = seats
        self.members = list(seats)
        self.state = {}
        self.finished = False
        self.started = False
        self.game = "liar"
        self.over = None

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

    async def finish(self, winners=None, reason="", extra_losers=None):
        self.finished = True
        self.started = False
        self.over = {"winners": winners or [], "reason": reason}
        self.state["status"] = "finished"
        self.state["reason"] = reason
        self.state["winners"] = winners or []


def fresh(n=4):
    conns = [Conn(100 + i, "P%d" % i) for i in range(n)]
    room = Room(conns)
    asyncio.run(liar.start(room))
    return room, conns


def give_turn(room, conn, phase="play"):
    """把回合交给指定玩家，方便逐条验证规则。"""
    room.state["turn"] = conn.uid
    room.state["phase"] = phase
    room.state["deadline"] = 0


def set_hand(room, conn, cards):
    room.state["hands"][str(conn.uid)] = list(cards)


def table(room, rank):
    room.state["table"] = rank


def act(room, conn, what, **kw):
    return asyncio.run(liar.act(room, conn, what, kw))


# ---------------------------------------------------------------- 牌堆与发牌
check("牌堆 = Q6 + K6 + A6 + 赖子2 = 20 张",
      sorted(liar.DECK) == sorted(["Q"] * 6 + ["K"] * 6 + ["A"] * 6 + ["J"] * 2)
      and len(liar.DECK) == 20)
check("人数锁死在 4 人（20 张刚好分完）",
      liar.MIN_PLAYERS == 4 and liar.MAX_PLAYERS == 4 and liar.HAND_SIZE == 5
      and liar.MIN_PLAYERS * liar.HAND_SIZE == len(liar.DECK))

room, conns = fresh()
st = room.state
all_cards = [c for u in st["order"] for c in st["hands"][str(u)]]
check("4 人各发 5 张，手牌总量 = 20", all(len(st["hands"][str(c.uid)]) == 5 for c in conns)
      and len(all_cards) == 20)
check("发出去的手牌和牌堆完全一致（没多发也没漏发）",
      sorted(all_cards) == sorted(liar.DECK))
check("Table 牌只可能是 Q/K/A", st["table"] in liar.TABLE_RANKS)
check("开局是第 1 轮、全员存活、无人开枪",
      st["round"] == 1 and all(st["alive"].values()) and all(v["fired"] == 0 for v in st["revolver"].values()))
check("先手是存活玩家之一", st["turn"] in st["order"])

# ---------------------------------------------------------------- 出牌规则
room, conns = fresh()
p0, p1 = conns[0], conns[1]
give_turn(room, p0)
table(room, "Q")
check("本轮第一个出牌的人不能质疑（没有上家）",
      liar.can_do(room.state, p0.uid)["doubt"] is False
      and liar.can_do(room.state, p0.uid)["play"] is True)

set_hand(room, p0, ["Q", "K", "J", "A", "Q"])
act(room, p0, "play", cards=[0, 2])
check("盖 2 张后手牌从 5 变 3", len(room.state["hands"][str(p0.uid)]) == 3)
check("牌堆记下这一手（张数 + 真实牌面）",
      room.state["pile"][-1] == {"uid": p0.uid, "n": 2, "cards": ["Q", "J"]})
check("出牌后回合交给下家", room.state["turn"] == p1.uid)
check("下家可以质疑上家", liar.can_do(room.state, p1.uid)["doubt"] is True)

before = len(room.state["hands"][str(p0.uid)])
act(room, p0, "play", cards=[0])
check("没轮到你的时候出牌无效", len(room.state["hands"][str(p0.uid)]) == before)

act(room, p1, "play", cards=[])
check("一张都不选 -> 拒绝并提示", p1.said("先点选要出的牌"))

act(room, p1, "play", cards=[0, 1, 2, 3, 4])
check("一手最多 3 张", p1.said("最多盖 3 张"))

# ---------------------------------------------------------------- 质疑：撒谎被抓
room, conns = fresh()
p0, p1 = conns[0], conns[1]
give_turn(room, p0)
table(room, "Q")
set_hand(room, p0, ["K", "K", "K"])
room.state["revolver"][str(p0.uid)] = {"bullet": 1, "fired": 0}
act(room, p0, "play", cards=[0, 1])
check("（前置）P0 谎报 2 张 Q，实际是 2 张 K", room.state["pile"][-1]["cards"] == ["K", "K"])
act(room, p1, "doubt")
rev = room.state["reveal"]
check("撒谎被翻开 -> 出牌者挨枪", rev["truthful"] is False and rev["loser"] == p0.uid)
check("开牌信息里带着真实牌面", rev["cards"] == ["K", "K"])
check("实弹在第 1 发 -> 一枪毙命", rev["shot"]["died"] is True
      and room.state["alive"][str(p0.uid)] is False)
check("开牌后进入展示期（phase=reveal）", room.state["phase"] == "reveal")

# ---------------------------------------------------------------- 质疑：真话被冤枉
room, conns = fresh()
p0, p1 = conns[0], conns[1]
give_turn(room, p0)
table(room, "A")
set_hand(room, p0, ["A", "A", "K"])
room.state["revolver"][str(p1.uid)] = {"bullet": 6, "fired": 0}
act(room, p0, "play", cards=[0, 1])
act(room, p1, "doubt")
rev = room.state["reveal"]
check("出的确实是 Table 牌 -> 质疑者挨枪", rev["truthful"] is True and rev["loser"] == p1.uid)
check("实弹在第 6 发 -> 第一枪是空枪，活下来",
      rev["shot"]["died"] is False and room.state["alive"][str(p1.uid)] is True)
check("空枪也记一发（1/6）", room.state["revolver"][str(p1.uid)]["fired"] == 1)

# ---------------------------------------------------------------- 赖子当 Table 牌
room, conns = fresh()
p0, p1 = conns[0], conns[1]
give_turn(room, p0)
table(room, "K")
set_hand(room, p0, ["J", "K"])
act(room, p0, "play", cards=[0, 1])
act(room, p1, "doubt")
check("赖子 J 可以当 Table 牌 -> 算真话", room.state["reveal"]["truthful"] is True)
check("质疑者反而挨枪", room.state["reveal"]["loser"] == p1.uid)

# ---------------------------------------------------------------- 左轮：第 bullet 发才死
room, conns = fresh()
uid = conns[0].uid
room.state["revolver"][str(uid)] = {"bullet": 3, "fired": 0}
shots = [asyncio.run(liar.shoot(room, uid)) for _ in range(3)]
check("实弹在第 3 发：前两枪空枪",
      shots[0]["died"] is False and shots[1]["died"] is False)
check("第 3 枪毙命，出局", shots[2]["died"] is True and room.state["alive"][str(uid)] is False)
check("子弹序号永远是 1~6",
      all(1 <= v["bullet"] <= liar.CYLINDER for v in fresh()[0].state["revolver"].values()))

# ---------------------------------------------------------------- 出完手牌
room, conns = fresh()
p0, p1 = conns[0], conns[1]
give_turn(room, p0)
table(room, "Q")
set_hand(room, p0, ["Q"])
act(room, p0, "play", cards=[0])
check("出完手牌 -> 不是立刻结束，进入 final 让下家表态",
      room.state["phase"] == "final" and room.state["turn"] == p1.uid)
check("下家此刻只能质疑或放过",
      liar.can_do(room.state, p1.uid) == {"play": False, "doubt": True, "pass": True, "max": 0})
act(room, p1, "play", cards=[0])
check("final 阶段不许再出牌", room.state["phase"] == "final")
act(room, p1, "pass")
check("放过 -> 出完牌的人赢下本轮，轮次 +1",
      room.state["reveal"]["round_winner"] == p0.uid
      and room.state["round_wins"][str(p0.uid)] == 1)

# ---------------------------------------------------------------- 出完手牌但撒谎被抓
room, conns = fresh()
p0, p1 = conns[0], conns[1]
give_turn(room, p0)
table(room, "Q")
set_hand(room, p0, ["K"])
room.state["revolver"][str(p0.uid)] = {"bullet": 1, "fired": 0}
act(room, p0, "play", cards=[0])
act(room, p1, "doubt")
check("出完牌但撒谎被质疑 -> 自己挨枪出局",
      room.state["reveal"]["loser"] == p0.uid and room.state["alive"][str(p0.uid)] is False)
check("这一轮没有胜利者（round_winner = 0）", room.state["reveal"]["round_winner"] == 0)

# ---------------------------------------------------------------- 轮转与结算
room, conns = fresh()
st = room.state
for c in conns[1:]:
    st["alive"][str(c.uid)] = False
asyncio.run(liar.resolve_reveal(room))
check("只剩 1 人存活 -> 对局结束", room.finished is True and room.over["winners"] == [conns[0].uid])
check("结算把赢家交给 Room.finish（积分 +2 / -1 由它统一发）",
      room.over["winners"] == [conns[0].uid])

# ---------------------------------------------------------------- 回合轮转
room, conns = fresh()
st = room.state
st["turn"] = conns[0].uid
order = [liar.next_alive(st, conns[i].uid) for i in range(4)]
check("回合按座位 1->2->3->4->1 轮转",
      order == [conns[1].uid, conns[2].uid, conns[3].uid, conns[0].uid])
st["alive"][str(conns[1].uid)] = False
check("跳过已出局的人", liar.next_alive(st, conns[0].uid) == conns[2].uid)

# ---------------------------------------------------------------- 视角隔离
room, conns = fresh()
me, other = conns[0], conns[1]
v_me = liar.view(room.state, me.uid)
v_other = liar.view(room.state, other.uid)
check("只有本人能看到自己的手牌",
      v_me["my_hand"] == room.state["hands"][str(me.uid)]
      and v_other["my_hand"] == room.state["hands"][str(other.uid)]
      and v_me["my_hand"] != v_other["my_hand"])
check("别人的手牌只暴露张数", "hands" not in v_me and v_me["hand_count"][str(other.uid)] == 5)
check("实弹位置对所有人保密（view 里只有已开枪数）",
      "bullet" not in str(v_me.get("revolver")) and v_me["revolver"][str(me.uid)] == 0)
check("未开牌时盖牌的牌面不外泄",
      all("cards" not in p for p in v_me["pile"]) and "pile" in v_me)
check("等待开局时不会去读还没建的 state", liar.view({}, me.uid) == {"waiting": True, "phase": "waiting"})

room, conns = fresh()
give_turn(room, conns[0])
set_hand(room, conns[0], ["Q", "K"])
act(room, conns[0], "play", cards=[0])
v = liar.view(room.state, conns[1].uid)
check("对局中别人也看不到我的牌面", v["last"] == {"uid": conns[0].uid, "n": 1}
      and "cards" not in v["last"])

# ---------------------------------------------------------------- 超时兜底
def expire(room):
    """把 deadline 拨到过去（0 是"还没起计时"的哨兵值，不能用）。"""
    room.state["deadline"] = 1


room, conns = fresh()
p0 = conns[0]
give_turn(room, p0)
table(room, "Q")
set_hand(room, p0, ["K", "K"])
expire(room)
asyncio.run(liar.tick(room))
check("超时自动盖牌出 1 张（不卡死整局）",
      room.state["pile"] and room.state["pile"][-1]["n"] == 1
      and len(room.state["hands"][str(p0.uid)]) == 1)
check("自动出牌也算一次正常的出牌（回合交给下家）", room.state["turn"] == conns[1].uid)

room, conns = fresh()
p0, p1 = conns[0], conns[1]
give_turn(room, p0)
table(room, "Q")
set_hand(room, p0, ["Q"])
act(room, p0, "play", cards=[0])
expire(room)
asyncio.run(liar.tick(room))
check("final 阶段超时 -> 自动放过，本轮照样收场",
      room.state["reveal"] is not None and room.state["reveal"]["round_winner"] == p0.uid)

room, conns = fresh()
give_turn(room, conns[0])
room.state["deadline"] = 0
asyncio.run(liar.tick(room))
check("还没起计时的时候 tick 不会误触发", room.state["pile"] == [])

# ---------------------------------------------------------------- 中途退出
room, conns = fresh()
st = room.state
give_turn(room, conns[0])
ended = asyncio.run(liar.drop(room, conns[0].uid, "P0"))
check("中途退出的人直接出局，牌作废",
      st["alive"][str(conns[0].uid)] is False and st["hands"][str(conns[0].uid)] == []
      and ended is False)
check("退出的正好是当前回合 -> 回合交给下一个人", st["turn"] == conns[1].uid)

room, conns = fresh()
st = room.state
for c in conns[2:]:
    st["alive"][str(c.uid)] = False
asyncio.run(liar.drop(room, conns[1].uid, "P1"))
check("退到只剩 1 人 -> 直接判剩下的赢", room.finished is True and room.over["winners"] == [conns[0].uid])

room, conns = fresh()
st = room.state
st["alive"][str(conns[3].uid)] = False
check("已经出局的人再退出不会误判胜负",
      asyncio.run(liar.drop(room, conns[3].uid, "P3")) is False and room.finished is False)

# ---------------------------------------------------------------- 完整对局（4 轮以上）
room, conns = fresh()
st = room.state
for c in conns:
    st["revolver"][str(c.uid)] = {"bullet": 1, "fired": 0}   # 谁挨枪谁死，快速收场
guard = 0
while not room.finished and guard < 200:
    guard += 1
    st = room.state
    if st.get("phase") in ("play", "final"):
        cur = room.seat_of(st["turn"])
        if cur is None:
            break
        if st["phase"] == "final":
            act(room, cur, "doubt")           # 一路质疑到底
        elif liar.can_do(st, cur.uid)["doubt"] and len(st["pile"]) >= 2:
            act(room, cur, "doubt")
        else:
            act(room, cur, "play", cards=[0])
    elif st.get("phase") == "reveal":
        expire(room)
        asyncio.run(liar.tick(room))
check("一整局能自动跑完并收敛到唯一赢家",
      room.finished and len(room.over["winners"]) == 1
      and st["alive"][str(room.over["winners"][0])] is True,
      "guard=%d" % guard)
check("赢家是最后活着的那个（其余人都已出局）",
      sum(1 for v in st["alive"].values() if v) == 1)

print("======================================")
ok = sum(1 for _, o, _e in results if o)
for name, good, extra in results:
    print(("PASS  " if good else "FAIL  ") + name + (("   " + extra) if extra and not good else ""))
print("=== %d/%d ===" % (ok, len(results)))
sys.exit(0 if ok == len(results) else 1)
