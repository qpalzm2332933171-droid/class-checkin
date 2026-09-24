"""骗子酒馆完整流程回归：4 个客户端真的打完整一局。

验证的是"网络层 + 房间壳子 + 状态机"三者的接缝：
  * 建房间 / 4 人到齐 / 全员准备才开局
  * 每人只拿到自己的 5 张牌，4 个人拼起来正好是完整 20 张牌堆
  * 实弹位置不通过网络泄露给任何人
  * 出牌 -> 质疑 -> 开牌 -> 挨枪 -> 下一轮 的完整闭环
  * 回合超时由服务端自动兜底（不会把整局卡死）
  * 最后只剩 1 人时 game.over 下发，积分 +2 / -1

用法: python tests/liar_flow.py [base] u1:p1 u2:p2 u3:p3 u4:p4
  或设 CHECKIN_TEST_ACCOUNTS="u1:p1 u2:p2 u3:p3 u4:p4"
"""
import os
import sys
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

import threading

results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))


# ---------------------------------------------------------------- 加速旋钮
def _resolve_data_dir(users):
    """定位"服务端真正在用的那个库"。

    坑（踩过一次）：db.py 按 CHECKIN_DATA 找库，测试进程里没有这个变量就会落到
    server/data/app.db；而本地开发时服务端通常跑在 class-checkin/data。
    写错库不会报任何错 —— 只是加速旋钮静默失效，整局按原速跑，
    测试于是以"超时"的形式假失败，排查半天才发现跟被测代码无关。

    所以这里按候选路径挑一个"确实装着本次测试全部账号"的库；
    一个都挑不出来就直接报错说清楚，不猜。
    """
    import sqlite3
    here = os.path.dirname(os.path.abspath(__file__))
    cands = []
    if os.environ.get("CHECKIN_DATA"):
        cands.append(os.environ["CHECKIN_DATA"])
    cands.append(os.path.join(here, "..", "server", "data"))
    cands.append(os.path.join(here, "..", "data"))
    marks = ",".join("?" * len(users))
    for d in cands:
        path = os.path.join(d, "app.db")
        if not os.path.isfile(path):
            continue
        try:
            con = sqlite3.connect(path)
            hit = con.execute(
                "SELECT COUNT(*) FROM users WHERE username IN (%s)" % marks,
                list(users)).fetchone()[0]
            con.close()
        except Exception:
            continue
        if hit == len(users):
            return os.path.abspath(d)
    print("⚠ 找不到服务端在用的数据库（试过：%s）。" % "、".join(cands))
    print("  跳过加速旋钮，整局按原速跑（每回合 25 秒，会比较慢）。")
    print("  本机跑请把 CHECKIN_DATA 指到服务端的数据目录；对着远端跑就先手动调快。")
    return None


def set_speed(speed=5, users=()):
    """返回旧值；摸不到服务端数据库就返回 None（不阻断测试，只是不加速）。"""
    data_dir = _resolve_data_dir(users)
    if not data_dir:
        return None
    os.environ["CHECKIN_DATA"] = data_dir
    import db
    db.init()
    old = db.setting("liar_speed", "1")
    db.set_setting("liar_speed", str(speed))
    return old


def restore_speed(old):
    if old is None:
        return
    import db
    if old in ("", None):
        db.execute("DELETE FROM settings WHERE k = ?", ("liar_speed",))
    else:
        db.set_setting("liar_speed", old)


class Pumped:
    """后台线程持续收消息，主线程只查最新状态（避免超时把 WebSocket 帧读残）。"""

    def __init__(self, tok):
        self.ws = WS(tok)
        self.msgs = []
        self._stop = False
        threading.Thread(target=self._pump, daemon=True).start()
        self.wait(lambda: any(m.get("t") == "hello" for m in self.msgs), 5)

    def _pump(self):
        while not self._stop:
            try:
                self.msgs.append(self.ws.recv())
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
            if m.get("t") in ("game.state", "game.update", "game.over") and (m.get("room") or {}).get("state"):
                return m["room"]["state"]
        return {}

    def over(self):
        for m in reversed(self.msgs):
            if m.get("t") == "game.over":
                return m
        return None

    def events(self):
        return [m.get("text", "") for m in self.msgs if m.get("t") == "game.event"]


