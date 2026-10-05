// maze.js —— 对应 C++ Maze.h / Maze.cc（随机 Prim 迷宫生成）

var MAX_GRID_ID = HORIZON_GRID_NUMBER * VERTICAL_GRID_NUMBER; // 77

// Maze::Grid
function MazeGrid(x, y) {
  this.x = x;
  this.y = y;
}
MazeGrid.prototype.id = function () { return this.y * HORIZON_GRID_NUMBER + this.x; };

function Maze() {
  this.map = null;
}

// 随机 Prim：map 是 MAX_GRID_ID×MAX_GRID_ID 邻接矩阵，1 = 连通
// C++ 里的全局 vis 只在此函数使用，改为局部变量
Maze.prototype.generate = function () {
  var dx = [0, -1, 0, 1];
  var dy = [-1, 0, 1, 0];
  this.map = [];
  for (var i = 0; i < MAX_GRID_ID; i++) this.map.push(new Array(MAX_GRID_ID).fill(0));
  var vis = [];
  for (i = 0; i < HORIZON_GRID_NUMBER; i++) vis.push(new Array(VERTICAL_GRID_NUMBER).fill(0));
  vis[0][0] = 1;
  var walls = [[new MazeGrid(0, 0), new MazeGrid(1, 0)]];
  while (walls.length) {
    var n = getRandomNumber(0, walls.length - 1);
    var wall = walls.splice(n, 1)[0];
    if (!vis[wall[1].x][wall[1].y]) {
      this.map[wall[0].id()][wall[1].id()] = 1;
      this.map[wall[1].id()][wall[0].id()] = 1;
      vis[wall[1].x][wall[1].y] = 1;
    }
    for (var i2 = 0; i2 < 4; i2++) {
      var nx = wall[1].x + dx[i2];
      var ny = wall[1].y + dy[i2];
      if (nx < 0 || nx >= HORIZON_GRID_NUMBER || ny < 0 || ny >= VERTICAL_GRID_NUMBER) continue;
      if (vis[nx][ny]) continue;
      var next = new MazeGrid(nx, ny);
      if (this.map[wall[1].id()][next.id()] === 0)
        walls.push([wall[1], next]);
    }
  }
};

// 不连通的相邻格子对之间生成墙段（返回 [起点Vec, 终点Vec] 列表）
Maze.prototype.getBlockPositions = function () {
  var blocks = [];
  for (var y = 0; y < VERTICAL_GRID_NUMBER; y++)
    for (var x = 0; x < HORIZON_GRID_NUMBER - 1; x++)
      if (this.map[new MazeGrid(x, y).id()][new MazeGrid(x + 1, y).id()] === 0)
        blocks.push([new Vec((x + 1) * GRID_SIZE, y * GRID_SIZE),
                     new Vec((x + 1) * GRID_SIZE, (y + 1) * GRID_SIZE)]);
  for (x = 0; x < HORIZON_GRID_NUMBER; x++)
    for (y = 0; y < VERTICAL_GRID_NUMBER - 1; y++)
      if (this.map[new MazeGrid(x, y).id()][new MazeGrid(x, y + 1).id()] === 0)
        blocks.push([new Vec(x * GRID_SIZE, (y + 1) * GRID_SIZE),
                     new Vec((x + 1) * GRID_SIZE, (y + 1) * GRID_SIZE)]);
  return blocks;
};
