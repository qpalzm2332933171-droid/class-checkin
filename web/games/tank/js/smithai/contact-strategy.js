// smithai/contact-strategy.js —— 对应 C++ smithAI/ContactStrategy.h / .cc（沿 A* 路线移动）

function ContactStrategy(route) {
  Strategy.call(this, STRATEGY_CONTACT);
  this.route = route;
  this.next = 1;
  this.stuckSteps = 0;
  this.prevPos = new PosInfo();
}
ContactStrategy.prototype = Object.create(Strategy.prototype);
ContactStrategy.prototype.constructor = ContactStrategy;

// 对照 ContactStrategy::update
ContactStrategy.prototype.update = function (ctl, tank, globalStep) {
  var isRotating = tank.isRotatingCW() || tank.isRotatingCCW();
  var isForwarding = tank.isForwarding();
  tank.stop();
  if (this.next >= this.route.length) return false;
  var tankPos = tank.getCurrentPosition();
  var nextX = this.route[this.next][0];
  var nextY = this.route[this.next][1];
  var gridCenter = new Vec(mapAStarXToRealX(nextX), mapAStarYToRealY(nextY));
  if (distanceOfTwoPoints(tankPos.pos, gridCenter) < 15) this.next++;
  var vn = gridCenter.minus(tankPos.pos);
  var vt = getUnitVector(tankPos.angle);
  if (angleBetweenVectors(vt, vn) < 45.0) tank.forward(true);
  if (angleBetweenVectors(vt, vn) >= 12.0 && !(isRotating && tankPos.angle === this.prevPos.angle)) {
    if (vt.cross(vn) >= 0) tank.rotateCW(true);
    else tank.rotateCCW(true);
  }
  if (isForwarding && tankPos.pos.equals(this.prevPos.pos)) {
    var tryPos = Tank.nextPosition(tankPos, ROTATING_CW, 0, 0);
    if (ctl.checkTankBlockCollision(tryPos, tryPos) === 0) tank.rotateCW(true);
    else tank.rotateCCW(true);
    tank.forward(false);
  }
  if (tankPos.equals(this.prevPos)) {
    this.stuckSteps++;
    if (this.stuckSteps > 5) {
      tank.rotateCW(false);
      tank.rotateCCW(false);
      tank.backward(true);
    }
  } else this.stuckSteps = 0;
  this.prevPos = tankPos;
  // 走出下一步会死就停下（AgentSmith::safeToMove）
  if (!ctl.smith.safeToMove(globalStep, tankPos, tank.getMovingStatus()))
    tank.stop();
  return true;
};

// ChaseStrategy —— 追击玩家（替代原版 A* ContactStrategy 追击：A* 路线失败 /
// 瞄准分支清空路线时 Smith 会原地不动）。每 80 tick 由 AgentSmith.attack 用 A*
// 重算一次路线喂进来，坦克沿路点走迷宫正解；路线为空（理论上迷宫连通不会发生）时
// 退回直线追击。绕墙交给滑行物理，卡死时倒车 + 原地转兜底。
function ChaseStrategy() {
  Strategy.call(this, STRATEGY_CONTACT);
  this.route = null;         // A* 路线（[[x,y]...]，头部是起点）；null = 直线追击玩家
  this.next = 1;
  this.stuckSteps = 0;
  this.escapeTicks = 0;      // >0 = 卡死逃跑中（倒车 + 原地转）
  this.escapeFrom = null;    // 逃跑起点，逃开 30px 就算脱困
  this.refPos = null;        // 卡死判定参考点：±1px 的顶墙抖动不算移动
  this.bestDist = Infinity;  // 本段追击中的最小距离
  this.noProgressTicks = 0;  // 距离迟迟不缩短的连续 tick 数（追墙绕圈检测）
  this.followSide = 1;       // 沿墙滑行选边（+1/-1），每次逃跑翻转 —— 死胡同换一边走
  this.aimCache = PosInfo.invalid();  // 缓存的瞄准角（tryAiming 全角扫描不便宜）
  this.aimCacheTick = -999;
  this.aimCachePos = new Vec();       // 缓存瞄准角时的车位：车挪了 20px 以上就得重算
}
ChaseStrategy.prototype = Object.create(Strategy.prototype);
ChaseStrategy.prototype.constructor = ChaseStrategy;

