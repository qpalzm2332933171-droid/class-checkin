import {
  defineView, registerRoute, ref, computed, watch, onUnmounted, store, wsSend, toast, haptic, mediaUrl,
} from "../ui.js";
import { useRoom } from "../room.js";

registerRoute("/games/board", defineView("gameBoard", {
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

    <div class="players row gap3 mt5">
      <div v-for="(p, i) in players" :key="p.uid" class="player glass glass-thin" :class="{ active: isTurn(p) }">
        <span class="avatar avatar-sm" :style="p.color ? { background: p.color } : {}">
          <img v-if="p.avatar" :src="mediaUrl(p.avatar)" :alt="p.name" loading="lazy" />
          <template v-else>{{ (p.name || '?').slice(0, 1) }}</template>
        </span>
        <span class="stone" :class="markOf(p) === 1 ? 'black' : 'white'"></span>
        <div class="grow" style="min-width:0">
          <b class="elide">{{ p.name }}</b>
          <p class="cap">{{ i === 0 ? '先手' : '后手' }}{{ p.uid === room?.host ? ' · 房主' : '' }}</p>
        </div>
        <span v-if="isReady(p)" class="chip chip-green">已准备</span>
        <span v-if="isTurn(p)" class="chip chip-accent">落子中</span>
      </div>
      <div v-if="players.length < 2" class="player glass glass-thin waiting">
        <span class="stone ghost"></span>
        <p class="sub">等待对手加入…</p>
      </div>
    </div>

    <p v-if="isSpectator" class="chip chip-orange mt4">观战模式</p>

    <div class="board-wrap">
      <div class="board glass glass-liquid" :style="{ '--n': size }">
        <button v-for="(cell, index) in board" :key="index" class="cell" :class="{ last: last?.index === index }"
                @click="play(index)">
          <span v-if="cell" class="stone" :class="cell === 1 ? 'black' : 'white'"></span>
        </button>
      </div>
    </div>

    <p v-if="canReady && !myReady" class="cap center mt4">对手已准备 {{ ready.length }}/{{ players.length }} · 双方都准备后自动开局</p>
    <p v-else-if="canReady && myReady && !room?.started" class="cap center mt4 green-text">
      已准备 {{ ready.length }}/{{ players.length }} · 等对手点准备
    </p>

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
      <button v-else class="btn grow" @click="leaveRoom(false)">离开房间</button>
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
  .player { padding: 10px 12px; border-radius: var(--r-md); display: flex; align-items: center; gap: 10px;
    transition: box-shadow var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out); }
  .player.active { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent); transform: translateY(-1px); }
  .player.waiting { justify-content: center; color: var(--ink-3); }
  .stone { width: 20px; height: 20px; border-radius: 50%; flex: none; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3); }
  .stone.black { background: radial-gradient(circle at 34% 30%, #5b6470, #10141a 70%); }
  .stone.white { background: radial-gradient(circle at 34% 30%, #ffffff, #d5dae3 72%); box-shadow: inset 0 -1px 2px rgba(0,0,0,0.18); }
  .stone.ghost { background: var(--hair); box-shadow: none; }
  .board-wrap { display: flex; justify-content: center; margin-top: var(--s5); }
  .board { display: grid; grid-template-columns: repeat(var(--n), 1fr); gap: 1px; width: min(94vw, 460px);
    aspect-ratio: 1; padding: 8px; border-radius: var(--r-lg); background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .cell { border: 0; background: var(--hair); border-radius: 3px; display: flex; align-items: center; justify-content: center;
    padding: 0; cursor: pointer; transition: background-color var(--dur-fast) linear; }
  .cell .stone { width: 86%; height: 86%; }
  .cell.last { box-shadow: inset 0 0 0 2px var(--accent); }
  .overlay { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--safe-b) + var(--s6));
    padding: var(--s5); border-radius: var(--r-xl); text-align: center; width: min(90vw, 400px); z-index: 30; }
  .green-text { color: var(--green); font-weight: 600; }
  `,
  setup() {
    const roomApi = useRoom("/games/board");
    const board = ref([]);
    const size = ref(15);
    const last = ref(null);

    const players = roomApi.players;
    const spectators = roomApi.spectators;
    const finished = roomApi.finished;
    const isSpectator = roomApi.isSpectator;
    const myMark = computed(() => {
      const marks = roomApi.room.value?.state?.marks || {};
      return marks[String(store.user?.id)] || 0;
    });
    const isMyTurn = computed(() => roomApi.room.value?.state?.turn === store.user?.id);
    const canStart = computed(() => !roomApi.room.value?.started && players.value.length === 2 && !finished.value);
    const statusText = computed(() => {
      if (!roomApi.room.value) return "连接中…";
      if (finished.value) return "本局结束";
      if (roomApi.aborted.value) return "本局已中止";
      if (!roomApi.room.value.started) return players.value.length < 2 ? "等待对手加入" : "点准备，双方都准备后开局";
      return isMyTurn.value ? "轮到你落子" : "等待对手落子";
    });
    const resultTitle = computed(() => {
      if (isSpectator.value) return "本局结束";
      if (!roomApi.winners.value.length) return "平局";
      return roomApi.winners.value.includes(store.user?.id) ? "你赢了 🎉" : "惜败";
    });
    const resultReason = computed(() => roomApi.reason.value || "");

    function markOf(player) {
      const marks = roomApi.room.value?.state?.marks || {};
      return marks[String(player.uid)] || 0;
    }
    function isTurn(player) { return roomApi.room.value?.started && roomApi.room.value?.state?.turn === player.uid; }

    function syncBoard() {
      const room = roomApi.room.value;
      const state = (room && room.state) || {};
      const expected = (room && room.game) === "tictactoe" ? 3 : 15;
      size.value = state.size || expected;
      const total = size.value * size.value;
      if (state.board && state.board.length) board.value = state.board;
      else if (board.value.length !== total) board.value = new Array(total).fill(0);
      last.value = state.last || null;
    }
    const unwatch = watch(roomApi.room, syncBoard, { immediate: true });

    function play(index) {
      if (!roomApi.room.value?.started || finished.value) return;
      if (roomApi.isSpectator.value) { toast("观战模式不能落子", "warn"); return; }
      if (!isMyTurn.value) { haptic(20); return; }
      if (board.value[index]) return;
      wsSend({ t: "game.move", index });
      haptic(8);
    }

    function start() { wsSend({ t: "game.start" }); }

    onUnmounted(() => { if (unwatch) unwatch(); });

    return { ...roomApi, board, size, last, players, spectators, finished, myMark, isMyTurn, canStart, isSpectator: roomApi.isSpectator,
             statusText, resultTitle, resultReason, markOf, isTurn, play, start, mediaUrl };
  },
}));
