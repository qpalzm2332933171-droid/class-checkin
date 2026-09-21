// Tiny runtime shim: Vue re-export, view helper, router, store, api + ws clients.
import * as Vue from "../assets/vendor/vue.esm-browser.prod.js";

export const {
  createApp, ref, reactive, computed, watch, watchEffect, onMounted, onUnmounted,
  nextTick, defineComponent, h, Transition, TransitionGroup, KeepAlive, Teleport,
} = Vue;

/* ------------------------------------------------------------------ styles */
const STYLE_CACHE = new Set();
export function injectStyle(name, css) {
  if (STYLE_CACHE.has(name)) return;
  STYLE_CACHE.add(name);
  const tag = document.createElement("style");
  tag.dataset.view = name;
  tag.textContent = css;
  document.head.appendChild(tag);
}

export function defineView(name, options) {
  if (options.style) injectStyle(name, options.style);
  return defineComponent({ name, ...options });
}

/* ------------------------------------------------------------------ store */
function nativeSession() {
  try {
    if (window.__CHECKIN_TOKEN__) return String(window.__CHECKIN_TOKEN__);
  } catch (err) { /* ignore */ }
  try {
    const bridge = window.ClassCheckIn;
    if (bridge && typeof bridge.getSession === "function") return bridge.getSession() || "";
  } catch (err) { /* ignore */ }
  return "";
}

let savedToken = "";
try {
  savedToken = localStorage.getItem("checkin_token") || "";
} catch (err) {
  savedToken = "";
}
const scriptToken = nativeSession();   // 安卓壳里启动瞬间就能同步拿到，不依赖 localStorage
if (!savedToken) savedToken = scriptToken;
/* 自愈：任一存储里有登录态就补写到另一处，避免 WebView 清缓存或换版本目录后掉登录 */
if (savedToken) {
  try { localStorage.setItem("checkin_token", savedToken); } catch (err) { /* ignore */ }
  if (savedToken !== scriptToken) {
    try {
      const bootBridge = window.ClassCheckIn;
      if (bootBridge && typeof bootBridge.saveSession === "function") bootBridge.saveSession(savedToken);
    } catch (err) { /* ignore */ }
  }
}

export const store = reactive({
  token: savedToken,
  user: null,
  stats: null,
  points: null,          // { online, solo, total, wins, losses }
  settings: {},
  online: 0,
  onlineUsers: [],
  alias: "",
  route: "/",
  ready: false,
  toasts: [],
  sheet: null,
  profile: null,          // 个人主页浮窗 { uid, data, loading }
  navDir: 1,
  announcements: [],
  unreadAnnounce: 0,
  announcePopup: null,
  tabHidden: false,
});

export function setToken(token) {
  store.token = token || "";
  try {
    if (token) localStorage.setItem("checkin_token", token);
    else localStorage.removeItem("checkin_token");
  } catch (err) {
    /* file:// 下偶尔不可用，交给原生壳兜底 */
  }
  try {
    const bridge = window.ClassCheckIn;
    if (bridge && typeof bridge.saveSession === "function") {
      if (token) bridge.saveSession(token);
      else if (typeof bridge.clearSession === "function") bridge.clearSession();
    }
  } catch (err) {
    /* 网页端没有桥，忽略 */
  }
}

/* ------------------------------------------------------------------ router */
const ROUTES = {};
export function registerRoute(path, component) {
  ROUTES[path] = component;
}

export const route = reactive({ path: "/", query: {} });

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  route.path = path || "/";
  route.query = Object.fromEntries(new URLSearchParams(query || ""));
}

export function navigate(path, replace = false, dir = 0) {
  if (dir) store.navDir = dir;
  const target = "#" + path;
  if (location.hash === target) return;
  if (replace) {
    try {
      history.replaceState(null, "", target);
      parseHash();          // replaceState 不触发 hashchange，手动同步路由状态
      return;
    } catch (err) {
      /* 安卓壳以 file:// 加载时 replaceState 会被拦，退回直接改 hash */
    }
  }
  location.hash = target;
  parseHash();
}

export function currentView() {
  return ROUTES[route.path] || ROUTES["/404"] || null;
}

export function viewFor(path) {
  return ROUTES[path] || null;
}

export function startRouter() {
  window.addEventListener("hashchange", parseHash);
  parseHash();
}

/* ---------------------------------------------------------------- server
   H5 由浏览器打开时用同源地址；被安卓壳以 file:// 加载时由壳注入
   window.__CHECKIN_SERVER__，所有请求与 WebSocket 都指向它。 */
const SERVER_KEY = "checkin_server";

