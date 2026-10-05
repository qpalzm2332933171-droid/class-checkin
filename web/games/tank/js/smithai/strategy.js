// smithai/strategy.js —— 对应 C++ smithAI/Strategy.h（策略基类）

var STRATEGY_DODGE = 0;
var STRATEGY_CONTACT = 1;
var STRATEGY_ATTACK = 2;

function Strategy(type) {
  this._type = type;
}

Strategy.prototype.type = function () { return this._type; };
