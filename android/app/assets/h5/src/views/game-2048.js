import { defineView, registerRoute, ref, computed, onMounted, onUnmounted, navigate, toast, haptic, confirmDialog } from "../ui.js";

const SIZE = 4;
let idSeq = 1;

function emptyGrid() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(null)); }

registerRoute("/games/2048", defineView("game2048", {
  template: `
  <div class="page-plain game-shell">
    <header class="row gap3 head">
      <button class="btn btn-icon glass glass-thin" @click="navigate('/games')"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">2048</h1>
        <p class="sub">滑动合并相同数字</p>
      </div>
      <div class="score-box glass glass-thin">
        <span class="cap">分数</span><b class="num">{{ score }}</b>
      </div>
      <div class="score-box glass glass-thin">
        <span class="cap">最高</span><b class="num">{{ best }}</b>
      </div>
    </header>

    <div class="board-wrap" @pointerdown="onDown" @pointerup="onUp" @pointermove="onMove">
      <div class="board-2048 glass glass-liquid">
        <div class="cell-bg" v-for="i in 16" :key="'b'+i"></div>
        <div v-for="tile in tiles" :key="tile.id" class="tile" :class="'v' + Math.min(tile.v, 4096)"
             :style="tileStyle(tile)">
          <span>{{ tile.v }}</span>
        </div>
      </div>
      <Transition name="mat">
        <div v-if="over" class="over glass glass-thick">
          <h2 class="t2">{{ won ? '达成 2048！' : '没有可以移动的了' }}</h2>
          <p class="sub mt2">本局得分 {{ score }} · 最高 {{ best }}</p>
          <div class="row gap3 mt5">
            <button class="btn" @click="undo">撤销一步</button>
            <button class="btn btn-primary" @click="restart">再来一局</button>
          </div>
        </div>
      </Transition>
    </div>

    <div class="row gap3 mt5">
      <button class="btn grow" @click="undo" :disabled="!history.length">撤销</button>
      <button class="btn grow" @click="restart">重开</button>
    </div>
    <p class="cap center mt4">在棋盘上滑动，或用键盘方向键</p>
  </div>`,
  style: `
  .game-shell { display: flex; flex-direction: column; }
  .head { padding-top: calc(var(--safe-t) + var(--s4)); }
  .score-box { padding: 7px 12px; border-radius: var(--r-md); text-align: center; min-width: 64px; }
  .score-box b { display: block; font-size: 17px; }
  .board-wrap { position: relative; margin-top: var(--s5); touch-action: none; }
  .board-2048 { position: relative; width: min(92vw, 420px); aspect-ratio: 1; margin: 0 auto;
    padding: 10px; border-radius: var(--r-xl); }
  .cell-bg, .tile { position: absolute; width: calc((100% - 20px - 30px) / 4); height: calc((100% - 20px - 30px) / 4); }
  .cell-bg { background: var(--hair); border-radius: var(--r-md); }
  .tile { border-radius: var(--r-md); display: flex; align-items: center; justify-content: center;
    font-weight: 720; font-size: clamp(20px, 6.4vw, 30px); color: #22303f;
    background: #eee4da; box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
    transition: transform 105ms var(--ease-out); will-change: transform; }
  .tile.v2 { background: #eee4da; } .tile.v4 { background: #ece0c8; }
  .tile.v8 { background: #f2b179; color: #fff; } .tile.v16 { background: #f59563; color: #fff; }
  .tile.v32 { background: #f67c5f; color: #fff; } .tile.v64 { background: #f65e3b; color: #fff; }
  .tile.v128 { background: #edcf72; color: #fff; font-size: clamp(18px, 5.6vw, 26px); }
  .tile.v256 { background: #edcc61; color: #fff; font-size: clamp(18px, 5.6vw, 26px); }
  .tile.v512 { background: #edc850; color: #fff; font-size: clamp(18px, 5.6vw, 26px); }
  .tile.v1024 { background: #edc53f; color: #fff; font-size: clamp(16px, 5vw, 23px); }
  .tile.v2048 { background: linear-gradient(140deg, #edc22e, #f0b429); color: #fff; font-size: clamp(16px, 5vw, 23px); }
  .tile.v4096 { background: linear-gradient(140deg, #7c5cff, #0a6cff); color: #fff; font-size: clamp(16px, 5vw, 23px); }
  .tile.pop { animation: tpop 200ms var(--ease-out); }
  @keyframes tpop { from { transform: var(--pos) scale(0.86); opacity: 0.4; } to { transform: var(--pos) scale(1); } }
  .over { position: absolute; inset: 8% 6%; display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center; border-radius: var(--r-xl); z-index: 5; }
  @media (prefers-reduced-motion: reduce) { .tile { transition: none; } }
  `,
  setup() {
    const tiles = ref([]);
    const score = ref(0);
    const best = ref(Number(localStorage.getItem("best2048") || 0));
    const over = ref(false);
    const won = ref(false);
    const history = ref([]);
    let startX = 0, startY = 0, dragging = false;

    function tileStyle(tile) {
      const step = "calc(100% + 10px)";
      return {
        "--pos": `translate(calc(${tile.c} * ${step}), calc(${tile.r} * ${step}))`,
        transform: `translate(calc(${tile.c} * ${step}), calc(${tile.r} * ${step}))`,
      };
    }

    function gridOf() {
      const grid = emptyGrid();
      for (const tile of tiles.value) grid[tile.r][tile.c] = tile;
      return grid;
    }

    function snapshot(tilesBefore, scoreBefore) {
      history.value.push({ tiles: tilesBefore, score: scoreBefore });
      if (history.value.length > 30) history.value.shift();
    }

    function spawn() {
      const empties = [];
      const grid = gridOf();
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!grid[r][c]) empties.push([r, c]);
      if (!empties.length) return null;
      const [r, c] = empties[Math.floor(Math.random() * empties.length)];
      const tile = { id: idSeq++, r, c, v: Math.random() < 0.9 ? 2 : 4, pop: true };
      tiles.value.push(tile);
      return tile;
    }

    function restart(silent) {
      tiles.value = [];
      score.value = 0;
      over.value = false;
      won.value = false;
      history.value = [];
      spawn();
      spawn();
      if (!silent) haptic(10);
    }

    function canMove(grid) {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const tile = grid[r][c];
          if (!tile) return true;
          if (c + 1 < SIZE && grid[r][c + 1] && grid[r][c + 1].v === tile.v) return true;
          if (r + 1 < SIZE && grid[r + 1][c] && grid[r + 1][c].v === tile.v) return true;
        }
      }
      return false;
    }

    function move(dir) {
      if (over.value) return;
      const before = tiles.value.map((t) => ({ id: t.id, r: t.r, c: t.c, v: t.v }));
      const scoreBefore = score.value;
      const vertical = dir === "up" || dir === "down";
      const forward = dir === "up" || dir === "left";
      const at = (r, c) => (r < 0 || c < 0 ? null : tiles.value.find((t) => t.r === r && t.c === c) || null);
      const merges = [];
      let moved = false;

      for (let line = 0; line < SIZE; line++) {
        const seq = [];
        for (let step = 0; step < SIZE; step++) {
          const tile = vertical ? at(forward ? step : SIZE - 1 - step, line)
                                : at(line, forward ? step : SIZE - 1 - step);
          if (tile) seq.push(tile);
        }
        const slots = [];
        for (let i = 0; i < seq.length; i++) {
          if (i + 1 < seq.length && seq[i].v === seq[i + 1].v) {
            slots.push({ keep: seq[i], drop: seq[i + 1] });
            i++;
          } else {
            slots.push({ keep: seq[i], drop: null });
          }
        }
        slots.forEach((slot, index) => {
          const r = vertical ? (forward ? index : SIZE - 1 - index) : line;
          const c = vertical ? line : (forward ? index : SIZE - 1 - index);
          if (slot.keep.r !== r || slot.keep.c !== c) moved = true;
          slot.keep.r = r;
          slot.keep.c = c;
          if (slot.drop) {
            slot.drop.r = r;
            slot.drop.c = c;
            slot.drop.pop = false;
            merges.push(slot);
            moved = true;
          }
        });
      }
      if (!moved) return;
      snapshot(before, scoreBefore);
      setTimeout(() => {
        let gained = 0;
        for (const slot of merges) {
          slot.keep.v *= 2;
          slot.keep.pop = true;
          gained += slot.keep.v;
          if (slot.keep.v >= 2048) won.value = true;
        }
        if (merges.length) {
          const dropped = new Set(merges.map((slot) => slot.drop));
          tiles.value = tiles.value.filter((tile) => !dropped.has(tile));
          score.value += gained;
          if (score.value > best.value) {
            best.value = score.value;
            localStorage.setItem("best2048", String(best.value));
          }
          haptic(6);
        }
        if (tiles.value.some((tile) => tile.pop)) {
          setTimeout(() => tiles.value.forEach((tile) => { tile.pop = false; }), 220);
        }
        if (!canMove(gridOf())) { over.value = true; haptic([12, 60, 12]); return; }
        spawn();
        if (!canMove(gridOf())) { over.value = true; haptic([12, 60, 12]); }
      }, 96);
    }

    function undo() {
      const last = history.value.pop();
      if (!last) return;
      tiles.value = last.tiles.map((t) => ({ ...t, pop: false }));
      score.value = last.score;
      over.value = false;
      haptic(8);
    }

    function onDown(event) { dragging = true; startX = event.clientX; startY = event.clientY; }
    function onMove(event) {
      if (!dragging) return;
      const dx = event.clientX - startX, dy = event.clientY - startY;
      if (Math.abs(dx) < 26 && Math.abs(dy) < 26) return;
      dragging = false;
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "right" : "left");
      else move(dy > 0 ? "down" : "up");
    }
    function onUp(event) {
      if (!dragging) return;
      const dx = event.clientX - startX, dy = event.clientY - startY;
      dragging = false;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "right" : "left");
      else move(dy > 0 ? "down" : "up");
    }
    function onKey(event) {
      const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right" };
      const dir = map[event.key];
      if (dir) { event.preventDefault(); move(dir); }
    }

    onMounted(() => { restart(true); window.addEventListener("keydown", onKey); });
    onUnmounted(() => window.removeEventListener("keydown", onKey));

    return { tiles, score, best, over, won, history, tileStyle, restart, undo, onDown, onMove, onUp, navigate };
  },
}));
