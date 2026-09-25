"""Small helpers shared by the whole backend (stdlib only)."""

import datetime
import json
import os
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


# ---------------------------------------------------------------- 日志刹车
# 2026-09-23 的事故是「日志把磁盘写满」：进程 fd 被吃光后 asyncio 的 accept 循环
# 每次迭代都甩一份完整 traceback，没有任何节流，两天刷出 26.5GB —— 28G 的磁盘
# 就这么没了，顺带服务整整 25 小时接不了新连接。日志不能再当故障放大器，
# 所以这里有两道闸：
#   1. 去重：同一条消息在 _LOG_DEDUP_WINDOW 秒内只打第一遍，之后只计数，
#      等它重新出现时补一句「被压掉 N 次」；
#   2. 限流：全局每秒最多 _LOG_BURST_MAX 行，超出直接丢。
# 硬上限在 systemd 那边：日志交给 journald，SystemMaxUse 封顶（见 deploy/）。
_LOG_DEDUP_WINDOW = 30.0   # 同一条消息多少秒内不再重复打
_LOG_BURST_MAX = 40        # 每秒最多打多少行（正常运行时远远用不到）
_LOG_BURST_WINDOW = 1.0
_LOG_DEDUP_MAX = 512       # 去重表最多记多少条，防止它自己把内存吃光

_log_seen = {}                 # 消息 -> [上次打印时间, 期间被压掉的条数]
_log_burst = [0.0, 0]          # [窗口起点, 本窗口已打的行数]


def log(*parts):
    """带限流和去重的日志（见文件上方说明）。"""
    line = " ".join(str(p) for p in parts)
    stamp = time.strftime("[%Y-%m-%d %H:%M:%S]")
    try:
        stamp_t = time.time()
        entry = _log_seen.get(line)
        if entry is None:
            if len(_log_seen) >= _LOG_DEDUP_MAX:
                _log_seen.clear()   # 表满了就清空重来：丢掉计数，换内存有界
            _log_seen[line] = [stamp_t, 0]
        elif stamp_t - entry[0] < _LOG_DEDUP_WINDOW:
            entry[1] += 1
            return
        else:
            blocked, entry[1] = entry[1], 0
            entry[0] = stamp_t
            if blocked:
                print(stamp, "（上一条相同的日志刚被压掉 %d 次）" % blocked, flush=True)

        if stamp_t - _log_burst[0] >= _LOG_BURST_WINDOW:
            _log_burst[0], _log_burst[1] = stamp_t, 0
        _log_burst[1] += 1
        if _log_burst[1] > _LOG_BURST_MAX:
            if _log_burst[1] == _LOG_BURST_MAX + 1:
                print(stamp, "日志超过每秒 %d 行，开始丢弃（磁盘保护）" % _LOG_BURST_MAX, flush=True)
            return
        print(stamp, line, flush=True)
    except Exception:  # noqa: BLE001
        # 日志自己出错绝不能把主流程带走（比如 stdout 已经断了）
        pass


def log_exc(prefix, exc):
    """异常日志：类型 + 消息 + 出错位置，不打完整堆栈。

    traceback.print_exc() 会绕过 log() 的限流直接写 stderr，而完整堆栈正是把
    28G 磁盘写满的东西。要看完整堆栈时设 CHECKIN_DEBUG_TRACEBACK=1。
    """
    where = ""
    tb = getattr(exc, "__traceback__", None)
    while tb is not None:
        where = "%s:%d" % (tb.tb_frame.f_code.co_filename.rsplit("/", 1)[-1], tb.tb_lineno)
        tb = tb.tb_next
    log(prefix, "%s: %s" % (type(exc).__name__, exc), "@", where)
    if os.environ.get("CHECKIN_DEBUG_TRACEBACK") == "1":
        import traceback
        print(traceback.format_exc(), flush=True)


def install_log_guard(loop):
    """换掉 asyncio 的默认异常处理器。

    默认处理器把每个未处理异常的完整 traceback 直接写 stderr，完全不限速 ——
    2026-09-23 就是它：accept() 因为 fd 耗尽一直抛 OSError，事件循环每转一圈
    甩一份 traceback，两天 26.5GB。这里改成走限流日志，只留类型和消息。
    """
    def handler(loop_, context):
        exc = context.get("exception")
        msg = context.get("message") or "event loop error"
        if exc is not None:
            log("asyncio", msg, "|", "%s: %s" % (type(exc).__name__, exc))
        else:
            log("asyncio", msg)
    loop.set_exception_handler(handler)


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
