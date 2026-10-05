// smithai/agent-smith.js —— 对应 C++ smithAI/AgentSmith.h / .cc（AI 大脑：
// 弹道预测、威胁排序、三种躲避策略、瞄准开火、A* 追击）

var LEFT_SIDE = 0;
var RIGHT_SIDE = 1;

// AgentSmith::KeyPoint —— [step, Vec]
// AgentSmith::BallisticSegment
function BallisticSegment(id, seq, s, e, len, a, dis) {
  this.shellId = id;
  this.seq = seq;
  this.start = s;      // KeyPoint
  this.end = e;        // KeyPoint
  this.length = len;
  this.angle = a;
  this.distanceToTarget = dis;
  this.center = new Vec((s[1].x() + e[1].x()) / 2, (s[1].y() + e[1].y()) / 2);
}

BallisticSegment.invalid = function () {
  return new BallisticSegment(-1, -1, [0, new Vec()], [0, new Vec()], 0, 0, 0);
};

BallisticSegment.prototype.isValid = function () { return this.shellId !== -1; };

var AGENT_SMITH_MAX_PREDICT_STEP = 500;   // 500：弹道预测拉满 5s，长程折射瞄得到（原版 150）
var AGENT_SMITH_THREATENED_RANGE = 220;   // 220：更早看到炮弹，提前开躲（原版 150）
var AGENT_SMITH_FIRE_CD = 120;            // 开火冷却（tick，1.2s；原版 60）。对齐 5 发弹夹 +
                                          // 6s 炮弹寿命的经济：5/6s ≈ 0.83 发/秒 —— 打一发的
                                          // 间隔里刚好有炮弹到期回收，弹夹稳定循环，
                                          // 不爆发、不哑火，也不超过 5 发在场

var CHECK_RESULT_SAFE = 0;
var CHECK_RESULT_DIE = 1;
var CHECK_RESULT_UNKNOWN = 2;

function AgentSmith(ctl) {
  this.ctl = ctl;
  this.aStar = new AStar();
  this.prevFireTime = -1000;
  this.prevThreat = BallisticSegment.invalid();
  this.dangerSegment = BallisticSegment.invalid();

  this.ballistics = new Map();   // Ballistics: shellId -> Ballistic
  this.smithPos = new PosInfo();
  this.threats = [];
  this.potentialThreats = new Set();

  this.enemySamples = [];        // 玩家位置采样 [[tick, Vec]×2]，算速度做提前量
  this.prevSampleTick = -999;
}

// 150 单位内的敌方炮弹（AI 自己刚出膛的忽略）
AgentSmith.prototype.getIncomingShells = function (cur) {
  var shells = new Map();
  var entries = this.ctl.objects.entries();
  for (var it = entries.next(); !it.done; it = entries.next()) {
    var entry = it.value;
    var obj = entry[1];
    if (obj.type() === OBJ_SHELL) {
      if (obj.tankId() === AI_TANK_ID && obj.ttl() === SHELL_INITIAL_TTL) continue;
      var shellPos = obj.getCurrentPosition();
      if (distanceOfTwoPoints(shellPos.pos, cur.pos) <= AGENT_SMITH_THREATENED_RANGE)
        shells.set(entry[0], shellPos);
    }
  }
  return shells;
};

// 模拟一条弹道：最多 150 tick，遇到墙按反弹角折返，每段一个 BallisticSegment
AgentSmith.prototype.ballisticPredict = function (shell, ballistic, globalSteps) {
  var seq = 1;
  var cur = shell[1];
  var startKp = [globalSteps, cur.pos];
  for (var i = 0; i < AGENT_SMITH_MAX_PREDICT_STEP - 1; i++) {
    var next = Shell.nextPosition(cur, 0, 0);
    var collisionId = this.ctl.checkShellBlockCollision(cur, next);
    if (collisionId) {
      next = this.ctl.getBouncedPosition(cur, next, collisionId);
      var endKp = [globalSteps + i + 1, next.pos];
      ballistic.push(new BallisticSegment(shell[0], seq++, startKp, endKp,
        distanceOfTwoPoints(startKp[1], endKp[1]), cur.angle, 0.0));
      startKp = endKp;
    }
    cur = next;
  }
  var endKpLast = [globalSteps + AGENT_SMITH_MAX_PREDICT_STEP, cur.pos];
  ballistic.push(new BallisticSegment(shell[0], seq++, startKp, endKpLast,
    distanceOfTwoPoints(startKp[1], endKpLast[1]), cur.angle, 0.0));
};

