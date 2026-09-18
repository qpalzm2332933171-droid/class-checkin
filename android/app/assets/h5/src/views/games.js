import {
  defineView, registerRoute, ref, computed, onMounted, onUnmounted, nextTick, api, store, navigate, toast, onWs, wsSend,
  haptic, registerSwipe, pillStyle,
} from "../ui.js";

const SINGLE = [
  { key: "2048", name: "2048", desc: "滑一滑，把数字合到 2048", icon: "puzzle", path: "/games/2048" },
  { key: "mine", name: "扫雷", desc: "经典 9×9，长按插旗", icon: "flag", path: "/games/mine" },
];
const ONLINE = [
  { key: "gomoku", name: "五子棋", desc: "15×15 对弈，五连即胜", icon: "grid" },
  { key: "tictactoe", name: "井字棋", desc: "30 秒一局的极简对局", icon: "grid" },
  { key: "draw", name: "你画我猜", desc: "2~10 人轮流作画互相猜", icon: "brush" },
  { key: "bomb", name: "数字炸弹", desc: "轮流报数，踩中炸弹的人出局", icon: "bomb" },
];

registerRoute("/games", defineView("games", {
  template: `
  <div class="games-root">
  <div class="page">
    <header class="big-title row-between">
      <div>
        <h1 class="t1">小游戏</h1>
        <p class="sub mt2">{{ store.online }} 人在线 · 随时开一局</p>
      </div>
      <button class="btn btn-icon glass glass-thin" @click="refresh"><Icon n="refresh" :size="19" /></button>
    </header>

    <div class="seg seg-haspill mt5" ref="segEl">
      <span class="seg-pill" :style="pill" aria-hidden="true"></span>
      <button :class="{ on: tab === 'online' }" @click="setTab('online')">联机对战</button>
      <button :class="{ on: tab === 'single' }" @click="setTab('single')">单机休闲</button>
    </div>

    <div class="x-stage">
      <div class="x-track" ref="trackEl" :class="{ anim: xAnim }">
      <!-- 联机 -->
      <section class="x-pane">
        <h2 class="section-title">开个房间</h2>
        <div class="grid2">
          <button v-for="g in onlineGames" :key="g.key" class="glass glass-liquid pad5 game-card" @click="pick(g)">
            <span class="gicon"><Icon :n="g.icon" :size="24" /></span>
            <b class="t3">{{ g.name }}</b>
            <span class="cap">{{ g.desc }}</span>
          </button>
        </div>

        <h2 class="section-title">正在进行的房间</h2>
        <div v-if="rooms.length" class="stack">
          <div v-for="room in rooms" :key="room.id" class="glass glass-thin pad5 room-card">
            <div class="row gap2">
              <span class="room-code">{{ room.code }}</span>
              <b class="grow elide">{{ room.name }}</b>
              <span class="chip" :class="room.started ? 'chip-orange' : 'chip-accent'">
                {{ room.finished ? '已结束' : (room.started ? '进行中' : '等人加入') }}
              </span>
            </div>
            <p class="cap mt2 elide">{{ room.started_names.join('、') || '还没有人' }}<span v-if="room.spectators"> · {{ room.spectators }} 人围观</span></p>
            <div class="row gap2 mt3">
              <span class="cap num grow">{{ room.players }}/{{ room.max }} 人</span>
              <button class="btn btn-sm" @click="spectate(room)">观战</button>
              <button v-if="room.can_join" class="btn btn-sm btn-primary" @click="joinRoom(room)">
                {{ room.players ? '加入' : '进入' }}
              </button>
              <span v-else class="chip chip-orange">已满</span>
            </div>
          </div>
        </div>
        <div v-else class="glass glass-thin pad6 center sub">还没有房间，点上面的按钮开一个吧</div>
      </section>

      <!-- 单机 -->
      <section class="x-pane">
        <div class="stack mt4">
          <button v-for="g in singleGames" :key="g.key" class="glass glass-liquid pad5 row gap4 game-card-wide" @click="navigate(g.path)">
            <span class="gicon"><Icon :n="g.icon" :size="24" /></span>
            <span class="grow" style="text-align:left">
              <b class="t3">{{ g.name }}</b>
              <p class="cap mt2">{{ g.desc }}</p>
            </span>
            <Icon n="back" :size="18" style="transform:rotate(180deg);color:var(--ink-3)" />
          </button>
        </div>
      </section>
      </div>
    </div>

    <h2 class="section-title">最近战绩</h2>
    <div class="glass glass-thin list">
      <div v-for="r in records" :key="r.id" class="list-row">
        <span class="chip">{{ nameOf(r.game) }}</span>
        <span class="grow elide">{{ winnersText(r) }}</span>
        <span class="cap">{{ shortTime(r.created_at) }}</span>
      </div>
      <div v-if="!records.length" class="list-row sub">还没有对战记录</div>
    </div>

    <div v-if="tab === 'online'" class="swipe-hint mt5">左右滑动可切换 联机 / 单机</div>
  </div>

  <Transition name="fade">
    <div v-if="dialog" class="scrim" @click="closeDialog"></div>
  </Transition>
  <Transition name="mat">
    <div v-if="dialog" class="modal room-modal glass glass-thick">
      <template v-if="dialog.step === 'choose'">
        <h3 class="t3">{{ dialog.game.name }}</h3>
        <p class="sub mt2">{{ dialog.game.desc }}</p>
        <div class="stack mt5">
          <button class="btn btn-primary btn-block" @click="dialog.step = 'create'">创建房间</button>
          <button class="btn btn-block" @click="dialog.step = 'join'">加入房间</button>
        </div>
      </template>

      <template v-else-if="dialog.step === 'create'">
        <h3 class="t3">创建 {{ dialog.game.name }} 房间</h3>
        <p class="sub mt2">想要固定房间号就填一个四位数，不填我们随机生成。</p>
        <input class="field mt4 code-input" v-model="codeInput" inputmode="numeric" maxlength="4" placeholder="房间号（可留空）" />
        <div class="row gap2 mt5">
          <button class="btn grow" @click="back">返回</button>
          <button class="btn btn-primary grow" @click="doCreate">创建</button>
        </div>
      </template>

      <template v-else>
        <h3 class="t3">加入 {{ dialog.game.name }} 房间</h3>
        <p class="sub mt2">输入房主分享给你的四位房间号。</p>
        <input class="field mt4 code-input" v-model="codeInput" inputmode="numeric" maxlength="4" placeholder="房间号" />
        <div class="row gap2 mt5">
          <button class="btn grow" @click="back">返回</button>
          <button class="btn btn-primary grow" @click="doJoin">加入</button>
        </div>
      </template>
    </div>
  </Transition>
  </div>
  `,
  style: `
  .games-root { display: block; }
  .grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--s3); }
  .game-card { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left;
    border: 1px solid var(--hair); cursor: pointer; transition: transform var(--dur-fast) var(--ease-out); }
  .game-card:active { transform: scale(0.975); }
  .game-card-wide { cursor: pointer; border: 1px solid var(--hair); transition: transform var(--dur-fast) var(--ease-out); }
  .game-card-wide:active { transform: scale(0.985); }
  .gicon { width: 42px; height: 42px; border-radius: 14px; display: flex; align-items: center; justify-content: center;
    background: var(--accent-soft); color: var(--accent); margin-bottom: 4px; }
  .room-card { display: block; }
  .room-modal { z-index: 61; width: min(90vw, 360px); padding: var(--s5); border-radius: var(--r-xl); }
  .code-input { text-align: center; font-size: 26px; letter-spacing: 0.24em; font-variant-numeric: tabular-nums;
    padding: 14px; font-weight: 600; }
  `,
  setup() {
    const ORDER = ["online", "single"];
    const tab = ref("online");
    const rooms = ref([]);
    const records = ref([]);
    const dialog = ref(null);
    const codeInput = ref("");
    const trackEl = ref(null);
    const segEl = ref(null);
    const pill = ref("opacity:0");
    const xAnim = ref(false);
    let xDrag = 0;
    let stops = [];

    const xIndex = computed(() => Math.max(0, ORDER.indexOf(tab.value)));

    /** 轨道 + 滑块用同一份位移渲染，两边永远同速同曲线 */
    function renderX() {
      if (trackEl.value) {
        trackEl.value.style.transform = "translate3d(calc(-" + (xIndex.value * 100) + "% + " + Math.round(xDrag) + "px),0,0)";
      }
      pill.value = pillStyle(segEl.value, xDrag / ORDER.length) + (xAnim.value ? "" : "transition:none;");
    }

    function onSwipe(e) {
      if (e.phase === "move") {
        xAnim.value = false;
        xDrag = e.dx;
        if (trackEl.value) trackEl.value.classList.remove("anim");
        renderX();
        return;
      }
      const dx = e.dx;
      const far = Math.abs(dx) > Math.min(88, e.width * 0.2) || (Math.abs(e.velocity || 0) > 0.35 && Math.abs(dx) > 22);
      xAnim.value = true;
      if (e.phase === "end" && far) {
        const next = xIndex.value + (e.dir > 0 ? 1 : -1);
        if (ORDER[next]) { tab.value = ORDER[next]; haptic(6); }
      }
      xDrag = 0;
      nextTick(() => { renderX(); });
    }

    window.addEventListener("resize", () => renderX());

    function nameOf(key) { return (ONLINE.find((g) => g.key === key) || { name: key }).name; }
    function shortTime(ts) {
      const d = new Date(ts * 1000);
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    function winnersText(row) {
      try {
        const winners = JSON.parse(row.winners || "[]");
        const players = JSON.parse(row.players || "[]");
        if (!winners.length) return "平局 / 无胜者";
        return winners.map((uid) => (players.find((p) => p.uid === uid) || {}).name || "?").join("、") + " 获胜";
      } catch (err) { return ""; }
    }

    async function refresh() {
      wsSend({ t: "game.list" });
      try {
        const meta = await api("/api/games/meta");
        records.value = meta.records || [];
      } catch (err) { /* ignore */ }
    }

    function setTab(next) {
      if (next === tab.value) return;
      xAnim.value = true;
      xDrag = 0;
      tab.value = next;
      haptic(6);
      nextTick(() => { renderX(); });
    }

    function pick(game) {
      codeInput.value = "";
      dialog.value = { game, step: "choose" };
      haptic(6);
    }
    function back() {
      if (dialog.value && dialog.value.step !== "choose") dialog.value.step = "choose";
      else closeDialog();
    }
    function closeDialog() { dialog.value = null; codeInput.value = ""; }

    function doCreate() {
      const code = (codeInput.value || "").replace(/\D/g, "");
      if (code && code.length !== 4) { toast("房间号需要是 4 位数字", "warn"); return; }
      const game = dialog.value.game;
      wsSend({ t: "game.create", game: game.key, code: code });
      closeDialog();
      toast("正在创建房间…", "info", 1200);
    }
    function doJoin() {
      const code = (codeInput.value || "").replace(/\D/g, "");
      if (!code) { toast("请输入四位房间号", "warn"); return; }
      wsSend({ t: "game.join", room: code, play: true });
      closeDialog();
      toast("正在加入房间 " + code + "…", "info", 1200);
    }
    function joinRoom(room) {
      wsSend({ t: "game.join", room: room.id, play: true });
      toast("正在加入房间 " + room.code + "…", "info", 1200);
    }
    function spectate(room) {
      wsSend({ t: "game.join", room: room.id, play: false });
      toast("正在进入观战…", "info", 1200);
    }

    function routeFor(room) {
      if (["gomoku", "tictactoe"].includes(room.game)) return "/games/board?room=" + room.id;
      if (room.game === "draw") return "/games/draw?room=" + room.id;
      if (room.game === "bomb") return "/games/bomb?room=" + room.id;
      return "/games";
    }

    onMounted(() => {
      refresh();
      stops.push(registerSwipe("/games", onSwipe, (dir) => {
        if (dialog.value) return true;
        const next = xIndex.value + (dir > 0 ? 1 : -1);
        return !!ORDER[next];      // 到头了就交给外层底栏分页
      }));
      nextTick(() => { renderX(); });
      stops.push(onWs("game.rooms", (msg) => { rooms.value = msg.rooms || []; }));
      stops.push(onWs("game.entered", (msg) => {
        const room = msg.room;
        if (room) navigate(routeFor(room));
      }));
      stops.push(onWs("game.error", (msg) => toast(msg.text || "房间不存在", "warn", 3000)));
    });
    onUnmounted(() => stops.forEach((fn) => fn && fn()));

    return { tab, rooms, records, dialog, codeInput, onlineGames: ONLINE, singleGames: SINGLE, store,
             trackEl, segEl, pill, xAnim,
             refresh, setTab, pick, back, closeDialog, doCreate, doJoin, joinRoom, spectate,
             nameOf, shortTime, winnersText, navigate };
  },
}));

