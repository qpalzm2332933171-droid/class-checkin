// shell.js —— 对应 C++ Shell.h / Shell.cc（炮弹）

function Shell(id, p, angle, tankId) {
  GameObject.call(this, p, angle, BLACK, id);
  this._tankId = tankId;
  this._ttl = SHELL_INITIAL_TTL;
  this._age = 0;   // 飞行 tick 数（时间寿命，见 SHELL_MAX_AGE）
  this.movingStatus = MOVING_FORWARD;
}
Shell.prototype = Object.create(GameObject.prototype);
Shell.prototype.constructor = Shell;

// 对照 Shell::draw —— 黑色实心圆
Shell.prototype.draw = function (ctx) {
  ctx.save();
  ctx.fillStyle = rgb(this.color);
  ctx.beginPath();
  ctx.arc(this.posInfo.pos.x(), this.posInfo.pos.y(), SHELL_RADIUS, 0.0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
};

Shell.prototype.getNextPosition = function (movingStep, rotationStep) {
  var next = Shell.nextPosition(this.posInfo, movingStep, rotationStep);
  this.nextPos = next;
  return next;
};

Shell.nextPosition = function (cur, movingStep, rotationStep) {
  if (movingStep === 0) movingStep = SHELL_MOVING_STEP;
  var next = new PosInfo(new Vec(cur.pos.x(), cur.pos.y()), cur.angle);
  next.pos = polar2Cart(cur.angle, movingStep, cur.pos);
  return next;
};

Shell.prototype.moveToNextPosition = function () { this.posInfo = this.nextPos; };

Shell.prototype.type = function () { return OBJ_SHELL; };

// C++ countDown 是 _ttl--（先返回再减）
Shell.prototype.countDown = function () { return this._ttl--; };

Shell.prototype.age = function () { return this._age; };

Shell.prototype.tankId = function () { return this._tankId; };

Shell.prototype.ttl = function () { return this._ttl; };