export function serverBase() {
  const injected = (typeof window !== "undefined" && window.__CHECKIN_SERVER__) || "";
  if (injected) {
    try { localStorage.setItem(SERVER_KEY, injected); } catch (err) { /* ignore */ }
    return injected.replace(/\/+$/, "");
  }
  let cached = "";
  try { cached = localStorage.getItem(SERVER_KEY) || ""; } catch (err) { cached = ""; }
  if (cached) return cached.replace(/\/+$/, "");
  if (location.protocol === "file:") return "";
  return location.origin;
}

/* 安卓壳是在 onPageFinished 里注入 __CHECKIN_SERVER__ 的，而冷启动时首屏 JS 一定早于它，
   不等待就会出现"刚打开 App 就被判定未登录"（需重新登录）。这里轮询等一小会儿。 */
export function waitServer(timeout) {
  if (serverBase()) return Promise.resolve(true);
  const limit = timeout || 2500;
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (serverBase()) return resolve(true);
      if (Date.now() - start > limit) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

export function serverHost() {
  return serverBase().replace(/^http/, "ws");
}

/* ------------------------------------------------------------------ api */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body, raw, query } = {}) {
  const url = new URL(path + (query ? "?" + query : ""), serverBase() || location.origin);
  const headers = {};
  if (store.token) headers.Authorization = "Bearer " + store.token;
  let payload;
  if (body instanceof Blob) {
    payload = body;
    headers["Content-Type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, { method, headers, body: payload });
  if (raw) {
    if (!resp.ok) throw new ApiError(resp.status, "请求失败");
    return resp;
  }
  let data = {};
  try {
    data = await resp.json();
  } catch (err) {
    data = {};
  }
  if (!resp.ok || data.ok === false) {
    if (resp.status === 401) logout(true);
    throw new ApiError(resp.status, data.error || "网络错误 (%d)" % resp.status);
  }
  return data;
}

export function logout(silent = false) {
  setToken("");
  store.user = null;
  wsClose();
  navigate("/login");
  if (!silent) toast("已退出登录");
}

/* ------------------------------------------------------------------ toast */
let toastSeq = 0;
export function toast(message, kind = "info", timeout = 2600) {
  const id = ++toastSeq;
  store.toasts.push({ id, message, kind });
  setTimeout(() => {
    const index = store.toasts.findIndex((t) => t.id === id);
    if (index >= 0) store.toasts.splice(index, 1);
  }, timeout);
}

export function haptic(pattern = 8) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (err) { /* ignore */ }
  }
}

export function confirmDialog(message, options = {}) {
  return new Promise((resolve) => {
    store.confirm = { message, resolve, ...options };
  });
}

/* --------------------------------------------------- 个人主页浮窗 */
/** 打开某人的个人主页卡片；下层页面完全不动。传自己的 id 会被忽略。 */
export async function openUserProfile(uid) {
  const id = Number(uid || 0);
  if (!id) return;
  if (store.user && store.user.id === id) return;   // 自己不用看自己的卡片
  store.profile = { uid: id, data: null, loading: true };
  haptic(6);
  try {
    const data = await api("/api/user/" + id + "/profile");
    if (store.profile && store.profile.uid === id) {
      store.profile = { uid: id, data: data.profile, loading: false };
    }
  } catch (err) {
    if (store.profile && store.profile.uid === id) store.profile = null;
    toast(err.message || "打不开这个人的主页", "error");
  }
}

export function closeUserProfile() {
  store.profile = null;
}

/* ------------------------------------------------------------------ websocket */
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 800;
const listeners = new Map();

export function onWs(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);
  return () => listeners.get(type).delete(handler);
}

function emit(type, payload) {
  const bucket = listeners.get(type);
  if (bucket) bucket.forEach((fn) => { try { fn(payload); } catch (err) { console.error(err); } });
  const wildcard = listeners.get("*");
  if (wildcard) wildcard.forEach((fn) => fn(payload));
}

export function wsConnect() {
  if (!store.token || (socket && socket.readyState <= 1)) return;
  const base = serverHost();
  const target = base ? base + "/ws" : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  socket = new WebSocket(`${target}?token=${encodeURIComponent(store.token)}&device=${isApp() ? "android" : "web"}`);
  socket.onopen = () => {
    reconnectDelay = 800;
    store.wsStatus = "open";
    emit("open", {});
  };
  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (err) { return; }
    store.lastPing = Date.now();
    emit(msg.t, msg);
  };
  socket.onclose = () => {
    store.wsStatus = "closed";
    socket = null;
    emit("close", {});
    if (store.token) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(wsConnect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 12000);
    }
  };
  socket.onerror = () => { store.wsStatus = "error"; };
}

/** 立刻重连（丢掉可能已经僵死的 socket）。从后台切回来时用。 */
export function wsReconnectNow() {
  reconnectDelay = 800;
  if (socket) {
    try { socket.close(); } catch (err) { /* ignore */ }
  } else {
    clearTimeout(reconnectTimer);
    wsConnect();
  }
}