AgentSmith.prototype.ballisticsPredict = function (shells, globalSteps) {
  this.ballistics.clear();
  var entries = shells.entries();
  for (var it = entries.next(); !it.done; it = entries.next()) {
    var shell = it.value;
    var ballistic = [];
    this.ballisticPredict(shell, ballistic, globalSteps);
    this.ballistics.set(shell[0], ballistic);
  }
};

// 按移动状态推演一步，判断会不会死
AgentSmith.prototype.safeToMove = function (globalSteps, cur, movingStatus) {
  var next = Tank.nextPosition(cur, movingStatus, 0, 0);
  return this.checkWillDie(globalSteps + 1, next) !== CHECK_RESULT_DIE;
};

// 弹道线性插值：第 step 帧炮弹位置
AgentSmith.prototype.getShellPosition = function (id, step) {
  var ballistic = this.ballistics.get(id);
  if (!ballistic) return PosInfo.invalid();
  for (var i = 0; i < ballistic.length; i++) {
    var segment = ballistic[i];
    if (segment.end[0] < step) continue;
    var start = segment.start[1];
    var end = segment.end[1];
    var span = segment.end[0] - segment.start[0];
    var pos = new Vec((step - segment.start[0]) * (end.x() - start.x()) / span + start.x(),
                      (step - segment.start[0]) * (end.y() - start.y()) / span + start.y());
    return new PosInfo(pos, segment.angle);
  }
  return PosInfo.invalid();
};

AgentSmith.prototype.checkFeasible = function (step, tryPos) {
  if (this.ctl.checkTankBlockCollision(tryPos, tryPos) !== 0) return false;
  return this.checkWillDie(step, tryPos) === CHECK_RESULT_SAFE;
};

AgentSmith.prototype.checkWillDie = function (step, pos) {
  var axis = getUnitVectors(pos.angle);
  var threats = this.potentialThreats.values();
  for (var it = threats.next(); !it.done; it = threats.next()) {
    var id = it.value;
    var p = this.getShellPosition(id, step);
    if (!p.isValid()) return CHECK_RESULT_UNKNOWN;
    if (checkRectCircleCollision(axis.first, axis.second, pos.pos, p.pos,
                                 TANK_WIDTH, TANK_HEIGHT, SHELL_RADIUS))
      return CHECK_RESULT_DIE;
  }
  return CHECK_RESULT_SAFE;
};

AgentSmith.segmentCmp = function (s1, s2) {
  if (s1.shellId === s2.shellId) return s1.seq - s2.seq;
  return s1.distanceToTarget - s2.distanceToTarget;
};

// 原地转向躲弹：CW / CCW 各试 59 步，取步数最少的可行方案
AgentSmith.prototype.tryRotation = function (globalSteps) {
  var tryPos = new PosInfo(new Vec(this.smithPos.pos.x(), this.smithPos.pos.y()), this.smithPos.angle);
  var step = globalSteps + 1;
  var segment = this.threats[0];
  var strategies = [];
  for (var r = 0; r < Math.trunc(179 / TANK_ROTATING_STEP); r++, step++) {
    tryPos.angle = Math.trunc(360 + tryPos.angle - TANK_ROTATING_STEP) % 360;
    if (!this.checkFeasible(step, tryPos)) break;
    if (!checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                                tryPos.angle, tryPos.pos, TANK_WIDTH, TANK_HEIGHT)) {
      if (checkRectRectCollision(this.dangerSegment.angle, this.dangerSegment.center,
                                 2 * SHELL_RADIUS, this.dangerSegment.length,
                                 tryPos.angle, tryPos.pos, TANK_WIDTH, TANK_HEIGHT))
        continue;
      var strategy = new DodgeStrategy(step - globalSteps);
      strategy.addCmd(new DodgeCommand(DODGE_CMD_ROTATE_CW, step - globalSteps, 0));
      strategies.push(strategy);
      break;
    }
  }
  tryPos = new PosInfo(new Vec(this.smithPos.pos.x(), this.smithPos.pos.y()), this.smithPos.angle);
  step = globalSteps + 1;
  for (r = 0; r < Math.trunc(179 / TANK_ROTATING_STEP); r++, step++) {
    tryPos.angle = Math.trunc(tryPos.angle + TANK_ROTATING_STEP) % 360;
    if (!this.checkFeasible(step, tryPos)) break;
    if (!checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                                tryPos.angle, tryPos.pos, TANK_WIDTH, TANK_HEIGHT)) {
      if (checkRectRectCollision(this.dangerSegment.angle, this.dangerSegment.center,
                                 2 * SHELL_RADIUS, this.dangerSegment.length,
                                 tryPos.angle, tryPos.pos, TANK_WIDTH, TANK_HEIGHT))
        continue;
      var strategy2 = new DodgeStrategy(step - globalSteps);
      strategy2.addCmd(new DodgeCommand(DODGE_CMD_ROTATE_CCW, step - globalSteps, 0));
      strategies.push(strategy2);
      break;
    }
  }
  if (!strategies.length) return new DodgeStrategy();
  strategies.sort(function (a, b) { return a.needStep - b.needStep; });
  return strategies[0];
};

