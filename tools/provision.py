"""Provision class accounts on the deployed server + verify public TCP/HTTP/WS."""
import base64
import hashlib
import json
import os
import random
import secrets
import socket
import struct
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CHECKIN_SERVER", "http://127.0.0.1:8081")
ADMIN_PASSWORD = sys.argv[2]
COUNT = int(sys.argv[3]) if len(sys.argv) > 3 else 25
OUT = sys.argv[4] if len(sys.argv) > 4 else "accounts.csv"

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"


def call(path, method="GET", body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def password(n=6):
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


def ws_roundtrip(token):
    """Minimal RFC6455 client: handshake, send a chat ping, read one frame."""
    host = BASE.split("//", 1)[1].split(":")[0]
    port = int(BASE.rsplit(":", 1)[1]) if BASE.count(":") == 2 else 80
    key = base64.b64encode(os.urandom(16)).decode()
    sock = socket.create_connection((host, port), timeout=12)
    handshake = (
        "GET /ws?token=%s&device=web HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
        % (token, host, port, key))
    sock.sendall(handshake.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("握手期间连接被关闭")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    status = head.split(b"\r\n")[0].decode()
    if "101" not in status:
        raise RuntimeError("握手失败: " + status)

    def send_text(text):
        payload = text.encode()
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        sock.sendall(bytes(header) + mask + masked)

    def read_frame():
        nonlocal rest

        def need(n):
            nonlocal rest
            while len(rest) < n:
                chunk = sock.recv(65536)
                if not chunk:
                    raise RuntimeError("连接被关闭")
                rest += chunk
            out, rest = rest[:n], rest[n:]
            return out

        b0, b1 = need(2)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", need(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", need(8))[0]
        data = need(length)
        return b0 & 0x0F, data

    send_text(json.dumps({"t": "ping"}))
    for _ in range(8):
        opcode, data = read_frame()
        if opcode == 0x1:
            msg = json.loads(data.decode())
            if msg.get("t") == "pong":
                send_text(json.dumps({"t": "presence.get"}))
                op, payload = read_frame()
                presence = json.loads(payload.decode())
                sock.sendall(b"\x88\x80" + os.urandom(4))
                sock.close()
                return presence.get("count", 0)
    raise RuntimeError("未收到 pong")


def main():
    login = call("/api/login", "POST", {"username": "admin", "password": ADMIN_PASSWORD})
    token = login["token"]
    print("管理员登录成功:", login["user"]["name"], login["user"]["role"])

    existing = {u["username"] for u in call("/api/admin/users", token=token)["users"]}
    rows = []
    created = 0
    for index in range(1, COUNT + 1):
        username = "stu%02d" % index
        name = "同学%02d" % index
        if username in existing:
            rows.append((username, name, "已存在"))
            continue
        pw = password()
        call("/api/admin/users", "POST", {"username": username, "name": name, "password": pw, "role": "member"}, token)
        rows.append((username, name, pw))
        created += 1
    print("新建账号:", created, "个")

    with open(OUT, "w", encoding="utf-8-sig") as fh:
        fh.write("用户名,姓名,初始密码\n")
        for row in rows:
            fh.write(",".join(row) + "\n")
    print("账号表已写入:", OUT)

    session = call("/api/admin/sign-sessions", "POST", {"title": "第一次签到 · 全班到齐", "minutes": 30}, token)
    print("测试场次 #%d 口令 %s" % (session["id"], session["code"]))
    call("/api/admin/sign-sessions/%d" % session["id"], "DELETE", token=token)
    print("测试场次已删除")

    online = ws_roundtrip(token)
    print("公网 WebSocket 握手 + ping/pong 成功, 在线人数:", online)


main()
