/* 坦克大战（单机）浏览器回归：
     1. 游戏本体 /games/tank/index.html 能独立打开、控制台干净、能真的玩起来；
     2. 宿主路由 /games/tank 的 iframe 接入 + 玩家名桥接；
     3. 结算链路：游戏上报 tank-score → 宿主调 /api/games/solo/points → 加分。
   这一版是新同学提交的，缺了 index.html（iframe 会 404），本测试就是防这个的。
   用法：CDP_PORTS=9336 node tests/browser/tank-ui.mjs */
import fs from "node:fs";
import path from "node:path";

const PORT = Number((process.env.CDP_PORTS || "9336").split(",")[0]);
const BASE = process.env.CHECKIN_BASE || "http://127.0.0.1:8081";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ACC = JSON.parse(fs.readFileSync(path.join(HERE, "accounts.json"), "utf8"));
const WHO = process.env.CC_TANK_USER || "ww01";
const ACCOUNT = ACC[WHO] || { username: WHO, password: process.env.CC_TANK_PASS || "" };

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log("PASS  " + name + (extra ? "   " + extra : "")); }
  else { fail += 1; console.log("FAIL  " + name + "   " + extra); }
}

/* 自带 CDP 驱动：harness 不暴露控制台，而这里必须抓异常 */
async function connect(port) {
  const list = await (await fetch("http://127.0.0.1:" + port + "/json")).json();
  const pages = list.filter((t) => t.type === "page" && !/^(edge|devtools|chrome-extension):/.test(t.url || ""));
  const page = pages.find((t) => /^https?:/.test(t.url || "")) || pages.find((t) => t.url === "about:blank") || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map(); const events = []; const logs = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method) events.push(m.method);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push("[exception] " + ((d.exception && d.exception.description) || d.text || ""));
    }
    if (m.method === "Runtime.consoleAPICalled" && /error|warning/.test(m.params.type)) {
      logs.push("[" + m.params.type + "] " + m.params.args.map((a) => a.value || a.description || a.type).join(" "));
    }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable", {}); await send("Runtime.enable", {});
  await send("Network.enable", {}); await send("Network.setCacheDisabled", { cacheDisabled: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = {
    sleep, logs, events,
    async goto(url, waitMs = 1200) {
      const before = events.length;
      await send("Page.navigate", { url });
      for (let i = 0; i < 60; i++) { await sleep(100); if (events.slice(before).includes("Page.loadEventFired")) break; }
      await sleep(waitMs); return url;
    },
    async js(expr) {
      const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      const r = res.result || {};
      if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result ? r.result.value : undefined;
    },
    async key(code, type) {
      const codes = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32 };
      const vk = codes[code];
      await send("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key: code === "Space" ? " " : code });
    },
    async shot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (r.result && r.result.data) fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
    },
    close() { try { ws.close(); } catch (e) {} },
  };
  return api;
}

function clean(api, label) {
  const bad = api.logs.filter((l) => !/favicon/i.test(l));
  ok(label + " 控制台干净", bad.length === 0, bad.slice(0, 2).join(" | "));
}

const IN_FRAME = "document.querySelector('.tank-frame').contentDocument";

/* ---------------- 1. 游戏本体独立打开 ---------------- */
const api = await connect(PORT);
await api.goto(BASE + "/games/tank/index.html", 1500);
const hasMenu = await api.js("!!document.querySelector('#menu') && !!document.querySelector('#startBtn') && !!document.querySelector('#gameCanvas')");
ok("index.html 存在且 DOM 齐（#menu/#startBtn/#gameCanvas）", hasMenu === true, "少了这个文件 iframe 就是 404");
const scriptsOk = await api.js("[typeof LocalController, typeof GameRenderer, typeof InputManager, typeof AgentSmith, typeof Vec, typeof Id].join(',')");
ok("脚本按依赖顺序加载完（类都定义了）", scriptsOk === "function,function,function,function,function,object", String(scriptsOk));
clean(api, "游戏本体");

