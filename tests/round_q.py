"""本轮（阶段 Q）回归：围棋 9/19 路 · 画猜词库与不放回抽词 · 猜中打码 · 观战弹幕标记 · 象棋将军/绝杀。

用法: python tests/round_q.py [base] [账号1 账号2 账号3]
账号形如 user:pass；也可以走环境变量 CHECKIN_TEST_ACCOUNTS。
"""
import asyncio
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_src = open(os.path.join(HERE, "board_ww_ws.py"), encoding="utf-8").read()
_head = _src.split("results = []")[0]
_head = _head.replace("BASE = sys.argv[1]", 'BASE = "http://127.0.0.1:8081"')
_head = _head.replace("PASS_A = sys.argv[2]", 'PASS_A = ""').replace("PASS_B = sys.argv[3]", 'PASS_B = ""')
_ns = {}
exec(compile(_head, "head", "exec"), _ns)
api, login, whoami, WS = _ns["api"], _ns["login"], _ns["whoami"], _ns["WS"]

os.environ.setdefault("CHECKIN_DATA", r"D:\learn\class-checkin\data")
import db                                                    # noqa: E402
db.init()
import games                                                 # noqa: E402

results = []
T0 = time.time()


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(("[OK] " if ok else "[!!] ") + name + (("  <- " + str(extra)) if extra and not ok else ""))


class Pumped:
    """带后台读线程的连接：对局里两次推送可能隔十几秒，读超时不算断线。"""

    def __init__(self, tok):
        self.ws = WS(tok)
        self.msgs = []
        threading.Thread(target=self._pump, daemon=True).start()
        self.wait(lambda: any(m.get("t") == "hello" for m in self.msgs), 5)

    def _pump(self):
        while True:
            try:
                self.msgs.append(self.ws.recv())
            except socket.timeout:
                continue
            except Exception:
                return

    def wait(self, pred, secs=10):
        end = time.time() + secs
        while time.time() < end:
            if pred():
                return True
            time.sleep(0.05)
        return False

    def send(self, obj):
        self.ws.send(obj)

    def _rooms(self):
        return [m["room"] for m in self.msgs if m.get("t") in ("game.state", "game.update", "game.over", "game.entered")
                and m.get("room")]

    def room(self):
        rooms = self._rooms()
        return rooms[-1] if rooms else {}

    def state(self):
        r = self.room()
        return (r or {}).get("state") or {}

    def over(self):
        for m in reversed(self.msgs):
            if m.get("t") == "game.over":
                return m
        return None

    def chats(self):
        return [m["chat"] for m in self.msgs if m.get("t") == "game.chat" and m.get("chat")]

    def events(self):
        return [m.get("text", "") for m in self.msgs if m.get("t") == "game.event"]

    def clear(self):
        self.msgs[:] = []          # 必须原地清空：读线程此时正阻塞在 recv()，换列表会把回来的消息丢进旧列表


def creds():
    raw = os.environ.get("CHECKIN_TEST_ACCOUNTS", "").strip()
    if not raw and len(sys.argv) > 2:
        raw = " ".join(sys.argv[2:])
    out = [x for x in raw.replace(",", " ").split() if x]
    if len(out) < 3:
        print("用法: python tests/round_q.py [base] user1:pass user2:pass user3:pass")
        sys.exit(2)
    return out[:3]


CREDS = creds()
A, B, C = [login(*c.split(":", 1)) for c in CREDS]          # login() 返回 token
UID = {A: whoami(A), B: whoami(B), C: whoami(C)}
wa, wb, wc = Pumped(A), Pumped(B), Pumped(C)


def ready_both(ra, rb):
    ra.send({"t": "game.ready"})
    rb.send({"t": "game.ready"})


def wait_kind(w, kind, secs=8):
    return w.wait(lambda: any(m.get("t") == kind for m in w.msgs), secs)


def enter(w, payload, secs=8):
    """发一条 game.create / game.join，并且**等到 game.entered** 再返回房间快照。
    不能只看"最近一条带 room 的消息"——上一局的残留消息还在路上，会拿到旧房间号。"""
    w.clear()
    w.send(payload)
    wait_kind(w, "game.entered", secs)
    return w.room()


def leave_all(secs=8):
    for w in (wa, wb, wc):
        w.send({"t": "game.leave"})
    for w in (wa, wb, wc):
        wait_kind(w, "game.left", secs)
        w.clear()


# ================================================================ 9. 围棋 9 / 19 路
room19 = enter(wa, {"t": "game.create", "game": "go", "size": 19})
ok = room19.get("opts", {}).get("size") == 19
check("建房时选 19 路：房间记下 opts.size=19", ok and room19.get("board_size") == 19, room19.get("opts"))
enter(wb, {"t": "game.join", "room": room19.get("code"), "play": True})
ready_both(wa, wb)
ok = wa.wait(lambda: wa.state().get("status") == "playing", 10)
st19 = wa.state()
check("19 路开局：19x19 / 361 个交叉点",
      ok and st19.get("size") == 19 and st19.get("cols") == 19 and len(st19.get("board") or []) == 361,
      {"size": st19.get("size"), "len": len(st19.get("board") or [])})
