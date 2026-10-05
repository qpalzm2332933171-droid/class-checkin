// smithai/dodge-strategy.js —— 对应 C++ smithAI/DodgeStrategy.h / .cc（躲避指令队列）

// DodgeStrategy::DodgeOperation
var DODGE_CMD_MOVE_FORWARD = 0;
var DODGE_CMD_MOVE_BACKWARD = 1;
var DODGE_CMD_ROTATE_CW = 2;
var DODGE_CMD_ROTATE_CCW = 3;
var DODGE_CMD_FORWARD_CW = 4;
var DODGE_CMD_FORWARD_CCW = 5;
var DODGE_CMD_BACKWARD_CW = 6;
var DODGE_CMD_BACKWARD_CCW = 7;

// DodgeStrategy::DodgeCommand
function DodgeCommand(op, step, targetStep) {
  this.op = op;
  this.step = step;
  this.targetStep = targetStep === undefined ? 0 : targetStep;
}

function DodgeStrategy(needStep) {
  Strategy.call(this, STRATEGY_DODGE);
  if (needStep === undefined) needStep = 0;
  this.cmds = [];          // deque
  this.prevPos = new PosInfo();
  this.needStep = needStep;
}
DodgeStrategy.prototype = Object.create(Strategy.prototype);
DodgeStrategy.prototype.constructor = DodgeStrategy;

DodgeStrategy.prototype.addCmd = function (cmd) { this.cmds.push(cmd); };

DodgeStrategy.prototype.popBack = function () { this.cmds.pop(); };

DodgeStrategy.prototype.isEmpty = function () { return this.cmds.length === 0; };

DodgeStrategy.prototype.isValid = function () { return this.cmds.length > 0; };

// 对照 DodgeStrategy::update —— 逐 tick 执行队首指令，卡死时反向 10 tick
DodgeStrategy.prototype.update = function (ctl, tank, globalStep) {
  var isForwarding = tank.isForwarding();
  var isBackwarding = tank.isBackwarding();
  if (this.cmds.length === 0) return false;
  tank.stop();
  var cmd = this.cmds.shift();
  var cur = tank.getCurrentPosition();
  if (cmd.targetStep === 0) {
    cmd.targetStep = globalStep + cmd.step;
    this.cmds.unshift(cmd);
  }
  switch (cmd.op) {
    case DODGE_CMD_ROTATE_CW:
      if (globalStep < cmd.targetStep) { tank.rotateCW(true); this.cmds.unshift(cmd); }
      break;
    case DODGE_CMD_ROTATE_CCW:
      if (globalStep < cmd.targetStep) { tank.rotateCCW(true); this.cmds.unshift(cmd); }
      break;
    case DODGE_CMD_MOVE_FORWARD:
      if (globalStep < cmd.targetStep) { tank.forward(true); this.cmds.unshift(cmd); }
      break;
    case DODGE_CMD_MOVE_BACKWARD:
      if (globalStep < cmd.targetStep) { tank.backward(true); this.cmds.unshift(cmd); }
      break;
    case DODGE_CMD_FORWARD_CW:
      if (globalStep < cmd.targetStep) {
        tank.rotateCW(true); tank.forward(true); this.cmds.unshift(cmd);
      }
      break;
    case DODGE_CMD_FORWARD_CCW:
      if (globalStep < cmd.targetStep) {
        tank.rotateCCW(true); tank.forward(true); this.cmds.unshift(cmd);
      }
      break;
    case DODGE_CMD_BACKWARD_CW:
      if (globalStep < cmd.targetStep) {
        tank.rotateCW(true); tank.backward(true); this.cmds.unshift(cmd);
      }
      break;
    case DODGE_CMD_BACKWARD_CCW:
      if (globalStep < cmd.targetStep) {
        tank.rotateCCW(true); tank.backward(true); this.cmds.unshift(cmd);
      }
      break;
  }
  // 移动中位置没变 → 判定卡墙，反向 10 tick（对照原版逻辑）
  if (isForwarding && cur.pos.equals(this.prevPos.pos)) {
    this.cmds.length = 0;
    cmd = new DodgeCommand(DODGE_CMD_MOVE_BACKWARD, 0, globalStep + 10);
    this.cmds.unshift(cmd);
    tank.backward(true);
  } else if (isBackwarding && cur.pos.equals(this.prevPos.pos)) {
    this.cmds.length = 0;
    cmd = new DodgeCommand(DODGE_CMD_MOVE_FORWARD, 0, globalStep + 10);
    this.cmds.unshift(cmd);
    tank.forward(true);
  }
  this.prevPos = cur;
  return true;
};
