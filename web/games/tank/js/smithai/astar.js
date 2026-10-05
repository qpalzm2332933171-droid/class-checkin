// smithai/astar.js —— 对应 C++ smithAI/AStar.h / AStar.cc（8 方向 A* 寻路）

var REACHABLE = 0;
var UNREACHABLE = 1;
var HORIZON_VERTICAL_COST = 10;
var DIAGONAL_COST = 14;

// AStar::AStarNode
function AStarNode(x, y) {
  this.x = x;
  this.y = y;
  this.id = AStar.getGridId(x, y);
  this.parentId = -1;
  this.G = 0;
  this.H = 0;
  this.F = 0;
}

function AStar() {
  this.map = null;
  this.entryList = []; // C++ 的最小堆（按 F 排序的数组模拟，节点最多 77 个）
  this.openSet = new Set();
  this.closedSet = new Set();
  this.nodes = new Map(); // id -> AStarNode
}

AStar.getGridId = function (x, y) { return y * HORIZON_A_STAR_GRID_NUMBER + x; };

// 置为不可达。C++ 原版对部分越界 id 是未定义行为（vector 越界写）；
// 这里补上边界保护，合法 id 的行为与原版完全一致
AStar.prototype.setUnreachable = function (a, b) {
  if (a >= 0 && a < MAX_A_STAR_NODE_ID && b >= 0 && b < MAX_A_STAR_NODE_ID) {
    this.map[a][b] = UNREACHABLE;
    this.map[b][a] = UNREACHABLE;
  }
};

// 根据墙段建立 77 节点邻接矩阵：墙两侧节点间不可达（防穿越墙角）
AStar.prototype.init = function (blocks) {
  this.map = [];
  for (var i = 0; i < MAX_A_STAR_NODE_ID; i++)
    this.map.push(new Array(MAX_A_STAR_NODE_ID).fill(REACHABLE));

  var blockList = blocks.values();
  for (var it = blockList.next(); !it.done; it = blockList.next()) {
    var block = it.value;
    var blockStart = block.start();
    var blockEnd = block.end();
    if (block.isHorizon()) {
      var topLeftGridId = AStar.getGridId(
        mapRealXToAStarX(blockStart.x() - A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockStart.y() - A_STAR_GRID_SIZE / 2));
      var bottomLeftGridId = AStar.getGridId(
        mapRealXToAStarX(blockStart.x() - A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockStart.y() + A_STAR_GRID_SIZE / 2));
      var topRightGridId = AStar.getGridId(
        mapRealXToAStarX(blockEnd.x() + A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockEnd.y() - A_STAR_GRID_SIZE / 2));
      var bottomRightGridId = AStar.getGridId(
        mapRealXToAStarX(blockEnd.x() + A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockEnd.y() + A_STAR_GRID_SIZE / 2));
      var y1 = blockStart.y() - A_STAR_GRID_SIZE / 2;
      var y2 = blockStart.y() + A_STAR_GRID_SIZE / 2;
      for (var i2 = 0; i2 < A_STAR_GRID_PER_GRID; i2++) {
        var x1 = block.start().x() + i2 * A_STAR_GRID_SIZE + A_STAR_GRID_SIZE / 2;
        var id1 = AStar.getGridId(mapRealXToAStarX(x1), mapRealYToAStarY(y1));
        if (i2 === 0 && bottomLeftGridId < MAX_A_STAR_NODE_ID)
          this.setUnreachable(id1, bottomLeftGridId);
        if (i2 === A_STAR_GRID_PER_GRID - 1 && bottomRightGridId < MAX_A_STAR_NODE_ID)
          this.setUnreachable(id1, bottomRightGridId);
        for (var j = 0; j < A_STAR_GRID_PER_GRID; j++) {
          var x2 = block.start().x() + j * A_STAR_GRID_SIZE + A_STAR_GRID_SIZE / 2;
          var id2 = AStar.getGridId(mapRealXToAStarX(x2), mapRealYToAStarY(y2));
          this.setUnreachable(id1, id2);
          if (j === 0 && topLeftGridId < MAX_A_STAR_NODE_ID)
            this.setUnreachable(id2, topLeftGridId);
          if (j === A_STAR_GRID_PER_GRID - 1 && topRightGridId < MAX_A_STAR_NODE_ID)
            this.setUnreachable(id2, topRightGridId);
        }
      }
    } else {
      var topLeftGridIdV = AStar.getGridId(
        mapRealXToAStarX(blockStart.x() - A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockStart.y() - A_STAR_GRID_SIZE / 2));
      var bottomLeftGridIdV = AStar.getGridId(
        mapRealXToAStarX(blockEnd.x() - A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockEnd.y() + A_STAR_GRID_SIZE / 2));
      var topRightGridIdV = AStar.getGridId(
        mapRealXToAStarX(blockStart.x() + A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockStart.y() - A_STAR_GRID_SIZE / 2));
      var bottomRightGridIdV = AStar.getGridId(
        mapRealXToAStarX(blockEnd.x() + A_STAR_GRID_SIZE / 2),
        mapRealYToAStarY(blockEnd.y() + A_STAR_GRID_SIZE / 2));
      var x1v = blockStart.x() - A_STAR_GRID_SIZE / 2;
      var x2v = blockStart.x() + A_STAR_GRID_SIZE / 2;
      for (var i3 = 0; i3 < A_STAR_GRID_PER_GRID; i3++) {
        var y1v = block.start().y() + i3 * A_STAR_GRID_SIZE + A_STAR_GRID_SIZE / 2;
        var id1v = AStar.getGridId(mapRealXToAStarX(x1v), mapRealYToAStarY(y1v));
        if (i3 === 0 && topRightGridIdV < MAX_A_STAR_NODE_ID)
          this.setUnreachable(id1v, topRightGridIdV);
        if (i3 === A_STAR_GRID_PER_GRID - 1 && bottomRightGridIdV < MAX_A_STAR_NODE_ID)
          this.setUnreachable(id1v, bottomRightGridIdV);
        for (var j2 = 0; j2 < A_STAR_GRID_PER_GRID; j2++) {
          var y2v = block.start().y() + j2 * A_STAR_GRID_SIZE + A_STAR_GRID_SIZE / 2;
          var id2v = AStar.getGridId(mapRealXToAStarX(x2v), mapRealYToAStarY(y2v));
          this.setUnreachable(id1v, id2v);
          if (j2 === 0 && topLeftGridIdV < MAX_A_STAR_NODE_ID)
            this.setUnreachable(id2v, topLeftGridIdV);
          if (j2 === A_STAR_GRID_PER_GRID - 1 && bottomLeftGridIdV < MAX_A_STAR_NODE_ID)
            this.setUnreachable(id2v, bottomLeftGridIdV);
        }
      }
    }
  }
};

