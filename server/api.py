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
        "topics_enabled": settings.get("topics_enabled", "1") == "1",
        "announce_popup": settings.get("announce_popup", "1") == "1",
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


@route("POST", "/api/me")
async def update_me(req):
    data = req.json()
    name = (data.get("name") or "").strip()[:20]
    color = (data.get("color") or "").strip()[:16]
    if name:
        db.execute("UPDATE users SET name = ? WHERE id = ?", (name, req.user["id"]))
    if color is not None:
        db.execute("UPDATE users SET color = ? WHERE id = ?", (color, req.user["id"]))
    return ok({"updated": True})


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
    total = db.query_one("SELECT COUNT(*) AS c FROM users WHERE banned = 0")["c"]
    present = db.query_one(
        "SELECT COUNT(*) AS c FROM records WHERE session_id = ? AND status IN ('present','late')", (row["id"],))["c"]
    mine = None
    if user_id:
        rec = db.query_one("SELECT * FROM records WHERE session_id = ? AND user_id = ?", (row["id"], user_id))
        if rec:
            mine = {"status": rec["status"], "created_at": rec["created_at"], "note": rec["note"]}
    sign_at = row.get("sign_at") or row["late_after"] or row["starts_at"]
    ends_at = row["ends_at"]
    return {
        "id": row["id"], "title": row["title"], "status": row["status"],
        "starts_at": row["starts_at"], "ends_at": ends_at, "late_after": row["late_after"],
        "sign_at": sign_at, "grace_minutes": row.get("grace_minutes") or 0,
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
    rows = db.query("SELECT * FROM sign_sessions ORDER BY starts_at DESC LIMIT ?", (limit,))
    return ok({"sessions": [session_view(r, req.user["id"]) for r in rows]})


@route("GET", "/api/sign/active")
async def sign_active(req):
    """同时可以开多个签到，这里把它们全部返回，前端用标签切换查看。"""
    ts = now()
    rows = db.query(
        "SELECT * FROM sign_sessions WHERE status = 'open' AND (ends_at = 0 OR ends_at > ?) "
        "ORDER BY starts_at DESC, id DESC", (ts,))
    if not rows:
        row = db.query_one("SELECT * FROM sign_sessions ORDER BY starts_at DESC, id DESC LIMIT 1")
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
    if row["status"] != "open":
        raise HttpError(400, "该场次已结束")
    ts = now()
    if row["ends_at"] and ts > row["ends_at"]:
        raise HttpError(400, "签到已截止")
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
    if not row["allow_leave"]:
        raise HttpError(400, "该场次不允许请假")
    note = (data.get("note") or "").strip()[:200] or "请假"
    ts = now()
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
    data = session_view(row, req.user["id"])
    if req.user.get("role") == "admin":
        data["code"] = row["code"]
        records = db.query(
            "SELECT r.*, u.name, u.username FROM records r JOIN users u ON u.id = r.user_id "
            "WHERE r.session_id = ? ORDER BY r.created_at ASC", (row["id"],))
        data["records"] = [{
            "id": r["id"], "user_id": r["user_id"], "name": r["name"], "username": r["username"],
            "status": r["status"], "note": r["note"], "created_at": r["created_at"],
            "ip": mask_ip(r["ip"]), "device": r["device"], "by_admin": r["by_admin"],
        } for r in records]
        done = {r["user_id"] for r in records if r["status"] in ("present", "late")}
        data["missing"] = [{"id": u["id"], "name": u["name"], "username": u["username"]}
                           for u in member_list() if u["id"] not in done and not u["banned"]]
    return ok({"session": data})


@route("GET", "/api/stats/class")
async def class_stats(req):
    users = member_list()
    sessions = db.query("SELECT * FROM sign_sessions ORDER BY starts_at DESC LIMIT 50")
    total = len(sessions) or 1
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
    key = ("q", query, round(lat, 2), round(lng, 2))
    items = _geo_cache_get(key)
    if items is None:
        try:
            items = await asyncio.to_thread(_photon_search, query, lat, lng)
        except Exception:  # noqa: BLE001
            _geo_cache_put(key, [], 120)
            return ok({"items": [], "offline": True})
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
        if is_admin:
            item["author_id"] = r["author_id"]
            item["author_name"] = r["real_name"]
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
    if row["author_id"] != req.user["id"] and req.user.get("role") != "admin":
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
    if row["author_id"] != req.user["id"] and req.user.get("role") != "admin":
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
    rows = db.query(
        "SELECT p.*, u.name AS author_name, u.avatar FROM posts p LEFT JOIN users u ON u.id = p.author_id "
        "WHERE p.kind = 'announce' AND p.deleted = 0 ORDER BY p.id DESC LIMIT 30")
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
    """单机游戏领积分：2048 每合成一个 2048 记 1 分；扫雷按难度 0/1/2/3 分。"""
    data = req.json()
    kind = (data.get("kind") or "").strip()
    difficulty = (data.get("difficulty") or "").strip()
    if kind == "2048":
        points, label = 1, "2048 合成"
    elif kind == "mine":
        if difficulty not in SOLO_MINE_POINTS:
            raise HttpError(400, "未知难度")
        points, label = SOLO_MINE_POINTS[difficulty], "扫雷 " + difficulty
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


@route("POST", "/api/admin/changelog", admin=True)
async def changelog_create(req):
    data = req.json()
    title = (data.get("title") or "").strip()[:80]
    body = (data.get("body") or "").strip()[:4000]
    version = (data.get("version") or "").strip()[:24] or ("v" + str(int(db.setting("version_h5") or 1)))
    if not title:
        raise HttpError(400, "标题不能为空")
    ts = now()
    cid = db.execute("INSERT INTO changelogs(version, title, body, created_by, created_at) VALUES(?,?,?,?,?)",
                     (version, title, body, req.user["id"], ts))
    if data.get("announce", True):
        text = ("【更新 %s】%s\n%s" % (version, title, body)).strip()
        post_id = db.execute(
            "INSERT INTO posts(author_id, anon, anon_name, content, kind, created_at) VALUES(?,?,?,?,?,?)",
            (req.user["id"], 0, req.user["name"], text[:500], "announce", ts))
        asyncio.ensure_future(ws.broadcast({"t": "announce", "content": text[:500],
                                            "id": post_id, "created_at": ts}))
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


@route("GET", "/api/admin/overview", staff=True)
async def admin_overview(req):
    import ws
    payload = {
        "online": len({c.uid for c in ws.CONNS if not c.closed}),
        "online_users": sorted({c.user["name"] for c in ws.CONNS if not c.closed}),
        "users": db.query_one("SELECT COUNT(*) AS c FROM users")["c"],
        "members": db.query_one("SELECT COUNT(*) AS c FROM users WHERE role='member'")["c"],
        "sessions": db.query_one("SELECT COUNT(*) AS c FROM sign_sessions")["c"],
        "records": db.query_one("SELECT COUNT(*) AS c FROM records")["c"],
        "posts": db.query_one("SELECT COUNT(*) AS c FROM posts WHERE deleted = 0")["c"],
        "games": db.query_one("SELECT COUNT(*) AS c FROM game_records")["c"],
        "topics": db.query_one("SELECT COUNT(*) AS c FROM topics WHERE deleted = 0")["c"],
        "role": req.user.get("role") or "member",
        "is_admin": req.user.get("role") == "admin",
        "settings": db.get_settings(),
    }
    if req.user.get("role") == "admin":
        payload["server"] = server_stats()
    return ok(payload)


@route("GET", "/api/admin/users", admin=True)
async def admin_users(req):
    out = []
    for u in member_list():
        item = auth.public_user(u, req.user)
        item["username"] = u["username"]
        item["checked"] = db.query_one(
            "SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND status IN ('present','late')", (u["id"],))["c"]
        out.append(item)
    return ok({"users": out})


@route("POST", "/api/admin/users", admin=True)
async def admin_user_create(req):
    data = req.json()
    username = (data.get("username") or "").strip()
    name = (data.get("name") or "").strip() or username
    password = (data.get("password") or "").strip() or db.random_password()
    role = data.get("role") if data.get("role") in ("admin", "committee", "study", "member") else "member"
    if len(username) < 2:
        raise HttpError(400, "用户名至少 2 位")
    if db.query_one("SELECT id FROM users WHERE username = ?", (username,)):
        raise HttpError(409, "用户名已存在")
    password_hash, salt = auth.hash_password(password)
    uid = db.execute(
        "INSERT INTO users(username, name, role, password_hash, salt, color, note, created_at) VALUES(?,?,?,?,?,?,?,?)",
        (username, name, role, password_hash, salt, data.get("color") or "", data.get("note") or "", now()))
    db.audit(req.user["id"], "admin.user.create", "%s(%s)" % (name, username), req.client_ip)
    return ok({"id": uid, "password": password})


@route("PATCH", "/api/admin/users/{uid}", admin=True)
async def admin_user_update(req, uid):
    data = req.json()
    target = db.query_one("SELECT * FROM users WHERE id = ?", (int(uid),))
    if not target:
        raise HttpError(404, "用户不存在")
    fields, args = [], []
    for key in ("name", "note", "color"):
        if key in data:
            fields.append("%s = ?" % key)
            args.append(str(data[key])[:200])
    if "role" in data:
        if data["role"] not in ("admin", "committee", "study", "member"):
            raise HttpError(400, "未知的身份类型")
        fields.append("role = ?")
        args.append(data["role"])
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


@route("POST", "/api/admin/users/{uid}/reset-password", admin=True)
async def admin_user_reset(req, uid):
    target = db.query_one("SELECT * FROM users WHERE id = ?", (int(uid),))
    if not target:
        raise HttpError(404, "用户不存在")
    data = req.json()
    password = (data.get("password") or "").strip() or db.random_password()
    password_hash, salt = auth.hash_password(password)
    db.execute("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", (password_hash, salt, target["id"]))
    auth.drop_user_sessions(target["id"])
    db.audit(req.user["id"], "admin.user.reset", target["username"], req.client_ip)
    return ok({"password": password})


@route("DELETE", "/api/admin/users/{uid}", admin=True)
async def admin_user_delete(req, uid):
    target = db.query_one("SELECT * FROM users WHERE id = ?", (int(uid),))
    if not target:
        raise HttpError(404, "用户不存在")
    if target["id"] == req.user["id"]:
        raise HttpError(400, "不能删除自己")
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
    rows = db.query("SELECT * FROM sign_sessions ORDER BY starts_at DESC LIMIT 200")
    out = []
    for r in rows:
        item = session_view(r)
        item["code"] = r["code"]
        item["created_by"] = r["created_by"]
        out.append(item)
    return ok({"sessions": out})


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
        "allow_leave, require_note, note, sign_at, grace_minutes, require_location, lat, lng, radius, place) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (title, code, "open", req.user["id"], ts, ts,
         sign_at + grace * 60,
         sign_at,
         0 if data.get("allow_leave") is False else 1,
         1 if data.get("require_note") else 0,
         (data.get("note") or "")[:200],
         sign_at, grace, require_location, lat, lng, radius,
         (data.get("place") or "")[:80]))
    db.audit(req.user["id"], "admin.session.create", "#%d %s" % (sid, title), req.client_ip)
    asyncio.ensure_future(ws.broadcast({"t": "sign.new", "id": sid, "title": title,
                                        "sign_at": sign_at, "require_location": require_location}))
    return ok({"id": sid, "code": code, "sign_at": sign_at, "ends_at": sign_at + grace * 60})