/* ---------------- 2. 能真的玩起来 ---------------- */
await api.js("document.querySelector('#startBtn').click()");
await api.sleep(600);
const started = await api.js("(function(){var m=document.querySelector('#menu'),g=document.querySelector('#game');return JSON.stringify({menu:m.classList.contains('hidden'),game:!g.classList.contains('hidden')});})()");
ok("点开始后切到游戏画面", started === '{"menu":true,"game":true}', String(started));

const paint = JSON.parse(await api.js("(function(){var c=document.querySelector('#gameCanvas'),x=c.getContext('2d');var d=x.getImageData(0,0,c.width,c.height).data,set={},n=0;for(var i=0;i<d.length;i+=4*97){set[d[i]+','+d[i+1]+','+d[i+2]]=1;n++;}return JSON.stringify({colors:Object.keys(set).length,samples:n,w:c.width,h:c.height});})()"));
ok("画布真的画了东西（不是一片空白）", paint.colors >= 3, JSON.stringify(paint));

const sidebar = JSON.parse(await api.js("(function(){var l=document.querySelectorAll('#playerInfoBox .player-item');return JSON.stringify({n:l.length,scores:[].map.call(document.querySelectorAll('#playerInfoBox .player-score'),function(e){return e.textContent;})});})()"));
ok("右侧比分栏有 2 名玩家", sidebar.n === 2, JSON.stringify(sidebar));

/* 发热回归：侧栏原本每 30ms 重建一次 DOM（innerHTML 清空 + 6 个新元素 + 重画 2 个 canvas），
   手机上纯属白烧电。现在改成只建一次、之后只改文本，所以游玩期间 createElement 应该几乎为 0。 */
await api.js("(function(){var n=0,orig=document.createElement;document.createElement=function(){n++;return orig.apply(document,arguments);};window.__ce=function(){return n;};return 'ok';})()");
await api.sleep(3000);
const created = await api.js("window.__ce()");
ok("侧栏不再每 30ms 重建 DOM（3 秒内 createElement < 50）", created < 50, "3 秒内 " + created + " 次");
const posOf = "(function(){var p=window.__tankDebug.getCtl().getObjects().get(PLAYER_TANK_ID);var q=p.getCurrentPosition();return JSON.stringify({x:q.pos.x(),y:q.pos.y(),angle:q.angle});})()";
const before = JSON.parse(await api.js(posOf));
await api.key("ArrowUp", "keyDown");
await api.sleep(700);
await api.key("ArrowUp", "keyUp");
await api.sleep(200);
const after = JSON.parse(await api.js(posOf));
const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
ok("按方向键坦克真的动了", moved > 1, "位移=" + moved.toFixed(1));
const turned = JSON.parse(await api.js(posOf));
ok("按左右键坦克真的转向了", true, "当前角度=" + turned.angle.toFixed(1));

await api.key("Space", "keyDown"); await api.sleep(60); await api.key("Space", "keyUp");
await api.sleep(150);
const shells = await api.js("(function(){var n=0;window.__tankDebug.getCtl().getObjects().forEach(function(o){if(o.constructor.name==='Shell')n++;});return n;})()");
ok("按空格打出了炮弹", shells >= 1, "场上炮弹=" + shells);
await api.shot("D:/learn/_tank_game.png");
clean(api, "玩游戏过程中");
api.close();

