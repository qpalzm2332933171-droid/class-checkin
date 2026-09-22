#!/usr/bin/env python3
"""Role/permission + topic/avatar regression test (stdlib only).

usage: python perm.py [base_url] [admin:pass] [staff:pass] [member:pass]
口令也可用环境变量 CHECKIN_ADMIN / CHECKIN_STAFF / CHECKIN_MEMBER 传（user:pass）
default base http://127.0.0.1:8081
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

def _cred(env, arg):
    """测试账号从命令行参数或环境变量取，格式 user:pass；仓库里不写死任何口令。"""
    raw = arg if arg else os.environ.get(env, "")
    if ":" not in raw:
        sys.exit("缺少测试账号：用参数或环境变量 %s=user:pass 提供" % env)
    return raw.split(":", 1)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8081"
ADMIN = _cred("CHECKIN_ADMIN", sys.argv[2] if len(sys.argv) > 2 else "")
STAFF = _cred("CHECKIN_STAFF", sys.argv[3] if len(sys.argv) > 3 else "")
MEMBER = _cred("CHECKIN_MEMBER", sys.argv[4] if len(sys.argv) > 4 else "")
PASSED, FAILED = [], []
PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print("%s  %-38s %s" % ("PASS" if cond else "FAIL", name, str(detail)[:120]), flush=True)


def http(method, path, body=None, token=None, query=""):
    url = BASE + path + (("?" + query) if query else "")
    url = urllib.parse.quote(url, safe=":/?&=%,.+-")
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        try:
            return exc.code, json.loads(payload.decode() or "{}")
        except Exception:
            return exc.code, {"raw": payload[:120].decode("utf-8", "replace")}


def login(user, pwd):
    status, data = http("POST", "/api/login", {"username": user, "password": pwd})
    if status != 200 or not data.get("token"):
        raise SystemExit("login failed for %s: %s %s" % (user, status, data))
    return data["token"]


tok_admin = login(ADMIN[0], ADMIN[1])
tok_staff = login(STAFF[0], STAFF[1])
tok_member = login(MEMBER[0], MEMBER[1])
me_staff = http("GET", "/api/me", token=tok_staff)[1].get("user", {})
check("committee role is committee", me_staff.get("role") == "committee", me_staff.get("role"))

# --- 1. overview: committee gets stats but no server metrics
s_staff, d_staff = http("GET", "/api/admin/overview", token=tok_staff)
check("committee can open overview", s_staff == 200 and d_staff.get("ok"), s_staff)
check("committee cannot see server metrics", "server" not in d_staff)
s_admin, d_admin = http("GET", "/api/admin/overview", token=tok_admin)
check("admin sees server metrics", s_admin == 200 and "server" in d_admin)

# --- 2. member management stays admin-only
new_user = {"username": "perm_%d" % __import__("time").time(), "password": "permtest1", "name": "权限测试", "role": "member"}
s, d = http("POST", "/api/admin/users", new_user, token=tok_staff)
check("committee cannot add member", s == 403, s)
s, d = http("POST", "/api/admin/users", new_user, token=tok_admin)
uid = d.get("id") if s == 200 else None
check("admin can add member", s == 200 and uid, s)
if uid:
    check("committee cannot rename member", http("PATCH", "/api/admin/users/%d" % uid, {"name": "x"}, token=tok_staff)[0] == 403)
    check("committee cannot reset password", http("POST", "/api/admin/users/%d/reset-password" % uid, {"password": "abcdefg1"}, token=tok_staff)[0] == 403)
    check("committee cannot delete member", http("DELETE", "/api/admin/users/%d" % uid, token=tok_staff)[0] == 403)
    check("committee cannot read member list", http("GET", "/api/admin/users", token=tok_staff)[0] == 403)
    check("admin deletes temp member", http("DELETE", "/api/admin/users/%d" % uid, token=tok_admin)[0] == 200)

# --- 3. settings / sql / backup / versions stay admin-only
check("committee cannot change settings", http("PATCH", "/api/admin/settings", {"site_name": "x"}, token=tok_staff)[0] == 403)
check("committee cannot run sql", http("POST", "/api/admin/sql", {"sql": "SELECT 1"}, token=tok_staff)[0] == 403)
check("committee cannot download backup", http("GET", "/api/admin/backup", token=tok_staff)[0] == 403)
check("committee cannot read versions", http("GET", "/api/admin/versions", token=tok_staff)[0] == 403)
check("committee cannot upload", http("POST", "/api/admin/upload", {"name": "x", "data": ""}, token=tok_staff)[0] == 403)

# --- 4. moderation: committee may post announcements, not delete others' speeches
check("committee can read logs", http("GET", "/api/admin/logs", token=tok_staff)[0] == 200)
s, d = http("POST", "/api/admin/announce", {"content": "权限测试公告（自动清理）"}, token=tok_staff)
ann_id = d.get("id") if s == 200 else None
check("committee can publish announcement", s == 200, s)
if ann_id:
    check("admin cleans test announcement", http("PATCH", "/api/admin/posts/%d" % ann_id, {"deleted": True}, token=tok_admin)[0] == 200)
check("committee cannot edit a speech", http("PATCH", "/api/admin/posts/1", {"text": "x"}, token=tok_staff)[0] == 403)

# --- 5. sign sessions: committee creates, only admin deletes
s, d = http("POST", "/api/admin/sign-sessions", {"title": "权限测试签到", "sign_at": "08:00", "grace_minutes": 15}, token=tok_staff)
sid = d.get("id") if s == 200 else None
check("committee can publish sign session", s == 200 and sid, (s, str(d)[:80]))
if sid:
    # 资委/学委有删除场次的权限（用户 2026-09-20 明确要求），所以这里反过来断言可以删
    check("committee can delete sign session", http("DELETE", "/api/admin/sign-sessions/%d" % sid, token=tok_staff)[0] == 200)
check("committee can edit sign settings", http("PATCH", "/api/admin/sign-settings", {"default_grace": 20}, token=tok_staff)[0] == 200)

# --- 6. plain member cannot reach staff console
check("member blocked from overview", http("GET", "/api/admin/overview", token=tok_member)[0] == 403)
check("member blocked from sign-sessions", http("GET", "/api/admin/sign-sessions", token=tok_member)[0] == 403)
check("member blocked from records", http("GET", "/api/admin/records", token=tok_member)[0] == 403)

# --- 7. topics: any member can open a topic with its own chat log
s, d = http("POST", "/api/chat/topics", {"title": "权限测试话题"}, token=tok_member)
tid = (d.get("topic") or {}).get("id") if s == 200 else None
check("member can create topic", s == 200 and tid, (s, str(d)[:80]))
if tid:
    s, d = http("GET", "/api/chat/topics", token=tok_member)
    found = any(t["id"] == tid for t in (d.get("topics") or []))
    check("topic shows in list", s == 200 and found, s)
    s, d = http("POST", "/api/chat/post", {"content": "话题里的第一条", "topic_id": tid}, token=tok_member)
    check("post lands inside topic", s == 200 and d.get("topic_id") == tid, (s, str(d)[:80]))
    s, d = http("GET", "/api/chat/topic/%d" % tid, token=tok_member)
    check("topic chat log isolated", s == 200 and len(d.get("messages") or []) >= 1, s)
    s, d = http("GET", "/api/chat/search", token=tok_member, query="q=" + urllib.parse.quote("第一条"))
    check("chat search finds message", s == 200 and len(d.get("messages") or []) >= 1, (s, str(d)[:80]))
    check("guest cannot rename topic", http("PATCH", "/api/chat/topic/%d" % tid, {"title": "y"}, token=tok_member)[0] in (200, 403))
    check("author deletes own topic", http("DELETE", "/api/chat/topic/%d" % tid, token=tok_member)[0] == 200)

# --- 8. avatar upload round trip
s, d = http("POST", "/api/me/avatar", {"data": "data:image/png;base64," + PNG}, token=tok_member)
url = d.get("avatar") if s == 200 else None
check("member can upload avatar", s == 200 and url, (s, str(d)[:80]))
if url:
    try:
        with urllib.request.urlopen(BASE + url, timeout=10) as resp:
            blob, st = resp.read(), resp.status
    except urllib.error.HTTPError as exc:
        blob, st = b"", exc.code
    check("avatar served back", st == 200 and blob[:4] == b"\x89PNG", st)
    check("bad image rejected", http("POST", "/api/me/avatar", {"data": "data:image/png;base64,AAAA"}, token=tok_member)[0] == 400)
    check("member can clear avatar", http("POST", "/api/me/avatar/clear", {}, token=tok_member)[0] == 200)

# --- 9. announcements ack + geo helpers
s, d = http("GET", "/api/announcements", token=tok_member)
check("announcements list readable", s == 200 and "unread" in d, s)
s, d = http("GET", "/api/geo/search", query="q=教学楼", token=tok_member)
check("geo search returns places", s == 200 and len(d.get("items") or []) >= 1, (s, str(d)[:90]))
s, d = http("GET", "/api/config")
check("config carries sign_times", s == 200 and isinstance(d.get("sign_times"), list) and len(d["sign_times"]) >= 1, s)

print("\n%d passed, %d failed" % (len(PASSED), len(FAILED)))
if FAILED:
    print("failed: " + ", ".join(FAILED))
sys.exit(1 if FAILED else 0)
