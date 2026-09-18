"""Turn-based multiplayer games over WebSocket rooms (server authoritative)."""

import random
import time

import boardgames as bgl
import db
import werewolf as ww
from util import dumps, log, now

ROOMS = {}

# 断线宽限期（秒）：手机切后台 / 锁屏会断 WebSocket，
# 这段时间内保留座位，同一个人重连上来直接坐回原位，对局不中止。
GRACE_SECONDS = 120


def new_room_code():
    """四位数字房间号，避免和现有房间撞车。"""
    for _ in range(400):
        code = "%04d" % random.randint(1000, 9999)
        if code not in ROOMS:
            return code
    seq = 1
    while "%04d" % seq in ROOMS:
        seq += 1
    return "%04d" % seq


async def broadcast(obj):
    """Fan out to every websocket connection (imported lazily: ws imports games)."""
    import ws
    await ws.broadcast(obj)


WORDS = [
    "奶茶", "黑板", "篮球", "耳机", "沙发", "西瓜", "企鹅", "长城", "火锅", "雨伞",
    "吉他", "灯泡", "自行车", "熊猫", "风筝", "冰淇淋", "足球", "月亮", "机器人", "汉堡",
    "雨鞋", "望远镜", "蘑菇", "钟表", "剪刀", "相机", "钢琴", "棒棒糖", "火箭", "螃蟹",
    "森林", "灯塔", "披萨", "滑板", "蝴蝶", "帐篷", "魔方", "甜甜圈", "消防车", "海豚",
]

GAME_META = {
    "gomoku": {"name": "五子棋", "min": 2, "max": 2, "desc": "15×15 传统五子棋，五连即胜"},
    "tictactoe": {"name": "井字棋", "min": 2, "max": 2, "desc": "三连成一线的经典小游戏"},
    "draw": {"name": "你画我猜", "min": 2, "max": 10, "desc": "轮流作画，谁先猜中谁加分"},
    "bomb": {"name": "数字炸弹", "min": 2, "max": 12, "desc": "轮流报数缩小范围，踩中炸弹的人输"},
    "go": {"name": "围棋", "min": 2, "max": 2, "desc": "9 路棋盘 · 中国规则数子 · 黑贴 7.5 目"},
    "xiangqi": {"name": "象棋", "min": 2, "max": 2, "desc": "标准中国象棋 · 将死或困毙即胜"},
    "werewolf": {"name": "狼人杀", "min": ww.MIN_PLAYERS, "max": ww.MAX_PLAYERS,
                 "desc": "6~12 人正规板子 · 预女猎白 · 狼刀+验人+用药+投票放逐"},
}

# 棋盘形状：(列, 行)
BOARD_SHAPE = {"gomoku": (15, 15), "tictactoe": (3, 3), "go": (bgl.GO_SIZE, bgl.GO_SIZE),
               "xiangqi": (bgl.XQ_COLS, bgl.XQ_ROWS)}
BOARD_GAMES = ("gomoku", "tictactoe", "go", "xiangqi")


def player_view(conn):
    return {
        "uid": conn.uid,
        "name": conn.user["name"],
        "role": conn.user.get("role"),
        "color": conn.user.get("color") or "",
        "avatar": conn.user.get("avatar") or "",
    }


