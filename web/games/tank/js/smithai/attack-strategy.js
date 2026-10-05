// smithai/attack-strategy.js —— 对应 C++ smithAI/AttackStrategy.h / .cc（转向瞄准并开火）

function AttackStrategy(pos) {
  Strategy.call(this, STRATEGY_ATTACK);
  this.attackingPos = pos;
  this.done = false;
}
AttackStrategy.prototype = Object.create(Strategy.prototype);
AttackStrategy.prototype.constructor = AttackStrategy;

// 对照 AttackStrategy::update —— 转到目标角度（误差 < 4°）就开火
AttackStrategy.prototype.update = function (ctl, tank, globalStep) {
  if (this.done) return false;
  var cur = tank.getCurrentPosition();
  if (Math.abs(cur.angle - this.attackingPos.angle) < 4) {
    tank.rotateCW(false);
    tank.rotateCCW(false);
    ctl.fire(tank);
    this.done = true;
    return false;
  } else {
    var vAttack = getUnitVector(this.attackingPos.angle);
    var vt = getUnitVector(cur.angle);
    if (vt.cross(vAttack) > 0) tank.rotateCW(true);
    else tank.rotateCCW(true);
  }
  return true;
};

AttackStrategy.prototype.cancelAttack = function () { this.done = true; };
