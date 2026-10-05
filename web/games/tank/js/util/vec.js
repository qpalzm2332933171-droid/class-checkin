// util/vec.js —— 对应 C++ util/Vec.h / Vec.cc
// 注意：C++ 里 Vec 按值传递、返回副本；JS 对象是引用，凡 C++ 会"改副本"的地方
// 一律 new 一个新 Vec，防止污染调用方的数据。

function Vec(x, y) {
  if (x === undefined) x = 0;
  if (y === undefined) y = 0;
  this._x = x;
  this._y = y;
}

// operator* —— 点积
Vec.prototype.dot = function (v) { return this._x * v._x + this._y * v._y; };

// operator==
Vec.prototype.equals = function (v) { return this._x === v._x && this._y === v._y; };

// operator-
Vec.prototype.minus = function (v) { return new Vec(this._x - v._x, this._y - v._y); };

// operator+
Vec.prototype.plus = function (v) { return new Vec(this._x + v._x, this._y + v._y); };

// operator/(double)
Vec.prototype.divide = function (d) { return new Vec(this._x / d, this._y / d); };

Vec.prototype.norm = function () { return Math.sqrt(this._x * this._x + this._y * this._y); };

// swap（Block::calculate 里用来交换起终点）
Vec.prototype.swap = function (v) {
  var t = this._x; this._x = v._x; v._x = t;
  t = this._y; this._y = v._y; v._y = t;
};

Vec.prototype.cross = function (v) { return this._x * v._y - this._y * v._x; };

Vec.prototype.x = function () { return this._x; };
Vec.prototype.y = function () { return this._y; };
