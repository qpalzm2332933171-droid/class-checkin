"""WebSocket layer: handshake, frame codec, presence, chat, game routing."""

import asyncio
import base64
import hashlib
import struct
import time

import auth
import db
from util import dumps, log, loads, now

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PING_INTERVAL = 25
IDLE_TIMEOUT = 90

CONNS = set()
BY_USER = {}
GUEST_ALIASES = [
    "云朵", "海盐", "柠檬", "薄荷", "星河", "橘子", "银河", "青柠", "西瓜", "桃桃",
    "椰子", "布丁", "小满", "泡芙", "鲸鱼", "柚子", "奶油", "芒果", "松饼", "苏打",
    "月亮", "太阳", "流星", "闪电", "彩虹", "雪糕", "薯条", "小鹿", "企鹅", "海豚",
]


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key.strip() + GUID).encode()).digest()).decode()


def encode_frame(opcode, payload=b""):
    head = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        head += bytes([length])
    elif length < 65536:
        head += bytes([126]) + struct.pack("!H", length)
    else:
        head += bytes([127]) + struct.pack("!Q", length)
    return head + payload


async def read_frame(reader):
    header = await reader.readexactly(2)
    opcode = header[0] & 0x0F
    masked = header[1] & 0x80
    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]
    if length > 8 * 1024 * 1024:
        raise ValueError("frame too large")
    mask = await reader.readexactly(4) if masked else b""
    data = await reader.readexactly(length) if length else b""
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def anon_alias(user_id):
    """Stable per user for the current day, rotates daily."""
    day = time.strftime("%Y%m%d")
    seed = hashlib.sha1(("%s:%s" % (day, user_id)).encode()).digest()
    name = GUEST_ALIASES[seed[0] % len(GUEST_ALIASES)]
    return "%s#%02d" % (name, seed[1] % 100)


class Conn:
    def __init__(self, user, reader, writer, ip="", device="web"):
        self.user = user
        self.reader = reader
        self.writer = writer
        self.ip = ip
        self.device = device
        self.closed = False
        self.passive = False       # 「只看不收」的静默连接（安卓后台值守）：不计在线人数
        self.last_seen = now()
        self.rooms = set()
        self.detached_at = 0        # 断线时刻（0 = 在线）。房间宽限期内保留座位
        self.write_lock = asyncio.Lock()

    @property
    def uid(self):
        return self.user["id"]

    async def send(self, obj):
        if self.closed:
            return
        try:
            async with self.write_lock:
                self.writer.write(encode_frame(0x1, dumps(obj)))
                await self.writer.drain()
        except Exception:  # noqa: BLE001
            self.closed = True

    async def send_text(self, text):
        await self.send({"t": "text", "text": text})

    async def close(self, code=1000):
        if self.closed:
            return
        self.closed = True
        try:
            async with self.write_lock:
                self.writer.write(encode_frame(0x8, struct.pack("!H", code)))
                await self.writer.drain()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.writer.close()
        except Exception:  # noqa: BLE001
            pass


def user_view(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "color": row.get("color") or "",
        "avatar": row.get("avatar") or "",
    }


async def broadcast(obj, exclude=None, room_only=None):
    for conn in list(CONNS):
        if conn is exclude or conn.closed:
            continue
        if room_only is not None and room_only not in conn.rooms:
            continue
        await conn.send(obj)


def live_conns():
    """真正代表"人在线"的连接：安卓后台值守那条被动连接不算。"""
    return [c for c in CONNS if not c.closed and not c.passive]


def online_count():
    return len({c.uid for c in live_conns()})


def online_users():
    seen = {}
    for conn in live_conns():
        seen[conn.uid] = user_view(conn.user)
    return list(seen.values())


async def push_presence():
    await broadcast({"t": "presence", "count": online_count(), "users": online_users()})


