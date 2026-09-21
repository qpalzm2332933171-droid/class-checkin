"""REST endpoints: auth, check-in, chat, games meta, hot update, admin."""

import asyncio
import hashlib
import os
import time

import auth
import db
import ws
from app import HttpError, Response, ok, route
from util import dumps, fmt, human_size, mask_ip, now, today

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(db.DATA_DIR, "uploads")


def member_list(include_admin=True):
    sql = "SELECT * FROM users"
    if not include_admin:
        sql += " WHERE role = 'member'"
    sql += " ORDER BY role DESC, id ASC"
    return db.query(sql)


# ------------------------------------------------------------------ helpers
DEFAULT_SIGN_TIMES = "08:00,10:10,14:30,16:25,19:00"


def sign_time_options():
    raw = db.setting("sign_times", DEFAULT_SIGN_TIMES) or DEFAULT_SIGN_TIMES
    out = []
    for piece in raw.split(","):
        piece = piece.strip()
        if len(piece) == 5 and piece[2] == ":":
            out.append(piece)
    return out or DEFAULT_SIGN_TIMES.split(",")


def parse_hhmm(text):
    """'08:00' -> 分钟数; 非法返回 None。"""
    text = (text or "").strip()
    if len(text) == 4 and text[1] == ":":
        text = "0" + text
    if len(text) != 5 or text[2] != ":":
        return None
    try:
        hour, minute = int(text[:2]), int(text[3:])
    except ValueError:
        return None
    if 0 <= hour <= 23 and 0 <= minute <= 59:
        return hour * 60 + minute
    return None


def ts_at_hhmm(hhmm, base_ts=None, grace_seconds=0, min_lead=0):
    """把 HH:MM 落到今天(必要时顺延到明天)的具体时间戳上。"""
    minutes = parse_hhmm(hhmm)
    if minutes is None:
        return 0
    base = base_ts or now()
    day_start = base - (base + 8 * 3600) % 86400
    target = day_start + minutes * 60
    while target + grace_seconds <= base:
        target += 86400
    if min_lead and target - base < min_lead:
        target += 86400
    return target


DEFAULT_EARLY_MINUTES = 30


def session_opens_at(row):
    """签到开放时刻 = 签到时间 - 提前开放时长（0 表示没有签到时间，不限制）。"""
    sign_at = row.get("sign_at") if hasattr(row, "get") else None
    if not sign_at:
        return 0
    early = int(db.setting("early_minutes", str(DEFAULT_EARLY_MINUTES)) or DEFAULT_EARLY_MINUTES)
    return int(sign_at) - early * 60


def haversine(lat1, lng1, lat2, lng2):
    """两点间距离(米)。"""
    import math
    radius = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


def can_delete_posts(user):
    return (user.get("role") or "") == "admin"


def avatar_dir():
    path = os.path.join(UPLOAD_DIR, "avatars")
    os.makedirs(path, exist_ok=True)
    return path


# ------------------------------------------------------------------ 班级（class）
# 角色：admin(总管理员，管所有班) / class_admin(管理员(xx班)) / committee(资委，本班) /
#       study(学委，本班) / member(普通成员)。
# 除了 admin，其他人能看到的签到、成员、记录全部被钉死在自己班里 —— 收口就靠下面三个函数。
CLASS_ROLES = ("admin", "class_admin", "committee", "study")


def is_super(user):
    return (user or {}).get("role") == "admin"


def is_staff(user):
    """有没有管理台资格（总管理员/班级管理员/资委/学委）。"""
    return bool(user and user.get("role") in CLASS_ROLES)


def is_manager(user):
    """总管理员或班级管理员 —— 能进「成员管理」这一档。"""
    return bool(user and user.get("role") in ("admin", "class_admin"))


def class_id_of(user):
    return int((user or {}).get("class_id") or 0)


def class_list():
    return db.query("SELECT * FROM classes ORDER BY id ASC")


def class_name_of(cid):
    cid = int(cid or 0)
    if not cid:
        return ""
    row = db.query_one("SELECT name FROM classes WHERE id = ?", (cid,))
    return row["name"] if row else ""


def class_scope(req, param="class"):
    """数据可见范围 -> (scope, cid)。

    ("all", 0)   全部（只有总管理员拿得到）
    ("one", N)   只看第 N 班
    ("none", 0)  只看「未指定班级」的
    总管理员用 ?class=all|0|N 来选；其他人一律被钉在自己班里，传什么参数都没用。"""
    if is_super(req.user):
        raw = (req.q(param, "all") or "all").strip()
        if raw in ("", "all"):
            return ("all", 0)
        try:
            cid = int(raw)
        except ValueError:
            return ("all", 0)
        return ("none", 0) if cid <= 0 else ("one", cid)
    cid = class_id_of(req.user)
    return ("one", cid) if cid else ("none", 0)


def scope_where(scope, cid, column="class_id", alias=""):
    """class_scope() 的结果 -> SQL 片段（以 AND 开头，可直接拼在 WHERE 后面）。"""
    col = "%s%s" % (alias, column)
    if scope == "all":
        return "", []
    if scope == "none":
        return " AND %s = 0" % col, []
    return " AND %s = ?" % col, [cid]


def can_touch_user(actor, target):
    """actor 有没有资格管理 target 这个账号。

    比的是"同一个班"。class_id = 0 表示「未指定班级」，它也是一个正常的桶：
    还没分班的资委/学委要能照旧管没分班的同学，否则一分班之前所有老账号
    （class_id 全是 0）就谁都动不了了。跨班永远是 False。"""
    if is_super(actor):
        return True
    if (actor or {}).get("role") not in ("class_admin", "committee", "study"):
        return False
    return class_id_of(actor) == class_id_of(target)


def staff_can_see_class(user, cid):
    """这条数据（班级 cid）staff 能不能碰。跟 can_touch_user 一个口径：同班才算。"""
    if is_super(user):
        return True
    return class_id_of(user) == int(cid or 0)


def class_member_count(cid):
    """一个场次的「应到人数」：公共场次(0)算全体，班级场次只算本班。"""
    cid = int(cid or 0)
    if not cid:
        return db.query_one("SELECT COUNT(*) AS c FROM users WHERE banned = 0")["c"]
    return db.query_one("SELECT COUNT(*) AS c FROM users WHERE banned = 0 AND class_id = ?", (cid,))["c"]


def session_scope_where(scope, cid, alias=""):
    """签到场次可见性：班级场次只有本班看得见，class_id=0 的公共场次所有人都看得见。"""
    col = "%sclass_id" % alias
    if scope == "all":
        return "", []
    if scope == "none":
        return " AND %s = 0" % col, []
    return " AND (%s = ? OR %s = 0)" % (col, col), [cid]


def scope_members(scope, cid):
    """按 scope 取用户行，用于「本班名单」这类列表。"""
    where, args = scope_where(scope, cid)
    return db.query("SELECT * FROM users WHERE 1 = 1%s ORDER BY role DESC, id ASC" % where, tuple(args))


def https_info(req):
    """给前端一句准话：有没有 HTTPS、地址是啥。
    外面那层 NAT 转发的外部端口不一定等于内部端口，所以优先用配置里的
    https_origin（设置项 > 环境变量），最后才按同主机+内部端口猜。"""
    import app as app_mod
    port = app_mod.TLS_PORT
    ready = bool(port and app_mod.TLS_CERT and app_mod.TLS_KEY
                 and os.path.isfile(app_mod.TLS_CERT) and os.path.isfile(app_mod.TLS_KEY))
    origin = (db.setting("https_origin") or os.environ.get("CHECKIN_HTTPS_ORIGIN") or "").strip().rstrip("/")
    if not origin and ready:
        host = (req.header("host") or "").split(":")[0] or "localhost"
        if host not in ("localhost", "127.0.0.1"):
            origin = "https://%s:%d" % (host, port)
    return {
        "ready": bool(ready and origin),
        "origin": origin,
        "port": port if ready else 0,
        "ca": "/checkin-ca.crt" if ready and app_mod.TLS_CA and os.path.isfile(app_mod.TLS_CA) else "",
    }


def can_see_session(user, row):
    """这个用户能不能看到/操作这个签到场次。"""
    if is_super(user):
        return True
    cid = int(row.get("class_id") or 0)
    return cid == 0 or cid == class_id_of(user)


# ------------------------------------------------------------------ public
@route("GET", "/api/config", auth_required=False)
async def get_config(req):
    settings = db.get_settings()
    return ok({
        "site_name": settings.get("site_name"),
        "site_subtitle": settings.get("site_subtitle"),
        "chat_enabled": settings.get("chat_enabled") == "1",
        "games_enabled": settings.get("games_enabled") == "1",
        "signin_enabled": settings.get("signin_enabled") == "1",
        "code_required": settings.get("checkin_code_required") == "1",
        "version_h5": int(settings.get("version_h5") or 1),
        "server_time": now(),
        "register_open": settings.get("register_open") == "1",
        "sign_times": sign_time_options(),
        "default_grace": int(settings.get("default_grace") or 15),
        "early_minutes": int(settings.get("early_minutes") or DEFAULT_EARLY_MINUTES),
        "topics_enabled": settings.get("topics_enabled", "1") == "1",
        "announce_popup": settings.get("announce_popup", "1") == "1",
        "https": https_info(req),
    })


@route("POST", "/api/login", auth_required=False)
async def login(req):
    from app import check_login_throttle, note_login_fail
    check_login_throttle(req.client_ip)
    data = req.json()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    row = db.query_one("SELECT * FROM users WHERE username = ?", (username,))
    if not row or not auth.verify_password(password, row["password_hash"], row["salt"]):
        note_login_fail(req.client_ip)
        db.audit(0, "login.fail", "用户名: %s" % username, req.client_ip)
        raise HttpError(401, "用户名或密码错误")
    if row["banned"]:
        raise HttpError(403, "账号已被禁用，请联系管理员")
    token = auth.create_session(row["id"], req.client_ip, req.header("user-agent"))
    db.execute("UPDATE users SET last_login = ? WHERE id = ?", (now(), row["id"]))
    db.audit(row["id"], "login.ok", "登录成功", req.client_ip)
    return ok({"token": token, "user": auth.public_user(row, row), "settings": db.get_settings()})


@route("POST", "/api/register", auth_required=False)
async def register(req):
    if db.setting("register_open", "0") != "1":
        raise HttpError(403, "注册未开放，请联系管理员开通账号")
    data = req.json()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    name = (data.get("name") or "").strip() or username
    if len(username) < 3 or len(password) < 5:
        raise HttpError(400, "用户名至少 3 位、密码至少 5 位")
    if db.query_one("SELECT id FROM users WHERE username = ?", (username,)):
        raise HttpError(409, "用户名已存在")
    password_hash, salt = auth.hash_password(password)
    uid = db.execute(
        "INSERT INTO users(username, name, role, password_hash, salt, color, created_at) VALUES(?,?,?,?,?,?,?)",
        (username, name, "member", password_hash, salt, "", now()))
    db.audit(uid, "user.register", username, req.client_ip)
    return ok({"id": uid})


@route("GET", "/api/app/version", auth_required=False)
async def app_version(req):
    platform = req.q("platform", "h5")
    current = req.int_param("code", 0)
    row = db.query_one(
        "SELECT * FROM app_versions WHERE platform = ? AND active = 1 ORDER BY version_code DESC LIMIT 1", (platform,))
    if not row:
        return ok({"has_update": False, "current": current})
    return ok({
        "has_update": row["version_code"] > current,
        "version_code": row["version_code"],
        "version_name": row["version_name"],
        "notes": row["notes"],
        "size": row["size"],
        "sha256": row["sha256"],
        "url": "%s/api/app/bundle/%s" % (req.public_base(), row["file"]),
        "created_at": row["created_at"],
    })


