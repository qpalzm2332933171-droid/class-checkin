import {
  defineView, registerRoute, ref, computed, watch, onUnmounted, store, wsSend, toast, haptic, mediaUrl,
  confirmDialog,
} from "../ui.js";
import { useRoom } from "../room.js";

/* 中国象棋：9 列 × 10 行，红先行。
   规则全部由服务端判定（别马腿 / 塞象眼 / 炮隔子 / 将帅照面 / 将军），
   客户端只负责"点自己的子 -> 点目标格"，走不了会给出具体原因。 */
const RED = { 1: "帅", 2: "仕", 3: "相", 4: "马", 5: "车", 6: "炮", 7: "兵" };
const BLACK = { 1: "将", 2: "士", 3: "象", 4: "马", 5: "车", 6: "炮", 7: "卒" };

registerRoute("/games/xiangqi", defineView("gameXiangqi", {
  template: `
  <div class="page-plain">
    <header class="row gap3 head">
      <button class="btn btn-icon glass glass-thin" @click="leaveRoom(false)"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">{{ roomName }}</h1>
        <p class="sub">{{ statusText }}</p>
      </div>
      <button class="btn glass glass-thin code-btn" @click="copyCode">房间 {{ roomCode }}</button>
    </header>

    <div class="players row gap3 mt4">
      <div v-for="p in players" :key="p.uid" class="player glass glass-thin" :class="{ active: isTurn(p) }">
        <span class="avatar avatar-sm">
          <img v-if="p.avatar" :src="mediaUrl(p.avatar)" :alt="p.name" loading="lazy" />
          <template v-else>{{ (p.name || '?').slice(0, 1) }}</template>
        </span>
        <div class="grow" style="min-width:0">
          <b class="elide">{{ p.name }}</b>
          <p class="cap">{{ sideOf(p) }} · {{ p.uid === room?.host ? '房主' : '对手' }}</p>
        </div>
        <span v-if="isReady(p)" class="chip chip-green">已准备</span>
        <span v-if="isTurn(p)" class="chip chip-accent">走棋中</span>
      </div>
      <div v-if="players.length < 2" class="player glass glass-thin waiting">
        <p class="sub">等待对手加入…</p>
      </div>
    </div>

    <p v-if="isSpectator" class="chip chip-orange mt4">观战模式</p>
    <p v-if="inCheck && room?.started && !finished" class="chip chip-red mt4">将军！</p>

    <div class="xq-wrap">
      <div class="xq-board glass glass-liquid" :style="{ '--cols': cols, '--rows': rows }">
        <button v-for="(cell, index) in board" :key="index" class="xq-cell"
                :class="{ sel: selected === index, last: isLast(index), side: index % cols < 3 || index % cols > 5 }"
                @click="tap(index)">
          <span v-if="cell" class="xq-piece" :class="cell > 0 ? 'red' : 'black'">{{ glyph(cell) }}</span>
        </button>
        <span class="xq-river" aria-hidden="true">楚河　汉界</span>
      </div>
    </div>

    <p class="cap center mt3">{{ selected === null ? '点一下自己的棋子选中，再点目标格子' : '已选中，点目标格子落子（点别的子可以换）' }}</p>

    <p v-if="canReady && !myReady" class="cap center mt4">双方都点准备后自动开局</p>
    <p v-else-if="canReady && myReady && !room?.started" class="cap center mt4 green-text">已准备 · 等对手点准备</p>

    <div class="row gap3 mt5">
      <button v-if="canReady" class="btn grow" :class="myReady ? '' : 'btn-primary'" @click="toggleReady">
        {{ myReady ? '取消准备' : '准备' }}
      </button>
      <button v-else-if="isSpectator" class="btn grow" @click="leaveRoom(false)">退出观战</button>
      <template v-else-if="finished">
        <button class="btn grow" @click="leaveRoom(false)">离开房间</button>
        <button class="btn grow" :class="othersWantRematch ? 'btn-green' : 'btn-primary'" @click="rematch">
          {{ iWantRematch ? '已发送' : '再来一局' }}
        </button>
      </template>
      <template v-else>
        <button class="btn grow" @click="leaveRoom(false)">离开房间</button>
        <button class="btn btn-danger" :disabled="!room?.started || isSpectator" @click="resign">认输</button>
      </template>
      <button v-if="spectators.length" class="btn">{{ spectators.length }} 人围观</button>
    </div>

    <div v-if="notice" class="rematch-bar mt4" :class="{ want: othersWantRematch }">{{ notice }}</div>
    <Transition name="mat">
      <div v-if="finished || aborted" class="overlay glass glass-thick">
        <h2 class="t2">{{ aborted ? '本局已中止' : resultTitle }}</h2>
        <p class="sub mt2">{{ aborted ? (reason || '有人离开了房间') : resultReason }}</p>
        <div class="row gap3 mt5">
          <button class="btn grow" @click="leaveRoom(false)">{{ isSpectator ? '退出观战' : '离开房间' }}</button>
          <button v-if="!isSpectator" class="btn grow" :class="othersWantRematch ? 'btn-green' : 'btn-primary'" @click="rematch">
            {{ iWantRematch ? '等待对方…' : '再来一局' }}
          </button>
        </div>
        <p v-if="notice" class="sub mt3" :class="{ 'green-text': othersWantRematch }">{{ notice }}</p>
      </div>
    </Transition>
  </div>`,
  style: `
  .head { padding-top: calc(var(--safe-t) + var(--s4)); }
  .code-btn { padding: 6px 12px; font-size: var(--fs-sub); font-weight: 600; letter-spacing: 0.08em; }
  .player { padding: 9px 11px; border-radius: var(--r-md); display: flex; align-items: center; gap: 9px;
    transition: box-shadow var(--dur-med) var(--ease-out); }
  .player.active { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent); }
  .player.waiting { justify-content: center; color: var(--ink-3); }
  .xq-wrap { display: flex; justify-content: center; margin-top: var(--s5); }
  .xq-board { position: relative; display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    grid-template-rows: repeat(var(--rows), 1fr);
    width: min(94vw, 420px); aspect-ratio: 9 / 10; padding: 8px;
    border-radius: var(--r-lg); overflow: hidden;
    background-image: linear-gradient(rgba(160, 120, 70, 0.16) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(160, 120, 70, 0.16) 1px, transparent 1px);
    background-size: calc(100% / var(--cols)) calc(100% / var(--rows)); }
  .xq-cell { position: relative; display: flex; align-items: center; justify-content: center;
    background: none; border: 0; padding: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .xq-cell.last { background: color-mix(in srgb, var(--accent) 16%, transparent); border-radius: 6px; }
  .xq-cell.sel { background: color-mix(in srgb, var(--accent) 26%, transparent); border-radius: 6px; }
  .xq-piece { display: flex; align-items: center; justify-content: center;
    width: 88%; aspect-ratio: 1; border-radius: 50%;
    font-weight: 800; font-size: clamp(13px, 4.2vw, 20px); line-height: 1;
    background: linear-gradient(180deg, #fffaf1, #efe2ca); color: #8a2b16;
    border: 1.5px solid rgba(120, 80, 40, 0.5);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.7); }
  .xq-piece.black { color: #1c1c1e; background: linear-gradient(180deg, #fbfbfb, #dedee2); }
  .xq-river { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
    text-align: center; font-size: clamp(11px, 3.2vw, 15px); letter-spacing: 0.5em;
    color: color-mix(in srgb, var(--ink-3) 55%, transparent); pointer-events: none; }
  .chip-red { background: color-mix(in srgb, #ff3b30 22%, transparent); color: #ff453a; font-weight: 700; }
  .overlay { position: fixed; inset: auto 0 0 0; margin: auto; top: 0; height: fit-content;
    width: min(440px, calc(100vw - 32px)); padding: var(--s6); border-radius: var(--r-xl); z-index: 62; text-align: center; }
  `,
  setup() {
    const roomApi = useRoom("/games/xiangqi");
    const board = ref([]);

    /* 还没开局时先摆出标准阵型，别让人对着空棋盘等 */
    function openingLineup() {
      const out = new Array(90).fill(0);
      const back = [5, 4, 3, 2, 1, 2, 3, 4, 5];
      back.forEach(function (piece, col) { out[col] = -piece; out[9 * 9 + col] = piece; });
      out[2 * 9 + 1] = -6; out[2 * 9 + 7] = -6;
      out[7 * 9 + 1] = 6; out[7 * 9 + 7] = 6;
      [0, 2, 4, 6, 8].forEach(function (col) { out[3 * 9 + col] = -7; out[6 * 9 + col] = 7; });
      return out;
    }
    const cols = ref(9);
    const rows = ref(10);
    const selected = ref(null);

    const players = roomApi.players;
    const finished = roomApi.finished;
    const isSpectator = roomApi.isSpectator;
    const mySide = computed(() => (roomApi.room.value?.state?.marks || {})[String(store.user?.id)] || 0);
    const isMyTurn = computed(() => roomApi.room.value?.state?.turn === store.user?.id);
    const inCheck = computed(() => !!roomApi.room.value?.state?.check);
    const lastMove = computed(() => roomApi.room.value?.state?.last || null);

    const statusText = computed(() => {
      if (!roomApi.room.value) return "连接中…";
      if (finished.value) return "本局结束";
      if (roomApi.aborted.value) return "本局已中止";
      if (!roomApi.room.value.started) return players.value.length < 2 ? "等待对手加入" : "点准备，双方都准备后开局";
      if (isSpectator.value) return "观战中";
      return isMyTurn.value ? "轮到你走棋" : "等待对手走棋";
    });
    const resultTitle = computed(() => {
      if (isSpectator.value) return "本局结束";
      if (!roomApi.winners.value.length) return "本局结束";
      return roomApi.winners.value.includes(store.user?.id) ? "你赢了 🎉" : "惜败";
    });
    const resultReason = computed(() => roomApi.reason.value || "");

    function glyph(piece) {
      const table = piece > 0 ? RED : BLACK;
      return table[Math.abs(piece)] || "";
    }
    function sideOf(player) {
      const marks = roomApi.room.value?.state?.marks || {};
      return marks[String(player.uid)] === 1 ? "红方（先行）" : "黑方（后行）";
    }
    function isTurn(player) { return roomApi.room.value?.started && roomApi.room.value?.state?.turn === player.uid; }
    function isLast(index) {
      const last = lastMove.value;
      return !!last && (last.from === index || last.to === index);
    }

    function syncBoard() {
      const state = (roomApi.room.value && roomApi.room.value.state) || {};
      cols.value = state.cols || 9;
      rows.value = state.rows || 10;
      const total = cols.value * rows.value;
      if (state.board && state.board.length) board.value = state.board;
      else if (board.value.length !== total) board.value = openingLineup();
      else if (!board.value.some((v) => v)) board.value = openingLineup();
      if (finished.value) selected.value = null;
    }
    const unwatch = watch(roomApi.room, syncBoard, { immediate: true });

    function tap(index) {
      const state = (roomApi.room.value && roomApi.room.value.state) || {};
      if (!roomApi.room.value?.started || finished.value) return;
      if (isSpectator.value) { toast("观战模式不能走棋", "warn"); return; }
      if (!isMyTurn.value) { haptic(20); toast("还没轮到你", "info", 1400); return; }
      const cell = board.value[index] || 0;
      const mine = mySide.value === 1 ? cell > 0 : cell < 0;
      if (selected.value === null) {
        if (!cell) { haptic(14); return; }
        if (!mine) { toast("那是对手的棋子", "warn", 1500); return; }
        selected.value = index; haptic(8); return;
      }
      if (selected.value === index) { selected.value = null; return; }
      if (mine && cell) { selected.value = index; haptic(8); return; }
      wsSend({ t: "game.move", from: selected.value, to: index });
      selected.value = null;
      haptic(8);
    }

    function resign() {
      if (!roomApi.room.value?.started || finished.value) return;
      if (isSpectator.value) { toast("观战模式不能操作", "warn"); return; }
      confirmDialog("确定认输吗？本局会判对手胜。", { okText: "认输", danger: true })
        .then((yes) => { if (yes) wsSend({ t: "game.move", resign: true }); });
    }

    onUnmounted(() => { if (unwatch) unwatch(); });

    return { ...roomApi, board, cols, rows, selected, players, finished, isSpectator,
             statusText, resultTitle, resultReason, glyph, sideOf, isTurn, isLast, tap, resign, mediaUrl };
  },
}));