@route("PATCH", "/api/admin/sign-sessions/{sid}", staff=True)
async def admin_sign_update(req, sid):
    data = req.json()
    session_id = int(sid)
    if not db.query_one("SELECT id FROM sign_sessions WHERE id = ?", (session_id,)):
        raise HttpError(404, "场次不存在")
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


@route("DELETE", "/api/admin/sign-sessions/{sid}", admin=True)
async def admin_sign_delete(req, sid):
    db.execute("DELETE FROM sign_sessions WHERE id = ?", (int(sid),))
    db.execute("DELETE FROM records WHERE session_id = ?", (int(sid),))
    db.audit(req.user["id"], "admin.session.delete", "#%s" % sid, req.client_ip)
    asyncio.ensure_future(ws.broadcast({"t": "sign.update", "id": int(sid)}))
    return ok({"deleted": True})


@route("GET", "/api/admin/records", staff=True)
async def admin_records(req):
    sid = req.int_param("session_id", 0)
    if sid:
        rows = db.query(
            "SELECT r.*, u.name, u.username, u.avatar FROM records r JOIN users u ON u.id = r.user_id "
            "WHERE r.session_id = ? ORDER BY r.created_at", (sid,))
    else:
        rows = db.query(
            "SELECT r.*, u.name, u.username, u.avatar FROM records r JOIN users u ON u.id = r.user_id "
            "ORDER BY r.id DESC LIMIT 300")
    return ok({"records": [{
        "id": r["id"], "session_id": r["session_id"], "user_id": r["user_id"], "name": r["name"],
        "username": r["username"], "status": r["status"], "note": r["note"], "created_at": r["created_at"],
        "avatar": r["avatar"] or "",
        "ip": mask_ip(r["ip"]), "device": r["device"], "by_admin": r["by_admin"],
    } for r in rows]})