/* 手机切后台会暂停 JS，socket 可能已经假死但浏览器还不知道。
   回到前台时先探一次活，5 秒没回应就重连。 */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !store.token) return;
    if (!socket || socket.readyState !== 1) { wsReconnectNow(); return; }
    try { socket.send(JSON.stringify({ t: "ping" })); } catch (err) { /* ignore */ }
    setTimeout(() => {
      if (Date.now() - (store.lastPing || 0) > 5000) wsReconnectNow();
    }, 5200);
  });
}

export function wsClose() {
  clearTimeout(reconnectTimer);
  if (socket) {
    const s = socket;
    socket = null;
    try { s.close(); } catch (err) { /* ignore */ }
  }
}

export function wsSend(obj) {
  if (!socket || socket.readyState !== 1) {
    toast("连接已断开，正在重连…", "warn");
    wsConnect();
    return false;
  }
  socket.send(JSON.stringify(obj));
  return true;
}

export function mediaUrl(path) {
  if (!path) return "";
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return serverBase() + path;
}

export function isApp() {
  if (/ClassCheckInApp/.test(navigator.userAgent)) return true;
  try { if (window.ClassCheckIn) return true; } catch (err) { /* ignore */ }
  return false;
}

/* ---------------------------------------------------------------- HTTPS
   浏览器只在"安全上下文"里给 navigator.geolocation：http:// 的页面直接拿不到，
   所以网页端要定位签到就只能走 HTTPS。配置在服务端（/api/config 的 https 字段）。 */
export function httpsInfo() {
  const cfg = store.settings || {};
  return cfg.https || { ready: false, origin: "", ca: "" };
}

/* 当前页面是 http 且服务端开了 HTTPS 时才给地址，其它情况返回空串 */
export function httpsOrigin() {
  const info = httpsInfo();
  if (!info.ready || !info.origin) return "";
  try {
    if (location.protocol !== "http:") return "";
  } catch (err) {
    return "";
  }
  return String(info.origin).replace(/\/+$/, "");
}

/* 安卓壳有原生定位，不需要也不该跳走 */
export function needHttps() {
  if (isApp()) return false;
  try {
    if (location.protocol !== "http:") return false;
  } catch (err) {
    return false;
  }
  if (window.isSecureContext !== false) return false;
  return !!httpsOrigin();
}

export function goHttps() {
  const origin = httpsOrigin();
  if (!origin) return false;
  location.href = origin + location.pathname + location.search + location.hash;
  return true;
}

/* ------------------------------------------------------- 设备定位
   优先用安卓壳的原生定位（HTTP 页面浏览器会禁用 navigator.geolocation），
   退回到浏览器定位（https / localhost 可用）。 */
export function deviceLocation(options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const bridge = window.ClassCheckIn;
    if (bridge && typeof bridge.requestLocation === "function") {
      const id = "loc" + Date.now() + Math.floor(Math.random() * 1000);
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (window.__onNativeLocation === handler) delete window.__onNativeLocation;
        reject(new Error("定位超时，请到信号好一点的地方再试"));
      }, opts.timeout || 15000);
      function handler(cbId, lat, lng, err) {
        if (cbId !== id || done) return;
        done = true;
        clearTimeout(timer);
        delete window.__onNativeLocation;
        if (err) reject(new Error(err));
        else if (!lat && !lng) reject(new Error("定位失败，请重试"));
        else resolve({ lat: Number(lat), lng: Number(lng), native: true });
      }
      window.__onNativeLocation = handler;
      try {
        bridge.requestLocation(id);
      } catch (err) {
        done = true;
        clearTimeout(timer);
        reject(new Error("调用原生定位失败"));
      }
      return;
    }
    if (!navigator.geolocation) {
      reject(new Error("设备不支持定位"));
      return;
    }
    if (window.isSecureContext === false) {
      reject(new Error(httpsOrigin()
        ? "浏览器只在 HTTPS 下给定位，点页面顶部的「去开启」切到 HTTPS 再试"
        : "网页端定位需要 HTTPS，请用安卓客户端尝试"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, native: false }),
      (err) => reject(new Error(err && err.code === 1 ? "定位权限被拒绝，请在系统设置里允许后重试" : "定位失败，请重试")),
      { enableHighAccuracy: true, timeout: opts.timeout || 12000, maximumAge: 30000 });
  });
}

/* ------------------------------------------------------------------ 手势
   视图可以注册自己的左右滑动处理（页面内的分页，比如游戏的联机/单机）：
     registerSwipe("/games", handler, (dir) => bool)
   handler({ phase, dir, dx, width })  phase: "move" | "end" | "cancel"
     dir: 1 = 手指向左（切到右边的页）, -1 = 手指向右（切到左边的页）
   canGo(dir) 返回 false 表示这一侧没有页面了 -> 交给外层底栏分页器继续拖整页。 */