class Room:
    def __init__(self, game, host, code=None):
        self.id = code if code and code not in ROOMS else new_room_code()
        self.game = game
        self.host = host.uid
        self.members = []          # [Conn]
        self.seats = []            # [Conn] players
        self.started = False
        self.state = {}
        self.created_at = now()
        self.finished = False
        self.rematch = set()      # 点了"再来一局"的人
        self.ready = set()        # 点了"准备"的人（所有人都准备才开局）

    # ---------- membership ----------
    def player_limit(self):
        return GAME_META[self.game]["max"]

    def seat_available(self):
        return len(self.seats) < self.player_limit()

    async def add(self, conn, as_player=True):
        if conn not in self.members:
            self.members.append(conn)
        conn.rooms.add(self.id)
        if as_player and conn not in self.seats and self.seat_available():
            self.seats.append(conn)
            self.rematch.discard(conn.uid)
            self.ready.discard(conn.uid)     # 新坐下的人要重新准备
        elif not as_player:
            self.rematch.discard(conn.uid)
        await self.push("game.state")
        await broadcast({"t": "game.rooms", "rooms": list_rooms()})

    def find_reconnect(self, uid):
        """找出同一个人断线后留下的（还在宽限期内的）旧连接。"""
        for conn in list(self.members):
            if conn.uid == uid and conn.closed:
                return conn
        return None

    async def reattach(self, old, new):
        """把断线玩家原封不动地交还给重连上来的新连接：座位、房籍、对局状态都不变。"""
        if old not in self.members:
            return False
        index = self.members.index(old)
        self.members[index] = new
        if old in self.seats:
            self.seats[self.seats.index(old)] = new
        new.rooms.add(self.id)
        old.rooms.discard(self.id)
        old.detached_at = 0
        name = new.user["name"] if new.user else "有人"
        await self.push("game.state")
        await self.broadcast({"t": "game.event", "text": "%s 已重新连接" % name})
        await broadcast({"t": "game.rooms", "rooms": list_rooms()})
        return True

    async def remove(self, conn):
        was_seat = conn in self.seats
        if conn in self.members:
            self.members.remove(conn)
        if was_seat:
            self.seats.remove(conn)
        conn.rooms.discard(self.id)
        self.rematch.discard(conn.uid)
        self.ready.discard(conn.uid)
        name = conn.user["name"] if conn.user else "有人"
        if was_seat and self.started and not self.finished:
            # 对局进行中走人 -> 直接中止本局（不写战绩），房间回到等待状态，别人还能加进来
            await self.abort("%s 离开了，本局已中止" % name)
        elif self.members:
            await self.broadcast({"t": "game.event", "text": "%s 离开了房间" % name})
        if not self.members:
            ROOMS.pop(self.id, None)
        else:
            await self.push("game.state")
            await self.broadcast_rematch()
        await broadcast({"t": "game.rooms", "rooms": list_rooms()})

    # ---------- 准备 ----------
    def all_ready(self):
        """所有座位都点了准备、并且人数够了，才可以开局。"""
        if len(self.seats) < GAME_META[self.game]["min"]:
            return False
        return all(c.uid in self.ready for c in self.seats)

    async def begin(self, conn=None):
        """所有人都准备好了 —— 由服务端统一开局。"""
        if self.started:
            return
        self.ready.clear()
        if self.game in ("gomoku", "tictactoe"):
            await start_board(self)
        elif self.game == "go":
            await start_go(self)
        elif self.game == "xiangqi":
            await start_xiangqi(self)
        elif self.game == "werewolf":
            await ww.start(self)
        elif self.game == "draw":
            await draw_start(self)
        elif self.game == "bomb":
            await bomb_start(self, conn)

    async def toggle_ready(self, conn):
        if conn not in self.seats:
            await self.send_to(conn, {"t": "game.event", "text": "你在观战，不用准备"})
            return
        if self.started:
            await self.send_to(conn, {"t": "game.event", "text": "本局已经在进行中了"})
            return
        if conn.uid in self.ready:
            self.ready.discard(conn.uid)
        else:
            self.ready.add(conn.uid)
        name = conn.user["name"] if conn.user else "有人"
        await self.broadcast({"t": "game.event",
                              "text": "%s %s" % (name, "已准备" if conn.uid in self.ready else "取消准备")})
        await self.push("game.state")
        if self.all_ready():
            await self.begin(conn)

    async def abort(self, reason=""):
        """中止一局（不计战绩），房间保留并回到可加入状态。"""
        if self.finished and not self.started:
            return
        self.started = False
        self.finished = True
        self.rematch.clear()
        self.ready.clear()
        self.state = dict(self.state or {})
        self.state["status"] = "aborted"
        self.state["reason"] = reason
        await self.push("game.over", {"winners": [], "reason": reason, "aborted": True})

    def seat_of(self, uid):
        for seat in self.seats:
            if seat.uid == uid:
                return seat
        return None

    def seat_index(self, uid):
        for i, seat in enumerate(self.seats):
            if seat.uid == uid:
                return i
        return -1

    # ---------- messaging ----------
    async def broadcast(self, obj, room=None):
        for conn in list(self.members):
            if not conn.closed:
                await conn.send(obj)

    async def send_to(self, conn, obj):
        if conn and not conn.closed:
            await conn.send(obj)

    async def push(self, event="game.state", extra=None):
        """Send the room state to each member with secrets hidden per viewer."""
        for conn in list(self.members):
            if conn.closed:
                continue
            payload = {"t": event, "room": self.public_state(conn)}
            if extra:
                payload.update(extra)
            await conn.send(payload)

    def public_state(self, viewer=None):
        seats = [player_view(c) for c in self.seats]
        state = self.state
        if self.game == "draw":
            state = {k: v for k, v in self.state.items() if k != "order"}
            if not self.finished:
                is_drawer = viewer is not None and viewer.uid == self.state.get("drawer")
                if not is_drawer:
                    state = dict(state)
                    state["word"] = ""
        elif self.game == "bomb" and not self.finished:
            state = {k: v for k, v in self.state.items() if k != "bomb"}
        elif self.game == "werewolf":
            # 还没发身份时 state 是空的，不能让 view() 去读 roles；这时只报人数和板子
            if self.state.get("roles"):
                state = ww.view(self.state, viewer.uid if viewer else 0)
            else:
                state = {"waiting": True, "players_now": len(self.seats),
                         "board": ww.board_summary(max(len(self.seats), ww.MIN_PLAYERS))}
        return {
            "id": self.id,
            "code": self.id,
            "game": self.game,
            "max": GAME_META[self.game]["max"],
            "rematch": sorted(self.rematch),
            "can_join": self.seat_available(),
            "name": GAME_META[self.game]["name"],
            "host": self.host,
            "host_name": next((c.user["name"] for c in self.members if c.uid == self.host), ""),
            "started": self.started,
            "finished": self.finished,
            "min": GAME_META[self.game]["min"],
            "ready": sorted(self.ready),
            "players": seats,
            "spectators": [player_view(c) for c in self.members if c not in self.seats],
            "state": state,
        }

    async def finish(self, winners=None, reason=""):
        if self.finished:
            return
        self.finished = True
        self.started = False
        self.rematch.clear()
        self.ready.clear()
        self.state["status"] = "finished"
        self.state["reason"] = reason
        self.state["winners"] = winners or []
        db.execute("INSERT INTO game_records(game, mode, players, winners, detail, created_at) VALUES(?,?,?,?,?,?)",
                   (self.game, "online",
                    dumps([player_view(c) for c in self.seats]).decode(),
                    dumps(winners or []).decode(),
                    dumps({"room": self.id, "reason": reason}).decode(), now()))
        await self.push("game.over", {"winners": winners or [], "reason": reason, "aborted": False})
        await self.award_points(winners or [])

    # ---------- 积分 ----------
    async def award_points(self, winners):
        """联机对局结算：赢的人 +2，输的人 -1（可以是负分）。平局不加不减，观战者不参与。"""
        if not self.seats:
            return
        winners = {int(uid) for uid in (winners or [])}
        for seat in list(self.seats):
            if winners and seat.uid in winners:
                delta, outcome = 2, True
            elif winners:
                delta, outcome = -1, False
            else:
                delta, outcome = 0, None
            points = db.add_points(seat.uid, online=delta, outcome=outcome)
            if points is None:
                continue
            await self.send_to(seat, {"t": "points", "delta": delta, "scope": "online", "points": points})

    # ---------- 再来一局 ----------
    async def broadcast_rematch(self):
        waiting = sorted(self.rematch)
        payload = {"t": "game.rematch", "waiting": waiting,
                   "names": {str(c.uid): c.user["name"] for c in self.seats}}
        for conn in list(self.members):
            if not conn.closed:
                await conn.send(payload)

    async def vote_rematch(self, conn):
        if self.started and not self.finished:
            await self.send_to(conn, {"t": "game.event", "text": "本局还在进行中"})
            return
        self.rematch.add(conn.uid)
        await self.broadcast_rematch()
        seats = [c.uid for c in self.seats]
        if seats and all(uid in self.rematch for uid in seats) and len(seats) >= 2:
            self.rematch.clear()
            await restart(room=self)
        elif len(seats) < 2:
            await self.send_to(conn, {"t": "game.event", "text": "等对手加入后就能开始"})