// AStarResult = [[x, y], ...]（deque，头部是起点）
AStar.prototype.findRoute = function (sx, sy, ex, ey) {
  var res = [];
  var id = this.getRoute(sx, sy, ex, ey);
  while (id !== -1) {
    res.unshift([this.nodes.get(id).x, this.nodes.get(id).y]);
    id = this.nodes.get(id).parentId;
  }
  this.entryList.length = 0;
  this.openSet.clear();
  this.closedSet.clear();
  this.nodes.clear();
  return res;
};

AStar.calcG = function (parent, cur) {
  var curG = (cur.x === parent.x || cur.y === parent.y)
    ? HORIZON_VERTICAL_COST : DIAGONAL_COST;
  return parent.G + curG;
};

AStar.calcH = function (cur, ex, ey) {
  return Math.trunc(Math.sqrt(Math.pow(ex - cur.x, 2) + Math.pow(ey - cur.y, 2)));
};

AStar.prototype.getReachable = function (x, y) {
  var dx = [0, -1, -1, -1, 0, 1, 1, 1];
  var dy = [-1, -1, 0, 1, 1, 1, 0, -1];
  var reachable = [];
  for (var i = 0; i < 8; i++) {
    var nx = x + dx[i];
    var ny = y + dy[i];
    if (nx < 0 || nx >= HORIZON_A_STAR_GRID_NUMBER || ny < 0 || ny >= VERTICAL_A_STAR_GRID_NUMBER)
      continue;
    var currentId = AStar.getGridId(x, y);
    var nextId = AStar.getGridId(nx, ny);
    if (this.map[currentId][nextId] !== REACHABLE || this.closedSet.has(nextId))
      continue;
    reachable.push(new AStarNode(nx, ny));
  }
  return reachable;
};

AStar.prototype.pushEntry = function (F, id) {
  this.entryList.push({ F: F, id: id });
  this.entryList.sort(function (a, b) { return (a.F - b.F) || (a.id - b.id); });
};

AStar.prototype.popSmallest = function () { return this.entryList.shift(); };

AStar.prototype.addToOpenList = function (node) {
  this.pushEntry(node.F, node.id);
  this.openSet.add(node.id);
  this.nodes.set(node.id, node);
};

AStar.prototype.getRoute = function (sx, sy, ex, ey) {
  this.addToOpenList(new AStarNode(sx, sy));
  var endId = AStar.getGridId(ex, ey);
  while (this.openSet.size) {
    var smallestF = this.popSmallest();
    var cur = this.nodes.get(smallestF.id);
    this.openSet.delete(cur.id);
    this.closedSet.add(cur.id);
    var reachable = this.getReachable(cur.x, cur.y);
    for (var i = 0; i < reachable.length; i++) {
      var n = reachable[i];
      if (!this.openSet.has(n.id)) {
        var next = new AStarNode(n.x, n.y);
        next.parentId = cur.id;
        next.G = AStar.calcG(cur, next);
        next.H = AStar.calcH(next, ex, ey);
        next.F = next.G + next.H;
        this.addToOpenList(next);
      } else {
        var next2 = this.nodes.get(n.id);
        var testG = AStar.calcG(cur, next2);
        if (testG < next2.G) {
          var oldF = next2.F;
          next2.G = testG;
          next2.F = next2.G + next2.H;
          next2.parentId = cur.id;
          // C++ 里是过滤整个堆移除旧 (F,id) 再压入新值
          var tmp = [];
          for (var j = 0; j < this.entryList.length; j++) {
            var e = this.entryList[j];
            if (e.id === next2.id && e.F === oldF) continue;
            tmp.push(e);
          }
          this.entryList = tmp;
          this.pushEntry(next2.F, next2.id);
        }
      }
      if (this.openSet.has(endId)) return endId;
    }
  }
  return -1;
};
