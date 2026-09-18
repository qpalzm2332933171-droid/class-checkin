import { defineView, registerRoute, ref, onMounted, onUnmounted, navigate, haptic } from "../ui.js";

const SIZE = 9;
const MINES = 10;

registerRoute("/games/mine", defineView("gameMine", {
  template: `
  <div class="page-plain">
    <header class="row gap3 head">
      <button class="btn btn-icon glass glass-thin" @click="navigate('/games')"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">扫雷</h1>
        <p class="sub">点开安全格子，长按插旗</p>
      </div>
      <div class="chip chip-red"><Icon n="flag" :size="15" />{{ MINES - flags }}</div>
      <div class="chip">{{ elapsed }}s</div>
    </header>

    <div class="seg mine-seg" data-no-swipe>
      <button class="seg-item" :class="{ on: mode === 'dig' }" @click="mode = 'dig'">挖开</button>
      <button class="seg-item" :class="{ on: mode === 'flag' }" @click="mode = 'flag'">
        <Icon n="flag" :size="15" /> 插旗
      </button>
    </div>

    <div class="mine-board glass glass-liquid" :class="{ dead: dead }">
      <button v-for="cell in cells" :key="cell.i" class="mine-cell" :class="cellClass(cell)"
              @click.prevent="tap(cell)" @contextmenu.prevent="toggleFlag(cell)"
              @touchstart="startPress(cell, $event)" @touchend="endPress" @touchcancel="endPress"
              @touchmove="endPress" @mousedown="startPress(cell, $event)" @mouseup="endPress">
        <span v-if="cell.open && cell.mine">💥</span>
        <span v-else-if="cell.open && cell.n > 0" :class="'n' + cell.n">{{ cell.n }}</span>
        <span v-else-if="cell.flag">🚩</span>
      </button>
    </div>

    <Transition name="mat">
      <div v-if="state === 'win' || state === 'lose'" class="result glass glass-thick">
        <h2 class="t2">{{ state === 'win' ? '全部排雷完成 🎉' : '踩到雷了' }}</h2>
        <p class="sub mt2">用时 {{ elapsed }} 秒</p>
        <button class="btn btn-primary mt4" @click="reset">再来一局</button>
      </div>
    </Transition>

    <div class="row gap3 mt5">
      <button class="btn grow" @click="reset">重新开始</button>
      <button class="btn grow" @click="hint" :disabled="state === 'win' || state === 'lose'">提示一格</button>
    </div>
    <p class="cap center mt4">
      {{ mode === 'flag' ? '插旗模式：点一下就插旗，再点取消' : '挖开模式：长按插旗 · 数字表示周围雷数' }}
    </p>
  </div>`,
  style: `
  .head { padding-top: calc(var(--safe-t) + var(--s4)); }
  .mine-board { position: relative; margin: var(--s5) auto 0; width: min(94vw, 430px); aspect-ratio: 1;
    display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; padding: 8px; border-radius: var(--r-xl);
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .mine-board.dead { filter: saturate(0.7); }
  .mine-cell { border: 0; border-radius: 9px; background: var(--hair); color: var(--ink);
    font-weight: 700; font-size: clamp(13px, 3.6vw, 17px); display: flex; align-items: center; justify-content: center;
    cursor: pointer; padding: 0; touch-action: manipulation;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    transition: transform var(--dur-fast) var(--ease-out), background-color var(--dur-med) linear; }
  .mine-cell:active { transform: scale(0.94); }
  .mine-cell.open { background: var(--mat-thin); box-shadow: inset 0 1px 0 var(--edge); cursor: default; }
  .mine-cell.flagcell { background: var(--orange-soft); }
  .mine-cell.minecell { background: var(--red-soft); }
  .mine-cell.n1 { color: #0a6cff; } .mine-cell.n2 { color: #17a34a; } .mine-cell.n3 { color: #e5484d; }
  .mine-cell.n4 { color: #7c5cff; } .mine-cell.n5 { color: #e8850c; } .mine-cell.n6 { color: #12a5a5; }
  .mine-cell.n7 { color: #d6437c; } .mine-cell.n8 { color: var(--ink-2); }
  .mine-seg { margin: var(--s4) auto 0; width: min(94vw, 430px); }
  .mine-seg .seg-item { display: flex; align-items: center; justify-content: center; gap: 6px; }
  .mine-cell span { pointer-events: none; -webkit-user-select: none; user-select: none; }
  .result { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--safe-b) + var(--s6));
    padding: var(--s5); border-radius: var(--r-xl); text-align: center; width: min(88vw, 380px); z-index: 20; }
  `,
  setup() {
    const cells = ref([]);
    const mode = ref("dig");
    const state = ref("ready");
    const flags = ref(0);
    const elapsed = ref(0);
    let timer = null;
    let pressTimer = null;
    let longPressAt = 0;
    let started = false;

    function idx(r, c) { return r * SIZE + c; }

    function reset() {
      cells.value = Array.from({ length: SIZE * SIZE }, (_, i) => ({
        i, r: Math.floor(i / SIZE), c: i % SIZE, mine: false, open: false, flag: false, n: 0,
      }));
      state.value = "ready";
      flags.value = 0;
      elapsed.value = 0;
      started = false;
      clearInterval(timer);
      timer = null;
    }

    function placeMines(safeIndex) {
      const safeZone = new Set();
      const sr = Math.floor(safeIndex / SIZE), sc = safeIndex % SIZE;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = sr + dr, c = sc + dc;
        if (r >= 0 && c >= 0 && r < SIZE && c < SIZE) safeZone.add(idx(r, c));
      }
      const pool = cells.value.filter((cell) => !safeZone.has(cell.i));
      for (let placed = 0; placed < MINES && pool.length; placed++) {
        const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        pick.mine = true;
      }
      for (const cell of cells.value) {
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const r = cell.r + dr, c = cell.c + dc;
          if (r < 0 || c < 0 || r >= SIZE || c >= SIZE || (!dr && !dc)) continue;
          if (cells.value[idx(r, c)].mine) count++;
        }
        cell.n = count;
      }
    }

    function startTimer() {
      started = true;
      state.value = "play";
      timer = setInterval(() => { elapsed.value++; }, 1000);
    }

    function openCell(cell) {
      if (cell.open || cell.flag) return;
      cell.open = true;
      if (cell.mine) {
        state.value = "lose";
        clearInterval(timer);
        cells.value.forEach((c) => { if (c.mine) c.open = true; });
        haptic([16, 60, 16]);
        return;
      }
      if (cell.n === 0) {
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const r = cell.r + dr, c = cell.c + dc;
          if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) continue;
          const next = cells.value[idx(r, c)];
          if (!next.open && !next.flag && !next.mine) openCell(next);
        }
      }
    }

    function checkWin() {
      const closed = cells.value.filter((cell) => !cell.open);
      if (closed.length === MINES) {
        state.value = "win";
        clearInterval(timer);
        haptic([10, 40, 10, 40, 20]);
      }
    }

    function reveal(cell) {
      if (state.value === "win" || state.value === "lose" || cell.flag) return;
      if (!started) { placeMines(cell.i); startTimer(); }
      openCell(cell);
      if (state.value === "play") checkWin();
    }


    function toggleFlag(cell) {
      if (cell.open || state.value === "win" || state.value === "lose") return;
      cell.flag = !cell.flag;
      flags.value += cell.flag ? 1 : -1;
      haptic(12);
      if (!started) { placeMines(cell.i); startTimer(); }
      if (started) checkWin();
    }

    function tap(cell) {
      if (longPressAt && Date.now() - longPressAt < 800) return;
      if (mode.value === "flag") toggleFlag(cell);
      else reveal(cell);
    }

    function startPress(cell, ev) {
      endPress();
      if (mode.value === "flag") return;
      if (cell.open) return;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressAt = Date.now();
        toggleFlag(cell);
      }, 320);
    }

    function endPress() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }

    function hint() {
      const closed = cells.value.filter((cell) => !cell.open && !cell.mine);
      if (!closed.length) return;
      reveal(closed[Math.floor(Math.random() * closed.length)]);
    }

    function cellClass(cell) {
      return {
        open: cell.open, flagcell: cell.flag, minecell: cell.open && cell.mine,
        ["n" + cell.n]: cell.open && !cell.mine,
      };
    }

    onMounted(reset);
    onUnmounted(() => { clearInterval(timer); clearTimeout(pressTimer); });
    return { cells, state, flags, elapsed, MINES, cellClass, reveal, toggleFlag, tap,
             startPress, endPress, reset, hint, navigate };
  },
}));