@route("POST", "/api/admin/records", staff=True)
async def admin_record_add(req):
    data = req.json()
    session_id = int(data.get("session_id") or 0)
    user_id = int(data.get("user_id") or 0)
    status = data.get("status") or "present"
    if status not in ("present", "late", "leave", "absent"):
        raise HttpError(400, "状态不合法")
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


@route("PATCH", "/api/admin/posts/{pid}", admin=True)
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
    post_id = db.execute(
        "INSERT INTO posts(author_id, anon, anon_name, content, kind, created_at) VALUES(?,?,?,?,?,?)",
        (req.user["id"], 0, req.user["name"], content, "announce", now()))
    import asyncio
    import ws
    asyncio.ensure_future(ws.broadcast({"t": "announce", "content": content, "id": post_id, "created_at": now()}))
    db.audit(req.user["id"], "admin.announce", content[:80], req.client_ip)
    return ok({"id": post_id})


@route("GET", "/api/admin/logs", staff=True)
async def admin_logs(req):
    rows = db.query(
        "SELECT a.*, u.name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300")
    return ok({"logs": [{
        "id": r["id"], "user_id": r["user_id"], "name": r["name"] or "系统", "action": r["action"],
        "detail": r["detail"], "ip": mask_ip(r["ip"]), "created_at": r["created_at"],
    } for r in rows]})


@route("PATCH", "/api/admin/settings", admin=True)
async def admin_settings(req):
    data = req.json()
    allowed = {"site_name", "site_subtitle", "chat_enabled", "games_enabled", "signin_enabled",
               "register_open", "checkin_code_required", "version_h5"}
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
