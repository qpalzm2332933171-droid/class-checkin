"""数字炸弹结束规则回归：谁踩中炸弹谁输、本局立刻结束、其余人 +2 / 踩雷的人 -1。

用法: python tests/bomb_end.py [base] [3 个账号 user:pass]
"""
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

def _creds_from_env():
    raw = os.environ.get("CHECKIN_TEST_ACCOUNTS", "").strip()
    return [x for x in raw.replace(",", " ").split() if x]


results = []
TRACE = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))


class Pumped:
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

    def wait(self, pred, secs):
        end = time.time() + secs
        while time.time() < end:
            if pred():
                return True
            time.sleep(0.05)
        return False

    def send(self, obj):
        self.ws.send(obj)

    def state(self):
        for m in reversed(self.msgs):
            if m.get("t") in ("game.state", "game.update", "game.over") and m.get("room", {}).get("state"):
                return m["room"]["state"]
        return {}

    def over(self):
        for m in reversed(self.msgs):
            if m.get("t") == "game.over":
                return m
        return None

    def texts(self):
        return [m.get("text", "") for m in self.msgs if m.get("t") == "game.event"]


POINTS = {}


def points_of(uid, tok):
    current = api("/api/me", token=tok)["points"]["online"]
    return current - POINTS.get(uid, current)


def main():
    args = sys.argv[1:]
    base = "http://127.0.0.1:8081"
    if args and args[0].startswith("http"):
        base = args.pop(0)
    _ns["BASE"] = base
    accs = args or _creds_from_env()
    if len(accs) < 3:
        sys.exit("需要 3 个账号（口令不要写进仓库）：\n  python tests/bomb_end.py [base] user:pass user:pass user:pass\n或设 CHECKIN_TEST_ACCOUNTS=\"user:pass user:pass ...\"")
    toks = [login(*a.split(":", 1)) for a in accs]
    uids = [whoami(t) for t in toks]
    for u, t in zip(uids, toks):
        POINTS[u] = api("/api/me", token=t)["points"]["online"]

    cs = [Pumped(t) for t in toks]
    cs[0].send({"t": "game.create", "game": "bomb"})
    room = None
    end = time.time() + 6
    while time.time() < end and not room:
        for m in cs[0].msgs:
            if m.get("t") == "game.entered":
                room = m["room"]["id"]
        time.sleep(0.05)
    check("建炸弹房成功", bool(room), str(room))
    for c in cs[1:]:
        c.send({"t": "game.join", "room": room})
        time.sleep(0.3)
    for c in cs:
        c.send({"t": "game.ready"})
        time.sleep(0.15)
    check("3 人开局", cs[0].wait(lambda: cs[0].state().get("status") == "playing", 8))
    check("开局带范围 1~100", cs[0].state().get("lo") == 1 and cs[0].state().get("hi") == 100,
          str(cs[0].state().get("lo")) + "~" + str(cs[0].state().get("hi")))

    conn_of = {u: c for u, c in zip(uids, cs)}
    guard = 0
    while not cs[0].over() and guard < 20:
        guard += 1
        st = cs[0].state()
        turn = st.get("turn")
        lo, hi = st.get("lo", 1), st.get("hi", 100)
        n = (lo + hi) // 2
        if not (lo < n < hi):
            check("二分收敛到炸弹", False, "lo=%s hi=%s" % (lo, hi))
            break
        c = conn_of.get(turn)
        if not c:
            check("轮到的玩家在线", False, str(turn))
            break
        c.send({"t": "game.guess", "text": str(n)})
        time.sleep(0.45)
        TRACE.append("#%d %s 报 %d -> lo=%s hi=%s over=%s"
                     % (guard, uids.index(turn) + 1 if turn in uids else turn, n,
                        cs[0].state().get("lo"), cs[0].state().get("hi"), bool(cs[0].over())))
    check("有人踩中炸弹后本局立刻结束（bug 6）", bool(cs[0].over()),
          "status=%s" % cs[0].state().get("status"))
    over = cs[0].over() or {}
    check("结束理由写明炸弹", "炸弹" in (over.get("reason") or ""), str(over.get("reason")))
    winners = over.get("winners") or []
    check("赢家是没猜中的那些人（其余人 +2）", len(winners) == 2, str(winners))
    check("结束广播里说清了谁踩了雷",
          any("砰" in t or "炸弹" in t for t in cs[0].texts()), str(cs[0].texts()[-3:]))
    time.sleep(1.5)
    loser = [u for u in uids if u not in winners]
    check("踩雷的人 -1 分", loser and points_of(loser[0], toks[uids.index(loser[0])]) == -1,
          str([(u, points_of(u, toks[uids.index(u)])) for u in uids]))
    check("赢家各 +2 分", all(points_of(u, toks[uids.index(u)]) == 2 for u in winners),
          str([(u, points_of(u, toks[uids.index(u)])) for u in uids]))

    ok = sum(1 for _, good, _ in results if good)
    for name, good, extra in results:
        print(("PASS  " if good else "FAIL  ") + name + (("   [" + extra + "]") if extra and not good else ""))
    print("=== %d/%d ===" % (ok, len(results)))
    for line in TRACE:
        print(line)
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
