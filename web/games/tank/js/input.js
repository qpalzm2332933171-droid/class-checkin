// input.js —— 对应 C++ Window.cc 的键盘处理（边沿触发）+ 新增触屏虚拟按键

// ControlEvent::Operation（顺序与原版枚举一致）
var OP_FORWARD = 0;
var OP_BACKWARD = 1;
var OP_ROTATE_CW = 2;
var OP_ROTATE_CCW = 3;
var OP_FIRE = 4;
var OP_STOP_FORWARD = 5;
var OP_STOP_BACKWARD = 6;
var OP_STOP_ROTATE_CW = 7;
var OP_STOP_ROTATE_CCW = 8;

// 键盘输入：对照 Window::on_key_press/release_event ——
// 边沿触发（布尔标志防 key repeat），松开发对应 Stop 操作
function InputManager(dispatch) {
  this.dispatch = dispatch;
  this.KeyUpPressed = false;
  this.KeyDownPressed = false;
  this.KeyLeftPressed = false;
  this.KeyRightPressed = false;
  this.spacePressed = false;

  this._onKeyDown = this.onKeyDown.bind(this);
  this._onKeyUp = this.onKeyUp.bind(this);
  this._onBlur = this.onBlur.bind(this);
  window.addEventListener("keydown", this._onKeyDown);
  window.addEventListener("keyup", this._onKeyUp);
  window.addEventListener("blur", this._onBlur);
}

InputManager.prototype.onKeyDown = function (e) {
  if (e.code === "ArrowUp" && !this.KeyUpPressed) {
    this.KeyUpPressed = true;
    this.dispatch(OP_FORWARD);
  } else if (e.code === "ArrowDown" && !this.KeyDownPressed) {
    this.KeyDownPressed = true;
    this.dispatch(OP_BACKWARD);
  } else if (e.code === "ArrowLeft" && !this.KeyLeftPressed) {
    this.KeyLeftPressed = true;
    this.dispatch(OP_ROTATE_CCW);
  } else if (e.code === "ArrowRight" && !this.KeyRightPressed) {
    this.KeyRightPressed = true;
    this.dispatch(OP_ROTATE_CW);
  } else if (e.code === "Space" && !this.spacePressed) {
    this.spacePressed = true;
    this.dispatch(OP_FIRE);
  } else return;
  e.preventDefault();
};

InputManager.prototype.onKeyUp = function (e) {
  if (e.code === "ArrowUp") {
    this.KeyUpPressed = false;
    this.dispatch(OP_STOP_FORWARD);
  } else if (e.code === "ArrowDown") {
    this.KeyDownPressed = false;
    this.dispatch(OP_STOP_BACKWARD);
  } else if (e.code === "ArrowLeft") {
    this.KeyLeftPressed = false;
    this.dispatch(OP_STOP_ROTATE_CCW);
  } else if (e.code === "ArrowRight") {
    this.KeyRightPressed = false;
    this.dispatch(OP_STOP_ROTATE_CW);
  } else if (e.code === "Space") {
    this.spacePressed = false;
  } else return;
  e.preventDefault();
};

// 失焦（切窗口 / 点 iframe 外）时停掉所有动作，防止按键状态残留
InputManager.prototype.onBlur = function () {
  if (this.KeyUpPressed) { this.KeyUpPressed = false; this.dispatch(OP_STOP_FORWARD); }
  if (this.KeyDownPressed) { this.KeyDownPressed = false; this.dispatch(OP_STOP_BACKWARD); }
  if (this.KeyLeftPressed) { this.KeyLeftPressed = false; this.dispatch(OP_STOP_ROTATE_CCW); }
  if (this.KeyRightPressed) { this.KeyRightPressed = false; this.dispatch(OP_STOP_ROTATE_CW); }
  this.spacePressed = false;
};

InputManager.prototype.release = function () {
  window.removeEventListener("keydown", this._onKeyDown);
  window.removeEventListener("keyup", this._onKeyUp);
  window.removeEventListener("blur", this._onBlur);
};

