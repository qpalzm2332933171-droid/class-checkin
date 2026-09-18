"""围棋 / 象棋的**纯规则层**：不碰房间、不碰网络，方便单独测试。

坐标一律用一维下标：index = row * cols + col。
棋盘取值：0 = 空；围棋 1=黑 2=白；象棋 正数=红方、负数=黑方。
"""

# ==================================================================== 围棋
GO_SIZE = 9
GO_KOMI = 7.5          # 中国规则：黑贴 3又3/4 子，等价白 +7.5 目
GO_WEIGHTS = {1: 1, 2: 1}   # 占位说明：黑白同价，只有贴目不同


def go_new_board(size=GO_SIZE):
    return [0] * (size * size)


def go_neighbors(index, size=GO_SIZE):
    """上下左右四个邻点（越界不返回）。"""
    row, col = divmod(index, size)
    if row > 0:
        yield index - size
    if row < size - 1:
        yield index + size
    if col > 0:
        yield index - 1
    if col < size - 1:
        yield index + 1


def go_group(board, index, size=GO_SIZE):
    """返回 (颜色, 这一整块棋的点集合, 这块棋的气集合)。"""
    color = board[index]
    group = {index}
    stack = [index]
    libs = set()
    while stack:
        cur = stack.pop()
        for nb in go_neighbors(cur, size):
            if board[nb] == 0:
                libs.add(nb)
            elif board[nb] == color and nb not in group:
                group.add(nb)
                stack.append(nb)
    return color, group, libs


def go_place(board, index, color, size=GO_SIZE):
    """落子 + 提子。

    返回 (新棋盘, 被提掉的点 list)；占位或**自杀手**返回 None（非法）。
    """
    if index < 0 or index >= len(board) or board[index] != 0:
        return None
    nxt = list(board)
    nxt[index] = color
    other = 3 - color
    captured = []
    for nb in go_neighbors(index, size):
        if nxt[nb] == other:
            _color, group, libs = go_group(nxt, nb, size)
            if not libs:                       # 对方这块没气了 -> 提掉
                for point in group:
                    nxt[point] = 0
                captured.extend(group)
    if not go_group(nxt, index, size)[2]:
        return None                            # 自己下完也没气 -> 自杀，禁入
    return nxt, sorted(captured)


def go_score(board, size=GO_SIZE, komi=GO_KOMI):
    """中国规则数子：自己的活子 + 只被自己围住的空点（单方围空才算）。"""
    black = sum(1 for v in board if v == 1)
    white = sum(1 for v in board if v == 2)
    seen = set()
    for index in range(len(board)):
        if board[index] != 0 or index in seen:
            continue
        region = set()
        stack = [index]
        border = set()
        while stack:
            cur = stack.pop()
            if cur in region:
                continue
            region.add(cur)
            for nb in go_neighbors(cur, size):
                if board[nb] == 0:
                    if nb not in region:
                        stack.append(nb)
                else:
                    border.add(board[nb])
        seen |= region
        if len(border) == 1:                   # 被两家共用的空点不算目
            if 1 in border:
                black += len(region)
            else:
                white += len(region)
    return black, white + komi


# ==================================================================== 象棋
XQ_COLS, XQ_ROWS = 9, 10
# 棋子类型：1 帅/将  2 仕/士  3 相/象  4 马  5 车  6 炮  7 兵/卒
XQ_RED_NAMES = {1: "帅", 2: "仕", 3: "相", 4: "马", 5: "车", 6: "炮", 7: "兵"}
XQ_BLACK_NAMES = {1: "将", 2: "士", 3: "象", 4: "马", 5: "车", 6: "炮", 7: "卒"}


def xq_piece_name(piece):
    if piece == 0:
        return ""
    table = XQ_RED_NAMES if piece > 0 else XQ_BLACK_NAMES
    return table[abs(piece)]


def xq_initial():
    """标准开局：上一行黑（负），下一行红（正），红先行。"""
    board = [0] * (XQ_COLS * XQ_ROWS)
    back = [5, 4, 3, 2, 1, 2, 3, 4, 5]
    for col, piece in enumerate(back):
        board[0 * XQ_COLS + col] = -piece
        board[9 * XQ_COLS + col] = piece
    board[2 * XQ_COLS + 1] = -6
    board[2 * XQ_COLS + 7] = -6
    board[7 * XQ_COLS + 1] = 6
    board[7 * XQ_COLS + 7] = 6
    for col in (0, 2, 4, 6, 8):
        board[3 * XQ_COLS + col] = -7
        board[6 * XQ_COLS + col] = 7
    return board


def xq_in_palace(row, col, red):
    """九宫：列 3~5；红在 7~9 行，黑在 0~2 行。"""
    if col < 3 or col > 5:
        return False
    return 7 <= row <= 9 if red else 0 <= row <= 2


def xq_own_side(row, red):
    """相/象不能过河。"""
    return row >= 5 if red else row <= 4


