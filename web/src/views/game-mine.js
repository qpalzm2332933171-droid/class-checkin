import {
  defineView, registerRoute, ref, computed, onMounted, onUnmounted, navigate, haptic, api, toast,
} from "../ui.js";

/* 四档难度：尺寸 / 雷数 / 通关积分（只有简单模式给"提示一格"） */
const DIFFICULTIES = [
  { key: "easy",   name: "简单", size: 9,  mines: 10, points: 0, hint: true,  desc: "9×9 · 10 颗雷 · 送一次提示" },
  { key: "normal", name: "正常", size: 12, mines: 24, points: 1, hint: false, desc: "12×12 · 24 颗雷" },
  { key: "hard",   name: "困难", size: 16, mines: 51, points: 2, hint: false, desc: "16×16 · 51 颗雷" },
  { key: "insane", name: "极难", size: 16, mines: 75, points: 3, hint: false, desc: "16×16 · 75 颗雷 · 心跳加速" },
];
const LAST_KEY = "mine_diff";

registerRoute("/games/mine", defineView("gameMine", {
  template: `
  <div class="page-plain">
    <header class="row gap3 head">
      <button class="btn btn-icon glass glass-thin" @click="navigate('/games')"><Icon n="back" :size="20" /></button>
      <div class="grow" style="min-width:0">
        <h1 class="t2">扫雷</h1>
        <p class="sub elide">{{ diff.name }} · {{ diff.desc }}</p>
      </div>
      <button class="chip chip-accent" @click="picker = true">{{ diff.name }}</button>
      <div class="chip chip-red"><Icon n="flag" :size="15" />{{ mineTotal - flags }}</div>
      <div class="chip">{{ elapsed }}s</div>
    </header>

    <div class="seg mine-seg" data-no-swipe>
      <button class="seg-item" :class="{ on: mode === 'dig' }" @click="mode = 'dig'">挖开</button>
      <button class="seg-item" :class="{ on: mode === 'flag' }" @click="mode = 'flag'">
        <Icon n="flag" :size="15" /> 插旗
      </button>
    </div>

    <div class="mine-board glass glass-liquid" :class="{ dead: state === 'lose' }" :style="boardStyle">
      <button v-for="cell in cells" :key="cell.i" class="mine-cell" :class="cellClass(cell)"
              @contextmenu.prevent="contextFlag(cell)"
              @pointerdown="pressStart(cell, $event)" @pointermove="pressMove($event)"
              @pointerup="pressEnd($event)" @pointercancel="pressCancel($event)">
        <span v-if="cell.open && cell.mine">💥</span>
        <span v-else-if="cell.open && cell.n > 0" :class="'n' + cell.n">{{ cell.n }}</span>
        <span v-else-if="cell.flag">🚩</span>
      </button>
    </div>

    <Transition name="mat">
      <div v-if="state === 'win' || state === 'lose'" class="result glass glass-thick">
        <h2 class="t2">{{ state === 'win' ? '全部排雷完成 🎉' : '踩到雷了' }}</h2>
        <p class="sub mt2">用时 {{ elapsed }} 秒<span v-if="state === 'win'"> · {{ diff.name }}<template v-if="diff.points"> · 积分 +{{ diff.points }}</template></span></p>
        <div class="row gap2 mt4">
          <button class="btn grow" @click="picker = true">换难度</button>
          <button class="btn btn-primary grow" @click="reset">再来一局</button>
        </div>
      </div>
    </Transition>

    <div class="row gap3 mt5">
      <button class="btn grow" @click="reset">重新开始</button>
      <button class="btn grow" @click="hint" :disabled="!hintEnabled">
        {{ diff.hint ? '提示一格' : '提示（仅简单）' }}
      </button>
    </div>
    <p class="cap center mt4">
      {{ mode === 'flag' ? '插旗模式：点一下就插旗，再点取消' : '挖开模式：长按插旗 · 数字表示周围雷数' }}
    </p>
  </div>

  <Transition name="fade">
    <div v-if="picker" class="scrim" @click="picker = false"></div>
  </Transition>
  <Transition name="mat">
    <div v-if="picker" class="modal pick-modal glass glass-thick">
      <h3 class="t3">选择难度</h3>
      <p class="sub mt2">难度越高通关积分越多，只有简单模式能提示一格。</p>
      <div class="stack mt4">
        <button v-for="d in difficulties" :key="d.key" class="glass glass-thin pad4 diff-card"
                :class="{ on: d.key === diff.key }" @click="choose(d)">
          <span class="grow" style="text-align:left">
            <b class="t3">{{ d.name }}</b>
            <p class="cap mt1">{{ d.desc }}</p>
          </span>
          <span class="chip" :class="d.points ? 'chip-accent' : ''">{{ d.points ? '+' + d.points + ' 分' : '不加分' }}</span>
        </button>
      </div>
    </div>
  </Transition>
  `,
  style: `
  .head { padding-top: calc(var(--safe-t) + var(--s4)); }
  .mine-board { position: relative; margin: var(--s5) auto 0; width: min(94vw, 430px); aspect-ratio: 1;
    display: grid; grid-template-columns: repeat(var(--n), 1fr); grid-template-rows: repeat(var(--n), 1fr);
    gap: var(--gap, 4px); padding: 8px; border-radius: var(--r-xl);
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .mine-board.dead { filter: saturate(0.7); }
  .mine-cell { border: 0; border-radius: var(--rad, 9px); background: var(--hair); color: var(--ink);
    font-weight: 700; font-size: var(--fs, 15px); display: flex; align-items: center; justify-content: center;
    cursor: pointer; padding: 0; overflow: hidden; line-height: 1; touch-action: manipulation;
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
  .pick-modal { z-index: 61; width: min(90vw, 380px); padding: var(--s5); border-radius: var(--r-xl); }
  .diff-card { display: flex; align-items: center; gap: 10px; border: 1px solid var(--hair); cursor: pointer;
    transition: transform var(--dur-fast) var(--ease-out), border-color var(--dur-fast) linear; }
  .diff-card:active { transform: scale(0.985); }
  .diff-card.on { border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
  `,
  setup() {
    const cells = ref([]);
    const mode = ref("dig");
    const state = ref("ready");
    const flags = ref(0);
    const elapsed = ref(0);
    const picker = ref(true);
    const difficulties = DIFFICULTIES;
    const remembered = DIFFICULTIES.find((d) => d.key === localStorage.getItem(LAST_KEY));
    const diff = ref(remembered || DIFFICULTIES[0]);
    const awardDone = ref(0);
    let timer = null;
    let pressTimer = null;
    let press = null;          // { cell, id, x, y, long }
    let started = false;

    const size = computed(() => diff.value.size);
    const mineTotal = computed(() => diff.value.mines);
    const hintEnabled = computed(() =>
      !!diff.value.hint && state.value !== "win" && state.value !== "lose");
    const boardStyle = computed(() => {
      const n = size.value;
      const span = "min(94vw, 430px)";
      return {
        "--n": n,
        "--gap": n >= 16 ? "3px" : "4px",
        "--rad": n >= 16 ? "5px" : "9px",
        "--fs": "calc(" + span + " / " + n + " * 0.5)",
      };
    });

    function idx(r, c) { return r * size.value + c; }

    function reset() {
      const n = size.value;
      cells.value = Array.from({ length: n * n }, (_, i) => ({
        i, r: Math.floor(i / n), c: i % n, mine: false, open: false, flag: false, n: 0,
      }));
      state.value = "ready";
      flags.value = 0;
      elapsed.value = 0;
      awardDone.value = 0;
      started = false;
      clearInterval(timer);
      timer = null;
    }

    function choose(d) {
      diff.value = d;
      try { localStorage.setItem(LAST_KEY, d.key); } catch (err) { /* ignore */ }
      picker.value = false;
      reset();
      haptic(8);
    }

    function placeMines(safeIndex) {
      const n = size.value;
      const safeZone = new Set();
      const sr = Math.floor(safeIndex / n), sc = safeIndex % n;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = sr + dr, c = sc + dc;
        if (r >= 0 && c >= 0 && r < n && c < n) safeZone.add(idx(r, c));
      }
      const pool = cells.value.filter((cell) => !safeZone.has(cell.i));
      for (let placed = 0; placed < mineTotal.value && pool.length; placed++) {
        const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        pick.mine = true;
      }
      for (const cell of cells.value) {
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const r = cell.r + dr, c = cell.c + dc;
          if (r < 0 || c < 0 || r >= n || c >= n || (!dr && !dc)) continue;
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
        const n = size.value;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const r = cell.r + dr, c = cell.c + dc;
          if (r < 0 || c < 0 || r >= n || c >= n) continue;
          const next = cells.value[idx(r, c)];
          if (!next.open && !next.flag && !next.mine) openCell(next);
        }
      }
    }

    /* 通关发积分：简单 0 / 正常 1 / 困难 2 / 极难 3，由服务端按难度下发 */
    async function award() {
      const points = diff.value.points;
      if (!points || awardDone.value) return;
      awardDone.value = points;
      try {
        const res = await api("/api/games/solo/points", {
          method: "POST", body: { kind: "mine", difficulty: diff.value.key } });
        if (res.awarded) toast("扫雷 " + diff.value.name + " 通关，积分 +" + res.awarded, "ok", 3600);
      } catch (err) { toast(err.message, "warn"); }
    }

    function checkWin() {
      const closed = cells.value.filter((cell) => !cell.open);
      if (closed.length === mineTotal.value) {
        state.value = "win";
        clearInterval(timer);
        haptic([10, 40, 10, 40, 20]);
        award();
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

    function pressStart(cell, ev) {
      if (state.value === "win" || state.value === "lose") return;
      if (ev.pointerType === "mouse" && ev.button !== 0) return;   // 右键交给 contextmenu
      pressClear();
      press = { cell, id: ev.pointerId, x: ev.clientX, y: ev.clientY, long: false };
      if (mode.value === "flag" || cell.open) return;              // 这两种情况抬手时处理
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (!press || press.id !== ev.pointerId) return;
        press.long = true;             // 长按命中：抬手时不再挖开
        toggleFlag(cell);
      }, 380);
    }

    function pressMove(ev) {
      if (!press || press.id !== ev.pointerId) return;
      if (Math.abs(ev.clientX - press.x) + Math.abs(ev.clientY - press.y) > 14) pressClear(ev);
    }

    function pressClear(ev) {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (press && (!ev || press.id === ev.pointerId)) press = null;
    }

    /** 右键盘/桌面长按的右键菜单：触摸长按由 pressStart 计时器负责，这里不重复触发 */
    function contextFlag(cell) {
      if (press) return;
      toggleFlag(cell);
    }

    function pressEnd(ev) {
      if (!press || press.id !== ev.pointerId) return;
      const cell = press.cell;
      const long = press.long;
      press = null;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (long) return;
      if (mode.value === "flag") toggleFlag(cell);
      else reveal(cell);
    }

    function hint() {
      if (!hintEnabled.value) { toast("只有简单模式能提示一格", "warn"); return; }
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
    onUnmounted(() => { clearInterval(timer); pressClear(); });
    return { cells, mode, state, flags, elapsed, diff, difficulties, picker, size, mineTotal, hintEnabled,
             boardStyle, cellClass, reveal, toggleFlag, contextFlag,
             pressStart, pressMove, pressEnd, pressCancel: pressClear, reset, hint, choose, navigate };
  },
}));
