import {
  defineView, registerRoute, ref, computed, onMounted, onUnmounted, api, store, navigate,
  toast, haptic, onWs, confirmDialog, mediaUrl, deviceLocation,
} from "../ui.js";

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

registerRoute("/", defineView("home", {
  template: `
  <div class="page">
    <header class="big-title row-between">
      <div>
        <h1 class="t1">{{ greeting }}</h1>
        <p class="sub mt2">{{ todayText }} · 第 {{ weekNo }} 教学周</p>
      </div>
      <div class="row gap2">
        <button class="announce-btn" @click="openAnnouncements" title="班级公告">
          <Icon n="megaphone" :size="19" />
          <span v-if="store.unreadAnnounce" class="badge">{{ store.unreadAnnounce }}</span>
        </button>
        <div class="avatar" :style="avatarStyle" @click="navigate('/me')">
          <img v-if="myAvatar" :src="myAvatar" alt="" />
          <template v-else>{{ initial }}</template>
        </div>
      </div>
    </header>

    <!-- 当前签到场次 -->
    <section class="mt5">
      <div v-if="loading" class="glass pad5"><div class="skel" style="height:132px"></div></div>

      <div v-else-if="!session" class="glass glass-liquid pad6 center stack" style="text-align:center">
        <Icon n="calendar" :size="38" />
        <h2 class="t3 mt3">今天还没有签到安排</h2>
        <p class="sub">等老师开放签到场次后，这里会出现一个大按钮。</p>
      </div>

      <div v-else class="glass glass-thick glass-liquid session-card" :class="{ done: mine }">
        <div v-if="sessions.length > 1" class="sess-tabs" data-no-swipe>
          <button v-for="s in sessions" :key="s.id" class="sess-tab" :class="{ on: s.id === activeId }" @click="pickSession(s.id)">
            <span class="elide">{{ s.title }}</span>
            <span class="cap">{{ fmtTime(s.sign_at) }}</span>
          </button>
        </div>
        <div class="row-between">
          <div class="grow" style="min-width:0">
            <div class="row gap2">
              <span class="chip" :class="statusChip.cls"><span class="dot"></span>{{ statusChip.text }}</span>
              <span v-if="session.require_note" class="chip">需备注</span>
            </div>
            <h2 class="t2 mt3 elide">{{ session.title }}</h2>
            <p class="sub mt2">
              签到时间 {{ fmtTime(session.sign_at) || fmtTime(session.late_after) }}
              <template v-if="session.sign_at"> · {{ fmtTime(session.sign_at) }} 前正常</template>
              <template v-if="session.ends_at"> · {{ fmtTime(session.ends_at) }} 截止（之后 {{ session.grace_minutes }} 分钟内可补签）</template>
            </p>
          </div>
          <div class="ring" :style="ringStyle">
            <svg width="96" height="96" viewBox="0 0 96 96">
              <circle class="bgc" cx="48" cy="48" r="40"></circle>
              <circle class="fgc" cx="48" cy="48" r="40"
                      :stroke-dasharray="251.2" :stroke-dashoffset="ringOffset"></circle>
            </svg>
            <div class="ring-label"><b class="num">{{ session.present }}</b><span class="cap">/{{ session.total }}</span></div>
          </div>
        </div>

        <div v-if="session.require_location && !mine" class="glass glass-thin pad4 mt4 loc-box">
          <Icon n="location" :size="18" />
          <div class="grow" style="min-width:0">
            <b class="elide">{{ session.place || '指定签到位置' }}</b>
            <p class="cap mt1">需要在签到地点 {{ session.radius }} 米范围内</p>
          </div>
          <button class="btn btn-sm" @click="locate">{{ geoText }}</button>
        </div>

        <div v-if="session.require_note && !mine" class="mt4">
          <input class="field" v-model.trim="note" placeholder="备注（例如：请假原因 / 迟到的原因）" maxlength="60" />
        </div>

        <Transition name="mat" mode="out-in">
          <button v-if="!mine" key="go" class="btn btn-primary btn-lg btn-block mt5" :disabled="busy" @click="doSign">
            <span v-if="!busy">立即签到</span>
            <span v-else class="row gap2"><span class="spin"></span>提交中</span>
          </button>
          <div v-else key="done" class="done-box mt5">
            <div class="tick"><Icon n="check" :size="26" /></div>
            <div class="grow">
              <b>{{ mine.status === 'late' ? '已签到（迟到）' : mine.status === 'leave' ? '已请假' : '签到成功' }}</b>
              <p class="sub">{{ fmtTime(mine.created_at) }} 记录 · 本月出勤 {{ stats.rate }}%</p>
            </div>
          </div>
        </Transition>

        <div class="row gap2 mt4">
          <button class="btn btn-sm grow" @click="showDetail">查看名单</button>
          <button v-if="!mine && session" class="btn btn-sm grow" @click="askLeave">请假</button>
        </div>
      </div>
    </section>

    <!-- 我的数据 -->
    <section class="stat-grid mt5">
      <div class="glass pad5 stat">
        <span class="cap">连续签到</span>
        <b class="num t1">{{ stats.streak || 0 }}<i>天</i></b>
      </div>
      <div class="glass pad5 stat">
        <span class="cap">出勤率</span>
        <b class="num t1">{{ stats.rate || 0 }}<i>%</i></b>
      </div>
      <div class="glass pad5 stat">
        <span class="cap">迟到</span>
        <b class="num t1">{{ stats.late || 0 }}<i>次</i></b>
      </div>
      <div class="glass pad5 stat">
        <span class="cap">请假</span>
        <b class="num t1">{{ stats.leave || 0 }}<i>次</i></b>
      </div>
    </section>

    <!-- 班级动态 -->
    <h2 class="section-title">班级出勤</h2>
    <div class="glass glass-thin list">
      <div v-for="row in ranking" :key="row.id" class="list-row">
        <span class="avatar avatar-sm" :style="row.color ? { background: row.color } : {}">
          <img v-if="row.avatar" :src="mediaUrl(row.avatar)" :alt="row.name" loading="lazy" />
          <template v-else>{{ (row.name || '?').slice(0, 1) }}</template>
        </span>
        <span class="grow elide">{{ row.name }}</span>
        <span class="bar"><i :style="{ width: row.rate + '%' }"></i></span>
        <b class="num" style="width:52px;text-align:right">{{ row.rate }}%</b>
      </div>
      <div v-if="!ranking.length" class="list-row sub">暂无数据</div>
    </div>

    <h2 class="section-title">最近签到</h2>
    <div class="glass glass-thin list">
      <div v-for="item in recent" :key="item.id" class="list-row tap" @click="navigate('/records')">
        <span class="chip" :class="statusOf(item.status).cls">{{ statusOf(item.status).text }}</span>
        <span class="grow elide">{{ item.title }}</span>
        <span class="cap">{{ fmtTime(item.created_at) }}</span>
      </div>
      <div v-if="!recent.length" class="list-row sub">还没有签到记录</div>
    </div>
  </div>`,
  style: `
  .session-card { padding: var(--s5); }
  .sess-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; margin-bottom: var(--s3);
    scrollbar-width: none; }
  .sess-tabs::-webkit-scrollbar { display: none; }
  .sess-tab { flex: none; max-width: 62%; display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
    padding: 7px 12px; border-radius: var(--r-full); border: 1px solid var(--hair); background: var(--mat-thin);
    color: var(--ink-2); font-size: var(--fs-foot); cursor: pointer; text-align: left;
    transition: background-color var(--dur-med) var(--ease-out), color var(--dur-med) linear, border-color var(--dur-med) linear; }
  .sess-tab.on { background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 600; }
  .sess-tab .cap { font-size: 11px; }
  .ring { position: relative; width: 96px; height: 96px; flex: none; }
  .ring-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 1px; }
  .ring-label b { font-size: 20px; }
  .stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--s3); }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat b { font-weight: 680; }
  .stat i { font-style: normal; font-size: var(--fs-sub); color: var(--ink-3); margin-left: 3px; }
  .done-box { display: flex; align-items: center; gap: var(--s3); padding: var(--s4);
    background: var(--green-soft); border-radius: var(--r-md); }
  .done-box b { font-size: var(--fs-callout); color: var(--green); }
  .tick { width: 44px; height: 44px; border-radius: var(--r-full); background: var(--green); color: #fff;
    display: flex; align-items: center; justify-content: center; animation: pop 420ms var(--ease-out); }
  @keyframes pop { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .rank { width: 26px; height: 26px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
    font-size: var(--fs-foot); font-weight: 700; background: var(--hair); color: var(--ink-2); }
  .rank.top { background: var(--accent-soft); color: var(--accent); }
  .bar { width: 74px; height: 7px; border-radius: 4px; background: var(--hair); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 4px;
    background: linear-gradient(90deg, var(--accent), var(--purple)); transition: width var(--dur-slow) var(--ease-out); }
  .loc-box { display: flex; align-items: center; gap: 10px; color: var(--accent); }
  .loc-box b { color: var(--ink); font-size: var(--fs-sub); }
  .avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
  .spin { width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.45);
    border-top-color: #fff; animation: sp 700ms linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .tick { animation: none; } }
  `,
  setup() {
    const sessions = ref([]);
    const activeId = ref(0);
    const session = computed(() => sessions.value.find((s) => s.id === activeId.value) || sessions.value[0] || null);

    function pickSession(id) { activeId.value = id; haptic(6); }
    const stats = ref(store.stats || {});
    const ranking = ref([]);
    const recent = ref([]);
    const loading = ref(true);
    const busy = ref(false);
    const note = ref("");
    const now = ref(Date.now());
    const geo = ref({ state: "idle", lat: 0, lng: 0, message: "" });
    const myAvatar = computed(() => (store.user && store.user.avatar ? mediaUrl(store.user.avatar) : ""));
    const geoText = computed(() => {
      if (geo.value.state === "ok") return "已定位";
      if (geo.value.state === "busy") return "定位中…";
      if (geo.value.state === "err") return "重新定位";
      return "获取定位";
    });

    function locate() {
      geo.value = { state: "busy", lat: 0, lng: 0, message: "" };
      return deviceLocation({ timeout: 15000 }).then(
        (pos) => {
          geo.value = { state: "ok", lat: pos.lat, lng: pos.lng, message: "" };
          haptic(10);
          return geo.value;
        },
        (err) => {
          geo.value = { state: "err", lat: 0, lng: 0, message: err.message || "定位失败" };
          toast(err.message || "定位失败", "warn");
          return null;
        });
    }

    function openAnnouncements() {
      const list = store.announcements || [];
      if (!list.length) { toast("暂时还没有公告", "info"); return; }
      store.announcePopup = list.slice(0, 10);
      haptic(6);
    }

    const WEEK0 = new Date(2026, 8, 1);
    const todayText = computed(() => {
      const d = new Date();
      const names = ["日", "一", "二", "三", "四", "五", "六"];
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${names[d.getDay()]}`;
    });
    const weekNo = computed(() => Math.max(1, Math.floor((Date.now() - WEEK0.getTime()) / 604800000) + 1));
    const greeting = computed(() => {
      const h = new Date().getHours();
      if (h < 6) return "夜深了";
      if (h < 11) return "早上好";
      if (h < 14) return "中午好";
      if (h < 18) return "下午好";
      return "晚上好";
    });
    const initial = computed(() => (store.user?.name || "?").slice(0, 1));
    const avatarStyle = computed(() => (store.user?.color ? { background: store.user.color } : {}));
    const mine = computed(() => session.value?.mine || null);
    const ringStyle = computed(() => ({ "--p": session.value ? session.value.present / Math.max(1, session.value.total) : 0 }));
    const ringOffset = computed(() => {
      const total = Math.max(1, session.value?.total || 1);
      const ratio = Math.min(1, (session.value?.present || 0) / total);
      return (251.2 * (1 - ratio)).toFixed(1);
    });
    const statusChip = computed(() => {
      if (!session.value) return { text: "无", cls: "" };
      if (mine.value) return statusOf(mine.value.status);
      const ends = session.value.ends_at;
      if (session.value.status !== "open" || (ends && now.value / 1000 > ends)) return { text: "已结束", cls: "chip-orange" };
      return { text: "进行中", cls: "chip-accent" };
    });

    function statusOf(status) {
      return {
        present: { text: "已签到", cls: "chip-green" },
        late: { text: "迟到", cls: "chip-orange" },
        leave: { text: "请假", cls: "chip" },
        absent: { text: "缺勤", cls: "chip-red" },
      }[status] || { text: "未签到", cls: "" };
    }

    async function load() {
      try {
        const [active, board, me] = await Promise.all([
          api("/api/sign/active"),
          api("/api/stats/class"),
          api("/api/sign/mine"),
        ]);
        sessions.value = active.sessions && active.sessions.length ? active.sessions : (active.session ? [active.session] : []);
        if (!sessions.value.some((s) => s.id === activeId.value)) activeId.value = sessions.value.length ? sessions.value[0].id : 0;
        ranking.value = (board.ranking || []).map((row, index) => ({ ...row, rank: index + 1 })).slice(0, 8);
        stats.value = me.stats || {};
        store.stats = stats.value;
        recent.value = (me.stats?.recent || []).slice(0, 4);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        loading.value = false;
      }
    }

    async function doSign() {
      if (!session.value || busy.value) return;
      busy.value = true;
      try {
        const body = { session_id: session.value.id, note: note.value };
        if (session.value.require_location) {
          const point = geo.value.state === "ok" ? geo.value : await locate();
          if (!point || point.state !== "ok") {
            toast(geo.value.message || "本次签到需要定位", "warn");
            busy.value = false;
            return;
          }
          body.lat = point.lat;
          body.lng = point.lng;
        }
        const res = await api("/api/sign/in", { method: "POST", body });
        session.value = res.session;
        haptic(res.late ? [12, 50, 12] : 18);
        toast(res.session.status_text || "签到成功", res.late ? "warn" : "ok");
        await load();
      } catch (err) {
        toast(err.message, "error");
        haptic(30);
      } finally {
        busy.value = false;
      }
    }

    async function askLeave() {
      const ok = await confirmDialog("确定要请假吗？老师会在名单里看到你的请假记录。", { okText: "提交请假" });
      if (!ok) return;
      try {
        const res = await api("/api/sign/leave", { method: "POST", body: { session_id: session.value.id, note: note.value } });
        session.value = res.session;
        toast("已提交请假", "ok");
        await load();
      } catch (err) {
        toast(err.message, "error");
      }
    }

    function showDetail() { navigate("/records?session=" + session.value.id); }

    let stop = null;
    let clockTimer = 0;
    let stops = [];
    onMounted(() => {
      load();
      stop = onWs("chat.new", () => {});
      /* 场次发布 / 有人签到 / 场次被改，都立刻重拉，不用手动刷新 */
      stops.push(onWs("sign.new", () => { load(); haptic(6); toast("有新的签到发布", "info", 4000); }));
      stops.push(onWs("sign.update", () => { load(); }));
      /* 根路径/我的页不注册滑动处理器，交给全局分页器（否则会吞掉左右滑动） */
      clockTimer = window.setInterval(() => { now.value = Date.now(); }, 30000);
      window.addEventListener("focus", () => load());
      document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
    });
    onUnmounted(() => { if (stop) stop(); stops.forEach((fn) => fn && fn()); clearInterval(clockTimer); });

    return { session, sessions, activeId, pickSession, stats, ranking, recent, loading, busy, note, mine, initial, avatarStyle, myAvatar,
             ringStyle, ringOffset, statusChip, statusOf, fmtTime, greeting, todayText, weekNo, geo, geoText,
             load, doSign, askLeave, showDetail, navigate, locate, openAnnouncements, mediaUrl, store };
  },
}));
