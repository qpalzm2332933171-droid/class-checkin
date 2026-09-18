/* ------------------------------------------------------------------ 地图选点
   轻量 slippy map：高德栅格瓦片（GCJ-02）+ 自绘拖动/缩放，不依赖任何第三方库。
   对外一律使用 WGS-84（和安卓 GPS、服务端一致），只有贴瓦片时才换算成 GCJ-02，
   否则在中国境内会出现几百米的整体偏移，签到半径就对不上了。 */

const PI = Math.PI;
const TILE = 256;
const EARTH_A = 6378245.0;
const EARTH_EE = 0.00669342162296594323;
const MIN_Z = 4;
const MAX_Z = 18;

function outOfChina(lat, lng) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/* WGS-84 -> GCJ-02（火星坐标） */
export function wgs2gcj(lat, lng) {
  if (outOfChina(lat, lng)) return { lat: lat, lng: lng };
  const dLat = transformLat(lng - 105.0, lat - 35.0);
  const dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EARTH_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  return {
    lat: lat + (dLat * 180.0) / ((EARTH_A * (1 - EARTH_EE)) / (magic * sqrtMagic) * PI),
    lng: lng + (dLng * 180.0) / (EARTH_A / sqrtMagic * Math.cos(radLat) * PI)
  };
}

/* GCJ-02 -> WGS-84：一次迭代反解，误差在米级，远小于最小签到半径 */
export function gcj2wgs(lat, lng) {
  const guess = wgs2gcj(lat, lng);
  return { lat: lat * 2 - guess.lat, lng: lng * 2 - guess.lng };
}