@route("GET", "/api/app/bundle/{name}", auth_required=False)
async def app_bundle(req, name):
    safe = os.path.basename(name)
    path = os.path.join(UPLOAD_DIR, safe)
    if not os.path.isfile(path):
        raise HttpError(404, "文件不存在")
    with open(path, "rb") as fh:
        body = fh.read()
    return Response(200, body, "application/octet-stream", {
        "Content-Disposition": 'attachment; filename="%s"' % safe,
        "Cache-Control": "no-cache",
    })


# ------------------------------------------------------------------ me
def my_stats(user_id):
    records = db.query(
        "SELECT r.*, s.title, s.starts_at FROM records r JOIN sign_sessions s ON s.id = r.session_id "
        "WHERE r.user_id = ? ORDER BY s.starts_at DESC", (user_id,))
    total_sessions = db.query_one("SELECT COUNT(*) AS c FROM sign_sessions")["c"]
    present = [r for r in records if r["status"] in ("present", "late")]
    late = [r for r in records if r["status"] == "late"]
    leave = [r for r in records if r["status"] == "leave"]
    day_set = {today(r["created_at"]) for r in present}
    streak = 0
    cursor = now()
    for _ in range(400):
        key = fmt(cursor, "%Y-%m-%d")
        if key in day_set:
            streak += 1
            cursor -= 86400
        else:
            if streak == 0 and key == today():
                cursor -= 86400
                continue
            break
    return {
        "total_sessions": total_sessions,
        "checked": len(present),
        "late": len(late),
        "leave": len(leave),
        "missed": max(0, total_sessions - len(present) - len(leave)),
        "streak": streak,
        "rate": round(len(present) * 100.0 / total_sessions, 1) if total_sessions else 0.0,
        "recent": [{
            "id": r["id"], "session_id": r["session_id"], "title": r["title"], "status": r["status"],
            "created_at": r["created_at"], "note": r["note"], "starts_at": r["starts_at"],
        } for r in records[:60]],
    }


@route("GET", "/api/me")
async def me(req):
    import ws
    return ok({"user": auth.public_user(req.user, req.user), "stats": my_stats(req.user["id"]),
               "points": db.get_points(req.user["id"]),
               "alias": ws.anon_alias(req.user["id"])})


BIO_MAX = 60


@route("POST", "/api/me")
async def update_me(req):
    data = req.json()
    name = (data.get("name") or "").strip()[:20]
    color = (data.get("color") or "").strip()[:16]
    if name:
        db.execute("UPDATE users SET name = ? WHERE id = ?", (name, req.user["id"]))
    if color is not None:
        db.execute("UPDATE users SET color = ? WHERE id = ?", (color, req.user["id"]))
    if "bio" in data:
        db.execute("UPDATE users SET bio = ? WHERE id = ?",
                   ((data.get("bio") or "").strip()[:BIO_MAX], req.user["id"]))
    db.audit(req.user["id"], "user.profile", "更新了个人资料", req.client_ip)
    return ok({"updated": True})


@route("GET", "/api/user/{uid}/profile")
async def user_profile(req, uid):
    """个人主页浮窗的数据：头像/昵称/签名/班级/总积分/联机分数(胜-负)/单机积分。"""
    try:
        target_id = int(uid)
    except (TypeError, ValueError):
        raise HttpError(400, "用户编号不合法")
    target = db.query_one("SELECT * FROM users WHERE id = ?", (target_id,))
    if not target or target.get("banned"):
        raise HttpError(404, "用户不存在")
    viewer_is_staff = is_staff(req.user)
    mine = target_id == req.user["id"]
    return ok({"profile": {
        "id": target_id,
        "name": target["name"],
        "username": target["username"] if (viewer_is_staff or mine) else "",
        "avatar": target.get("avatar") or "",
        "color": target.get("color") or "",
        "role": target["role"],
        "bio": target.get("bio") or "",
        "class_id": int(target.get("class_id") or 0),
        "class_name": auth.class_name_of(target.get("class_id")),
        "created_at": target.get("created_at") or 0,
        "muted": target.get("muted") or 0,
        "online": mine,
        "points": db.get_points(target_id),
    }})


# ------------------------------------------------------------------ 班级管理
@route("GET", "/api/classes")
async def classes_list(req):
    if not is_staff(req.user):
        raise HttpError(403, "没有权限查看班级列表")
    out = []
    for row in class_list():
        cid = int(row["id"])
        out.append({
            "id": cid, "name": row["name"], "note": row.get("note") or "",
            "created_at": row.get("created_at") or 0,
            "members": db.query_one("SELECT COUNT(*) AS c FROM users WHERE class_id = ?", (cid,))["c"],
            "sessions": db.query_one("SELECT COUNT(*) AS c FROM sign_sessions WHERE class_id = ?", (cid,))["c"],
        })
    return ok({"classes": out, "mine": class_id_of(req.user), "is_super": is_super(req.user)})


@route("POST", "/api/classes", admin=True)
async def class_create(req):
    data = req.json()
    name = (data.get("name") or "").strip()[:30]
    if not name:
        raise HttpError(400, "班级名称不能为空")
    if db.query_one("SELECT id FROM classes WHERE name = ?", (name,)):
        raise HttpError(409, "这个班级已经存在了")
    cid = db.execute("INSERT INTO classes(name, note, created_at, created_by) VALUES(?,?,?,?)",
                     (name, (data.get("note") or "").strip()[:60], now(), req.user["id"]))
    db.audit(req.user["id"], "admin.class.create", name, req.client_ip)
    return ok({"id": cid, "name": name})


@route("PATCH", "/api/classes/{cid}", admin=True)
async def class_update(req, cid):
    class_id = int(cid)
    row = db.query_one("SELECT * FROM classes WHERE id = ?", (class_id,))
    if not row:
        raise HttpError(404, "班级不存在")
    data = req.json()
    fields, args = [], []
    if "name" in data:
        name = (data.get("name") or "").strip()[:30]
        if not name:
            raise HttpError(400, "班级名称不能为空")
        if db.query_one("SELECT id FROM classes WHERE name = ? AND id <> ?", (name, class_id)):
            raise HttpError(409, "已存在同名班级")
        fields.append("name = ?")
        args.append(name)
    if "note" in data:
        fields.append("note = ?")
        args.append((data.get("note") or "").strip()[:60])
    if fields:
        args.append(class_id)
        db.execute("UPDATE classes SET %s WHERE id = ?" % ", ".join(fields), tuple(args))
        db.audit(req.user["id"], "admin.class.update", "%d %s" % (class_id, dumps(data).decode()), req.client_ip)
    return ok({"updated": True})


@route("DELETE", "/api/classes/{cid}", admin=True)
async def class_delete(req, cid):
    class_id = int(cid)
    row = db.query_one("SELECT * FROM classes WHERE id = ?", (class_id,))
    if not row:
        raise HttpError(404, "班级不存在")
    moved = db.query_one("SELECT COUNT(*) AS c FROM users WHERE class_id = ?", (class_id,))["c"]
    db.execute("UPDATE users SET class_id = 0 WHERE class_id = ?", (class_id,))
    db.execute("UPDATE sign_sessions SET class_id = 0 WHERE class_id = ?", (class_id,))
    db.execute("UPDATE posts SET class_id = 0 WHERE class_id = ?", (class_id,))
    db.execute("DELETE FROM classes WHERE id = ?", (class_id,))
    db.audit(req.user["id"], "admin.class.delete", "%s（%d 名成员转为未指定班级）" % (row["name"], moved), req.client_ip)
    return ok({"deleted": True, "moved": moved})


@route("POST", "/api/me/password")
async def change_password(req):
    data = req.json()
    old = data.get("old") or ""
    new = data.get("new") or ""
    if len(new) < 5:
        raise HttpError(400, "新密码至少 5 位")
    if not auth.verify_password(old, req.user["password_hash"], req.user["salt"]):
        raise HttpError(400, "原密码不正确")
    password_hash, salt = auth.hash_password(new)
    db.execute("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", (password_hash, salt, req.user["id"]))
    db.audit(req.user["id"], "user.password", "修改了自己的密码", req.client_ip)
    return ok({"changed": True})


@route("POST", "/api/me/avatar")
async def upload_avatar(req):
    import base64
    data = req.json()
    raw = (data.get("data") or "").strip()
    if not raw:
        raise HttpError(400, "没有收到图片数据")
    if "," in raw[:80] and raw.startswith("data:"):
        header, raw = raw.split(",", 1)
        if "image/" not in header:
            raise HttpError(400, "只支持图片格式")
    if len(raw) > 3_000_000:
        raise HttpError(413, "图片太大了，请压缩到 2MB 以内")
    try:
        blob = base64.b64decode(raw, validate=False)
    except Exception:  # noqa: BLE001
        raise HttpError(400, "图片数据不合法")
    if len(blob) > 2 * 1024 * 1024:
        raise HttpError(413, "图片太大了，请压缩到 2MB 以内")
    if blob[:8] != b"\x89PNG\r\n\x1a\n" and blob[:3] != b"\xff\xd8\xff" and blob[:4] != b"RIFF":
        raise HttpError(400, "只支持 PNG / JPEG / WebP 图片")
    ext = ".png" if blob[:8] == b"\x89PNG\r\n\x1a\n" else (".jpg" if blob[:3] == b"\xff\xd8\xff" else ".webp")
    folder = avatar_dir()
    name = "u%d-%d%s" % (req.user["id"], now(), ext)
    with open(os.path.join(folder, name), "wb") as fh:
        fh.write(blob)
    url = "/api/avatar/%s" % name
    db.execute("UPDATE users SET avatar = ? WHERE id = ?", (url, req.user["id"]))
    db.audit(req.user["id"], "user.avatar", name, req.client_ip)
    import ws
    await ws.broadcast({"t": "avatar", "user_id": req.user["id"], "avatar": url})
    return ok({"avatar": url})


@route("POST", "/api/me/avatar/clear")
async def clear_avatar(req):
    db.execute("UPDATE users SET avatar = '' WHERE id = ?", (req.user["id"],))
    import ws
    await ws.broadcast({"t": "avatar", "user_id": req.user["id"], "avatar": ""})
    return ok({"avatar": ""})


@route("GET", "/api/avatar/{name}", auth_required=False)
async def get_avatar(req, name):
    safe = os.path.basename(name)
    path = os.path.join(avatar_dir(), safe)
    if not os.path.isfile(path):
        raise HttpError(404, "头像不存在")
    stat = os.stat(path)
    etag = '"%x-%x"' % (int(stat.st_mtime), stat.st_size)
    if req.header("if-none-match") == etag:
        return Response(304, b"", headers={"ETag": etag, "Cache-Control": "public, max-age=86400"})
    import mimetypes
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as fh:
        body = fh.read()
    return Response(200, body, ctype, {"ETag": etag, "Cache-Control": "public, max-age=86400"})


@route("POST", "/api/logout")
async def logout(req):
    if req.token:
        auth.drop_session(req.token)
    return ok({"bye": True})


# ------------------------------------------------------------------ check-in
def session_view(row, user_id=None):
    total = class_member_count(row.get("class_id"))
    present = db.query_one(
        "SELECT COUNT(*) AS c FROM records WHERE session_id = ? AND status IN ('present','late')", (row["id"],))["c"]
    mine = None
    if user_id:
        rec = db.query_one("SELECT * FROM records WHERE session_id = ? AND user_id = ?", (row["id"], user_id))
        if rec:
            mine = {"status": rec["status"], "created_at": rec["created_at"], "note": rec["note"]}
    sign_at = row.get("sign_at") or row["late_after"] or row["starts_at"]
    ends_at = row["ends_at"]
    early = int(db.setting("early_minutes", str(DEFAULT_EARLY_MINUTES)) or DEFAULT_EARLY_MINUTES)
    opens_at = (sign_at - early * 60) if row.get("sign_at") else 0
    return {
        "id": row["id"], "title": row["title"], "status": row["status"],
        "class_id": int(row.get("class_id") or 0),
        "class_name": auth.class_name_of(row.get("class_id")) or "全体",
        "starts_at": row["starts_at"], "ends_at": ends_at, "late_after": row["late_after"],
        "sign_at": sign_at, "opens_at": opens_at,
        "grace_minutes": row.get("grace_minutes") or 0,
        "require_note": row["require_note"], "note": row["note"],
        "require_location": row.get("require_location") or 0,
        "lat": row.get("lat") or 0.0, "lng": row.get("lng") or 0.0,
        "radius": row.get("radius") or 0, "place": row.get("place") or "",
        "allow_leave": row["allow_leave"],
        "closed": bool(ends_at and now() > ends_at),
        "total": total, "present": present, "mine": mine,
    }


