import { defineView, registerRoute, ref, onMounted, onUnmounted, navigate,
         api, store, toast, haptic, mediaUrl, registerBack } from "../ui.js";

// 坦克大战：iframe 插件式接入（游戏本体在 /games/tank/index.html，独立可运行、零依赖）。
// 桥接协议（postMessage，双向）：
//   游戏 → 宿主: {type:'tank-ready'}              加载完成，请求玩家信息
//   宿主 → 游戏: {type:'tank-player', name}       玩家名（显示在比分侧栏）
//   游戏 → 宿主: {type:'tank-score', score}       退出时上报本局击毁数（每击毁 1 辆 +1 积分）
registerRoute("/games/tank", defineView("gameTank", {
  template: `
  <div class="page-plain tank-shell">
    <iframe ref="gameEl" class="tank-frame" :src="gameSrc" title="坦克大战"
            allow="autoplay; fullscreen" allowfullscreen @load="sendPlayer"></iframe>
    <button class="btn btn-icon glass glass-thin tank-back" @click="goBack" aria-label="返回大厅">
      <Icon n="back" :size="20" />
    </button>
  </div>`,
  style: `
  .tank-shell { position: fixed; inset: 0; background: var(--bg); z-index: 40; }
  .tank-frame { width: 100%; height: 100%; border: 0; display: block; }
  /* 返回键放左下角：右上/左上留给游戏 HUD */
  .tank-back { position: absolute; left: 12px; bottom: calc(var(--safe-b) + 12px); z-index: 2; }
  `,
  setup() {
    const gameEl = ref(null);
    // 必须 mediaUrl()：安卓壳是 file:// 加载宿主页，相对路径 iframe 会 404
    const gameSrc = mediaUrl("/games/tank/index.html");
    let stops = [];

    let leaveTimer = null;
    let leaving = false;

    // 离开前先让游戏结算：点宿主返回键 / 安卓返回键退出时，
    // 游戏刚打完的那一局也得算分（游戏内的「退出」按钮自己会上报，这里是兜底）。
    // 等 tank-score 回来再跳；400ms 还没等到（iframe 卡住之类）就直接走，不卡返回键。
    function goBack() {
      const el = gameEl.value;
      if (!leaving && el && el.contentWindow) {
        leaving = true;
        try { el.contentWindow.postMessage({ type: "tank-quit" }, "*"); } catch (err) { /* 忽略 */ }
        leaveTimer = setTimeout(() => navigate("/games"), 400);
        return;
      }
      navigate("/games");
    }

    function sendPlayer() {
      const el = gameEl.value;
      if (!el || !el.contentWindow) return;
      const user = store.user || {};
      el.contentWindow.postMessage({
        type: "tank-player",
        name: user.name || store.alias || "同学",
      }, "*");
    }

    async function reportScore(rawScore) {
      const score = Math.max(0, Math.floor(Number(rawScore) || 0));
      if (!score) return;
      try {
        const res = await api("/api/games/solo/points",
                              { method: "POST", body: { kind: "tank", score: score } });
        if (res.points) store.points = res.points;
        toast("坦克大战结算：+" + (res.awarded || 0) + " 积分", "ok", 3600);
        haptic([10, 40, 10]);
      } catch (err) {
        // 429 冷却 / 400 未知游戏（服务端未更新时）都在这里兜底，不重试
        toast(err.message, "warn", 3600);
      }
    }

    function onMessage(ev) {
      const el = gameEl.value;
      if (!el || !el.contentWindow || ev.source !== el.contentWindow) return;
      const d = ev.data || {};
      if (d.type === "tank-ready") sendPlayer();
      else if (d.type === "tank-score") {
        reportScore(d.score);
        if (leaving) {   // 结算回来了，可以走了
          if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
          navigate("/games");
        }
      }
    }

    onMounted(() => {
      window.addEventListener("message", onMessage);
      // 安卓原生返回键也走 goBack()：这里以前直接 navigate，于是按硬件返回键
      // 退出时这一局照样不结算（和界面返回按钮是同一条丢分 bug）。
      stops.push(registerBack("/games/tank", () => { goBack(); return true; }));
    });
    onUnmounted(() => {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      window.removeEventListener("message", onMessage);
      stops.forEach((fn) => fn && fn());
    });

    return { gameEl, gameSrc, goBack, sendPlayer };
  },
}));
