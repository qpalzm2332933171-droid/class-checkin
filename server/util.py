"""Small helpers shared by the whole backend (stdlib only)."""

import datetime
import json
import time

CST = datetime.timezone(datetime.timedelta(hours=8))


def now():
    return int(time.time())


def fmt(ts, pattern="%Y-%m-%d %H:%M:%S"):
    if not ts:
        return ""
    return datetime.datetime.fromtimestamp(int(ts), CST).strftime(pattern)


def today(ts=None):
    return fmt(ts or now(), "%Y-%m-%d")


def day_start(ts=None):
    t = datetime.datetime.fromtimestamp(int(ts or now()), CST)
    start = t.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp())


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def loads(data, default=None):
    if not data:
        return default
    try:
        return json.loads(data)
    except Exception:  # noqa: BLE001
        return default


def log(*parts):
    print(time.strftime("[%Y-%m-%d %H:%M:%S]"), *parts, flush=True)


def clamp(value, low, high):
    return max(low, min(high, value))


def mask_ip(ip):
    """183.95.73.110 -> 183.95.*.*  (kept for non-admin display)"""
    if not ip:
        return ""
    if ":" in ip:  # ipv6
        return ip.split(":")[0] + "::"
    chunks = ip.split(".")
    if len(chunks) == 4:
        return "%s.%s.*.*" % (chunks[0], chunks[1])
    return ip


def human_size(num):
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return "%.1f%s" % (num, unit) if unit != "B" else "%dB" % num
        num /= 1024.0
