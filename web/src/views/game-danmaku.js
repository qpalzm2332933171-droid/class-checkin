import { defineView, registerRoute, ref, onMounted, onUnmounted, navigate,
         api, store, toast, haptic, mediaUrl, registerBack } from "../ui.js";

// 弹幕大战：iframe 插件式接入（游戏本体在 /games/danmaku/index.html，独立可运行）。
// 桥接协议（postMessage，双向）：
//   游戏 → 宿主: {type:'danmaku-ready'}          加载完成，请求玩家信息
//   宿主 → 游戏: {type:'danmaku-player', name, points}  显示玩家名与积分角标
//   游戏 → 宿主: {type:'danmaku-score', score}   GAME OVER 一次性上报本局得分
registerRoute("/games/danmaku", defineView("gameDanmaku", {
  template: `
  <div class="page-plain danmaku-shell">
    <iframe ref="gameEl" class="danmaku-frame" :src="gameSrc" title="弹幕大战"
            allow="autoplay; fullscreen" allowfullscreen @load="sendPlayer"></iframe>
    <button class="btn btn-icon glass glass-thin danmaku-back" @click="goBack" aria-label="返回">
      <Icon n="back" :size="20" />
    </button>
  </div>`,
  style: `
  .danmaku-shell { position: fixed; inset: 0; background: #000; z-index: 40; }
  .danmaku-frame { width: 100%; height: 100%; border: 0; display: block; }
  .danmaku-back { position: absolute; top: calc(var(--safe-t) + 8px); left: 10px; z-index: 2; }
  `,
  setup() {
    const gameEl = ref(null);
    // 必须 mediaUrl()：安卓壳是 file:// 加载宿主页，相对路径 iframe 会 404
    const gameSrc = mediaUrl("/games/danmaku/index.html");
    let stops = [];

    function goBack() { navigate("/games"); }

    function sendPlayer() {
      const el = gameEl.value;
      if (!el || !el.contentWindow) return;
      const user = store.user || {};
      el.contentWindow.postMessage({
        type: "danmaku-player",
        name: user.name || store.alias || "同学",
        points: store.points ? store.points.total : 0,
      }, "*");
    }

    async function reportScore(rawScore) {
      const score = Math.max(0, Math.floor(Number(rawScore) || 0));
      const pts = Math.floor(score / 20000);
      if (!pts) { toast("本局未达到 2 万分，不计积分", "info"); return; }
      try {
        const res = await api("/api/games/solo/points",
                              { method: "POST", body: { kind: "danmaku", score: score } });
        if (res.points) store.points = res.points;
        toast("弹幕大战结算：+" + (res.awarded || pts) + " 积分", "ok", 3600);
        haptic([10, 40, 10]);
        sendPlayer();   // 把最新总积分同步给游戏内角标
      } catch (err) {
        // 429 冷却 / 400 未知游戏（服务端未更新时）都在这里兜底，不重试
        toast(err.message, "warn", 3600);
      }
    }

    function onMessage(ev) {
      const el = gameEl.value;
      if (!el || !el.contentWindow || ev.source !== el.contentWindow) return;
      const d = ev.data || {};
      if (d.type === "danmaku-ready") sendPlayer();
      else if (d.type === "danmaku-score") reportScore(d.score);
    }

    onMounted(() => {
      window.addEventListener("message", onMessage);
      stops.push(registerBack("/games/danmaku", () => { navigate("/games"); return true; }));
    });
    onUnmounted(() => {
      window.removeEventListener("message", onMessage);
      stops.forEach((fn) => fn && fn());
    });

    return { gameEl, gameSrc, goBack, sendPlayer };
  },
}));