@route("GET", "/api/sign/sessions")
async def sign_sessions(req):
    limit = min(req.int_param("limit", 20), 100)
    scope, cid = class_scope(req)
    where, args = session_scope_where(scope, cid)
    rows = db.query("SELECT * FROM sign_sessions WHERE 1 = 1%s ORDER BY starts_at DESC LIMIT ?" % where,
                    tuple(args + [limit]))
    return ok({"sessions": [session_view(r, req.user["id"]) for r in rows]})


@route("GET", "/api/sign/active")
async def sign_active(req):
    """同时可以开多个签到，这里把它们全部返回，前端用标签切换查看。"""
    ts = now()
    scope, cid = class_scope(req)
    where, args = session_scope_where(scope, cid)
    rows = db.query(
        "SELECT * FROM sign_sessions WHERE status = 'open' AND (ends_at = 0 OR ends_at > ?)%s "
        "ORDER BY starts_at DESC, id DESC" % where, tuple([ts] + args))
    if not rows:
        row = db.query_one("SELECT * FROM sign_sessions WHERE 1 = 1%s ORDER BY starts_at DESC, id DESC LIMIT 1" % where,
                           tuple(args))
        rows = [row] if row else []
    if not rows:
        return ok({"session": None, "sessions": []})
    views = [session_view(row, req.user["id"]) for row in rows]
    return ok({"session": views[0], "sessions": views})


