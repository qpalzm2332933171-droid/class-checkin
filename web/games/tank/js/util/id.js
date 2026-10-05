// util/id.js —— 对应 C++ util/Id.cc
// ID 分段：坦克 1..10，墙 11..136（MAX_BLOCKS_NUM+11-1=146 是最后一个块 id），炮弹 147 起
// 每局结束（restart / 析构）必须 reset()
var Id = {
  globalTankId: 1,
  globalBlockId: 11,
  globalShellId: MAX_BLOCKS_NUM + 11, // 147

  getTankId: function () { return this.globalTankId++; },
  getBlockId: function () { return this.globalBlockId++; },
  getShellId: function () { return this.globalShellId++; },

  reset: function () {
    this.globalTankId = 1;
    this.globalBlockId = 11;
    this.globalShellId = MAX_BLOCKS_NUM + 11;
  },
};
