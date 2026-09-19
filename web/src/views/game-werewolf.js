import {
  defineView, registerRoute, ref, computed, watch, onMounted, onUnmounted, store, wsSend, toast, haptic, mediaUrl,
  onWs,
} from "../ui.js";
import { useRoom } from "../room.js";

/* 狼人杀：完全照服务端的状态机走。
   服务端只会把"你该看到的东西"发给你 —— 身份、狼队友、验人结果、女巫信息都是私密的。 */
const ROLE_ICON = { wolf: "wolf", villager: "user", seer: "eye", witch: "sparkles", hunter: "bolt", idiot: "crown2" };
const STEP_TEXT = {
  wolf: "狼人行动中", seer: "预言家验人中", witch: "女巫用药中",
  hunter: "猎人开枪中", speak: "白天讨论中", vote: "放逐投票中",
};

registerRoute("/games/werewolf", defineView("gameWerewolf", {
  template: `
  <div class="page-plain">
    <header class="row gap3 head">
      <button class="btn btn-icon glass glass-thin" @click="leaveRoom(false)"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">狼人杀</h1>
        <p class="sub">{{ state.board ? (state.board.players + ' 人局 · ' + state.board.wolf + '狼 ' + state.board.villager + '民 ' + state.board.gods_text) : '等待开局' }}</p>
      </div>
      <button class="btn glass glass-thin code-btn" @click="copyCode">房间 {{ roomCode }}</button>
    </header>

    <Transition name="mat">
      <div v-if="banner" class="banner glass glass-thick" :class="banner.kind">
        <b>{{ banner.text }}</b>
      </div>
    </Transition>

    <div class="phase glass glass-liquid mt4" :class="isNight ? 'night' : 'day'">
      <span class="phase-ico"><Icon :n="isNight ? 'moon' : 'sun'" :size="22" /></span>
      <div class="grow">
        <b class="t3">{{ phaseTitle }}</b>
        <p class="cap">{{ stepText }}</p>
      </div>
      <span v-if="remaining > 0 && !finished" class="timer num">{{ remaining }}s</span>
    </div>

    <div v-if="!room?.started && !finished" class="wait-card glass glass-thin mt4">
      <b class="t3">还差 {{ waitingShort }} 人开局</b>
      <p class="cap mt2">已入座 {{ players.length }} / {{ room?.max || 12 }} 人 · 最少 {{ room?.min || 6 }} 人，全部人点准备后自动开局</p>
      <div class="row gap2 wrap mt3">
        <span v-for="p in players" :key="p.uid" class="chip">
          {{ p.name }}{{ p.uid === room?.host ? '（房主）' : '' }}
        </span>
      </div>
    </div>

    <div v-if="myRole" class="role-card glass glass-thin mt4" :class="myRole">
      <div class="row gap3">
        <span class="role-ico"><Icon :n="iconOf(myRole)" :size="22" /></span>
        <div class="grow">
          <b class="t3">你是【{{ state.my_role_name || '旁观' }}】</b>
          <p class="cap">{{ mySeat }} 号位 · {{ state.my_alive === false ? '已出局' : '存活' }}{{ state.can_vote_now === false ? ' · 已失去投票权' : '' }}</p>
        </div>
      </div>
      <div v-if="state.wolf_mates && state.wolf_mates.length" class="mates mt3">
        <p class="cap">狼队友：</p>
        <div class="row gap2 wrap mt2">
          <span v-for="m in state.wolf_mates" :key="m.uid" class="chip" :class="m.alive ? 'chip-accent' : ''">
            {{ seatOf(m.uid) }}号 {{ m.name }}{{ m.alive ? '' : '（已出局）' }}
          </span>
        </div>
      </div>
      <div v-if="state.checks && state.checks.length" class="mates mt3">
        <p class="cap">验人记录：</p>
        <div class="stack mt2">
          <p v-for="c in state.checks" :key="c.day + '-' + c.uid" class="cap">
            第 {{ c.day }} 夜：{{ seatOf(c.uid) }}号 {{ c.name }} 是
            <b :class="c.wolf ? 'red-text' : 'green-text'">{{ c.wolf ? '狼人' : '好人' }}</b>
          </p>
        </div>
      </div>
      <div v-if="state.witch" class="mates mt3">
        <p class="cap">
          解药：<b :class="state.witch.heal ? 'green-text' : 'dim'">{{ state.witch.heal ? '还在' : '已用' }}</b>
          · 毒药：<b :class="state.witch.poison ? 'green-text' : 'dim'">{{ state.witch.poison ? '还在' : '已用' }}</b>
          {{ state.witch.self_save ? ' · 首夜可自救' : ' · 今晚不能自救' }}
        </p>
        <p v-if="state.step === 'witch' && state.witch.seen" class="cap mt2">
          今晚倒牌的是 <b>{{ seatOf(state.witch.seen) }}号 {{ nameOf(state.witch.seen) }}</b>
        </p>
        <p v-else-if="state.step === 'witch'" class="cap mt2">今晚是平安夜</p>
      </div>
    </div>

    <h2 class="section-title mt5">座位</h2>
    <div class="seats">
      <button v-for="uid in seatOrder" :key="uid" class="seat glass glass-thin"
              :class="{ dead: !state.alive?.[uid], me: uid === myId, picked: picked === uid, can: canPick(uid) }"
              @click="pick(uid)">
        <span class="seat-no num">{{ seatOf(uid) }}</span>
        <span class="avatar avatar-sm">
          <img v-if="avatarOf(uid)" :src="mediaUrl(avatarOf(uid))" :alt="nameOf(uid)" loading="lazy" />
          <template v-else>{{ (nameOf(uid) || '?').slice(0, 1) }}</template>
        </span>
        <b class="elide">{{ nameOf(uid) }}</b>
        <span class="seat-tags">
          <span v-if="!state.alive?.[uid]" class="mini">出局</span>
          <span v-else-if="state.revealed?.[uid]" class="mini gold">白痴</span>
          <span v-else-if="state.can_vote?.[uid] === false" class="mini">无票</span>
          <span v-else-if="hasVoted(uid)" class="mini blue">已投</span>
        </span>
      </button>
    </div>

    <div v-if="voteResult" class="glass glass-thin pad4 mt4">
      <b class="t3">投票结果</b>
      <p v-if="voteResult.tie" class="cap mt2">平票，本轮无人出局</p>
      <p v-else-if="!voteResult.out" class="cap mt2">全员弃票</p>
      <p v-else class="cap mt2">{{ seatOf(voteResult.out) }}号 {{ nameOf(voteResult.out) }} 被放逐</p>
      <div class="stack mt2">
        <p v-for="row in voteResult.tally || []" :key="row.uid" class="cap">{{ row.name }} · {{ row.count }} 票</p>
      </div>
    </div>

    <div v-if="myAction" class="action glass glass-liquid mt4">
      <b class="t3">{{ actionTitle }}</b>
      <p class="cap mt2">{{ actionHint }}</p>
      <div class="row gap3 mt3 wrap">
        <template v-if="state.step === 'witch'">
          <button class="btn" :disabled="!state.witch?.heal || !state.witch?.seen || (state.witch?.seen === myId && !state.witch?.self_save)" @click="witch('heal')">用解药</button>
          <button class="btn" :disabled="!state.witch?.poison || !picked" @click="witch('poison')">毒 {{ picked ? seatOf(picked) + '号' : '（先选人）' }}</button>
          <button class="btn grow" @click="witch('skip')">不用药</button>
        </template>
        <template v-else>
          <button class="btn grow btn-primary" :disabled="!picked && !allowEmpty" @click="confirm">{{ confirmText }}</button>
        </template>
      </div>
    </div>

    <p v-if="isSpectator" class="chip chip-orange mt4">观战模式（看不到任何人的身份）</p>
    <p v-else-if="!state.my_alive && room?.started && !finished" class="chip mt4">你已经出局，可以继续看别人玩</p>

    <h2 class="section-title mt5">发言</h2>
    <div class="chat-box glass glass-thin pad4">
      <div class="chat-list">
        <p v-for="(line, i) in chats" :key="i" class="cap"><b>{{ line.name }}：</b>{{ line.text }}</p>
        <p v-if="!chats.length" class="cap dim">白天讨论阶段在这里发言</p>
      </div>
      <div class="row gap2 mt3">
        <input class="field grow" v-model="draft" placeholder="说点什么…" @keyup.enter="sendChat" />
        <button class="btn btn-primary" @click="sendChat">发送</button>
      </div>
    </div>

    <h2 class="section-title mt5">进程</h2>
    <div class="glass glass-thin pad4 log">
      <p v-for="(line, i) in (state.log || [])" :key="i" class="cap log-line" :class="line.kind">
        <span class="dim">D{{ line.day }}</span> {{ line.text }}
      </p>
      <p v-if="!(state.log || []).length" class="cap dim">还没有事件</p>
    </div>

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

    <p v-if="canReady" class="cap center mt3">
      {{ players.length }} / {{ room?.min || 6 }} 人 · {{ players.length >= (room?.min || 6) ? '人齐了，全部点准备就开局' : '至少要 ' + (room?.min || 6) + ' 人' }}
    </p>
    <p v-if="!room?.started && room?.board" class="cap center mt2 dim">
      当前人数对应板子：{{ room.board.wolf }} 狼 / {{ room.board.villager }} 民 / {{ room.board.gods_text }}
    </p>

    <div v-if="notice" class="rematch-bar mt4" :class="{ want: othersWantRematch }">{{ notice }}</div>
    <Transition name="mat">
      <div v-if="finished || aborted" class="overlay glass glass-thick">
        <h2 class="t2">{{ aborted ? '本局已中止' : (myAliveWin ? '你赢了 🎉' : (myTeamOfWinner ? '你的阵营赢了 🎉' : '惜败')) }}</h2>
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
  .phase { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: var(--r-lg); }
  .phase.night { background: linear-gradient(135deg, rgba(58,58,96,0.55), rgba(24,24,38,0.55)); }
  .phase.day { background: linear-gradient(135deg, rgba(255,196,84,0.30), rgba(255,145,64,0.22)); }
  .phase-ico { display: flex; width: 34px; height: 34px; border-radius: 50%; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.14); }
  .timer { font-weight: 800; font-size: var(--fs-callout); font-variant-numeric: tabular-nums; }
  .role-card { padding: 12px 14px; border-radius: var(--r-lg); border-left: 3px solid var(--accent); }
  .role-card.wolf { border-left-color: #ff453a; }
  .role-card.seer { border-left-color: #0a84ff; }
  .role-card.witch { border-left-color: #af52de; }
  .role-card.hunter { border-left-color: #ff9f0a; }
  .role-card.idiot { border-left-color: #ffd60a; }
  .role-ico { display: flex; width: 38px; height: 38px; border-radius: 50%; align-items: center; justify-content: center;
    background: var(--accent-soft); }
  .mates { border-top: 1px solid var(--hair); padding-top: 8px; }
  .seats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .seat { position: relative; display: flex; flex-direction: column; align-items: center; gap: 5px;
    padding: 10px 6px; border-radius: var(--r-md); cursor: pointer; transition: transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out), opacity var(--dur-fast) linear; }
  .seat.dead { opacity: 0.45; filter: grayscale(0.7); }
  .seat.me { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent); }
  .seat.picked { box-shadow: 0 0 0 2px #ff453a; transform: translateY(-2px); }
  .seat.can:active { transform: scale(0.96); }
  .seat-no { position: absolute; top: 5px; left: 7px; font-size: 11px; color: var(--ink-3); font-weight: 700; }
  .seat-tags { min-height: 13px; }
  .mini { font-size: 10px; padding: 1px 5px; border-radius: 999px; background: var(--hair); color: var(--ink-3); }
  .mini.gold { background: rgba(255,214,10,0.25); color: #b58900; }
  .mini.blue { background: var(--accent-soft); color: var(--accent); }
  .action { padding: 14px; border-radius: var(--r-lg); }
  .chat-box { border-radius: var(--r-lg); }
  .chat-list { max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .log { border-radius: var(--r-lg); max-height: 190px; overflow-y: auto; }
  .log-line { display: block; padding: 2px 0; }
  .log-line.bad { color: #ff453a; }
  .log-line.good { color: #34c759; }
  .red-text { color: #ff453a; } .green-text { color: #34c759; } .dim { color: var(--ink-3); }
  /* 阶段播报：天黑请闭眼 / 狼人请睁眼 这类提示要看得见 */
  .banner { position: fixed; left: 50%; transform: translateX(-50%); top: calc(var(--safe-t) + 64px);
    z-index: 58; padding: 13px 20px; border-radius: var(--r-xl); max-width: min(92vw, 420px);
    text-align: center; font-size: var(--fs-callout); line-height: 1.45; font-weight: 700; }
  .banner.night { background: linear-gradient(135deg, rgba(58,58,96,0.78), rgba(24,24,38,0.78)); }
  .banner.day { background: linear-gradient(135deg, rgba(255,196,84,0.42), rgba(255,145,64,0.34)); }
  .banner.good { color: #34c759; }
  .banner.bad { color: #ff453a; }
  .overlay { position: fixed; inset: 0; margin: auto; top: 0; height: fit-content;
    width: min(440px, calc(100vw - 32px)); padding: var(--s6); border-radius: var(--r-xl); z-index: 62; text-align: center; }
  `,
  setup() {
    const roomApi = useRoom("/games/werewolf");
    const picked = ref(0);
    const draft = ref("");
    const chats = ref([]);
    const tick = ref(Date.now());
    const banner = ref(null);
    let bannerTimer = 0;
    let logSeen = "";

    function showBanner(entry) {
      if (!entry || !entry.text) return;
      banner.value = { text: entry.text, kind: entry.kind || "" };
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { banner.value = null; }, 4600);
    }

    const players = roomApi.players;
    const finished = roomApi.finished;
    const isSpectator = roomApi.isSpectator;
    const myId = computed(() => (store.user && store.user.id) || 0);
    const state = computed(() => (roomApi.room.value && roomApi.room.value.state) || {});
    const myRole = computed(() => state.value.my_role || "");
    const isNight = computed(() => state.value.phase === "night");
    const phaseTitle = computed(() => {
      if (!roomApi.room.value?.started) return "等待开局";
      if (finished.value) return "本局结束";
      return (isNight.value ? "第 " + state.value.day + " 夜" : "第 " + state.value.day + " 天");
    });
    const stepText = computed(() => {
      if (!roomApi.room.value?.started) return "全部人点准备后自动开局";
      if (finished.value) return roomApi.reason.value || "已结束";
      return STEP_TEXT[state.value.step] || "进行中";
    });
    const remaining = computed(() => {
      const dl = state.value.deadline || 0;
      return dl ? Math.max(0, Math.round(dl - tick.value / 1000)) : 0;
    });
    const voteResult = computed(() => state.value.vote_result || null);

    const myAction = computed(() => {
      const st = state.value;
      if (!roomApi.room.value?.started || finished.value) return false;
      if (!st.my_alive) return false;
      if (st.step === "wolf") return myRole.value === "wolf";
      if (st.step === "seer") return myRole.value === "seer";
      if (st.step === "witch") return myRole.value === "witch" && !st.witch?.done;
      if (st.step === "hunter") return true;
      if (st.step === "vote") return st.can_vote_now !== false;
      return false;
    });
    const actionTitle = computed(() => ({
      wolf: "🐺 选一个人下刀", seer: "🔮 选一个人验身份", witch: "🧪 用药",
      hunter: "🔫 你是猎人，带走一个", vote: "🗳️ 投票放逐",
    }[state.value.step] || ""));
    const actionHint = computed(() => {
      const st = state.value;
      if (st.step === "wolf") return st.wolf_votes?.length ? "队友已经动刀了，等你" : "点座位选目标";
      if (st.step === "seer") return "点座位选一个人，结果只有你自己看得到";
      if (st.step === "witch") return "一晚只能用一瓶药；解药救人，毒药杀人";
      if (st.step === "hunter") return picked.value ? "点下面的按钮开枪" : "点座位选目标，也可以放弃";
      if (st.step === "vote") return picked.value ? "确认要投 " + seatOf(picked.value) + " 号吗？" : "点座位选目标，或直接弃票";
      return "";
    });
    const confirmText = computed(() => {
      const st = state.value;
      if (st.step === "vote") return picked.value ? "投 " + seatOf(picked.value) + " 号" : "弃票";
      if (st.step === "hunter") return picked.value ? "开枪带走 " + seatOf(picked.value) + " 号" : "放弃开枪";
      if (st.step === "wolf") return picked.value ? "刀 " + seatOf(picked.value) + " 号" : "请选择要刀的人";
      if (st.step === "seer") return picked.value ? "验 " + seatOf(picked.value) + " 号" : "请选择要验的人";
      return "确认";
    });
    const allowEmpty = computed(() => state.value.step === "vote" || state.value.step === "hunter");

    const myTeamOfWinner = computed(() => {
      if (!finished.value) return false;
      const mine = state.value.my_team || "";
      const win = state.value.winner_team || "";
      return !!mine && mine === win;
    });
    const seatOrder = computed(() => {
      const st = state.value;
      if (st.order && st.order.length) return st.order;
      return players.value.map(function (p) { return p.uid; });
    });
    const waitingShort = computed(() => {
      const need = Math.max(0, (roomApi.room.value?.min || 6) - players.value.length);
      return need;
    });
    const myAliveWin = computed(() => finished.value && (roomApi.winners.value || []).includes(myId.value));

    function nameOf(uid) { return (state.value.names || {})[String(uid)] || "同学"; }
    function seatOf(uid) {
      const fixed = (state.value.seats || {})[String(uid)];
      if (fixed) return fixed;
      const idx = seatOrder.value.indexOf(uid);
      return idx >= 0 ? idx + 1 : 0;
    }
    function avatarOf(uid) {
      const hit = players.value.find((p) => p.uid === Number(uid));
      return (hit && hit.avatar) || "";
    }
    function iconOf(role) { return ROLE_ICON[role] || "user"; }
    function hasVoted(uid) { return (state.value.voted || []).indexOf(uid) >= 0; }

    function canPick(uid) {
      if (!myAction.value) return false;
      if (!state.value.alive?.[String(uid)]) return false;
      const st = state.value;
      if (st.step === "wolf") {
        if (uid === myId.value) return false;
        return !(st.wolf_mates || []).some((m) => m.uid === uid);
      }
      if (st.step === "seer") return uid !== myId.value;
      if (st.step === "vote") return uid !== myId.value;
      if (st.step === "hunter") return uid !== myId.value;
      if (st.step === "witch") return uid !== myId.value;
      return false;
    }
    function pick(uid) {
      if (state.value.step === "witch") { return; }
      if (!canPick(uid)) { haptic(14); return; }
      picked.value = picked.value === uid ? 0 : uid;
      haptic(8);
    }

    function confirm() {
      const st = state.value;
      const what = { wolf: "wolf_kill", seer: "seer_check", hunter: "hunter", vote: "vote" }[st.step];
      if (!what) return;
      if (!picked.value && !allowEmpty.value) { toast("先选一个人", "warn"); return; }
      wsSend({ t: "game.act", what, target: picked.value });
      picked.value = 0;
      haptic(10);
    }
    function witch(use) {
      wsSend({ t: "game.act", what: "witch", use, target: use === "poison" ? picked.value : 0 });
      picked.value = 0;
      haptic(10);
    }
    function sendChat() {
      const text = (draft.value || "").trim();
      if (!text) return;
      wsSend({ t: "game.chat", text: text.slice(0, 200) });
      draft.value = "";
    }

    /* 换阶段就把选中清掉，免得手滑把上一轮的选中带过去 */
    const unwatch = watch(() => state.value.step, () => { picked.value = 0; });

    /* 服务端每进入一个新阶段都会写一条 log：把它播报出来，不要一闪而过 */
    const unwatchLog = watch(() => {
      const log = state.value.log || [];
      const last = log[log.length - 1];
      return last ? String(last.at) + "|" + last.text : "";
    }, (key) => {
      if (!key || key === logSeen) return;
      const first = !logSeen;
      logSeen = key;
      if (first) return;                        /* 刚进房间不打扰 */
      const log = state.value.log || [];
      showBanner(log[log.length - 1]);
    }, { immediate: true });
    let stops = [];
    let timer = 0;
    onMounted(() => {
      stops.push(onWs("game.chat", (msg) => {
        if (!msg.chat) return;
        chats.value = chats.value.concat([msg.chat]).slice(-60);
      }));
      stops.push(onWs("game.event", (msg) => {
        if (!msg.text) return;
        if (msg.kind === "bad") { toast(msg.text, "warn", 2600); haptic(16); return; }
        showBanner({ text: msg.text, kind: msg.kind || "" });
      }));
      timer = setInterval(() => { tick.value = Date.now(); }, 1000);
    });
    onUnmounted(() => {
      stops.forEach((fn) => fn && fn());
      if (unwatch) unwatch();
      if (unwatchLog) unwatchLog();
      if (bannerTimer) clearTimeout(bannerTimer);
      if (timer) clearInterval(timer);
    });

    return { ...roomApi, picked, draft, chats, banner, players, finished, isSpectator, myId, state, myRole,
             isNight, phaseTitle, stepText, remaining, voteResult, myAction, actionTitle, actionHint,
             confirmText, allowEmpty, myAliveWin, myTeamOfWinner, waitingShort,
             nameOf, seatOf, avatarOf, iconOf, hasVoted, canPick, pick, confirm, witch, sendChat, mediaUrl, store,
             seatOrder };
  },
}));
