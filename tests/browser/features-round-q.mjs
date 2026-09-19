/* 阶段 Q 浏览器回归：围棋 9/19 路选择 · 画猜聊天框与可收起积分榜 · 观战弹幕 · 象棋"将军"动画。
   前置：无头 Edge 已开 CDP 9336，本地服务在 8081。
   用法：cd tests/browser && node features-round-q.mjs */
import fs from "node:fs";
import path from "node:path";
import { connect, login, BASE } from "./harness.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(HERE, "accounts.json"), "utf8"));

const A = await connect(Number((process.env.CDP_PORTS || "9336").split(",")[0]));
const out = [];
const check = (name, ok, extra = "") => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok || !extra ? "" : "   [" + extra + "]"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(who) {
  const res = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ACCOUNTS[who]),
  });
  return (await res.json()).token;
}

/* 极简 WS 客户端：用来当对手 / 观战者，省掉第二、第三台浏览器 */
async function peer(who) {
  const ws = new WebSocket("ws://127.0.0.1:8081/ws?token=" + encodeURIComponent(await account(who)) + "&device=web");
  const msgs = [];
  ws.addEventListener("message", (ev) => {
    try { msgs.push(JSON.parse(typeof ev.data === "string" ? ev.data : "")); } catch (e) { /* ping 之类的非文本帧 */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  return {
    msgs,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    wait: async (pred, secs = 8000) => {
      const end = Date.now() + secs;
      while (Date.now() < end) { if (pred()) return true; await sleep(80); }
      return false;
    },
    room: () => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].room) return msgs[i].room; return {}; },
    chats: () => msgs.filter((m) => m.t === "game.chat").map((m) => m.chat),
  };
}

/* 轮询等一个 DOM 条件成立（弹幕这类"服务端推过来才出现"的东西要等一等） */
async function waitDom(page, expr, secs = 4000) {
  const end = Date.now() + secs;
  while (Date.now() < end) {
    if (await page.js(expr)) return true;
    await sleep(150);
  }
  return false;
}

async function createRoom(page, gameText, sizeLabel) {
  await page.goto(BASE + "/#/games", 2000);
  await page.js("__T.clickText('" + gameText + "','.game-card')"); await page.sleep(400);
  await page.js("__T.clickText('创建房间')"); await page.sleep(400);
  if (sizeLabel) { await page.js("__T.clickExact('" + sizeLabel + "')"); await page.sleep(250); }
  await page.js("__T.clickText('创建')"); await page.sleep(2500);
}