def list_rooms():
    rooms = []
    for room in sorted(ROOMS.values(), key=lambda item: item.created_at, reverse=True):
        rooms.append({
            "id": room.id,
            "code": room.id,
            "game": room.game,
            "name": GAME_META[room.game]["name"],
            "players": len(room.seats),
            "max": GAME_META[room.game]["max"],
            "spectators": len([c for c in room.members if c not in room.seats]),
            "started": room.started,
            "finished": room.finished,
            "can_join": room.seat_available(),
            "host": room.host,
            "host_name": next((c.user["name"] for c in room.members if c.uid == room.host), ""),
            "started_names": [c.user["name"] for c in room.seats],
        })
    return rooms


BOARD_SIZE = {"gomoku": 15, "tictactoe": 3}


def new_board(game):
    size = BOARD_SIZE[game]
    return [0] * (size * size)


def check_win(board, game, index, player):
    size = BOARD_SIZE[game]
    need = 5 if game == "gomoku" else 3
    row, col = divmod(index, size)
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        count = 1
        for direction in (1, -1):
            step = 1
            while True:
                r = row + dr * step * direction
                c = col + dc * step * direction
                if r < 0 or c < 0 or r >= size or c >= size:
                    break
                if board[r * size + c] != player:
                    break
                count += 1
                step += 1
        if count >= need:
            return True
    return False


