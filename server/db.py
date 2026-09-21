"""SQLite storage layer (stdlib sqlite3)."""

import os
import sqlite3
import secrets
import string
import threading

from util import log, now

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("CHECKIN_DATA") or os.path.join(BASE_DIR, "data")
DB_PATH = os.environ.get("CHECKIN_DB") or os.path.join(DATA_DIR, "app.db")

_lock = threading.RLock()
_conn = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  class_id INTEGER NOT NULL DEFAULT 0,
  bio TEXT NOT NULL DEFAULT '',
  banned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  last_login INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT DEFAULT '',
  ua TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sign_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER NOT NULL DEFAULT 0,
  late_after INTEGER NOT NULL DEFAULT 0,
  allow_leave INTEGER NOT NULL DEFAULT 1,
  require_note INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  sign_at INTEGER NOT NULL DEFAULT 0,
  grace_minutes INTEGER NOT NULL DEFAULT 0,
  require_location INTEGER NOT NULL DEFAULT 0,
  lat REAL NOT NULL DEFAULT 0,
  lng REAL NOT NULL DEFAULT 0,
  radius INTEGER NOT NULL DEFAULT 200,
  place TEXT NOT NULL DEFAULT '',
  class_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'present',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  ip TEXT DEFAULT '',
  ua TEXT DEFAULT '',
  device TEXT DEFAULT '',
  by_admin INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, user_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL,
  anon INTEGER NOT NULL DEFAULT 1,
  anon_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  reply_to INTEGER NOT NULL DEFAULT 0,
  class_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_by INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL,
  anon INTEGER NOT NULL DEFAULT 1,
  anon_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_by INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS announce_reads (
  user_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(post_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS game_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'online',
  players TEXT NOT NULL DEFAULT '[]',
  winners TEXT NOT NULL DEFAULT '[]',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS app_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'android',
  version_code INTEGER NOT NULL DEFAULT 1,
  version_name TEXT NOT NULL DEFAULT '1.0.0',
  file TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS scores (
  user_id INTEGER PRIMARY KEY,
  online INTEGER NOT NULL DEFAULT 0,
  solo INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS changelogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id);
CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_topics_last ON topics(last_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""

DEFAULT_SETTINGS = {
    "site_name": "班级签到",
    "site_subtitle": "25 人小班 · 签到 / 讨论 / 小游戏",
    "chat_enabled": "1",
    "chat_anon_required": "1",
    "games_enabled": "1",
    "signin_enabled": "1",
    "register_open": "0",
    "checkin_code_required": "0",
    "online_window": "60",
    "version_h5": "1",
    # 固定的签到时间点（资委可在设置里改）
    "sign_times": "08:00,10:10,14:30,16:25,19:00",
    "default_grace": "15",
    "topics_enabled": "1",
    "announce_popup": "1",
}


# 旧库升级用：表 -> [(列名, 列定义)]，缺哪个补哪个
MIGRATIONS = {
    "sign_sessions": [
        ("sign_at", "INTEGER NOT NULL DEFAULT 0"),        # 该场次对应的签到时刻
        ("grace_minutes", "INTEGER NOT NULL DEFAULT 0"),  # 签到时刻之后还能补签的分钟数
        ("require_location", "INTEGER NOT NULL DEFAULT 0"),
        ("lat", "REAL NOT NULL DEFAULT 0"),
        ("lng", "REAL NOT NULL DEFAULT 0"),
        ("radius", "INTEGER NOT NULL DEFAULT 200"),
        ("place", "TEXT NOT NULL DEFAULT ''"),
        ("class_id", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "records": [
        ("lat", "REAL NOT NULL DEFAULT 0"),
        ("lng", "REAL NOT NULL DEFAULT 0"),
        ("distance", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "posts": [
        ("topic_id", "INTEGER NOT NULL DEFAULT 0"),
        ("image", "TEXT NOT NULL DEFAULT ''"),
        ("class_id", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "users": [
        ("avatar", "TEXT NOT NULL DEFAULT ''"),
        ("class_id", "INTEGER NOT NULL DEFAULT 0"),
        ("bio", "TEXT NOT NULL DEFAULT ''"),
    ],
    "topics": [
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
    ],
}


# 依赖迁移列的索引，必须在 ALTER TABLE 之后再建
LATE_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts(topic_id, id);
CREATE INDEX IF NOT EXISTS idx_topics_pinned ON topics(pinned DESC, last_at DESC);
CREATE INDEX IF NOT EXISTS idx_announce_reads ON announce_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_users_class ON users(class_id);
CREATE INDEX IF NOT EXISTS idx_sign_class ON sign_sessions(class_id, starts_at DESC);
"""


def migrate():
    con = connect()
    changed = []
    with _lock:
        for table, columns in MIGRATIONS.items():
            existing = {row["name"] for row in con.execute("PRAGMA table_info(%s)" % table).fetchall()}
            for name, ddl in columns:
                if name not in existing:
                    con.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, name, ddl))
                    changed.append("%s.%s" % (table, name))
        con.executescript(LATE_INDEXES)
        con.commit()
    if changed:
        log("db migrated:", ", ".join(changed))


def connect():
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=15)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.execute("PRAGMA foreign_keys=ON")
    return _conn


def init():
    con = connect()
    with _lock:
        con.executescript(SCHEMA)
        con.commit()
        migrate()
        for key, value in DEFAULT_SETTINGS.items():
            con.execute("INSERT OR IGNORE INTO settings(k, v) VALUES(?, ?)", (key, value))
        con.commit()
    log("sqlite ready:", DB_PATH)


def query(sql, args=()):
    with _lock:
        cur = connect().execute(sql, args)
        rows = cur.fetchall()
        cur.close()
    return [dict(r) for r in rows]


def query_one(sql, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql, args=()):
    with _lock:
        con = connect()
        cur = con.execute(sql, args)
        con.commit()
        rowid = cur.lastrowid
        cur.close()
    return rowid


def execute_many(sql, seq):
    with _lock:
        con = connect()
        con.executemany(sql, seq)
        con.commit()


def setting(key, default=""):
    row = query_one("SELECT v FROM settings WHERE k = ?", (key,))
    return row["v"] if row else default


def set_setting(key, value):
    execute("INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            (key, str(value)))


def get_settings():
    return {row["k"]: row["v"] for row in query("SELECT k, v FROM settings")}


def audit(user_id, action, detail="", ip=""):
    execute("INSERT INTO audit_logs(user_id, action, detail, ip, created_at) VALUES(?,?,?,?,?)",
            (user_id, action, str(detail)[:2000], ip, now()))


# ---------------------------------------------------------------- 积分
def add_points(user_id, online=0, solo=0, outcome=None):
    """累加积分：online/solo 是增量（可以是负的），outcome=True 记一胜、False 记一负。"""
    if not user_id:
        return None
    online = int(online or 0)
    solo = int(solo or 0)
    win = 1 if outcome is True else 0
    lose = 1 if outcome is False else 0
    with _lock:
        con = connect()
        con.execute("INSERT OR IGNORE INTO scores(user_id, online, solo, wins, losses, updated_at) "
                    "VALUES(?,0,0,0,0,?)", (user_id, now()))
        con.execute("UPDATE scores SET online = online + ?, solo = solo + ?, wins = wins + ?, "
                    "losses = losses + ?, updated_at = ? WHERE user_id = ?",
                    (online, solo, win, lose, now(), user_id))
        con.commit()
        row = con.execute("SELECT online, solo, wins, losses FROM scores WHERE user_id = ?",
                          (user_id,)).fetchone()
    return {"online": row["online"], "solo": row["solo"], "total": row["online"] + row["solo"],
            "wins": row["wins"], "losses": row["losses"]}


def get_points(user_id):
    row = query_one("SELECT online, solo, wins, losses FROM scores WHERE user_id = ?", (user_id,))
    if not row:
        return {"online": 0, "solo": 0, "total": 0, "wins": 0, "losses": 0}
    return {"online": row["online"], "solo": row["solo"], "total": row["online"] + row["solo"],
            "wins": row["wins"], "losses": row["losses"]}


def leaderboard(column, limit=50):
    if column not in ("online", "solo"):
        column = "online"
    rows = query(
        "SELECT s.user_id, s.online, s.solo, s.wins, s.losses, u.name, u.avatar, u.color, u.role "
        "FROM scores s JOIN users u ON u.id = s.user_id "
        "WHERE u.banned = 0 AND (s.online <> 0 OR s.solo <> 0) "
        "ORDER BY s.%s DESC, (s.online + s.solo) DESC, s.wins DESC, u.id ASC LIMIT ?" % column,
        (int(limit),))
    out = []
    for i, row in enumerate(rows):
        out.append({
            "rank": i + 1, "uid": row["user_id"], "name": row["name"],
            "avatar": row["avatar"] or "", "color": row["color"] or "", "role": row["role"],
            "points": row[column], "online": row["online"], "solo": row["solo"],
            "total": row["online"] + row["solo"], "wins": row["wins"], "losses": row["losses"],
        })
    return out


def rank_of(user_id, column):
    for row in leaderboard(column, 1000):
        if row["uid"] == user_id:
            return row["rank"]
    return 0


def random_code(length=4):
    alphabet = string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def random_password(length=8):
    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))
