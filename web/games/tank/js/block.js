// block.js —— 对应 C++ Block.h / Block.cc（迷宫墙段）
// 注意 C++ 的 width()/height() 命名：width 恒为细边(4)，height 恒为长边(60)，
// 水平墙的 _width/_height 存储是"交换命名"的 —— 移植时保持原样，碰撞函数才等价。

function Block(id, start, end) {
  this._id = id;
  this._start = start;
  this._end = end;
  // C++ assert：墙必须水平或垂直
  this.horizon = start.y() === end.y();
  this.tl = null; this.tr = null; this.bl = null; this.br = null;
  this._border = [];
  this.calculate();

  this._center = new Vec((this.tl.x() + this.tr.x()) / 2, (this.tl.y() + this.bl.y()) / 2);
  // 碰撞包围盒（顺序上下左右），外扩 Shell::RADIUS
  var btl = new Vec(this.tl.x() - SHELL_RADIUS, this.tl.y() - SHELL_RADIUS);
  var btr = new Vec(this.tr.x() + SHELL_RADIUS, this.tr.y() - SHELL_RADIUS);
  var bbl = new Vec(this.bl.x() - SHELL_RADIUS, this.bl.y() + SHELL_RADIUS);
  var bbr = new Vec(this.br.x() + SHELL_RADIUS, this.br.y() + SHELL_RADIUS);
  this._border[0] = [btl, btr];
  this._border[1] = [bbl, bbr];
  this._border[2] = [btl, bbl];
  this._border[3] = [btr, bbr];
}

// C++ 第二个构造：Block(bool isHorizon, const util::Vec& center)（原版未使用，保留）
Block.fromCenter = function (isHorizon, center) {
  if (isHorizon)
    return new Block(-1, new Vec(center.x() - GRID_SIZE / 2, center.y()),
                          new Vec(center.x() + GRID_SIZE / 2, center.y()));
  return new Block(-1, new Vec(center.x(), center.y() - GRID_SIZE / 2),
                       new Vec(center.x(), center.y() + GRID_SIZE / 2));
};

Block.prototype.calculate = function () {
  if (this.horizon) {
    if (this._start.x() > this._end.x()) this._start.swap(this._end);
    this.tl = new Vec(this._start.x() - BLOCK_WIDTH / 2, this._start.y() - BLOCK_WIDTH / 2);
    this.bl = new Vec(this._start.x() - BLOCK_WIDTH / 2, this._start.y() + BLOCK_WIDTH / 2);
    this.tr = new Vec(this._end.x() + BLOCK_WIDTH / 2, this._end.y() - BLOCK_WIDTH / 2);
    this.br = new Vec(this._end.x() + BLOCK_WIDTH / 2, this._end.y() + BLOCK_WIDTH / 2);
    this._width = Math.trunc(this.bl.y() - this.tl.y());  // 4（细边，命名与直觉相反）
    this._height = Math.trunc(this.tr.x() - this.tl.x()); // 60（长边）
  } else {
    if (this._start.y() > this._end.y()) this._start.swap(this._end);
    this.tl = new Vec(this._start.x() - BLOCK_WIDTH / 2, this._start.y() - BLOCK_WIDTH / 2);
    this.tr = new Vec(this._start.x() + BLOCK_WIDTH / 2, this._start.y() - BLOCK_WIDTH / 2);
    this.bl = new Vec(this._end.x() - BLOCK_WIDTH / 2, this._end.y() + BLOCK_WIDTH / 2);
    this.br = new Vec(this._end.x() + BLOCK_WIDTH / 2, this._end.y() + BLOCK_WIDTH / 2);
    this._height = Math.trunc(this.bl.y() - this.tl.y()); // 60（长边）
    this._width = Math.trunc(this.tr.x() - this.tl.x());  // 4（细边）
  }
};

// 对照 GameArea::drawRect —— 黑色四边形
Block.prototype.draw = function (ctx) {
  drawRect(ctx, BLACK, this.tl, this.tr, this.bl, this.br);
};

Block.prototype.isHorizon = function () { return this.horizon; };
Block.prototype.center = function () { return this._center; };
Block.prototype.height = function () { return this._height; };
Block.prototype.width = function () { return this._width; };
Block.prototype.id = function () { return this._id; };
Block.prototype.start = function () { return this._start; };
Block.prototype.end = function () { return this._end; };
Block.prototype.border = function (n) { return this._border[n]; };
