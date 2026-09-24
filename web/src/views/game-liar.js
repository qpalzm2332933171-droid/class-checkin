import {
  defineView, registerRoute, ref, computed, watch, nextTick, onMounted, onUnmounted,
  store, wsSend, toast, haptic, mediaUrl, onWs,
} from "../ui.js";
import { useRoom } from "../room.js";

/* 牌面：服务端只下发点数（Q/K/A/赖子 J），花色是纯装饰。
   每个点数固定一个花色，好处是同一张牌在整局里花色不会变（不会"看着看着换了张牌"），
   而且横扫一眼就能分清 Q/K/A。 */
const SUIT = {
  Q: { d: "M12 3c3 3.4 6 5.8 6 8.7a3.1 3.1 0 0 1-5 2.5l1.1 4.3h-4.2L11 14.2a3.1 3.1 0 0 1-5-2.5C6 8.8 9 6.4 12 3Z", red: false },   // ♠
  K: { d: "M12 20.5S4 15.6 4 10.6A4.6 4.6 0 0 1 12 7.6a4.6 4.6 0 0 1 8 3c0 5-8 9.9-8 9.9Z", red: true },                                    // ♥
  A: { d: "M12 3l7 9-7 9-7-9 7-9Z", red: true },                                                                                            // ♦
  J: { d: "M12 3l2.6 6.1 6.6.6-5 4.3 1.5 6.5L12 17l-5.8 3.5L7.7 9.9l-5-4.3 6.6-.6L12 3Z", red: false },                                    // ★ 赖子
};

