"""WebSocket 连接泄漏回归：断掉之后服务端必须真的把连接收回去。

背景（2026-09-23 事故）：
  * Conn.send() / heartbeat() 出错时只把 closed 置 True，**不关 socket**；
  * 读循环又没有超时，半开连接会永久阻塞在 read_frame 上，
    于是 run_connection 的 finally 永远不执行 —— CONNS、房间座位、fd 一起漏。
  1024 个 fd 被吃光后 accept() 开始抛 OSError，asyncio 的接受循环每转一圈甩一份
  traceback，两天把 28G 磁盘写满 26.5GB，服务整整 25 小时接不了新连接。

这个测试把三种断开方式各来一轮，要求服务端把连接**全部**收回：
  1. normal  正常关闭（先发 close 帧再 FIN）
  2. abort   硬断开（SO_LINGER=0 → RST）
  3. half    半开（握完手就不说话，也不发 FIN）—— 只有读超时能救这条

判定用的两个数：
  * /proc/<pid>/fd 的条目数（传了 --pid 才有，Linux）；
  * /api/admin/overview 的 online —— 注意它数的是「去重后的人头」，
    所以测试要拿多个账号轮流连，不然 15 条连接只让 online 涨 1。

用法：
  python tests/fd_leak.py [baseUrl] [--pid PID] [--rounds 20] [--read-timeout 8]
  # 本地跑：服务端先带 CHECKIN_WS_READ_TIMEOUT=8 启动，这边也传 --read-timeout 8

环境变量：
  ADMIN_PASS     管理员口令（必需，用来登录和采样）
  CC_USERS       多个账号，形如 "admin:xxx,ww01:yyy"，用来产生多条「不同人」的连接
  ADMIN_USER / MEMBER_USER / MEMBER_PASS   没给 CC_USERS 时的兜底
"""

import argparse
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request

PASS = 0
FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS  %s%s" % (name, ("   " + extra) if extra else ""))
    else:
        FAIL += 1
        print("FAIL  %s   %s" % (name, extra))


def http_json(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    req.add_header("Connection", "close")   # 别让测试自己占住一条 keep-alive
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def login(base, user, password):
    """登录拿 token（接口字段是 username，不是 name）。"""
    body = json.dumps({"username": user, "password": password}).encode()
    req = urllib.request.Request(base + "/api/login", data=body)
    req.add_header("Content-Type", "application/json")
    req.add_header("Connection", "close")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))["token"]


def fd_count(pid):
    """进程当前打开的 fd 数（只有 Linux 有 /proc）。"""
    path = "/proc/%d/fd" % pid
    if not os.path.isdir(path):
        return None
    return len(os.listdir(path))


