// Root component: boot, tab bar, toasts, global confirm dialog, 公告弹窗, 左右滑动切换。
import {
  createApp, ref, computed, onMounted, watch, nextTick,
  store, api, setToken, startRouter, currentView, navigate, route,
  wsConnect, onWs, toast, haptic, resolveSwipe, resolveBack, viewFor, waitServer,
  loadAnnouncements, ackAnnouncements, isApp, confirmDialog,
} from "./ui.js";
import { Icon } from "./icons.js";
import { MatchChat } from "./matchchat.js";

import "./views/login.js";
import "./views/home.js";
import "./views/records.js";
import "./views/chat.js";
import "./views/games.js";
import "./views/profile.js";
import "./views/changelog.js";
import "./views/admin.js";
import "./views/game-board.js";
import "./views/game-xiangqi.js";
import "./views/game-werewolf.js";
import "./views/game-draw.js";
import "./views/game-bomb.js";
import "./views/game-2048.js";
import "./views/game-mine.js";
import "./views/notfound.js";

const TABS = [
  { path: "/", label: "签到", icon: "checkCircle" },
  { path: "/chat", label: "讨论", icon: "chat" },
  { path: "/games", label: "游戏", icon: "game" },
  { path: "/me", label: "我的", icon: "user" },
];

function fmtWhen(ts) {
  const d = new Date((ts || 0) * 1000);
  return (d.getMonth() + 1) + " 月 " + d.getDate() + " 日 " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

const Root = {
  components: { Icon },
  setup() {
    const booting = ref(true);
    const view = computed(() => currentView());
    const isLogin = computed(() => route.path === "/login");
    const isStaff = computed(() => !!store.user && ["admin", "committee", "study"].includes(store.user.role));
    const tabs = computed(() => {
      const list = TABS.slice();
      if (isStaff.value) list.push({ path: "/admin", label: "管理", icon: "shield" });
      return list;
    });
    const activeTab = computed(() => {
      const p = route.path;
      if (p === "/") return "/";
      const hit = tabs.value.find((t) => t.path !== "/" && p.startsWith(t.path));
      return hit ? hit.path : "";
    });
    const tabHidden = computed(() => {
      const p = route.path;
      if (p === "/login") return true;
      return p.startsWith("/games/");
    });
    const slideName = computed(() => (store.navDir > 0 ? "page-slide-left" : "page-slide-right"));

    /* ------------------------------------------------------- 观战弹幕
       观战同学在"对局讨论"里发的话，会以弹幕飘过正在比赛的玩家屏幕。
       只在"我在座位上 + 本局正在进行"时才飘，层本身 pointer-events:none，不影响操作。 */
    const danmaku = ref([]);
    let danmakuSeq = 0;
    let liveRoom = null;

    function noteLiveRoom(msg) { if (msg && msg.room) liveRoom = msg.room; }

    function fanOut(chat) {
      if (!chat || !chat.spec) return;                       // 只有观战者的发言飘弹幕
      const uid = store.user && store.user.id;
      if (!uid || !liveRoom || !liveRoom.started || liveRoom.finished) return;
      if (!(liveRoom.players || []).some((p) => p.uid === uid)) return;
      const text = String(chat.text || "").slice(0, 60);
      if (!text) return;
      const id = ++danmakuSeq;
      danmaku.value.push({ id, name: chat.name || "观战", text, lane: id % 3 });
      while (danmaku.value.length > 6) danmaku.value.shift();
      setTimeout(() => { danmaku.value = danmaku.value.filter((d) => d.id !== id); }, 12000);
    }

    /* ------------------------------------------------------- 版本检查 */
    function installedCode() {
      try {
        if (!isApp() || !window.ClassCheckIn) return 0;
        const raw = window.ClassCheckIn.versionCode;
        const value = typeof raw === "function" ? raw.call(window.ClassCheckIn) : raw;
        const num = parseInt(value, 10);
        return Number.isFinite(num) && num > 0 ? num : 0;
      } catch (err) {
        return 0;
      }
    }
    async function checkUpdate(silent) {
      const code = installedCode();
      if (!code) return;
      try {
        const info = await api("/api/app/version", { query: "platform=h5&code=" + code });
        const latest = Number(info.version_code || 0);
        if (!info.has_update || latest <= code) {
          if (!silent) toast("已是最新版本 v" + code, "ok");
          return;
        }
        store.updateInfo = info;
      } catch (err) {
        if (!silent) toast("检查更新失败：" + err.message, "warn");
      }
    }
    async function runUpdate() {
      const info = store.updateInfo;
      store.updateInfo = null;
      if (!info) return;
      if (window.ClassCheckIn && window.ClassCheckIn.updateH5) {
        window.ClassCheckIn.updateH5(info.url, String(info.version_code), info.version_name || "");
        toast("正在下载更新 " + Math.round((info.size || 0) / 1024) + " KB…", "info", 4000);
      } else {
        toast("当前环境不支持自动更新，请刷新页面", "warn");
      }
    }
    function dismissUpdate() {
      store.updateInfo = null;
    }

    async function boot() {
      if (isApp()) await waitServer(2500);   // 等壳注入服务器地址，否则冷启动会误判未登录
      try {
        const config = await api("/api/config");
        store.settings = config;
      } catch (err) { /* offline friendly */ }
      if (store.token) {
        try {
          const me = await api("/api/me");
          store.user = me.user;
          store.stats = me.stats;
          store.points = me.points || null;
          store.alias = me.alias;
          wsConnect();
          await loadAnnouncements();
        } catch (err) {
          // 只有服务端明确说没登录（401/403）才清掉登录态，断网时保留
          if (!err || err.status === 401 || err.status === 403) setToken("");
          else if (err && err.message) toast("网络不太好，稍后会自动重试", "warn", 2500);
        }
      }
      booting.value = false;
      if (store.user && route.path === "/login") navigate("/", true);
      else if (!store.user && route.path !== "/login") navigate("/login", true);
      if (isApp()) checkUpdate(true);
    }

    // 安卓壳：系统返回键先交给前端处理，返回 false 表示"可以退出应用了"
    const PARENT = { "/chat": "/", "/games": "/", "/me": "/", "/admin": "/", "/records": "/" };
    window.__androidBack = () => {
      const path = route.path;
      if (path === "/login") return false;
      const hook = resolveBack(path);
      if (hook) { hook(); return true; }
      if (PARENT[path]) { navigate(PARENT[path], false, -1); return true; }
      if (path.startsWith("/games/")) { navigate("/games", false, -1); return true; }
      if (path.startsWith("/chat/")) { navigate("/chat", false, -1); return true; }
      return false;
    };

    /* ---------------------------------------- 左右滑动（跟手分页，微信式） */
    const paneOpen = ref(false);     // 拖动时才挂载左右相邻页，平时零开销
    const navTo = ref(null);         // 点底栏时的滑动过渡 { path, dir }
    const paneShift = ref(0);        // 提交动画期间整体位移（-1/0/1 屏）
    const paneAnim = ref(false);     // 是否启用 transform 过渡
    const dragging = ref(false);
    const hostEl = ref(null);
    const paneEls = ref([]);
    let dragPx = 0;                  // 拖动位移：故意不做成响应式，直接写 DOM，避免每帧重渲染
    let gesture = null;
    let releaseTimer = 0;
    /* 点底栏滑动的"还作数吗"标记。
       注意不能用 navTo.value !== jump 来判断：ref() 会把对象深度包成 Proxy，
       拿到的永远不是原来那个对象，比较必然为真 —— 滑动的后半段会被整段吃掉。 */
    let navToken = 0;

    const tabPaths = computed(() => tabs.value.map((t) => t.path));
    const paged = computed(() => !!store.user && tabPaths.value.indexOf(route.path) >= 0);

    const panes = computed(() => {
      const list = tabs.value;
      const index = list.findIndex((t) => t.path === route.path);
      const out = [];
      for (let d = -1; d <= 1; d++) {
        const item = index >= 0 ? list[index + d] : null;
        out.push({
          key: item ? item.path : "ghost" + d,
          offset: d,
          view: item && (d === 0 || paneOpen.value) ? viewFor(item.path) : null,
        });
      }
      /* 点底栏时把目标页临时放进相邻格子，这样它能"滑"进来而不是"跳"过来 */
      const jump = navTo.value;
      if (jump) {
        const slot = out.find((p) => p.offset === jump.dir);
        if (slot && slot.key !== jump.path) {
          slot.key = jump.path;   // 用路径本身当 key：滑完切路由时能被复用，不重建
          slot.view = viewFor(jump.path);
        }
      }
      return out;
    });

    function hostWidth() {
      const w = hostEl.value ? hostEl.value.clientWidth : 0;
      return w > 0 ? w : Math.max(320, window.innerWidth || 375);
    }

    function tone(x) {
      // 位移为 0 时清掉 transform，避免把页面里的 fixed 元素变成"相对页面定位"
      return Math.abs(x) < 0.5 ? "" : "transform:translate3d(" + Math.round(x) + "px,0,0);";
    }

    function paneStyle(p) {
      return tone((p.offset - paneShift.value) * hostWidth() + dragPx);
    }

    /** 拖动时直接写 DOM（不触发 Vue 重渲染），保证 60fps 跟手。
        每次现查 DOM 而不是用 ref 数组：列表增删/复用后 ref 数组的顺序不可靠，
        但 data-offset 永远是对的。 */
    function applyPanes() {
      const host = hostEl.value;
      if (!host) return;
      const width = hostWidth();
      const els = host.querySelectorAll(".pager-pane");
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const off = Number(el.dataset.offset || 0);
        const x = Math.round((off - paneShift.value) * width + dragPx);
        el.style.transform = Math.abs(x) < 0.5 ? "" : "translate3d(" + x + "px,0,0)";
      }
    }

    /* 动画必须先"落地"再改位移，这是整页平滑的关键：
       如果在同一个 tick 里既挂 transition 又改 transform，浏览器会把两件事
       合并成一次样式计算（新建出来的元素更是如此），结果就是直接跳到终点 ——
       用户看到的就是"咔一下"。这里读一次 offsetWidth 强制回流，
       让浏览器先记住"旧位移 + 过渡已生效"，之后写新位移就一定会产生过渡。 */
    function beginAnim() {
      paneAnim.value = true;
      const host = hostEl.value;
      if (!host) return;
      if (!host.classList.contains("pager-anim")) host.classList.add("pager-anim");
      void host.offsetWidth;
    }

    function endAnim() {
      paneAnim.value = false;
      const host = hostEl.value;
      if (host) host.classList.remove("pager-anim");
    }

    /* 过渡时长要和 CSS 里的 .pager-anim .pager-pane 对齐，留一点余量等它彻底停稳 */
    const PANE_MS = 340;
    function animWait() {
      return preferMotion() ? PANE_MS + 40 : 40;
    }

    function neighborPath(dir) {
      const list = tabs.value;
      const index = list.findIndex((t) => t.path === route.path);
      if (index < 0) return null;
      const item = list[index + dir];
      return item ? item.path : null;
    }

    function swipeBlocked(target) {
      if (!target || !target.closest) return true;
      if (store.confirm || store.announcePopup || store.updateInfo || store.sheet) return true;
      return !!target.closest("input, textarea, select, canvas, [data-no-swipe], .tabbar, .scrim, .modal, .sheet");
    }

    /* 相邻页提前在空闲时挂载好：手势一开始就有 DOM，不会在拖动中现挂组件掉帧 */
    let idleTimer = 0;
    function preMount() {
      if (idleTimer || paneOpen.value) return;
      const run = () => {
        idleTimer = 0;
        if (gesture) { preMount(); return; }
        if (paged.value) { paneOpen.value = true; nextTick(applyPanes); }
      };
      if (window.requestIdleCallback) idleTimer = window.requestIdleCallback(run, { timeout: 700 });
      else idleTimer = setTimeout(run, 260);
    }

    function resetPager() {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
      navToken++;
      navTo.value = null;
      dragPx = 0;
      paneShift.value = 0;
      dragging.value = false;
      endAnim();
      nextTick(applyPanes);
      if (paged.value) preMount();
    }

    function onTouchStart(ev) {
      if (releaseTimer) resetPager();
      if (window.__swipeLog) window.__swipeLog.push("start:" + (ev.target && ev.target.tagName) + ":" + ev.touches.length);
      if (ev.touches.length !== 1) { gesture = null; return; }
      const t = ev.touches[0];
      gesture = { x: t.clientX, y: t.clientY, mode: null, bad: swipeBlocked(ev.target),
                  inner: null, dir: 0, edge: false, dx: 0, last: t.clientX, lastT: Date.now(), v: 0 };
      dragPx = 0;
    }

    function onTouchMove(ev) {
      const g = gesture;
      if (!g || g.bad || ev.touches.length !== 1) {
        if (window.__swipeLog && g && g.bad && g.mode === null) {
          g.mode = "bad";
          window.__swipeLog.push("blocked:" + (ev.target && ev.target.tagName) + "." + (ev.target && ev.target.className));
        }
        return;
      }
      const t = ev.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      const now = Date.now();
      if (now > g.lastT) g.v = (t.clientX - g.last) / (now - g.lastT);
      g.last = t.clientX;
      g.lastT = now;
      if (g.mode === null) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        if (Math.abs(dx) <= Math.abs(dy) * 1.15) {
          g.mode = "y";
          if (window.__swipeLog) window.__swipeLog.push("vertical:" + Math.round(dx) + ":" + Math.round(dy));
          return;
        }
        g.dir = dx < 0 ? 1 : -1;
        // 页面内还有分页（游戏的联机/单机、管理里的分栏）时先交给它，到头了才由底栏分页接管
        const reg = resolveSwipe(route.path);
        if (reg && (!reg.canGo || reg.canGo(g.dir))) {
          g.inner = reg.handler;
        } else if (!paged.value) {
          g.mode = "no";
          return;
        } else {
          g.edge = !neighborPath(g.dir);
          if (!g.edge && !paneOpen.value) { paneShift.value = 0; paneOpen.value = true; nextTick(applyPanes); }
        }
        g.mode = "x";
        dragging.value = true;
        if (window.__swipeLog) window.__swipeLog.push("engage:" + Math.round(dx) + ":inner=" + !!g.inner + ":edge=" + g.edge);
        haptic(3);
      }
      if (g.mode !== "x") return;
      g.dx = dx;
      if (g.inner) {
        g.inner({ phase: "move", dir: g.dir, dx: dx, width: hostWidth(), velocity: g.v });
        return;
      }
      dragPx = g.edge ? dx * 0.28 : dx;
      applyPanes();
    }

    function finishInner(g, phase) {
      dragging.value = false;
      g.inner({ phase: phase, dir: g.dir, dx: g.dx, width: hostWidth(), velocity: g.v });
      dragPx = 0;
    }

    function onTouchEnd() {
      const g = gesture;
      gesture = null;
      if (!g || g.mode !== "x") {
        dragging.value = false;
        dragPx = 0;
        applyPanes();
        return;
      }
      if (g.inner) { finishInner(g, Math.abs(g.dx) > 10 ? "end" : "cancel"); return; }
      const dx = dragPx;
      /* 方向按松手时的实际位移算：中途反向也不会切错边 */
      const dir = dx < 0 ? 1 : -1;
      g.dir = dir;
      const target = neighborPath(dir);
      const width = hostWidth();
      const fast = Math.abs(g.v) > 0.4 && Math.abs(dx) > 18;
      /* 微信的手感：慢慢拖要过 1/5 屏，快速甩一下 18px 就够 */
      const commit = !!target && !g.edge && (Math.abs(dx) > Math.min(72, width * 0.2) || fast);
      if (window.__swipeLog) window.__swipeLog.push("end:" + Math.round(dx) + ":commit=" + commit + ":target=" + target);
      if (!commit) {
        dragging.value = false;
        beginAnim();               // 过渡先落地（此刻 DOM 还停在手指位置）
        dragPx = 0;                // 再改位移，于是有一段真正的回弹动画
        applyPanes();
        const wait = animWait();
        setTimeout(() => { if (!gesture) { endAnim(); preMount(); } }, wait);
        return;
      }
      dragging.value = false;
      beginAnim();                 // 过渡先落地（此刻 DOM 还停在手指位置）
      paneShift.value = dir;       // 再滑到目标页，页面是"走"过去的
      dragPx = 0;
      applyPanes();
      haptic(8);
      const wait = animWait();
      releaseTimer = setTimeout(() => {
        releaseTimer = 0;
        endAnim();
        paneShift.value = 0;
        dragPx = 0;
        navigate(target, false, dir);
        nextTick(applyPanes);
        preMount();
      }, wait);
    }

    window.__swipeState = () => ({
      gesture: gesture ? { bad: !!gesture.bad, mode: gesture.mode, edge: !!gesture.edge, dir: gesture.dir } : null,
      drag: Math.round(dragPx), shift: paneShift.value, open: paneOpen.value,
      path: route.path, activeTab: activeTab.value, paged: paged.value, panes: panes.value.length,
      width: hostWidth(), tabs: tabPaths.value,
      flags: { confirm: !!store.confirm, announce: !!store.announcePopup, update: !!store.updateInfo, sheet: !!store.sheet },
    });

    onMounted(() => {
      startRouter();
      boot();
      try {
        if (!window.CSS || !CSS.supports || !CSS.supports("overflow-x", "clip")) {
          document.documentElement.className += " no-clip";
        }
      } catch (err) { /* 老内核退化到可滚动裁切 */ }
      document.addEventListener("touchstart", onTouchStart, { passive: true });
      document.addEventListener("touchmove", onTouchMove, { passive: true });
      document.addEventListener("touchend", onTouchEnd, { passive: true });
      document.addEventListener("touchcancel", onTouchEnd, { passive: true });
      onWs("hello", (msg) => {
        store.online = msg.online || 0;
        if (msg.settings) store.settings = { ...store.settings, ...msg.settings };
      });
      onWs("presence", (msg) => {
        store.online = msg.count || 0;
        store.onlineUsers = msg.users || [];
      });
      /* 积分变化（联机结算 / 单机得分都由服务端推过来） */
      onWs("points", (msg) => {
        if (msg.points) store.points = msg.points;
        if (msg.delta) {
          toast(msg.delta > 0 ? "积分 +" + msg.delta : "积分 " + msg.delta,
                msg.delta > 0 ? "ok" : "warn", 3200);
          haptic(msg.delta > 0 ? [10, 30, 10] : 20);
        }
      });
      onWs("game.entered", noteLiveRoom);
      onWs("game.state", noteLiveRoom);
      onWs("game.update", noteLiveRoom);
      onWs("game.over", noteLiveRoom);
      onWs("game.left", () => { liveRoom = null; });
      onWs("game.chat", (msg) => fanOut(msg.chat));
      onWs("announce", (msg) => {
        const item = { id: msg.id, content: msg.content, created_at: msg.created_at, author: msg.author || "班级公告", read: false };
        store.announcements = [item].concat(store.announcements || []);
        store.unreadAnnounce = (store.unreadAnnounce || 0) + 1;
        toast("公告：" + msg.content, "info", 6000);
        haptic([10, 40, 10]);
        loadAnnouncements();
      });
    });

    watch(() => route.path, (path) => {
      if (!booting.value && !store.user && path !== "/login") navigate("/login", true);
      window.scrollTo({ top: 0, behavior: "instant" });
    });

    // 路由或登录态变化后，空闲时把左右相邻页挂载好
    watch(() => [route.path, paged.value], () => { preMount(); }, { flush: "post" });

    /* 点底栏也走一次滑动，而不是"啪"地换页。
       目标页临时挂到相邻格子 -> 整条轨道滑一格 -> 滑完再真正换路由。 */
    function tabClick(target, ev) {
      const list = tabs.value;
      const from = list.findIndex((t) => t.path === activeTab.value);
      const to = list.findIndex((t) => t.path === target.path);
      if (from < 0 || to < 0 || to === from) return;
      const dir = to > from ? 1 : -1;
      store.navDir = dir;
      const adjacent = Math.abs(to - from) === 1;
      if (!adjacent || !paged.value || gesture || !paneOpen.value || !preferMotion()) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      dragging.value = false;
      paneShift.value = 0;
      const my = ++navToken;
      navTo.value = { path: target.path, dir: dir };
      nextTick(() => {
        applyPanes();              // 目标页刚挂进来，先按"旁边一格"定位好
        /* 等一帧、让新页面先完整渲染好，再开始滑。
           否则"首次挂载 + 首次布局"的开销会全压在动画第一帧上，
           看起来就是滑到一半卡一下。 */
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (gesture || my !== navToken) return;
          beginAnim();             // 过渡落地 + 强制回流（停在旁边一格）
          paneShift.value = dir;   // 现在再滑过来，用户看到的是真正的一格位移
          applyPanes();
          const wait = animWait();
          releaseTimer = setTimeout(() => {
            releaseTimer = 0;
            if (my !== navToken) return;
            navTo.value = null;
            endAnim();
            paneShift.value = 0;
            navigate(target.path, false, dir);
            nextTick(applyPanes);
            preMount();
          }, wait);
        }));
      });
    }

    function preferMotion() {
      try { return !window.matchMedia || !window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
      catch (err) { return true; }
    }

    function resolveConfirm(yes) {
      const dialog = store.confirm;
      if (!dialog) return;
      store.confirm = null;
      if (dialog.resolve) dialog.resolve(yes);
    }

    function closeAnnounce() {
      const ids = (store.announcePopup || []).map((item) => item.id);
      store.announcePopup = null;
      ackAnnouncements(ids);
      haptic(8);
    }

    function openAnnounce(item) {
      store.announcePopup = [item];
    }

    return { booting, view, isLogin, tabs, activeTab, tabHidden, slideName, store, hostEl, paneEls, paneAnim, dragging, paged, panes, paneStyle,
             resolveConfirm, closeAnnounce, openAnnounce, fmtWhen, tabClick,
             checkUpdate, runUpdate, dismissUpdate, installedCode, danmaku };
  },
  template: `
  <div class="app" :class="{ 'tab-hidden': tabHidden }">
    <div v-if="booting" class="boot"><div class="boot-mark"></div></div>

    <template v-else>
      <div class="page-host" ref="hostEl" :class="{ 'pager-anim': paneAnim, 'pager-live': dragging }">
        <div v-if="paged" class="pager-track">
          <div v-for="p in panes" :key="p.key" ref="paneEls" :data-offset="p.offset" class="pager-pane"
               :class="{ cur: p.offset === 0 }" :style="paneStyle(p)">
            <component v-if="p.view" :is="p.view" />
          </div>
        </div>
        <Transition v-else :name="slideName" mode="out-in">
          <component :is="view" v-if="view" :key="$route.path" />
          <div v-else class="page-plain center" style="min-height:60dvh">页面不存在</div>
        </Transition>
      </div>

      <div class="danmaku-layer" aria-hidden="true">
        <div v-for="d in danmaku" :key="d.id" class="danmaku" :style="{ top: (14 + d.lane * 34) + 'px' }">
          <b>{{ d.name }}</b><span>{{ d.text }}</span>
        </div>
      </div>

      <nav class="tabbar" v-if="store.user && !isLogin">
        <a v-for="t in tabs" :key="t.path" :href="'#' + t.path" :class="{ on: activeTab === t.path }" @click="tabClick(t, $event)">
          <span class="pill"></span>
          <Icon :n="t.icon" :size="25" />
          <span>{{ t.label }}</span>
        </a>
      </nav>
    </template>

    <div class="toasts">
      <TransitionGroup name="toast-list">
        <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.message }}</div>
      </TransitionGroup>
    </div>

    <Transition name="fade">
      <div v-if="store.confirm" class="scrim" @click="resolveConfirm(false)"></div>
    </Transition>
    <Transition name="mat">
      <div v-if="store.confirm" class="modal" style="top:auto;bottom:calc(var(--safe-b) + 16px);height:auto">
        <h3 class="t3">{{ store.confirm.title || '确认操作' }}</h3>
        <p class="sub mt3">{{ store.confirm.message }}</p>
        <div class="row gap2 mt5">
          <button class="btn grow" @click="resolveConfirm(false)">取消</button>
          <button class="btn grow" :class="store.confirm.danger ? 'btn-danger' : 'btn-primary'" @click="resolveConfirm(true)">
            {{ store.confirm.okText || '确定' }}
          </button>
        </div>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="store.updateInfo" class="scrim"></div>
    </Transition>
    <Transition name="mat">
      <div v-if="store.updateInfo" class="modal glass glass-thick">
        <h3 class="t3">发现新版本 v{{ store.updateInfo.version_code }}</h3>
        <p class="sub mt3">
          当前版本 v{{ installedCode() }}，更新包 {{ Math.max(1, Math.round((store.updateInfo.size || 0) / 1024)) }} KB。
        </p>
        <p v-if="store.updateInfo.notes" class="cap mt2">{{ store.updateInfo.notes }}</p>
        <div class="row gap2 mt5">
          <button class="btn grow" @click="dismissUpdate">稍后</button>
          <button class="btn grow btn-primary" @click="runUpdate">立即更新</button>
        </div>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="store.announcePopup && store.announcePopup.length" class="scrim"></div>
    </Transition>
    <Transition name="mat">
      <div v-if="store.announcePopup && store.announcePopup.length" class="modal announce-modal glass glass-thick">
        <span class="announce-badge"><Icon n="megaphone" :size="18" /></span>
        <h3 class="t3">班级公告</h3>
        <div class="announce-list">
          <div v-for="item in store.announcePopup" :key="item.id" class="announce-item">
            <p class="announce-text">{{ item.content }}</p>
            <p class="cap mt2">{{ item.author || '管理员' }} · {{ fmtWhen(item.created_at) }}</p>
          </div>
        </div>
        <button class="btn btn-primary btn-block mt5" @click="closeAnnounce">我知道了</button>
      </div>
    </Transition>
  </div>`,
};

const app = createApp(Root);
app.component("Icon", Icon);
app.component("MatchChat", MatchChat);
app.config.globalProperties.$route = route;
app.config.globalProperties.$store = store;
app.mount("#app");
