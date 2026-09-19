"""狼人杀完整流程回归：连着走两天两夜（夜晚三环节 -> 白天发言 -> 投票 -> 下一夜），
顺便验证胜负结算和积分。用 db 里的 ww_speed 把阶段时长整体加速。

用法: python tests/werewolf_flow.py [base] [6 个账号 user:pass]
"""
import io
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "http://127.0.0.1:8081"

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


def set_speed(speed):
    """直接改数据库设置，让整套阶段时长整体加速（测试专用）。"""
    os.environ.setdefault("CHECKIN_DATA", r"D:\learn\class-checkin\data")
    import db
    db.init()
    old = db.setting("ww_speed", "1")
    db.set_setting("ww_speed", str(speed))
    return old


def restore_speed(old):
    """跑完把阶段时长改回去，别影响别人。"""
    os.environ.setdefault("CHECKIN_DATA", r"D:\learn\class-checkin\data")
    import db
    if old in ("", None):
        db.execute("DELETE FROM settings WHERE k = ?", ("ww_speed",))
    else:
        db.set_setting("ww_speed", old)


class Pumped:
    """后台线程持续收消息，主线程只查最新状态（避免超时把 WebSocket 帧读残）。"""

    def __init__(self, tok):
        self.ws = WS(tok)
        self.msgs = []
        self._stop = False
        t = threading.Thread(target=self._pump, daemon=True)
        t.start()
        self._wait(lambda: any(m.get("t") == "hello" for m in self.msgs), 5)

    def _pump(self):
        while not self._stop:
            try:
                self.msgs.append(self.ws.recv())
            except Exception:
                return

    def _wait(self, pred, secs):
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

    def clear(self):
        self.msgs.clear()


