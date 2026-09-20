#!/usr/bin/env python3
"""End-to-end smoke test for the check-in server (stdlib only).

usage: python smoke.py [base_url]      default http://127.0.0.1:8081
"""

import base64
import hashlib
import json
import socket
import struct
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8081"
ADMIN_USER = sys.argv[3] if len(sys.argv) > 3 else "admin"
HOST = BASE.split("//", 1)[1].split(":")[0]
PORT = int(BASE.rsplit(":", 1)[1].split("/")[0])
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print("%s  %-34s %s" % ("PASS" if condition else "FAIL", name, str(detail)[:150]), flush=True)


def http(method, path, body=None, token=None, raw=False, query=""):
    url = BASE + path + (("?" + query) if query else "")
    data = None
    headers = {}
    if body is not None:
        data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload
            return resp.status, json.loads(payload.decode() or "{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        try:
            return exc.code, json.loads(payload.decode() or "{}")
        except Exception:  # noqa: BLE001
            return exc.code, {"raw": payload[:200].decode("utf-8", "replace")}


class WS:
    """Minimal WebSocket client (text frames only)."""

    def __init__(self, token, device="web"):
        self.sock = socket.create_connection((HOST, PORT), timeout=10)
        key = base64.b64encode(struct.pack("!I", int(time.time()) % 100000)).decode()
        self.sock.sendall((
            "GET /ws?token=%s&device=%s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
            % (token, device, HOST, PORT, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake closed")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if not head.startswith(b"HTTP/1.1 101"):
            raise RuntimeError("websocket handshake failed: %s" % head[:120])

    def send(self, obj):
        payload = json.dumps(obj).encode()
        mask = b"\x01\x02\x03\x04"
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        head = bytes([0x81])
        length = len(payload)
        if length < 126:
            head += bytes([0x80 | length])
        elif length < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", length)
        self.sock.sendall(head + mask + masked)

    def _fill(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("socket closed")
            self.buf += chunk

    def recv(self, timeout=6):
        end = time.time() + timeout
        while time.time() < end:
            try:
                self._fill(2)
                opcode = self.buf[0] & 0x0F
                length = self.buf[1] & 0x7F
                offset = 2
                if length == 126:
                    self._fill(4)
                    length = struct.unpack("!H", self.buf[2:4])[0]
                    offset = 4
                elif length == 127:
                    self._fill(10)
                    length = struct.unpack("!Q", self.buf[2:10])[0]
                    offset = 10
                self._fill(offset + length)
                payload = self.buf[offset:offset + length]
                self.buf = self.buf[offset + length:]
                if opcode == 0x9:
                    self.sock.sendall(bytes([0x8A, 0x80]) + b"\x00\x00\x00\x00")
                    continue
                if opcode == 0xA:
                    continue
                if opcode == 0x8:
                    raise RuntimeError("closed by server")
                if opcode == 0x1:
                    return json.loads(payload.decode())
            except socket.timeout:
                break
        return None

    def wait_for(self, kind, timeout=8, predicate=None):
        end = time.time() + timeout
        while time.time() < end:
            msg = self.recv(timeout=min(2, max(0.2, end - time.time())))
            if not msg:
                continue
            if msg.get("t") == kind and (predicate is None or predicate(msg)):
                return msg
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def main():
    stamp = int(time.time()) % 100000
    # ---------- public config ----------
    status, cfg = http("GET", "/api/config")
    check("GET /api/config", status == 200 and cfg.get("ok"), cfg.get("site_name"))

    # ---------- login ----------
    status, res = http("POST", "/api/login", {"username": ADMIN_USER, "password": sys.argv[2] if len(sys.argv) > 2 else ""})
    admin_token = res.get("token", "")
    check("admin login", status == 200 and admin_token, res.get("error", ""))
    status, bad = http("POST", "/api/login", {"username": ADMIN_USER, "password": "wrong-pass"})
    check("admin login wrong pw", status == 401, bad.get("error"))
    if not admin_token:
        print("!! cannot continue without admin token")
        return 1

    # ---------- admin creates user ----------
    uname = "stu%d" % stamp
    status, res = http("POST", "/api/admin/users", {"username": uname, "name": "同学%d" % stamp, "role": "member"}, admin_token)
    member_password = res.get("password", "")
    member_id = res.get("id", 0)
    check("admin create member", status == 200 and member_id, "%s / %s" % (uname, member_password))
    status, res = http("POST", "/api/login", {"username": uname, "password": member_password})
    member_token = res.get("token", "")
    check("member login", status == 200 and member_token, res.get("error", ""))
    status, res = http("GET", "/api/admin/users", None, member_token)
    check("member blocked from admin api", status == 403, res.get("error"))

    # ---------- check-in flow ----------
    sign_at_now = int(time.time()) + 60   # 立刻开放（提前开放时长默认 30 分钟），15 分钟后截止
    status, res = http("POST", "/api/admin/sign-sessions",
                       {"title": "冒烟测试%02d" % (stamp % 100), "sign_at": sign_at_now,
                        "grace_minutes": 15}, admin_token)
    session_id = res.get("id", 0)
    code = res.get("code", "")
    check("admin create sign session", status == 200 and session_id, "id=%s code=%s" % (session_id, code))
    status, res = http("POST", "/api/sign/in", {"session_id": session_id, "note": "到啦"}, member_token)
    check("member sign in", status == 200 and res.get("checked_in"), res.get("error", ""))
    status, res = http("POST", "/api/sign/in", {"session_id": session_id}, member_token)
    check("duplicate sign blocked", status == 409, res.get("error"))
    status, res = http("GET", "/api/sign/active", None, member_token)
    check("active session shows mine", status == 200 and (res.get("session") or {}).get("mine"), "")
    status, res = http("GET", "/api/sign/session/%d" % session_id, None, admin_token)
    detail = res.get("session", {})
    check("admin sees records", len(detail.get("records", [])) >= 1, "records=%d missing=%d"
          % (len(detail.get("records", [])), len(detail.get("missing", []))))
    status, res = http("GET", "/api/me", None, member_token)
    check("me stats", status == 200 and res["stats"]["checked"] >= 1, "checked=%s rate=%s"
          % (res["stats"]["checked"], res["stats"]["rate"]))
    status, res = http("GET", "/api/stats/class", None, member_token)
    check("class ranking", status == 200 and len(res.get("ranking", [])) >= 2, "rows=%d" % len(res.get("ranking", [])))

    # ---------- chat over REST ----------
    status, res = http("POST", "/api/chat/post", {"content": "冒烟测试消息 %d" % stamp, "anon": 1}, member_token)
    check("rest chat post", status == 200 and res.get("id"), res.get("error", ""))
    status, res = http("GET", "/api/chat/history", None, member_token)
    check("chat history", status == 200 and any("冒烟测试消息" in m["content"] for m in res.get("messages", [])),
          "count=%d" % len(res.get("messages", [])))

    # ---------- solo points (danmaku) ----------
    status, res = http("POST", "/api/games/solo/points", {"kind": "danmaku", "score": 19999}, member_token)
    check("danmaku 19999 -> awarded 0", status == 200 and res.get("awarded") == 0, res.get("error", ""))
    status, res = http("POST", "/api/games/solo/points", {"kind": "danmaku", "score": "41000.9"}, member_token)
    check("danmaku 41000 -> +2 solo", status == 200 and res.get("awarded") == 2
          and (res.get("points") or {}).get("solo") == 2, res.get("error", ""))
    status, res = http("POST", "/api/games/solo/points", {"kind": "danmaku", "score": 40000}, member_token)
    check("danmaku cooldown -> 429", status == 429, res.get("error", ""))
    status, res = http("POST", "/api/games/solo/points", {"kind": "nope"}, member_token)
    check("unknown game kind -> 400", status == 400, res.get("error", ""))

    # ---------- websocket ----------
    try:
        ws_admin = WS(admin_token, "web")
        ws_member = WS(member_token, "web")
        hello = ws_admin.wait_for("hello")
        check("ws handshake + hello", bool(hello) and hello["user"]["role"] == "admin", hello and hello["user"]["name"])
        presence = ws_admin.wait_for("presence", timeout=4)
        check("ws presence", bool(presence), presence and presence.get("count"))
        ws_member.wait_for("hello")
        ws_member.send({"t": "chat.send", "content": "ws 冒烟 %d" % stamp, "anon": 1})
        got = ws_admin.wait_for("chat.new", predicate=lambda m: "ws 冒烟" in m["msg"]["content"])
        check("ws chat broadcast", bool(got), got and got["msg"]["name"])

        # gomoku: admin creates room, member joins, play a short game
        ws_admin.send({"t": "game.create", "game": "gomoku"})
        entered = ws_admin.wait_for("game.entered")
        room_id = entered["room"]["id"] if entered else ""
        check("gomoku room created", bool(room_id), room_id)
        ws_member.send({"t": "game.join", "room": room_id})
        state = ws_member.wait_for("game.state", predicate=lambda m: len(m["room"]["players"]) == 2)
        check("gomoku 2nd player joined", bool(state), state and [p["name"] for p in state["room"]["players"]])
        ws_admin.send({"t": "game.ready"})
        ws_member.send({"t": "game.ready"})
        start = ws_admin.wait_for("game.state", predicate=lambda m: m["room"]["started"], timeout=8)
        turn = start["room"]["state"]["turn"] if start else 0
        first, second = (ws_admin, ws_member) if turn == hello["user"]["id"] else (ws_member, ws_admin)
        moves = [112, 0, 113, 1, 114, 2, 115, 3, 116]
        for i, index in enumerate(moves):
            (first if i % 2 == 0 else second).send({"t": "game.move", "index": index})
            time.sleep(0.15)
        over = ws_admin.wait_for("game.over", timeout=8)
        check("gomoku win detected", bool(over) and over.get("winners"), over and over.get("reason"))

        # number bomb
        ws_admin.send({"t": "game.leave"})
        ws_admin.wait_for("game.left")
        ws_admin.send({"t": "game.create", "game": "bomb"})
        entered = ws_admin.wait_for("game.entered")
        bomb_room = entered["room"]["id"] if entered else ""
        ws_member.send({"t": "game.join", "room": bomb_room})
        ws_member.wait_for("game.state", predicate=lambda m: len(m["room"]["players"]) == 2)
        ws_admin.send({"t": "game.ready"})
        ws_member.send({"t": "game.ready"})
        started = ws_admin.wait_for("game.state", predicate=lambda m: m["room"]["started"], timeout=8)
        check("bomb game started", bool(started), started and started["room"]["state"]["hi"])
        if started:
            turn_uid = started["room"]["state"]["turn"]
            actor, other = (ws_admin, ws_member) if turn_uid == hello["user"]["id"] else (ws_member, ws_admin)
            actor.send({"t": "game.guess", "text": "50"})
            upd = ws_admin.wait_for("game.update", timeout=6)
            check("bomb guess narrowed range", bool(upd), upd and ("lo=%s hi=%s" % (upd["room"]["state"]["lo"], upd["room"]["state"]["hi"])))
        ws_admin.send({"t": "game.leave"})
        ws_member.send({"t": "game.leave"})
    except Exception as exc:  # noqa: BLE001
        check("websocket suite", False, repr(exc))
    finally:
        for handle in ("ws_admin", "ws_member"):
            obj = locals().get(handle)
            if obj is not None:
                obj.close()

    # ---------- hot update ----------
    bundle = b"PK\x03\x04 fake h5 bundle " + str(stamp).encode()
    status, res = http("POST", "/api/admin/upload", bundle, admin_token,
                       query="kind=h5&name=h5.zip&version_name=1.0.%d&notes=smoke" % (stamp % 100))
    check("admin upload h5 bundle", status == 200 and res.get("file"), res.get("error", res.get("file")))
    status, res = http("GET", "/api/app/version", None, None, query="platform=h5&code=0")
    check("app version reports update", status == 200 and res.get("has_update"), "code=%s url=%s"
          % (res.get("version_code"), res.get("url")))
    bundle_name = (res.get("url") or "").rsplit("/", 1)[-1]
    status, body = http("GET", "/api/app/bundle/" + bundle_name, None, None, raw=True)
    check("bundle download", status == 200 and body.startswith(b"PK"), "%d bytes" % len(body))

    # ---------- admin extras ----------
    status, res = http("GET", "/api/admin/overview", None, admin_token)
    check("admin overview", status == 200 and res.get("users"), "online=%s users=%s" % (res.get("online"), res.get("users")))
    status, res = http("GET", "/api/admin/logs", None, admin_token)
    check("admin logs", status == 200 and len(res.get("logs", [])) > 3, "rows=%d" % len(res.get("logs", [])))
    status, res = http("POST", "/api/admin/announce", {"content": "冒烟公告 %d" % stamp}, admin_token)
    check("admin announce", status == 200 and res.get("id"), "")
    status, res = http("POST", "/api/admin/sql", {"sql": "SELECT COUNT(*) AS c FROM users"}, admin_token)
    check("admin sql read", status == 200 and res.get("rows"), res.get("rows"))
    status, res = http("POST", "/api/admin/sql", {"sql": "DELETE FROM users"}, admin_token)
    check("admin sql write guard", status == 400, res.get("error"))
    status, res = http("PATCH", "/api/admin/settings", {"site_name": "班级签到"}, admin_token)
    check("admin settings", status == 200, "")
    status, res = http("POST", "/api/admin/records",
                       {"session_id": session_id, "user_id": member_id, "status": "late", "note": "管理员改的"}, admin_token)
    check("admin override record", status == 200, res.get("error", ""))
    status, res = http("GET", "/api/sign/session/%d" % session_id, None, admin_token)
    rec = (res.get("session", {}).get("records") or [{}])[0]
    check("admin override visible", rec.get("status") == "late" and rec.get("by_admin") == 1, rec.get("status"))

    # ---------- cleanup ----------
    status, res = http("DELETE", "/api/admin/users/%d" % member_id, None, admin_token)
    check("admin delete member", status == 200, res.get("error", ""))

    print("\n=== summary: %d passed, %d failed ===" % (len(PASSED), len(FAILED)))
    if FAILED:
        print("failed:", ", ".join(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
