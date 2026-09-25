"""HTTP + WebSocket server (stdlib asyncio, no third-party packages)."""

import asyncio
import contextlib
import hashlib
import mimetypes
import os
import ssl
import sys
import time
import urllib.parse

import auth
import db
import ws
from util import dumps, install_log_guard, log, log_exc, loads

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.environ.get("CHECKIN_WEB") or os.path.join(BASE_DIR, "web")
MAX_JSON_BODY = 1024 * 1024
MAX_UPLOAD_BODY = 256 * 1024 * 1024

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("application/zip", ".zip")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("application/x-x509-ca-cert", ".crt")
mimetypes.add_type("application/x-x509-ca-cert", ".cer")

# ------------------------------------------------------------------ HTTPS
# 默认还是纯 HTTP（行为跟以前一模一样）；只有在 systemd 里配了证书+端口才多开一个
# HTTPS 监听。浏览器把「非安全上下文」的 navigator.geolocation 直接禁用，
# 所以网页端要定位签到就必须走这条路。
TLS_CERT = os.environ.get("CHECKIN_TLS_CERT") or ""
TLS_KEY = os.environ.get("CHECKIN_TLS_KEY") or ""
TLS_CA = os.environ.get("CHECKIN_TLS_CA") or ""
try:
    TLS_PORT = int(os.environ.get("CHECKIN_TLS_PORT") or 0)
except ValueError:
    TLS_PORT = 0

ROUTES = []
LOGIN_FAILS = {}


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Response:
    def __init__(self, status=200, body=b"", content_type="application/json; charset=utf-8", headers=None):
        self.status = status
        self.body = body if isinstance(body, bytes) else str(body).encode("utf-8")
        self.content_type = content_type
        self.headers = headers or {}


def ok(data=None, **extra):
    payload = {"ok": True}
    if isinstance(data, dict):
        payload.update(data)
    elif data is not None:
        payload["data"] = data
    payload.update(extra)
    return Response(200, dumps(payload))


def fail(status, message, **extra):
    payload = {"ok": False, "error": message}
    payload.update(extra)
    return Response(status, dumps(payload))


def route(method, path, auth_required=True, admin=False, staff=False, manage=False):
    """admin=True -> 仅总管理员; manage=True -> 总管理员或「管理员(xx班)」;
    staff=True -> 总管理员/班级管理员/资委/学委。"""
    def wrapper(fn):
        ROUTES.append((method.upper(), path, fn, auth_required, admin, staff, manage))
        return fn
    return wrapper


# 角色一览：
#   admin       总管理员（最高权限，能管所有班级）
#   class_admin 管理员(xx班) —— 只管自己班
#   committee   资委（本班）
#   study       学委（本班）
#   member      普通成员
# is_staff 只回答「有没有管理台资格」，具体能看哪个班的数据由 api.py 里的
# class_scope() 再收一次口子，别把两者混为一谈。
STAFF_ROLES = ("admin", "class_admin", "committee", "study")


def is_staff(user):
    return bool(user and user.get("role") in STAFF_ROLES)


def is_manager(user):
    """总管理员或班级管理员 —— 能进「成员管理」这一档。"""
    return bool(user and user.get("role") in ("admin", "class_admin"))


def match_route(method, path):
    for m, pattern, fn, need_auth, need_admin, need_staff, need_manage in ROUTES:
        if m != method:
            continue
        if "{" not in pattern:
            if pattern == path:
                return fn, {}, need_auth, need_admin, need_staff, need_manage
            continue
        p_parts = pattern.strip("/").split("/")
        r_parts = path.strip("/").split("/")
        if len(p_parts) != len(r_parts):
            continue
        params = {}
        for pp, rp in zip(p_parts, r_parts):
            if pp.startswith("{") and pp.endswith("}"):
                params[pp[1:-1]] = urllib.parse.unquote(rp)
            elif pp != rp:
                break
        else:
            return fn, params, need_auth, need_admin, need_staff, need_manage
    return None, None, None, None, None, None


class Request:
    def __init__(self, method, path, query, headers, reader, writer, client_ip):
        try:
            self.scheme = "https" if writer.get_extra_info("sslcontext") is not None else "http"
        except (AttributeError, NotImplementedError):
            self.scheme = "http"
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.reader = reader
        self.writer = writer
        self.client_ip = client_ip
        self.user = None
        self.token = ""
        self.upgrade_ws = False
        self.body = b""
        self.close_after = False

    def q(self, name, default=""):
        values = self.query.get(name)
        return values[0] if values else default

    def header(self, name, default=""):
        return self.headers.get(name.lower(), default)

    def json(self):
        if not self.body:
            return {}
        data = loads(self.body.decode("utf-8", "replace"), None)
        if not isinstance(data, dict):
            raise HttpError(400, "invalid json body")
        return data

    def int_param(self, name, default=0):
        try:
            return int(self.q(name, default))
        except (TypeError, ValueError):
            return default

    def public_base(self):
        host = self.header("host") or "localhost"
        return self.scheme + "://" + host


