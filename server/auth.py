"""Passwords, sessions and access checks."""

import hashlib
import secrets

from db import execute, query_one
from util import now

PBKDF2_ROUNDS = 120_000
SESSION_DAYS = 90


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS)
    return digest.hex(), salt


def verify_password(password, password_hash, salt):
    if not password_hash or not salt:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS)
    return secrets.compare_digest(digest.hex(), password_hash)


def create_session(user_id, ip="", ua=""):
    token = secrets.token_urlsafe(32)
    ts = now()
    execute("INSERT INTO sessions(token, user_id, created_at, expires_at, ip, ua) VALUES(?,?,?,?,?,?)",
            (token, user_id, ts, ts + SESSION_DAYS * 86400, ip[:64], ua[:300]))
    return token


def user_by_token(token):
    if not token:
        return None
    row = query_one(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
        (token, now()))
    if not row or row.get("banned"):
        return None
    return row


def drop_session(token):
    execute("DELETE FROM sessions WHERE token = ?", (token,))


def drop_user_sessions(user_id):
    execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def class_name_of(cid):
    """班级名。0 = 未指定班级，返回空串，前端会自己兜底。"""
    cid = int(cid or 0)
    if not cid:
        return ""
    row = query_one("SELECT name FROM classes WHERE id = ?", (cid,))
    return row["name"] if row else ""


def public_user(row, viewer=None):
    """Shape a user row for the client. Admins see more."""
    if not row:
        return None
    viewer_role = (viewer or {}).get("role") or ""
    is_admin = viewer_role == "admin"
    is_self = bool(viewer and viewer.get("id") == row.get("id"))
    # 班级管理员管本班成员，得看得见封禁/备注这些管理字段
    same_class = int((viewer or {}).get("class_id") or 0) == int(row.get("class_id") or 0)
    is_class_admin = viewer_role == "class_admin" and same_class and int(row.get("class_id") or 0) != 0
    data = {
        "id": row["id"],
        "username": row["username"],
        "name": row["name"],
        "role": row["role"],
        "avatar": row.get("avatar") or "",
        "color": row.get("color") or "",
        "muted": row.get("muted") or 0,
        "created_at": row.get("created_at") or 0,
        "class_id": int(row.get("class_id") or 0),
        "class_name": class_name_of(row.get("class_id")),
        "bio": row.get("bio") or "",
    }
    if is_admin or is_class_admin or is_self:
        data["banned"] = row.get("banned") or 0
        data["note"] = row.get("note") or ""
        data["last_login"] = row.get("last_login") or 0
    if is_admin or is_class_admin:
        data["username"] = row["username"]
    return data
