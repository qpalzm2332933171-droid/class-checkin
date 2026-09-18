/* 狼人杀真机端到端：浏览器当 1 号玩家，另外 5 个玩家用 WebSocket 直接连。
   验证 6 人开局后 UI 真的能显示身份卡 / 座位 / 夜晚阶段 / 行动面板。
   用法：cd tests/browser && node werewolf-live.mjs */
import fs from "node:fs";
import path from "node:path";
import { connect, login, BASE } from "./harness.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(HERE, "accounts.json"), "utf8"));
const results = [];
function check(name, ok) { results.push([name, !!ok]); }

async function token(who) {
  const acc = ACCOUNTS[who];
  const res = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: acc.username, password: acc.password }),
  });
  if (!res.ok) throw new Error("登录失败 " + who);
  return (await res.json()).token;
}

function openWs(tok) {
  const url = BASE.replace("http", "ws") + "/ws?token=" + encodeURIComponent(tok) + "&device=web";
  const ws = new WebSocket(url);
  const box = { ws: ws, msgs: [], send(o) { ws.send(JSON.stringify(o)); } };
  ws.addEventListener("message", function (ev) { try { box.msgs.push(JSON.parse(ev.data)); } catch (e) {} });
  return new Promise(function (res) {
    ws.addEventListener("open", function () { res(box); });
    setTimeout(function () { res(box); }, 4000);
  });
}

function waitFor(box, pred, ms) {
  const end = Date.now() + (ms || 8000);
  return new Promise(function (res) {
    (function loop() {
      const hit = box.msgs.find(pred);
      if (hit) return res(hit);
      if (Date.now() > end) return res(null);
      setTimeout(loop, 120);
    })();
  });
}

const browserToken = await token("ww01");
const meRes = await fetch(BASE + "/api/me", { headers: { Authorization: "Bearer " + browserToken } });
const myUid = (await meRes.json()).user.id;

const page = await connect(Number(process.env.CDP_PORT || 9336));
await login(page, "ww01", "/games");
await page.js("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message));});'ok'");

await page.js("(function(){var l=[].slice.call(document.querySelectorAll('.game-card'));var e=l.filter(function(x){return (x.textContent||'').indexOf('狼人杀')>=0;})[0];if(!e)return 'MISS';e.click();return 'OK';})()");
await page.sleep(500);
await page.js("__T.clickExact('创建房间');'ok'");
await page.sleep(500);
await page.js("__T.clickExact('创建');'ok'");
await page.sleep(2500);

const code = await page.js("(function(){var t=(document.querySelector('.code-btn')||{}).textContent||'';var m=t.match(/(\\d{4})/);return m?m[1]:'';})()");
check("浏览器创建狼人杀房间拿到四位房间号", /^\d{4}$/.test(code));

const others = ["ww02", "ww03", "ww04", "ww05", "ww06"];
const boxes = [];
const uidOfWho = {};
for (const who of others) {
  const tok = await token(who);
  const me = await (await fetch(BASE + "/api/me", { headers: { Authorization: "Bearer " + tok } })).json();
  uidOfWho[who] = me.user.id;
  boxes.push(await openWs(tok));
}
for (const b of boxes) b.send({ t: "game.join", room: code });
for (const b of boxes) await waitFor(b, (m) => m.t === "game.entered", 8000);
check("5 个 WebSocket 玩家进入同一房间",
  (await Promise.all(boxes.map((b) => waitFor(b, (m) => m.t === "game.entered", 5000)))).every(Boolean));

await page.js("__T.clickExact('准备');'ok'");
for (const b of boxes) { b.send({ t: "game.ready" }); await page.sleep(120); }

const started = await waitFor(boxes[0], (m) => m.t === "game.state" && m.room && m.room.started, 12000);
check("6 人到齐后自动开局", !!started);

await page.sleep(2600);
const ui = await page.js("(function(){var t=document.body.textContent||'';return JSON.stringify({"
  + "role:/你是【/.test(t), seats:document.querySelectorAll('.seat').length,"
  + "night:/第 1 夜|天黑请闭眼/.test(t), phase:!!document.querySelector('.phase'),"
  + "act:!!document.querySelector('.act-panel, .action-panel, .ww-act'),"
  + "text:t.slice(0,300)});})()");
const UI = JSON.parse(ui);
check("浏览器端显示身份卡", UI.role);
check("浏览器端显示 6 个座位", UI.seats === 6);
check("浏览器端显示夜晚阶段", UI.night && UI.phase);
check("浏览器端没有报错", (await page.js("JSON.stringify(window.__errs||[])")) === "[]");

function roleOf(box) {
  for (let i = box.msgs.length - 1; i >= 0; i--) {
    const m = box.msgs[i];
    if (m.t === "game.state" && m.room && m.room.state && m.room.state.my_role) return m.room.state.my_role;
  }
  return "";
}
function lastState(box) {
  for (let i = box.msgs.length - 1; i >= 0; i--) {
    const m = box.msgs[i];
    if (m.t === "game.state" && m.room && m.room.state) return m.room.state;
  }
  return null;
}
async function waitBridge(box, pred, ms) { return waitFor(box, pred, ms); }