try {
  await login(A, "gt01");
  await A.goto(BASE + "/#/games", 2200);

  /* ---------------- 9. 围棋可选 9 路 / 19 路 ---------------- */
  await A.js("__T.clickText('围棋','.game-card')"); await A.sleep(400);
  await A.js("__T.clickText('创建房间')"); await A.sleep(400);
  check("创建围棋房间时能选 9 路 / 19 路",
    await A.js("document.body.innerText.indexOf('9 路棋盘') >= 0 && document.body.innerText.indexOf('19 路棋盘') >= 0"));
  await A.js("__T.clickExact('19 路棋盘')"); await A.sleep(250);
  await A.js("__T.clickText('创建')"); await A.sleep(2500);
  const cells19 = await A.js("document.querySelectorAll('.board .cell').length");
  const n19 = await A.js("(function(){var b=document.querySelector('.board');return b?getComputedStyle(b).getPropertyValue('--n').trim():'';})()");
  check("19 路棋盘渲染 361 个交叉点", Number(cells19) === 361, "cells=" + cells19);
  check("棋盘 CSS 变量 --n = 19", String(n19) === "19", "--n=" + n19);
  check("19 路棋盘画了 9 个星位", Number(await A.js("document.querySelectorAll('.board .star-dot').length")) === 9);

  await createRoom(A, "围棋", null);            // 不选：默认 9 路
  const cells9 = await A.js("document.querySelectorAll('.board .cell').length");
  check("不选就是 9 路（81 个交叉点）+ 5 个星位",
    Number(cells9) === 81 && Number(await A.js("document.querySelectorAll('.board .star-dot').length")) === 5,
    "cells=" + cells9);

  /* ---------------- 11. 画猜：聊天框在上、积分榜收起 ---------------- */
  await createRoom(A, "你画我猜", null);
  const layout = await A.js("(function(){"
    + "var chat=document.querySelector('.gd-chat');var rank=document.querySelector('.gd-rank');"
    + "if(!chat||!rank)return 'null';"
    + "var feed=document.querySelector('.gd-feed');"
    + "var open=!!document.querySelector('.gd-rank .list');"
    + "return JSON.stringify({chatFirst:(chat.compareDocumentPosition(rank)&4)===4,feedH:Math.round(feed.getBoundingClientRect().height),open:open});})()");
  const L = JSON.parse(layout || "null") || {};
  check("聊天框排在积分排名上面", L.chatFirst === true, layout);
  check("聊天框被做大（>=150px 高）", Number(L.feedH) >= 150, "feedH=" + L.feedH);
  check("积分排名默认收起", L.open === false);
  await A.js("document.querySelector('.gd-rank-head').click()"); await A.sleep(500);
  check("点一下能展开积分排名", await A.js("!!document.querySelector('.gd-rank .list')"));
  await A.js("document.querySelector('.gd-rank-head').click()"); await A.sleep(500);
  check("再点一下能收回去", await A.js("!document.querySelector('.gd-rank .list')"));

  /* ---------------- 12. 观战讨论变成弹幕 ---------------- */
  const CODE_FROM_PAGE = "(function(){var b=document.querySelector('.code-btn');"
    + "return (b?b.textContent:'').replace(/[^0-9]/g,'');})()";
  const drawCode = await A.js(CODE_FROM_PAGE);
  check("页面上能读到四位房间号", /^[0-9]{4}$/.test(String(drawCode)), "code=" + drawCode);
  const B = await peer("gt02");
  B.send({ t: "game.join", room: drawCode, play: true });
  const joined = await B.wait(() => (B.room().players || []).length === 2, 9000);
  check("对手用 WS 加入了同一个画猜房间", joined && B.room().game === "draw", "code=" + drawCode);
  B.send({ t: "game.ready" });
  await A.js("__T.clickExact('准备')");
  const started = await B.wait(() => (B.room().state || {}).status === "playing", 9000);
  check("双方准备后画猜开局", started, JSON.stringify(B.room().state || {}).slice(0, 80));
  const C = await peer("cw01");
  C.send({ t: "game.join", room: drawCode, play: false });
  const spectating = await C.wait(() => !!(C.room().players || []).length && C.room().players.every((p) => p.name !== "生活委员"));
  check("第三人进入观战", spectating || (C.room().players || []).length === 2, JSON.stringify(C.room().players || []));
  await sleep(400);
  C.send({ t: "game.chat", text: "观战弹幕来啦" });
  const arrived = await waitDom(A, "(function(){var t=document.body.innerText;return t.indexOf('观战弹幕来啦')>=0;})()");
  check("观战的发言确实推到了选手页面", arrived);
  await waitDom(A, "!!document.querySelector('.danmaku')", 3000);
  const okDanmu = await A.js("(function(){var n=document.querySelector('.danmaku');if(!n)return 'MISS';"
    + "var s=getComputedStyle(n);return JSON.stringify({text:n.textContent,pe:s.pointerEvents,anim:s.animationName,z:s.zIndex});})()");
  const D = JSON.parse(okDanmu && okDanmu !== "MISS" ? okDanmu : "null") || {};
  check("选手屏幕上飘出观战弹幕", (D.text || "").indexOf("观战弹幕来啦") >= 0, okDanmu);
  check("弹幕层是穿透的（pointer-events:none）", D.pe === "none", "pe=" + D.pe);
  check("弹幕带飘过动画", (D.anim || "").indexOf("danmaku-fly") >= 0, "anim=" + D.anim);
  /* 收尾要真的退房间，否则服务端会按"掉线判负"结算，污染后面的积分测试 */
  B.send({ t: "game.leave" }); C.send({ t: "game.leave" });
  await sleep(500);
  B.close(); C.close();
  await A.goto(BASE + "/#/games", 1600);

  /* ---------------- 14. 象棋"将军"动画 ---------------- */
  await createRoom(A, "象棋", null);
  check("象棋页也有对局讨论入口（观战可发言）", await A.js("!!document.querySelector('.mc-fab')"));
  const E = await peer("gt02");
  E.send({ t: "game.join", room: await A.js(CODE_FROM_PAGE), play: true });
  await E.wait(() => (E.room().players || []).length === 2, 9000);
  E.send({ t: "game.ready" });
  await A.js("__T.clickExact('准备')");
  const xqOn = await E.wait(() => (E.room().state || {}).status === "playing", 9000);
  check("象棋开局", xqOn);
  const tap = (i) => A.js("document.querySelectorAll('.xq-cell')[" + i + "].click()");
  await tap(64); await sleep(150); await tap(46); await sleep(700);      // 红：炮 7,1 -> 5,1
  E.send({ t: "game.move", from: 27, to: 36 }); await sleep(700);         // 黑：卒 3,0 -> 4,0
  await tap(46); await sleep(150); await tap(49); await sleep(900);       // 红：炮 5,1 -> 5,4 将军
  const fx = await A.js("(function(){var n=document.querySelector('.xq-fx');if(!n)return 'MISS';"
    + "var w=document.querySelector('.xq-word');return JSON.stringify({label:w?w.textContent:'',anim:getComputedStyle(w).animationName,"
    + "cls:n.className});})()");
  const F = JSON.parse(fx && fx !== "MISS" ? fx : "null") || {};
  check("将军时弹出「将军」动画", (F.label || "") === "将军" && (F.cls || "").indexOf("check") >= 0, fx);
  check("动画真的在播（xq-stamp）", (F.anim || "").indexOf("xq-stamp") >= 0, "anim=" + F.anim);
  const alertOnPeer = (E.room().state || {}).alert || {};
  check("对手也收到将军信号", alertOnPeer.kind === "check", JSON.stringify(alertOnPeer));
  E.send({ t: "game.leave" });
  await sleep(500);
  E.close();
  await A.goto(BASE + "/#/games", 1600);
} catch (err) {
  check("测试过程没有抛异常", false, String(err && err.message || err));
}

console.log(out.join("\n"));
const bad = out.filter((x) => x.startsWith("FAIL")).length;
console.log("\n=== " + (out.length - bad) + "/" + out.length + " ===");
process.exit(bad ? 1 : 0);