st19b = wb.state()
check("19 路对局双方看到同一个棋盘", len(st19b.get("board") or []) == 361 and st19b.get("size") == 19)
leave_all()

r9 = enter(wa, {"t": "game.create", "game": "go"})
enter(wb, {"t": "game.join", "room": r9.get("code"), "play": True})
ready_both(wa, wb)
ok = wa.wait(lambda: wa.state().get("status") == "playing", 10)
st9 = wa.state()
check("不选就是默认 9 路：9x9 / 81 个点",
      ok and st9.get("size") == 9 and len(st9.get("board") or []) == 81,
      {"size": st9.get("size")})
leave_all()

# ================================================================ 10. 画猜词库 + 不放回
check("词库至少 100 个词（当前 %d 个）" % len(games.WORDS), len(games.WORDS) >= 100)
check("词库没有重复词", len(set(games.WORDS)) == len(games.WORDS))


class FakeConn:
    def __init__(self, uid, name):
        self.uid = uid
        self.user = {"name": name}
        self.closed = False
        self.rooms = set()
        self.detached_at = 0


class FakeRoom:
    def __init__(self, seats):
        self.id = "9001"
        self.game = "draw"
        self.started = False
        self.finished = False
        self.state = {}
        self.members = list(seats)
        self.seats = list(seats)
        self.left_names = {}
        self.rematch = set()
        self.ready = set()
        self.host = seats[0].uid

    def name_of(self, uid):
        return "同学"

    async def push(self, *a, **k):
        return None

    async def broadcast(self, *a, **k):
        return None

    async def send_to(self, *a, **k):
        return None


async def deck_rounds(n):
    room = FakeRoom([FakeConn(9001, "甲"), FakeConn(9002, "乙")])
    await games.draw_start(room)
    seen = [room.state["word"]]
    for i in range(n - 1):
        games.draw_begin_round(room, i % 2)
        seen.append(room.state["word"])
    return seen


deck = asyncio.run(deck_rounds(60))
check("连续 60 轮抽词互不重复（不放回抽取）", len(set(deck)) == len(deck),
      "重复了 %d 个" % (len(deck) - len(set(deck))))
check("抽出来的词都在词库里", all(w in set(games.WORDS) for w in deck))
check("词牌堆发完后会自动重洗（不会抽空卡死）", len(asyncio.run(deck_rounds(len(games.WORDS) + 5))) == len(games.WORDS) + 5)

# ================================================================ 画猜房间：13 打码 / 10 词库下发 / 12 观战弹幕
draw_room = enter(wa, {"t": "game.create", "game": "draw"})
draw_code = draw_room.get("code")
enter(wb, {"t": "game.join", "room": draw_code, "play": True})
ready_both(wa, wb)
ok = wa.wait(lambda: wa.state().get("status") == "playing", 10)
st = wa.state()
check("画猜公共状态带词库信息（words_total=%s）" % st.get("words_total"), int(st.get("words_total") or 0) >= 100)
check("画猜公共状态不泄露词牌堆", "deck" not in st and "deck_i" not in st)
drawer_a = st.get("drawer") == UID[A]
drawer_ws, guesser_ws = (wa, wb) if drawer_a else (wb, wa)
drawer_tok = A if drawer_a else B
guesser_uid = UID[B] if drawer_a else UID[A]
word = drawer_ws.state().get("word") or ""
check("画手能看到词、猜手看不到", bool(word) and not (guesser_ws.state().get("word") or ""))
guesser_ws.clear()
guesser_ws.send({"t": "game.guess", "text": word})
ok = guesser_ws.wait(lambda: any(c.get("text") == "***" for c in guesser_ws.chats()), 8)
check("猜中的人：聊天内容被打码成 ***", ok, guesser_ws.chats())
check("聊天里再也看不到正确答案", all(word not in (c.get("text") or "") for c in guesser_ws.chats()))
check("画手那边同样只看到 ***",
      all(word not in (c.get("text") or "") for c in drawer_ws.chats()) and
      any(c.get("text") == "***" for c in drawer_ws.chats()))
check("猜中会加分", int(guesser_ws.state().get("scores", {}).get(str(guesser_uid), 0)) > 0)

# 观战者：发的讨论带 spec 标记，且不会因为猜中而加分
wc.clear()
okc = bool(enter(wc, {"t": "game.join", "room": draw_code, "play": False}))
check("第三个人进来是观战（人数满了）", okc and wc.room().get("players") and
      UID[C] not in [p.get("uid") for p in (wc.room().get("players") or [])])
