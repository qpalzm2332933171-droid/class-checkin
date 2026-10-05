// renderer.js —— 对应 C++ view/component/GameArea.cc 的 Cairo 绘制 + GameView 侧栏
// Canvas 2D 替代 Cairo：核心绘制原语 drawRect（四边形路径填充）

// Color(0..1) → css rgb
function rgb(color) {
  var r = Math.round(Math.max(0, Math.min(1, color[0])) * 255);
  var g = Math.round(Math.max(0, Math.min(1, color[1])) * 255);
  var b = Math.round(Math.max(0, Math.min(1, color[2])) * 255);
  return "rgb(" + r + "," + g + "," + b + ")";
}

// 对照 GameArea::drawRect —— tl→tr→br→bl 闭合填充
function drawRect(ctx, color, tl, tr, bl, br) {
  ctx.fillStyle = rgb(color);
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(tl.x(), tl.y());
  ctx.lineTo(tr.x(), tr.y());
  ctx.lineTo(br.x(), br.y());
  ctx.lineTo(bl.x(), bl.y());
  ctx.closePath();
  ctx.fill();
}

// 对照 GameArea.cc 的 drawOutline —— 四边黑色边框
function drawOutline(ctx) {
  drawRect(ctx, BLACK, new Vec(0, 0), new Vec(4, 0),
           new Vec(0, GAME_VIEW_HEIGHT), new Vec(4, GAME_VIEW_HEIGHT));
  drawRect(ctx, BLACK, new Vec(GAME_VIEW_WIDTH - 4, 0), new Vec(GAME_VIEW_WIDTH, 0),
           new Vec(GAME_VIEW_WIDTH - 4, GAME_VIEW_HEIGHT), new Vec(GAME_VIEW_WIDTH, GAME_VIEW_HEIGHT));
  drawRect(ctx, BLACK, new Vec(0, 0), new Vec(GAME_VIEW_WIDTH, 0),
           new Vec(0, 4), new Vec(GAME_VIEW_WIDTH - 1, 4));
  drawRect(ctx, BLACK, new Vec(0, GAME_VIEW_HEIGHT - 4), new Vec(GAME_VIEW_WIDTH, GAME_VIEW_HEIGHT - 4),
           new Vec(0, GAME_VIEW_HEIGHT), new Vec(GAME_VIEW_WIDTH, GAME_VIEW_HEIGHT));
}

// 对照 GameArea::on_draw —— 边框 → 墙 → 对象
function GameRenderer(canvas, ctl) {
  this.canvas = canvas;
  this.ctx = canvas.getContext("2d");
  this.ctl = ctl;

  // HiDPI：按 devicePixelRatio 放大画布，逻辑坐标仍为 660×420
  var dpr = window.devicePixelRatio || 1;
  canvas.width = GAME_VIEW_WIDTH * dpr;
  canvas.height = GAME_VIEW_HEIGHT * dpr;
  canvas.style.width = GAME_VIEW_WIDTH + "px";
  canvas.style.height = GAME_VIEW_HEIGHT + "px";
  this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

GameRenderer.prototype.draw = function () {
  var ctx = this.ctx;
  ctx.save();
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.clearRect(0, 0, GAME_VIEW_WIDTH, GAME_VIEW_HEIGHT);
  drawOutline(ctx);
  var blocks = this.ctl.getBlocks().values();
  for (var it = blocks.next(); !it.done; it = blocks.next())
    it.value.draw(ctx);
  var objs = this.ctl.getObjects().values();
  for (it = objs.next(); !it.done; it = objs.next())
    it.value.draw(ctx);
  ctx.restore();
};

// 侧栏小坦克图标 —— 对照 PlayerInfoItem::PlayerIcon::on_draw（50×30 区域）
function drawPlayerIcon(canvas, color) {
  canvas.width = 50;
  canvas.height = 30;
  var ctx = canvas.getContext("2d");
  ctx.save();
  ctx.fillStyle = rgb(color);
  ctx.beginPath();
  ctx.moveTo(5, 5);
  ctx.lineTo(33, 5);
  ctx.lineTo(33, 25);
  ctx.lineTo(5, 25);
  ctx.closePath();
  ctx.fill();
  var turret = [color[0] - 0.3, color[1] - 0.3, color[2] - 0.3];
  ctx.fillStyle = rgb(turret);
  ctx.beginPath();
  ctx.arc(19, 15, 9, 0.0, 2 * Math.PI);
  ctx.fill();
  ctx.lineWidth = 9.0;
  ctx.strokeStyle = rgb(turret);
  ctx.beginPath();
  ctx.moveTo(19, 15);
  ctx.lineTo(2, 15);
  ctx.stroke();
  ctx.restore();
}