async def handle_chat_send(conn, msg):
    content = (msg.get("content") or "").strip()
    if not content:
        return
    if len(content) > 500:
        content = content[:500]
    if conn.user.get("muted"):
        await conn.send_text("你已被禁言，无法发言")
        return
    if db.setting("chat_enabled", "1") != "1":
        await conn.send_text("讨论区当前已关闭")
        return
    anon = 1 if msg.get("anon", 0) else 0   # 讨论默认实名，匿名要在界面里自己开
    reply_to = int(msg.get("reply_to") or 0)
    alias = anon_alias(conn.uid) if anon else conn.user["name"]
    topic_id = int(msg.get("topic_id") or 0)
    if topic_id and not db.query_one("SELECT id FROM topics WHERE id = ? AND deleted = 0", (topic_id,)):
        await conn.send({"t": "chat.error", "message": "话题不存在或已删除"})
        return
    created = now()
    post_id = db.execute(
        "INSERT INTO posts(author_id, anon, anon_name, content, kind, reply_to, created_at, topic_id) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (conn.uid, anon, alias, content, "chat", reply_to, created, topic_id))
    if topic_id:
        db.execute("UPDATE topics SET reply_count = reply_count + 1, last_at = ? WHERE id = ?", (created, topic_id))
        await broadcast({"t": "topic.bump", "topic_id": topic_id, "last_at": created,
                         "reply_count": (db.query_one("SELECT reply_count FROM topics WHERE id = ?",
                                                      (topic_id,)) or {}).get("reply_count", 0)})
    payload = {
        "t": "chat.new",
        "msg": {
            "id": post_id,
            "topic_id": topic_id,
            "name": alias,
            "anon": bool(anon),
            "color": conn.user.get("color") or "",
            "avatar": "" if anon else (conn.user.get("avatar") or ""),
            "content": content,
            "created_at": created,
            "reply_to": reply_to,
            "reactions": [],
            "mine": False,
        },
    }
    for target in list(CONNS):
        if target.closed:
            continue
        clone = dict(payload["msg"])
        clone["mine"] = target.uid == conn.uid
        await target.send({"t": "chat.new", "msg": clone})


async def handle_message(conn, msg):
    conn.last_seen = now()
    kind = msg.get("t") or ""
    if kind == "ping":
        await conn.send({"t": "pong", "ts": now()})
        return
    if kind == "chat.send":
        await handle_chat_send(conn, msg)
        return
    if kind == "chat.react":
        post_id = int(msg.get("post_id") or 0)
        emoji = (msg.get("emoji") or "")[:8]
        if post_id and emoji:
            try:
                db.execute("INSERT INTO reactions(post_id, user_id, emoji, created_at) VALUES(?,?,?,?)",
                           (post_id, conn.uid, emoji, now()))
            except Exception:  # noqa: BLE001  (duplicate reaction)
                pass
            rows = db.query("SELECT emoji, COUNT(*) AS n FROM reactions WHERE post_id = ? GROUP BY emoji", (post_id,))
            await broadcast({"t": "chat.reactions", "post_id": post_id, "reactions": rows})
        return
    if kind == "presence.get":
        await conn.send({"t": "presence", "count": online_count(),
                         "users": online_users()})
        return
    if kind.startswith("game."):
        import games
        await games.handle(conn, kind[5:], msg)
        return


async def run_connection(req, reader, writer):
    key = req.header("sec-websocket-key")
    if not key:
        writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    token = req.q("token") or req.header("authorization").replace("Bearer ", "").strip()
    user = auth.user_by_token(token)
    if not user:
        body = b'{"ok":false,"error":"\\u672a\\u767b\\u5f55"}'
        writer.write(b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: "
                     + str(len(body)).encode() + b"\r\n\r\n" + body)
        await writer.drain()
        writer.close()
        return
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                  "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % accept_key(key)).encode())
    await writer.drain()

    conn = Conn(user, reader, writer, req.client_ip, req.q("device", "web"))
    # watch=1：安卓客户端的后台值守长连接。它要能收到 broadcast（新签到推送），
    # 但不应把用户算成"在线"，也不该触发 presence 广播。
    conn.passive = req.q("watch") in ("1", "true")
    CONNS.add(conn)
    BY_USER.setdefault(conn.uid, set()).add(conn)
    db.execute("UPDATE users SET last_login = ? WHERE id = ?", (now(), conn.uid))
    try:
        await conn.send({
            "t": "hello",
            "user": user_view(user),
            "alias": anon_alias(conn.uid),
            "settings": db.get_settings(),
            "online": online_count(),
            "server_time": now(),
        })
        if not conn.passive:
            await push_presence()
        while not conn.closed:
            opcode, data = await read_frame(reader)
            if opcode == 0x8:
                break
            if opcode == 0x9:
                async with conn.write_lock:
                    writer.write(encode_frame(0xA, data))
                    await writer.drain()
                continue
            if opcode == 0xA:
                conn.last_seen = now()
                continue
            if opcode in (0x1, 0x2):
                msg = loads(data.decode("utf-8", "replace"), None)
                if isinstance(msg, dict):
                    try:
                        await handle_message(conn, msg)
                    except Exception as exc:  # noqa: BLE001
                        log("ws handler error", repr(exc))
                        await conn.send_text("操作失败: %s" % exc)
    except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
        pass
    except Exception as exc:  # noqa: BLE001
        log("ws connection error", repr(exc))
    finally:
        conn.closed = True
        CONNS.discard(conn)
        group = BY_USER.get(conn.uid)
        if group:
            group.discard(conn)
            if not group:
                BY_USER.pop(conn.uid, None)
        try:
            import games
            await games.on_disconnect(conn)
        except Exception:  # noqa: BLE001
            pass
        if not conn.passive:
            await push_presence()
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def heartbeat():
    while True:
        await asyncio.sleep(PING_INTERVAL)
        for conn in list(CONNS):
            if conn.closed:
                continue
            if now() - conn.last_seen > IDLE_TIMEOUT:
                await conn.close(1001)
                continue
            try:
                async with conn.write_lock:
                    conn.writer.write(encode_frame(0x9, b"hb"))
                    await conn.writer.drain()
            except Exception:  # noqa: BLE001
                conn.closed = True
        if live_conns():
            await push_presence()


def start_background_tasks():
    asyncio.get_event_loop().create_task(heartbeat())
