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
  settings: {},
  online: 0,
  onlineUsers: [],
  alias: "",
  route: "/",
  ready: false,
  toasts: [],
  sheet: null,
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
      reject(new Error("网页端定位需要 HTTPS，请用安卓客户端尝试"));
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

/* 分段控件（滑块）位置：按当前高亮按钮实测，返回可直接绑到 :style 的字符串 */
export function pillStyle(container, extraPx) {
  if (!container) return "opacity:0";
  const btn = container.querySelector("button.on");
  if (!btn) return "opacity:0";
  const cs = getComputedStyle(container);
  const padL = parseFloat(cs.borderLeftWidth) || 0;   // 绝对定位子元素的参照系是 padding box
  const padT = parseFloat(cs.borderTopWidth) || 0;
  const box = container.getBoundingClientRect();
  const rect = btn.getBoundingClientRect();
  if (!rect.width) return "opacity:0";
  const x = rect.left - box.left - padL + (extraPx || 0);
  const y = rect.top - box.top - padT;
  return "opacity:1;width:" + Math.round(rect.width) + "px;height:" + Math.round(rect.height) + "px;" +
    "transform:translate3d(" + Math.round(x) + "px," + Math.round(y) + "px,0);";
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