# ---------------------------------------------------------------- board games
async def start_board(room):
    room.started = True
    room.finished = False
    cols, rows = BOARD_SHAPE[room.game]
    room.state = {
        "status": "playing",
        "size": BOARD_SIZE[room.game],
        "cols": cols,
        "rows": rows,
        "board": new_board(room.game),
        "turn": room.seats[0].uid,
        "marks": {str(room.seats[0].uid): 1, str(room.seats[1].uid): 2},
        "last": None,
        "move_count": 0,
    }
    await room.push("game.state")
    await room.broadcast({"t": "game.event", "text": "%s 开局，黑棋先行" % GAME_META[room.game]["name"]})


async def board_move(room, conn, msg):
    if not room.started or room.finished:
        return
    if room.seat_index(conn.uid) < 0:
        await room.send_to(conn, {"t": "game.event", "text": "观战者不能落子"})
        return
    if room.state.get("turn") != conn.uid:
        await room.send_to(conn, {"t": "game.event", "text": "还没轮到你"})
        return
    index = int(msg.get("index", -1))
    board = room.state["board"]
    if index < 0 or index >= len(board) or board[index] != 0:
        await room.send_to(conn, {"t": "game.event", "text": "这个位置不能落子"})
        return
    player = room.state["marks"][str(conn.uid)]
    board[index] = player
    room.state["last"] = {"index": index, "uid": conn.uid}
    room.state["move_count"] += 1
    if check_win(board, room.game, index, player):
        room.state["status"] = "playing"
        await room.push("game.update")
        await room.finish(winners=[conn.uid], reason="%s 连成一线" % conn.user["name"])
        return
    if all(cell != 0 for cell in board):
        await room.push("game.update")
        await room.finish(winners=[], reason="棋盘已满，平局")
        return
    others = [c.uid for c in room.seats if c.uid != conn.uid]
    room.state["turn"] = others[0] if others else conn.uid
    await room.push("game.update")


# ---------------------------------------------------------------- 围棋
async def start_go(room):
    room.started = True
    room.finished = False
    room.state = {
        "status": "playing",
        "size": bgl.GO_SIZE,
        "cols": bgl.GO_SIZE,
        "rows": bgl.GO_SIZE,
        "board": bgl.go_new_board(),
        "turn": room.seats[0].uid,
        "marks": {str(room.seats[0].uid): 1, str(room.seats[1].uid): 2},
        "last": None,
        "move_count": 0,
        "passes": 0,
        "captures": {"1": 0, "2": 0},
        "history": [bgl.go_new_board()],
        "komi": bgl.GO_KOMI,
    }
    await room.push("game.state")
    await room.broadcast({"t": "game.event",
                          "text": "围棋开局，%s 执黑先行（黑贴 7.5 目，中国规则数子）" % room.seats[0].user["name"]})


async def _go_switch(room):
    state = room.state
    others = [c.uid for c in room.seats if c.uid != state["turn"]]
    state["turn"] = others[0] if others else state["turn"]


async def go_finish(room, reason):
    state = room.state
    black, white = bgl.go_score(state["board"])
    state["score"] = {"black": black, "white": white, "komi": bgl.GO_KOMI}
    black_uid = next((c.uid for c in room.seats if state["marks"].get(str(c.uid)) == 1), 0)
    white_uid = next((c.uid for c in room.seats if state["marks"].get(str(c.uid)) == 2), 0)
    if black > white:
        winners, who = [black_uid], "黑棋胜"
    elif white > black:
        winners, who = [white_uid], "白棋胜"
    else:
        winners, who = [], "和棋"
    await room.push("game.update")
    await room.finish(winners=[w for w in winners if w],
                      reason="%s：%s（黑 %.1f : 白 %.1f，白棋含贴目 7.5）" % (reason, who, black, white))


