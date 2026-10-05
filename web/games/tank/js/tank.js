// tank.js —— 对应 C++ Tank.h / Tank.cc（坦克）

function Tank(id, p, angle, c) {
  GameObject.call(this, p, angle, c, id);
  this.remainBullets = TANK_MAX_SHELLS;
  this.topLeft = null; this.topRight = null;
  this.bottomLeft = null; this.bottomRight = null;
  this.recalculate();
}
Tank.prototype = Object.create(GameObject.prototype);
Tank.prototype.constructor = Tank;

Tank.prototype.recalculate = function () {
  var corners = getCornerVec(this.posInfo.pos, this.posInfo.angle, TANK_WIDTH, TANK_HEIGHT);
  this.topLeft = corners[0];
  this.topRight = corners[1];
  this.bottomLeft = corners[2];
  this.bottomRight = corners[3];
};

Tank.prototype.stop = function () {
  this.movingStatus = 0;
  this.movingStatus |= MOVING_STATIONARY;
};

Tank.prototype.forward = function (enable) {
  if (enable) {
    this.movingStatus &= ~MOVING_BACKWARD;
    this.movingStatus |= MOVING_FORWARD;
  } else this.movingStatus &= ~MOVING_FORWARD;
};

Tank.prototype.backward = function (enable) {
  if (enable) {
    this.movingStatus &= ~MOVING_FORWARD;
    this.movingStatus |= MOVING_BACKWARD;
  } else this.movingStatus &= ~MOVING_BACKWARD;
};

Tank.prototype.rotateCW = function (enable) {
  if (enable) {
    this.movingStatus &= ~ROTATING_CCW;
    this.movingStatus |= ROTATING_CW;
  } else this.movingStatus &= ~ROTATING_CW;
};

Tank.prototype.rotateCCW = function (enable) {
  if (enable) {
    this.movingStatus &= ~ROTATING_CW;
    this.movingStatus |= ROTATING_CCW;
  } else this.movingStatus &= ~ROTATING_CCW;
};

Tank.prototype.isForwarding = function () { return this.movingStatus & MOVING_FORWARD; };
Tank.prototype.isBackwarding = function () { return this.movingStatus & MOVING_BACKWARD; };
Tank.prototype.isRotatingCW = function () { return this.movingStatus & ROTATING_CW; };
Tank.prototype.isRotatingCCW = function () { return this.movingStatus & ROTATING_CCW; };

// 对照 Tank::draw —— 旋转矩形车身 + 炮塔圆 + 炮管粗线
Tank.prototype.draw = function (ctx) {
  ctx.save();
  drawRect(ctx, this.color, this.topLeft, this.topRight, this.bottomLeft, this.bottomRight);

  var turret = [this.color[0] - 0.3, this.color[1] - 0.3, this.color[2] - 0.3];
  ctx.fillStyle = rgb(turret);
  ctx.beginPath();
  ctx.arc(this.posInfo.pos.x(), this.posInfo.pos.y(), 9, 0.0, 2 * Math.PI);
  ctx.fill();

  ctx.lineWidth = 9.0;
  ctx.strokeStyle = rgb(turret);
  ctx.beginPath();
  ctx.moveTo(this.posInfo.pos.x(), this.posInfo.pos.y());
  var to = polar2Cart(this.posInfo.angle, 17, this.posInfo.pos);
  ctx.lineTo(to.x(), to.y());
  ctx.stroke();
  ctx.restore();
};

Tank.prototype.getNextPosition = function (movingStep, rotationStep) {
  var next = Tank.nextPosition(this.posInfo, this.movingStatus, movingStep, rotationStep);
  this.nextPos = next;
  return next;
};

// C++ 静态版本（AI 预测用）：step 传 0 表示取默认步长
Tank.nextPosition = function (cur, movingStatus, movingStep, rotationStep) {
  if (movingStep === 0) movingStep = TANK_MOVING_STEP;
  if (rotationStep === 0) rotationStep = TANK_ROTATING_STEP;
  var next = new PosInfo(new Vec(cur.pos.x(), cur.pos.y()), cur.angle);
  if (movingStatus & ROTATING_CW)
    next.angle = Math.trunc(360 + cur.angle - rotationStep) % 360;
  if (movingStatus & ROTATING_CCW)
    next.angle = Math.trunc(cur.angle + rotationStep) % 360;
  if (movingStatus & MOVING_FORWARD)
    next.pos = polar2Cart(next.angle, movingStep, cur.pos);
  if (movingStatus & MOVING_BACKWARD)
    next.pos = polar2Cart(next.angle + 180, movingStep, cur.pos);
  return next;
};

Tank.prototype.moveToNextPosition = function () {
  this.posInfo = this.nextPos;
  this.recalculate();
};

Tank.prototype.type = function () { return OBJ_TANK; };

Tank.prototype.remainShells = function () { return this.remainBullets; };

// 炮口前方 15 处生成炮弹，归属 _id
Tank.prototype.makeShell = function () {
  this.remainBullets--;
  var shellPos = polar2Cart(this.posInfo.angle, 15, this.posInfo.pos);
  return new Shell(Id.getShellId(), shellPos, this.posInfo.angle, this._id);
};

// 弹数归还，上限 TANK_MAX_SHELLS —— 回弹/回收都不能让弹夹超过 5（人机曾靠
// 这个涨到 7~8 发同时在场，违反「和玩家一样最多 5 发」的规则）
Tank.prototype.getRemainShell = function () {
  if (this.remainBullets < TANK_MAX_SHELLS) this.remainBullets++;
};