async def read_request(reader, writer, client_ip):
    try:
        head = await asyncio.wait_for(reader.readline(), timeout=30)
    except (asyncio.TimeoutError, ConnectionError):
        return None
    if not head:
        return None
    try:
        line = head.decode("latin-1").strip()
        method, target, _ = line.split(" ", 2)
    except ValueError:
        return None

    headers = {}
    while True:
        raw = await asyncio.wait_for(reader.readline(), timeout=30)
        if not raw or raw in (b"\r\n", b"\n"):
            break
        text = raw.decode("latin-1").strip()
        if ":" in text:
            key, value = text.split(":", 1)
            headers[key.strip().lower()] = value.strip()

    parsed = urllib.parse.urlparse(target)
    query = urllib.parse.parse_qs(parsed.query)
    req = Request(method.upper(), urllib.parse.unquote(parsed.path), query, headers, reader, writer, client_ip)
    if headers.get("x-forwarded-for"):
        req.client_ip = headers["x-forwarded-for"].split(",")[0].strip()
    req.close_after = headers.get("connection", "").lower() == "close"

    if req.method == "GET" and req.path == "/ws" and "websocket" in headers.get("upgrade", "").lower():
        req.upgrade_ws = True
        return req

    length = int(headers.get("content-length") or 0)
    if length > MAX_UPLOAD_BODY:
        raise HttpError(413, "body too large")
    if length:
        req.body = await asyncio.wait_for(reader.readexactly(length), timeout=120)
    return req


async def send_response(req, resp):
    writer = req.writer
    headers = dict(resp.headers)
    headers.setdefault("Content-Type", resp.content_type)
    headers.setdefault("Content-Length", str(len(resp.body)))
    headers.setdefault("X-Content-Type-Options", "nosniff")
    if req.close_after:
        headers.setdefault("Connection", "close")
    else:
        headers.setdefault("Connection", "keep-alive")
    if resp.status == 304:
        headers.pop("Content-Length", None)
    chunks = ["HTTP/1.1 %d %s\r\n" % (resp.status, STATUS_TEXT.get(resp.status, "OK"))]
    chunks += ["%s: %s\r\n" % (k, v) for k, v in headers.items()]
    chunks.append("\r\n")
    writer.write("".join(chunks).encode("latin-1"))
    if resp.body and resp.status != 304:
        writer.write(resp.body)
    await writer.drain()


STATUS_TEXT = {
    200: "OK", 201: "Created", 204: "No Content", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
    429: "Too Many Requests", 500: "Internal Server Error",
}


def resolve_static(path):
    if path == "/":
        path = "/index.html"
    safe = os.path.normpath(path).lstrip("/\\")
    if safe.startswith(".."):
        return None, None
    full = os.path.join(WEB_DIR, safe)
    if os.path.isfile(full):
        return full, None
    if "." not in os.path.basename(safe):  # SPA fallback
        index = os.path.join(WEB_DIR, "index.html")
        if os.path.isfile(index):
            return index, None
    return None, None


async def serve_static(req):
    full, _ = resolve_static(req.path)
    if not full:
        return fail(404, "not found")
    stat = os.stat(full)
    etag = '"%x-%x"' % (int(stat.st_mtime), stat.st_size)
    if req.header("if-none-match") == etag:
        return Response(304, b"", headers={"ETag": etag, "Cache-Control": "no-cache"})
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    cache = "public, max-age=31536000, immutable" if "/assets/vendor/" in full.replace("\\", "/") else "no-cache"
    if ctype.startswith("text/") or ctype.endswith("javascript") or ctype.endswith("json"):
        ctype += "; charset=utf-8"
    with open(full, "rb") as fh:
        body = fh.read()
    return Response(200, body, ctype, {"ETag": etag, "Cache-Control": cache})


def build_ssl_context():
    """配了证书就返回 SSLContext；没配 / 读不到就返回 None（纯 HTTP，跟以前完全一样）。"""
    if not (TLS_CERT and TLS_KEY):
        return None
    if not (os.path.isfile(TLS_CERT) and os.path.isfile(TLS_KEY)):
        log("WARN", "找不到 TLS 证书/私钥，本次只跑 HTTP：", TLS_CERT, TLS_KEY)
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(TLS_CERT, TLS_KEY)
    return ctx


def serve_ca_cert():
    """把自签 CA 证书公开出去，方便手机下载后装成受信任的根证书。"""
    if not TLS_CA or not os.path.isfile(TLS_CA):
        return None
    with open(TLS_CA, "rb") as fh:
        body = fh.read()
    return Response(200, body, "application/x-x509-ca-cert", {"Cache-Control": "no-cache"})