async def go_move(room, conn, msg):
    state = room.state
    if not room.started or room.finished:
        return
    if room.seat_index(conn.uid) < 0:
        await room.send_to(conn, {"t": "game.event", "text": "观战者不能落子"})
        return
    if state.get("turn") != conn.uid:
        await room.send_to(conn, {"t": "game.event", "text": "还没轮到你"})
        return
    if msg.get("resign"):
        other = next((c for c in room.seats if c.uid != conn.uid), None)
        await room.broadcast({"t": "game.event", "text": "%s 认输" % conn.user["name"]})
        await room.finish(winners=[other.uid] if other else [],
                          reason="%s 中盘认输" % conn.user["name"])
        return
    color = state["marks"][str(conn.uid)]
    if msg.get("pass"):
        state["passes"] += 1
        state["last"] = None
        await room.broadcast({"t": "game.event", "text": "%s 停一手" % conn.user["name"]})
        if state["passes"] >= 2:
            await go_finish(room, "双方连续停手")
            return
        await _go_switch(room)
        await room.push("game.update")
        return
    index = int(msg.get("index", -1))
    placed = bgl.go_place(state["board"], index, color)
    if placed is None:
        await room.send_to(conn, {"t": "game.event", "text": "这里不能落子（已有子或自杀）"})
        return
    board, captured = placed
    history = state["history"]
    if len(history) >= 2 and board == history[-2]:
        await room.send_to(conn, {"t": "game.event", "text": "打劫：这一手不能马上提回来"})
        return
    state["board"] = board
    history.append(list(board))
    del history[:-3]
    state["passes"] = 0
    state["last"] = {"index": index, "uid": conn.uid, "color": color}
    state["move_count"] += 1
    if captured:
        state["captures"][str(color)] = state["captures"].get(str(color), 0) + len(captured)
        await room.broadcast({"t": "game.event",
                              "text": "%s 提掉 %d 子（累计提 %d 子）"
                                      % (conn.user["name"], len(captured), state["captures"][str(color)])})
    await _go_switch(room)
    await room.push("game.update")


# ---------------------------------------------------------------- 象棋
async def start_xiangqi(room):
    room.started = True
    room.finished = False
    room.state = {
        "status": "playing",
        "size": bgl.XQ_COLS,
        "cols": bgl.XQ_COLS,
        "rows": bgl.XQ_ROWS,
        "board": bgl.xq_initial(),
        "turn": room.seats[0].uid,
        "marks": {str(room.seats[0].uid): 1, str(room.seats[1].uid): 2},    # 1 = 红（先行）
        "last": None,
        "move_count": 0,
        "check": False,
        "moves": [],
    }
    await room.push("game.state")
    await room.broadcast({"t": "game.event", "text": "象棋开局，%s 执红先行" % room.seats[0].user["name"]})


async def xq_move(room, conn, msg):
    state = room.state
    if not room.started or room.finished:
        return
    if room.seat_index(conn.uid) < 0:
        await room.send_to(conn, {"t": "game.event", "text": "观战者不能走棋"})
        return
    if state.get("turn") != conn.uid:
        await room.send_to(conn, {"t": "game.event", "text": "还没轮到你"})
        return
    if msg.get("resign"):
        other = next((c for c in room.seats if c.uid != conn.uid), None)
        await room.broadcast({"t": "game.event", "text": "%s 认输" % conn.user["name"]})
        await room.finish(winners=[other.uid] if other else [],
                          reason="%s 中盘认输" % conn.user["name"])
        return
    board = state["board"]
    try:
        src, dst = int(msg.get("from", -1)), int(msg.get("to", -1))
    except (TypeError, ValueError):
        return
    if not (0 <= src < len(board) and 0 <= dst < len(board)) or board[src] == 0:
        await room.send_to(conn, {"t": "game.event", "text": "先点自己的棋子，再点要去的格子"})
        return
    red = state["marks"][str(conn.uid)] == 1
    if (board[src] > 0) != red:
        await room.send_to(conn, {"t": "game.event", "text": "那是对手的棋子"})
        return
    if dst not in bgl.xq_legal_moves(board, src):
        await room.send_to(conn, {"t": "game.event",
                                  "text": "这一步不合规则（别马腿 / 塞象眼 / 炮要隔子 / 会被将军或将帅照面）"})
        return
    taken = board[dst]
    state["board"] = bgl.xq_apply(board, src, dst)
    state["last"] = {"from": src, "to": dst, "uid": conn.uid, "taken": taken}
    state["move_count"] += 1
    state["moves"].append({"from": src, "to": dst, "uid": conn.uid})
    del state["moves"][:-40]
    opponents = [c.uid for c in room.seats if c.uid != conn.uid]
    state["turn"] = opponents[0] if opponents else conn.uid
    status = bgl.xq_status(state["board"], not red)
    state["check"] = status in ("check", "checkmate")
    if status == "checkmate":
        mate = bgl.xq_in_check(state["board"], not red)
        await room.push("game.update")
        await room.finish(winners=[conn.uid],
                          reason="%s %s" % (conn.user["name"], "将死对手" if mate else "困毙对手"))
        return
    await room.push("game.update")
    if status == "check":
        await room.broadcast({"t": "game.event", "text": "将军！"})