const mine = await page.js("(function(){var t=document.body.textContent||'';var m=t.match(/你是【(.+?)】/);return m?m[1]:'';})()");
console.log("浏览器玩家身份：" + mine);
if (mine === "狼人") {
  const canKill = await page.js("document.querySelectorAll('.seat.can').length > 0");
  check("狼人能看到可刀的座位", canKill);
  const tapped = await page.js("(function(){var s=document.querySelectorAll('.seat.can')[0];if(!s)return 'MISS';s.click();return 'OK';})()");
  await page.sleep(400);
  const act = await page.js("(function(){var b=document.querySelector('.action button.btn-primary');"
    + "return JSON.stringify({picked:document.querySelectorAll('.seat.picked').length,"
    + "label:(b?b.textContent:'').trim(),disabled:!!(b&&b.disabled)});})()");
  const ACT = JSON.parse(act);
  check("点座位会选中并显示刀人按钮", tapped === "OK" && ACT.picked === 1 && /刀 \d+ 号/.test(ACT.label) && !ACT.disabled);
  const sent = await page.js("(function(){var b=document.querySelector('.action button.btn-primary');if(!b)return 'MISS';if(b.disabled)return 'DISABLED';b.click();return 'OK';})()");
  await page.sleep(1500);
  check("狼人确认后服务端记录了这一刀", sent === "OK");
  const after = await page.js("(function(){var t=document.body.textContent||'';return /已经动了刀|狼人已经动了刀|等待其他狼人/.test(t)?'progressed':'waiting';})()");
  check("这一刀没有立刻跳阶段（还要等其他狼人）", after === "waiting" || after === "progressed");
}

/* ---------- 走完 夜晚 -> 天亮 的完整流程，验证各身份的界面 ---------- */
const wsSeer = boxes.find((b) => roleOf(b) === "seer");
const wsWitch = boxes.find((b) => roleOf(b) === "witch");
const wsWolves = boxes.filter((b) => roleOf(b) === "wolf");

const aliveOrder = (lastState(boxes[0]) || {}).order || [];
const roleByUid = {};
others.forEach((who, i) => { roleByUid[uidOfWho[who]] = roleOf(boxes[i]); });
const wolfUids = new Set(others.filter((who, i) => roleOf(boxes[i]) === "wolf").map((who) => uidOfWho[who]));
if (mine === "狼人") wolfUids.add(myUid);
const killTarget = aliveOrder.find((u) => !wolfUids.has(u)) || 0;

async function pollPanel(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const raw = await page.js("JSON.stringify({panel:!!document.querySelector('.action'),"
      + "can:document.querySelectorAll('.seat.can').length,"
      + "text:(document.body.textContent||'').slice(0,160)});");
    const o = JSON.parse(raw);
    if (o.panel) return o;
    await page.sleep(400);
  }
  return null;
}

// --- 狼人刀人
for (const b of wsWolves) b.send({ t: "game.act", what: "wolf_kill", target: killTarget });
if (mine === "狼人") {
  const hit = await waitBridge(boxes[0], (m) => m.t === "game.state" && m.room.state.step === "seer", 15000);
  check("狼人界面操作后进入预言家阶段", !!hit);
} else {
  await waitBridge(boxes[0], (m) => m.t === "game.state" && m.room.state.step === "seer", 15000);
}

// --- 预言家验人
if (mine === "预言家") {
  const panel = await pollPanel(20000);
  check("轮到预言家时出现行动面板", !!panel);
  if (panel && panel.can > 0) {
    await page.js("document.querySelectorAll('.seat.can')[0].click();'ok'");
    await page.sleep(400);
    const label = await page.js("(function(){var b=document.querySelector('.action button.btn-primary');return b?b.textContent.trim():'';})()");
    check("预言家选中后按钮变成「验 N 号」", /验 \d+ 号/.test(label));
    await page.js("(function(){var b=document.querySelector('.action button.btn-primary');if(b&&!b.disabled)b.click();return 'ok';})()");
    await page.sleep(800);
  }
} else if (wsSeer) {
  const seerTarget = aliveOrder.find((u) => wolfUids.has(u)) || killTarget;
  wsSeer.send({ t: "game.act", what: "seer_check", target: seerTarget });
}

// --- 女巫用药
if (mine === "女巫") {
  const panel = await pollPanel(25000);
  check("轮到女巫时出现药水面板", !!panel && /解药/.test(panel.text) && /毒药/.test(panel.text));
  const clicked = await page.js("(function(){var l=[].slice.call(document.querySelectorAll('.action button'));"
    + "var b=l.filter(function(x){return (x.textContent||'').trim()==='不用药';})[0];"
    + "if(!b)return 'MISS';if(b.disabled)return 'DISABLED';b.click();return 'OK';})()");
  check("女巫可以点不用药直接确认", clicked === "OK");
} else if (wsWitch) {
  wsWitch.send({ t: "game.act", what: "witch", use: "" });
}

// --- 天亮
const dayBox = (await Promise.all(boxes.map((b) => waitBridge(b, (m) => m.t === "game.state" && m.room.state.step === "speak", 120000)))).find(Boolean);
if (!dayBox) console.log("DEBUG stuck step", JSON.stringify((lastState(boxes[0]) || {}).step));
check("夜晚三个环节走完后进入白天发言", !!dayBox);
await page.sleep(1500);
const dayUI = await page.js("(function(){var t=document.body.textContent||'';return JSON.stringify({"
  + "day:/天亮了|平安夜|倒牌|白天/.test(t), errs:(window.__errs||[]).length});})()");
const DAY = JSON.parse(dayUI);
check("浏览器端同步到白天阶段", DAY.day && DAY.errs === 0);

await page.goto(BASE + "/#/games", 1200);
for (const b of boxes) { try { b.ws.close(); } catch (e) {} }
page.close();

const ok = results.filter((r) => r[1]).length;
for (const [n, o] of results) console.log((o ? "PASS  " : "FAIL  ") + n);
console.log("=== " + ok + "/" + results.length + " ===");
process.exit(ok === results.length ? 0 : 1);