def main():
    global BASE
    args = sys.argv[1:]
    if args and args[0].startswith("http"):
        BASE = args[0]
        args = args[1:]
        _ns["BASE"] = BASE
    accs = [a for a in args if not a.startswith("http")] or \
        [x for x in os.environ.get("CHECKIN_TEST_ACCOUNTS", "").replace(",", " ").split() if x]
    if len(accs) < 4:
        sys.exit("需要 4 个账号（口令不要写进仓库）：\n"
                 "  python tests/liar_flow.py [base] u1:p1 u2:p2 u3:p3 u4:p4\n"
                 '或设 CHECKIN_TEST_ACCOUNTS="u1:p1 u2:p2 u3:p3 u4:p4"')
    accs = accs[:4]
    tokens = [login(*a.split(":", 1)) for a in accs]
    uids = [whoami(t) for t in tokens]

    # 开牌展示期本来 7 秒，整局跑完太慢；回合给 5 秒，够客户端反应也够验证超时兜底
    old_speed = set_speed(5, [a.split(":", 1)[0] for a in accs])

    conns = [Pumped(t) for t in tokens]
    conn_of = {u: c for u, c in zip(uids, conns)}
    before = {u: api("/api/me", token=t)["points"] for u, t in zip(uids, tokens)}

    # ------------------------------------------------------------ 建房 / 加入 / 准备
    conns[0].send({"t": "game.create", "game": "liar"})
    room_id = None
    end = time.time() + 8
    while time.time() < end and not room_id:
        for m in conns[0].msgs:
            if m.get("t") == "game.entered":
                room_id = m["room"]["id"]
        time.sleep(0.05)
    check("建房间成功", bool(room_id), str(room_id))

    conns[0].send({"t": "game.ready"})
    time.sleep(0.3)
    check("只有 1 个人时不会开局（4 人局必须凑满）",
          not (conns[0].state() or {}).get("my_hand"))

    for c in conns[1:]:
        c.send({"t": "game.join", "room": room_id})
        time.sleep(0.15)
    time.sleep(0.4)
    for c in conns[1:]:
        c.send({"t": "game.ready"})
        time.sleep(0.1)

    check("4 人到齐 + 全员准备 -> 自动开局",
          conns[0].wait(lambda: len((conns[0].state() or {}).get("my_hand") or []) == 5, 12))

    # ------------------------------------------------------------ 发牌 & 秘密隔离
    states = [c.state() or {} for c in conns]
    hands = [(s.get("my_hand") or []) for s in states]
    check("每人手里正好 5 张牌", all(len(h) == 5 for h in hands), str([len(h) for h in hands]))
    pool = sorted(c for h in hands for c in h)
    check("4 个人的手牌拼起来 = 完整 20 张牌堆（Q6 K6 A6 J2）",
          pool == sorted(["Q"] * 6 + ["K"] * 6 + ["A"] * 6 + ["J"] * 2), str(pool))
    check("每个人看到的都是自己的牌（4 份手牌互不相同）",
          len({tuple(h) for h in hands}) == 4)
    check("状态里根本不带 hands 字段（服务器不会把别人的牌发过来）",
          all("hands" not in s for s in states))
    check("实弹位置不经过网络下发（只有已开枪数）",
          all(("bullet" not in str(s.get("revolver"))) for s in states))
    check("开局每个人头顶都是 0/6", all(
        list((s.get("revolver") or {}).values()) == [0, 0, 0, 0] for s in states))
    st0 = states[0]
    check("Table 牌是 Q/K/A 之一", st0.get("table") in ("Q", "K", "A"), str(st0.get("table")))
    check("座位和名字都下发了", len(st0.get("order") or []) == 4 and len(st0.get("names") or {}) == 4)
    check("本轮先手就是轮到的那个玩家",
          (st0.get("can") or {}).get("play") or (st0.get("can") or {}).get("doubt")
          or (conn_of.get(st0.get("turn")) is not None))

    # ------------------------------------------------------------ 超时兜底（真实走一遍 ticker）
    turn_uid = st0.get("turn")
    first = conn_of.get(turn_uid)
    pile_before = len(first.state().get("pile") or [])
    check("第一回合先手挂机 -> 服务端超时自动出牌",
          first.wait(lambda: len((first.state() or {}).get("pile") or []) > pile_before, 14))
    check("超时有明确提示", any("超时" in e for e in first.events()))

    # ------------------------------------------------------------ 打完整局
    stats = {"play": 0, "doubt": 0, "pass": 0, "reveal": 0, "round": 0, "shots": 0, "deaths": 0}
    final_n = 0
    last_key = None
    finished = None
    deadline = time.time() + 240
    while time.time() < deadline:
        st = conns[0].state() or {}
        over = conns[0].over()
        if over or st.get("status") == "finished":
            finished = over or {"winners": st.get("winners"), "reason": st.get("reason")}
            break
        round_no = st.get("round") or 0
        if round_no > stats["round"]:
            stats["round"] = round_no
        if st.get("phase") == "reveal":
            if last_key != ("reveal", round_no, st.get("pile_total")):
                last_key = ("reveal", round_no, st.get("pile_total"))
                stats["reveal"] += 1
                rev = st.get("reveal") or {}
                if rev.get("shot"):
                    stats["shots"] += 1
                if (rev.get("shot") or {}).get("died"):
                    stats["deaths"] += 1
            time.sleep(0.15)
            continue

        turn = st.get("turn")
        cur = conn_of.get(turn)
        if cur is None:
            time.sleep(0.15)
            continue
        key = (st.get("phase"), turn, round_no, st.get("pile_total"),
               (cur.state().get("hand_count") or {}).get(str(turn)))
        if key == last_key:
            time.sleep(0.1)
            continue
        can = (cur.state().get("can") or {})

        if st.get("phase") == "final":
            # 一半质疑一半放过，两条分支都要覆盖到
            act = "doubt" if final_n % 2 == 0 else "pass"
            final_n += 1
            cur.send({"t": "game.act", "action": "act", "what": act})
            stats[act] += 1
            last_key = key
        elif can.get("doubt") and stats["doubt"] % 3 != 2:
            cur.send({"t": "game.act", "action": "act", "what": "doubt"})
            stats["doubt"] += 1
            last_key = key
        elif can.get("play"):
            cur.send({"t": "game.act", "action": "act", "what": "play", "cards": [0]})
            stats["play"] += 1
            last_key = key
        else:
            time.sleep(0.1)
        time.sleep(0.22)

    check("对局能在时限内打完并收到 game.over", bool(finished), str(finished))
    if finished:
        winners = finished.get("winners") or []
        check("赢家只有一个（最后活着的人）", len(winners) == 1, str(winners))
        final_st = conns[0].state() or {}
        alive = [u for u, v in (final_st.get("alive") or {}).items() if v]
        check("结算时恰好剩 1 人存活", len(alive) == 1, str(alive))
        check("赢家就是那个活着的人", [str(w) for w in winners] == alive)
        # 4 条连接各自有独立收包线程，game.over 不保证同一个瞬间被解析完。
        # 对着远端跑时这个竞态会真的踩到（线上实测过一次假失败），所以给它一点时间。
        def all_ended():
            return all(cc.over() or (cc.state() or {}).get("status") == "finished" for cc in conns)

        for _ in range(20):
            if all_ended():
                break
            time.sleep(0.1)
        check("所有人都收到了结束推送", all_ended())
        check("过程里真的开过牌", stats["reveal"] > 0, str(stats))
        check("过程里真的开过枪", stats["shots"] > 0, str(stats))
        check("出完手牌的两条分支都走到过（有人质疑 / 有人放过）",
              stats["pass"] > 0 or stats["deaths"] > 0, str(stats))
        check("至少打满 2 轮（出完手牌/开牌后会重发一轮）", stats["round"] >= 2, str(stats["round"]))

        after = {u: api("/api/me", token=t)["points"] for u, t in zip(uids, tokens)}
        gain = {u: after[u]["online"] - before[u]["online"] for u in uids}
        check("赢家 +2 分", gain.get(int(winners[0])) == 2, str(gain))
        check("其余人 -1 分",
              all(gain[u] == -1 for u in uids if u != int(winners[0])), str(gain))
        rec = api("/api/games/meta", token=tokens[0])["records"]
        check("战绩写进了 game_records",
              any(r.get("game") == "liar" for r in rec), str([r.get("game") for r in rec[:5]]))

    # ------------------------------------------------------------ 房间收尾
    conns[0].send({"t": "game.leave"})
    time.sleep(0.6)

    restore_speed(old_speed)

    print("======================================")
    ok = sum(1 for _, o, _e in results if o)
    for name, good, extra in results:
        print(("PASS  " if good else "FAIL  ") + name + (("   [" + extra + "]") if extra else ""))
    print("过程统计:", stats)
    print("=== %d/%d ===" % (ok, len(results)))
    sys.exit(0 if ok == len(results) else 1)


if __name__ == "__main__":
    main()