def ws_connect(host, port, token, timeout=10):
    """裸 socket 走一遍 WebSocket 握手，返回 socket（之后的帧一律不管）。"""
    s = socket.create_connection((host, port), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    req = ("GET /ws?token=%s HTTP/1.1\r\n"
           "Host: %s:%d\r\n"
           "Upgrade: websocket\r\n"
           "Connection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\n"
           "Sec-WebSocket-Version: 13\r\n\r\n") % (urllib.parse.quote(token), host, port, key)
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("握手期间连接就断了：%r" % buf[:200])
        buf += chunk
    if b" 101 " not in buf.split(b"\r\n")[0]:
        raise RuntimeError("握手失败：%r" % buf[:200])
    return s


def send_close_frame(s):
    payload = struct.pack("!H", 1000)
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(b"\x88" + bytes([0x80 | len(payload)]) + mask + masked)


def close_abort(s):
    """不打招呼直接 RST（SO_LINGER 设成 0 再 close）。"""
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    except OSError:
        pass
    s.close()


def settle(seconds, label):
    print("      （等 %.1fs 让服务端回收：%s）" % (seconds, label))
    time.sleep(seconds)


def users_from_env():
    """要用的账号列表：CC_USERS 优先，否则用 ADMIN_* / MEMBER_*。"""
    raw = (os.environ.get("CC_USERS") or "").strip()
    out = []
    if raw:
        for chunk in raw.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            user, _, password = chunk.partition(":")
            if user and password:
                out.append((user, password))
    if not out:
        admin_pass = os.environ.get("ADMIN_PASS") or ""
        if admin_pass:
            out.append((os.environ.get("ADMIN_USER") or "admin", admin_pass))
        member_pass = os.environ.get("MEMBER_PASS") or ""
        if member_pass:
            out.append((os.environ.get("MEMBER_USER") or "ww01", member_pass))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://127.0.0.1:8081")
    ap.add_argument("--pid", type=int, default=0, help="服务端进程号，用来数 fd")
    ap.add_argument("--rounds", type=int, default=20)
    ap.add_argument("--fd-slack", type=int, default=3,
                    help="fd 允许的抖动（线上有真人连进连出，放宽一点）")
    ap.add_argument("--read-timeout", type=float, default=180.0,
                    help="要和服务端的 CHECKIN_WS_READ_TIMEOUT 对上")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    parts = urllib.parse.urlsplit(base)
    host = parts.hostname
    port = parts.port or (443 if parts.scheme == "https" else 80)

    creds = users_from_env()
    if not creds:
        print("需要 ADMIN_PASS（或 CC_USERS）环境变量")
        return 2

    tokens = []
    for user, password in creds:
        try:
            tokens.append(login(base, user, password))
        except Exception as exc:  # noqa: BLE001
            print("      登录 %s 失败，跳过：%r" % (user, exc))
    if not tokens:
        print("一个账号都没登上，没法测")
        return 2
    print("      账号 %d 个，连接会在它们之间轮换" % len(tokens))
    admin_token = tokens[0]

    def sample():
        return http_json(base + "/api/admin/overview", admin_token)["online"]

    def snapshot():
        return (fd_count(args.pid) if args.pid else None, sample())

    # 基线：多采几次取稳定值，上一轮的连接可能还在收尾
    for _ in range(3):
        settle(0.4, "基线采样")
    base_fd, base_online = snapshot()
    print("      基线：fd=%s online=%s" % (base_fd, base_online))

    rounds = args.rounds
    want_up = min(len(tokens) - 1, 5)   # 半开阶段至少该涨这么多「人头」
    socks = []

    def dial(i):
        return ws_connect(host, port, tokens[i % len(tokens)])

    # ---- 1. 正常关闭 ----
    for i in range(rounds):
        s = dial(i)
        send_close_frame(s)
        s.close()
    settle(2.0, "正常关闭")
    fd1, on1 = snapshot()
    ok("正常关闭后连接数回落", on1 <= base_online, "online %s -> %s" % (base_online, on1))
    if base_fd:
        ok("正常关闭后 fd 回落", fd1 <= base_fd + args.fd_slack, "fd %s -> %s（允许 +%d）" % (base_fd, fd1, args.fd_slack))

    # ---- 2. 硬断开（RST）----
    for i in range(rounds):
        close_abort(dial(i))
    settle(2.0, "RST 断开")
    fd2, on2 = snapshot()
    ok("RST 断开后连接数回落", on2 <= base_online, "online %s -> %s" % (base_online, on2))
    if base_fd:
        ok("RST 断开后 fd 回落", fd2 <= base_fd + args.fd_slack, "fd %s -> %s（允许 +%d）" % (base_fd, fd2, args.fd_slack))

    # ---- 3. 半开：握完手就装死，也不发 FIN ----
    # 这是最要命的一种：TCP 层面什么都没发生，服务端只能靠自己超时。
    for i in range(rounds):
        socks.append(dial(i))
    fd3, on3 = snapshot()
    if want_up:
        ok("半开连接确实被算成在线（说明这轮测到了东西）", on3 >= base_online + want_up,
           "online %s -> %s（%d 条半开，%d 个账号）" % (base_online, on3, rounds, len(tokens)))
    else:
        print("      跳过半开在线判定：只给了 1 个账号，online 数的是人头，涨不起来")
    if base_fd:
        ok("半开连接确实占住了 fd", fd3 >= base_fd + min(rounds, 5), "fd %s -> %s（允许 +%d）" % (base_fd, fd3, args.fd_slack))

    settle(args.read_timeout + 6, "等读超时把半开连接收掉")
    fd4, on4 = snapshot()
    ok("半开后连接数回到基线（读超时兜底）", on4 <= base_online,
       "online %s -> %s（半开 %d 条）" % (base_online, on4, rounds))
    if base_fd:
        ok("半开后 fd 回到基线（读超时兜底）", fd4 <= base_fd + args.fd_slack,
           "fd %s -> %s（半开 %d 条，允许 +%d）" % (base_fd, fd4, rounds, args.fd_slack))

    for s in socks:   # 这些本来就是"不发 FIN"的，测试自己收掉
        close_abort(s)

    print("")
    print("fd_leak: %d passed, %d failed" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
