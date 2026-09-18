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


def public_user(row, viewer=None):
    """Shape a user row for the client. Admins see more."""
    if not row:
        return None
    is_admin = bool(viewer and viewer.get("role") == "admin")
    is_self = bool(viewer and viewer.get("id") == row.get("id"))
    data = {
        "id": row["id"],
        "username": row["username"],
        "name": row["name"],
        "role": row["role"],
        "avatar": row.get("avatar") or "",
        "color": row.get("color") or "",
        "muted": row.get("muted") or 0,
        "created_at": row.get("created_at") or 0,
    }
    if is_admin or is_self:
        data["banned"] = row.get("banned") or 0
        data["note"] = row.get("note") or ""
        data["last_login"] = row.get("last_login") or 0
    if is_admin:
        data["username"] = row["username"]
    return data