export const swipeHandlers = new Map();
export function registerSwipe(path, handler, canGo) {
  swipeHandlers.set(path, { handler: handler, canGo: canGo || null });
  return () => swipeHandlers.delete(path);
}

export function resolveSwipe(path) {
  if (swipeHandlers.has(path)) return swipeHandlers.get(path);
  let best = null;
  let bestLen = -1;
  swipeHandlers.forEach((reg, key) => {
    if (key === "/" && path !== "/") return;   // 根路径不吞掉其它页面的滑动
    if (path.startsWith(key) && key.length > bestLen) {
      best = reg;
      bestLen = key.length;
    }
  });
  return best;
}

/* 分段控件（滑块）几何。
   三个坑都在这里解决：
   1. 绝对定位子元素的参照系是 padding box，所以要减掉 border 宽度；
   2. 导航条可以横向滚动（管理页 8 个分栏），getBoundingClientRect 是"视口坐标"，
      必须补回 scrollLeft，否则选中后面几项时滑块会整体偏掉一个滚动距离；
   3. 拖动时滑块要和内容同进度地滑到相邻按钮，所以按 progress 在相邻两个按钮之间插值。
   progress: 0 = 正好在高亮按钮上；1 = 正好在 dir 方向的相邻按钮上。 */
export function pillStyle(container, progress, dir) {
  if (!container) return "opacity:0";
  const btns = container.querySelectorAll("button");
  let index = -1;
  for (let i = 0; i < btns.length; i++) {
    if (btns[i].classList.contains("on")) { index = i; break; }
  }
  if (index < 0) return "opacity:0";
  const cs = getComputedStyle(container);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const box = container.getBoundingClientRect();
  const sx = container.scrollLeft || 0;
  const sy = container.scrollTop || 0;
  const geo = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left - box.left + sx - bl, y: r.top - box.top + sy - bt, w: r.width, h: r.height };
  };
  const a = geo(btns[index]);
  if (!a) return "opacity:0";
  let p = Number(progress) || 0;
  p = p < 0 ? 0 : (p > 1 ? 1 : p);
  const step = dir > 0 ? 1 : (dir < 0 ? -1 : 0);
  const b = step ? geo(btns[index + step]) : null;
  const x = b ? a.x + (b.x - a.x) * p : a.x;
  const y = b ? a.y + (b.y - a.y) * p : a.y;
  const w = b ? a.w + (b.w - a.w) * p : a.w;
  const h = b ? a.h + (b.h - a.h) * p : a.h;
  return "opacity:1;width:" + w.toFixed(2) + "px;height:" + h.toFixed(2) + "px;" +
    "transform:translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0);";
}

/* 页面内分页轨道：把 offset(px) 转成 translate 样式 */
export function trackStyle(offsetPx, index, reduce) {
  const shift = index * 100 + (offsetPx || 0);
  const base = "transform:translate3d(calc(-" + index * 100 + "% + " + Math.round(offsetPx || 0) + "px),0,0);";
  return base;
}

/* ------------------------------------------------------------------ 返回键
   视图可以拦截安卓系统返回键 / 页面内返回：registerBack("/games/board", fn)
   fn() 返回 true 表示已处理（不再执行默认的返回上一级）。 */
export const backHandlers = new Map();
export function registerBack(path, handler) {
  backHandlers.set(path, handler);
  return () => backHandlers.delete(path);
}

export function resolveBack(path) {
  if (backHandlers.has(path)) return backHandlers.get(path);
  let best = null;
  let bestLen = -1;
  backHandlers.forEach((handler, key) => {
    if (path.startsWith(key) && key.length > bestLen) {
      best = handler;
      bestLen = key.length;
    }
  });
  return best;
}

/* ------------------------------------------------------------------ 公告 */
export async function loadAnnouncements() {
  try {
    const data = await api("/api/announcements");
    store.announcements = data.items || [];
    store.unreadAnnounce = data.unread || 0;
    if (data.popup_enabled && store.unreadAnnounce) {
      store.announcePopup = store.announcements.filter((item) => !item.read).slice(0, 1);
    }
    return data;
  } catch (err) {
    return { items: [], unread: 0 };
  }
}

export async function ackAnnouncements(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  try {
    await api("/api/announcements/ack", { method: "POST", body: { ids: list } });
  } catch (err) { /* 离线时忽略，下次再看 */ }
  store.announcements = store.announcements.map((item) =>
    list.includes(item.id) ? { ...item, read: true } : item);
  store.unreadAnnounce = store.announcements.filter((item) => !item.read).length;
  store.announcePopup = null;
}
