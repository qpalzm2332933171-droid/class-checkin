"""两个客户端跑一局你画我猜 + 数字炸弹，验证按人下发的状态是否藏好了秘密。"""
import base64, json, os, socket, struct, sys, time, urllib.request

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


def check(name, ok):
    results.append((name, bool(ok)))


USERS = []
args = sys.argv[1:]
BASE = args[0] if args else "http://127.0.0.1:8081"
rest = args[1:]
if rest and ":" in rest[0]:
    for item in rest:
        name, _, password = item.partition(":")
        USERS.append((name, password))
else:
    USERS.append(("stu01", rest[0] if rest else ""))
    USERS.append(("stu02", rest[1] if len(rest) > 1 else ""))
while len(USERS) < 3:
    USERS.append(USERS[-1])

token_a, token_b, token_c = (login(u, p) for u, p in USERS[:3])
uid_a, uid_b, uid_c = whoami(token_a), whoami(token_b), whoami(token_c)
a = WS(token_a)
b = WS(token_b)
c = WS(token_c)
a.until({"hello"})
b.until({"hello"})
c.until({"hello"})

# ---- 你画我猜：秘密只发给画手 ----
a.send({"t": "game.create", "game": "draw"})
entered = a.until({"game.entered"})["room"]
room = entered["id"]
check("房间号是四位数字", str(room).isdigit() and len(str(room)) == 4)
b.send({"t": "game.join", "room": room, "play": True})
b.until({"game.entered"})
a.send({"t": "game.ready"})
_early = []
a.sock.settimeout(1.2)
try:
    for _ in range(6):
        _m = a.recv()
        if _m.get("t") in ("game.state", "game.update") and _m["room"]["state"].get("status") == "playing":
            _early.append(_m)
except Exception:
    pass
a.sock.settimeout(12)
check("只有一个人准备时不会开局", not _early)
b.send({"t": "game.ready"})


def wait_for(client, kinds, predicate, limit=40):
    for _ in range(limit):
        msg = client.until(kinds, limit=limit)
        if predicate(msg):
            return msg
    raise RuntimeError("没有等到符合条件的消息 " + str(kinds))


def wait_playing(client):
    for _ in range(40):
        msg = client.until({"game.state", "game.update"})
        state = msg["room"]["state"]
        if state.get("status") == "playing":
            return state
    raise RuntimeError("房间没有进入进行中状态")


state_a = wait_playing(a)
state_b = wait_playing(b)
drawer = state_a.get("drawer")
word_a, word_b = state_a.get("word", ""), state_b.get("word", "")
sees = {uid_a: word_a, uid_b: word_b}
secret = sees.get(drawer, "")
check("只有画手能看到词", bool(secret.strip()) and sum(1 for w in sees.values() if w.strip()) == 1)
check("轮次顺序不下发", ("order" not in state_a) and ("order" not in state_b))

guesser = b if drawer == uid_a else a
guesser.send({"t": "game.guess", "text": secret})
guesser.until({"game.update", "game.event"}, limit=20)
check("猜中广播", True)
a.send({"t": "game.leave"})
b.send({"t": "game.leave"})

# ---- 观战 + 中途离开 + 再来一局（五子棋 2 人位）----
# 固定房间号会被上一次跑挂掉的残留房间占用，所以这一节用随机四位号
code = str(1000 + (int(time.time() * 37) % 8999))
a.send({"t": "game.create", "game": "gomoku", "code": code})
room = a.until({"game.entered"}, limit=20)["room"]["id"]
check("可以指定四位房间号", str(room) == code)
b.send({"t": "game.create", "game": "gomoku", "code": code})
check("占用房间号会被拒绝", b.until({"game.error", "game.entered"}, limit=20).get("t") == "game.error")
b.send({"t": "game.create", "game": "gomoku", "code": "abcd"})
check("非数字房间号会被拒绝", b.until({"game.error", "game.entered"}, limit=20).get("t") == "game.error")
b.send({"t": "game.join", "room": "0001"})
check("房间不存在会报错", b.until({"game.error", "game.entered"}, limit=20).get("t") == "game.error")

b.send({"t": "game.join", "room": room, "play": True})
b.until({"game.entered"}, limit=20)
c.send({"t": "game.join", "room": room, "play": True})
spectate = c.until({"game.entered"}, limit=20)["room"]
check("满员时自动进入观战", bool(spectate["spectators"]) and
      all(p["uid"] != uid_c for p in spectate["players"]) and spectate["code"] == room)

a.send({"t": "game.ready"})
b.send({"t": "game.ready"})
wait_playing(a)
wait_playing(b)
a.send({"t": "game.leave"})
left_over = wait_for(b, {"game.over", "game.state"},
                     lambda m: m.get("t") == "game.over", limit=30)