word2 = drawer_ws.state().get("word") or ""
wa.clear()
wc.clear()
wc.send({"t": "game.guess", "text": word2}) if word2 else wc.send({"t": "game.chat", "text": "观战路过"})
ok = wa.wait(lambda: any(c.get("spec") == 1 for c in wa.chats()), 8)
check("观战者的发言带 spec=1（前端据此飘弹幕）", ok, wa.chats()[-3:])
wa.clear()
wa.send({"t": "game.chat", "text": "我是选手"})
ok = wb.wait(lambda: any(c.get("spec") == 0 and c.get("text") == "我是选手" for c in wb.chats()), 8)
check("正在比赛的玩家发言 spec=0", ok)
check("观战者不会因为猜中得分",
      int(wc.state().get("scores", {}).get(str(UID[C]), 0) or 0) == 0)
leave_all()

# ================================================================ 14. 象棋：将军 / 绝杀
xq_code = enter(wa, {"t": "game.create", "game": "xiangqi"}).get("code")
enter(wb, {"t": "game.join", "room": xq_code, "play": True})
ready_both(wa, wb)
ok = wa.wait(lambda: wa.state().get("status") == "playing", 10)
check("象棋开局", ok and wa.state().get("cols") == 9 and wa.state().get("rows") == 10)
# 红方两步：炮 7,1 -> 5,1 -> 5,4 中间隔一个黑卒 -> 将军
wa.send({"t": "game.move", "from": 64, "to": 46})
wb.wait(lambda: wb.state().get("turn") == UID[A], 8)
wb.send({"t": "game.move", "from": 27, "to": 36})
wa.wait(lambda: wa.state().get("turn") == UID[A], 8)
wb.clear()
wa.send({"t": "game.move", "from": 46, "to": 49})
ok = wb.wait(lambda: (wb.state().get("alert") or {}).get("kind") == "check", 8)
alert = wb.state().get("alert") or {}
check("将军：双方都收到 alert(kind=check)", ok and (wa.state().get("alert") or {}).get("kind") == "check", alert)
check("将军 alert 带递增序号与发起人", int(alert.get("seq") or 0) >= 1 and alert.get("uid") == UID[A], alert)
check("将军会播报文字提示", any("将军" in t for t in wb.events()), wb.events()[-3:])
leave_all()


MATE_SEQ = [(83, 63), (0, 9), (64, 55), (7, 24), (55, 64), (29, 38), (64, 1), (25, 7), (62, 53), (6, 26),
            (87, 67), (19, 21), (1, 64), (8, 17), (88, 71), (17, 13), (64, 1), (35, 44), (53, 44), (9, 0),
            (85, 76), (21, 18), (70, 34), (18, 54), (76, 77), (24, 17), (44, 35), (31, 40), (77, 68), (13, 14)]

mate_code = enter(wa, {"t": "game.create", "game": "xiangqi"}).get("code")
enter(wb, {"t": "game.join", "room": mate_code, "play": True})
ready_both(wa, wb)
ok = wa.wait(lambda: wa.state().get("status") == "playing", 10)
turn_a = True                    # 红先行，A 是房主所以执红
wb.clear()
for src, dst in MATE_SEQ:
    (wa if turn_a else wb).send({"t": "game.move", "from": src, "to": dst})
    time.sleep(0.16)
    turn_a = not turn_a
ok = wb.wait(lambda: (wb.state().get("alert") or {}).get("kind") == "mate", 8)
mate_alert = wb.state().get("alert") or {}
check("绝杀：最后一步触发 alert(kind=mate)", ok, {"status": wb.state().get("status"), "alert": mate_alert})
check("绝杀 alert 的序号比将军那次更新", int(mate_alert.get("seq") or 0) >= 1)
check("绝杀会播报文字提示", any("绝杀" in t for t in wb.events()), wb.events()[-3:])
check("绝杀同样给对手发 alert（两边都播动画）",
      (wa.state().get("alert") or {}).get("kind") == "mate")
over = wb.wait(lambda: bool(wb.over()), 8) and wb.over()
winner = UID[B] if len(MATE_SEQ) % 2 == 0 else UID[A]
check("绝杀之后正常结算（有胜者、有原因）",
      bool(over) and over.get("winners") == [winner] and "将死" in (over.get("reason") or ""),
      {"over": over})
leave_all()

# ================================================================ 汇总
bad = [n for n, ok, _ in results if not ok]
print("\n================ %d/%d 通过，用时 %.1fs ================" % (len(results) - len(bad), len(results), time.time() - T0))
if bad:
    print("失败项：")
    for n in bad:
        print(" - " + n)
sys.exit(1 if bad else 0)
