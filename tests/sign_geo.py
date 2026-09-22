#!/usr/bin/env python3
"""定位签到 / 签到时间点 + 补签窗口 回归测试（stdlib only）。

usage: python sign_geo.py [base_url] [staff:pass] [member:pass]
口令也可用环境变量 CHECKIN_STAFF / CHECKIN_MEMBER 传（user:pass）
"""

import json
import os
import sys
import time
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
STAFF = _cred("CHECKIN_STAFF", sys.argv[2] if len(sys.argv) > 2 else "")
MEMBER = _cred("CHECKIN_MEMBER", sys.argv[3] if len(sys.argv) > 3 else "")
CAMPUS = (31.2304, 121.4737)
FAR = (31.3000, 121.5500)
PASSED, FAILED = [], []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print("%s  %-40s %s" % ("PASS" if cond else "FAIL", name, str(detail)[:120]), flush=True)


def http(method, path, body=None, token=None, query=""):
    url = BASE + path + (("?" + query) if query else "")
    url = urllib.parse.quote(url, safe=":/?&=%,.+-")
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
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
        raise SystemExit("login failed: %s %s" % (status, data))
    return data["token"]


tok_staff = login(STAFF[0], STAFF[1])
tok_member = login(MEMBER[0], MEMBER[1])
staff_role = (http("GET", "/api/me", token=tok_staff)[1].get("user") or {}).get("role")
# 资委/学委也有删除场次的权限（用户 2026-09-20 明确要求），只有普通成员不能删
can_delete = staff_role in ("admin", "class_admin", "committee", "study")

# ---- 1. 定位签到: 超出半径应被拒绝
started = int(time.time()) - 60
status, data = http("POST", "/api/admin/sign-sessions", {
    "title": "定位签到回归", "sign_at": started, "grace_minutes": 600,
    "require_location": True, "lat": CAMPUS[0], "lng": CAMPUS[1], "radius": 200, "place": "教学楼",
}, token=tok_staff)
sid = data.get("id")
check("staff creates located session", status == 200 and bool(sid), (status, str(data)[:110]))
if sid:
    check("late window = sign_at + grace", data.get("ends_at") == data.get("sign_at", started) + 600 * 60,
          (data.get("sign_at"), data.get("ends_at")))
    check("session already open", data.get("starts_at", 0) <= int(time.time()), data.get("starts_at"))

    status, data = http("POST", "/api/sign/in", {"session_id": sid, "lat": FAR[0], "lng": FAR[1], "device": "test"},
                        token=tok_member)
    check("far away rejected", status == 400 and "范围" in str(data.get("error")), (status, str(data)[:90]))

    status, data = http("POST", "/api/sign/in", {"session_id": sid, "device": "test"}, token=tok_member)
    check("no coords rejected", status == 400, (status, str(data)[:90]))

    status, data = http("POST", "/api/sign/in", {"session_id": sid, "lat": CAMPUS[0], "lng": CAMPUS[1],
                                                 "device": "test"}, token=tok_member)
    check("in-range check-in accepted", status == 200 and data.get("checked_in") is True,
          (status, str(data)[:110]))
    check("late mark because past sign_at", data.get("late") is True, data.get("late"))
    check("distance recorded", int((data.get("session") or {}).get("distance") or -1) <= 200,
          (data.get("session") or {}).get("distance"))

    status, data = http("POST", "/api/sign/in", {"session_id": sid, "lat": CAMPUS[0], "lng": CAMPUS[1]},
                        token=tok_member)
    check("duplicate check-in blocked", status == 409, (status, str(data)[:80]))

    status, data = http("GET", "/api/admin/records", token=tok_staff, query="session_id=%d" % sid)
    records = data.get("records") or []
    check("staff sees attendance row", status == 200 and len(records) >= 1,
          (status, len(records)))
    status, data = http("GET", "/api/sign/session/%d" % sid, token=tok_staff)
    check("staff sees place", (data.get("session") or {}).get("place") == "教学楼",
          (data.get("session") or {}).get("place"))

    status, data = http("POST", "/api/sign/leave", {"session_id": sid}, token=tok_member)
    check("member can undo check-in", status == 200, status)
    status, _ = http("DELETE", "/api/admin/sign-sessions/%d" % sid, token=tok_staff)
    check("%s session delete right" % (staff_role or "?"), status == (200 if can_delete else 403),
          (staff_role, status))

# ---- 2. 普通签到 (无定位, 未到时间, 应记为 present)
status, data = http("POST", "/api/admin/sign-sessions", {
    "title": "普通签到回归", "sign_at": int(time.time()) + 600, "grace_minutes": 900,
}, token=tok_staff)
sid2 = data.get("id")
check("staff creates plain session", status == 200 and bool(sid2), (status, str(data)[:110]))
if sid2:
    status, data = http("POST", "/api/sign/in", {"session_id": sid2, "device": "test"}, token=tok_member)
    check("plain check-in accepted", status == 200 and data.get("checked_in") is True, (status, str(data)[:90]))
    check("before sign_at is present", data.get("late") is False, data.get("late"))
    status, data = http("GET", "/api/sign/sessions", token=tok_member)
    sessions = data.get("sessions") or []
    check("session visible to member", any(s.get("id") == sid2 for s in sessions), len(sessions))
    http("POST", "/api/sign/leave", {"session_id": sid2}, token=tok_member)
    if can_delete:
        http("DELETE", "/api/admin/sign-sessions/%d" % sid2, token=tok_staff)

# ---- 3. 过期签到应被拒绝
status, data = http("POST", "/api/admin/sign-sessions", {
    "title": "过期签到回归", "sign_at": int(time.time()) - 7200, "grace_minutes": 30,
}, token=tok_staff)
sid3 = data.get("id")
if sid3:
    status, data = http("POST", "/api/sign/in", {"session_id": sid3, "device": "test"}, token=tok_member)
    check("expired session blocked", status == 400, (status, str(data)[:90]))
    if can_delete:
        http("DELETE", "/api/admin/sign-sessions/%d" % sid3, token=tok_staff)

print("\n%d passed, %d failed" % (len(PASSED), len(FAILED)))
if FAILED:
    print("failed: " + ", ".join(FAILED))
sys.exit(1 if FAILED else 0)