// 触屏虚拟摇杆 + 开火键（原版没有，网页/安卓壳在手机上需要）。
// 左下固定双圈摇杆：径向距离 r 归一化 —— 0~1 内圈只调整坦克朝向，1~2 外圈锁定朝向
// 沿摇杆方向前进（r 越大越快）；中心带死区，输入角度 EMA 平滑。
// 右下圆形开火键：按下发射子弹。摇杆状态挂在 ctl.joystick 上，每 tick 由
// LocalController.applyJoystick 生效（触屏与键盘二选一，摇杆按下时优先生效）。
function setupTouchControls(ctl) {
  var zone = document.getElementById("joyZone");
  var base = document.getElementById("joyBase");
  var knob = document.getElementById("joyKnob");
  var fireBtn = document.getElementById("btnFire");
  if (!zone || !base || !knob || !fireBtn) return;

  var joy = { active: false, r: 0, rawAngle: 0, smoothAngle: 0, moveAcc: 0, fresh: true };
  ctl.joystick = joy;

  function joyCenter() {
    var rect = base.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function joyStop() {
    ctl.dispatchEvent(OP_STOP_FORWARD);
    ctl.dispatchEvent(OP_STOP_BACKWARD);
    ctl.dispatchEvent(OP_STOP_ROTATE_CW);
    ctl.dispatchEvent(OP_STOP_ROTATE_CCW);
  }

  function updateJoy(cx, cy) {
    var c = joyCenter();
    var dx = cx - c.x, dy = cy - c.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) { joy.r = 0; knob.style.transform = "translate(0px, 0px)"; return; }
    // 归一化 r：内环边界（30px）= 1，满行程（60px）= 2
    joy.r = Math.min(2 * dist / JOY_MAX_TRAVEL, 2);
    var a = Math.atan2(-dy, dx) * 180 / Math.PI;
    if (a < 0) a += 360;
    joy.rawAngle = a;
    // 角度平滑：最短弧 EMA，压掉手指抖动（横穿 0° 不跳变）；
    // 每次按下从当前角度直接开始，不做大弧追赶
    if (joy.fresh) { joy.smoothAngle = a; joy.fresh = false; }
    else {
      var d = ((a - joy.smoothAngle + 540) % 360) - 180;
      joy.smoothAngle = (joy.smoothAngle + d * JOY_ANGLE_SMOOTH + 360) % 360;
    }
    // 旋钮跟手：行程内 1:1，超出行程锁在边缘
    var k = Math.min(dist, JOY_MAX_TRAVEL) / dist;
    knob.style.transform = "translate(" + (dx * k) + "px," + (dy * k) + "px)";
  }

  function onDown(e) {
    if (joy.active) return;
    joy.active = true;
    joy.moveAcc = 0;
    joy.fresh = true;
    if (zone.setPointerCapture) { try { zone.setPointerCapture(e.pointerId); } catch (err) {} }
    updateJoy(e.clientX, e.clientY);
    e.preventDefault();
  }
  function onMove(e) {
    if (!joy.active) return;
    updateJoy(e.clientX, e.clientY);
    e.preventDefault();
  }
  function onUp(e) {
    if (!joy.active) return;
    joy.active = false;
    joy.r = 0;
    joy.moveAcc = 0;
    knob.style.transform = "translate(0px, 0px)";
    joyStop();
    e.preventDefault();
  }
  zone.addEventListener("pointerdown", onDown);
  zone.addEventListener("pointermove", onMove);
  zone.addEventListener("pointerup", onUp);
  zone.addEventListener("pointercancel", onUp);

  fireBtn.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    ctl.dispatchEvent(OP_FIRE);
    fireBtn.classList.add("pressed");
  });
  var fireEnd = function (e) {
    e.preventDefault();
    fireBtn.classList.remove("pressed");
  };
  fireBtn.addEventListener("pointerup", fireEnd);
  fireBtn.addEventListener("pointercancel", fireEnd);
}

function isTouchDevice() {
  return ("ontouchstart" in window) ||
         (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}