def main():
    global BASE
    args = sys.argv[1:]
    if args and args[0].startswith("http"):
        BASE = args[0]
        args = args[1:]
        _ns["BASE"] = BASE
    accs = [a for a in args if not a.startswith("http")] or \
        [x for x in os.environ.get("CHECKIN_TEST_ACCOUNTS", "").replace(",", " ").split() if x]
    if len(accs) < 6:
        sys.exit("需要 6 个账号（口令不要写进仓库）：\n"
                 "  python tests/werewolf_flow.py [base] u1:p1 u2:p2 u3:p3 u4:p4 u5:p5 u6:p6\n"
                 "或设 CHECKIN_TEST_ACCOUNTS=\"u1:p1 u2:p2 ...\"")
    tokens = [login(*a.split(":", 1)) for a in accs]
    uids = [whoami(t) for t in tokens]

    # 阶段时长整体加速（默认 1；白天发言本来要 90 秒，整局跑完太慢）
    old_speed = set_speed(10)

    conns = [Pumped(t) for t in tokens]
    before = {u: api("/api/me", token=t)["points"] for u, t in zip(uids, tokens)}

    conns[0].send({"t": "game.create", "game": "werewolf"})
    room = None
    end = time.time() + 8
    while time.time() < end and not room:
        for m in conns[0].msgs:
            if m.get("t") == "game.entered":
                room = m["room"]["id"]
        time.sleep(0.1)
    check("建房间成功", bool(room))
    for c in conns[1:]:
        c.send({"t": "game.join", "room": room})
    time.sleep(1.0)
    for c in conns:
        c.send({"t": "game.ready"})
        time.sleep(0.1)
    check("6 人到齐自动开局", conns[0]._wait(
        lambda: (conns[0].state() or {}).get("my_role"), 12))

    roles = {}
    for u, c in zip(uids, conns):
        roles[u] = (c.state() or {}).get("my_role")
    wolves = [u for u in uids if roles[u] == "wolf"]
    seer = next((u for u in uids if roles[u] == "seer"), 0)
    witch = next((u for u in uids if roles[u] == "witch"), 0)
    check("身份分配完整（2 狼 + 预言家 + 女巫）", len(wolves) == 2 and bool(seer) and bool(witch),
          str(roles))

    conn_of = {u: c for u, c in zip(uids, conns)}
    done = set()
    day_seen = []
    finished = None
    deadline = time.time() + 200
    while time.time() < deadline:
        st = conns[0].state() or {}
        day = st.get("day")
        step = st.get("step")
        if day and (not day_seen or day_seen[-1] != day):
            day_seen.append(day)
        over = conns[0].over()
        if over or st.get("status") == "finished":
            finished = over or {"winners": st.get("winners"), "reason": st.get("reason")}
            break
        key = (day, step)
        alive = [u for u in st.get("order", []) if (st.get("alive") or {}).get(str(u))]
        if step == "wolf" and key not in done:
            done.add(key)
            target = next((u for u in alive if u not in wolves), 0)
            for w in wolves:
                if w in alive:
                    conn_of[w].send({"t": "game.act", "what": "wolf_kill", "target": target})
        elif step == "seer" and key not in done:
            done.add(key)
            target = next((u for u in alive if u in wolves), 0)
            if seer in alive:
                conn_of[seer].send({"t": "game.act", "what": "seer_check", "target": target})
        elif step == "witch" and key not in done:
            done.add(key)
            if witch in alive:
                conn_of[witch].send({"t": "game.act", "what": "witch", "use": ""})
        elif step == "vote" and key not in done:
            done.add(key)
            voters = [u for u in alive if (st.get("can_vote") or {}).get(str(u), True)]
            target = next((u for u in alive if u in wolves), next((u for u in alive), 0))
            for u in voters:
                conn_of[u].send({"t": "game.act", "what": "vote", "target": target})
        elif step == "speak":
            pass
        elif step == "hunter" and key not in done:
            done.add(key)
            h = (st.get("hunter") or {}).get("uid")
            if h and h in conn_of:
                conn_of[h].send({"t": "game.act", "what": "hunter", "target": 0})
        time.sleep(0.25)

    check("至少走到第 2 天（第一夜之后能正常进入下一阶段）", max(day_seen or [0]) >= 2,
          "day 序列: %s" % day_seen)
    check("多轮循环没有卡死（发言 -> 投票 -> 下一夜）", len(day_seen) >= 3 or bool(finished),
          "day 序列: %s" % day_seen)
    check("游戏能分出胜负", bool(finished), str(finished and finished.get("reason")))

    step_seq = []
    for m in conns[0].msgs:
        s = (m.get("room") or {}).get("state") or {}
        if m.get("t") == "game.state" and s.get("step") and (not step_seq or step_seq[-1] != s["step"]):
            step_seq.append(s["step"])
    check("阶段按 狼刀->预言家->女巫->发言->投票 顺序推进",
          all(x in step_seq for x in ("wolf", "seer", "witch", "speak", "vote")), str(step_seq))

    if finished:
        winners = finished.get("winners") or []
        reason = finished.get("reason") or ""
        if "狼人全部出局" in reason:
            check("狼人全出局 -> 胜方全是好人", winners and all(roles.get(u) != "wolf" for u in winners),
                  "winners=%s" % winners)
        else:
            check("屠边结束 -> 胜方全是狼人 (%s)" % reason, winners and all(roles.get(u) == "wolf" for u in winners),
                  "winners=%s roles=%s" % (winners, roles))
        time.sleep(1.2)
        after = {u: api("/api/me", token=t)["points"] for u, t in zip(uids, tokens)}
        gained = {u: after[u]["online"] - before[u]["online"] for u in uids}
        winners_up = all(gained[u] == 2 for u in winners) if winners else False
        losers_down = all(gained[u] == -1 for u in uids if u not in winners)
        check("赢家 +2 分 / 输家 -1 分", winners_up and losers_down, str(gained))

    restore_speed(old_speed)
    ok = sum(1 for _, good, _ in results if good)
    for name, good, extra in results:
        print(("PASS  " if good else "FAIL  ") + name + (("   [" + extra + "]") if extra and not good else ""))
    print("=== %d/%d ===" % (ok, len(results)))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