@route("POST", "/api/sign/in")
async def sign_in(req):
    if db.setting("signin_enabled", "1") != "1":
        raise HttpError(403, "签到功能已关闭")
    data = req.json()
    sid = int(data.get("session_id") or 0)
    row = db.query_one("SELECT * FROM sign_sessions WHERE id = ?", (sid,))
    if not row:
        raise HttpError(404, "签到场次不存在")
    if not can_see_session(req.user, row):
        raise HttpError(403, "这是别的班的签到，你签不了")
    if row["status"] != "open":
        raise HttpError(400, "该场次已结束")
    ts = now()
    if row["ends_at"] and ts > row["ends_at"]:
        raise HttpError(400, "签到已截止")
    opens_at = session_opens_at(row)
    if opens_at and ts < opens_at:
        raise HttpError(400, "签到还没开始，%s 才会开放" % fmt(opens_at, "%H:%M"))
    note = (data.get("note") or "").strip()[:200]
    if row["require_note"] and not note:
        raise HttpError(400, "本次签到需要填写备注/请假说明")
    if db.setting("checkin_code_required", "0") == "1":
        code = (data.get("code") or "").strip()
        if not row["code"]:
            raise HttpError(400, "该场次没有设置签到码，请联系管理员")
        if code != row["code"]:
            raise HttpError(400, "签到码不正确")
    existing = db.query_one("SELECT * FROM records WHERE session_id = ? AND user_id = ?", (sid, req.user["id"]))
    if existing and existing["status"] in ("present", "late"):
        raise HttpError(409, "你已签到过了")
    lat = float(data.get("lat") or 0)
    lng = float(data.get("lng") or 0)
    distance = 0
    if row.get("require_location"):
        if not (lat or lng):
            raise HttpError(400, "本次签到需要定位，请允许定位后重试")
        distance = int(haversine(lat, lng, row["lat"], row["lng"]))
        if distance > (row["radius"] or 200):
            raise HttpError(400, "你距离签到地点约 %d 米，超出 %d 米范围" % (distance, row["radius"] or 200))
    status = "late" if (row["late_after"] and ts > row["late_after"]) else "present"
    device = (data.get("device") or "web")[:32]
    ua = req.header("user-agent")[:300]
    if existing:
        db.execute("UPDATE records SET status = ?, note = ?, updated_at = ?, ip = ?, ua = ?, device = ?, "
                   "lat = ?, lng = ?, distance = ? WHERE id = ?",
                   (status, note, ts, req.client_ip, ua, device, lat, lng, distance, existing["id"]))
        record_id = existing["id"]
    else:
        record_id = db.execute(
            "INSERT INTO records(session_id, user_id, status, note, created_at, updated_at, ip, ua, device, "
            "lat, lng, distance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, req.user["id"], status, note, ts, ts, req.client_ip, ua, device, lat, lng, distance))
    db.audit(req.user["id"], "sign.in", "场次#%d %s" % (sid, status), req.client_ip)
    result = session_view(row, req.user["id"])
    result["record_id"] = record_id
    result["distance"] = distance
    result["status_text"] = "签到成功" if status == "present" else "已记录（迟到）"
    asyncio.ensure_future(ws.broadcast({"t": "sign.update", "id": sid}))
    return ok({"session": result, "checked_in": True, "late": status == "late"})


@route("POST", "/api/sign/leave")
async def sign_leave(req):
    data = req.json()
    sid = int(data.get("session_id") or 0)
    row = db.query_one("SELECT * FROM sign_sessions WHERE id = ?", (sid,))
    if not row:
        raise HttpError(404, "签到场次不存在")
    if not can_see_session(req.user, row):
        raise HttpError(403, "这是别的班的签到，你没法请假")
    if not row["allow_leave"]:
        raise HttpError(400, "该场次不允许请假")
    note = (data.get("note") or "").strip()[:200] or "请假"
    ts = now()
    if row["ends_at"] and ts > row["ends_at"]:
        raise HttpError(400, "该场次已截止")
    opens_at = session_opens_at(row)
    if opens_at and ts < opens_at:
        raise HttpError(400, "签到还没开始，%s 才会开放" % fmt(opens_at, "%H:%M"))
    existing = db.query_one("SELECT * FROM records WHERE session_id = ? AND user_id = ?", (sid, req.user["id"]))
    if existing:
        db.execute("UPDATE records SET status = 'leave', note = ?, updated_at = ? WHERE id = ?", (note, ts, existing["id"]))
    else:
        db.execute(
            "INSERT INTO records(session_id, user_id, status, note, created_at, updated_at, ip, ua) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (sid, req.user["id"], "leave", note, ts, ts, req.client_ip, req.header("user-agent")[:300]))
    db.audit(req.user["id"], "sign.leave", "场次#%d" % sid, req.client_ip)
    asyncio.ensure_future(ws.broadcast({"t": "sign.update", "id": sid}))
    return ok({"session": session_view(row, req.user["id"])})


@route("GET", "/api/sign/mine")
async def sign_mine(req):
    return ok({"stats": my_stats(req.user["id"]), "user": auth.public_user(req.user, req.user)})


@route("GET", "/api/sign/session/{sid}")
async def sign_session_detail(req, sid):
    row = db.query_one("SELECT * FROM sign_sessions WHERE id = ?", (int(sid),))
    if not row:
        raise HttpError(404, "场次不存在")
    if not can_see_session(req.user, row):
        raise HttpError(403, "这是别的班的签到")
    data = session_view(row, req.user["id"])
    if is_staff(req.user):
        scope, cid = class_scope(req)
        member_where, member_args = scope_where(scope, cid, "class_id", "u.")
        data["code"] = row["code"]
        records = db.query(
            "SELECT r.*, u.name, u.username FROM records r JOIN users u ON u.id = r.user_id "
            "WHERE r.session_id = ?%s ORDER BY r.created_at ASC" % member_where, tuple([row["id"]] + member_args))
        data["records"] = [{
            "id": r["id"], "user_id": r["user_id"], "name": r["name"], "username": r["username"],
            "status": r["status"], "note": r["note"], "created_at": r["created_at"],
            "ip": mask_ip(r["ip"]), "device": r["device"], "by_admin": r["by_admin"],
        } for r in records]
        done = {r["user_id"] for r in records if r["status"] in ("present", "late")}
        data["missing"] = [{"id": u["id"], "name": u["name"], "username": u["username"]}
                           for u in scope_members(scope, cid) if u["id"] not in done and not u["banned"]]
    return ok({"session": data})


@route("GET", "/api/stats/class")
async def class_stats(req):
    scope, cid = class_scope(req)
    users = scope_members(scope, cid)
    sess_where, sess_args = session_scope_where(scope, cid)
    sessions = db.query("SELECT * FROM sign_sessions WHERE 1 = 1%s ORDER BY starts_at DESC LIMIT 50" % sess_where,
                        tuple(sess_args))
    total = len(sessions) or 1
    session_ids = [s["id"] for s in sessions]
    rows = []
    for user in users:
        got = db.query_one(
            "SELECT COUNT(*) AS c FROM records r WHERE r.user_id = ? AND r.status IN ('present','late') "
            "AND r.session_id IN (SELECT id FROM sign_sessions ORDER BY starts_at DESC LIMIT 50)",
            (user["id"],))["c"]
        rows.append({"id": user["id"], "name": user["name"], "rate": round(got * 100.0 / total, 1), "count": got,
                     "avatar": user.get("avatar") or "", "color": user.get("color") or ""})
    rows.sort(key=lambda item: item["rate"], reverse=True)
    return ok({"ranking": rows, "recent": [session_view(r) for r in sessions[:10]], "total_sessions": len(sessions)})


# ------------------------------------------------------------------ geo
# 坐标约定：库里存的一律是 WGS-84（和安卓 GPS 一致），比较距离时才能对得上。
# 地图瓦片用的是高德（GCJ-02），只在 Web 层做 WGS-84 <-> GCJ-02 换算，见 web/src/mapkit.js。
# 地理编码可用的服务：Photon(komoot, OSM 数据) 与 BigDataCloud，两者都返回中文地名；
# Nominatim / tile.openstreetmap.org 在国内网络下不可达，不再调用，也绝不返回编造的地点。
_GEO_CACHE = {}
_GEO_UA = "ClassCheckIn/2.0 (class attendance)"


def _geo_get(url, timeout=6):
    import json as _json
    import urllib.request as _request
    request = _request.Request(url, headers={"User-Agent": _GEO_UA, "Accept": "application/json"})
    with _request.urlopen(request, timeout=timeout) as resp:
        return _json.loads(resp.read().decode("utf-8", "replace"))


def _geo_cache_get(key):
    hit = _GEO_CACHE.get(key)
    if hit and time.time() - hit[0] < hit[2]:
        return hit[1]
    return None


def _geo_cache_put(key, value, ttl=900):
    _GEO_CACHE[key] = (time.time(), value, ttl)
    if len(_GEO_CACHE) > 400:
        _GEO_CACHE.clear()


def _photon_items(payload, limit=8):
    """把 Photon 的 GeoJSON 压成 {name, address, lat, lng} 列表。"""
    out = []
    for item in (payload.get("features") or [])[:limit]:
        geometry = item.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue
        props = item.get("properties") or {}
        parts = []
        for field in ("name", "street", "locality", "district", "city", "state"):
            value = str(props.get(field) or "").strip()
            if value and value not in parts:
                parts.append(value)
        if not parts:
            continue
        try:
            out.append({"name": parts[0][:40], "address": " · ".join(parts)[:160],
                        "lat": round(float(coords[1]), 7), "lng": round(float(coords[0]), 7)})
        except (TypeError, ValueError):
            continue
    return out


def _photon_search(query, lat=0.0, lng=0.0):
    import urllib.parse as _parse
    params = {"q": query, "limit": "8"}
    if lat or lng:
        params["lat"], params["lon"] = "%.5f" % lat, "%.5f" % lng
    return _photon_items(_geo_get("https://photon.komoot.io/api/?" + _parse.urlencode(params)))


def _photon_reverse(lat, lng):
    import urllib.parse as _parse
    params = {"lat": "%.6f" % lat, "lon": "%.6f" % lng, "limit": "1"}
    items = _photon_items(_geo_get("https://photon.komoot.io/reverse?" + _parse.urlencode(params)), 1)
    if not items:
        return None
    return {"name": items[0]["name"], "address": items[0]["address"], "lat": lat, "lng": lng}


def _bdc_reverse(lat, lng):
    import urllib.parse as _parse
    params = {"latitude": "%.6f" % lat, "longitude": "%.6f" % lng, "localityLanguage": "zh"}
    data = _geo_get("https://api.bigdatacloud.net/data/reverse-geocode-client?" + _parse.urlencode(params))
    parts = []
    for field in ("locality", "city", "principalSubdivision", "countryName"):
        value = str(data.get(field) or "").strip()
        if value and value not in parts:
            parts.append(value)
    if not parts:
        return None
    return {"name": parts[0][:40], "address": " · ".join(parts)[:160], "lat": lat, "lng": lng}


def _reverse_lookup(lat, lng):
    """按可用性依次尝试，全部失败返回 {}。"""
    for worker in (_photon_reverse, _bdc_reverse):
        try:
            hit = worker(lat, lng)
        except Exception:  # noqa: BLE001  网络不可用时静默换下一个
            hit = None
        if hit:
            return hit
    return {}


def _photon_nearby(lat, lng, limit=12):
    """把点周围的 POI 拉出来，按距离从近到远排好（Photon reverse 支持 limit>1）。"""
    import urllib.parse as _parse
    params = {"lat": "%.6f" % lat, "lon": "%.6f" % lng, "limit": str(int(limit))}
    items = _photon_items(_geo_get("https://photon.komoot.io/reverse?" + _parse.urlencode(params)), limit)
    seen, out = set(), []
    for item in items:
        if not item["lat"] and not item["lng"]:
            continue
        distance = int(haversine(lat, lng, item["lat"], item["lng"]))
        key = (item["name"], round(distance / 40.0))
        if key in seen:
            continue
        seen.add(key)
        item["distance"] = distance
        out.append(item)
    out.sort(key=lambda row: row["distance"])
    return out


@route("GET", "/api/geo/nearby", auth_required=False)
async def geo_nearby(req):
    """附近的几个地点：按距离从近到远返回，供"定位到我"之后直接挑。"""
    import asyncio
    try:
        lat, lng = float(req.q("lat", "0")), float(req.q("lng", "0"))
    except ValueError:
        raise HttpError(400, "坐标格式不正确")
    if not lat and not lng:
        raise HttpError(400, "缺少坐标")
    limit = max(3, min(req.int_param("limit", 12), 20))
    key = ("n", round(lat, 4), round(lng, 4), limit)
    items = _geo_cache_get(key)
    if items is None:
        try:
            items = await asyncio.to_thread(_photon_nearby, lat, lng, limit)
        except Exception:  # noqa: BLE001
            _geo_cache_put(key, [], 120)
            return ok({"items": [], "offline": True})
        _geo_cache_put(key, items, 600)
    return ok({"items": items, "offline": False})


@route("GET", "/api/geo/search", auth_required=False)
async def geo_search(req):
    import asyncio
    query = (req.q("q") or "").strip()[:60]
    if not query:
        return ok({"items": [], "offline": False})
    near = (req.q("near") or "").strip()
    lat = lng = 0.0
    if "," in near:
        try:
            lat, lng = float(near.split(",")[0]), float(near.split(",")[1])
        except ValueError:
            lat = lng = 0.0
    key = ("q", query, round(lat, 3), round(lng, 3))
    items = _geo_cache_get(key)
    if items is None:
        try:
            items = await asyncio.to_thread(_photon_search, query, lat, lng)
        except Exception:  # noqa: BLE001
            _geo_cache_put(key, [], 120)
            return ok({"items": [], "offline": True})
        if lat or lng:
            for item in items:
                item["distance"] = int(haversine(lat, lng, item["lat"], item["lng"]))
            items.sort(key=lambda row: row.get("distance", 0))
        _geo_cache_put(key, items)
    return ok({"items": items, "offline": False})


@route("GET", "/api/geo/reverse", auth_required=False)
async def geo_reverse(req):
    import asyncio
    try:
        flat, flng = float(req.q("lat", "0")), float(req.q("lng", "0"))
    except ValueError:
        raise HttpError(400, "坐标格式不正确")
    key = ("r", round(flat, 4), round(flng, 4))
    found = _geo_cache_get(key)
    if found is None:
        found = await asyncio.to_thread(_reverse_lookup, flat, flng)
        _geo_cache_put(key, found, 900 if found else 120)   # 失败只缓存 2 分钟，方便重试
    return ok({"name": found.get("name", ""), "address": found.get("address", ""),
               "lat": flat, "lng": flng, "offline": not found})

# ------------------------------------------------------------------ chat
TOPIC_SELECT = (
    "SELECT t.*, u.name AS author_name, u.username AS author_username, u.color, u.avatar "
    "FROM topics t JOIN users u ON u.id = t.author_id ")


def topic_view(row, user_id=None, full=True):
    content = row["content"] or ""
    if not full and len(content) > 80:
        content = content[:80] + "…"
    anon = bool(row["anon"])
    name = row["anon_name"] if anon else row["author_name"]
    is_admin = False
    data = {
        "id": row["id"], "title": row["title"], "content": content,
        "author_id": row["author_id"], "author": row["author_name"],
        "name": name, "avatar": "" if anon else (row["avatar"] or ""),
        "anon": anon, "color": "" if anon else (row["color"] or ""),
        "reply_count": row["reply_count"] or 0,
        "last_at": row["last_at"] or row["created_at"],
        "created_at": row["created_at"],
        "mine": row["author_id"] == user_id,
        "deleted": row["deleted"],
        "pinned": row.get("pinned") or 0,
    }
    return data


def reaction_map(post_ids):
    if not post_ids:
        return {}
    marks = ",".join("?" * len(post_ids))
    rows = db.query(
        "SELECT post_id, emoji, COUNT(*) AS n FROM reactions WHERE post_id IN (%s) "
        "GROUP BY post_id, emoji" % marks, tuple(post_ids))
    out = {}
    for r in rows:
        out.setdefault(r["post_id"], []).append({"emoji": r["emoji"], "count": r["n"]})
    return out


def fetch_messages(user, topic_id, limit=60, before=0):
    sql = ("SELECT p.*, u.name AS real_name, u.color, u.avatar FROM posts p "
           "JOIN users u ON u.id = p.author_id "
           "WHERE p.kind = 'chat' AND p.deleted = 0 AND p.topic_id = ?")
    args = [topic_id]
    if before:
        sql += " AND p.id < ?"
        args.append(before)
    sql += " ORDER BY p.id DESC LIMIT ?"
    args.append(limit)
    rows = db.query(sql, tuple(args))
    rows.reverse()
    is_admin = user.get("role") == "admin"
    marks = reaction_map([r["id"] for r in rows])
    out = []
    for r in rows:
        item = {
            "id": r["id"], "topic_id": r["topic_id"],
            "name": r["anon_name"] if r["anon"] else r["real_name"],
            "anon": bool(r["anon"]), "color": r["color"] or "", "avatar": r["avatar"] or "",
            "content": r["content"], "created_at": r["created_at"], "reply_to": r["reply_to"],
            "mine": r["author_id"] == user["id"], "reactions": marks.get(r["id"], []),
        }
        # 非匿名发言才带上作者 id —— 讨论区点头像要看个人主页，匿名的一律不给
        if is_admin:
            item["author_id"] = r["author_id"]
            item["author_name"] = r["real_name"]
        elif not r["anon"]:
            item["author_id"] = r["author_id"]
        out.append(item)
    return out, len(rows) == limit


@route("GET", "/api/chat/topics")
async def chat_topics(req):
    limit = min(req.int_param("limit", 60), 200)
    query = (req.q("q") or "").strip()[:40]
    sql = TOPIC_SELECT + "WHERE t.deleted = 0"
    args = []
    if query:
        sql += " AND (t.title LIKE ? OR t.content LIKE ?)"
        args += ["%" + query + "%", "%" + query + "%"]
    sql += " ORDER BY t.pinned DESC, t.last_at DESC LIMIT ?"
    args.append(limit)
    rows = db.query(sql, tuple(args))
    return ok({"topics": [topic_view(r, req.user["id"], full=False) for r in rows]})


@route("POST", "/api/chat/topics")
async def chat_topic_create(req):
    if db.setting("topics_enabled", "1") != "1":
        raise HttpError(403, "话题讨论已关闭")
    if db.setting("chat_enabled", "1") != "1":
        raise HttpError(403, "讨论区已关闭")
    if req.user.get("muted"):
        raise HttpError(403, "你已被禁言")
    data = req.json()
    title = (data.get("title") or "").strip()[:60]
    content = (data.get("content") or "").strip()[:1000]
    if not title:
        raise HttpError(400, "话题标题不能为空")
    import asyncio
    import ws
    anon = 1 if data.get("anon", 0) else 0
    alias = ws.anon_alias(req.user["id"]) if anon else req.user["name"]
    ts = now()
    topic_id = db.execute(
        "INSERT INTO topics(author_id, anon, anon_name, title, content, reply_count, last_at, created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (req.user["id"], anon, alias, title, content, 0, ts, ts))
    row = db.query_one(TOPIC_SELECT + "WHERE t.id = ?", (topic_id,))
    asyncio.ensure_future(ws.broadcast({"t": "topic.new", "topic": topic_view(row, None, full=False)}))
    db.audit(req.user["id"], "chat.topic.create", "#%d %s" % (topic_id, title), req.client_ip)
    return ok({"topic": topic_view(row, req.user["id"])})


@route("GET", "/api/chat/topic/{tid}")
async def chat_topic_detail(req, tid):
    topic_id = int(tid)
    row = db.query_one(TOPIC_SELECT + "WHERE t.id = ?", (topic_id,))
    if not row:
        raise HttpError(404, "话题不存在")
    limit = min(req.int_param("limit", 60), 200)
    messages, has_more = fetch_messages(req.user, topic_id, limit, req.int_param("before", 0))
    return ok({"topic": topic_view(row, req.user["id"]), "messages": messages, "has_more": has_more})


@route("PATCH", "/api/chat/topic/{tid}")
async def chat_topic_update(req, tid):
    topic_id = int(tid)
    row = db.query_one("SELECT * FROM topics WHERE id = ?", (topic_id,))
    if not row:
        raise HttpError(404, "话题不存在")
    if row["author_id"] != req.user["id"] and not is_manager(req.user):
        raise HttpError(403, "只能修改自己创建的话题")
    data = req.json()
    fields, args = [], []
    if "title" in data:
        fields.append("title = ?")
        args.append((data["title"] or "").strip()[:60])
    if "content" in data:
        fields.append("content = ?")
        args.append((data["content"] or "").strip()[:1000])
    if "pinned" in data and req.user.get("role") == "admin":
        fields.append("pinned = ?")
        args.append(1 if data["pinned"] else 0)
    if "deleted" in data:
        if req.user.get("role") != "admin" and row["author_id"] != req.user["id"]:
            raise HttpError(403, "没有权限")
        fields += ["deleted = ?", "deleted_by = ?"]
        args += [1 if data["deleted"] else 0, req.user["id"] if data["deleted"] else 0]
    if fields:
        args.append(topic_id)
        db.execute("UPDATE topics SET %s WHERE id = ?" % ", ".join(fields), tuple(args))
        db.audit(req.user["id"], "chat.topic.update", "#%d %s" % (topic_id, dumps(data).decode()), req.client_ip)
    return ok({"updated": True})


@route("DELETE", "/api/chat/topic/{tid}")
async def chat_topic_delete(req, tid):
    topic_id = int(tid)
    row = db.query_one("SELECT * FROM topics WHERE id = ?", (topic_id,))
    if not row:
        raise HttpError(404, "话题不存在")
    if row["author_id"] != req.user["id"] and not is_manager(req.user):
        raise HttpError(403, "只能删除自己创建的话题")
    db.execute("UPDATE topics SET deleted = 1, deleted_by = ? WHERE id = ?", (req.user["id"], topic_id))
    db.audit(req.user["id"], "chat.topic.delete", "#%d" % topic_id, req.client_ip)
    return ok({"deleted": True})


@route("GET", "/api/chat/history")
async def chat_history(req):
    topic_id = req.int_param("topic_id", 0)
    limit = min(req.int_param("limit", 40), 200)
    messages, has_more = fetch_messages(req.user, topic_id, limit, req.int_param("before", 0))
    return ok({"messages": messages, "has_more": has_more, "topic_id": topic_id})


@route("POST", "/api/chat/post")
async def chat_post(req):
    data = req.json()
    content = (data.get("content") or "").strip()[:500]
    if not content:
        raise HttpError(400, "内容不能为空")
    if req.user.get("muted"):
        raise HttpError(403, "你已被禁言")
    if db.setting("chat_enabled", "1") != "1":
        raise HttpError(403, "讨论区已关闭")
    topic_id = int(data.get("topic_id") or 0)
    if topic_id and not db.query_one("SELECT id FROM topics WHERE id = ? AND deleted = 0", (topic_id,)):
        raise HttpError(404, "话题不存在或已删除")
    import asyncio
    import ws
    anon = 1 if data.get("anon", 0) else 0
    alias = ws.anon_alias(req.user["id"]) if anon else req.user["name"]
    reply_to = int(data.get("reply_to") or 0)
    ts = now()
    post_id = db.execute(
        "INSERT INTO posts(author_id, anon, anon_name, content, kind, reply_to, created_at, topic_id) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (req.user["id"], anon, alias, content, "chat", reply_to, ts, topic_id))
    if topic_id:
        db.execute("UPDATE topics SET reply_count = reply_count + 1, last_at = ? WHERE id = ?", (ts, topic_id))
    payload = {"t": "chat.new", "msg": {
        "id": post_id, "topic_id": topic_id, "name": alias, "anon": bool(anon),
        "color": req.user.get("color") or "", "avatar": "" if anon else (req.user.get("avatar") or ""),
        "content": content, "created_at": ts, "reply_to": reply_to, "reactions": [], "mine": False}}
    asyncio.ensure_future(ws.broadcast(payload))
    return ok({"id": post_id, "topic_id": topic_id})


@route("GET", "/api/chat/search")
async def chat_search(req):
    query = (req.q("q") or "").strip()[:40]
    if not query:
        return ok({"q": "", "topics": [], "messages": []})
    like = "%" + query + "%"
    topics = db.query(
        TOPIC_SELECT + "WHERE t.deleted = 0 AND (t.title LIKE ? OR t.content LIKE ?) "
        "ORDER BY t.last_at DESC LIMIT 30", (like, like))
    rows = db.query(
        "SELECT p.*, u.name AS real_name, u.color, u.avatar, t.title AS topic_title FROM posts p "
        "JOIN users u ON u.id = p.author_id LEFT JOIN topics t ON t.id = p.topic_id "
        "WHERE p.kind = 'chat' AND p.deleted = 0 AND p.content LIKE ? ORDER BY p.id DESC LIMIT 50", (like,))
    messages = [{
        "id": r["id"], "topic_id": r["topic_id"], "topic_title": r["topic_title"] or "大厅",
        "name": r["anon_name"] if r["anon"] else r["real_name"], "anon": bool(r["anon"]),
        "content": r["content"], "created_at": r["created_at"],
        "mine": r["author_id"] == req.user["id"],
    } for r in rows]
    return ok({"q": query, "topics": [topic_view(r, req.user["id"], full=False) for r in topics],
               "messages": messages})


@route("GET", "/api/announcements")
async def announcements(req):
    ann_scope, ann_cid = class_scope(req)
    ann_where, ann_args = session_scope_where(ann_scope, ann_cid, "p.")
    rows = db.query(
        "SELECT p.*, u.name AS author_name, u.avatar FROM posts p LEFT JOIN users u ON u.id = p.author_id "
        "WHERE p.kind = 'announce' AND p.deleted = 0%s ORDER BY p.id DESC LIMIT 30" % ann_where, tuple(ann_args))
    read_ids = {r["post_id"] for r in db.query(
        "SELECT post_id FROM announce_reads WHERE user_id = ?", (req.user["id"],))}
    items = [{
        "id": r["id"], "content": r["content"], "created_at": r["created_at"],
        "author": r["author_name"] or "管理员", "avatar": r["avatar"] or "",
        "read": r["id"] in read_ids,
    } for r in rows]
    return ok({"items": items, "unread": sum(1 for item in items if not item["read"]),
               "popup_enabled": db.setting("announce_popup", "1") == "1"})


@route("POST", "/api/announcements/ack")
async def announce_ack(req):
    data = req.json()
    ids = data.get("ids")
    if not isinstance(ids, list):
        ids = [data.get("id")]
    count = 0
    for value in ids:
        try:
            post_id = int(value)
        except (TypeError, ValueError):
            continue
        if not post_id:
            continue
        if not db.query_one("SELECT 1 AS x FROM announce_reads WHERE user_id = ? AND post_id = ?",
                            (req.user["id"], post_id)):
            db.execute("INSERT INTO announce_reads(user_id, post_id, read_at) VALUES(?,?,?)",
                       (req.user["id"], post_id, now()))
            count += 1
    return ok({"acked": count})


# ------------------------------------------------------------------ games
@route("GET", "/api/games/meta")
async def games_meta(req):
    import games
    return ok({"games": games.GAME_META,
               "records": db.query("SELECT * FROM game_records ORDER BY id DESC LIMIT 20")})


# ---------------------------------------------------------------- 积分 / 排行榜
SOLO_MINE_POINTS = {"easy": 0, "normal": 1, "hard": 2, "insane": 3}
SOLO_COOLDOWN = 10  # 秒，防止连点刷分
DANMAKU_MAX_POINTS = 10  # 弹幕大战单局积分上限（对应 20 万分封顶），防伪造刷分
_solo_last = {}


@route("GET", "/api/games/leaderboard")
async def games_leaderboard(req):
    scope = (req.q("scope") or "online").strip().lower()
    if scope not in ("online", "solo"):
        scope = "online"
    return ok({"scope": scope, "rows": db.leaderboard(scope, 100),
               "me": db.get_points(req.user["id"]), "my_rank": db.rank_of(req.user["id"], scope)})


@route("POST", "/api/games/solo/points")
async def solo_points(req):
    """单机游戏领积分：2048 每合成一个 2048 记 1 分；扫雷按难度 0/1/2/3 分；
    弹幕大战按 score//20000 计分，单局上限 10 分。"""
    data = req.json()
    kind = (data.get("kind") or "").strip()
    difficulty = (data.get("difficulty") or "").strip()
    if kind == "2048":
        points, label = 1, "2048 合成"
    elif kind == "mine":
        if difficulty not in SOLO_MINE_POINTS:
            raise HttpError(400, "未知难度")
        points, label = SOLO_MINE_POINTS[difficulty], "扫雷 " + difficulty
    elif kind == "danmaku":
        try:
            score = max(0, int(float(data.get("score") or 0)))
        except (TypeError, ValueError):
            raise HttpError(400, "分数格式不对")
        points = min(score // 20000, DANMAKU_MAX_POINTS)
        label = "弹幕大战"
    else:
        raise HttpError(400, "未知游戏")
    if points <= 0:
        return ok({"awarded": 0, "points": db.get_points(req.user["id"]), "label": label})
    stamp = now()
    if stamp - _solo_last.get(req.user["id"], 0) < SOLO_COOLDOWN:
        raise HttpError(429, "刚刚已经记过分啦，稍等几秒")
    _solo_last[req.user["id"]] = stamp
    info = db.add_points(req.user["id"], solo=points)
    db.audit(req.user["id"], "game.solo.points", "%s +%d" % (label, points), req.client_ip)
    return ok({"awarded": points, "points": info, "label": label})


# ---------------------------------------------------------------- 更新日志
def changelog_view(row):
    return {"id": row["id"], "version": row["version"] or "", "title": row["title"],
            "body": row["body"] or "", "author": row["author"] or "系统",
            "created_at": row["created_at"]}


@route("GET", "/api/changelog")
async def changelog_list(req):
    rows = db.query("SELECT c.*, u.name AS author FROM changelogs c "
                    "LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id DESC LIMIT 60")
    return ok({"items": [changelog_view(r) for r in rows],
               "version_h5": int(db.setting("version_h5") or 1)})


def _text(value):
    """把任意 JSON 值安全地转成去空白的字符串（None -> ''，其它类型走 str）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


@route("POST", "/api/admin/changelog", admin=True)
async def changelog_create(req):
    data = req.json()
    title = _text(data.get("title"))[:80]
    # body 允许是字符串或字符串数组（脚本/接口调用方两种写法都见过），统一成换行拼接
    raw_body = data.get("body")
    body = ("\n".join(_text(x) for x in raw_body) if isinstance(raw_body, list) else _text(raw_body))[:4000]
    version = (data.get("version") or "").strip()[:24] or ("v" + str(int(db.setting("version_h5") or 1)))
    if not title:
        raise HttpError(400, "标题不能为空")
    ts = now()
    cid = db.execute("INSERT INTO changelogs(version, title, body, created_by, created_at) VALUES(?,?,?,?,?)",
                     (version, title, body, req.user["id"], ts))
    # 更新日志只进「更新日志」入口，不再往公告里发（用户 2026-09-20 要求）
    db.audit(req.user["id"], "admin.changelog", "%s %s" % (version, title), req.client_ip)
    return ok({"id": cid, "version": version})


@route("DELETE", "/api/admin/changelog/{cid}", admin=True)
async def changelog_delete(req, cid):
    db.execute("DELETE FROM changelogs WHERE id = ?", (int(cid),))
    db.audit(req.user["id"], "admin.changelog.delete", "id=%s" % cid, req.client_ip)
    return ok({"deleted": True})


# ------------------------------------------------------------------ admin helpers
def server_stats():
    load = open("/proc/loadavg").read().split()[:3] if os.path.exists("/proc/loadavg") else ["-", "-", "-"]
    mem = {}
    try:
        for line in open("/proc/meminfo"):
            key, value = line.split(":", 1)
            mem[key.strip()] = int(value.strip().split()[0])
    except OSError:
        pass
    total = mem.get("MemTotal", 0) / 1024.0
    available = mem.get("MemAvailable", 0) / 1024.0
    if hasattr(os, "statvfs"):
        stat = os.statvfs("/")
        disk_total = stat.f_blocks * stat.f_frsize / 1048576.0
        disk_free = stat.f_bavail * stat.f_frsize / 1048576.0
    else:  # development on Windows
        import shutil
        usage = shutil.disk_usage("/")
        disk_total = usage.total / 1048576.0
        disk_free = usage.free / 1048576.0
    return {
        "load": load,
        "mem_total": round(total),
        "mem_used": round(total - available),
        "mem_percent": round((total - available) * 100 / total, 1) if total else 0,
        "disk_total": round(disk_total),
        "disk_free": round(disk_free),
        "disk_percent": round((disk_total - disk_free) * 100 / disk_total, 1) if disk_total else 0,
    }


_NET_PREV = {"t": 0.0, "rx": 0, "tx": 0}
_NET_LAST = {"rx": 0.0, "tx": 0.0}
_NET_PEAK = {"rx": 0.0, "tx": 0.0}


def _read_net_dev():
    """累计收发字节数（跳过 lo 回环）。非 Linux 或读不到时返回 None。"""
    if not os.path.exists("/proc/net/dev"):
        return None
    try:
        with open("/proc/net/dev") as fh:
            lines = fh.readlines()[2:]
    except OSError:
        return None
    rx = tx = 0
    for line in lines:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        if name.strip() == "lo":
            continue
        parts = rest.split()
        if len(parts) < 9:
            continue
        rx += int(parts[0])
        tx += int(parts[8])
    return rx, tx


def net_stats():
    """实时带宽占用：两次采样的差值 / 时间差。同一秒内重复调用返回上次的结果。"""
    cap = float(db.setting("net_cap_mbps", "10") or 10) or 10.0
    sample = _read_net_dev()
    if sample is None:  # Windows 上开发时没有 /proc
        return {"net_unsupported": True, "net_cap_mbps": cap,
                "net_rx_bps": 0.0, "net_tx_bps": 0.0, "net_total_bps": 0.0,
                "net_percent": 0.0, "net_peak_bps": 0.0, "net_rx_total": 0, "net_tx_total": 0}
    rx, tx = sample
    ts = time.time()
    prev = _NET_PREV
    span = ts - prev["t"] if prev["t"] else 0
    if prev["t"] and span >= 0.2:
        _NET_LAST["rx"] = max(0.0, rx - prev["rx"]) / span
        _NET_LAST["tx"] = max(0.0, tx - prev["tx"]) / span
        _NET_PEAK["rx"] = max(_NET_PEAK["rx"], _NET_LAST["rx"])
        _NET_PEAK["tx"] = max(_NET_PEAK["tx"], _NET_LAST["tx"])
        _NET_PREV.update({"t": ts, "rx": rx, "tx": tx})
    elif not prev["t"]:
        _NET_PREV.update({"t": ts, "rx": rx, "tx": tx})
    total = _NET_LAST["rx"] + _NET_LAST["tx"]
    peak = _NET_PEAK["rx"] + _NET_PEAK["tx"]
    return {
        "net_rx_bps": round(_NET_LAST["rx"], 1),
        "net_tx_bps": round(_NET_LAST["tx"], 1),
        "net_total_bps": round(total, 1),
        "net_peak_bps": round(peak, 1),
        "net_cap_mbps": cap,
        "net_percent": round(total * 100.0 / (cap * 125000.0), 1),
        "net_rx_total": rx,
        "net_tx_total": tx,
    }


@route("GET", "/api/admin/overview", staff=True)
async def admin_overview(req):
    import ws
    scope, cid = class_scope(req)
    user_where, user_args = scope_where(scope, cid, "class_id", "u.")
    sess_where, sess_args = session_scope_where(scope, cid)
    super_admin = is_super(req.user)

    def count(sql, args=()):
        return db.query_one(sql, tuple(args))["c"]

    live = [c for c in ws.CONNS if not c.closed]
    if scope != "all":
        keep = cid if scope == "one" else 0
        live = [c for c in live if class_id_of(c.user) == keep]
    payload = {
        "online": len({c.uid for c in live}),
        "online_users": sorted({c.user["name"] for c in live}),
        "online_people": sorted({(c.uid, c.user["name"], c.user.get("avatar") or "",
                                  class_id_of(c.user), auth.class_name_of(c.user.get("class_id")))
                                 for c in live}, key=lambda item: item[0]),
        "users": count("SELECT COUNT(*) AS c FROM users u WHERE 1 = 1%s" % user_where, user_args),
        "members": count("SELECT COUNT(*) AS c FROM users u WHERE u.role='member'%s" % user_where, user_args),
        "sessions": count("SELECT COUNT(*) AS c FROM sign_sessions s WHERE 1 = 1%s"
                          % sess_where.replace("class_id", "s.class_id"), sess_args),
        "records": count(
            "SELECT COUNT(*) AS c FROM records r JOIN users u ON u.id = r.user_id "
            "JOIN sign_sessions s ON s.id = r.session_id WHERE 1 = 1%s%s"
            % (user_where, sess_where.replace("class_id", "s.class_id")), list(user_args) + list(sess_args)),
        "posts": count("SELECT COUNT(*) AS c FROM posts WHERE deleted = 0"),
        "games": count("SELECT COUNT(*) AS c FROM game_records"),
        "topics": count("SELECT COUNT(*) AS c FROM topics WHERE deleted = 0"),
        "role": req.user.get("role") or "member",
        "is_admin": super_admin,
        "is_super": super_admin,
        "my_class_id": class_id_of(req.user),
        "my_class_name": auth.class_name_of(req.user.get("class_id")),
        "scope": scope,
        "scope_class": cid,
        "classes": class_list(),
        "settings": db.get_settings(),
    }
    if super_admin:
        payload["server"] = server_stats()
        payload["net"] = net_stats()
    return ok(payload)


@route("GET", "/api/admin/users", manage=True)
async def admin_users(req):
    """成员列表：总管理员可选班（?class=all|0|N），班级管理员只能看本班。"""
    scope, cid = class_scope(req)
    where, args = scope_where(scope, cid)
    rows = db.query("SELECT * FROM users WHERE 1 = 1%s ORDER BY role DESC, id ASC" % where, tuple(args))
    out = []
    for u in rows:
        item = auth.public_user(u, req.user)
        item["username"] = u["username"]
        item["checked"] = db.query_one(
            "SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND status IN ('present','late')", (u["id"],))["c"]
        out.append(item)
    return ok({"users": out, "classes": class_list(), "scope": scope, "scope_class": cid,
               "is_super": is_super(req.user), "can_create": is_super(req.user),
               "my_class_id": class_id_of(req.user)})


@route("POST", "/api/admin/users", admin=True)
async def admin_user_create(req):
    data = req.json()
    username = (data.get("username") or "").strip()
    name = (data.get("name") or "").strip() or username
    password = (data.get("password") or "").strip() or db.random_password()
    role = data.get("role") if data.get("role") in ("admin", "class_admin", "committee", "study", "member") else "member"
    if len(username) < 2:
        raise HttpError(400, "用户名至少 2 位")
    if db.query_one("SELECT id FROM users WHERE username = ?", (username,)):
        raise HttpError(409, "用户名已存在")
    class_id = int(data.get("class_id") or 0)
    if class_id and not db.query_one("SELECT id FROM classes WHERE id = ?", (class_id,)):
        raise HttpError(400, "班级不存在，请先创建班级")
    password_hash, salt = auth.hash_password(password)
    uid = db.execute(
        "INSERT INTO users(username, name, role, password_hash, salt, color, note, created_at, class_id) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (username, name, role, password_hash, salt, data.get("color") or "", data.get("note") or "", now(), class_id))
    db.audit(req.user["id"], "admin.user.create", "%s(%s)" % (name, username), req.client_ip)
    return ok({"id": uid, "password": password})


@route("PATCH", "/api/admin/users/{uid}", manage=True)
async def admin_user_update(req, uid):
    data = req.json()
    target = db.query_one("SELECT * FROM users WHERE id = ?", (int(uid),))
    if not target:
        raise HttpError(404, "用户不存在")
    super_admin = is_super(req.user)
    if not can_touch_user(req.user, target):
        raise HttpError(403, "你只能管理自己班里的成员")
    if not super_admin and target["role"] in ("admin", "class_admin"):
        raise HttpError(403, "你无权修改管理员账号")
    fields, args = [], []
    for key in ("name", "note", "color"):
        if key in data:
            fields.append("%s = ?" % key)
            args.append(str(data[key])[:200])
    if "role" in data:
        new_role = data["role"]
        if new_role not in ("admin", "class_admin", "committee", "study", "member"):
            raise HttpError(400, "未知的身份类型")
        if not super_admin and new_role not in ("committee", "study", "member"):
            raise HttpError(403, "只有总管理员能任命管理员")
        fields.append("role = ?")
        args.append(new_role)
    if "class_id" in data:
        if not super_admin:
            raise HttpError(403, "只有总管理员能调整成员班级")
        new_class = int(data["class_id"] or 0)
        if new_class and not db.query_one("SELECT id FROM classes WHERE id = ?", (new_class,)):
            raise HttpError(400, "班级不存在")
        fields.append("class_id = ?")
        args.append(new_class)
    for key in ("banned", "muted"):
        if key in data:
            fields.append("%s = ?" % key)
            args.append(1 if data[key] else 0)
    if data.get("password"):
        password_hash, salt = auth.hash_password(data["password"])
        fields += ["password_hash = ?", "salt = ?"]
        args += [password_hash, salt]
        auth.drop_user_sessions(target["id"])
    if fields:
        args.append(target["id"])
        db.execute("UPDATE users SET %s WHERE id = ?" % ", ".join(fields), tuple(args))
        db.audit(req.user["id"], "admin.user.update", "%s: %s" % (target["username"], dumps(data).decode()), req.client_ip)
    return ok({"updated": True})


@route("POST", "/api/admin/users/{uid}/reset-password", manage=True)
async def admin_user_reset(req, uid):
    target = db.query_one("SELECT * FROM users WHERE id = ?", (int(uid),))
    if not target:
        raise HttpError(404, "用户不存在")
    if not can_touch_user(req.user, target) or (
            not is_super(req.user) and target["role"] in ("admin", "class_admin")):
        raise HttpError(403, "你只能重置自己班里成员的密码")
    data = req.json()
    password = (data.get("password") or "").strip() or db.random_password()
    password_hash, salt = auth.hash_password(password)
    db.execute("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", (password_hash, salt, target["id"]))
    auth.drop_user_sessions(target["id"])
    db.audit(req.user["id"], "admin.user.reset", target["username"], req.client_ip)
    return ok({"password": password})


@route("DELETE", "/api/admin/users/{uid}", manage=True)
async def admin_user_delete(req, uid):
    target = db.query_one("SELECT * FROM users WHERE id = ?", (int(uid),))
    if not target:
        raise HttpError(404, "用户不存在")
    if target["id"] == req.user["id"]:
        raise HttpError(400, "不能删除自己")
    if not can_touch_user(req.user, target):
        raise HttpError(403, "你只能删除自己班里的成员")
    if not is_super(req.user) and target["role"] in ("admin", "class_admin"):
        raise HttpError(403, "你无权删除管理员账号")
    if target["role"] == "admin":
        if db.query_one("SELECT COUNT(*) AS c FROM users WHERE role='admin'")["c"] <= 1:
            raise HttpError(400, "至少要保留一个管理员")
    db.execute("DELETE FROM users WHERE id = ?", (target["id"],))
    db.execute("DELETE FROM records WHERE user_id = ?", (target["id"],))
    auth.drop_user_sessions(target["id"])
    db.audit(req.user["id"], "admin.user.delete", target["username"], req.client_ip)
    return ok({"deleted": True})


@route("GET", "/api/admin/sign-sessions", staff=True)
async def admin_sign_sessions(req):
    scope, cid = class_scope(req)
    where, args = session_scope_where(scope, cid)
    rows = db.query("SELECT * FROM sign_sessions WHERE 1 = 1%s ORDER BY starts_at DESC LIMIT 200" % where,
                    tuple(args))
    out = []
    for r in rows:
        item = session_view(r)
        item["code"] = r["code"]
        item["created_by"] = r["created_by"]
        item["class_id"] = int(r.get("class_id") or 0)
        item["class_name"] = auth.class_name_of(r.get("class_id")) or "全体"
        item["mine"] = (int(r.get("class_id") or 0) == class_id_of(req.user) and class_id_of(req.user) != 0) \
            or is_super(req.user)
        out.append(item)
    return ok({"sessions": out, "classes": class_list(), "scope": scope, "scope_class": cid,
               "is_super": is_super(req.user), "my_class_id": class_id_of(req.user),
               "my_class_name": auth.class_name_of(req.user.get("class_id"))})


@route("POST", "/api/admin/sign-sessions", staff=True)
async def admin_sign_create(req):
    data = req.json()
    ts = now()
    grace = data.get("grace_minutes")
    grace = int(grace) if grace not in (None, "") else int(db.setting("default_grace", "15") or 15)
    grace = max(0, min(grace, 24 * 60))
    raw_at = data.get("sign_at")
    if isinstance(raw_at, (int, float)) and raw_at > 1000000:
        sign_at = int(raw_at)
    elif isinstance(raw_at, str) and raw_at.strip().isdigit() and len(raw_at.strip()) > 8:
        sign_at = int(raw_at.strip())
    else:
        hhmm = (str(raw_at).strip() if raw_at else "") or (sign_time_options()[0])
        if parse_hhmm(hhmm) is None:
            raise HttpError(400, "签到时间格式应为 HH:MM")
        sign_at = ts_at_hhmm(hhmm, ts, grace * 60)
    if is_super(req.user):
        target_class = int(data.get("class_id") or 0)
        if target_class and not db.query_one("SELECT id FROM classes WHERE id = ?", (target_class,)):
            raise HttpError(400, "班级不存在")
    else:
        # 还没分班（或者管理员自己就是「未指定班级」）时，退回成全体可见的公共场次，
        # 这样单班时代的老用法不会因为没建班级就直接罢工。
        target_class = class_id_of(req.user)
    title = (data.get("title") or "").strip()[:60] or ("签到 " + fmt(sign_at, "%H:%M"))
    code = (data.get("code") or db.random_code()).strip()[:8]
    require_location = 1 if data.get("require_location") else 0
    lat = float(data.get("lat") or 0)
    lng = float(data.get("lng") or 0)
    radius = int(data.get("radius") or 200)
    if require_location and not (lat or lng):
        raise HttpError(400, "开启定位签到时需要先选择签到位置")
    radius = max(20, min(radius, 5000))
    sid = db.execute(
        "INSERT INTO sign_sessions(title, code, status, created_by, created_at, starts_at, ends_at, late_after, "
        "allow_leave, require_note, note, sign_at, grace_minutes, require_location, lat, lng, radius, place, class_id) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (title, code, "open", req.user["id"], ts, ts,
         sign_at + grace * 60,
         sign_at,
         0 if data.get("allow_leave") is False else 1,
         1 if data.get("require_note") else 0,
         (data.get("note") or "")[:200],
         sign_at, grace, require_location, lat, lng, radius,
         (data.get("place") or "")[:80], target_class))
    db.audit(req.user["id"], "admin.session.create", "#%d %s" % (sid, title), req.client_ip)
    asyncio.ensure_future(ws.broadcast({"t": "sign.new", "id": sid, "title": title,
                                        "sign_at": sign_at, "require_location": require_location,
                                        "class_id": target_class}))
    return ok({"id": sid, "code": code, "sign_at": sign_at, "ends_at": sign_at + grace * 60,
               "class_id": target_class})


@route("PATCH", "/api/admin/sign-sessions/{sid}", staff=True)
async def admin_sign_update(req, sid):
    data = req.json()
    session_id = int(sid)
    row = db.query_one("SELECT * FROM sign_sessions WHERE id = ?", (session_id,))
    if not row:
        raise HttpError(404, "场次不存在")
    if not is_super(req.user) and int(row.get("class_id") or 0) != class_id_of(req.user):
        raise HttpError(403, "这条签到不属于你的班级")
    fields, args = [], []
    for key in ("title", "code", "status", "note", "place"):
        if key in data:
            fields.append("%s = ?" % key)
            args.append(str(data[key])[:200])
    for key in ("starts_at", "ends_at", "late_after", "sign_at", "grace_minutes", "radius"):
        if key in data:
            fields.append("%s = ?" % key)
            args.append(int(data[key] or 0))
    for key in ("lat", "lng"):
        if key in data:
            fields.append("%s = ?" % key)
            args.append(float(data[key] or 0))
    for key in ("allow_leave", "require_note", "require_location"):
        if key in data:
            fields.append("%s = ?" % key)
            args.append(1 if data[key] else 0)
    if fields:
        args.append(session_id)
        db.execute("UPDATE sign_sessions SET %s WHERE id = ?" % ", ".join(fields), tuple(args))
        db.audit(req.user["id"], "admin.session.update", "#%d %s" % (session_id, dumps(data).decode()), req.client_ip)
    asyncio.ensure_future(ws.broadcast({"t": "sign.update", "id": int(sid)}))
    return ok({"updated": True})


@route("DELETE", "/api/admin/sign-sessions/{sid}", staff=True)
async def admin_sign_delete(req, sid):
    row = db.query_one("SELECT * FROM sign_sessions WHERE id = ?", (int(sid),))
    if not row:
        raise HttpError(404, "场次不存在")
    if not is_super(req.user) and int(row.get("class_id") or 0) != class_id_of(req.user):
        raise HttpError(403, "这条签到不属于你的班级")
    db.execute("DELETE FROM sign_sessions WHERE id = ?", (int(sid),))
    db.execute("DELETE FROM records WHERE session_id = ?", (int(sid),))
    db.audit(req.user["id"], "admin.session.delete", "#%s" % sid, req.client_ip)
    asyncio.ensure_future(ws.broadcast({"t": "sign.update", "id": int(sid)}))
    return ok({"deleted": True})


@route("GET", "/api/admin/records", staff=True)
async def admin_records(req):
    sid = req.int_param("session_id", 0)
    scope, cid = class_scope(req)
    user_where, user_args = scope_where(scope, cid, "class_id", "u.")
    sess_where, sess_args = session_scope_where(scope, cid, "s.")
    if sid:
        rows = db.query(
            "SELECT r.*, u.name, u.username, u.avatar FROM records r JOIN users u ON u.id = r.user_id "
            "WHERE r.session_id = ?%s ORDER BY r.created_at" % user_where, tuple([sid] + user_args))
    else:
        rows = db.query(
            "SELECT r.*, u.name, u.username, u.avatar FROM records r JOIN users u ON u.id = r.user_id "
            "JOIN sign_sessions s ON s.id = r.session_id WHERE 1 = 1%s%s "
            "ORDER BY r.id DESC LIMIT 300" % (user_where, sess_where),
            tuple(list(user_args) + list(sess_args)))
    return ok({"records": [{
        "id": r["id"], "session_id": r["session_id"], "user_id": r["user_id"], "name": r["name"],
        "username": r["username"], "status": r["status"], "note": r["note"], "created_at": r["created_at"],
        "avatar": r["avatar"] or "",
        "ip": mask_ip(r["ip"]), "device": r["device"], "by_admin": r["by_admin"],
    } for r in rows]})


STATUS_TEXT = {"present": "已签到", "late": "迟到", "leave": "请假", "absent": "缺勤", "none": "未记录"}


def session_roster(session_id, scope="all", cid=0):
    """一个场次的本班名单：每个人当前是什么状态（没有记录就是"未记录"）。"""
    where, args = scope_where(scope, cid)
    users = db.query("SELECT id, name, username, avatar, class_id FROM users WHERE banned = 0%s ORDER BY id"
                     % where, tuple(args))
    recs = {r["user_id"]: r for r in db.query("SELECT * FROM records WHERE session_id = ?", (session_id,))}
    rows, counts = [], {"present": 0, "late": 0, "leave": 0, "absent": 0, "none": 0}
    for u in users:
        rec = recs.get(u["id"])
        status = rec["status"] if rec else "none"
        counts[status] = counts.get(status, 0) + 1
        rows.append({
            "user_id": u["id"], "name": u["name"], "username": u["username"],
            "avatar": u["avatar"] or "", "status": status,
            "record_id": rec["id"] if rec else 0,
            "note": (rec["note"] if rec else "") or "",
            "created_at": rec["created_at"] if rec else 0,
            "by_admin": rec["by_admin"] if rec else 0,
        })
    return rows, counts


@route("GET", "/api/admin/session-roster", staff=True)
async def admin_session_roster(req):
    sid = req.int_param("session_id", 0)
    row = db.query_one("SELECT * FROM sign_sessions WHERE id = ?", (sid,))
    if not row:
        raise HttpError(404, "场次不存在")
    if not is_super(req.user) and int(row.get("class_id") or 0) not in (0, class_id_of(req.user)):
        raise HttpError(403, "这条签到不属于你的班级")
    scope, cid = class_scope(req)
    rows, counts = session_roster(sid, scope, cid)
    return ok({"session": session_view(row), "roster": rows, "counts": counts})


def _stamp(ts):
    return fmt(ts, "%Y-%m-%d %H:%M") if ts else ""


def _rate(present, late, total):
    if not total:
        return "0%"
    return "%.1f%%" % ((present + late) * 100.0 / total)


@route("GET", "/api/admin/records.xlsx", staff=True)
async def admin_records_xlsx(req):
    """把全部场次的签到记录导出成 Excel（.xlsx 用标准库 zipfile 现写，不依赖第三方包）。"""
    import xlsx
    scope, cid = class_scope(req)
    user_where, user_args = scope_where(scope, cid)
    sess_where, sess_args = session_scope_where(scope, cid)
    sid = req.int_param("session_id", 0)
    if sid:
        sessions = db.query("SELECT * FROM sign_sessions WHERE id = ?%s" % sess_where, tuple([sid] + sess_args))
    else:
        sessions = db.query(
            "SELECT * FROM sign_sessions WHERE 1 = 1%s ORDER BY sign_at DESC, id DESC LIMIT 500" % sess_where,
            tuple(sess_args))
    users = db.query("SELECT id, name, username FROM users WHERE banned = 0%s ORDER BY id" % user_where,
                     tuple(user_args))
    user_acc = {u["id"]: u["username"] for u in users}
    total_users = len(users)

    detail = [["场次", "签到时间", "姓名", "账号", "状态", "记录时间", "备注", "距离(米)", "管理员代签"]]
    summary = [["场次", "签到时间", "应到", "已签到", "迟到", "请假", "缺勤", "未记录", "出勤率"]]
    per_user = {}
    for u in users:
        per_user[u["id"]] = {"present": 0, "late": 0, "leave": 0, "absent": 0, "none": 0}

    for sess in sessions:
        rows = list(db.query(
            "SELECT r.*, u.name AS uname FROM records r JOIN users u ON u.id = r.user_id "
            "WHERE r.session_id = ?%s" % user_where, tuple([sess["id"]] + user_args)))
        got = {}
        for r in rows:
            got[r["user_id"]] = r
            detail.append([
                "#%d %s" % (sess["id"], sess["title"]), _stamp(sess.get("sign_at") or sess["starts_at"]),
                r["uname"], user_acc.get(r["user_id"], ""), STATUS_TEXT.get(r["status"], r["status"]),
                _stamp(r["created_at"]), r["note"] or "", int(r["distance"] or 0),
                "是" if r["by_admin"] else "",
            ])
            if r["user_id"] in per_user:
                per_user[r["user_id"]][r["status"]] = per_user[r["user_id"]].get(r["status"], 0) + 1
        for u in users:
            if u["id"] not in got:
                per_user[u["id"]]["none"] += 1
        counts = {"present": 0, "late": 0, "leave": 0, "absent": 0}
        for r in rows:
            if r["status"] in counts:
                counts[r["status"]] += 1
        missing = max(0, total_users - len(rows))
        summary.append([
            "#%d %s" % (sess["id"], sess["title"]), _stamp(sess.get("sign_at") or sess["starts_at"]),
            total_users, counts["present"], counts["late"], counts["leave"], counts["absent"], missing,
            _rate(counts["present"], counts["late"], total_users),
        ])

    stat = [["姓名", "账号", "已签到", "迟到", "请假", "缺勤", "未记录", "出勤率"]]
    for u in users:
        c = per_user[u["id"]]
        stat.append([u["name"], u["username"], c["present"], c["late"], c["leave"], c["absent"], c["none"],
                     _rate(c["present"], c["late"], len(sessions) or 1)])

    blob = xlsx.build([
        ("签到明细", detail, [26, 18, 12, 14, 9, 18, 20, 10, 11]),
        ("场次汇总", summary, [26, 18, 7, 8, 7, 7, 7, 8, 9]),
        ("个人统计", stat, [12, 14, 9, 7, 7, 7, 8, 9]),
    ])
    fname = ("sign-records-%s.xlsx" % fmt(now(), "%Y%m%d-%H%M")) if not sid else ("sign-session-%d.xlsx" % sid)
    db.audit(req.user["id"], "admin.records.export", "session=%s rows=%d" % (sid or "all", len(detail) - 1), req.client_ip)
    return Response(200, blob, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {
        "Content-Disposition": 'attachment; filename="%s"' % fname,
        "Cache-Control": "no-cache",
    })


@route("POST", "/api/admin/records", staff=True)
async def admin_record_add(req):
    data = req.json()
    session_id = int(data.get("session_id") or 0)
    user_id = int(data.get("user_id") or 0)
    status = data.get("status") or "present"
    if status not in ("present", "late", "leave", "absent"):
        raise HttpError(400, "状态不合法")
    sess_row = db.query_one("SELECT * FROM sign_sessions WHERE id = ?", (session_id,))
    if not sess_row:
        raise HttpError(404, "场次不存在")
    if not can_see_session(req.user, sess_row):
        raise HttpError(403, "这条签到不属于你的班级")
    target_user = db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
    if not target_user:
        raise HttpError(404, "用户不存在")
    if not can_touch_user(req.user, target_user):
        raise HttpError(403, "你只能修改自己班里成员的记录")
    ts = now()
    existing = db.query_one("SELECT * FROM records WHERE session_id = ? AND user_id = ?", (session_id, user_id))
    if existing:
        db.execute("UPDATE records SET status = ?, note = ?, updated_at = ?, by_admin = 1 WHERE id = ?",
                   (status, (data.get("note") or "")[:200], ts, existing["id"]))
    else:
        db.execute(
            "INSERT INTO records(session_id, user_id, status, note, created_at, updated_at, ip, ua, by_admin) "
            "VALUES(?,?,?,?,?,?,?,?,1)",
            (session_id, user_id, status, (data.get("note") or "")[:200], ts, ts, req.client_ip, "admin"))
    db.audit(req.user["id"], "admin.record.set", "场次#%d 用户#%d %s" % (session_id, user_id, status), req.client_ip)
    return ok({"saved": True})


@route("PATCH", "/api/admin/records/{rid}", staff=True)
async def admin_record_update(req, rid):
    data = req.json()
    rec = db.query_one("SELECT * FROM records WHERE id = ?", (int(rid),))
    if not rec:
        raise HttpError(404, "记录不存在")
    owner = db.query_one("SELECT * FROM users WHERE id = ?", (rec["user_id"],))
    if not owner or not can_touch_user(req.user, owner):
        raise HttpError(403, "你只能修改自己班里成员的记录")
    fields, args = [], []
    if "status" in data:
        fields.append("status = ?")
        args.append(data["status"])
    if "note" in data:
        fields.append("note = ?")
        args.append(str(data["note"])[:200])
    if "created_at" in data:
        fields.append("created_at = ?")
        args.append(int(data["created_at"]))
    fields += ["by_admin = 1", "updated_at = ?"]
    args += [now(), int(rid)]
    db.execute("UPDATE records SET %s WHERE id = ?" % ", ".join(fields), tuple(args))
    db.audit(req.user["id"], "admin.record.update", "#%s %s" % (rid, dumps(data).decode()), req.client_ip)
    return ok({"updated": True})


@route("DELETE", "/api/admin/records/{rid}", admin=True)
async def admin_record_delete(req, rid):
    rec = db.query_one("SELECT * FROM records WHERE id = ?", (int(rid),))
    if not rec:
        raise HttpError(404, "记录不存在")
    owner = db.query_one("SELECT * FROM users WHERE id = ?", (rec["user_id"],))
    if not owner or not can_touch_user(req.user, owner):
        raise HttpError(403, "你只能删除自己班里成员的记录")
    db.execute("DELETE FROM records WHERE id = ?", (int(rid),))
    db.audit(req.user["id"], "admin.record.delete", "#%s" % rid, req.client_ip)
    return ok({"deleted": True})


@route("GET", "/api/admin/posts", staff=True)
async def admin_posts(req):
    rows = db.query(
        "SELECT p.*, u.name AS real_name, u.username FROM posts p JOIN users u ON u.id = p.author_id "
        "ORDER BY p.id DESC LIMIT 200")
    return ok({"posts": [{
        "id": r["id"], "content": r["content"], "kind": r["kind"], "anon": bool(r["anon"]),
        "anon_name": r["anon_name"], "author_id": r["author_id"], "author": r["real_name"],
        "username": r["username"], "created_at": r["created_at"], "deleted": r["deleted"],
    } for r in rows]})


@route("PATCH", "/api/admin/posts/{pid}", manage=True)
async def admin_post_update(req, pid):
    data = req.json()
    fields, args = [], []
    if "deleted" in data:
        fields += ["deleted = ?", "deleted_by = ?"]
        args += [1 if data["deleted"] else 0, req.user["id"] if data["deleted"] else 0]
    if "content" in data:
        fields.append("content = ?")
        args.append(str(data["content"])[:500])
    if fields:
        args.append(int(pid))
        db.execute("UPDATE posts SET %s WHERE id = ?" % ", ".join(fields), tuple(args))
        db.audit(req.user["id"], "admin.post.update", "#%s %s" % (pid, dumps(data).decode()), req.client_ip)
    return ok({"updated": True})


@route("POST", "/api/admin/announce", staff=True)
async def admin_announce(req):
    data = req.json()
    content = (data.get("content") or "").strip()[:500]
    if not content:
        raise HttpError(400, "内容不能为空")
    if is_super(req.user):
        announce_class = int(data.get("class_id") or 0)
        if announce_class and not db.query_one("SELECT id FROM classes WHERE id = ?", (announce_class,)):
            raise HttpError(400, "班级不存在")
    else:
        announce_class = class_id_of(req.user)
    post_id = db.execute(
        "INSERT INTO posts(author_id, anon, anon_name, content, kind, created_at, class_id) VALUES(?,?,?,?,?,?,?)",
        (req.user["id"], 0, req.user["name"], content, "announce", now(), announce_class))
    import asyncio
    import ws
    asyncio.ensure_future(ws.broadcast({"t": "announce", "content": content, "id": post_id,
                                        "created_at": now(), "class_id": announce_class,
                                        "author": req.user["name"]}))
    db.audit(req.user["id"], "admin.announce", content[:80], req.client_ip)
    return ok({"id": post_id, "class_id": announce_class})


@route("GET", "/api/admin/logs", staff=True)
async def admin_logs(req):
    scope, cid = class_scope(req)
    log_where, log_args = scope_where(scope, cid, "class_id", "u.")
    rows = db.query(
        "SELECT a.*, u.name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id "
        "WHERE 1 = 1%s ORDER BY a.id DESC LIMIT 300" % log_where, tuple(log_args))
    return ok({"logs": [{
        "id": r["id"], "user_id": r["user_id"], "name": r["name"] or "系统", "action": r["action"],
        "detail": r["detail"], "ip": mask_ip(r["ip"]), "created_at": r["created_at"],
    } for r in rows]})


@route("PATCH", "/api/admin/settings", admin=True)
async def admin_settings(req):
    data = req.json()
    allowed = {"site_name", "site_subtitle", "chat_enabled", "games_enabled", "signin_enabled",
               "register_open", "checkin_code_required", "version_h5", "net_cap_mbps"}
    changed = {}
    for key, value in data.items():
        if key in allowed:
            db.set_setting(key, value)
            changed[key] = value
    db.audit(req.user["id"], "admin.settings", dumps(changed).decode(), req.client_ip)
    return ok({"settings": db.get_settings()})


@route("PATCH", "/api/admin/sign-settings", staff=True)
async def admin_sign_settings(req):
    data = req.json()
    changed = {}
    if "sign_times" in data:
        values = []
        for piece in str(data["sign_times"]).split(","):
            piece = piece.strip()
            if not piece:
                continue
            if parse_hhmm(piece) is None:
                raise HttpError(400, "时间点格式应为 HH:MM")
            if len(piece) == 4:
                piece = "0" + piece
            if piece not in values:
                values.append(piece)
        if not values:
            raise HttpError(400, "至少要保留一个签到时间点")
        db.set_setting("sign_times", ",".join(sorted(values))[:200])
        changed["sign_times"] = db.setting("sign_times")
    if "default_grace" in data:
        try:
            grace = int(data["default_grace"] or 0)
        except (TypeError, ValueError):
            raise HttpError(400, "补签时长应为分钟数")
        grace = max(0, min(grace, 24 * 60))
        db.set_setting("default_grace", str(grace))
        changed["default_grace"] = grace
    if "early_minutes" in data:
        try:
            early = int(data["early_minutes"] if data["early_minutes"] not in (None, "") else 0)
        except (TypeError, ValueError):
            raise HttpError(400, "提前开放时长应为分钟数")
        early = max(0, min(early, 24 * 60))
        db.set_setting("early_minutes", str(early))
        changed["early_minutes"] = early
    if "topics_enabled" in data and req.user.get("role") == "admin":
        db.set_setting("topics_enabled", "1" if data["topics_enabled"] else "0")
        changed["topics_enabled"] = db.setting("topics_enabled")
    db.audit(req.user["id"], "admin.sign_settings", dumps(changed).decode(), req.client_ip)
    return ok({"settings": db.get_settings(), "changed": changed})


@route("POST", "/api/admin/sql", admin=True)
async def admin_sql(req):
    data = req.json()
    sql = (data.get("sql") or "").strip()
    if not sql:
        raise HttpError(400, "SQL 不能为空")
    readonly = sql.lower().startswith(("select", "pragma", "explain"))
    if not readonly and not data.get("confirm"):
        raise HttpError(400, "写操作需要二次确认")
    if ";" in sql.strip().rstrip(";"):
        raise HttpError(400, "一次只能执行一条语句")
    started = time.time()
    try:
        if readonly:
            rows = db.query(sql)
            result = {"rows": rows[:200], "count": len(rows)}
        else:
            result = {"lastrowid": db.execute(sql)}
    except Exception as exc:  # noqa: BLE001
        raise HttpError(400, "SQL 执行失败: %s" % exc)
    db.audit(req.user["id"], "admin.sql", sql[:300], req.client_ip)
    result["ms"] = round((time.time() - started) * 1000, 2)
    return ok(result)


@route("GET", "/api/admin/backup", admin=True)
async def admin_backup(req):
    with open(db.DB_PATH, "rb") as fh:
        body = fh.read()
    name = "checkin-backup-%s.db" % time.strftime("%Y%m%d-%H%M%S")
    return Response(200, body, "application/octet-stream", {
        "Content-Disposition": 'attachment; filename="%s"' % name})


@route("POST", "/api/admin/upload", admin=True)
async def admin_upload(req):
    name = os.path.basename(req.q("name") or "upload.bin")
    kind = req.q("kind", "h5")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = "%s-%s" % (time.strftime("%Y%m%d%H%M%S"), name)
    path = os.path.join(UPLOAD_DIR, filename)
    with open(path, "wb") as fh:
        fh.write(req.body)
    digest = hashlib.sha256(req.body).hexdigest()
    version_code = int(req.q("version_code") or 0) or (int(db.setting("version_h5") or 1) + 1)
    db.execute("UPDATE app_versions SET active = 0 WHERE platform = ?", (kind,))
    vid = db.execute(
        "INSERT INTO app_versions(platform, version_code, version_name, file, size, sha256, notes, active, created_at) "
        "VALUES(?,?,?,?,?,?,?,1,?)",
        (kind, version_code, req.q("version_name") or time.strftime("%Y.%m.%d"),
         filename, len(req.body), digest, req.q("notes") or "", now()))
    if kind == "h5":
        db.set_setting("version_h5", version_code)
    db.audit(req.user["id"], "admin.upload", "%s %s (%s)" % (kind, filename, human_size(len(req.body))), req.client_ip)
    return ok({"id": vid, "file": filename, "sha256": digest, "size": len(req.body), "version_code": version_code})


@route("GET", "/api/admin/versions", admin=True)
async def admin_versions(req):
    return ok({"versions": db.query("SELECT * FROM app_versions ORDER BY id DESC LIMIT 50")})