def xq_pseudo_moves(board, index):
    """这只棋按走法能去哪些点（**不**检查将军 / 将帅照面）。"""
    piece = board[index]
    if piece == 0:
        return []
    red = piece > 0
    kind = abs(piece)
    row, col = divmod(index, XQ_COLS)
    out = []

    def add(r, c):
        """能走到 (r,c) 就记下来；返回 True 表示这格是空的、还能继续滑。"""
        if not (0 <= r < XQ_ROWS and 0 <= c < XQ_COLS):
            return False
        target = board[r * XQ_COLS + c]
        if target != 0 and (target > 0) == red:
            return False
        out.append(r * XQ_COLS + c)
        return target == 0

    if kind == 1:                                  # 帅 / 将
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if xq_in_palace(row + dr, col + dc, red):
                add(row + dr, col + dc)
    elif kind == 2:                                # 仕 / 士
        for dr, dc in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
            if xq_in_palace(row + dr, col + dc, red):
                add(row + dr, col + dc)
    elif kind == 3:                                # 相 / 象：塞象眼 + 不过河
        for dr, dc in ((2, 2), (2, -2), (-2, 2), (-2, -2)):
            r, c = row + dr, col + dc
            if not (0 <= r < XQ_ROWS and 0 <= c < XQ_COLS):
                continue
            if not xq_own_side(r, red):
                continue
            if board[(row + dr // 2) * XQ_COLS + (col + dc // 2)] != 0:
                continue
            add(r, c)
    elif kind == 4:                                # 马：蹩马腿
        for dr, dc in ((2, 1), (2, -1), (-2, 1), (-2, -1), (1, 2), (1, -2), (-1, 2), (-1, -2)):
            r, c = row + dr, col + dc
            if not (0 <= r < XQ_ROWS and 0 <= c < XQ_COLS):
                continue
            leg_r = row + (dr // 2 if abs(dr) == 2 else 0)
            leg_c = col + (dc // 2 if abs(dc) == 2 else 0)
            if board[leg_r * XQ_COLS + leg_c] != 0:
                continue
            add(r, c)
    elif kind == 5:                                # 车
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            r, c = row + dr, col + dc
            while 0 <= r < XQ_ROWS and 0 <= c < XQ_COLS:
                target = board[r * XQ_COLS + c]
                if target == 0:
                    out.append(r * XQ_COLS + c)
                else:
                    if (target > 0) != red:
                        out.append(r * XQ_COLS + c)
                    break
                r += dr
                c += dc
    elif kind == 6:                                # 炮：吃子必须隔一个炮架
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            r, c = row + dr, col + dc
            jumped = False
            while 0 <= r < XQ_ROWS and 0 <= c < XQ_COLS:
                target = board[r * XQ_COLS + c]
                if not jumped:
                    if target == 0:
                        out.append(r * XQ_COLS + c)
                    else:
                        jumped = True              # 这枚就是炮架
                elif target != 0:
                    if (target > 0) != red:
                        out.append(r * XQ_COLS + c)
                    break
                r += dr
                c += dc
    elif kind == 7:                                # 兵 / 卒：过河才能横走
        add(row + (-1 if red else 1), col)
        crossed = row <= 4 if red else row >= 5
        if crossed:
            add(row, col - 1)
            add(row, col + 1)
    return out


def xq_king_index(board, red):
    target = 1 if red else -1
    for index, piece in enumerate(board):
        if piece == target:
            return index
    return -1


def xq_kings_face(board):
    """将帅照面（同列且中间无子）—— 非法局面。"""
    red_king = xq_king_index(board, True)
    black_king = xq_king_index(board, False)
    if red_king < 0 or black_king < 0:
        return False
    col = red_king % XQ_COLS
    if col != black_king % XQ_COLS:
        return False
    lo, hi = sorted((red_king // XQ_COLS, black_king // XQ_COLS))
    for row in range(lo + 1, hi):
        if board[row * XQ_COLS + col] != 0:
            return False
    return True


def xq_attacked(board, index, by_red):
    for i, piece in enumerate(board):
        if piece == 0 or (piece > 0) != by_red:
            continue
        if index in xq_pseudo_moves(board, i):
            return True
    return False


def xq_in_check(board, red):
    king = xq_king_index(board, red)
    if king < 0:
        return True                                # 老将没了 = 已经被吃
    return xq_attacked(board, king, not red)


def xq_apply(board, src, dst):
    nxt = list(board)
    nxt[dst] = nxt[src]
    nxt[src] = 0
    return nxt


def xq_legal_moves(board, src):
    """过滤掉"走完自己被将军 / 将帅照面"的走法。"""
    piece = board[src]
    if piece == 0:
        return []
    red = piece > 0
    out = []
    for dst in xq_pseudo_moves(board, src):
        nxt = xq_apply(board, src, dst)
        if xq_kings_face(nxt):
            continue
        if xq_in_check(nxt, red):
            continue
        out.append(dst)
    return out


def xq_all_legal_moves(board, red):
    moves = []
    for index, piece in enumerate(board):
        if piece == 0 or (piece > 0) != red:
            continue
        for dst in xq_legal_moves(board, index):
            moves.append((index, dst))
    return moves


def xq_status(board, red):
    """给轮到走棋的一方判断：正常 / 被将军 / 被将死（象棋里"困毙"也算输）。"""
    if not xq_all_legal_moves(board, red):
        return "checkmate"
    return "check" if xq_in_check(board, red) else "playing"


def xq_render(board):
    """给测试/日志看的文字棋盘（红大写在后，黑用小写）。"""
    lines = []
    for row in range(XQ_ROWS):
        cells = []
        for col in range(XQ_COLS):
            piece = board[row * XQ_COLS + col]
            if piece == 0:
                cells.append(".")
            else:
                name = xq_piece_name(piece)
                cells.append(name if piece > 0 else name)
        lines.append(" ".join(cells))
    return "\n".join(lines)
