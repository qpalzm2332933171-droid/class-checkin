// local-controller.js —— 对应 C++ controller/LocalController.h / .cc
// 100Hz 固定步长模拟 + AgentSmith AI。C++ 里跑在独立线程的 ev 事件循环上
// （runEvery 0.01/0.1/0.8），JS 单线程用 10ms 定时器 + tick 计数对齐节奏。

// 外边界矩形中心（LocalController.cc 顶部 static Vec）
var TOP_BORDER_CENTER = new Vec(GAME_VIEW_WIDTH / 2, 2.0);
var LEFT_BORDER_CENTER = new Vec(2.0, GAME_VIEW_HEIGHT / 2);
var BOTTOM_BORDER_CENTER = new Vec(GAME_VIEW_WIDTH / 2, GAME_VIEW_HEIGHT - 2 - 1);
var RIGHT_BORDER_CENTER = new Vec(GAME_VIEW_WIDTH - 2 - 1, GAME_VIEW_HEIGHT / 2);

function LocalController() {
  Controller.call(this);
  this.globalSteps = 0;
  this.danger = 0;
  this.smith = new AgentSmith(this);

  this.playersInfo.set(PLAYER_TANK_ID, new PlayerInfo("你", RED));
  this.playersInfo.set(AI_TANK_ID, new PlayerInfo("Agent Smith", GREY));

  this.maze = new Maze();
  this.deletedObjs = [];
  // 宽相位碰撞表：shellPossibleCollisionBlocks[11][7][8]、tankPossibleCollisionBlocks[11][7]
  this.shellPossibleCollisionBlocks = [];
  this.tankPossibleCollisionBlocks = [];
  for (var i = 0; i < HORIZON_GRID_NUMBER; i++) {
    this.shellPossibleCollisionBlocks.push([]);
    this.tankPossibleCollisionBlocks.push([]);
    for (var j = 0; j < VERTICAL_GRID_NUMBER; j++) {
      this.shellPossibleCollisionBlocks[i].push([]);
      for (var k = 0; k < 8; k++)
        this.shellPossibleCollisionBlocks[i][j].push([]);
      this.tankPossibleCollisionBlocks[i].push([]);
    }
  }

  this.smithDodgeStrategy = null;
  this.smithContactStrategy = null;
  this.smithAttackStrategy = null;
  this.restartTimer = null;
  this.joystick = null;   // 触屏摇杆状态（input.js 挂上，每 tick 生效）

  this.initAll();
}
LocalController.prototype = Object.create(Controller.prototype);
LocalController.prototype.constructor = LocalController;

// C++ 的 start() 起线程跑事件循环；JS 里由 main.js 的 10ms 定时器驱动 moveAll()
LocalController.prototype.start = function () {};

