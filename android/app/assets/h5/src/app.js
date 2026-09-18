// Root component: boot, tab bar, toasts, global confirm dialog, 公告弹窗, 左右滑动切换。
import {
  createApp, ref, computed, onMounted, watch, nextTick,
  store, api, setToken, startRouter, currentView, navigate, route,
  wsConnect, onWs, toast, haptic, resolveSwipe, resolveBack, viewFor, waitServer,
  loadAnnouncements, ackAnnouncements, isApp, confirmDialog,
} from "./ui.js";
import { Icon } from "./icons.js";

import "./views/login.js";
import "./views/home.js";
import "./views/records.js";
import "./views/chat.js";
import "./views/games.js";
import "./views/profile.js";
import "./views/admin.js";
import "./views/game-board.js";
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
    const paneShift = ref(0);        // 提交动画期间整体位移（-1/0/1 屏）
    const paneAnim = ref(false);     // 是否启用 transform 过渡
    const dragging = ref(false);
    const hostEl = ref(null);
    const paneEls = ref([]);
    let dragPx = 0;                  // 拖动位移：故意不做成响应式，直接写 DOM，避免每帧重渲染
    let gesture = null;
    let releaseTimer = 0;

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

    /** 拖动时直接写 DOM（不触发 Vue 重渲染），保证 60fps 跟手 */
    function applyPanes() {
      const width = hostWidth();
      const els = paneEls.value || [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!el) continue;
        const off = Number(el.dataset.offset || 0);
        const x = Math.round((off - paneShift.value) * width + dragPx);
        el.style.transform = Math.abs(x) < 0.5 ? "" : "translate3d(" + x + "px,0,0)";
      }
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
      dragPx = 0;
      paneShift.value = 0;
      paneAnim.value = false;
      dragging.value = false;
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
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        if (Math.abs(dx) <= Math.abs(dy) * 1.2) {
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
      const target = neighborPath(g.dir);
      const fast = Math.abs(g.v) > 0.3 && Math.abs(dx) > 30;
      const commit = !!target && !g.edge && (Math.abs(dx) > Math.min(104, hostWidth() * 0.24) || fast);
      if (window.__swipeLog) window.__swipeLog.push("end:" + Math.round(dx) + ":commit=" + commit + ":target=" + target);
      if (!commit) {
        dragging.value = false;
        paneAnim.value = true;
        dragPx = 0;
        applyPanes();
        setTimeout(() => { if (!gesture) { paneAnim.value = false; preMount(); } }, 360);
        return;
      }
      dragging.value = false;
      paneShift.value = g.dir;
      dragPx = 0;
      paneAnim.value = true;
      applyPanes();
      haptic(8);
      releaseTimer = setTimeout(() => {
        releaseTimer = 0;
        paneShift.value = 0;
        paneAnim.value = false;
        navigate(target, false, g.dir);
        dragPx = 0;
        nextTick(applyPanes);
        preMount();
      }, 360);
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

    function tabClick(target) {
      const list = tabs.value;
      const from = list.findIndex((t) => t.path === activeTab.value);
      const to = list.findIndex((t) => t.path === target.path);
      if (from >= 0 && to >= 0 && to !== from) store.navDir = to > from ? 1 : -1;
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
             checkUpdate, runUpdate, dismissUpdate, installedCode };
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

      <nav class="tabbar" v-if="store.user && !isLogin">
        <a v-for="t in tabs" :key="t.path" :href="'#' + t.path" :class="{ on: activeTab === t.path }" @click="tabClick(t)">
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
          当前版本 v{{ installedCode }}，更新包 {{ Math.max(1, Math.round((store.updateInfo.size || 0) / 1024)) }} KB。
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
app.config.globalProperties.$route = route;
app.config.globalProperties.$store = store;
app.mount("#app");