check("有人中途离开按判负结算（对手直接获胜）",
      (not left_over.get("aborted")) and left_over.get("winners") == [uid_b])

c.send({"t": "game.join", "room": room, "play": True})
rejoin = c.until({"game.entered"}, limit=20)["room"]
check("离开后同一个房间号还能加进来", rejoin["id"] == room and
      any(p["uid"] == uid_c for p in rejoin["players"]))

b.send({"t": "game.rematch"})
vote = wait_for(b, {"game.rematch", "game.event"},
                lambda m: m.get("t") == "game.rematch" and uid_b in m.get("waiting", []), limit=30)
check("再来一局投票会广播", uid_b in vote.get("waiting", []))
c.send({"t": "game.rematch"})
restarted = wait_for(b, {"game.state", "game.rematch", "game.event"},
                     lambda m: m.get("t") == "game.state" and m["room"]["state"].get("status") == "playing",
                     limit=30)
check("两人都点再来一局后重开", restarted is not None)
b.send({"t": "game.leave"})
c.send({"t": "game.leave"})

# ---- 数字炸弹：秘密不下发 ----
a.send({"t": "game.create", "game": "bomb"})
room = a.until({"game.entered"}, limit=20)["room"]
check("随机房间号也是四位数字", str(room["id"]).isdigit() and len(str(room["id"])) == 4)
b.send({"t": "game.join", "room": room["id"], "play": True})
b.until({"game.entered"}, limit=20)
a.send({"t": "game.ready"})
b.send({"t": "game.ready"})
played = wait_for(a, {"game.state", "game.update"},
                  lambda m: m["room"]["state"].get("status") == "playing", limit=30)
check("双方准备后炸弹开局", played is not None)
first = played["room"]["state"] if played else {}
check("炸弹数字不下发", "bomb" not in first)

socks = {uid_a: a, uid_b: b}
state = first
over = None
for _ in range(14):
    if not state or state.get("status") != "playing":
        break
    lo, hi, turn = state.get("lo"), state.get("hi"), state.get("turn")
    if lo is None or hi is None or hi - lo <= 1 or turn not in socks:
        break
    socks[turn].send({"t": "game.guess", "text": str((lo + hi) // 2)})
    msg = a.until({"game.update", "game.state", "game.over"}, limit=30)
    if msg.get("t") == "game.over":
        over = msg
        break
    state = msg["room"]["state"]

if over:
    final = over["room"]["state"]
    bomb = final.get("bomb")
    hist = final.get("history") or []
    ok_dir = bool(hist) and all(
        ("low" if h["n"] < bomb else "high") == h.get("dir") for h in hist)
    check("炸弹方向与真实炸弹一致", ok_dir)
    check("炸弹一局能正常分出胜负", bool(final.get("loser")) and bool(final.get("winners")))
else:
    check("炸弹方向与真实炸弹一致", False)
    check("炸弹一局能正常分出胜负", False)

a.send({"t": "game.leave"})
b.send({"t": "game.leave"})

# ---- 联机积分：赢 +2 / 输 -1 ----
p0a = api("/api/me", token=token_a)["points"]
p0b = api("/api/me", token=token_b)["points"]
a.send({"t": "game.create", "game": "tictactoe"})
room = a.until({"game.entered"}, limit=200)["room"]
b.send({"t": "game.join", "room": room["id"], "play": True})
b.until({"game.entered"}, limit=200)
a.send({"t": "game.ready"})
b.send({"t": "game.ready"})
try:
    wait_for(a, {"game.state"}, lambda m: m["room"]["state"].get("status") == "playing", limit=60)
except RuntimeError:
    pass
for idx, who in [(0, a), (3, b), (1, a), (4, b), (2, a)]:
    who.send({"t": "game.move", "index": idx})
    time.sleep(0.25)
try:
    a.until({"game.over"}, limit=200)
except RuntimeError:
    pass
p1a = api("/api/me", token=token_a)["points"]
p1b = api("/api/me", token=token_b)["points"]
check("联机赢家 +2 分 (%d->%d)" % (p0a["online"], p1a["online"]), p1a["online"] - p0a["online"] == 2)
check("联机赢家胜场 +1", p1a["wins"] - p0a["wins"] == 1)
check("联机输家 -1 分 (%d->%d)" % (p0b["online"], p1b["online"]), p1b["online"] - p0b["online"] == -1)
check("联机输家负场 +1", p1b["losses"] - p0b["losses"] == 1)
a.send({"t": "game.leave"})
b.send({"t": "game.leave"})

failed = [name for name, ok in results if not ok]
for name, ok in results:
    print(("PASS  " if ok else "FAIL  ") + name)
print("=== %d/%d ===" % (len(results) - len(failed), len(results)))
sys.exit(1 if failed else 0)
