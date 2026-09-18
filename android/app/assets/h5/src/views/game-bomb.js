import {
  defineView, registerRoute, ref, computed, watch, onMounted, onUnmounted, onWs, store, wsSend, toast, haptic,
} from "../ui.js";
import { useRoom } from "../room.js";

registerRoute("/games/bomb", defineView("gameBomb", {
  template: `
  <div class="page-plain">
    <header class="row gap3 head">
      <button class="btn btn-icon glass glass-thin" @click="leaveRoom(false)"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">数字炸弹</h1>
        <p class="sub">{{ statusText }}</p>
      </div>
      <button class="btn glass glass-thin code-btn" @click="copyCode">房间 {{ roomCode }}</button>
    </header>

    <div class="range glass glass-thick glass-liquid mt5">
      <span class="bound num">{{ lo }}</span>
      <div class="track">
        <div class="safe" :style="{ left: pct(lo) + '%', right: (100 - pct(hi)) + '%' }"></div>
        <b class="pick" :style="{ left: pct(guessValue || (lo + hi) / 2) + '%' }">{{ guessValue || '?' }}</b>
      </div>
      <span class="bound num">{{ hi }}</span>
    </div>
    <p class="cap center mt3">安全区间 {{ lo }} ~ {{ hi }}，炸弹藏在这之间</p>

    <div class="players mt5">
      <span v-for="p in players" :key="p.uid" class="chip" :class="chipOf(p)">
        {{ p.name }}{{ state.turn === p.uid ? ' · 该你了' : '' }}
      </span>
    </div>
    <p v-if="isSpectator" class="chip chip-orange mt4">观战模式</p>

    <div v-if="canStart" class="mt5">
      <button class="btn btn-primary btn-block btn-lg" @click="start">开始游戏</button>
      <p class="cap center mt3">至少 2 人开始，房主可提前开局</p>
    </div>

    <template v-else>
      <div class="glass glass-thin pad5 mt5 stack">
        <label class="label">报一个 {{ lo }} 到 {{ hi }} 之间的数字</label>
        <input class="field" type="number" inputmode="numeric" v-model="guessValue"
               :placeholder="'如 ' + Math.floor((lo + hi) / 2)" @keyup.enter="submit" :disabled="!isMyTurn" />
        <div class="row gap2 wrap">
          <button v-for="n in quick" :key="n" class="chip" @click="guessValue = n; submit()" :disabled="!isMyTurn">{{ n }}</button>
        </div>
        <button class="btn btn-primary btn-block" @click="submit" :disabled="!isMyTurn || !guessValue">报数</button>
      </div>
    </template>

    <h2 class="section-title">历史</h2>
    <div class="glass glass-thin list">
      <div v-for="(h, i) in history.slice().reverse()" :key="i" class="list-row">
        <span class="avatar avatar-sm">{{ h.name.slice(0,1) }}</span>
        <span class="grow elide">{{ h.name }}</span>
        <b class="num">{{ h.n }}</b>
        <span class="chip" :class="h.n < bomb ? 'chip-accent' : 'chip-orange'">{{ h.n < bomb ? '偏小' : '偏大' }}</span>
      </div>
      <div v-if="!history.length" class="list-row sub">还没有人报数</div>
    </div>

    <Transition name="mat">
      <div v-if="finished" class="overlay glass glass-thick">
        <h2 class="t2">{{ winners.includes(store.user?.id) ? '你活到了最后 🎉' : '炸了' }}</h2>
        <p class="sub mt2">炸弹是 {{ bomb }}</p>
        <div class="row gap3 mt5">
          <button class="btn grow" @click="leaveRoom(false)">离开房间</button>
          <button class="btn grow" :class="othersWantRematch ? 'btn-green' : 'btn-primary'" @click="rematch">再来一局</button>
        </div>
        <p v-if="notice" class="sub mt3" :class="{ 'green-text': othersWantRematch }">{{ notice }}</p>
      </div>
    </Transition>
  </div>`,
  style: `
  .head { padding-top: calc(var(--safe-t) + var(--s4)); }
  .code-btn { padding: 6px 12px; font-size: var(--fs-sub); font-weight: 600; letter-spacing: 0.08em; }
  .range { display: flex; align-items: center; gap: var(--s3); padding: var(--s5); border-radius: var(--r-lg); }
  .bound { font-size: 22px; font-weight: 700; min-width: 46px; text-align: center; }
  .track { position: relative; flex: 1; height: 10px; border-radius: 5px; background: var(--hair); }
  .safe { position: absolute; top: 0; bottom: 0; background: linear-gradient(90deg, var(--accent), var(--purple)); border-radius: 5px;
    transition: left var(--dur-slow) var(--ease-out), right var(--dur-slow) var(--ease-out); }
  .pick { position: absolute; top: -22px; transform: translateX(-50%); font-size: var(--fs-foot);
    transition: left var(--dur-slow) var(--ease-out); }
  .players { display: flex; flex-wrap: wrap; gap: 6px; }
  .overlay { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--safe-b) + var(--s6));
    padding: var(--s5); border-radius: var(--r-xl); text-align: center; width: min(90vw, 400px); z-index: 30; }
  .green-text { color: var(--green); font-weight: 600; }
  `,
  setup() {
    const roomApi = useRoom("/games/bomb");
    const state = ref({});
    const history = ref([]);
    const guessValue = ref("");
    const players = roomApi.players;
    const finished = roomApi.finished;
    const winners = roomApi.winners;

    const lo = computed(() => state.value.lo ?? 1);
    const hi = computed(() => state.value.hi ?? 100);
    const bomb = computed(() => state.value.bomb || 0);
    const alive = computed(() => state.value.alive || []);
    const isMyTurn = computed(() => state.value.turn === store.user?.id && !finished.value);
    const canStart = computed(() => !state.value.status || state.value.status === "finished" || !alive.value.length);
    const quick = computed(() => {
      const low = lo.value, high = hi.value;
      const span = Math.max(1, high - low);
      return [low + Math.round(span * 0.25), Math.round((low + high) / 2), high - Math.round(span * 0.25)];
    });
    const statusText = computed(() => {
      if (finished.value) return "本局结束";
      if (roomApi.aborted.value) return "本局已中止";
      if (!alive.value.length) return "等待开局";
      return isMyTurn.value ? "轮到你报数" : "等待其他同学报数";
    });

    function pct(value) { return Math.max(0, Math.min(100, ((value - 0) / 100) * 100)); }
    function chipOf(player) {
      if (finished.value) return winners.value.includes(player.uid) ? "chip-green" : "";
      if (!alive.value.includes(player.uid)) return "chip-red";
      if (state.value.turn === player.uid) return "chip-accent";
      return "";
    }

    function syncState() {
      const next = roomApi.room.value?.state || {};
      if (next !== state.value) {
        state.value = next;
        history.value = next.history || [];
        guessValue.value = "";
      }
    }
    const unwatch = watch(roomApi.room, syncState, { immediate: true });

    function submit() {
      const value = parseInt(guessValue.value, 10);
      if (!value || !isMyTurn.value) return;
      wsSend({ t: "game.guess", text: String(value) });
      haptic(10);
      guessValue.value = "";
    }
    function start() { wsSend({ t: "game.start" }); }

    let stopEvents = null;
    onMounted(() => {
      stopEvents = onWs("game.event", (msg) => {
        if (!msg.text) return;
        toast(msg.text, msg.text.includes("砰") ? "error" : "info", 2800);
        if (msg.text.includes("砰")) haptic([20, 60, 20]);
      });
    });
    onUnmounted(() => { if (unwatch) unwatch(); if (stopEvents) stopEvents(); });

    return { ...roomApi, state, history, guessValue, players, finished, winners, lo, hi, bomb, alive,
             isMyTurn, canStart, quick, statusText, pct, chipOf, submit, start, store };
  },
}));