async def restart(room):
    room.ready.clear()
    """按游戏类型重新开一局（双方都点了"再来一局"之后调用）。"""
    room.rematch.clear()
    if len(room.seats) < GAME_META[room.game]["min"]:
        await room.broadcast({"t": "game.event",
                              "text": "人数不够（%s 至少 %d 人），等同学加入"
                                      % (GAME_META[room.game]["name"], GAME_META[room.game]["min"])})
        return
    room.finished = False
    room.state = {}
    if room.game in ("gomoku", "tictactoe"):
        room.seats.reverse()          # 交换先后手
        await start_board(room)
    elif room.game == "go":
        room.seats.reverse()          # 交换黑白
        await start_go(room)
    elif room.game == "xiangqi":
        room.seats.reverse()          # 交换红黑
        await start_xiangqi(room)
    elif room.game == "werewolf":
        await ww.start(room)          # 狼人杀重开：重新洗牌发身份
    elif room.game == "draw":
        await draw_start(room)
    elif room.game == "bomb":
        await bomb_start(room)
    await broadcast({"t": "game.rooms", "rooms": list_rooms()})


# ---------------------------------------------------------------- draw & guess
async def draw_start(room, conn=None):
    if len(room.seats) < 2:
        if conn:
            await room.send_to(conn, {"t": "game.event", "text": "至少 2 名玩家才能开始"})
        return
    room.started = True
    room.finished = False
    order = [c for c in room.seats]
    random.shuffle(order)
    room.state = {
        "status": "playing",
        "order": [c.uid for c in order],
        "turn_index": 0,
        "drawer": order[0].uid,
        "word": random.choice(WORDS),
        "masked": "",
        "scores": {str(c.uid): 0 for c in room.seats},
        "guessed": [],
        "strokes": [],
        "round": 1,
        "deadline": now() + 75,
        "reveal": "",
    }
    room.state["masked"] = "_" * len(room.state["word"])
    await room.push("game.state")
    await room.broadcast({"t": "game.event", "text": "第 1 轮开始，轮到 %s 作画" % order[0].user["name"]})


async def draw_next_round(room, reason="本轮结束"):
    order = room.state["order"]
    index = (room.state["turn_index"] + 1) % len(order)
    room.state["round"] += 1
    room.state["turn_index"] = index
    room.state["drawer"] = order[index]
    room.state["word"] = random.choice(WORDS)
    room.state["masked"] = "_" * len(room.state["word"])
    room.state["guessed"] = []
    room.state["strokes"] = []
    room.state["deadline"] = now() + 75
    room.state["reveal"] = ""
    await room.push("game.state")
    drawer_conn = room.seat_of(order[index])
    await room.broadcast({"t": "game.event", "text": "%s 第 %d 轮开始" % (reason, room.state["round"])})


async def draw_guess(room, conn, text):
    if not room.started or room.finished or conn.uid == room.state.get("drawer"):
        return False
    word = room.state["word"]
    if conn.uid in room.state["guessed"]:
        return False
    if text.strip() == word:
        room.state["guessed"].append(conn.uid)
        order = len(room.state["guessed"])
        gain = max(30, 120 - (order - 1) * 25)
        drawer_gain = 40
        room.state["scores"][str(conn.uid)] = room.state["scores"].get(str(conn.uid), 0) + gain
        room.state["scores"][str(room.state["drawer"])] = room.state["scores"].get(str(room.state["drawer"]), 0) + drawer_gain
        await room.broadcast({"t": "game.event", "text": "%s 猜中了！+%d 分（画手 +%d）" % (conn.user["name"], gain, drawer_gain)})
        others = [c.uid for c in room.seats if c.uid != room.state["drawer"]]
        if all(uid in room.state["guessed"] for uid in others):
            room.state["reveal"] = word
            await room.push("game.update")
            await draw_next_round(room, "全员猜中，")
        else:
            await room.push("game.update")
        return True
    return False


async def draw_timeout_check():
    for room in list(ROOMS.values()):
        if room.game != "draw" or not room.started or room.finished:
            continue
        if room.state.get("deadline", 0) and now() > room.state["deadline"]:
            room.state["reveal"] = room.state.get("word", "")
            await room.broadcast({"t": "game.event", "text": "时间到！答案是「%s」" % room.state.get("reveal", "")})
            await room.push("game.update")
            await draw_next_round(room, "时间到，")


