import {
  defineView, registerRoute, ref, computed, watch, nextTick, onMounted, onUnmounted, store, onWs, wsSend, toast, haptic,
  mediaUrl,
} from "../ui.js";
import { useRoom } from "../room.js";

const COLORS = ["#1c1c1e", "#ff3b30", "#ff9500", "#34c759", "#0a84ff", "#af52de"];
const SIZES = [3, 7, 14];
const ERASER_SIZES = [14, 26, 40];
/* 笔粗按钮里那个小圆点的直径（px）。它只是"粗细预览"，不必等于实际笔画宽度，
   所以和上面的尺寸分成两套数据。
   老代码用一个公式 szDot(s) = min(22, 3 + s*0.9) 现算，结果橡皮那三个算出
   [16, 22, 22] —— 后两个被上限 22 卡成一样大，看着像"两个按钮没区别"。
   改成显式列表后，三个档位各自可控。 */
const SIZES_DOTS = [6, 9, 16];
const ERASER_DOTS = [10, 16, 22];

registerRoute("/games/draw", defineView("gameDraw", {
  template: `
  <div class="page-plain">
    <header class="row gap3 gd-head">
      <button class="btn btn-icon glass glass-thin" @click="leaveRoom(false)"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">你画我猜</h1>
        <p class="sub">{{ statusText }}</p>
      </div>
      <button class="btn glass glass-thin code-btn" @click="copyCode">{{ roomCode }}</button>
    </header>

    <div class="glass glass-thick glass-liquid gd-wordbar mt4">
      <div class="grow">
        <p class="cap">{{ isDrawer ? "你来画" : (solvedByMe ? "已猜中，等待本轮结束" : "猜这个词") }}</p>
        <h2 class="gd-word">{{ isDrawer ? (state.word || "") : (state.masked || "…") }}</h2>
      </div>
      <div class="gd-timer" :class="{ urgent: left <= 15 }">
        <svg viewBox="0 0 44 44" class="gd-ring">
          <circle cx="22" cy="22" r="19" class="track" />
          <circle cx="22" cy="22" r="19" class="bar" :style="{ strokeDashoffset: 119.4 * (1 - ratio) }" />
        </svg>
        <b class="num">{{ left }}</b>
      </div>
    </div>

    <div v-if="revealed" class="gd-reveal glass glass-thin mt3">答案是「{{ revealed }}」</div>
    <p v-if="playing" class="cap mt2 gd-progress">
      每人画 {{ state.rounds_per_player || 2 }} 轮 · 还有 {{ state.draw_left || 0 }} 人没画满
    </p>

    <div class="gd-board glass glass-thin mt3">
      <canvas ref="cv" class="gd-cv" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up"></canvas>
      <div v-if="isDrawer && playing" class="gd-tools">
        <div class="gd-row">
          <button v-for="c in colors" :key="c" class="gd-sw"
                  :class="{ on: color === c && !eraser }"
                  :style="{ background: c }"
                  @click="pickColor(c)"></button>
          <span class="grow"></span>
          <button class="btn btn-icon glass glass-thin" title="撤销" @click="undo">
            <Icon n="back" :size="17" />
          </button>
        </div>

        <div class="gd-row">
          <button class="gd-tool" :class="{ on: eraser }" title="橡皮" aria-label="橡皮" @click="toggleEraser">
            <Icon n="eraser" :size="17" />
          </button>
          <span class="gd-div"></span>
          <button v-for="(s, i) in activeSizes" :key="s" class="gd-sz"
                  :class="{ on: activeSize === s }"
                  @click="pickSize(s)">
            <i :style="{ width: activeDots[i] + 'px', height: activeDots[i] + 'px' }"></i>
          </button>
            <span class="grow"></span>
            <button class="btn btn-icon glass glass-thin" title="清空" @click="clearAll">
                <Icon n="trash" :size="17" />
            </button>
        </div>
    </div>
      <p v-else-if="!playing" class="cap gd-empty">{{ canStart ? "至少 2 人才可以开始" : "等待画手作画…" }}</p>
    </div>

    <p v-if="canReady" class="cap center mt4">
      已准备 {{ ready.length }}/{{ players.length }} · {{ myReady ? '等其他人准备' : '点准备，大家准备好自动开始' }}
    </p>
    <button v-if="canReady" class="btn btn-block btn-lg mt3" :class="myReady ? '' : 'btn-primary'" @click="toggleReady">
      {{ myReady ? '取消准备' : '准备' }}
    </button>

    <section class="gd-chat glass glass-thin mt4">
      <header class="gd-chat-head">
        <b class="grow">聊天 / 猜词</b>
        <span class="cap">{{ isSpectator ? '观战中 · 发言会变弹幕' : '猜中会自动打码成 ***' }}</span>
      </header>
      <div class="gd-feed" ref="feedEl">
        <div v-for="(m, i) in feed" :key="i" class="gd-frow" :class="{ me: m.uid === me, ok: m.correct }">
          <b>{{ m.name }}</b><span class="elide">{{ m.text }}</span>
        </div>
        <p v-if="!feed.length" class="cap gd-feed-empty">还没有人说话，猜中的词会打码成 ***</p>
      </div>
      <form class="gd-composer" @submit.prevent="send">
        <input class="field" v-model="draft" :disabled="isDrawer || !playing" maxlength="40"
               :placeholder="isDrawer ? '你是画手，专心画啦' : (isSpectator ? '观战发言（会变成弹幕）' : '输入你猜的词')"
               enterkeyhint="send" />
        <button class="btn btn-primary btn-icon btn-lg" type="submit" :disabled="isDrawer || !playing || !draft.trim()">
          <Icon n="send" :size="19" />
        </button>
      </form>
    </section>

    <section class="gd-rank mt4">
      <button class="gd-rank-head glass glass-thin" @click="toggleRank">
        <Icon n="chart" :size="16" />
        <b class="grow">本场积分排名</b>
        <span class="cap">{{ ranked.length }} 人 · 我第 {{ myRank }} 名</span>
        <span class="gd-caret" :class="{ open: rankOpen }"><Icon n="back" :size="15" /></span>
      </button>
      <Transition name="mat">
        <div v-if="rankOpen" class="glass glass-thin list mt2">
          <div v-for="p in ranked" :key="p.uid" class="list-row">
            <span class="avatar avatar-sm" :style="p.color ? { background: p.color } : {}">
              <img v-if="p.avatar" :src="mediaUrl(p.avatar)" :alt="p.name" loading="lazy" />
              <template v-else>{{ p.name.slice(0, 1) }}</template>
            </span>
            <span class="grow elide">{{ p.name }}{{ p.uid === state.drawer ? " · 画手" : "" }}</span>
            <span v-if="!playing && isReady(p)" class="chip chip-green">已准备</span>
            <span v-if="state.guessed && state.guessed.includes(p.uid)" class="chip chip-green">已猜中</span>
            <b class="num">{{ p.score }}</b>
          </div>
        </div>
      </Transition>
    </section>

    <div v-if="notice" class="rematch-bar mt4" :class="{ want: othersWantRematch }">{{ notice }}</div>

    <Transition name="mat">
      <div v-if="finished || aborted" class="gd-overlay glass glass-thick">
        <h2 class="t2">{{ aborted ? "本局已中止" : (iWon ? "你赢了 🎉" : "本局结束") }}</h2>
        <p class="sub mt2">{{ aborted ? (reason || "有人离开了房间") : (winners.length ? winners.map((w) => w.name).join("、") + " 胜出" : "再来一局？") }}</p>
        <div class="row gap3 mt5">
          <button class="btn grow" @click="leaveRoom(false)">{{ isSpectator ? '退出观战' : '离开房间' }}</button>
          <button v-if="!isSpectator" class="btn grow" :class="othersWantRematch ? 'btn-green' : 'btn-primary'" @click="rematch">再来一局</button>
        </div>
        <p v-if="notice" class="sub mt3" :class="{ 'green-text': othersWantRematch }">{{ notice }}</p>
      </div>
    </Transition>
  </div>`,
  style: `
  .gd-head { padding-top: calc(var(--safe-t) + var(--s4)); }
  .code-btn { padding: 6px 12px; font-size: var(--fs-sub); font-weight: 600; letter-spacing: 0.08em; }
  .green-text { color: var(--green); font-weight: 600; }
  .gd-wordbar { display: flex; align-items: center; gap: var(--s4); padding: var(--s4) var(--s5); border-radius: var(--r-lg); }
  .gd-word { font-size: 26px; letter-spacing: 6px; font-weight: 700; margin-top: 2px; }
  .gd-timer { position: relative; width: 52px; height: 52px; display: grid; place-items: center; }
  .gd-ring { position: absolute; inset: 0; transform: rotate(-90deg); }
  .gd-ring .track { fill: none; stroke: var(--hair); stroke-width: 4; }
  .gd-ring .bar { fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round;
    stroke-dasharray: 119.4; transition: stroke-dashoffset 1s linear, stroke var(--dur-med) var(--ease-out); }
  .gd-timer b { font-size: var(--fs-foot); }
  .gd-timer.urgent .gd-ring .bar { stroke: var(--orange); }
  .gd-timer.urgent b { color: var(--orange); }
  .gd-progress { color: var(--ink-3); }
  .gd-reveal { padding: var(--s3) var(--s4); border-radius: var(--r-md); text-align: center; font-weight: 600; }
  .gd-board { position: relative; border-radius: var(--r-lg); overflow: hidden; }
  .gd-cv { display: block; width: 100%; aspect-ratio: 4 / 3; touch-action: none; background: #fff; }
  .gd-tools { display: flex; flex-direction: column; gap: 8px; padding: 10px var(--s4) calc(10px + var(--safe-b)); }
  .gd-row { display: flex; align-items: center; gap: 10px; }
  /* 下面三个都是 <button>，而项目没有全局重置 UA 的 padding / border / appearance。
     不重置的话按钮内部会被原生边框(1.7px outset)和内边距(1px 4px)挤小，
     .gd-sz 里那个"圆点偏离圆心"就是这么来的（实测内部只剩约 18.6×24.6）。
     这条必须放在 .gd-sw / .gd-tool / .gd-sz 各自的规则【之前】，否则会被盖掉。 */
  .gd-sw, .gd-tool, .gd-sz { appearance: none; -webkit-appearance: none; padding: 0; border: 0; }
  .gd-sw { width: 26px; height: 26px; flex: none; border-radius: 50%; border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
  .gd-sw.on { border-color: var(--ink); transform: scale(1.12); }
  .gd-sz { width: 30px; height: 30px; flex: none; display: grid; place-items: center; border-radius: 50%; }
  .gd-sz.on { background: color-mix(in srgb, var(--ink) 18%, transparent); }
  .gd-sz on i { background: var(--accent); }
  .gd-sz i { display: block; border-radius: 50%; background: var(--ink); }
  .gd-tool { height: 30px; min-width: 30px; flex: none; padding: 0 5px; display: grid; place-items: center;
    border-radius: 15px; color: var(--ink-2); }
  .gd-tool.on { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .gd-div { width: 1px; height: 20px; flex: none; background: var(--hair); }
  .gd-empty { padding: var(--s5); text-align: center; }
  .gd-chat { display: flex; flex-direction: column; padding: var(--s3) var(--s4) var(--s4); border-radius: var(--r-lg); }
  .gd-chat-head { display: flex; align-items: baseline; gap: var(--s2); padding-bottom: var(--s2); }
  .gd-chat-head b { font-size: var(--fs-callout); font-weight: 650; }
  .gd-feed { flex: 1; min-height: 168px; max-height: 40vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
    display: flex; flex-direction: column; gap: 2px; padding: var(--s2) 0; }
  .gd-feed-empty { padding: var(--s6) 0; text-align: center; }
  .gd-frow { display: flex; gap: 8px; padding: 7px 0; font-size: var(--fs-sub); }
  .gd-frow + .gd-frow { border-top: 1px solid var(--hair); }
  .gd-frow b { color: var(--ink-2); font-weight: 600; flex: none; }
  .gd-frow.me b { color: var(--accent); }
  .gd-frow.ok { color: var(--green); }
  .gd-composer { display: flex; gap: 10px; margin-top: var(--s2); padding-top: var(--s3); border-top: 1px solid var(--hair); }
  .gd-composer .field { flex: 1; }
  .gd-rank-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 13px var(--s4);
    border-radius: var(--r-lg); text-align: left; }
  .gd-rank-head b { font-size: var(--fs-callout); font-weight: 650; }
  .gd-caret { display: inline-grid; place-items: center; color: var(--ink-3);
    transition: transform var(--dur-med) var(--ease-out); transform: rotate(-90deg); }
  .gd-caret.open { transform: rotate(90deg); }
  .gd-rank .list { padding: 4px var(--s3); }
  .gd-overlay { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--safe-b) + var(--s6));
    padding: var(--s5); border-radius: var(--r-xl); text-align: center; width: min(90vw, 400px); z-index: 30; }
  `,
  setup() {
    const roomApi = useRoom("/games/draw");
    const cv = ref(null);
    const state = ref({});
    const feed = ref([]);
    const players = roomApi.players;
    const finished = roomApi.finished;
    const winners = roomApi.winners;
    const draft = ref("");
    const color = ref(COLORS[0]);
    const size = ref(SIZES[1]);
    const eraser = ref(false);
    const esize = ref(ERASER_SIZES[1]);
    const left = ref(75);
    let ctx = null;
    let drawing = false;
    let last = null;
    let strokes = [];
    let stops = [];
    let ticker = null;


    const activeSizes = computed(() => (eraser.value ? ERASER_SIZES : SIZES));
    const activeDots = computed(() => (eraser.value ? ERASER_DOTS : SIZES_DOTS));
    const activeSize = computed(() => (eraser.value ? esize.value : size.value));
    const me = computed(() => store.user?.id);
    const isDrawer = computed(() => state.value.drawer === me.value);
    const playing = computed(() => state.value.status === "playing");
    const revealed = computed(() => state.value.reveal || "");
    const guessed = computed(() => state.value.guessed || []);
    const solvedByMe = computed(() => guessed.value.includes(me.value));
    const canStart = computed(() => !playing.value && players.value.length >= 2);
    const isSpectator = roomApi.isSpectator;
    const roundSeconds = computed(() => Math.max(1, state.value.round_seconds || 75));
    const ratio = computed(() => Math.max(0, Math.min(1, left.value / roundSeconds.value)));
    const ranked = computed(() => {
      const scores = state.value.scores || {};
      return players.value.map((p) => ({ ...p, score: scores[String(p.uid)] || 0 }))
        .sort((a, b) => b.score - a.score);
    });
    const iWon = computed(() => winners.value.some((w) => w.uid === me.value));
    const rankOpen = ref(false);
    const feedEl = ref(null);
    const myRank = computed(() => {
      const hit = ranked.value.findIndex((p) => p.uid === me.value);
      return hit < 0 ? "-" : hit + 1;
    });
    function toggleRank() { rankOpen.value = !rankOpen.value; haptic(8); }
    function scrollFeed() {
      nextTick(() => { const el = feedEl.value; if (el) el.scrollTop = el.scrollHeight; });
    }
    const statusText = computed(() => {
      if (finished.value) return "本局结束";
      if (!playing.value) return "等待开局";
      if (isDrawer.value) return "你正在作画";
      if (solvedByMe.value) return "已猜中，等其他人";
      return "看画猜词";
    });

    function setupCanvas() {
      const el = cv.value;
      if (!el) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = el.clientWidth || 320;
      const h = el.clientHeight || 240;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx = el.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.clearRect(0, 0, w, h);
      strokes.forEach(paint);
    }

    function paint(seg) {
      if (!ctx || !seg) return;
      const el = cv.value;
      const w = el.clientWidth || 320;
      const h = el.clientHeight || 240;
      const prev = ctx.globalCompositeOperation;
      if (seg.e) ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = seg.c || "#1c1c1e";
      ctx.lineWidth = seg.w || 4;
      ctx.beginPath();
      ctx.moveTo(seg.x1 * w, seg.y1 * h);
      ctx.lineTo(seg.x2 * w, seg.y2 * h);
      ctx.stroke();
      ctx.globalCompositeOperation = prev;
    }

    function clearAll(silent) {
      strokes = [];
      if (ctx) ctx.clearRect(0, 0, cv.value.clientWidth || 320, cv.value.clientHeight || 240);
      if (!silent) { wsSend({ t: "game.clear" }); haptic(8); }
    }

    function undo() {
      if (!strokes.length) return;
      strokes.pop();
      wsSend({ t: "game.clear" });
      strokes.forEach((seg) => wsSend({ t: "game.draw", seg }));
      if (ctx) ctx.clearRect(0, 0, cv.value.clientWidth || 320, cv.value.clientHeight || 240);
      strokes.forEach(paint);
      haptic(8);
    }

    function point(ev) {
      const rect = cv.value.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
               y: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)) };
    }

    function down(ev) {
      if (!isDrawer.value || !playing.value) return;
      ev.preventDefault();
      try { cv.value.setPointerCapture(ev.pointerId); } catch (err) { /* 某些浏览器不支持，忽略 */ }
      drawing = true;
      last = point(ev);
    }

    function move(ev) {
      if (!drawing) return;
      ev.preventDefault();
      const p = point(ev);
      const seg = { x1: last.x, y1: last.y, x2: p.x, y2: p.y, c: color.value,
                    w: eraser.value ? esize.value : size.value, e: eraser.value ? 1 : 0 };
      last = p;
      strokes.push(seg);
      paint(seg);
      wsSend({ t: "game.draw", seg });
    }


    function up(ev) {
      if (!drawing) return;
      drawing = false;
      try { cv.value.releasePointerCapture(ev.pointerId); } catch (e) {}
    }

    function pickColor(c) { color.value = c; eraser.value = false; haptic(6); }
    function toggleEraser() { eraser.value = !eraser.value; haptic(8); }
    function pickSize(s) { if (eraser.value) esize.value = s; else size.value = s; haptic(6); }

    function start() { wsSend({ t: "game.start" }); haptic(12); }

    function send() {
      const text = draft.value.trim();
      if (!text || isDrawer.value) return;
      wsSend({ t: "game.guess", text });
      draft.value = "";
      haptic(10);
    }

    function applyRoom(room) {
      if (!room) return;
      const next = room.state || {};
      const first = !state.value.status;
      state.value = next;
      if (next.strokes && (first || next.strokes.length < strokes.length)) {
        strokes = next.strokes.slice();
        setupCanvas();
      }
      tick();
    }

    function tick() {
      const dl = state.value.deadline || 0;
      left.value = dl ? Math.max(0, Math.round(dl - Date.now() / 1000)) : roundSeconds.value;
    }

    const unwatch = watch(roomApi.room, (next) => { if (next) applyRoom(next); }, { immediate: true });

    let ro = null;
    onMounted(() => {
      requestAnimationFrame(setupCanvas);
      ticker = setInterval(tick, 1000);
      window.addEventListener("resize", setupCanvas);
      if (typeof ResizeObserver !== "undefined" && cv.value && cv.value.parentElement) {
        ro = new ResizeObserver(() => { if (!drawing) setupCanvas(); });
        ro.observe(cv.value.parentElement);
      }
      stops.push(onWs("game.stroke", (msg) => {
        if (msg.clear) { strokes = []; if (ctx) ctx.clearRect(0, 0, cv.value.clientWidth || 320, cv.value.clientHeight || 240); return; }
        if (msg.seg) { strokes.push(msg.seg); paint(msg.seg); }
      }));
      stops.push(onWs("game.chat", (msg) => {
        if (!msg.chat) return;
        feed.value.push(msg.chat);
        if (feed.value.length > 60) feed.value.shift();
        scrollFeed();
      }));
      stops.push(onWs("game.event", (msg) => { if (msg.text) toast(msg.text, "info", 2600); }));
    });

    onUnmounted(() => {
      stops.forEach((fn) => fn && fn());
      if (ticker) clearInterval(ticker);
      if (ro) { ro.disconnect(); ro = null; }
      window.removeEventListener("resize", setupCanvas);
    });

    return { ...roomApi, cv, state, players, feed, finished, winners, draft, color, size, left, isSpectator,
             colors: COLORS, sizes: SIZES, eraser, activeSizes, activeDots, activeSize, pickColor, toggleEraser, pickSize,
             isDrawer, playing, revealed, solvedByMe, canStart, ratio, roundSeconds,
             ranked, iWon, statusText, down, move, up, undo, clearAll, start, send, store, mediaUrl,
             rankOpen, toggleRank, myRank, feedEl, me };
  },
}));
