// defs.js —— 对应 C++ 的 defs.h / Object.h / LocalController.h / util/Id.h 中的常量
// 所有脚本以普通 <script> 顺序加载，顶层声明共享（相当于 C++ 的全局 include）

// ---- 网格与窗口尺寸（defs.h）
var HORIZON_GRID_NUMBER = 11;
var VERTICAL_GRID_NUMBER = 7;
var GRID_SIZE = 60.0;
var GAME_VIEW_WIDTH = HORIZON_GRID_NUMBER * GRID_SIZE;    // 660
var GAME_VIEW_HEIGHT = VERTICAL_GRID_NUMBER * GRID_SIZE;  // 420
var WINDOW_WIDTH = GAME_VIEW_WIDTH + 100;                 // 760（窗口宽，侧栏 +100）
var WINDOW_HEIGHT = GAME_VIEW_HEIGHT;
var MAX_BLOCKS_NUM = (HORIZON_GRID_NUMBER - 1) * VERTICAL_GRID_NUMBER
                   + (VERTICAL_GRID_NUMBER - 1) * HORIZON_GRID_NUMBER; // 136

// ---- A* 网格（与游戏网格一一对应，defs.h）
var A_STAR_GRID_PER_GRID = 1.0;
var A_STAR_GRID_SIZE = GRID_SIZE / A_STAR_GRID_PER_GRID;                   // 60
var HORIZON_A_STAR_GRID_NUMBER = A_STAR_GRID_PER_GRID * HORIZON_GRID_NUMBER;  // 11
var VERTICAL_A_STAR_GRID_NUMBER = A_STAR_GRID_PER_GRID * VERTICAL_GRID_NUMBER; // 7
var MAX_A_STAR_NODE_ID = VERTICAL_A_STAR_GRID_NUMBER * HORIZON_A_STAR_GRID_NUMBER; // 77

// ---- 坐标宏 → 函数（注意 C++ 里 int 截断 = 向零取整，JS 用 Math.trunc 对齐）
function mapRealToGridX(rx) { return rx / GRID_SIZE; }
function mapRealToGridY(ry) { return ry / GRID_SIZE; }
function mapGridToRealX(gx) { return gx * GRID_SIZE + GRID_SIZE / 2; }
function mapGridToRealY(gy) { return gy * GRID_SIZE + GRID_SIZE / 2; }
function mapRealXToAStarX(rx) { return Math.trunc(rx / A_STAR_GRID_SIZE); }
function mapRealYToAStarY(ry) { return Math.trunc(ry / A_STAR_GRID_SIZE); }
function mapAStarXToRealX(ax) { return ax * A_STAR_GRID_SIZE + A_STAR_GRID_SIZE / 2; }
function mapAStarYToRealY(ay) { return ay * A_STAR_GRID_SIZE + A_STAR_GRID_SIZE / 2; }

// ---- 颜色（RGB 0..1，defs.h 宏）
var BLACK = [0, 0, 0];
var RED = [1.0, 0.3, 0.3];
var BLUE = [0.3, 0.3, 1.0];
var GREEN = [0.3, 1.0, 0.3];
var YELLOW = [0.9, 0.9, 0.3];
var GREY = [0.3, 0.3, 0.3];

// ---- 移动状态位掩码（Object.h）
var MOVING_STATIONARY = 1;
var MOVING_FORWARD = 2;
var MOVING_BACKWARD = 4;
var ROTATING_CW = 8;
var ROTATING_CCW = 16;

// ---- 步长与类型（Object.h）
var TANK_MOVING_STEP = 1;
var SHELL_MOVING_STEP = 1;
var OBJ_TANK = 0;
var OBJ_SHELL = 1;

// ---- 尺寸（Tank.h / Block.h / Shell.h）
var TANK_WIDTH = 20;
var TANK_HEIGHT = 28;
var TANK_ROTATING_STEP = 3;   // Tank::ROTATING_STEP
var BLOCK_WIDTH = 4;          // Block::BLOCK_WIDTH
var SHELL_RADIUS = 2.5;       // Shell::RADIUS
var SHELL_INITIAL_TTL = 8;    // Shell::INITIAL_TTL（原版 10：炮弹只靠反弹掉血，10 次反弹
                              // 能飞 10~40 秒，弹夹 5 发打空后要等半天，节奏断成「爆发-哑火」）
var SHELL_MAX_AGE = 800;      // 炮弹时间寿命（tick，8s）—— 到点消失回收，够飞全场 +
                              // 几次反弹；与反弹寿命（8 次）对齐，持续时间一致
var TANK_MAX_SHELLS = 5;      // 弹夹上限：人机与玩家一致，同时在场最多 5 发
                              // （回弹/回收都不能突破 —— 曾涨到 7~8 发）

// ---- 方向八分区（LocalController.h）
var UPWARDS = 0;
var UPWARDS_LEFT = 1;
var LEFT = 2;
var DOWNWARDS_LEFT = 3;
var DOWNWARDS = 4;
var DOWNWARDS_RIGHT = 5;
var RIGHT = 6;
var UPWARDS_RIGHT = 7;

// ---- 坦克 ID 范围（util/Id.h）
var PLAYER_TANK_ID = 1;
var AI_TANK_ID = 2;
var MIN_TANK_ID = 1;
var MAX_TANK_ID = 10;

// ---- 外边界 ID（util/Id.h）
var VERTICAL_BORDER_ID = -1;
var HORIZON_BORDER_ID = -2;

// ---- 触屏摇杆（网页/安卓壳新增，input.js 采集、local-controller 生效）
var JOY_MAX_TRAVEL = 60;      // 摇杆最大行程（px）= 归一化 r 的 2.0（内环边界 30px = r 1.0）
var JOY_DEAD_ZONE = 0.15;     // 中心死区（归一化 r，约 4.5px）
var JOY_ANGLE_SMOOTH = 0.45;  // 输入角度 EMA 系数（0~1，越大越跟手）
var JOY_MIN_SPEED = 0.35;     // 外圈刚过界（r=1）的速度系数（0~1）
var JOY_MAX_SPEED = 1.0;      // 满行程（r=2）的速度系数，1 = 键盘全速