# ---------------------------------------------------------------- number bomb
async def bomb_start(room, conn):
    if len(room.seats) < 2:
        await room.send_to(conn, {"t": "game.event", "text": "至少 2 名玩家才能开始"})
        return
    lo, hi = 1, 100
    room.started = True
    room.finished = False
    room.state = {
        "status": "playing",
        "lo": lo,
        "hi": hi,
        "bomb": random.randint(lo + 1, hi - 1),
        "turn": room.seats[0].uid,
        "alive": [c.uid for c in room.seats],
        "names": {str(c.uid): c.user["name"] for c in room.seats},
        "history": [],
        "loser": 0,
    }
    await room.push("game.state")
    await room.broadcast({"t": "game.event", "text": "范围 1~100，%s 先猜" % room.seats[0].user["name"]})


async def bomb_guess(room, conn, number):
    if not room.started or room.finished:
        return False
    if room.state.get("turn") != conn.uid:
        return False
    number = int(number)
    lo, hi = room.state["lo"], room.state["hi"]
    if number <= lo or number >= hi:
        await room.send_to(conn, {"t": "game.event", "text": "请报 %d~%d 之间的数字" % (lo + 1, hi - 1)})
        return True
    room.state["history"].append({"uid": conn.uid, "name": conn.user["name"], "n": number,
                                  "avatar": conn.user.get("avatar") or "",
                                  "dir": "low" if number < room.state["bomb"] else "high"})
    if number == room.state["bomb"]:
        room.state["loser"] = conn.uid
        alive = [uid for uid in room.state["alive"] if uid != conn.uid]
        room.state["alive"] = alive
        await room.broadcast({"t": "game.event", "text": "💥 砰！%s 踩中炸弹 %d" % (conn.user["name"], number)})
        if len(alive) <= 1:
            await room.finish(winners=alive, reason="%s 被炸飞" % conn.user["name"])
            return True
        room.state["bomb"] = random.randint(lo + 1, hi - 1)
        room.state["turn"] = alive[0]
        await room.push("game.update")
        await room.broadcast({"t": "game.event", "text": "新一轮 1~100，%s 先猜" % room.state["names"][str(alive[0])]})
        return True
    if number < room.state["bomb"]:
        room.state["lo"] = number
    else:
        room.state["hi"] = number
    order = room.state["alive"]
    index = order.index(conn.uid)
    room.state["turn"] = order[(index + 1) % len(order)]
    await room.push("game.update")
    return True


# ---------------------------------------------------------------- dispatch
async def leave_other_rooms(conn, keep_id=None):
    """进入新房间前先退出其他房间，避免同一条连接同时挂在多个房间里。"""
    for other in list(ROOMS.values()):
        if other.id != keep_id and conn in other.members:
            await other.remove(conn)


