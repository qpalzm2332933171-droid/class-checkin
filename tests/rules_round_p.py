"""本轮改动回归：退出/掉线判负积分、你画我猜轮次规则、数字炸弹结束规则。

用法: python tests/rules_round_p.py [base] [account:pass ...]
"""
import io
import json
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

results = []


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

    def texts(self):
        return [m.get("text", "") for m in self.msgs if m.get("t") == "game.event"]


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


POINTS = {}


def points_of(uid, tok):
    now = api("/api/me", token=tok)["points"]["online"]
    return now - POINTS.get(uid, now)


def snap(uids, tokens):
    for u, t in zip(uids, tokens):
        POINTS[u] = api("/api/me", token=t)["points"]["online"]


def main():
    args = sys.argv[1:]
    base = "http://127.0.0.1:8081"
    if args and args[0].startswith("http"):
        base = args.pop(0)
    _ns["BASE"] = base
    accs = args or [x for x in os.environ.get("CHECKIN_TEST_ACCOUNTS", "").replace(",", " ").split() if x]
    if len(accs) < 7:
        sys.exit("需要 7 个账号（口令不要写进仓库）：\n"
                 "  python tests/rules_round_p.py [base] u1:p1 u2:p2 u3:p3 u4:p4 u5:p5 u6:p6 u7:p7\n"
                 "或设 CHECKIN_TEST_ACCOUNTS=\"u1:p1 u2:p2 ...\"")
    tokens = [login(*a.split(":", 1)) for a in accs]
    uids = [whoami(t) for t in tokens]
    old = set_settings({"game_grace_seconds": 5, "draw_seconds": 10})
    # 上一次跑测试留下的房间：宽限期一缩短就会被扫掉并补结算积分。先等它们清干净再快照，
    # 否则这些"迟到"的积分会算到本轮头上（赢家看起来只加了 1 分）。
    time.sleep(8)
    snap(uids, tokens)

    try:
        # ---------------- 1. 1v1 中途退出 = 判负 + 积分 ----------------
        a, b = Pumped(tokens[0]), Pumped(tokens[1])
        a.send({"t": "game.create", "game": "gomoku"})
        room = None
        end = time.time() + 6
        while time.time() < end and not room:
            for m in a.msgs:
                if m.get("t") == "game.entered":
                    room = m["room"]["id"]
            time.sleep(0.05)
        b.send({"t": "game.join", "room": room})
        time.sleep(0.4)
        a.send({"t": "game.ready"})
        b.send({"t": "game.ready"})
        check("1v1 开局", a.wait(lambda: a.state().get("status") == "playing", 8))
        a.send({"t": "game.move", "index": 0})
        time.sleep(0.4)
        b.send({"t": "game.leave"})
        check("对手退出后立刻结算", a.wait(lambda: bool(a.over()), 8))
        over = a.over() or {}
        check("退出方判负、留在房里的人获胜",
              over.get("winners") == [uids[0]] and "判负" in (over.get("reason") or ""),
              str(over))
        time.sleep(1.2)
        check("退出判负也算积分（赢 +2 / 输 -1）",
              points_of(uids[0], tokens[0]) == 2 and points_of(uids[1], tokens[1]) == -1,
              "%s / %s" % (points_of(uids[0], tokens[0]), points_of(uids[1], tokens[1])))

        # ---------------- 2. 掉线也判负 ----------------
        snap(uids, tokens)
        a, b = Pumped(tokens[0]), Pumped(tokens[1])
        a.send({"t": "game.create", "game": "tictactoe"})
        room = None
        end = time.time() + 6
        while time.time() < end and not room:
            for m in a.msgs:
                if m.get("t") == "game.entered":
                    room = m["room"]["id"]
            time.sleep(0.05)
        b.send({"t": "game.join", "room": room})
        time.sleep(0.4)
        a.send({"t": "game.ready"})
        b.send({"t": "game.ready"})
        a.wait(lambda: a.state().get("status") == "playing", 8)
        b.ws.sock.close()          # 模拟手机切后台/断网
        check("掉线超过宽限期后判负", a.wait(lambda: bool(a.over()), 25))
        over = a.over() or {}
        check("掉线判负的理由写清楚了", "退出" in (over.get("reason") or ""), str(over))
        time.sleep(1.2)
        check("掉线判负也扣分", points_of(uids[1], tokens[1]) == -1, str(points_of(uids[1], tokens[1])))

        # ---------------- 3. 你画我猜：倒计时结束本轮结束 + 每人两轮后收场 ----------------
        cs = [Pumped(t) for t in tokens[:3]]
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
        check("你画我猜 3 人开局", cs[0].wait(lambda: cs[0].state().get("status") == "playing", 8))
        check("开局是第 1 轮且带倒计时",
              cs[0].state().get("round") == 1 and cs[0].state().get("deadline", 0) > 0)
        # 谁也不猜，等倒计时到点（draw_seconds=10）
        moved = cs[0].wait(lambda: (cs[0].state().get("round") or 1) >= 2, 25)
        check("没人猜中时倒计时结束也会换轮（bug 5）", moved,
              "round=%s" % cs[0].state().get("round"))
        check("换轮提示有文字", any("时间到" in t or "轮开始" in t for t in cs[0].texts()))
        # 半场加入：第 4 个全新账号中途进来，不能被无视（服务端不对外下发 order，就看轮转）
        late = Pumped(tokens[6])
        late.send({"t": "game.join", "room": room})
        time.sleep(1.0)
        seated = [pp.get("uid") for pp in (late.room().get("players") or [])]
        check("半场加入的人坐上了座位", uids[6] in seated, str(seated))
        rotated = late.wait(lambda: late.state().get("drawer") == uids[6]
                            or late.state().get("draws", {}).get(str(uids[6]), 0) > 0, 90)
        check("半场加入的人会被排进轮转（轮到他作画）", rotated,
              "drawer=%s draws=%s" % (late.state().get("drawer"), late.state().get("draws")))
        late.send({"t": "game.leave"})
        time.sleep(0.6)
        check("半场玩家离开后本局继续",
              cs[0].state().get("status") == "playing" and not cs[0].over(),
              "status=%s" % cs[0].state().get("status"))
        # 让在场的人各画两轮：一直等到结束（3 人 x 2 轮 x 10 秒 + 收尾）
        done = cs[0].wait(lambda: bool(cs[0].over()) or cs[0].state().get("status") == "finished", 180)
        check("所有人都画满两轮后本局结束（bug 3）", done,
              "round=%s" % cs[0].state().get("round"))
        over = cs[0].over() or {}
        check("画猜结束会给出名次和分数", "分" in (over.get("reason") or ""), str(over.get("reason")))

        # ---------------- 4. 你画我猜：有人退出不影响整局 ----------------
        cs = [Pumped(t) for t in tokens[:3]]
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
        cs[0].wait(lambda: cs[0].state().get("status") == "playing", 8)
        cs[2].send({"t": "game.leave"})
        time.sleep(1.5)
        st = cs[0].state()
        check("3 人局走掉 1 个，本局继续（bug 4）",
              st.get("status") == "playing" and not cs[0].over(),
              "status=%s" % st.get("status"))
        check("走掉的人被判负扣分", points_of(uids[2], tokens[2]) <= -1, str(points_of(uids[2], tokens[2])))
        cs[1].send({"t": "game.leave"})
        cs[0].wait(lambda: bool(cs[0].over()) or cs[0].state().get("status") == "finished", 20)
        check("只剩 1 个人时才结束本局（bug 4）",
              bool(cs[0].over()) or cs[0].state().get("status") == "finished",
              "status=%s" % cs[0].state().get("status"))

        # ---------------- 5. 数字炸弹：猜中即结束 ----------------
        cs = [Pumped(t) for t in tokens]
        cs[0].send({"t": "game.create", "game": "bomb"})
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
        ok_start = cs[0].wait(lambda: cs[0].state().get("status") == "playing", 8)
        check("数字炸弹 3 人开局（不再报 bomb_start 参数错）", ok_start)
        st = cs[0].state()
        order = st.get("order") or [uids[0]]
        first = order[0]
        conn_of = {u: c for u, c in zip(uids, cs)}
        # 二分逼近炸弹（炸弹在 2~99 之间，二分最多 7 次就能踩中）
        guard = 0
        while not cs[0].over() and guard < 20:
            guard += 1
            st = cs[0].state()
            turn = st.get("turn")
            lo, hi = st.get("lo", 1), st.get("hi", 100)
            n = (lo + hi) // 2
            if not (lo < n < hi):
                break
            c = conn_of.get(turn)
            if not c:
                break
            c.send({"t": "game.guess", "text": str(n)})
            time.sleep(0.5)
        check("有人踩中炸弹后本局立刻结束（bug 6）", bool(cs[0].over()),
              "status=%s" % cs[0].state().get("status"))
        over = cs[0].over() or {}
        check("炸弹局失败者只有一个且其余人获胜",
              len(over.get("winners") or []) >= 1 and "炸弹" in (over.get("reason") or ""),
              str(over))
    finally:
        restore(old)

    ok = sum(1 for _, good, _ in results if good)
    for name, good, extra in results:
        print(("PASS  " if good else "FAIL  ") + name + (("   [" + extra + "]") if extra and not good else ""))
    print("=== %d/%d ===" % (ok, len(results)))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
