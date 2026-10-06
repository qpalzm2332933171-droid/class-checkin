// main.js —— 游戏入口：主菜单 / 游戏画面切换、10ms 游戏循环、
// 30ms 侧栏轮询（对照 GameView::getPlayersInfo）、与宿主页的 postMessage 桥

(function () {
  var menuEl = document.getElementById("menu");
  var gameEl = document.getElementById("game");
  var stageEl = document.getElementById("stage");
  var canvas = document.getElementById("gameCanvas");
  var playerInfoBox = document.getElementById("playerInfoBox");
  var startBtn = document.getElementById("startBtn");
  var quitBtn = document.getElementById("quitBtn");
  var touchControlsEl = document.getElementById("touchControls");

  var ctl = null;        // LocalController
  var renderer = null;   // GameRenderer
  var input = null;      // InputManager
  var tickTimer = null;  // 10ms：只跑 moveAll 逻辑（100Hz，物理判定与原版一致）
  var infoTimer = null;  // 30ms：侧栏比分轮询（对照 GameView 的 30ms timeout）
  var rafId = null;      // 重绘循环句柄
  var dirty = false;     // 上一帧逻辑之后画面是否变了
  var hostPlayerName = null;

  /* ---------------- 与宿主页（game-tank.js）的 postMessage 桥 ----------------
     对照弹幕大战协议：
       游戏 → 宿主: {type:"tank-ready"}           加载完成，请求玩家信息
       宿主 → 游戏: {type:"tank-player", name}    玩家名（显示在侧栏）
       游戏 → 宿主: {type:"tank-score", score}    退出时上报本局击毁数 */
  function post(type, data) {
    try {
      window.parent.postMessage(Object.assign({ type: type }, data || {}), "*");
    } catch (e) { /* 独立打开时无父页面，忽略 */ }
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (d.type === "tank-player") {
      var name = String(d.name || "").trim().slice(0, 50);
      hostPlayerName = name || null;
      refreshSidebar();
    } else if (d.type === "tank-quit") {
      // 宿主按了返回键（含安卓物理返回）：走和点「退出」同一条结算路，
      // 不然玩家用返回键离开就白玩一局
      quitGame();
    }
  });
  post("tank-ready");
  setTimeout(function () { post("tank-ready"); }, 300);

  /* ---------------- 视图切换 ---------------- */

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  // 让 iframe 拿到键盘焦点（桌面端直接开玩）
  function focusGame() {
    try { window.focus(); } catch (e) {}
    canvas.setAttribute("tabindex", "0");
    canvas.focus();
  }

  function startGame() {
    stopGame();
    ctl = new LocalController();
    ctl.start();
    renderer = new GameRenderer(canvas, ctl);
    input = new InputManager(function (op) { ctl.dispatchEvent(op); });
    setupTouchControls(ctl);
    if (isTouchDevice()) show(touchControlsEl);
    else hide(touchControlsEl);

    hide(menuEl);
    show(gameEl);
    focusGame();
    buildSidebar();

    renderer.draw();   // 开局先画一帧，不用等第一个 tick

    // 逻辑仍是 10ms 一次（100Hz），对照 C++ 主循环，物理判定完全不变；
    // 但重绘从「每个 tick 都全画布重画」改成 requestAnimationFrame：
    // 原来手机上每秒 100 次全屏 canvas 重绘，正是单机游戏玩一会就发烫的主因。
    // rAF 会自动对齐屏幕刷新率（手机一般 60/120Hz），页面切到后台也不再重绘。
    tickTimer = setInterval(function () {
      ctl.moveAll();
      dirty = true;
    }, 10);
    infoTimer = setInterval(updateSidebar, 30);
    drawLoop();
  }

  // 重绘循环：只有「上一帧逻辑跑过」才真正画，同一画面不会重复画
  function drawLoop() {
    rafId = requestAnimationFrame(drawLoop);
    if (!dirty || !renderer) return;
    dirty = false;
    renderer.draw();
  }

  function stopGame() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (infoTimer) { clearInterval(infoTimer); infoTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    dirty = false;
    if (input) { input.release(); input = null; }
    if (ctl) { ctl.stop(); ctl = null; }
    renderer = null;
  }

  // 退出：上报净胜分（玩家击毁数 - 人机击毁数，没超过人机就 0 分）→ 回主菜单
  // （对照 GameView::onQuit → 回 EntryView）
  function quitGame() {
    var score = 0;
    if (ctl) {
      var mine = ctl.playersInfo.get(PLAYER_TANK_ID).score_;
      var smith = ctl.playersInfo.get(AI_TANK_ID).score_;
      score = Math.max(0, mine - smith);   // 比人机多几分得几分
    }
    stopGame();
    hide(gameEl);
    show(menuEl);
    post("tank-score", { score: score });
  }

  // 侧栏：两名玩家的 图标 + 昵称 + 比分。
  // 原版 C++ 每 30ms 重建一次控件（GameView::getPlayersInfo），照搬到 DOM 上就是
  // 每秒 33 次 innerHTML 清空 + 重建 6 个元素 + 重画两个 canvas，手机上纯属白烧电：
  // 所以这里只建一次，之后每 30ms 只比较/更新两处文本。
  var sidebarRows = [];

  function buildSidebar() {
    if (!ctl) return;
    var players = ctl.getPlaysInfo();
    playerInfoBox.innerHTML = "";
    sidebarRows = [];
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var item = document.createElement("div");
      item.className = "player-item";

      var icon = document.createElement("canvas");
      icon.className = "player-icon";
      drawPlayerIcon(icon, p.color_);

      var nick = document.createElement("div");
      nick.className = "player-name";

      var score = document.createElement("div");
      score.className = "player-score";

      item.appendChild(icon);
      item.appendChild(nick);
      item.appendChild(score);
      playerInfoBox.appendChild(item);
      sidebarRows.push({ nick: nick, score: score });
    }
    updateSidebar();
  }

  function updateSidebar() {
    if (!ctl || !sidebarRows.length) return;
    var players = ctl.getPlaysInfo();
    for (var i = 0; i < sidebarRows.length && i < players.length; i++) {
      var name = players[i].nickname_;
      if (name === "你" && hostPlayerName) name = hostPlayerName;
      if (sidebarRows[i].nick.textContent !== name) sidebarRows[i].nick.textContent = name;
      var score = String(players[i].score_);
      if (sidebarRows[i].score.textContent !== score) sidebarRows[i].score.textContent = score;
    }
  }

  // 兼容旧调用点：名字变了要重画吗？不用，文本是每次比对的
  function refreshSidebar() { updateSidebar(); }

  /* ---------------- 自适应缩放 ----------------
     舞台固定 760×420（与原版窗口一致），视口更小时整体等比缩小 */
  function layoutScale() {
    var k = Math.min(window.innerWidth / WINDOW_WIDTH, window.innerHeight / WINDOW_HEIGHT);
    stageEl.style.transform = "scale(" + k + ")";
  }
  window.addEventListener("resize", layoutScale);
  layoutScale();

  /* ---------------- 事件绑定 ---------------- */
  startBtn.addEventListener("click", function () { startGame(); });
  quitBtn.addEventListener("click", quitGame);
  // 点击画面任意处（手机）确保焦点在 iframe 内
  document.addEventListener("click", focusGame);

  /* ---------------- 调试钩子（排查用，无害） ---------------- */
  window.__tankDebug = { getCtl: function () { return ctl; } };
  window.addEventListener("error", function (e) {
    (window.__tankErrors = window.__tankErrors || []).push(String(e.message || e.error));
  });
})();
