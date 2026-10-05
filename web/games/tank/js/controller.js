// controller.js —— 对应 C++ Controller.h / Controller.cc（控制器基类）
// 注意：C++ 里游戏逻辑跑独立线程、GUI 读 COW 快照；JS 单线程，直接共享引用即可

// controller/Data.h 的 PlayerInfo
function PlayerInfo(nickname, color) {
  this.nickname_ = nickname;
  this.color_ = color;
  this.score_ = 0;
}

function Controller() {
  this.blocks = new Map();        // unordered_map<int, Block>
  this.playersInfo = new Map();   // std::map<int, PlayerInfo>（JS Map 按插入序 = 按 id 有序）
  this.objects = new Map();       // ObjectList（C++ 里在 LocalController，这里提到基类方便访问）
}

// C++ 返回 COW 快照副本；JS 单线程直接返回本体
Controller.prototype.getObjects = function () { return this.objects; };

Controller.prototype.getBlocks = function () { return this.blocks; };

Controller.prototype.getPlaysInfo = function () {
  return Array.from(this.playersInfo.values());
};

Controller.prototype.quitGame = function () {};