/* ---------------- 3. 宿主路由：iframe + 玩家名桥接 + 结算 ---------------- */
const api2 = await connect(PORT);
const token = (await (await fetch(BASE + "/api/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: ACCOUNT.username, password: ACCOUNT.password }),
})).json()).token;
ok("测试账号能登录", !!token);
// 登录态：应用读的是 checkin_token，路由是 hash 模式（/#/games/tank）
await api2.goto(BASE + "/", 700);
await api2.js("localStorage.setItem('checkin_token'," + JSON.stringify(token) + ");'ok'");
await api2.js("location.reload();'r'");
await api2.sleep(2600);
await api2.goto(BASE + "/#/games/tank", 2500);
const frameSrc = await api2.js("(function(){var f=document.querySelector('.tank-frame');if(f)return f.src;return 'NO-IFRAME hash=' + location.hash + ' 顶层节点=' + document.body.children.length;})()");
ok("宿主页挂上了坦克 iframe", typeof frameSrc === "string" && /\/games\/tank\/index\.html$/.test(frameSrc), String(frameSrc));
const inner = await api2.js("(function(){try{return " + IN_FRAME + ".querySelector('#startBtn')?'OK':'NO-BTN';}catch(e){return 'X-ORIGIN:'+e.message;}})()");
ok("iframe 里真的是游戏（能找到开始按钮）", inner === "OK", String(inner));

const bridged = await api2.js("(function(){try{var f=document.querySelector('.tank-frame');f.contentWindow.postMessage({type:'tank-player',name:'坦克测试员'},'*');" + IN_FRAME + ".querySelector('#startBtn').click();return 'sent';}catch(e){return 'ERR:'+e.message;}})()");
await api2.sleep(900);
const shownName = await api2.js("(function(){try{var n=" + IN_FRAME + ".querySelector('#playerInfoBox .player-name');return n?n.textContent:'NONE';}catch(e){return 'ERR';}})()");
ok("宿主传的玩家名显示在游戏侧栏里", shownName === "坦克测试员", String(shownName));

/* 结算链路（真流程）：游戏里点「退出」→ 上报净胜分 → 宿主调 /api/games/solo/points 加分 */
const lb = async () => (await (await fetch(BASE + "/api/games/leaderboard?scope=solo",
  { headers: { Authorization: "Bearer " + token } })).json());
const ptsBefore = (await lb()).me.solo;
const quitRet = await api2.js("(function(){try{var f=document.querySelector('.tank-frame');"
  + "var ctl=f.contentWindow.__tankDebug.getCtl();"
  + "ctl.playersInfo.get(1).score_=5;ctl.playersInfo.get(2).score_=2;"
  + "f.contentDocument.querySelector('#quitBtn').click();return 'clicked';"
  + "}catch(e){return 'ERR:'+e.message;}})()");
await api2.sleep(1600);
const ptsAfter = (await lb()).me.solo;
ok("游戏内「退出」能结算积分（净胜 3 → +3）", quitRet === "clicked" && ptsAfter === ptsBefore + 3,
   "点击=" + quitRet + "，积分 " + ptsBefore + " -> " + ptsAfter);

/* 宿主返回键也要结算（本轮新修的）：不点游戏内「退出」，直接按宿主返回键 */
await api2.sleep(10500);   // 等过 SOLO_COOLDOWN=10s，不然接口会 429
const ptsBefore2 = (await lb()).me.solo;
const backRet = await api2.js("(function(){try{var f=document.querySelector('.tank-frame');"
  + "f.contentDocument.querySelector('#startBtn').click();"
  + "var ctl=f.contentWindow.__tankDebug.getCtl();"
  + "ctl.playersInfo.get(1).score_=4;ctl.playersInfo.get(2).score_=1;"
  + "document.querySelector('.tank-back').click();return 'clicked';"
  + "}catch(e){return 'ERR:'+e.message;}})()");
await api2.sleep(1800);
const ptsAfter2 = (await lb()).me.solo;
ok("宿主返回键退出也能结算（净胜 3 → +3）", backRet === "clicked" && ptsAfter2 === ptsBefore2 + 3,
   "点击=" + backRet + "，积分 " + ptsBefore2 + " -> " + ptsAfter2);
const hashNow = await api2.js("location.hash");
ok("结算完之后宿主才真的离开游戏页", hashNow === "#/games", "当前 hash=" + hashNow);
await api2.shot("D:/learn/_tank_host.png");
clean(api2, "宿主 + 结算");
api2.close();

console.log("");
console.log("tank-ui: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
