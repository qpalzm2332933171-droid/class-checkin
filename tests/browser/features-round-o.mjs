/* 阶段 O 浏览器回归：围棋 / 象棋 / 狼人杀 三个新房间 + 排行榜有头像能显示。
   前置：无头 Edge 已开 CDP（默认 9336），本地服务在 8081。
   用法：cd tests/browser && node features-round-o.mjs */
import { connect, login, BASE } from "./harness.mjs";

const PORT = Number(process.env.CDP_PORT || 9336);
const page = await connect(PORT);
const results = [];
function check(name, ok) { results.push([name, !!ok]); }

async function clickCard(name) {
  return page.js("(function(){var l=[].slice.call(document.querySelectorAll('.game-card'));"
    + "var e=l.filter(function(x){return (x.textContent||'').indexOf(" + JSON.stringify(name) + ")>=0;})[0];"
    + "if(!e)return 'MISS';e.click();return 'OK';})()");
}

async function createRoom() {
  await page.sleep(500);
  const a = await page.js("__T.clickExact('创建房间');");
  await page.sleep(600);
  const b = await page.js("__T.clickExact('创建');");
  await page.sleep(2500);
  return a + "/" + b;
}

await login(page, "gt01", "/games");
await page.js("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message));});'ok'");

const lobby = await page.js("document.body.textContent");
check("游戏大厅列出围棋", /围棋/.test(lobby));
check("游戏大厅列出象棋", /象棋/.test(lobby));
check("游戏大厅列出狼人杀", /狼人杀/.test(lobby));

/* ---------- 排行榜：有头像的用户也要能看到内容 ---------- */
await page.js("document.querySelector('.pt-chip').click();'ok'");
await page.sleep(1800);
const lb = await page.js("(function(){var m=document.querySelector('.modal');if(!m)return 'NOMODAL';"
  + "var rows=m.querySelectorAll('.list-row,.lb-row,li');return (m.textContent||'').trim().slice(0,80)+' | rows='+rows.length;})()");
check("排行榜弹窗能打开且不是空的", lb !== "NOMODAL" && !/NOMODAL/.test(lb) && /rows=[1-9]/.test(lb));
await page.dismiss();
await page.sleep(600);

/* ---------- 象棋 ---------- */
check("点象棋卡片弹出创建/加入", (await clickCard("象棋")) === "OK");
check("选择创建房间", /OK/.test(await createRoom()));
await page.sleep(1200);
const hashXq = await page.js("location.hash");
check("象棋进入 /games/xiangqi", String(hashXq).indexOf("#/games/xiangqi") === 0);
const xq = await page.js("(function(){return JSON.stringify({cells:document.querySelectorAll('.xq-cell').length,"
  + "pieces:document.querySelectorAll('.xq-piece').length,"
  + "river:!!document.querySelector('.xq-river'),"
  + "code:(document.querySelector('.code-btn')||{}).textContent||''});})()");
const XQ = JSON.parse(xq);
check("象棋棋盘 90 个交叉点", XQ.cells === 90);
check("象棋开局 32 枚棋子", XQ.pieces === 32);
check("象棋显示楚河汉界", XQ.river);
check("象棋显示四位房间号", /^房间 \d{4}$/.test((XQ.code || "").trim()));
const xqErr = await page.js("JSON.stringify(window.__errs||[])");
check("象棋页面没有报错", xqErr === "[]");

/* ---------- 围棋 ---------- */
await page.goto(BASE + "/#/games", 2200);
await page.js("window.__errs=[];'ok'");
check("点围棋卡片弹出创建/加入", (await clickCard("围棋")) === "OK");
check("围棋创建房间", /OK/.test(await createRoom()));
await page.sleep(1200);
const go = await page.js("(function(){return JSON.stringify({hash:location.hash,"
  + "cells:document.querySelectorAll('.cell').length,"
  + "pass:!!document.querySelector('button'),"
  + "text:(document.body.textContent||'')});})()");
const GO = JSON.parse(go);
check("围棋进入 /games/board", String(GO.hash).indexOf("#/games/board") === 0);
check("围棋棋盘 81 个落点", GO.cells === 81);
check("围棋页面提示停一手/认输", /停一手/.test(GO.text) && /认输/.test(GO.text));
check("围棋页面没有报错", (await page.js("JSON.stringify(window.__errs||[])")) === "[]");

/* ---------- 狼人杀 ---------- */
await page.goto(BASE + "/#/games", 2200);
await page.js("window.__errs=[];'ok'");
check("点狼人杀卡片弹出创建/加入", (await clickCard("狼人杀")) === "OK");
check("狼人杀创建房间", /OK/.test(await createRoom()));
await page.sleep(1400);
const ww = await page.js("(function(){return JSON.stringify({hash:location.hash,"
  + "seats:document.querySelectorAll('.seat').length,"
  + "text:(document.body.textContent||'').slice(0,400)});})()");
const WW = JSON.parse(ww);
check("狼人杀进入 /games/werewolf", String(WW.hash).indexOf("#/games/werewolf") === 0);
check("狼人杀显示人数和板子", /人局 · \d狼 \d民/.test(WW.text) && /还差 \d 人开局/.test(WW.text));
check("狼人杀未开局也能看到座位", WW.seats >= 1);
check("狼人杀显示准备按钮", /准备/.test(WW.text));
check("狼人杀页面没有报错", (await page.js("JSON.stringify(window.__errs||[])")) === "[]");

/* ---------- 收尾 ---------- */
await page.goto(BASE + "/#/games", 1500);
await page.js("window.__errs=[];'ok'");
await page.sleep(600);

const ok = results.filter((r) => r[1]).length;
for (const [n, o] of results) console.log((o ? "PASS  " : "FAIL  ") + n);
console.log("=== " + ok + "/" + results.length + " ===");
page.close();
process.exit(ok === results.length ? 0 : 1);