// 沿 direction 直行试 50 步，看能否脱离威胁线
AgentSmith.prototype.tryMovingStraight = function (globalSteps, direction, cur, out) {
  var step = globalSteps + 1;
  var tryPos = new PosInfo(new Vec(cur.pos.x(), cur.pos.y()), cur.angle);
  var success = false;
  var segment = this.threats[0];
  for (var s = 0; s < 50; s++, step++) {
    tryPos = Tank.nextPosition(tryPos, direction, 0, 0);
    if (!this.checkFeasible(step, tryPos)) break;
    if (!checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                                tryPos.angle, tryPos.pos, TANK_WIDTH, TANK_HEIGHT)) {
      if (checkRectRectCollision(this.dangerSegment.angle, this.dangerSegment.center,
                                 2 * SHELL_RADIUS, this.dangerSegment.length,
                                 tryPos.angle, tryPos.pos, TANK_WIDTH, TANK_HEIGHT))
        continue;
      success = true;
      break;
    }
  }
  out.v = step - globalSteps;
  return success;
};

// 边转边开（最多转 90°），每 angleGran 步检查一次是否脱险
AgentSmith.prototype.movingCurve = function (globalSteps, direction, rotation, cur, angleGran,
                                             outRotating, outStraight) {
  var segment = this.threats[0];
  var tryPos = new PosInfo(new Vec(cur.pos.x(), cur.pos.y()), cur.angle);
  var step = globalSteps;
  var maxTryingStep = 0;
  var bestRotatingStep = 0;
  var bestStraightStep = 0;
  var cnt = 0;

  for (var i = 0; i < 90 / TANK_ROTATING_STEP; i++) {
    step++; cnt++;
    tryPos = Tank.nextPosition(tryPos, direction | rotation, 0, 0);
    if (!this.checkFeasible(step, tryPos)) {
      if (step - globalSteps > maxTryingStep) {
        maxTryingStep = step - globalSteps;
        bestRotatingStep = step - globalSteps;
      }
      break;
    }
    if (cnt % angleGran) continue;
    if (!checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                                tryPos.angle, tryPos.pos, TANK_WIDTH, TANK_HEIGHT)) {
      outRotating.v = step - globalSteps;
      return true;
    }
    var outS = { v: 0 };
    if (this.tryMovingStraight(step, direction, tryPos, outS)) {
      outRotating.v = step - globalSteps;
      outStraight.v = outS.v;
      return true;
    } else if ((step - globalSteps) + outS.v > maxTryingStep) {
      maxTryingStep = (step - globalSteps) + outS.v;
      bestRotatingStep = step - globalSteps;
      bestStraightStep = outS.v;
    }
  }
  outRotating.v = bestRotatingStep;
  outStraight.v = bestStraightStep;
  return false;
};