registerRoute("/games/liar", defineView("gameLiar", {
  template: `
  <div class="page-plain liar-root">
    <MatchChat />

    <header class="row gap3 liar-head">
      <button class="btn btn-icon glass glass-thin" @click="leaveRoom(false)"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">骗子酒馆</h1>
        <p class="sub elide">{{ statusText }}</p>
      </div>
      <button class="btn glass glass-thin liar-code" @click="copyCode">房间 {{ roomCode }}</button>
    </header>

    <!-- ------------------------------------------------ 还没开局 -->
    <template v-if="!started && !finished && !aborted">
      <div class="glass glass-thick glass-liquid pad5 liar-wait mt5">
        <div class="center" style="flex-direction:column;gap:var(--s2)">
          <span class="liar-wait-ico"><Icon n="cards" :size="30" /></span>
          <b class="t3">{{ players.length >= readyNeeded ? '人齐了，点准备开局' : ('还差 ' + (readyNeeded - players.length) + ' 人开局') }}</b>
          <p class="cap center">4 人局 · 每人 5 张 · 牌堆 Q6 K6 A6 + 赖子 2</p>
        </div>
        <div class="row gap2 wrap mt5 center">
          <span v-for="p in players" :key="p.uid" class="chip chip-av" :class="isReady(p) ? 'chip-green' : ''">
            <span class="avatar" :style="p.color ? { background: p.color } : {}">
              <img v-if="p.avatar" :src="mediaUrl(p.avatar)" :alt="p.name" loading="lazy" />
              <template v-else>{{ (p.name || '?').slice(0, 1) }}</template>
            </span>
            {{ p.name }}{{ p.uid === room?.host ? '（房主）' : '' }}{{ isReady(p) ? ' · 已准备' : '' }}
          </span>
        </div>
        <button v-if="canReady" class="btn btn-block btn-lg mt5" :class="myReady ? '' : 'btn-primary'" @click="toggleReady">
          {{ myReady ? '取消准备' : '准备' }}
        </button>
        <p v-else class="cap center mt5">
          {{ players.length < readyNeeded ? '凑满 4 个人才能开局，喊同学输房间号进来' : '点上面的准备' }}
        </p>
      </div>
    </template>

    <!-- ------------------------------------------------ 牌桌 -->
    <template v-else>
      <!-- 对手：手牌张数 / 弹巢 / 本轮盖了多少张 -->
      <div class="liar-opps mt4">
        <div v-for="p in opponents" :key="p.uid" class="glass glass-thin liar-opp"
             :class="[revealTag(p.uid) ? ('tag-' + revealTag(p.uid)) : '', { turn: isTurn(p), out: !alive(p), bang: isBang(p.uid) }]">
          <!-- 开牌期间标出当事人：谁质疑的、谁被质疑（围观的人也能一眼看清是谁跟谁） -->
          <span v-if="revealTag(p.uid)" class="liar-tag">
            {{ revealTag(p.uid) === 'doubt' ? '质疑' : (revealTag(p.uid) === 'doubted' ? '被质疑' : '赢下本轮') }}
          </span>
          <div class="row gap2">
            <span class="avatar avatar-sm" :style="p.color ? { background: p.color } : {}">
              <img v-if="p.avatar" :src="mediaUrl(p.avatar)" :alt="p.name" loading="lazy" />
              <template v-else>{{ (p.name || '?').slice(0, 1) }}</template>
            </span>
            <b class="cap elide grow">{{ p.name }}</b>
          </div>
          <div class="liar-opp-mid">
            <span class="liar-back-mini" v-for="n in p.handCount" :key="n"></span>
            <span v-if="!p.handCount" class="cap">{{ alive(p) ? '空手' : '出局' }}</span>
          </div>
          <div class="liar-chambers" :class="{ hot: isBang(p.uid) }">
            <i v-for="n in cylinder" :key="n" class="liar-chamber" :class="chamberClass(p.uid, n)"></i>
          </div>
          <span v-if="p.played" class="liar-opp-pile num">本轮已盖 {{ p.played }} 张</span>
        </div>
      </div>

      <!-- 中央面板：平时显示 Table 牌，开牌时整块换成开牌结果。
           以前是"上面 Table 面板 + 下面再挂一个开牌框"两块并排：信息重复、还往下顶，
           而且倒计时 6 秒变红正好盖住整个 7 秒的开牌期，跟开牌内容抢注意力。 -->
      <div class="liar-center glass glass-thick glass-liquid mt4"
           :class="[reveal ? ('is-reveal tone-' + revealTone) : '', { urgent: !reveal && remaining > 0 && remaining <= 6 }]">
        <template v-if="reveal">
          <div class="liar-rv">
            <p class="liar-rv-verdict" :class="reveal.truthful === true ? 'ok' : (reveal.truthful === false ? 'bad' : '')">
              {{ revealHeadline }}
            </p>
            <div v-if="revealCards.length" class="liar-rv-cards">
              <div v-for="(c, i) in revealCards" :key="i" class="liar-card liar-card-rv"
                   :class="{ red: suitOf(c).red, mine: revealIsMine }" :style="{ animationDelay: (i * 80) + 'ms' }">
                <span class="liar-rank">{{ c }}</span>
                <svg class="liar-suit" viewBox="0 0 24 24" aria-hidden="true"><path :d="suitOf(c).d" /></svg>
                <span class="liar-rank liar-rank-b">{{ c }}</span>
              </div>
            </div>
            <p v-if="revealIsMine" class="liar-rv-mine">这是你的牌</p>
            <p class="liar-rv-outcome" :class="revealTone">{{ revealOutcome }}</p>
          </div>
        </template>

        <template v-else>
          <div class="liar-table-side">
            <p class="cap">本轮只能报</p>
            <div class="liar-card liar-card-table" :class="{ red: suitOf(table).red }">
              <span class="liar-rank">{{ table }}</span>
              <svg class="liar-suit" viewBox="0 0 24 24" aria-hidden="true"><path :d="suitOf(table).d" /></svg>
              <span class="liar-rank liar-rank-b">{{ table }}</span>
            </div>
          </div>
          <div class="grow liar-center-mid">
            <b class="t3">{{ centerTitle }}</b>
            <p class="cap mt2">{{ centerSub }}</p>
            <div class="liar-pile-row mt3">
              <span v-for="(p, i) in pile" :key="i" class="liar-back-tiny" :class="{ last: i === pile.length - 1 }"
                    :title="nameOf(p.uid)"></span>
              <span v-if="!pile.length" class="cap">还没有人出牌</span>
            </div>
          </div>
          <div v-if="remaining > 0 && !finished" class="liar-timer-wrap">
            <span class="liar-secs num">{{ remaining }}</span>
            <span class="liar-timer"><i :style="{ width: timerPct + '%' }"></i></span>
          </div>
        </template>
      </div>

      <!-- 我的手牌 -->
      <div class="liar-me mt4" :class="{ 'under-fire': underFire }">
        <div class="row-between">
          <span class="cap">
            我的手牌 <b class="num">{{ myHand.length }}</b>/{{ handSize }}
            <span v-if="myHand.length" class="liar-true-tip">· 其中 {{ trueCount }} 张是真牌</span>
          </span>
          <span class="liar-chambers" :class="{ hot: isBang(myUid) || underFire }">
            <i v-for="n in cylinder" :key="n" class="liar-chamber" :class="chamberClass(myUid, n)"></i>
          </span>
        </div>
        <TransitionGroup name="liar-deal" tag="div" class="liar-hand">
          <button v-for="(c, i) in myHand" :key="tokens[i] || i" type="button"
                  class="liar-card" :class="{ red: suitOf(c).red, sel: picked.includes(i), real: isTrueCard(c), dim: !canPick }"
                  @click="toggleCard(i)">
            <span class="liar-rank">{{ c }}</span>
            <svg class="liar-suit" viewBox="0 0 24 24" aria-hidden="true"><path :d="suitOf(c).d" /></svg>
            <span class="liar-rank liar-rank-b">{{ c }}</span>
            <i v-if="isTrueCard(c)" class="liar-true-dot" aria-hidden="true"></i>
          </button>
          <span v-if="!myHand.length" class="cap">{{ myAlive ? '手上没牌了' : '你已出局，本局继续' }}</span>
        </TransitionGroup>
      </div>

      <!-- 战报：谁盖了几张这类流水放这儿，服务端不会再为它们弹 toast -->
      <div class="liar-log glass glass-thin">
        <div class="row-between">
          <span class="cap">战报</span>
          <span class="cap">第 {{ state.round || 1 }} 轮</span>
        </div>
        <div class="liar-log-list">
          <p v-for="(l, i) in logLines" :key="i" class="liar-log-line" :class="l.kind">{{ l.text }}</p>
          <p v-if="!logLines.length" class="liar-log-line">还没有动静</p>
        </div>
      </div>
    </template>

    <!-- ------------------------------------------------ 底部操作条 -->
    <div class="liar-bar-spacer"></div>
    <div class="liar-bar glass glass-thick">
      <template v-if="isSpectator">
        <span class="cap center grow">观战模式 · 看他们互相骗</span>
      </template>
      <template v-else-if="!started && !finished">
        <span class="cap center grow">等 4 个人到齐、都点准备就开局</span>
      </template>
      <template v-else-if="finished || aborted">
        <span class="cap center grow">{{ overTitle }} · 用下面的按钮离开或再来一局</span>
      </template>
      <template v-else-if="!myAlive">
        <span class="cap center grow">你已经出局了 · 等这一局打完</span>
      </template>
      <template v-else-if="can.pass">
        <button class="btn grow liar-doubt" @click="doDoubt">质疑（赌一把）</button>
        <button class="btn grow btn-primary" @click="doPass">放过</button>
      </template>
      <template v-else-if="isMyTurn">
        <button class="btn grow liar-doubt" :disabled="!can.doubt" @click="doDoubt">质疑上家</button>
        <button class="btn grow btn-primary" :disabled="!picked.length" @click="doPlay">
          盖牌出 {{ picked.length || '' }} 张
        </button>
      </template>
      <!-- 开牌期间：这条固定条一直在屏幕上，正好拿来播报"我个人"的结局。
           跟你无关时只说"开牌中…"，不抢中央面板的戏。 -->
      <template v-else-if="reveal">
        <span class="liar-personal" :class="revealBar.tone">{{ revealBar.text }}</span>
      </template>
      <template v-else>
        <span class="cap center grow">等 {{ nameOf(state.turn) }} 出牌</span>
      </template>
    </div>

    <Transition name="fade"><div v-if="flash" :key="flashKey" class="liar-flash"></div></Transition>

    <Transition name="mat">
      <div v-if="finished || aborted" class="liar-over glass glass-thick">
        <h2 class="t2">{{ overTitle }}</h2>
        <p class="sub mt2">{{ overSub }}</p>
        <div class="row gap3 mt5">
          <button class="btn grow" @click="leaveRoom(false)">{{ isSpectator ? '退出观战' : '离开房间' }}</button>
          <button v-if="!isSpectator" class="btn grow" :class="othersWantRematch ? 'btn-green' : 'btn-primary'" @click="rematch">再来一局</button>
        </div>
        <p v-if="notice" class="sub mt3">{{ notice }}</p>
      </div>
    </Transition>
  </div>`,

  style: `
  .liar-root { position: relative; }
  .liar-head { padding-top: calc(var(--safe-t) + var(--s4)); }
  .liar-code { padding: 6px 12px; font-size: var(--fs-sub); font-weight: 600; letter-spacing: 0.08em; }

  /* ---------------- 等待开局 ---------------- */
  .liar-wait { border-radius: var(--r-xl); }
  .liar-wait-ico { display: grid; place-items: center; width: 58px; height: 58px; border-radius: var(--r-full);
    background: var(--accent-soft); color: var(--accent); }

  /* ---------------- 对手 ---------------- */
  .liar-opps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s2); }
  .liar-opp { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: var(--r-md);
    transition: box-shadow var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out); }
  .liar-opp.turn { box-shadow: 0 0 0 2px var(--accent), var(--shadow-1); }
  .liar-opp.out { opacity: 0.42; filter: grayscale(1); }
  .liar-opp.bang { animation: liar-shake 460ms var(--ease-inout); }
  /* 开牌期间标出当事人：质疑者 / 被质疑者 / 放过时赢下本轮的人 */
  .liar-opp.tag-doubt { box-shadow: 0 0 0 2px var(--orange), var(--shadow-1); }
  .liar-opp.tag-doubted { box-shadow: 0 0 0 2px var(--accent), var(--shadow-1); }
  .liar-opp.tag-win { box-shadow: 0 0 0 2px var(--green), var(--shadow-1); }
  .liar-tag { position: absolute; top: -9px; left: 8px; padding: 1px 7px; border-radius: var(--r-full);
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em; color: #fff; white-space: nowrap; }
  .tag-doubt .liar-tag { background: var(--orange); }
  .tag-doubted .liar-tag { background: var(--accent); }
  .tag-win .liar-tag { background: var(--green); }
  .liar-opp-mid { display: flex; flex-wrap: wrap; gap: 2px; min-height: 20px; align-items: center; }
  .liar-back-mini { width: 9px; height: 13px; border-radius: 2px; border: 1px solid rgba(11,18,32,.22);
    background: repeating-linear-gradient(135deg, #4b5566 0 2px, #39414f 2px 4px); }
  .liar-opp-pile { font-size: 10.5px; color: var(--ink-3); }

  /* ---------------- 弹巢 ---------------- */
  .liar-chambers { display: flex; gap: 3px; align-items: center; }
  .liar-chamber { width: 7px; height: 7px; border-radius: 50%; background: var(--hair-strong);
    transition: background-color var(--dur-med) linear, transform var(--dur-med) var(--ease-out); }
  .liar-chamber.fired { background: var(--orange); }
  .liar-chamber.bang { background: var(--red); transform: scale(1.35); }
  .liar-chambers.hot .liar-chamber { animation: liar-spin 520ms var(--ease-inout); }

  /* ---------------- 中央牌桌 ---------------- */
  .liar-center { display: flex; align-items: center; gap: var(--s3); padding: var(--s4); border-radius: var(--r-xl);
    position: relative; overflow: hidden; }
  .liar-center.urgent { box-shadow: 0 0 0 2px var(--red), var(--shadow-2); }
  .liar-table-side { display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .liar-center-mid { min-width: 0; }
  .liar-pile-row { display: flex; align-items: center; gap: 3px; min-height: 22px; flex-wrap: wrap; }
  .liar-back-tiny { width: 14px; height: 20px; border-radius: 3px; border: 1px solid rgba(11,18,32,.2);
    background: repeating-linear-gradient(135deg, #55607a 0 3px, #3c4557 3px 6px);
    animation: liar-drop var(--dur-med) var(--ease-out) both; }
  .liar-back-tiny.last { box-shadow: 0 0 0 2px var(--accent); }
  .liar-timer-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .liar-secs { font-size: var(--fs-title3); font-weight: 700; }
  .liar-timer { display: block; width: 40px; height: 4px; border-radius: 2px; background: var(--hair); overflow: hidden; }
  .liar-timer i { display: block; height: 100%; background: var(--accent); transition: width 250ms linear; }
  .liar-center.urgent .liar-timer i { background: var(--red); }
  .liar-center.urgent .liar-secs { color: var(--red); }

  /* ---------------- 牌 ---------------- */
  .liar-card { position: relative; flex: 0 0 auto; width: 56px; height: 80px; padding: 0;
    border-radius: 9px; background: linear-gradient(160deg, #ffffff, #eef1f7); color: #10131a;
    border: 1px solid rgba(11, 18, 32, 0.16);
    box-shadow: 0 1px 2px rgba(15, 23, 42, .12), 0 6px 16px rgba(15, 23, 42, .10);
    transition: transform var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out);
    will-change: transform; overflow: hidden; }
  .liar-card.red { color: #cf2f36; }
  .liar-rank { position: absolute; top: 4px; left: 6px; font-size: 15px; font-weight: 700; line-height: 1;
    letter-spacing: -0.02em; }
  .liar-rank-b { top: auto; left: auto; bottom: 4px; right: 6px; transform: rotate(180deg); font-size: 12px; opacity: .7; }
  .liar-suit { position: absolute; left: 50%; top: 54%; width: 58%; height: 58%; transform: translate(-50%, -50%);
    fill: currentColor; opacity: .92; }
  .liar-card-table { width: 62px; height: 88px; box-shadow: var(--shadow-2); }
  .liar-card-table .liar-rank { font-size: 19px; }
  .liar-card.sel { transform: translateY(-16px) scale(1.04); }
  .liar-card.sel::after { content: ""; position: absolute; inset: 0; border-radius: inherit;
    border: 2px solid var(--accent); background: var(--accent-soft); }
  .liar-card.dim { opacity: .78; }
  .liar-true-dot { position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%;
    background: var(--green); box-shadow: 0 0 0 2px rgba(255,255,255,.9); }
  .liar-hand { display: flex; gap: var(--s2); justify-content: center; align-items: flex-end;
    min-height: 96px; padding-top: 18px; flex-wrap: wrap; }
  .liar-true-tip { color: var(--green); font-weight: 600; }

  /* ---------------- 开牌：中央面板整块换成结果 ---------------- */
  .liar-center.is-reveal { flex-direction: column; align-items: stretch; justify-content: center;
    gap: var(--s3); padding: var(--s5) var(--s4); min-height: 148px; }
  .liar-center.tone-dead { box-shadow: 0 0 0 2px var(--red), var(--shadow-2); }
  .liar-center.tone-survive { box-shadow: 0 0 0 2px var(--orange), var(--shadow-2); }
  .liar-center.tone-pass { box-shadow: 0 0 0 2px var(--green), var(--shadow-2); }
  .liar-rv { display: flex; flex-direction: column; align-items: center; gap: var(--s3);
    width: 100%; text-align: center; }
  /* 判决语是这一屏最该被看到的东西，所以比正文大一档 */
  .liar-rv-verdict { font-size: 20px; font-weight: 700; line-height: 1.28; letter-spacing: -0.01em; }
  .liar-rv-verdict.ok { color: var(--green); }
  .liar-rv-verdict.bad { color: var(--red); }
  .liar-rv-cards { display: flex; gap: var(--s2); justify-content: center; flex-wrap: wrap; perspective: 900px; }
  .liar-card-rv { width: 54px; height: 78px; animation: liar-flip var(--dur-slow) var(--ease-out) both; }
  .liar-card-rv .liar-rank { font-size: 15px; }
  .liar-rv-outcome { font-size: var(--fs-callout); font-weight: 650; line-height: 1.4; }
  .liar-rv-outcome.dead { color: var(--red); }
  .liar-rv-outcome.survive { color: var(--orange); }
  .liar-rv-outcome.pass { color: var(--green); }
  /* 被翻开的是我自己的牌 -> 加一圈自己的强调色，一眼认出"这是我的牌" */
  .liar-card-rv.mine { box-shadow: 0 0 0 2px var(--accent), var(--shadow-2); }
  .liar-rv-mine { font-size: var(--fs-cap); font-weight: 700; color: var(--accent); letter-spacing: 0.02em; }
  /* 枪口对着我：整块自己的区域持续高亮（不只是弹巢抖一下） */
  .liar-me.under-fire { border-radius: var(--r-md); box-shadow: 0 0 0 2px var(--red); }
  .liar-me.under-fire .liar-chamber.fired { background: var(--red); }
  /* 底部固定条上的"我的结局" */
  .liar-personal { flex: 1; text-align: center; font-size: var(--fs-sub); font-weight: 650; line-height: 1.35; }
  .liar-personal.good { color: var(--green); }
  .liar-personal.bad { color: var(--red); }

  /* ---------------- 战报 ---------------- */
  .liar-log { margin-top: var(--s4); padding: var(--s3) var(--s4); border-radius: var(--r-lg); }
  .liar-log-list { display: flex; flex-direction: column; gap: 3px; margin-top: 5px; }
  .liar-log-line { font-size: var(--fs-cap); line-height: 1.55; color: var(--ink-2); }
  /* 最新的那条压在最上面并且加粗，一眼能看到刚发生了什么 */
  .liar-log-line:first-child { color: var(--ink); font-weight: 600; }
  .liar-log-line.good { color: var(--green); }
  .liar-log-line.bad { color: var(--red); }

  /* ---------------- 底部操作条 ---------------- */
  /* 留白要同时避开两样东西：固定操作条（约 68px）和它上面的"讨论"悬浮球
     （.mc-fab 定位在 safe-b + 78px、高约 50px），否则战报最后几行会被盖住 */
  .liar-bar-spacer { height: 132px; }
  .liar-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    display: flex; align-items: center; gap: var(--s2);
    padding: var(--s3) var(--s4) calc(var(--s3) + var(--safe-b));
    border-radius: var(--r-xl) var(--r-xl) 0 0; }
  .liar-doubt { background: var(--orange-soft); color: var(--orange);
    border-color: color-mix(in srgb, var(--orange) 30%, transparent); }
  .liar-over { position: fixed; left: 50%; transform: translateX(-50%);
    /* 抬到底部操作条上面去，否则浮层的按钮会被操作条压住 */
    bottom: calc(var(--safe-b) + 84px);
    padding: var(--s5); border-radius: var(--r-xl); text-align: center; width: min(90vw, 400px); z-index: 30; }
  .liar-flash { position: fixed; inset: 0; z-index: 60; pointer-events: none;
    background: radial-gradient(circle at 50% 55%, rgba(229, 72, 77, .55), rgba(229, 72, 77, 0) 68%);
    animation: liar-flash 620ms var(--ease-out) both; }

  /* ---------------- 动效 ---------------- */
  @keyframes liar-drop { from { transform: translateY(-10px) scale(.7); opacity: 0 } to { transform: none; opacity: 1 } }
  @keyframes liar-flip { from { transform: rotateY(88deg) scale(.92); opacity: 0 } to { transform: rotateY(0) scale(1); opacity: 1 } }
  @keyframes liar-shake { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-4px) } 40% { transform: translateX(4px) } 60% { transform: translateX(-3px) } 80% { transform: translateX(2px) } }
  @keyframes liar-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
  @keyframes liar-flash { from { opacity: 1 } to { opacity: 0 } }
  .liar-deal-enter-from { transform: translateY(-26px) scale(.86); opacity: 0; }
  .liar-deal-leave-to { transform: translateY(-40px) scale(.8); opacity: 0; }
  .liar-deal-enter-active, .liar-deal-leave-active { transition: transform var(--dur-med) var(--ease-out), opacity var(--dur-med) linear; }
  @media (prefers-reduced-motion: reduce) {
    .liar-opp.bang, .liar-chambers.hot .liar-chamber, .liar-flash,
    .liar-card-rv, .liar-back-tiny { animation: none; }
  }
  `,

  setup() {
    const roomApi = useRoom("/games/liar");
    const { room, players, finished, aborted, winners, notice, isSpectator, othersWantRematch,
            canReady, myReady, isReady, toggleReady, leaveRoom, rematch, copyCode, roomCode, readyNeeded } = roomApi;

    const state = ref({});
    const picked = ref([]);
    const tokens = ref([]);        // 与手牌等长的稳定 key，保证"打出去的那张"飞走时其他牌不乱跳
    const flash = ref(false);
    const flashKey = ref(0);
    const nowSec = ref(Date.now() / 1000);
    const skew = ref(0);           // 服务端与本机的时钟差（手机时间不准时倒计时也不会飞）
    const budget = ref(1);
    let seq = 0;
    let lastPlayed = [];
    let timer = null;
    let flashTimer = null;

    const me = computed(() => (store.user && store.user.id) || 0);
    const myUid = computed(() => state.value.my_uid || me.value);
    const myHand = computed(() => state.value.my_hand || []);
    const myAlive = computed(() => state.value.my_alive !== false);
    const table = computed(() => state.value.table || "");
    const cylinder = computed(() => state.value.cylinder || 6);
    const pile = computed(() => state.value.pile || []);
    const reveal = computed(() => state.value.reveal || null);
    const can = computed(() => state.value.can || { play: false, doubt: false, pass: false, max: 0 });
    const started = computed(() => !!(room.value && room.value.started));
    const finishedState = computed(() => finished.value || aborted.value || state.value.status === "finished");
    const handSize = computed(() => 5);
    const isMyTurn = computed(() => !!state.value.my_turn && !finishedState.value);
    const trueCount = computed(() => myHand.value.filter(isTrueCard).length);
    const canPick = computed(() => isMyTurn.value && !can.value.pass && myHand.value.length > 0);
    /* 战报：最新的在最上面，只留最近几条 */
    const logLines = computed(() => (state.value.log || []).slice(-8).reverse());

    function suitOf(rank) { return SUIT[rank] || SUIT.Q; }
    function isTrueCard(card) { return card === table.value || card === "J"; }
    function nameOf(uid) { return (state.value.names || {})[String(uid)] || "同学"; }
    function alive(uid) { return !!(state.value.alive || {})[String(uid)]; }
    function isTurn(player) { return state.value.turn === player.uid && !finishedState.value; }
    function firedOf(uid) { return (state.value.revolver || {})[String(uid)] || 0; }
    function isBang(uid) {
      const rev = reveal.value;
      return !!(rev && !rev.pass && rev.shot && rev.loser === uid);
    }
    function chamberClass(uid, n) {
      const fired = firedOf(uid);
      const bang = isBang(uid) && n === fired;
      return { fired: n <= fired, bang };
    }

    const opponents = computed(() => {
      const st = state.value;
      const order = st.order || [];
      const names = st.names || {};
      const counts = st.hand_count || {};
      const seat = st.seats || {};
      const played = {};
      (st.pile || []).forEach((p) => { played[String(p.uid)] = (played[String(p.uid)] || 0) + p.n; });
      return order.filter((uid) => uid !== myUid.value).map((uid) => ({
        uid,
        name: names[String(uid)] || "同学",
        seat: seat[String(uid)] || 0,
        handCount: counts[String(uid)] || 0,
        played: played[String(uid)] || 0,
        color: ((players.value || []).find((p) => p.uid === uid) || {}).color || "",
        avatar: ((players.value || []).find((p) => p.uid === uid) || {}).avatar || "",
      }));
    });

    const remaining = computed(() => {
      const deadline = state.value.deadline || 0;
      if (!deadline) return 0;
      return Math.max(0, Math.round(deadline - (nowSec.value + skew.value)));
    });
    const timerPct = computed(() => {
      const r = remaining.value;
      if (!r) return 0;
      return Math.max(0, Math.min(100, Math.round((r / Math.max(1, budget.value)) * 100)));
    });

    const statusText = computed(() => {
      if (aborted.value) return "本局已中止";
      if (finished.value) return "本局结束";
      if (!started.value) return "等人齐 · 4 人局";
      if (reveal.value) return "开牌中…";
      if (!myAlive.value) return "你已出局 · 观看剩下的对局";
      if (can.value.pass) return "上家出完手牌了 —— 质疑，还是放过？";
      if (isMyTurn.value) return "轮到你：盖牌出 1~3 张，或质疑上家";
      return "第 " + (state.value.round || 1) + " 轮 · 等 " + nameOf(state.value.turn) + " 行动";
    });
    const centerTitle = computed(() => {
      if (can.value.pass) return nameOf((state.value.last || {}).uid) + " 出完了手牌";
      const last = state.value.last;
      if (last) return nameOf(last.uid) + " 报了 " + last.n + " 张 " + table.value;
      return "本轮还没人出牌";
    });
    /* 中央面板是四个人共用的一块，所以这里每一句都要想清楚"这句话对所有人成立吗"。
       `can` 是服务端按观看者算的（只有当事人能通过），拿它做判断天然是按人区分的；
       而 `pile` 是全场共享的 —— 用它做判断时就必须自己补上"是不是轮到我"。 */
    const centerSub = computed(() => {
      if (can.value.pass) return "你必须质疑或者放过（超时会自动放过）";
      if (!pile.value.length) {
        // 本轮还没人出牌：只有真正该先出的人能听到"你"，其他人是在等
        return isMyTurn.value
          ? "你是本轮第一个出牌的，只能出牌，不能质疑"
          : "还没有人出牌 · 等 " + nameOf(state.value.turn) + " 先出";
      }
      const total = state.value.pile_total || 0;
      const mine = pile.value.filter((p) => p.uid === myUid.value).reduce((a, p) => a + p.n, 0);
      return "本轮牌堆共 " + total + " 张" + (mine ? "（你盖了 " + mine + " 张）" : "");
    });

    /* ---- 开牌展示：整块中央面板换成这个 ---- */
    const revealCards = computed(() => (reveal.value && reveal.value.cards) || []);
    /** 面板描边色看"后果"：出局=红、空枪=橙、放过=绿 */
    const revealTone = computed(() => {
      const r = reveal.value;
      if (!r) return "";
      if (r.pass) return "pass";
      return (r.shot && r.shot.died) ? "dead" : "survive";
    });

    /* ---- 当事人视角 ----
       原来开牌是纯第三方播报（「牌手2 质疑 牌手1」），三个人的屏幕上写的是同一句话，
       当事人根本看不出跟自己什么关系。下面这几件事专门解决它：
         whoIs()          判决语里把自己写成"你"
         revealTag()      对手卡片上标出谁是质疑者、谁是被质疑者
         revealBar        底部固定操作条播报（当事人=我的结局，其他人=一句短的）
         revealIsMine     被翻开的是我的牌时，牌面加自己的强调色
         underFire        轮到我挨枪时，我的弹巢行持续高亮（不只是抖一下） */
    function whoIs(uid) { return uid === myUid.value ? "你" : nameOf(uid); }
    function revealTag(uid) {
      const r = reveal.value;
      if (!r) return "";
      if (r.pass) return uid === r.uid ? "win" : "";
      if (uid === r.doubt_by) return "doubt";
      if (uid === r.uid) return "doubted";
      return "";
    }
    const revealIsMine = computed(() => !!reveal.value && reveal.value.uid === myUid.value);
    const underFire = computed(() => {
      const r = reveal.value;
      return !!r && !r.pass && r.loser === myUid.value;
    });
    const revealHeadline = computed(() => {
      const r = reveal.value;
      if (!r) return "";
      if (r.pass) return "🤝 " + whoIs(r.doubt_by) + " 放过 —— " + whoIs(r.uid) + " 赢下本轮";
      return whoIs(r.doubt_by) + " 质疑 " + whoIs(r.uid) + " —— " + (r.truthful ? "开出来是真牌" : "抓到撒谎");
    });
    const revealOutcome = computed(() => {
      const r = reveal.value;
      if (!r) return "";
      if (r.pass) return whoIs(r.uid) + " 盖着出了 " + r.n + " 张，没人质疑，本轮结束";
      if (r.shot && r.shot.died) return "💥 " + whoIs(r.loser) + " 挨了第 " + r.shot.fired + " 枪 —— 出局";
      if (r.shot) return "咔哒，空枪。" + whoIs(r.loser) + " 活下来了（" + r.shot.fired + "/" + cylinder.value + "）";
      return "";
    });
    /** 底部固定条在开牌期间的播报。
     *  当事人看到"我个人"的结局；其他人看到一句短的 —— 这样底栏**始终**能告诉你
     *  刚刚发生了什么，也就不需要再往顶部弹 toast 了（toast 会盖住对手卡片上的身份标签）。 */
    const revealBar = computed(() => {
      const none = { text: "", tone: "" };
      const r = reveal.value;
      if (!r) return none;
      const me = myUid.value;
      const fired = r.shot ? ("第 " + r.shot.fired + " 枪") : "";
      const ended = (r.shot && r.shot.died) ? "你出局了" : "空枪，你活下来了";

      if (r.pass) {
        if (r.uid === me) return { text: "✅ 没人质疑你 —— 你赢下本轮", tone: "good" };
        if (r.doubt_by === me) return { text: "你放过了 —— " + r.name + " 赢下本轮", tone: "" };
      } else if (r.doubt_by === me) {
        return r.truthful
          ? { text: "❌ 质疑失败 —— " + r.name + " 说的是真话，" + ended, tone: "bad" }
          : { text: "✅ 你抓到撒谎了 —— " + r.name + " 挨" + fired + (r.shot.died ? "，出局" : "（空枪）"), tone: "good" };
      } else if (r.uid === me) {
        return r.truthful
          ? { text: "✅ 你说的是真话 —— " + r.doubt_by_name + " 挨" + fired + (r.shot.died ? "，出局" : "（空枪）"), tone: "good" }
          : { text: "❌ 你被 " + r.doubt_by_name + " 抓到撒谎 —— " + ended, tone: "bad" };
      }

      // 不是我参与的这局：给一句短的，保证底栏不是空的
      if (r.pass) return { text: whoIs(r.doubt_by) + " 放过 —— " + whoIs(r.uid) + " 赢下本轮", tone: "" };
      return { text: whoIs(r.doubt_by) + " 质疑 " + whoIs(r.uid) + " —— "
               + (r.truthful ? "开的确实是真牌" : "抓到撒谎"), tone: "" };
    });
    const overTitle = computed(() => {
      if (aborted.value) return "本局已中止";
      if (isSpectator.value) return "本局结束";
      return (winners.value || []).includes(myUid.value) ? "你活到了最后 🎉" : "你出局了";
    });
    const overSub = computed(() => {
      if (aborted.value) return roomApi.reason.value || "有人离开了房间";
      const names = (winners.value || []).map((uid) => nameOf(uid)).join("、");
      return names ? (names + " 活到了最后") : "本局结束";
    });

    /* 手牌 key：张数变了就按"我刚打出的下标"精确移除，否则整副重发。
       这样打出去的那张牌会准确地飞走，而不是让 Vue 把最后一张删掉。 */
    function syncTokens(hand) {
      const want = hand.length;
      if (tokens.value.length === want) { lastPlayed = []; return; }
      if (lastPlayed.length && tokens.value.length === want + lastPlayed.length) {
        tokens.value = tokens.value.filter((_, i) => !lastPlayed.includes(i));
      }
      if (tokens.value.length !== want) tokens.value = hand.map(() => ++seq);
      lastPlayed = [];
    }

    function showFlash() {
      flash.value = true;
      flashKey.value += 1;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flash.value = false; }, 640);
    }

    const stopWatch = watch(room, () => {
      const next = (room.value && room.value.state) || {};
      const before = state.value || {};
      state.value = next;
      syncTokens(next.my_hand || []);
      /* 手牌或轮次变了就把选中的牌清掉，避免拿着上一轮的选中态去打下一轮 */
      const handSig = (next.my_hand || []).join("");
      const oldSig = (before.my_hand || []).join("");
      if (handSig !== oldSig || next.round !== before.round || next.turn !== before.turn) picked.value = [];
      /* 有人中枪：红闪 + 强震动 */
      const rev = next.reveal;
      const oldRev = before.reveal;
      if (rev && rev !== oldRev && rev.shot) {
        haptic(rev.shot.died ? [30, 60, 30, 60, 120] : [16, 40, 16]);
        if (rev.shot.died) showFlash();
      }
    }, { immediate: true, deep: false });

    const stopDeadline = watch(() => state.value.deadline, () => {
      budget.value = 1;
      nextTick(() => { budget.value = Math.max(1, remaining.value); });
    }, { immediate: true });

    function toggleCard(i) {
      if (!canPick.value) return;
      const max = can.value.max || 3;
      const at = picked.value.indexOf(i);
      if (at >= 0) {
        picked.value = picked.value.filter((x) => x !== i);
      } else {
        if (picked.value.length >= max) {
          toast("一手最多盖 " + max + " 张", "warn", 1600);
          return;
        }
        picked.value = picked.value.concat([i]).sort((a, b) => a - b);
      }
      haptic(6);
    }

    function doPlay() {
      if (!picked.value.length || !isMyTurn.value) return;
      lastPlayed = picked.value.slice();
      wsSend({ t: "game.act", action: "act", what: "play", cards: picked.value.slice() });
      picked.value = [];
      haptic(12);
    }
    function doDoubt() {
      if (!can.value.doubt) return;
      wsSend({ t: "game.act", action: "act", what: "doubt" });
      haptic([14, 40, 14]);
    }
    function doPass() {
      if (!can.value.pass) return;
      wsSend({ t: "game.act", action: "act", what: "pass" });
      haptic(10);
    }

    let stops = [];
    onMounted(() => {
      timer = setInterval(() => { nowSec.value = Date.now() / 1000; }, 250);
      /* 用 pong 里的服务端时间校准倒计时，手机时间不准也不会显示成负数或乱跳 */
      stops.push(onWs("pong", (msg) => { if (msg.ts) skew.value = msg.ts - Date.now() / 1000; }));
      wsSend({ t: "ping" });
    });
    onUnmounted(() => {
      clearInterval(timer);
      clearTimeout(flashTimer);
      stops.forEach((fn) => fn && fn());
      if (stopWatch) stopWatch();
      if (stopDeadline) stopDeadline();
    });

    return {
      ...roomApi, store, mediaUrl,
      state, picked, tokens, flash, flashKey,
      myUid, myHand, myAlive, table, cylinder, pile, reveal, can, started,
      /* finished 覆盖 useRoom 里那个：开牌展示期也当"进行中"，避免提前弹结束浮层 */
      finished: finishedState, handSize, isMyTurn, trueCount, canPick, logLines,
      opponents, remaining, timerPct, statusText, centerTitle, centerSub, overTitle, overSub,
      revealCards, revealTone, revealHeadline, revealOutcome,
      suitOf, isTrueCard, nameOf, alive, isTurn, firedOf, isBang, chamberClass,
      revealTag, revealIsMine, underFire, revealBar,
      toggleCard, doPlay, doDoubt, doPass,
    };
  },
}));