ChaseStrategy.prototype.isEscaping = function () { return this.escapeTicks > 0; };

// 躲避期间的开火通道：danger 挡住追击（含移动）时，瞄准 + 开火照常 —— 否则玩家
// 贴脸连射会让 Smith 一直处于躲闪状态，永远不开火还手，被近距离白打
ChaseStrategy.prototype.updateFireOnly = function (ctl, tank, globalStep) {
  var enemy = ctl.getMyPosition();
  var cur = tank.getCurrentPosition();
  var smith = ctl.smith;
  if (!enemy) return;
  // 瞄准缓存在这里维护（被 danger 挡住时追击不跑，缓存会过期）
  if (globalStep - this.aimCacheTick >= 40 ||
      distanceOfTwoPoints(cur.pos, this.aimCachePos) > 20) {
    var predEnemy = smith.predictEnemy(cur, enemy, globalStep);
    this.aimCache = smith.tryAiming(cur, predEnemy);
    this.aimCacheTick = globalStep;
    this.aimCachePos = new Vec(cur.pos.x(), cur.pos.y());
  }
  var distToEnemy = distanceOfTwoPoints(cur.pos, enemy.pos);
  var aimAngle = this.aimCache.isValid()
    ? this.aimCache.angle
    : Math.trunc(vector2Angle(enemy.pos.minus(cur.pos))) % 360;
  // 贴脸（<80px）：放宽对准容差（15°）、跳过弹道安全线 —— 玩家就在眼前，
  // 先开枪再说；远距离：精确瞄准（折射弹道）或盲射（车头大致朝玩家 + 安全线）
  var tol = distToEnemy < 80 ? 15 : (this.aimCache.isValid() ? 3 : 20);
  if (globalStep - smith.prevFireTime >= AGENT_SMITH_FIRE_CD &&
      (distToEnemy < 80 || smith.safeShotAngle(cur, cur.angle))) {
    var aimDiff = Math.abs(((aimAngle - cur.angle + 540) % 360) - 180);
    if (aimDiff <= tol) {
      ctl.fire(tank);
      smith.prevFireTime = globalStep;
    }
  }
};

// 换路线（attack 每 80 tick 调用一次）；太短的路线直接退回直线追击
ChaseStrategy.prototype.setRoute = function (route) {
  if (route && route.length >= 2) { this.route = route; this.next = 1; }
  else this.route = null;
};