// 边转边开策略（走弧线），方向按坦克当前朝向与炮弹方向的夹角选择
AgentSmith.prototype.tryRotatingWithMoving = function (globalSteps) {
  var segment = this.threats[0];
  var v1 = getUnitVector(segment.angle);
  var v2 = this.smithPos.pos.minus(segment.start[1]);
  var vt = getUnitVector(this.smithPos.angle);
  var strategy = new DodgeStrategy();
  var direction = angleBetweenVectors(vt, v1) <= 90.0 ? MOVING_FORWARD : MOVING_BACKWARD;
  var bestRotatingStep = 0;
  var bestStraightStep = 0;
  var bestRotationOp;
  var bestMoveOp = direction === MOVING_FORWARD ? DODGE_CMD_MOVE_FORWARD : DODGE_CMD_MOVE_BACKWARD;
  var rs = { v: 0 };
  var ms = { v: 0 };
  var rotateCwOp = direction === MOVING_FORWARD ? DODGE_CMD_FORWARD_CW : DODGE_CMD_BACKWARD_CW;
  var rotateCcwOp = direction === MOVING_FORWARD ? DODGE_CMD_FORWARD_CCW : DODGE_CMD_BACKWARD_CCW;
  bestRotationOp = rotateCwOp;
  if (this.movingCurve(globalSteps, direction, ROTATING_CW, this.smithPos, 2, rs, ms)) {
    strategy.addCmd(new DodgeCommand(rotateCwOp, rs.v, 0));
    if (ms.v > 0) strategy.addCmd(new DodgeCommand(bestMoveOp, ms.v, 0));
    return strategy;
  }
  bestRotatingStep = rs.v;
  bestStraightStep = ms.v;
  rs = { v: 0 }; ms = { v: 0 };
  if (this.movingCurve(globalSteps, direction, ROTATING_CCW, this.smithPos, 2, rs, ms)) {
    strategy.addCmd(new DodgeCommand(rotateCcwOp, rs.v, 0));
    if (ms.v > 0) strategy.addCmd(new DodgeCommand(bestMoveOp, ms.v, 0));
    return strategy;
  }
  if (rs.v + ms.v > bestRotatingStep + bestStraightStep) {
    bestRotationOp = rotateCcwOp;
    bestRotatingStep = rs.v;
    bestStraightStep = ms.v;
  }
  strategy.addCmd(new DodgeCommand(bestRotationOp, bestRotatingStep, 0));
  if (bestStraightStep > 0) strategy.addCmd(new DodgeCommand(bestMoveOp, bestStraightStep, 0));
  return strategy;
};