def check_login_throttle(ip):
    bucket = LOGIN_FAILS.get(ip)
    if not bucket:
        return
    count, first = bucket
    if count >= 8 and time.time() - first < 300:
        raise HttpError(429, "登录失败次数过多，请 5 分钟后再试")
    if time.time() - first >= 300:
        LOGIN_FAILS.pop(ip, None)


def note_login_fail(ip):
    count, first = LOGIN_FAILS.get(ip, (0, time.time()))
    if time.time() - first >= 300:
        count, first = 0, time.time()
    LOGIN_FAILS[ip] = (count + 1, first)


async def dispatch(req):
    if req.method in ("GET", "HEAD") and req.path == "/checkin-ca.crt":
        resp = serve_ca_cert()
        return resp if resp else fail(404, "没有配置自签证书")
    fn, params, need_auth, need_admin, need_staff, need_manage = match_route(req.method, req.path)
    if fn is None:
        if req.path.startswith("/api/"):
            return fail(404, "接口不存在")
        if req.method in ("GET", "HEAD"):
            return await serve_static(req)
        return fail(405, "method not allowed")

    token = req.header("authorization").replace("Bearer ", "").strip() or req.q("token")
    if token:
        req.token = token
        req.user = auth.user_by_token(token)
    if need_auth and not req.user:
        return fail(401, "请先登录")
    if need_admin and (not req.user or req.user.get("role") != "admin"):
        return fail(403, "需要管理员权限")
    if need_manage and not is_manager(req.user):
        return fail(403, "需要管理员权限")
    if need_staff and not is_staff(req.user):
        return fail(403, "需要管理员或资委权限")
    try:
        result = await fn(req, **(params or {}))
    except HttpError as exc:
        return fail(exc.status, exc.message)
    except Exception as exc:  # noqa: BLE001
        # 以前这里还有一句 traceback.print_exc()：它绕过 log() 的限流直接写 stderr，
        # 请求一多就是又一条把磁盘写满的路。log_exc 会带上出错位置，够查了。
        log_exc("ERROR %s %s" % (req.method, req.path), exc)
        return fail(500, "服务器内部错误: %s" % exc)
    if isinstance(result, Response):
        return result
    return ok(result)


async def handle_connection(reader, writer):
    peer = writer.get_extra_info("peername")
    client_ip = peer[0] if peer else ""
    try:
        while True:
            try:
                req = await read_request(reader, writer, client_ip)
            except HttpError as exc:
                await send_response(Request("GET", "/", {}, {}, reader, writer, client_ip), fail(exc.status, exc.message))
                return
            if req is None:
                return
            if req.upgrade_ws:
                await ws.run_connection(req, reader, writer)
                return
            resp = await dispatch(req)
            await send_response(req, resp)
            if req.close_after:
                return
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    except Exception as exc:  # noqa: BLE001
        log("connection error", repr(exc))
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def main():
    import api  # noqa: F401  (registers routes)
    # 第一件事就把日志闸门装上：asyncio 默认处理器不限速地打 traceback，
    # 2026-09-23 的 26.5GB 就是它干的。
    install_log_guard(asyncio.get_running_loop())
    port = int(os.environ.get("CHECKIN_PORT", "80"))
    host = os.environ.get("CHECKIN_HOST", "0.0.0.0")
    db.init()
    seed = db.query_one("SELECT COUNT(*) AS c FROM users")["c"]
    if not seed:
        from bootstrap import create_default_users
        create_default_users()
    server = await asyncio.start_server(handle_connection, host, port)
    listeners = [server]
    ssl_ctx = build_ssl_context()
    if ssl_ctx and TLS_PORT:
        tls_server = await asyncio.start_server(handle_connection, host, TLS_PORT, ssl=ssl_ctx)
        listeners.append(tls_server)
    elif ssl_ctx:
        log("WARN", "有证书但 CHECKIN_TLS_PORT 没配，HTTPS 没起来")
    ws.start_background_tasks()
    # 游戏对局的后台推进器：画猜倒计时、狼人杀阶段计时、掉线清理全靠它
    import games
    asyncio.ensure_future(games.ticker())
    log("check-in server listening on %s:%d  (web root: %s)" % (host, port, WEB_DIR))
    if len(listeners) > 1:
        log("check-in server https listening on %s:%d" % (host, TLS_PORT))
    async with contextlib.AsyncExitStack() as stack:
        for one in listeners:
            await stack.enter_async_context(one)
        await asyncio.Event().wait()


if __name__ == "__main__":
    # Re-import as a module so that "import api" inside main() shares this
    # module's ROUTES table (running the file as __main__ would create a
    # second copy of the module).
    import app as _app
    try:
        asyncio.run(_app.main())
    except KeyboardInterrupt:
        sys.exit(0)
