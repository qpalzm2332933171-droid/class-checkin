// object.js —— 对应 C++ Object.h / Object.cc（游戏对象基类）
// 注意：C++ 的 PosInfo 按值传递；JS 对象是引用，凡 C++ 拷贝的地方都 new 新对象

var DBL_MAX = Number.MAX_VALUE;

// Object::PosInfo
function PosInfo(p, a) {
  if (p === undefined) p = new Vec(0, 0);
  if (a === undefined) a = 0;
  this.pos = p;
  this.angle = a;
}

PosInfo.prototype.equals = function (info) {
  return this.pos.equals(info.pos) && this.angle === info.angle;
};

PosInfo.prototype.isValid = function () {
  return this.pos.x() !== DBL_MAX && this.pos.y() !== DBL_MAX && this.angle !== DBL_MAX;
};

PosInfo.invalid = function () {
  return new PosInfo(new Vec(DBL_MAX, DBL_MAX), DBL_MAX);
};

// Object 基类（C++ 里名为 Object，这里叫 GameObject 避免与 window.Object 混淆）
function GameObject(pos, angle, c, id) {
  this.posInfo = new PosInfo(pos, angle);
  this.nextPos = new PosInfo();
  this.movingStatus = MOVING_STATIONARY;
  this.color = c;
  this._id = id;
}

GameObject.prototype.resetNextPosition = function (next) { this.nextPos = next; };

GameObject.prototype.getCurrentPosition = function () { return this.posInfo; };

GameObject.prototype.id = function () { return this._id; };

GameObject.prototype.getMovingStatus = function () { return this.movingStatus; };