// 转向 + 侧移躲弹（先试直行，再 CCW/CW 转向后直行）
AgentSmith.prototype.dodgeToSide = function (globalSteps, cur, whichSide, angleGran) {
  var strategy = new DodgeStrategy();
  var tryPos = new PosInfo(new Vec(cur.pos.x(), cur.pos.y()), cur.angle);
  var segment = this.threats[0];
  var v1 = getUnitVector(segment.angle);
  var vt = getUnitVector(tryPos.angle);
  var pointingToSameSide = (whichSide === RIGHT_SIDE && v1.cross(vt) > 0) ||
                           (whichSide === LEFT_SIDE && v1.cross(vt) < 0);
  var stop = false;
  var direction;
  if (v1.cross(vt) !== 0)
    direction = pointingToSameSide ? MOVING_FORWARD : MOVING_BACKWARD;
  else direction = angleBetweenVectors(v1, vt) <= 90.0 ? MOVING_FORWARD : MOVING_BACKWARD;
  var moveOp = direction === MOVING_FORWARD ? DODGE_CMD_MOVE_FORWARD : DODGE_CMD_MOVE_BACKWARD;
  var outS = { v: 0 };
  if (this.tryMovingStraight(globalSteps, direction, tryPos, outS)) {
    strategy.addCmd(new DodgeCommand(moveOp, outS.v, 0));
    stop = true;
  }
  if (stop) return strategy;
  var step = globalSteps;
  var cnt = 0;
  for (var i = 0; i < 90 / TANK_ROTATING_STEP; i++) {
    step++; cnt++;
    tryPos.angle = Math.trunc(tryPos.angle + TANK_ROTATING_STEP) % 360;
    if (!this.checkFeasible(step, tryPos)) break;
    if (cnt % angleGran) continue;
    var vn = getUnitVector(tryPos.angle);
    if (v1.cross(vn) * v1.cross(vt) > 0) {
      moveOp = pointingToSameSide ? DODGE_CMD_MOVE_FORWARD : DODGE_CMD_MOVE_BACKWARD;
      direction = pointingToSameSide ? MOVING_FORWARD : MOVING_BACKWARD;
    } else if (v1.cross(vn) * v1.cross(vt) < 0) {
      moveOp = pointingToSameSide ? DODGE_CMD_MOVE_BACKWARD : DODGE_CMD_MOVE_FORWARD;
      direction = pointingToSameSide ? MOVING_BACKWARD : MOVING_FORWARD;
    } else {
      if (v1.cross(vn) === 0) continue;
      else {
        direction = ((whichSide === RIGHT_SIDE && v1.cross(vn) > 0) ||
                     (whichSide === LEFT_SIDE && v1.cross(vn) < 0))
          ? MOVING_FORWARD : MOVING_BACKWARD;
        moveOp = direction === MOVING_FORWARD ? DODGE_CMD_MOVE_FORWARD : DODGE_CMD_MOVE_BACKWARD;
      }
    }
    var outS2 = { v: 0 };
    if (this.tryMovingStraight(step, direction, tryPos, outS2)) {
      strategy.addCmd(new DodgeCommand(DODGE_CMD_ROTATE_CCW, step - globalSteps, 0));
      strategy.addCmd(new DodgeCommand(moveOp, outS2.v, 0));
      stop = true;
      break;
    }
  }
  if (stop) return strategy;
  step = globalSteps; cnt = 0;
  tryPos = new PosInfo(new Vec(cur.pos.x(), cur.pos.y()), cur.angle);
  for (i = 0; i < 90 / TANK_ROTATING_STEP; i++) {
    step++; cnt++;
    tryPos.angle = Math.trunc(360 + tryPos.angle - TANK_ROTATING_STEP) % 360;
    if (!this.checkFeasible(step, tryPos)) break;
    if (cnt % angleGran) continue;
    var vn2 = getUnitVector(tryPos.angle);
    if (v1.cross(vn2) * v1.cross(vt) > 0) {
      moveOp = pointingToSameSide ? DODGE_CMD_MOVE_FORWARD : DODGE_CMD_MOVE_BACKWARD;
      direction = pointingToSameSide ? MOVING_FORWARD : MOVING_BACKWARD;
    } else if (v1.cross(vn2) * v1.cross(vt) < 0) {
      moveOp = pointingToSameSide ? DODGE_CMD_MOVE_BACKWARD : DODGE_CMD_MOVE_FORWARD;
      direction = pointingToSameSide ? MOVING_BACKWARD : MOVING_FORWARD;
    } else {
      if (v1.cross(vn2) === 0) continue;
      else {
        direction = ((whichSide === RIGHT_SIDE && v1.cross(vn2) > 0) ||
                     (whichSide === LEFT_SIDE && v1.cross(vn2) < 0))
          ? MOVING_FORWARD : MOVING_BACKWARD;
        moveOp = direction === MOVING_FORWARD ? DODGE_CMD_MOVE_FORWARD : DODGE_CMD_MOVE_BACKWARD;
      }
    }
    var outS3 = { v: 0 };
    if (this.tryMovingStraight(step, direction, tryPos, outS3)) {
      strategy.addCmd(new DodgeCommand(DODGE_CMD_ROTATE_CW, step - globalSteps, 0));
      strategy.addCmd(new DodgeCommand(moveOp, outS3.v, 0));
      stop = true;
      break;
    }
  }
  return strategy;
};

// 选择躲闪侧：按炮弹相对位置先试一侧，不行再试另一侧
AgentSmith.prototype.tryRotatingAndMoving = function (globalSteps) {
  var segment = this.threats[0];
  var v1 = getUnitVector(segment.angle);
  var v2 = this.smithPos.pos.minus(segment.start[1]);
  var strategy;
  if (v1.cross(v2) >= 0) {
    strategy = this.dodgeToSide(globalSteps, this.smithPos, RIGHT_SIDE, 2);
    if (!strategy.isValid())
      strategy = this.dodgeToSide(globalSteps, this.smithPos, LEFT_SIDE, 2);
  } else {
    strategy = this.dodgeToSide(globalSteps, this.smithPos, LEFT_SIDE, 2);
    if (!strategy.isValid())
      strategy = this.dodgeToSide(globalSteps, this.smithPos, RIGHT_SIDE, 2);
  }
  return strategy;
};