function lngToPx(lng, z) { return (lng + 180) / 360 * TILE * Math.pow(2, z); }
function latToPy(lat, z) {
  const safe = Math.max(-85.05, Math.min(85.05, lat));
  const s = Math.sin(safe * PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * PI)) * TILE * Math.pow(2, z);
}
function pxToLng(x, z) { return x / (TILE * Math.pow(2, z)) * 360 - 180; }
function pyToLat(y, z) {
  const n = PI - 2 * PI * y / (TILE * Math.pow(2, z));
  return 180 / PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/* 该纬度下 1 米等于多少像素（用于画半径圈） */
export function metersPerPixel(lat, z) {
  return 156543.03392 * Math.cos(Math.max(-85, Math.min(85, lat)) * PI / 180) / Math.pow(2, z);
}

function tileUrl(x, y, z) {
  const sub = (Math.abs(x + y) % 4) + 1;
  return "https://webrd0" + sub + ".is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x="
    + x + "&y=" + y + "&z=" + z;
}

/* ------------------------------------------------------------------ 地图实例
   host: 容器元素（会被完全接管，Vue 不要再往里渲染东西）
   opts: { lat, lng, zoom, radius, onPick(lat,lng), onZoom(z) }                     */
export function createMapPicker(host, opts) {
  const options = opts || {};
  let zoom = Math.max(MIN_Z, Math.min(MAX_Z, options.zoom || 17));
  let radius = options.radius || 200;
  let onPick = options.onPick || null;
  let me = null;                                   // 设备自身位置（WGS-84）
  let gcj = wgs2gcj(options.lat || 31.2304, options.lng || 121.4737);

  const root = document.createElement("div");
  root.className = "mk-root";
  const layer = document.createElement("div");
  layer.className = "mk-tiles";
  const circle = document.createElement("div");
  circle.className = "mk-circle";
  const dot = document.createElement("div");
  dot.className = "mk-dot";
  dot.hidden = true;
  const alert = document.createElement("div");
  alert.className = "mk-alert";
  alert.hidden = true;
  root.appendChild(layer);
  root.appendChild(circle);
  root.appendChild(dot);
  root.appendChild(alert);
  host.appendChild(root);

  const tiles = new Map();                          // "z/x/y" -> img
  let baseX = 0;
  let baseY = 0;
  let cols = 0;
  let rows = 0;
  let failures = 0;

  function size() {
    const box = host.getBoundingClientRect();
    return { w: Math.max(120, Math.round(box.width)), h: Math.max(120, Math.round(box.height)) };
  }

  function centerPx() {
    return { x: lngToPx(gcj.lng, zoom), y: latToPy(gcj.lat, zoom) };
  }

  function buildTiles() {
    const s = size();
    const px = centerPx();
    cols = Math.ceil(s.w / TILE) + 1;
    rows = Math.ceil(s.h / TILE) + 1;
    baseX = Math.floor(px.x / TILE) - 1;
    baseY = Math.floor(px.y / TILE) - 1;
    const want = new Set();
    const max = Math.pow(2, zoom);
    for (let j = 0; j < rows + 2; j++) {
      for (let i = 0; i < cols + 2; i++) {
        const tx = baseX + i;
        const ty = baseY + j;
        if (ty < 0 || ty >= max) continue;
        const key = zoom + "/" + (((tx % max) + max) % max) + "/" + ty;
        want.add(key);
        if (tiles.has(key)) continue;
        const img = document.createElement("img");
        img.className = "mk-tile";
        img.alt = "";
        img.draggable = false;
        img.decoding = "async";
        img.src = tileUrl((((tx % max) + max) % max), ty, zoom);
        img.style.left = (i * TILE) + "px";
        img.style.top = (j * TILE) + "px";
        img.addEventListener("error", () => {
          failures += 1;
          if (failures > 2) {
            alert.hidden = false;
            alert.textContent = "地图瓦片加载不出来，检查一下网络";
          }
        });
        tiles.set(key, img);
        layer.appendChild(img);
      }
    }
    tiles.forEach((img, key) => {
      if (want.has(key)) return;
      img.remove();
      tiles.delete(key);
    });
    return px;
  }

  function place() {
    const px = centerPx();
    const s = size();
    const offX = px.x - baseX * TILE;
    const offY = px.y - baseY * TILE;
    layer.style.transform = "translate3d(" + (-offX) + "px," + (-offY) + "px,0)";
    const mpp = metersPerPixel(gcj.lat, zoom);
    const dia = Math.max(12, Math.round((radius * 2) / mpp));
    circle.style.width = dia + "px";
    circle.style.height = dia + "px";
    circle.style.left = Math.round(s.w / 2 - dia / 2) + "px";
    circle.style.top = Math.round(s.h / 2 - dia / 2) + "px";
    if (me) {
      const mx = lngToPx(me.gcj.lng, zoom);
      const my = latToPy(me.gcj.lat, zoom);
      const sx = s.w / 2 - (px.x - mx);
      const sy = s.h / 2 - (px.y - my);
      dot.hidden = Math.abs(sx) > s.w * 3 || Math.abs(sy) > s.h * 3;
      dot.style.transform = "translate3d(" + Math.round(sx) + "px," + Math.round(sy) + "px,0)";
    }
  }

  function redraw(rebuild) {
    const px = rebuild ? buildTiles() : centerPx();
    place();
    return px;
  }

  /* -------------------------------------------------- 拖动 */
  let drag = null;

  function down(ev) {
    if (ev.touches && ev.touches.length > 1) return;
    const p = point(ev);
    drag = { x: p.x, y: p.y, px: centerPx(), moved: 0, id: ev.pointerId };
    root.classList.add("mk-grabbing");
    if (ev.pointerId != null && root.setPointerCapture) {
      try { root.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
    }
  }

  function move(ev) {
    if (!drag) return;
    const p = point(ev);
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    if (drag.moved < 3) return;
    if (ev.cancelable) ev.preventDefault();
    const nx = drag.px.x - dx;
    const ny = drag.px.y - dy;
    gcj = { lat: pyToLat(ny, zoom), lng: pxToLng(nx, zoom) };
    const px = centerPx();
    const wantBase = { x: Math.floor(px.x / TILE) - 1, y: Math.floor(px.y / TILE) - 1 };
    if (wantBase.x !== baseX || wantBase.y !== baseY) buildTiles();
    place();
  }

  function up(ev) {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    root.classList.remove("mk-grabbing");
    if (moved < 3) return;
    emit();
  }

  function point(ev) {
    if (ev.touches && ev.touches.length) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    if (ev.changedTouches && ev.changedTouches.length) {
      return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
    }
    return { x: ev.clientX, y: ev.clientY };
  }

  function emit() {
    if (!onPick) return;
    const wgs = gcj2wgs(gcj.lat, gcj.lng);
    onPick(Number(wgs.lat.toFixed(7)), Number(wgs.lng.toFixed(7)));
  }

  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", (ev) => {
    if (drag) { drag = null; root.classList.remove("mk-grabbing"); }
  });
  /* 老 WebView 没有 pointer 事件时用 touch 兜底 */
  if (!window.PointerEvent) {
    root.addEventListener("touchstart", (ev) => { down(ev); }, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", up);
  }
  root.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    setZoom(zoom + (ev.deltaY < 0 ? 1 : -1), false);
  }, { passive: false });

  /* 半径圈按 z17 画直径接近 390px，比视口还大，用户根本看不到边界。
     这里只在"圈放不下"时自动拉远，绝不主动拉近，避免抢用户的缩放。 */
  function fitRadius() {
    const s = size();
    const limit = Math.min(s.w, s.h) * 0.84;
    let target = zoom;
    while (target > MIN_Z && (radius * 2) / metersPerPixel(gcj.lat, target) > limit) target -= 1;
    if (target !== zoom) setZoom(target, true);
    return target !== zoom;
  }

  function setZoom(next, silent) {
    const value = Math.max(MIN_Z, Math.min(MAX_Z, next));
    if (value === zoom) return;
    zoom = value;
    failures = 0;
    alert.hidden = true;
    tiles.forEach((img) => img.remove());
    tiles.clear();
    redraw(true);
    if (!silent) emit();
  }

  const observer = window.ResizeObserver ? new ResizeObserver(() => {
    tiles.forEach((img) => img.remove());
    tiles.clear();
    redraw(true);
  }) : null;
  if (observer) observer.observe(host);

  redraw(true);

  return {
    /* 传入 WGS-84 坐标 */
    setCenter(lat, lng) {
      gcj = wgs2gcj(lat, lng);
      tiles.forEach((img) => img.remove());
      tiles.clear();
      failures = 0;
      alert.hidden = true;
      redraw(true);
    },
    center() {
      const wgs = gcj2wgs(gcj.lat, gcj.lng);
      return { lat: Number(wgs.lat.toFixed(7)), lng: Number(wgs.lng.toFixed(7)) };
    },
    setMe(lat, lng) {
      me = { gcj: wgs2gcj(lat, lng) };
      place();
    },
    setRadius(meters) {
      radius = Math.max(10, Number(meters) || 0);
      if (!fitRadius()) place();
    },
    zoomBy(delta) { setZoom(zoom + delta, true); },
    zoom() { return zoom; },
    resize() {
      tiles.forEach((img) => img.remove());
      tiles.clear();
      redraw(true);
    },
    pick() { emit(); },
    destroy() {
      if (observer) observer.disconnect();
      tiles.clear();
      root.remove();
    }
  };
}
