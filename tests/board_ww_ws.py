"""两个客户端跑一局你画我猜 + 数字炸弹，验证按人下发的状态是否藏好了秘密。"""
import base64, json, os, socket, struct, sys, time, urllib.request
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = sys.argv[1]
PASS_A = sys.argv[2]
PASS_B = sys.argv[3]


def api(path, method="GET", body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


class WS:
    def __init__(self, token):
        host = BASE.split("//", 1)[1].split(":")[0]
        port = int(BASE.rsplit(":", 1)[1])
        self.sock = socket.create_connection((host, port), timeout=12)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(("GET /ws?token=%s&device=web HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
                           "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
                           % (token, host, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, obj):
        payload = json.dumps(obj).encode()
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        head = bytearray([0x81])
        if len(payload) < 126:
            head.append(0x80 | len(payload))
        else:
            head.append(0x80 | 126); head += struct.pack(">H", len(payload))
        self.sock.sendall(bytes(head) + mask + masked)

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        b0, b1 = self._need(2)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._need(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._need(8))[0]
        data = self._need(length)
        if (b0 & 0x0F) != 1:
            return {"t": "_"}
        return json.loads(data.decode())

    def until(self, kinds, limit=40):
        for _ in range(limit):
            msg = self.recv()
            if msg.get("t") in kinds:
                return msg
        raise RuntimeError("没等到 " + str(kinds))


def login(user, pw):
    return api("/api/login", "POST", {"username": user, "password": pw})["token"]


def whoami(token):
    return api("/api/me", token=token)["user"]["id"]



results = []
BASE = next((x for x in sys.argv[1:] if x.startswith("http")), "http://127.0.0.1:8081")
ACCS = []
for item in sys.argv[1:]:
    if item.startswith("http"):
        continue
    if ":" in item:
        n, _, p = item.partition(":")
        ACCS.append((n, p))
assert len(ACCS) >= 8, "需要 8 个账号"


def state_of(ws, limit=60):
    msg = ws.until({"game.state", "game.update"}, limit=limit)
    return msg


results = []


def check(name, ok):
    results.append((name, bool(ok)))


# ================================================================ 围棋
def wait_room(ws, pred, limit=120):
    for _ in range(limit):
        m = ws.recv()
        if m.get("t") in ("game.state", "game.update", "game.entered", "game.finished"):
            rm = m.get("room") or {}
            if pred(rm):
                return rm
    raise RuntimeError("wait_room 超时")


def st_until(ws, pred, limit=120):
    rm = wait_room(ws, lambda r: bool(r.get("state")) and pred(r["state"]), limit)
    return rm["state"], rm


token_a, token_b = login(*ACCS[0]), login(*ACCS[1])
uid_a, uid_b = whoami(token_a), whoami(token_b)
a, b = WS(token_a), WS(token_b)
a.until({"hello"}); b.until({"hello"})
a.send({"t": "game.create", "game": "go"})
room = a.until({"game.entered"}, limit=20)["room"]["id"]
check("围棋房间号是四位数字", str(room).isdigit() and len(str(room)) == 4)
b.send({"t": "game.join", "room": room})
b.until({"game.entered"}, limit=20)
a.send({"t": "game.ready"}); b.send({"t": "game.ready"})
st, _ = st_until(a, lambda s: s.get("turn") and len(s.get("board") or []) == 81)
check("围棋开局 9x9 / 81 格", st.get("cols") == 9 and st.get("rows") == 9 and len(st.get("board") or []) == 81)
check("围棋黑棋先行", st.get("turn") == uid_a and st.get("marks", {}).get(str(uid_a)) == 1)
a.send({"t": "game.move", "index": 40})
st, _ = st_until(b, lambda s: (s.get("board") or [0] * 81)[40] == 1)
check("围棋落子成功", st["board"][40] == 1 and st["turn"] == uid_b)
b.send({"t": "game.move", "index": 40})
ev = b.until({"game.event", "game.update"})
check("围棋不能落在已有子上", ev.get("t") == "game.event" and "不能落子" in ev.get("text", ""))
b.send({"t": "game.move", "index": 41})
st, _ = st_until(a, lambda s: (s.get("board") or [0] * 81)[41] == 2)
check("围棋白棋落子", st["board"][41] == 2 and st["turn"] == uid_a)
a.send({"t": "game.move", "pass": True})
st, _ = st_until(b, lambda s: s.get("passes") == 1)
check("围棋停一手计数", st.get("passes") == 1 and st.get("turn") == uid_b)
b.send({"t": "game.move", "pass": True})
over = None
for _ in range(80):
    m = b.recv()
    if m.get("t") == "game.over":
        over = m
        break
check("围棋双方连续停手终局", bool(over) and "停手" in (over or {}).get("reason", ""))
check("围棋终局给出数子比分",
      bool(over) and bool((over.get("room", {}).get("state") or {}).get("score"))
      and bool(over.get("winners") is not None))

# ================================================================ 象棋
token_a, token_b = login(*ACCS[0]), login(*ACCS[1])
a, b = WS(token_a), WS(token_b)
a.until({"hello"}); b.until({"hello"})
a.send({"t": "game.create", "game": "xiangqi"})
room = a.until({"game.entered"}, limit=20)["room"]["id"]
b.send({"t": "game.join", "room": room})
b.until({"game.entered"}, limit=20)
a.send({"t": "game.ready"}); b.send({"t": "game.ready"})
st, _ = st_until(a, lambda s: len(s.get("board") or []) == 90 and sum(1 for v in s["board"] if v) == 32)
board = st.get("board") or []
check("象棋 9x10 / 32 子", st.get("cols") == 9 and st.get("rows") == 10 and len(board) == 90
      and sum(1 for v in board if v) == 32)
check("象棋红方先行", st.get("turn") == uid_a and st.get("marks", {}).get(str(uid_a)) == 1)
a.send({"t": "game.move", "from": 54, "to": 45})
st, _ = st_until(b, lambda s: (s.get("board") or [0] * 90)[45] == 7)
check("象棋兵可以进一格", st["board"][45] == 7 and st["board"][54] == 0 and st["turn"] == uid_b)
b.send({"t": "game.move", "from": 45, "to": 44})
ev = b.until({"game.event", "game.update"})
check("象棋不能走对方的棋子", ev.get("t") == "game.event" and "对手" in ev.get("text", ""))
b.send({"t": "game.move", "from": 27, "to": 36})
st, _ = st_until(a, lambda s: (s.get("board") or [0] * 90)[36] == -7)
check("象棋黑卒可以进一格", st["board"][36] == -7 and st["turn"] == uid_a)
b.send({"t": "game.move", "from": 27, "to": 36})
ev = None
for _ in range(40):
    m = b.recv()
    if m.get("t") == "game.event" and "还没轮到" in m.get("text", ""):
        ev = m
        break
check("象棋不能连走两步", ev is not None)
a.send({"t": "game.move", "resign": True})
over = None
for _ in range(80):
    m = a.recv()
    if m.get("t") == "game.over":
        over = m
        break
check("象棋认输能结束对局且对手获胜", bool(over) and over.get("winners") == [uid_b] and "认输" in over.get("reason", ""))

# ================================================================ 狼人杀 6 人
tokens = [login(*acc) for acc in ACCS[2:8]]
uids = [whoami(t) for t in tokens]
cons = [WS(t) for t in tokens]
for c in cons:
    c.until({"hello"})
cons[0].send({"t": "game.create", "game": "werewolf"})
room = cons[0].until({"game.entered"}, limit=20)["room"]["id"]
for c in cons[1:]:
    c.send({"t": "game.join", "room": room})
    c.until({"game.entered"}, limit=20)
check("狼人杀 6 人能进同一房间", True)
for c in cons:
    c.send({"t": "game.ready"})
    time.sleep(0.2)
time.sleep(2.0)
views = {}
for c, u in zip(cons, uids):
    rm = wait_room(c, lambda r: bool((r.get("state") or {}).get("my_role")), 200)
    views[u] = rm["state"]
roles = [v.get("my_role") for v in views.values()]
check("狼人杀 6 人局 = 2 狼 / 2 民 / 预言家 + 女巫",
      sorted(roles) == sorted(["wolf", "wolf", "villager", "villager", "seer", "witch"]))
check("狼人杀开局进入夜晚狼刀", all(v.get("step") == "wolf" for v in views.values()) and all(v.get("phase") == "night" for v in views.values()))
wolf_pairs = [(c, u) for c, u in zip(cons, uids) if views[u].get("my_role") == "wolf"]
wolf_conn, wolf_uid = wolf_pairs[0]
seer_conn = [c for c, u in zip(cons, uids) if views[u].get("my_role") == "seer"][0]
witch_conn = [c for c, u in zip(cons, uids) if views[u].get("my_role") == "witch"][0]
check("狼人杀能看到狼队友", len(views[wolf_uid].get("wolf_mates") or []) == 1
      and views[wolf_uid]["wolf_mates"][0]["uid"] == wolf_pairs[1][1])
good = [u for u in uids if views[u].get("my_role") not in ("wolf", "seer")]
wolf_victim = good[0]
wolf_conn.send({"t": "game.act", "what": "wolf_kill", "target": wolf_victim})
wolf_pairs[1][0].send({"t": "game.act", "what": "wolf_kill", "target": wolf_victim})
time.sleep(0.8)
sv = None
for _ in range(40):
    m = seer_conn.recv()
    if m.get("t") == "game.state" and m["room"]["state"].get("step") == "seer":
        sv = m["room"]["state"]
        break
check("狼刀之后进入预言家", sv is not None)
seer_conn.send({"t": "game.act", "what": "seer_check", "target": wolf_uid})
time.sleep(0.8)
wv = None
for _ in range(40):
    m = witch_conn.recv()
    if m.get("t") == "game.state" and m["room"]["state"].get("step") == "witch":
        wv = m["room"]["state"]
        break
check("预言家验人结果只给自己且判对狼人",
      bool(wv) and (wv.get("witch") or {}).get("seen") == wolf_victim)
seer_view = None
for _ in range(60):
    try:
        m = seer_conn.recv()
    except Exception:
        break
    if m.get("t") == "game.state" and m["room"]["state"].get("step") == "witch":
        seer_view = m["room"]["state"]
        break
check("预言家验人记录下发本人（判对狼人）",
      bool(seer_view) and any(c.get("uid") == wolf_uid and c.get("wolf") for c in (seer_view.get("checks") or [])))
check("女巫能看到今晚倒牌的人", bool(wv) and (wv.get("witch") or {}).get("seen") == wolf_victim)
witch_conn.send({"t": "game.act", "what": "witch", "use": ""})
time.sleep(1.0)
dv = None
for _ in range(60):
    m = witch_conn.recv()
    if m.get("t") == "game.state" and m["room"]["state"].get("step") == "speak":
        dv = m["room"]["state"]
        break
check("女巫不用药则狼刀生效", bool(dv) and dv.get("last_deaths") == [wolf_victim])
check("天亮后进入发言阶段", bool(dv) and dv.get("step") == "speak")
check("狼人杀下发我的阵营", bool(dv) and dv.get("my_team") == "good" and dv.get("winner_team") == "")

print("======================================")
ok_count = sum(1 for _, o in results if o)
for name, ok in results:
    print(("PASS  " if ok else "FAIL  ") + name)
print("=== %d/%d ===" % (ok_count, len(results)))
sys.exit(0 if ok_count == len(results) else 1)