// 决策入口：收集威胁段 → 排序 → 依次尝试 原地转向 / 转向侧移 / 弧线移动
AgentSmith.prototype.getDodgeStrategy = function (pos, globalSteps) {
  var finalStrategy = new DodgeStrategy();
  this.smithPos = pos;
  this.potentialThreats.clear();
  this.threats = [];
  var ballisticsVals = this.ballistics.values();
  for (var it = ballisticsVals.next(); !it.done; it = ballisticsVals.next()) {
    var ballistic = it.value;
    for (var i = 0; i < ballistic.length; i++) {
      var segment = ballistic[i];
      if (checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                                 this.smithPos.angle, this.smithPos.pos, TANK_WIDTH, TANK_HEIGHT)) {
        segment.distanceToTarget = distanceOfTwoPoints(segment.start[1], this.smithPos.pos);
        this.threats.push(segment);
      }
      this.potentialThreats.add(segment.shellId);
    }
  }
  if (!this.threats.length) return;
  this.threats.sort(AgentSmith.segmentCmp);

  var closest = this.threats[0];
  if (closest.shellId !== this.prevThreat.shellId || closest.seq !== this.prevThreat.seq) {
    this.dangerSegment = this.prevThreat;
    this.prevThreat = closest;
  }

  var stop = false;
  var strategy = this.tryRotation(globalSteps);
  if (strategy.isValid()) {
    finalStrategy = strategy;
    stop = true;
  }
  if (!stop) {
    strategy = this.tryRotatingAndMoving(globalSteps);
    if (strategy.isValid()) {
      finalStrategy = strategy;
      stop = true;
    }
  }
  if (!stop) finalStrategy = this.tryRotatingWithMoving(globalSteps);

  this.ctl.updateStrategy(finalStrategy);
};

AgentSmith.prototype.initAStar = function (blocks) { this.aStar.init(blocks); };

// 每局重开（restart → initAll）后重置逐局状态。全局 tick 归零，上一局的时间戳
// （开火冷却、玩家采样）全部过期 —— 不重置的话冷却判定变成负数，每局开局哑火
// 十几秒，提前量还用上一局的旧位置，越往后打越弱
AgentSmith.prototype.resetRound = function () {
  this.prevFireTime = -1000;
  this.prevSampleTick = -999;
  this.enemySamples = [];
  this.prevThreat = BallisticSegment.invalid();
  this.dangerSegment = BallisticSegment.invalid();
  this.ballistics.clear();
  this.threats = [];
  this.potentialThreats.clear();
};

// 预判玩家位置（打提前量）：每 20 tick 采样一次玩家位置，用最近两点的速度
// 按炮弹飞行时间外推，外推最多 1.2s 位移并夹回场地 —— 玩家撞墙会停，外推别放飞
AgentSmith.prototype.predictEnemy = function (smith, enemy, globalSteps) {
  if (globalSteps - this.prevSampleTick >= 20) {
    this.enemySamples.push([globalSteps, new Vec(enemy.pos.x(), enemy.pos.y())]);
    if (this.enemySamples.length > 2) this.enemySamples.shift();
    this.prevSampleTick = globalSteps;
  }
  if (this.enemySamples.length < 2) return enemy;
  var a = this.enemySamples[0], b = this.enemySamples[1];
  var dt = b[0] - a[0];
  if (dt <= 0) return enemy;
  var vel = b[1].minus(a[1]).divide(dt);   // 每 tick 位移
  var dist = distanceOfTwoPoints(smith.pos, enemy.pos);
  var lead = Math.min(dist / SHELL_MOVING_STEP, 120);   // 炮弹到达 tick 数，封顶 1.2s
  var px = enemy.pos.x() + vel.x() * lead;
  var py = enemy.pos.y() + vel.y() * lead;
  px = Math.min(Math.max(px, 12), GAME_VIEW_WIDTH - 12);
  py = Math.min(Math.max(py, 12), GAME_VIEW_HEIGHT - 12);
  return new PosInfo(new Vec(px, py), enemy.angle);
};

// 攻击决策：追击常驻（ChaseStrategy 开局由 initAll 挂上；这里只喂 A* 路线、不重建 ——
// 重建会把它的卡死逃跑计数清零，墙角里永远逃不出来）。路线每 80 tick 重算，玩家跑动
// 也能跟上。开火已挪进 ChaseStrategy 追击中顺路打（边走边打、不再原地蹲点瞄 ——
// 原版要停下来转炮口再打，火力稀、节奏呆）
AgentSmith.prototype.attack = function (smith, enemy, globalSteps) {
  var smithX = mapRealXToAStarX(smith.pos.x());
  var smithY = mapRealYToAStarY(smith.pos.y());
  var enemyX = mapRealXToAStarX(enemy.pos.x());
  var enemyY = mapRealYToAStarY(enemy.pos.y());
  var route = this.aStar.findRoute(smithX, smithY, enemyX, enemyY);
  if (this.ctl.smithContactStrategy && this.ctl.smithContactStrategy.setRoute)
    this.ctl.smithContactStrategy.setRoute(route);
};