// 停止游戏：清掉挂起的 restart 定时器（C++ 里析构时 join 线程 + Id::reset）
LocalController.prototype.stop = function () {
  if (this.restartTimer) {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
  Id.reset();
};

// 对照 restart(delay)：C++ 是 controlLoop->runAfter(delay, ...)，JS 用 setTimeout
LocalController.prototype.restart = function (delay) {
  if (this.restartTimer) clearTimeout(this.restartTimer);
  this.restartTimer = setTimeout(function () {
    this.restartTimer = null;
    this.globalSteps = 0;
    this.objects.clear();
    this.blocks.clear();
    this.deletedObjs = [];
    for (var i = 0; i < HORIZON_GRID_NUMBER; i++)
      for (var j = 0; j < VERTICAL_GRID_NUMBER; j++) {
        this.tankPossibleCollisionBlocks[i][j].length = 0;
        for (var k = 0; k < 8; k++)
          this.shellPossibleCollisionBlocks[i][j][k].length = 0;
      }
    this.smithDodgeStrategy = null;
    this.smithContactStrategy = null;
    this.smithAttackStrategy = null;
    Id.reset();
    this.initAll();
  }.bind(this), delay * 1000);
};

// 生成迷宫、随机落位两辆坦克、初始化 A* 邻接矩阵
LocalController.prototype.initAll = function () {
  this.initBlocks();
  var pos = LocalController.getRandomPositions(2);
  var tank = new Tank(Id.getTankId(), pos[0].pos, pos[0].angle, RED);
  this.objects.set(tank.id(), tank);
  var smithTank = new Tank(Id.getTankId(), pos[1].pos, pos[1].angle, GREY);
  this.objects.set(smithTank.id(), smithTank);
  this.danger = 0;
  this.smith.initAStar(this.blocks);
  // 重置 Smith 的逐局状态：上一局的时间戳/采样在全局 tick 归零后全部过期
  this.smith.resetRound();
  // 开局就让 Smith 进入追击（原版要等第 80 tick 的首次攻击决策，期间可能一直不动）
  this.updateStrategy(new ChaseStrategy());
};

LocalController.prototype.getSmithPosition = function () {
  var t = this.objects.get(AI_TANK_ID);
  return t ? t.getCurrentPosition() : null;
};

LocalController.prototype.getMyPosition = function () {
  var t = this.objects.get(PLAYER_TANK_ID);
  return t ? t.getCurrentPosition() : null;
};

// 随机选 num 个不同格子作为出生点，朝向随机为 0/90/180/270
LocalController.getRandomPositions = function (num) {
  var pos = [];
  var s = new Set();
  while (s.size < num) {
    var x = getRandomNumber(0, HORIZON_GRID_NUMBER - 1);
    var y = getRandomNumber(0, VERTICAL_GRID_NUMBER - 1);
    s.add(x + "," + y);
  }
  var vals = s.values();
  for (var it = vals.next(); !it.done; it = vals.next()) {
    var parts = it.value.split(",");
    var gx = parseInt(parts[0], 10);
    var gy = parseInt(parts[1], 10);
    var i = getRandomNumber(0, 3);
    pos.push(new PosInfo(new Vec(mapGridToRealX(gx), mapGridToRealY(gy)), i * 90.0));
  }
  return pos;
};

// 玩家输入入口：对照 ControlEvent 的 9 种操作应用到玩家坦克
LocalController.prototype.dispatchEvent = function (op) {
  if (!this.objects.has(PLAYER_TANK_ID)) return;
  var me = this.objects.get(PLAYER_TANK_ID);
  switch (op) {
    case OP_FORWARD: me.forward(true); break;
    case OP_BACKWARD: me.backward(true); break;
    case OP_ROTATE_CW: me.rotateCW(true); break;
    case OP_ROTATE_CCW: me.rotateCCW(true); break;
    case OP_STOP_FORWARD: me.forward(false); break;
    case OP_STOP_BACKWARD: me.backward(false); break;
    case OP_STOP_ROTATE_CW: me.rotateCW(false); break;
    case OP_STOP_ROTATE_CCW: me.rotateCCW(false); break;
    case OP_FIRE: this.fire(me); break;
  }
};

// 更新 AI 当前策略（C++ 里按 Strategy::type 分派到三个 unique_ptr 槽位）
LocalController.prototype.updateStrategy = function (strategy) {
  if (strategy.type() === STRATEGY_DODGE)
    this.smithDodgeStrategy = strategy;
  else if (strategy.type() === STRATEGY_CONTACT)
    this.smithContactStrategy = strategy;
  else this.smithAttackStrategy = strategy;
};

// 开火：扣炮弹数、生成炮弹；随后立即刷新 AI 对局面的弹道认知
LocalController.prototype.fire = function (tank) {
  if (tank.remainShells() === 0) return;
  var shell = tank.makeShell();
  this.objects.set(shell.id(), shell);

  if (!this.objects.has(AI_TANK_ID)) return;
  var smithTank = this.objects.get(AI_TANK_ID);
  var shells = this.smith.getIncomingShells(smithTank.getCurrentPosition());
  this.smith.ballisticsPredict(shells, this.globalSteps);
};

// ---- 每 tick 主循环（对照 moveAll，C++ 的 0.1s/0.8s AI 定时器按 tick 计数折叠进来）
LocalController.prototype.moveAll = function () {
  this.globalSteps++;
  this.deletedObjs = [];
  var attacking = false;

  // 触屏摇杆生效：每 tick 按摇杆状态重写玩家坦克的移动标志（与键盘互斥使用）
  if (this.joystick && this.joystick.active) {
    var me = this.objects.get(PLAYER_TANK_ID);
    if (me) this.applyJoystick(me);
  }

  // C++ 遍历 unordered_map 时 fire() 可能插入新炮弹（是否参与本轮迭代是未定义的）；
  // JS 用键快照遍历，行为确定：新炮弹下一 tick 才开始动
  var keys = Array.from(this.objects.keys());
  for (var ki = 0; ki < keys.length; ki++) {
    var obj = this.objects.get(keys[ki]);
    if (obj.id() === AI_TANK_ID) {
      var smithTank = obj;
      if (this.smithDodgeStrategy) {
        if (this.smithDodgeStrategy.update(this, smithTank, this.globalSteps)) {
          if (this.smithAttackStrategy) this.smithAttackStrategy.cancelAttack();
          this.danger = 100;   // 100：躲完指令后继续专注躲闪 1s（原版 50，躲一下就回头挨打）
        } else this.danger = this.danger === 0 ? this.danger : this.danger - 1;
      }
      if (this.smithAttackStrategy && !this.danger) {
        if (this.smithAttackStrategy.update(this, smithTank, this.globalSteps))
          attacking = true;
      }
      if (this.smithContactStrategy && !this.danger && !attacking) {
        this.smithContactStrategy.update(this, smithTank, this.globalSteps);
      } else if (this.smithContactStrategy && this.danger) {
        // 躲闪期间照常还手：移动交给躲闪指令，瞄准开火走专用通道
        this.smithContactStrategy.updateFireOnly(this, smithTank, this.globalSteps);
      }
    }
    var next = obj.getNextPosition(0, 0);
    var cur = obj.getCurrentPosition();
    var countdown = false;
    if (obj.type() === OBJ_SHELL) {
      var shell = obj;
      shell._age++;
      if (shell.age() > SHELL_MAX_AGE) {
        // 时间寿命到点 → 炮弹消失，弹数归还（只靠反弹掉血能活 10~40s，弹夹回收太慢）
        this.deletedObjs.push(shell.id());
        if (this.objects.has(shell.tankId()))
          this.objects.get(shell.tankId()).getRemainShell();
        continue;
      }
      var id = this.checkShellCollision(cur, next);
      if (id < 0 || id > MAX_TANK_ID) {
        // 撞墙反弹
        obj.resetNextPosition(this.getBouncedPosition(cur, next, id));
        countdown = true;
      } else if (id) {
        // 命中坦克：无反弹过的炮弹不能打自己的坦克
        if ((id !== shell.tankId() || shell.ttl() < SHELL_INITIAL_TTL)) {
          this.deletedObjs.push(id);
          this.deletedObjs.push(shell.id());
          if (id === PLAYER_TANK_ID) this.playersInfo.get(AI_TANK_ID).score_++;
          else this.playersInfo.get(PLAYER_TANK_ID).score_++;
          this.restart(1.0);
          break;
        }
      }
      // 反弹次数耗尽 → 炮弹消失，弹数归还
      if (countdown && shell.countDown() <= 0) {
        this.deletedObjs.push(shell.id());
        if (this.objects.has(shell.tankId()))
          this.objects.get(shell.tankId()).getRemainShell();
      }
    } else {
      // 坦克撞墙：沿墙滑行 —— 玩家车头平滑转向顺墙拐弯，Smith 朝玩家方向滑（追击不停顿）
      var tank = obj;
      var bid = this.checkTankBlockCollision(cur, next);
      if (bid) obj.resetNextPosition(this.getSlidePosition(cur, next, bid, tank.id() === AI_TANK_ID));
    }
    obj.moveToNextPosition();
  }
  for (var di = 0; di < this.deletedObjs.length; di++)
    this.objects.delete(this.deletedObjs[di]);

  // C++ runEvery(0.1)：弹道预测 + 躲避决策（第 10、20…tick 后）
  if (this.globalSteps % 10 === 0) {
    var smithPos = this.getSmithPosition();
    if (smithPos) {
      var shells = this.smith.getIncomingShells(smithPos);
      this.smith.ballisticsPredict(shells, this.globalSteps);
      this.smith.getDodgeStrategy(smithPos, this.globalSteps);
    }
  }
  // C++ runEvery(0.8)：攻击决策（第 80、160…tick 后）
  if (this.globalSteps % 80 === 0) {
    var sp = this.getSmithPosition();
    var myPos = this.getMyPosition();
    if (sp && myPos) this.smith.attack(sp, myPos, this.globalSteps);
  }
};

// ---- 碰撞检测（逐行对照 C++）

LocalController.prototype.checkShellCollision = function (curPos, nextPos) {
  var collisionBlock = this.checkShellBlockCollision(curPos, nextPos);
  if (collisionBlock) return collisionBlock;
  return this.checkShellTankCollision(curPos, nextPos);
};

LocalController.prototype.checkShellBlockCollision = function (curPos, nextPos) {
  // 外边界（-1 竖边、-2 横边）
  if (nextPos.pos.x() < SHELL_RADIUS + BLOCK_WIDTH ||
      nextPos.pos.x() > GAME_VIEW_WIDTH - 1 - BLOCK_WIDTH)
    return VERTICAL_BORDER_ID;
  if (nextPos.pos.y() < SHELL_RADIUS + BLOCK_WIDTH ||
      nextPos.pos.y() > GAME_VIEW_HEIGHT - 1 - BLOCK_WIDTH)
    return HORIZON_BORDER_ID;

  // 按角度查八分区方向，再查该格该方向的候选墙（宽相位）
  var gridX = Math.trunc(curPos.pos.x() / GRID_SIZE);
  var gridY = Math.trunc(curPos.pos.y() / GRID_SIZE);
  var degreeRange = [0.0, 90.0, 180.0, 270.0, 360.0];
  var directions = [RIGHT, UPWARDS_RIGHT, UPWARDS, UPWARDS_LEFT,
                     LEFT, DOWNWARDS_LEFT, DOWNWARDS, DOWNWARDS_RIGHT];
  var dir = 0;
  for (var i = 0; i < 4; i++) {
    if (curPos.angle === degreeRange[i]) { dir = directions[2 * i]; break; }
    else if (curPos.angle > degreeRange[i] && curPos.angle < degreeRange[i + 1]) {
      dir = directions[2 * i + 1];
      break;
    }
  }
  var candidates = this.shellPossibleCollisionBlocks[gridX][gridY][dir];
  for (var ci = 0; ci < candidates.length; ci++) {
    var block = this.blocks.get(candidates[ci]);
    var v1 = block.isHorizon() ? new Vec(1, 0) : new Vec(0, 1);
    var v2 = block.isHorizon() ? new Vec(0, 1) : new Vec(1, 0);
    if (checkRectCircleCollision(v1, v2, block.center(), nextPos.pos,
                                 block.width(), block.height(), SHELL_RADIUS))
      return block.id();
  }
  return 0;
};

LocalController.prototype.checkShellTankCollision = function (curPos, nextPos) {
  for (var id = MIN_TANK_ID; id <= MAX_TANK_ID; id++) {
    if (!this.objects.has(id)) continue;
    var tank = this.objects.get(id);
    var axis = getUnitVectors(tank.getCurrentPosition().angle);
    if (checkRectCircleCollision(axis.first, axis.second, tank.getCurrentPosition().pos,
                                 nextPos.pos, TANK_WIDTH - 2, TANK_HEIGHT - 2, SHELL_RADIUS))
      return id;
  }
  return 0;
};

LocalController.prototype.checkTankBlockCollision = function (curPos, nextPos) {
  return this.checkTankBlockCollisionExcept(curPos, nextPos, 0);
};

// 同上，但排除 excludeId 那面墙（滑行时沿被撞的墙滑动，车身擦墙不算新碰撞）；
// exceptVertical/exceptHorizontal 同理排除左右/上下外边界（沿外边界滑行用）。
// 注意：排除只对切线方向的滑行安全 —— 往墙里/边界外的移动绝不能排除
LocalController.prototype.checkTankBlockCollisionExcept = function (curPos, nextPos, excludeId,
                                                                    exceptVertical, exceptHorizontal) {
  var gridX = Math.trunc(curPos.pos.x() / GRID_SIZE);
  var gridY = Math.trunc(curPos.pos.y() / GRID_SIZE);
  var candidates = this.tankPossibleCollisionBlocks[gridX][gridY];
  for (var ci = 0; ci < candidates.length; ci++) {
    if (candidates[ci] === excludeId) continue;
    var block = this.blocks.get(candidates[ci]);
    var blockAngle = block.isHorizon() ? 0.0 : 90.0;
    if (checkRectRectCollision(blockAngle, block.center(), block.width(), block.height(),
                               nextPos.angle, nextPos.pos, TANK_WIDTH, TANK_HEIGHT))
      return block.id();
  }
  // 四条外边界（上下边界原版也返回 VERTICAL_BORDER_ID，对坦克只表示"被挡住"，照搬）
  if (!exceptVertical &&
      (checkRectRectCollision(90.0, LEFT_BORDER_CENTER, 4.0, GAME_VIEW_HEIGHT,
                              nextPos.angle, nextPos.pos, TANK_WIDTH, TANK_HEIGHT) ||
       checkRectRectCollision(90.0, RIGHT_BORDER_CENTER, 4.0, GAME_VIEW_HEIGHT,
                              nextPos.angle, nextPos.pos, TANK_WIDTH, TANK_HEIGHT)))
    return VERTICAL_BORDER_ID;
  if (!exceptHorizontal &&
      (checkRectRectCollision(0.0, TOP_BORDER_CENTER, 4.0, GAME_VIEW_WIDTH,
                              nextPos.angle, nextPos.pos, TANK_WIDTH, TANK_HEIGHT) ||
       checkRectRectCollision(0.0, BOTTOM_BORDER_CENTER, 4.0, GAME_VIEW_WIDTH,
                              nextPos.angle, nextPos.pos, TANK_WIDTH, TANK_HEIGHT)))
    return VERTICAL_BORDER_ID;
  return 0;
};

// 反弹位置与角度：外边界按轴翻转；墙段找与 cur→next 线段的交点
LocalController.prototype.getBouncedPosition = function (cur, next, blockId) {
  var bounced = new PosInfo(new Vec(next.pos.x(), next.pos.y()), next.angle);
  if (blockId < 0) {
    bounced.angle = blockId === VERTICAL_BORDER_ID ? angleFlipY(next.angle) : angleFlipX(next.angle);
    return bounced;
  }
  var block = this.blocks.get(blockId);
  for (var i = 0; i < 4; i++) {
    var b = block.border(i);
    var out = { v: null };
    if (!intersectionOfSegments(cur.pos, next.pos, b[0], b[1], out)) continue;
    bounced.pos = out.v;
    if (i < 2) bounced.angle = angleFlipX(cur.angle);
    else bounced.angle = angleFlipY(cur.angle);
  }
  return bounced;
};

// 撞墙后沿墙滑行（Tank Trouble 风格）：把本帧位移投影到墙的切线方向，只改位置
// 不改车头 —— 车头永远只跟玩家/AI 的转向输入，撞墙滑行不转头（之前会顺着墙转头
// 拐弯，往前开却自己转回来，物理上很怪，删掉）。拐角平滑 = 主切线被挡时改试垂直切线。
// Smith（forSmith）：固定选边沿墙滑、垂直顶墙按满步长，配合 ChaseStrategy 追击绕墙。
LocalController.prototype.getSlidePosition = function (cur, next, blockId, forSmith) {
  // 保留本帧的转向（next.angle 已含 movingStatus 的旋转）—— 否则滑行时旋转丢失，
  // Smith 逃跑的原地转永远转不动，卡在墙角出不来
  var slide = new PosInfo(new Vec(cur.pos.x(), cur.pos.y()), next.angle);
  var dir = next.pos.minus(cur.pos);
  // 主切线：迷宫墙段按墙朝向；外边界按车位置（左右边 → 沿 y 滑，上下边 → 沿 x 滑）
  var tan = new Vec(1, 0);
  if (blockId > 0) {
    if (!this.blocks.get(blockId).isHorizon()) tan = new Vec(0, 1);
  } else if (cur.pos.x() < 20 || cur.pos.x() > GAME_VIEW_WIDTH - 20) {
    tan = new Vec(0, 1);
  }
  var axes = [tan, new Vec(-tan.y(), tan.x())];
  var slid = false;
  for (var ai = 0; ai < 2 && !slid; ai++) {
    var axis = axes[ai];
    var dot = dir.dot(axis);
    var d = Math.abs(dot);
    var heads = [dot >= 0 ? axis : new Vec(-axis.x(), -axis.y())];
    if (forSmith) {
      // Smith：垂直顶墙没有切向分量时按满步长滑，追击不停
      if (d < 1e-6) d = TANK_MOVING_STEP;
      // 「沿墙」固定选边（cross 符号 × followSide，逃跑时翻转）：斜顶墙时选边只由
      // 玩家在垂线哪一侧决定，不比较离玩家的远近 —— 贪心比较会在玩家垂直方向时
      // ±1px 来回抖，永远到不了。追到墙端前方无墙自然脱离
      var followSide = this.smithContactStrategy ? this.smithContactStrategy.followSide : 1;
      if (d < 0.9 && dir.cross(axis) * followSide < 0) heads[0] = new Vec(-axis.x(), -axis.y());
      // 选边被挡（拐角两墙夹着楔死）就试反向 —— 那是唯一出口
      heads.push(new Vec(-heads[0].x(), -heads[0].y()));
    } else if (ai === 0 && d < 1e-6) {
      // 玩家垂直顶墙：选离车头近的那条切线（固定选边，不逐 tick 横跳）
      var a0 = vector2Angle(axis), a1 = (a0 + 180) % 360;
      var d0 = Math.abs(((a0 - cur.angle + 540) % 360) - 180);
      var d1 = Math.abs(((a1 - cur.angle + 540) % 360) - 180);
      if (d1 < d0) heads[0] = new Vec(-axis.x(), -axis.y());
    }
    if (d < 1e-6) continue;   // 该切线没有可滑分量
    for (var hi = 0; hi < heads.length; hi++) {
      var head = heads[hi];
      var tried = new PosInfo(
        new Vec(cur.pos.x() + head.x() * d, cur.pos.y() + head.y() * d), slide.angle);
      // 主切线沿墙滑：碰撞检查排除撞上的那面墙/外边界（车头擦着墙滑是合法的，不越压越深）；
      // 垂直切线是往墙里/拐角另一侧走，必须全查
      var hit = 0;
      if (ai === 0) {
        hit = blockId > 0
          ? this.checkTankBlockCollisionExcept(cur, tried, blockId)
          : this.checkTankBlockCollisionExcept(cur, tried, 0,
              Math.abs(tan.y()) > 0, Math.abs(tan.x()) > 0);
      } else {
        hit = this.checkTankBlockCollision(cur, tried);
      }
      if (hit === 0) { slide.pos = tried.pos; slid = true; break; }
    }
  }
  return slide;
};

// 触屏摇杆 → 玩家坦克：内圈只转向，外圈转向 + 前进（r 越大越快，节流累加器调速）
LocalController.prototype.applyJoystick = function (tank) {
  var joy = this.joystick;
  tank.stop();
  if (joy.r <= JOY_DEAD_ZONE) return;   // 中心死区：不动
  var cur = tank.getCurrentPosition();
  var target = Math.trunc(joy.smoothAngle) % 360;
  var diff = ((target - cur.angle + 540) % 360) - 180;   // -180..180，正 = 逆时针
  if (diff >= TANK_ROTATING_STEP) tank.rotateCCW(true);
  else if (diff <= -TANK_ROTATING_STEP) tank.rotateCW(true);
  if (joy.r > 1) {
    var speed = JOY_MIN_SPEED + (JOY_MAX_SPEED - JOY_MIN_SPEED) * Math.min(1, joy.r - 1);
    joy.moveAcc += speed;
    if (joy.moveAcc >= 1) { joy.moveAcc -= 1; tank.forward(true); }
  }
};

// 生成迷宫墙并建立空间哈希碰撞表（对照 initBlocks 的六格邻域分配）
LocalController.prototype.initBlocks = function () {
  this.maze.generate();
  var blockPositions = this.maze.getBlockPositions();
  for (var bi = 0; bi < blockPositions.length; bi++) {
    var b = blockPositions[bi];
    var block = new Block(Id.getBlockId(), b[0], b[1]);
    this.blocks.set(block.id(), block);
    var gx = (block.start().x() - GRID_SIZE / 2 > 0)
      ? Math.trunc((block.start().x() - GRID_SIZE / 2) / GRID_SIZE) : -1;
    var gy = (block.start().y() - GRID_SIZE / 2 > 0)
      ? Math.trunc((block.start().y() - GRID_SIZE / 2) / GRID_SIZE) : -1;
    if (block.isHorizon()) {
      if (gx >= 0) {
        // 左上
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_RIGHT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][RIGHT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
        // 左下
        gy += 1;
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_RIGHT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][RIGHT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
        gy -= 1;
      }
      // 上中
      gx += 1;
      this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_RIGHT].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_LEFT].push(block.id());
      this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
      // 下中
      gy += 1;
      this.shellPossibleCollisionBlocks[gx][gy][UPWARDS].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_RIGHT].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_LEFT].push(block.id());
      this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
      gy -= 1; gx += 1;
      if (gx < HORIZON_GRID_NUMBER) {
        // 右上
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_LEFT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][LEFT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
        // 右下
        gy += 1;
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_LEFT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][LEFT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
      }
    } else {
      if (gy >= 0) {
        // 左上
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_RIGHT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][RIGHT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
        // 右上
        gx += 1;
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_LEFT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][LEFT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
        gx -= 1;
      }
      // 左中
      gy += 1;
      this.shellPossibleCollisionBlocks[gx][gy][RIGHT].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_RIGHT].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_RIGHT].push(block.id());
      this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
      // 右中
      gx += 1;
      this.shellPossibleCollisionBlocks[gx][gy][LEFT].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_LEFT].push(block.id());
      this.shellPossibleCollisionBlocks[gx][gy][DOWNWARDS_LEFT].push(block.id());
      this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
      gx -= 1; gy += 1;
      if (gy < VERTICAL_GRID_NUMBER) {
        // 左下
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][RIGHT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_RIGHT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
        // 右下
        gx += 1;
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][LEFT].push(block.id());
        this.shellPossibleCollisionBlocks[gx][gy][UPWARDS_LEFT].push(block.id());
        this.tankPossibleCollisionBlocks[gx][gy].push(block.id());
      }
    }
  }
};