ChaseStrategy.prototype.update = function (ctl, tank, globalStep) {
  var enemy = ctl.getMyPosition();
  var cur = tank.getCurrentPosition();
  tank.stop();
  if (!enemy) return false;
  var distToEnemy = distanceOfTwoPoints(cur.pos, enemy.pos);
  // 追击目标：A* 路线下一个路点（格子中心），走完/没有路线时就是玩家本人
  var target = enemy.pos;
  if (this.route) {
    var wp = new Vec(mapAStarXToRealX(this.route[this.next][0]),
                     mapAStarYToRealY(this.route[this.next][1]));
    if (distanceOfTwoPoints(cur.pos, wp) < 15) {
      this.next++;
      this.bestDist = Infinity; this.noProgressTicks = 0;
      this.refPos = null; this.stuckSteps = 0;
    }
    if (this.next >= this.route.length) this.route = null;
    else target = wp;
  }
  var dist = distanceOfTwoPoints(cur.pos, target);
  if (dist < this.bestDist) { this.bestDist = dist; this.noProgressTicks = 0; }
  else this.noProgressTicks++;
  // 卡死判定：只有「想走但没走动」才累计 —— 原地转向调车头是正常行为，不算卡死
  // （开局 Smith 背对玩家要转 180°，之前被误判卡死 → 触发逃跑原地转圈）
  var wasMoving = tank.isForwarding() || tank.isBackwarding();
  if (!this.refPos) this.refPos = new Vec(cur.pos.x(), cur.pos.y());
  if (distanceOfTwoPoints(cur.pos, this.refPos) > 3) {
    this.refPos = new Vec(cur.pos.x(), cur.pos.y());
    this.stuckSteps = 0;
  } else if (wasMoving) this.stuckSteps++;
  // 卡死兜底：连续 5 tick 想走没走动，或追墙绕圈 3s 距离不缩短 → 倒车 + 原地转。
  // 逃开 30px 或满 1.5s 才恢复追击 —— 之前逃 1px 就回头，会被重新按回墙角
  if (this.escapeTicks > 0) {
    this.escapeTicks--;
    if (distanceOfTwoPoints(cur.pos, this.escapeFrom) > 30) this.escapeTicks = 0;
    if (this.escapeTicks === 0) {
      this.escapeFrom = null;
      this.bestDist = dist;
      this.noProgressTicks = 0;
    }
  } else if (this.stuckSteps > 5 || this.noProgressTicks > 300) {
    this.escapeTicks = 150;
    this.escapeFrom = new Vec(cur.pos.x(), cur.pos.y());
    this.followSide = -this.followSide;   // 换一边沿墙，避免反复钻进同一个死胡同
  }
  if (this.escapeTicks > 0) {
    tank.backward(true);
    tank.rotateCW(true);
  } else {
    // 全图开火：瞄准打提前量的玩家位置（直线或折射反弹）。40 tick 或车位挪了 20px
    // 就重算一次（500 步弹道 × 120 角扫描不便宜；车位挪了不重算，反弹几何会偏）
    var smith = ctl.smith;
    var aiming = PosInfo.invalid();
    if (globalStep - this.aimCacheTick >= 40 ||
        distanceOfTwoPoints(cur.pos, this.aimCachePos) > 20) {
      var predEnemy = smith.predictEnemy(cur, enemy, globalStep);
      this.aimCache = smith.tryAiming(cur, predEnemy);
      this.aimCacheTick = globalStep;
      this.aimCachePos = new Vec(cur.pos.x(), cur.pos.y());
    }
    aiming = this.aimCache;
    var vt = getUnitVector(cur.angle);
    var moveDir = target.minus(cur.pos);
    var moveAngle = angleBetweenVectors(vt, moveDir);
    if (aiming.isValid()) {
      // 狙击姿态：有有效瞄准角（直线/折射打提前量）就停下原地打 —— 车头精确对准 +
      // 连续开火。折射角与车头同余 mod 3（都按 3° 步进），能转到分毫不差；折射弹道
      // 对角度极敏感，差 1° 在几百 px 外反弹几何就全偏，所以必须对准了才开火。
      // 边追边打进不了自己刚打出去的反弹弹道（走位会撞上自己的炮弹），所以原地狙
      this.noProgressTicks = 0;   // 狙击也算「在做正事」，别被 3s 无进展逃跑打断
      this.bestDist = dist;
      var aimDiff = ((aiming.angle - cur.angle + 540) % 360) - 180;
      if (Math.abs(aimDiff) >= 3) {
        if (vt.cross(getUnitVector(aiming.angle)) >= 0) tank.rotateCW(true);
        else tank.rotateCCW(true);
      } else if (globalStep - smith.prevFireTime >= AGENT_SMITH_FIRE_CD) {
        ctl.fire(tank);
        smith.prevFireTime = globalStep;
      }
    } else {
      // 没瞄准角才继续追：宽门斜着顶墙也走（靠滑行绕墙）
      if (!(this.route === null && distToEnemy < 25) && moveAngle < 90)
        tank.forward(true);
      if (angleBetweenVectors(vt, moveDir) >= 4) {
        if (vt.cross(moveDir) >= 0) tank.rotateCW(true);
        else tank.rotateCCW(true);
      }
      // 追击中盲射逼走位：车头大致朝玩家（20° 内）且当前朝向的弹道不会弹回自己就开火。
      // 命中看运气，主要作用是开局就开火、持续压制逼玩家不停走位；安全线按实际炮口朝向查
      if (globalStep - smith.prevFireTime >= AGENT_SMITH_FIRE_CD) {
        var blindAngle = Math.trunc(vector2Angle(
          smith.predictEnemy(cur, enemy, globalStep).pos.minus(cur.pos))) % 360;
        var blindDiff = Math.abs(((blindAngle - cur.angle + 540) % 360) - 180);
        if (blindDiff <= 20 && smith.safeShotAngle(cur, cur.angle)) {
          ctl.fire(tank);
          smith.prevFireTime = globalStep;
        }
      }
    }
  }
  // 走出下一步会死就停下（AgentSmith::safeToMove）
  if (!ctl.smith.safeToMove(globalStep, cur, tank.getMovingStatus()))
    tank.stop();
  return true;
};