// 尝试瞄准：先检查直线弹道是否无墙遮挡，否则 3° 步长扫一圈模拟弹道找折射命中角
AgentSmith.prototype.tryAiming = function (smith, enemy) {
  var tryPos = new PosInfo(new Vec(smith.pos.x(), smith.pos.y()), smith.angle);
  var distance = distanceOfTwoPoints(smith.pos, enemy.pos);
  var angle = vector2Angle(enemy.pos.minus(smith.pos));
  var blocks = this.ctl.getBlocks();
  var directShoot = true;
  var blockVals = blocks.values();
  for (var it = blockVals.next(); !it.done; it = blockVals.next()) {
    var block = it.value;
    if (distanceOfTwoPoints(block.start(), smith.pos) > distance &&
        distanceOfTwoPoints(block.end(), smith.pos) > distance)
      continue;
    var blockAngle = block.isHorizon() ? 180.0 : 90.0;
    if (checkRectRectCollision(angle, enemy.pos.plus(smith.pos).divide(2), 2 * SHELL_RADIUS, distance,
                               blockAngle, block.center(), block.width(), block.height())) {
      directShoot = false;
      break;
    }
  }
  if (directShoot) {
    tryPos.angle = angle;
    return tryPos;
  }
  // 折射扫描：从固定 0° 起步（与车头朝向无关 —— 原版从当前车头起步，扫描到的
  // 「第一个有效角」会随车头旋转漂移，车头永远追不上自己的瞄准角，Smith 原地
  // 转圈不开火），收集全部有效角后取离当前车头最近的一个 —— 稳定、转得最少
  var best = PosInfo.invalid();
  var bestDiff = Infinity;
  tryPos.angle = 0;
  for (var i = 0; i < 360 / TANK_ROTATING_STEP; i++) {
    tryPos.angle = Math.trunc(tryPos.angle + TANK_ROTATING_STEP) % 360;
    // 从炮口（车头前 15，对齐 Tank::makeShell）开始仿真，否则 15px 的起始差
    // 在长程折射下会把反弹几何整个带偏
    var muzzle = new PosInfo(polar2Cart(tryPos.angle, 15, tryPos.pos), tryPos.angle);
    var shell = [-1, muzzle];
    var ballistic = [];
    this.ballisticPredict(shell, ballistic, 0);
    for (var j = 0; j < ballistic.length; j++) {
      var segment = ballistic[j];
      // 炮弹活不到 TTL+1 段之后（反弹耗尽就消失）、也活不过时间寿命，后面的弹道不算数
      if (segment.seq > SHELL_INITIAL_TTL + 1 || segment.end[0] > SHELL_MAX_AGE) break;
      // 反弹后的弹道（seq > 1）不能穿过自己 —— 否则折射打玩家会先打到自己
      if (segment.seq > 1 &&
          checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                                 smith.angle, smith.pos, TANK_WIDTH, TANK_HEIGHT))
        break;
      if (checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                                 enemy.angle, enemy.pos, TANK_WIDTH, TANK_HEIGHT)) {
        var diff = Math.abs(((tryPos.angle - smith.angle + 540) % 360) - 180);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = new PosInfo(new Vec(tryPos.pos.x(), tryPos.pos.y()), tryPos.angle);
        }
        break;
      }
    }
  }
  return best;
};

// 盲射安全检查：模拟这个角度的完整弹道，反弹后（seq > 1）穿过自己就不安全。
// 车头按盲射角摆正后打（rect 朝向用盲射角）。检查范围外扩 40px：盲射时车还在追，
// 弹道离车太近的话车会开进自己的反弹路径里
AgentSmith.prototype.safeShotAngle = function (smith, angle) {
  var muzzle = new PosInfo(polar2Cart(angle, 15, smith.pos), angle);
  var ballistic = [];
  this.ballisticPredict([-1, muzzle], ballistic, 0);
  for (var j = 0; j < ballistic.length; j++) {
    var segment = ballistic[j];
    if (segment.seq > SHELL_INITIAL_TTL + 1 || segment.end[0] > SHELL_MAX_AGE) break;
    if (segment.seq > 1 &&
        checkRectRectCollision(segment.angle, segment.center, 2 * SHELL_RADIUS, segment.length,
                               angle, smith.pos, TANK_WIDTH + 80, TANK_HEIGHT + 80))
      return false;
  }
  return true;
};
