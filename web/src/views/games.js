import {
  defineView, registerRoute, ref, computed, onMounted, onUnmounted, nextTick, api, store, navigate, toast, onWs, wsSend,
  haptic, registerSwipe, pillStyle, mediaUrl,
} from "../ui.js";

const SINGLE = [
  { key: "2048", name: "2048", desc: "滑一滑，把数字合到 2048", icon: "puzzle", path: "/games/2048" },
  { key: "mine", name: "扫雷", desc: "经典 9×9，长按插旗", icon: "flag", path: "/games/mine" },
];
const ONLINE = [
  { key: "gomoku", name: "五子棋", desc: "15×15 对弈，五连即胜", icon: "grid" },
  { key: "tictactoe", name: "井字棋", desc: "30 秒一局的极简对局", icon: "grid" },
  { key: "go", name: "围棋", desc: "9 路棋盘 · 数子定胜负 · 黑贴 7.5 目", icon: "go" },
  { key: "xiangqi", name: "象棋", desc: "标准中国象棋 · 将死 / 困毙即胜", icon: "chess" },
  { key: "werewolf", name: "狼人杀", desc: "6~12 人正规板子 · 预女猎白", icon: "wolf" },
  { key: "draw", name: "你画我猜", desc: "2~10 人轮流作画互相猜", icon: "brush" },
  { key: "bomb", name: "数字炸弹", desc: "轮流报数，踩中炸弹的人出局", icon: "bomb" },
];

