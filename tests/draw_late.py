"""你画我猜轮次规则回归：倒计时换轮 / 半场加入的人进轮转 / 每人画满两轮后收场。

用法: python tests/draw_late.py [base] [4 个账号 user:pass]
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
T0 = time.time()


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
                continue          # 读超时只是"这段时间没消息"，不是断开（对局里 10s 才推一次状态）
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

    def room(self):
        for m in reversed(self.msgs):
            if m.get("t") in ("game.state", "game.update", "game.over") and m.get("room"):
                return m["room"]
        return {}


def set_settings(mapping):
    os.environ.setdefault("CHECKIN_DATA", r"D:\learn\class-checkin\data")
    import db
    db.init()
    old = {}
    for k, v in mapping.items():
        old[k] = db.setting(k, "")
        db.set_setting(k, str(v))
    return old


def restore(old):
    import db
    for k, v in old.items():
        if v in ("", None):
            db.execute("DELETE FROM settings WHERE k = ?", (k,))
        else:
            db.set_setting(k, v)


def desc(c, tag):
    st = c.state()
    return "%6.1fs %-14s round=%s drawer=%s draws=%s status=%s" % (
        time.time() - T0, tag, st.get("round"), st.get("drawer"), st.get("draws"), st.get("status"))


def main():
    args = sys.argv[1:]
    base = "http://127.0.0.1:8081"
    if args and args[0].startswith("http"):
        base = args.pop(0)
    _ns["BASE"] = base
    accs = args or _creds_from_env()
    if len(accs) < 4:
        sys.exit("需要 4 个账号（口令不要写进仓库）：\n  python tests/draw_late.py [base] user:pass user:pass user:pass user:pass\n或设 CHECKIN_TEST_ACCOUNTS=\"user:pass user:pass ...\"")
    toks = [login(*a.split(":", 1)) for a in accs]
    uids = [whoami(t) for t in toks]
    old = set_settings({"draw_seconds": 10, "game_grace_seconds": 5})
    try:
        cs = [Pumped(t) for t in toks[:3]]
        cs[0].send({"t": "game.create", "game": "draw"})
        room = None
        end = time.time() + 6
        while time.time() < end and not room:
            for m in cs[0].msgs:
                if m.get("t") == "game.entered":
                    room = m["room"]["id"]
            time.sleep(0.05)
        for c in cs[1:]:
            c.send({"t": "game.join", "room": room})
            time.sleep(0.3)
        for c in cs:
            c.send({"t": "game.ready"})
            time.sleep(0.15)
        check("3 人开局", cs[0].wait(lambda: cs[0].state().get("status") == "playing", 8))
        TRACE.append(desc(cs[0], "开局"))
        check("开局带倒计时", cs[0].state().get("deadline", 0) > 0)
        r2 = cs[0].wait(lambda: (cs[0].state().get("round") or 1) >= 2, 25)
        TRACE.append(desc(cs[0], "等第2轮"))
        check("没人猜中时倒计时结束会换轮", r2)

        # ---- 半场加入：第 4 位玩家（全新账号，不是重复连接）中途进场 ----
        late = Pumped(toks[3])
        late.send({"t": "game.join", "room": room})
        time.sleep(1.2)
        seated = [pp.get("uid") for pp in (late.room().get("players") or [])]
        TRACE.append(desc(late, "半场加入后"))
        check("半场加入的人坐上了座位", uids[3] in seated, str(seated))
        got = late.wait(lambda: late.state().get("drawer") == uids[3]
                        or late.state().get("draws", {}).get(str(uids[3]), 0) > 0, 70)
        TRACE.append(desc(late, "等半场玩家作画"))
        check("半场加入的人会被排进轮转（轮到他当画手）", got,
              "drawer=%s draws=%s" % (late.state().get("drawer"), late.state().get("draws")))
        late.send({"t": "game.leave"})
        time.sleep(0.8)
        TRACE.append(desc(cs[0], "半场玩家离开"))
        check("半场玩家离开后本局继续",
              cs[0].state().get("status") == "playing" and not cs[0].over(),
              "status=%s" % cs[0].state().get("status"))

        # ---- 一直打完：在场的人都画满两轮 ----
        deadline = time.time() + 60
        last_log = 0
        while time.time() < deadline:
            if cs[0].over() or cs[0].state().get("status") == "finished":
                break
            if time.time() - last_log > 6:
                last_log = time.time()
                TRACE.append(desc(cs[0], "打完中"))
            time.sleep(0.2)
        done = bool(cs[0].over()) or cs[0].state().get("status") == "finished"
        TRACE.append(desc(cs[0], "收场"))
        check("所有人都画满两轮后本局结束", done,
              "round=%s draws=%s" % (cs[0].state().get("round"), cs[0].state().get("draws")))
        over = cs[0].over() or {}
        check("结束语写明了打满两轮", "画满" in (over.get("reason") or ""), str(over.get("reason")))
        draws = cs[0].state().get("draws") or {}
        check("在场三个人都画满了 2 轮", all(int(draws.get(str(u), 0)) >= 2 for u in uids[:3]), str(draws))
    finally:
        restore(old)
    ok = sum(1 for _, good, _ in results if good)
    for name, good, extra in results:
        print(("PASS  " if good else "FAIL  ") + name + (("   [" + extra + "]") if extra and not good else ""))
    print("=== %d/%d ===" % (ok, len(results)))
    print("---- TRACE ----")
    for line in TRACE:
        print(line)
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