async def handle(conn, action, msg):
    if action == "list":
        await conn.send({"t": "game.rooms", "rooms": list_rooms(), "meta": GAME_META})
        return
    if action == "create":
        game = msg.get("game")
        if game not in GAME_META:
            await conn.send_text("未知游戏")
            return
        if db.setting("games_enabled", "1") != "1" and conn.user.get("role") != "admin":
            await conn.send_text("游戏大厅当前已关闭")
            return
        wanted = str(msg.get("code") or "").strip()
        if wanted and not wanted.isdigit():
            await conn.send({"t": "game.error", "text": "房间号只能是数字"})
            return
        code = wanted.zfill(4) if wanted else None
        if code and code in ROOMS:
            await conn.send({"t": "game.error", "text": "房间号 %s 已被占用" % code})
            return
        await leave_other_rooms(conn)
        room = Room(game, conn, code)
        ROOMS[room.id] = room
        await room.add(conn, as_player=True)
        await conn.send({"t": "game.entered", "room": room.public_state(conn), "meta": GAME_META[game]})
        await broadcast({"t": "game.rooms", "rooms": list_rooms()})
        return
    if action in ("join", "spectate"):
        raw = str(msg.get("room") or "").strip()
        room = ROOMS.get(raw) or ROOMS.get(raw.zfill(4)) or ROOMS.get(raw.lstrip("0"))
        if not room:
            # 支持直接用房间号找
            room = next((r for r in ROOMS.values() if r.id == raw.zfill(4)), None)
        if not room:
            await conn.send({"t": "game.error", "text": "房间 %s 不存在" % raw})
            return
        await leave_other_rooms(conn, keep_id=room.id)
        # 优先复用断线前的位置：切后台再回来还是原来那一局，不是观战
        stale = room.find_reconnect(conn.uid)
        if stale is not None and stale is not conn:
            await room.reattach(stale, conn)
            await conn.send({"t": "game.entered", "room": room.public_state(conn), "meta": GAME_META[room.game]})
            return
        want_play = action == "join" and bool(msg.get("play", True))
        await room.add(conn, as_player=want_play and room.seat_available())
        if conn not in room.seats:
            await room.send_to(conn, {"t": "game.event", "text": "已进入观战模式"})
        await conn.send({"t": "game.entered", "room": room.public_state(conn), "meta": GAME_META[room.game]})
        return
    if action == "leave":
        for room in list(ROOMS.values()):
            if conn in room.members:
                await room.remove(conn)
        await conn.send({"t": "game.left"})
        return
    room = None
    for candidate in ROOMS.values():
        if conn in candidate.members:
            room = candidate
            break
    if not room:
        await conn.send_text("你还没有进入房间")
        return
    if action in ("ready", "start"):
        # 老客户端发的 game.start 现在等同于"准备"：必须所有人都准备才会开局
        await room.toggle_ready(conn)
        return
    if action == "rematch":
        await room.vote_rematch(conn)
        return
    if action == "move":
        if room.game in ("gomoku", "tictactoe"):
            await board_move(room, conn, msg)
        elif room.game == "go":
            await go_move(room, conn, msg)
        elif room.game == "xiangqi":
            await xq_move(room, conn, msg)
        return
    if action == "act":
        # 狼人杀：狼刀 / 验人 / 女巫用药 / 猎人开枪 / 放逐投票
        if room.game == "werewolf":
            await ww.act(room, conn, (msg.get("what") or "").strip(), msg)
        return
    if action == "draw":
        if room.game == "draw" and conn.uid == room.state.get("drawer") and room.started:
            seg = msg.get("seg")
            if seg:
                room.state.setdefault("strokes", []).append(seg)
                await room.broadcast({"t": "game.stroke", "seg": seg, "clear": bool(msg.get("clear"))}, )
        return
    if action == "clear":
        if room.game == "draw" and conn.uid == room.state.get("drawer"):
            room.state["strokes"] = []
            await room.broadcast({"t": "game.stroke", "clear": True})
        return
    if action == "guess":
        text = (msg.get("text") or "").strip()
        if not text:
            return
        if room.game == "draw":
            await room.broadcast({"t": "game.chat", "chat": {"name": conn.user["name"], "text": text}})
            await draw_guess(room, conn, text)
        elif room.game == "bomb":
            try:
                number = int(text)
            except ValueError:
                await room.send_to(conn, {"t": "game.event", "text": "请输入数字"})
                return
            await bomb_guess(room, conn, number)
        return
    if action == "chat":
        await room.broadcast({"t": "game.chat", "chat": {"name": conn.user["name"], "text": (msg.get("text") or "")[:200]}})
        return
    if action == "kick" and (conn.uid == room.host or conn.user.get("role") == "admin"):
        target = int(msg.get("uid") or 0)
        for member in list(room.members):
            if member.uid == target:
                await room.send_to(member, {"t": "game.event", "text": "你被房主移出房间"})
                await room.remove(member)
        return


async def on_disconnect(conn):
    """WebSocket 断开：先保留座位等重连（手机会切后台），超时才真正退出。"""
    for room in list(ROOMS.values()):
        if conn in room.members and not conn.detached_at:
            conn.detached_at = time.time()
            name = conn.user["name"] if conn.user else "有人"
            await room.broadcast({"t": "game.event", "text": "%s 掉线了，%d 秒内回来还能接着玩" % (name, GRACE_SECONDS)})
            await room.push("game.state")


async def sweep_disconnected():
    """宽限期到了还没回来，才真的把人移出房间。"""
    deadline = time.time() - GRACE_SECONDS
    for room in list(ROOMS.values()):
        for conn in list(room.members):
            if not conn.closed:
                conn.detached_at = 0
                continue
            if not conn.detached_at:
                conn.detached_at = time.time()   # 服务器单方面判定掉线，从这里开始计时
                continue
            if conn.detached_at < deadline:
                await room.remove(conn)


async def werewolf_tick():
    """狼人杀的状态机靠它推进（到点自动进入下一阶段）。"""
    for room in list(ROOMS.values()):
        if room.game == "werewolf" and room.started and not room.finished:
            try:
                await ww.tick(room)
            except Exception as exc:  # noqa: BLE001
                log("werewolf tick error", repr(exc))


async def ticker():
    import asyncio
    while True:
        await asyncio.sleep(2)
        try:
            await draw_timeout_check()
            await werewolf_tick()
            await sweep_disconnected()
        except Exception as exc:  # noqa: BLE001
            log("game ticker error", repr(exc))