registerRoute("/games", defineView("games", {
  template: `
  <div class="games-root">
  <div class="page">
    <header class="big-title row-between">
      <div style="min-width:0">
        <h1 class="t1">小游戏</h1>
        <p class="sub mt2">{{ store.online }} 人在线 · 我的积分 <b>{{ myPoints.total }}</b></p>
      </div>
      <div class="row gap2">
        <button class="pt-chip" @click="openBoard('online')">
          <Icon n="crown" :size="17" /><span>{{ myPoints.total }}</span>
        </button>
        <button class="btn btn-icon glass glass-thin" @click="refresh"><Icon n="refresh" :size="19" /></button>
      </div>
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
        <div class="row-between sec-row">
          <h2 class="section-title">开个房间</h2>
          <button class="btn btn-sm glass glass-thin" @click="openBoard('online')">
            <Icon n="crown" :size="15" /> 联机榜
          </button>
        </div>
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
              <span v-if="room.opts && room.opts.size" class="chip">{{ room.opts.size }} 路</span>
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
        <div class="row-between sec-row">
          <h2 class="section-title">单机挑战</h2>
          <button class="btn btn-sm glass glass-thin" @click="openBoard('solo')">
            <Icon n="crown" :size="15" /> 单机榜
          </button>
        </div>
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
        <template v-if="dialog.game.key === 'go'">
          <p class="cap mt5">棋盘大小</p>
          <div class="row gap2 mt2">
            <button v-for="s in [9, 19]" :key="s" class="btn grow" :class="dialog.size === s ? 'btn-primary' : ''"
                    @click="dialog.size = s; haptic(6)">{{ s }} 路棋盘</button>
          </div>
          <p class="cap mt2">{{ dialog.size === 19 ? '19 路：标准大棋盘，一局慢一点' : '9 路：节奏快，几分钟一局' }}</p>
        </template>
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

  <Transition name="fade">
    <div v-if="board" class="scrim" @click="board = null"></div>
  </Transition>
  <Transition name="mat">
    <div v-if="board" class="modal board-modal glass glass-thick">
      <div class="row-between">
        <h3 class="t3"><Icon n="crown" :size="18" style="vertical-align:-3px" /> 积分排行榜</h3>
        <button class="btn btn-icon" @click="board = null"><Icon n="close" :size="18" /></button>
      </div>
      <div class="seg seg-haspill mt4" ref="boardSegEl">
        <span class="seg-pill" :style="boardPill" aria-hidden="true"></span>
        <button :class="{ on: board.scope === 'online' }" @click="switchScope('online')">联机榜</button>
        <button :class="{ on: board.scope === 'solo' }" @click="switchScope('solo')">单机榜</button>
      </div>
      <p class="cap mt3 text-center">{{ board.scope === 'online'
        ? '和别人打一局：赢 +2 分，输 -1 分（平局不加不减）'
        : '扫雷：正常 +1 / 困难 +2 / 极难 +3；2048：每合成一个 2048 +1' }}</p>
      <div class="glass glass-thin list mt3 board-list">
        <div v-for="row in board.rows" :key="row.uid" class="list-row" :class="{ me: row.uid === myId }">
          <span class="rank" :class="'r' + Math.min(row.rank, 4)">{{ row.rank }}</span>
          <span class="avatar avatar-sm" :style="{ background: row.color || '#8a94a6' }">
            <img v-if="row.avatar" :src="mediaUrl(row.avatar)" :alt="row.name" loading="lazy" />
            <template v-else>{{ (row.name || '?').slice(0,1) }}</template>
          </span>
          <span class="grow elide">{{ row.name }}<span v-if="row.uid === myId" class="cap"> · 我</span></span>
          <b class="num">{{ board.scope === 'online' ? row.online : row.solo }}</b>
        </div>
        <div v-if="!board.rows.length" class="list-row sub">还没有人得分，去开一局吧</div>
      </div>
      <p class="cap mt3">我的名次：{{ board.my_rank || '未上榜' }} · 总积分 {{ board.me ? board.me.total : 0 }}
        （联机 {{ board.me ? board.me.online : 0 }} · 单机 {{ board.me ? board.me.solo : 0 }}）</p>
    </div>
  </Transition>
  </div>
  `,
  style: `
  .games-root { display: block; }
  .sec-row { align-items: center; }
  .sec-row .section-title { margin-bottom: 0; }
  .pt-chip { display: inline-flex; align-items: center; gap: 5px; border: 0; cursor: pointer;
    padding: 9px 13px; border-radius: var(--r-full); font-weight: 700; font-size: var(--fs-sub); color: #fff;
    background: linear-gradient(180deg, color-mix(in srgb, var(--orange) 92%, #fff 8%), var(--orange));
    box-shadow: 0 6px 16px color-mix(in srgb, var(--orange) 28%, transparent); }
  .pt-chip:active { transform: scale(0.95); }
  .board-modal { z-index: 61; width: min(92vw, 400px); padding: var(--s5); border-radius: var(--r-xl); }
  .board-list { max-height: 46dvh; overflow-y: auto; }
  .board-list .list-row.me { background: var(--accent-soft); border-radius: var(--r-md); }
  .rank { width: 24px; text-align: center; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--ink-3); }
  .rank.r1 { color: #e8850c; } .rank.r2 { color: #8a94a6; } .rank.r3 { color: #b0763a; }
  .text-center { text-align: center; }
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
    const board = ref(null);                 // 排行榜弹层
    const boardSegEl = ref(null);
    const boardPill = ref("opacity:0");
    const xAnim = ref(false);
    let xDrag = 0;
    let stops = [];

    const xIndex = computed(() => Math.max(0, ORDER.indexOf(tab.value)));
    let paneWidth = 0;   // 一屏宽

    /* 拖动时关掉过渡（严格 1:1 跟手），松手前必须先恢复过渡并强制回流。
       如果在同一个 tick 里既恢复 transition 又改 transform，浏览器会把两件事
       合并成一次样式计算，直接跳到终点 —— 用户看到的就是"咔一下"。 */
    function pillDrag(on) {
      const seg = segEl.value;
      if (seg) seg.classList.toggle("pill-dragging", !!on);
    }
    function beginAnim() {
      const track = trackEl.value;
      const seg = segEl.value;
      xAnim.value = true;
      if (track && !track.classList.contains("anim")) track.classList.add("anim");
      if (seg) seg.classList.remove("pill-dragging");
      if (track) void track.offsetWidth;   // 强制回流：让过渡在这一刻真正生效
      if (seg) void seg.offsetWidth;
    }

    /** 轨道 + 滑块用同一份进度渲染，两边永远同速同曲线 */
    function renderX() {
      const track = trackEl.value;
      const w = (track && track.clientWidth) || paneWidth || 0;
      if (w) paneWidth = w;
      if (track && w) {
        /* 一律用像素：百分比 transform 在两个端点之间能否插值要看浏览器，
           用 px 才能保证过渡真的逐帧跑起来。 */
        const px = Math.round(-xIndex.value * w + xDrag);
        track.style.transform = px === 0 ? "" : "translate3d(" + px + "px,0,0)";
      }
      /* 滑块进度 = 翻页进度：拖满一屏刚好滑到相邻按钮，和内容同进同出。
         （以前这里写的是 xDrag / 分栏数，几百像素的位移除以 2，
          滑块直接被推到屏幕外面了 —— 就是"滑块飞走"那个 bug。） */
      const progress = xDrag && paneWidth ? Math.min(1, Math.abs(xDrag) / paneWidth) : 0;
      pill.value = pillStyle(segEl.value, progress, xDrag < 0 ? 1 : -1);
    }

    function onSwipe(e) {
      if (e.phase === "move") {
        xAnim.value = false;
        if (trackEl.value) trackEl.value.classList.remove("anim");
        pillDrag(true);
        xDrag = e.dx;
        renderX();
        return;
      }
      const dx = e.dx;
      const width = paneWidth || e.width || 1;
      /* 松手方向按实际位移算，中途反向也不会切错边 */
      const dir = dx < 0 ? 1 : -1;
      const far = Math.abs(dx) > Math.min(72, width * 0.18) || (Math.abs(e.velocity || 0) > 0.4 && Math.abs(dx) > 18);
      const next = ORDER[xIndex.value + dir];
      beginAnim();          // 先让过渡生效（此刻轨道还停在手指位置）
      if (e.phase === "end" && far && next) { tab.value = next; haptic(6); }
      xDrag = 0;            // 再改位移：要么滑到下一格，要么原地回弹
      nextTick(() => { renderX(); });
    }

    function onResize() { renderX(); }

    const myId = computed(() => (store.user && store.user.id) || 0);
    const myPoints = computed(() => store.points || { online: 0, solo: 0, total: 0 });

    async function loadBoard(scope) {
      try {
        const res = await api("/api/games/leaderboard", { query: "scope=" + scope });
        board.value = { scope: res.scope, rows: res.rows || [], me: res.me, my_rank: res.my_rank };
        if (res.me) store.points = res.me;
      } catch (err) { toast(err.message, "error"); }
    }

    function renderBoardPill() { boardPill.value = pillStyle(boardSegEl.value, 0, 1); }

    async function openBoard(scope) {
      board.value = { scope, rows: [], me: store.points, my_rank: 0 };
      haptic(6);
      await nextTick();
      renderBoardPill();
      await loadBoard(scope);
    }

    async function switchScope(scope) {
      if (!board.value || board.value.scope === scope) return;
      board.value.scope = scope;
      haptic(6);
      await nextTick();
      renderBoardPill();
      await loadBoard(scope);
    }

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
      beginAnim();               // 过渡先落地（此刻轨道还停在原来那一格）
      xDrag = 0;
      tab.value = next;          // 再换格：内容和滑块一起滑过去
      haptic(6);
      nextTick(() => { renderX(); });
    }

    function pick(game) {
      codeInput.value = "";
      dialog.value = { game, step: "choose", size: 9 };
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
      const payload = { t: "game.create", game: game.key, code: code };
      if (game.key === "go") payload.size = dialog.value.size === 19 ? 19 : 9;
      wsSend(payload);
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
      if (["gomoku", "tictactoe", "go"].includes(room.game)) return "/games/board?room=" + room.id;
      if (room.game === "xiangqi") return "/games/xiangqi?room=" + room.id;
      if (room.game === "werewolf") return "/games/werewolf?room=" + room.id;
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
    onMounted(() => window.addEventListener("resize", onResize));
    onUnmounted(() => {
      window.removeEventListener("resize", onResize);
      stops.forEach((fn) => fn && fn());
    });

    return { tab, rooms, records, dialog, codeInput, haptic, onlineGames: ONLINE, singleGames: SINGLE,
             board, boardSegEl, boardPill, myId, myPoints, openBoard, switchScope, store,
             trackEl, segEl, pill, xAnim, mediaUrl,
             refresh, setTab, pick, back, closeDialog, doCreate, doJoin, joinRoom, spectate,
             nameOf, shortTime, winnersText, navigate };
  },
}));

