/* 阶段 T 回归：观战「讨论」悬浮按钮被压扁 · 弹幕全员可见 · 弹幕大战 Phaser 版（体积/能玩/记分/竖屏自适应）
   用法：CDP_PORTS=9336,9337,9338 node features-round-t.mjs
   账号：gt01 / gt02（两位棋手）、cw01（观战者）、ww01（用来验积分，避开 10 秒冷却） */
import fs from 'node:fs';
import path from 'node:path';
import { connect, login, BASE, PORTS } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const out = [];
const check = (name, ok, extra = '') => out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !extra ? '' : '   [' + extra + ']'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = await connect(PORTS[0]);
const B = await connect(PORTS[1]);
const C = await connect(PORTS[2]);
await login(A, 'gt01'); await login(B, 'gt02'); await login(C, 'cw01');

/* 悬浮按钮体检：尺寸 + 文字是否真的显示出来（曾经被讨论区的 .live 全局样式压成 7px 绿点） */
const FAB = "JSON.stringify((function(){var f=document.querySelector('.mc-fab');if(!f)return 'NO-FAB';" +
  "var r=f.getBoundingClientRect();var sp=f.querySelector('span');var sr=sp?sp.getBoundingClientRect():null;" +
  "var cs=getComputedStyle(f);return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),y:Math.round(r.y)," +
  "fs:cs.fontSize,txt:(f.textContent||'').trim().slice(0,6),spanW:sr?Math.round(sr.width):0," +
  "overflow:cs.overflow,bb:cs.borderRadius};})())";
/* 弹幕层里有没有出现这句话 */
const DAN = (kw) => "JSON.stringify([].slice.call(document.querySelectorAll('.danmaku')).map(function(d){return (d.textContent||'').trim();}).filter(function(t){return t.indexOf(" + JSON.stringify(kw) + ")>=0;}))";

try {
  /* ---------------------------------------------------------- 1. 开一局象棋（两人对弈 + 一人观战） */
  const code = String(1000 + Math.floor(Math.random() * 8999));
  await A.goto(BASE + '/#/games', 2400);
  await A.js("__T.clickText('象棋','.game-card')"); await sleep(500);
  await A.js("__T.clickText('创建房间','.room-modal .btn')"); await sleep(400);
  await A.js("__T.setField('.room-modal .code-input','" + code + "')"); await sleep(200);
  await A.js("__T.clickText('创建','.room-modal .btn')"); await sleep(2600);
  await B.goto(BASE + '/#/games', 2400);
  await B.js("__T.clickText('象棋','.game-card')"); await sleep(500);
  await B.js("__T.clickText('加入房间','.room-modal .btn')"); await sleep(400);
  await B.js("__T.setField('.room-modal .code-input','" + code + "')"); await sleep(200);
  await B.js("__T.clickText('加入','.room-modal .btn')"); await sleep(2600);
  await C.goto(BASE + '/#/games', 2400);
  await C.js("(function(){var l=[].slice.call(document.querySelectorAll('.room-card .btn'));var e=l.filter(function(x){return x.textContent.trim()==='观战';})[0];if(e)e.click();return !!e;})()");
  await sleep(2600);
  await A.js("__T.clickText('准备')"); await sleep(600);
  await B.js("__T.clickText('准备')"); await sleep(2200);

  const started = await A.js("!!document.querySelector('.board, canvas, .mc-fab')");
  check('准备完毕、对局开始（三端都在房间里）', started === true, String(started));

  /* ---------------------------------------------------------- 2. 观战/对局中的「讨论」按钮不再被挤 */
  const fa = JSON.parse(await A.js(FAB));
  const fb = JSON.parse(await B.js(FAB));
  const fc = JSON.parse(await C.js(FAB));
  const okFab = (f) => f && f !== 'NO-FAB' && typeof f === 'object' && f.w >= 40 && f.h >= 40 && f.spanW >= 20 && f.txt.indexOf('讨论') >= 0;
  check('观战者：讨论按钮尺寸正常（>=40x40 且文字露出来）', okFab(fc), JSON.stringify(fc));
  check('棋手甲：讨论按钮尺寸正常', okFab(fa), JSON.stringify(fa));
  check('棋手乙：讨论按钮尺寸正常', okFab(fb), JSON.stringify(fb));

  /* ---------------------------------------------------------- 3. 弹幕全员可见 */
  const cOpen = await C.js("(function(){var f=document.querySelector('.mc-fab');if(!f)return 'MISS';f.click();return 'OK';})()");
  await sleep(800);
  await C.js("(function(){var i=document.querySelector('.mc-form .field');if(!i)return 'MISS';" +
    "var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'T观战弹幕一');" +
    "i.dispatchEvent(new Event('input',{bubbles:true}));return 'OK';})()");
  await sleep(450);   /* 等 Vue 把提交按钮的 disabled 解开，同一轮里点是点不动的 */
  const cSend = await C.js("(function(){var b=document.querySelector('.mc-form button[type=submit]');" +
    "if(!b)return 'MISS';if(b.disabled)return 'DISABLED';b.click();return 'OK';})()");
  check('观战者：讨论面板能发消息', cOpen === 'OK' && cSend === 'OK', cOpen + '/' + cSend);
  await sleep(1400);
  const sawA = JSON.parse(await A.js(DAN('T观战弹幕一')));
  const sawB = JSON.parse(await B.js(DAN('T观战弹幕一')));
  const sawC = JSON.parse(await C.js(DAN('T观战弹幕一')));
  check('观战者发的弹幕：棋手甲屏幕上能看到', sawA.length === 1, JSON.stringify(sawA));
  check('观战者发的弹幕：棋手乙屏幕上能看到', sawB.length === 1, JSON.stringify(sawB));
  check('观战者发的弹幕：观战者自己也看得到', sawC.length === 1, JSON.stringify(sawC));

  /* 棋手发一条，观战者也要看得到 */
  await A.js("(function(){var f=document.querySelector('.mc-fab');if(f)f.click();return 'OK';})()");
  await sleep(700);
  await A.js("(function(){var i=document.querySelector('.mc-form .field');if(!i)return 'MISS';" +
    "var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'T棋手弹幕二');" +
    "i.dispatchEvent(new Event('input',{bubbles:true}));return 'OK';})()");
  await sleep(450);
  const aSend = await A.js("(function(){var b=document.querySelector('.mc-form button[type=submit]');" +
    "if(!b||b.disabled)return 'NO';b.click();return 'OK';})()");
  check('棋手甲：讨论面板能发消息', aSend === 'OK', aSend);
  await sleep(1500);
  const sawC2 = JSON.parse(await C.js(DAN('T棋手弹幕二')));
  const sawB2 = JSON.parse(await B.js(DAN('T棋手弹幕二')));
  check('棋手发的弹幕：观战者屏幕上也能看到', sawC2.length === 1, JSON.stringify(sawC2));
  check('棋手发的弹幕：另一位棋手能看到', sawB2.length === 1, JSON.stringify(sawB2));

  /* ---------------------------------------------------------- 4. 退回大厅后弹幕层清空（不留残影） */
  await A.js("location.hash = '#/games'; 'ok'");
  await sleep(1400);
  const danA = JSON.parse(await A.js("JSON.stringify({n:document.querySelectorAll('.danmaku').length,hash:location.hash})"));
  check('离开房间路由后弹幕层立刻清空（不会回到大厅还一直飘旧消息）', danA.n === 0 && danA.hash === '#/games', JSON.stringify(danA));

  /* ---------------------------------------------------------- 4.5 装 JS 错误收集器（后面独立游戏页要用） */
  await C.send('Page.addScriptToEvaluateOnNewDocument', { source:
    "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message||e));});" +
    "window.addEventListener('unhandledrejection',function(e){window.__errs.push('rej:'+String(e.reason));});" });

  /* ---------------------------------------------------------- 5. 弹幕大战：体积（Phaser 版三件套） */
  const dir = path.resolve(HERE, '../../web/games/danmaku');
  const files = fs.readdirSync(dir).sort();
  const gsize = fs.statSync(path.join(dir, 'index.html')).size;
  const phSize = fs.statSync(path.join(dir, 'phaser.min.js')).size;
  const bgmSize = fs.statSync(path.join(dir, 'bgm.mp3')).size;
  check('弹幕大战：三件套齐全（index.html + phaser.min.js + bgm.mp3）',
        JSON.stringify(files) === JSON.stringify(['bgm.mp3', 'index.html', 'phaser.min.js']), JSON.stringify(files));
  check('弹幕大战：index.html 内嵌 BGM（' + (gsize / 1048576).toFixed(1) + 'MB）', gsize > 5 * 1024 * 1024, gsize + ' bytes');
  check('弹幕大战：引擎与回退音源就位（' + (phSize / 1024).toFixed(0) + 'KB / ' + (bgmSize / 1024).toFixed(0) + 'KB）',
        phSize > 500 * 1024 && bgmSize > 3 * 1024 * 1024, phSize + '/' + bgmSize);

  /* ---------------------------------------------------------- 6. 弹幕大战：能玩、能记分（Phaser 版,?autotest=1 钩子验死亡与结算面板） */
  await C.viewport(932, 430, 1);
  await C.goto(BASE + '/games/danmaku/index.html', 2600);
  const boot0 = JSON.parse(await C.js("JSON.stringify({phaser:!!window.Phaser," +
    "cv:(function(){var c=document.getElementById('gameCanvas');return c?[c.clientWidth,c.clientHeight]:null;})()," +
    "over:(function(){var o=document.getElementById('gameOver');return !!o && !o.classList.contains('hidden');})()," +
    "title:document.title})"));
  check('弹幕大战：横屏下正常加载（Phaser 引擎、画布铺开、还没 GAME OVER）',
        boot0.phaser === true && !!boot0.cv && boot0.cv[0] > 600 && boot0.cv[1] > 300 && boot0.over === false,
        JSON.stringify(boot0));
  /* 进页面即开战：自动开火 + 敌人下坠，不动鼠标也会得分，HUD 分数/时间至少有一个在动 */
  const hud1 = JSON.parse(await C.js("JSON.stringify({sc:document.getElementById('scoreEl').textContent," +
    "tm:document.getElementById('timeEl').textContent})"));
  await sleep(2200);
  const hud2 = JSON.parse(await C.js("JSON.stringify({sc:document.getElementById('scoreEl').textContent," +
    "tm:document.getElementById('timeEl').textContent})"));
  check('弹幕大战：真的在跑（HUD 分数/时间在动）', hud2.sc !== hud1.sc || hud2.tm !== hud1.tm,
        JSON.stringify(hud1) + ' -> ' + JSON.stringify(hud2));
  /* 画面在渲染：CDP 整页截图，纯黑屏的 PNG 只有几 KB，有画面的会大得多（截图会强制出一帧新画面，
     不受 WebGL 后缓冲读取语义影响，比 getImageData 稳） */
  const shot = await C.send('Page.captureScreenshot', { format: 'png' });
  const shotSize = shot.result && shot.result.data ? Math.round(shot.result.data.length * 3 / 4) : 0;
  check('弹幕大战：画布确实在画东西（不是黑屏，截图 ' + (shotSize / 1024).toFixed(1) + 'KB）', shotSize > 8000, shotSize + ' bytes');
  const errs = await C.js("JSON.stringify(window.__errs || [])");
  check('弹幕大战：运行期零 JS 报错', errs === '[]', errs);

  /* 结算链路：?autotest=1 载入即 0.6 秒后以 42000 分强制死亡 → GAME OVER 面板弹分 */
  await C.goto(BASE + '/games/danmaku/index.html?autotest=1', 2400);
  const over0 = JSON.parse(await C.js("JSON.stringify({over:(function(){var o=document.getElementById('gameOver');" +
    "return !!o && !o.classList.contains('hidden');})(),sc:document.getElementById('overScore').textContent})"));
  check('弹幕大战：?autotest=1 强制死亡,GAME OVER 面板弹出 SCORE 042000', over0.over === true && over0.sc === 'SCORE 042000',
        JSON.stringify(over0));

  /* 竖屏自适应：画布跟随窗口，不弹遮挡面板也不卡死 */
  await C.viewport(390, 844, 1);
  await sleep(700);
  const por = JSON.parse(await C.js("JSON.stringify({cv:(function(){var c=document.getElementById('gameCanvas');" +
    "return c?[c.clientWidth,c.clientHeight]:null;})(),over:(function(){var o=document.getElementById('gameOver');" +
    "return !!o && !o.classList.contains('hidden');})()})"));
  check('弹幕大战：竖屏自适应（画布跟随窗口，不会卡死）', !!por.cv && por.cv[1] > por.cv[0] && por.cv[0] > 300, JSON.stringify(por));
  await C.viewport(932, 430, 1);

  /* ---------------------------------------------------------- 7. 服务器积分接口（2 万分 = 1 分，上限 10） */
  const tokenW = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ww01', password: 'wwpass1' }) })).json();
  const post = async (tok, score) => (await (await fetch(BASE + '/api/games/solo/points', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.token },
    body: JSON.stringify({ kind: 'danmaku', score: score }) })).json());
  const low = await post(tokenW, 19999);
  check('积分：19999 分不计分（不足 2 万）', low.awarded === 0, JSON.stringify(low));
  const mid = await post(tokenW, 42500);
  check('积分：42500 分记 2 积分', mid.awarded === 2, JSON.stringify(mid));
  await sleep(11000);   /* 服务端 10 秒冷却 */
  const cap = await post(tokenW, 300000);
  check('积分：30 万分封顶 10 积分', cap.awarded === 10, JSON.stringify(cap));

  /* ---------------------------------------------------------- 8. 站点内 iframe 集成 */
  await C.goto(BASE + '/#/games', 2400);
  const openCard = await C.js("(function(){var c=[].slice.call(document.querySelectorAll('.game-card-wide,.game-card')).filter(function(x){return x.textContent.indexOf('弹幕大战')>=0;})[0];if(!c)return 'MISS';c.click();return 'OK';})()");
  await sleep(3000);
  const integ = JSON.parse(await C.js("JSON.stringify({hash:location.hash,frame:document.querySelectorAll('iframe.danmaku-frame').length," +
    "back:(function(){var b=document.querySelector('.danmaku-back');if(!b)return null;var r=b.getBoundingClientRect();return {y:Math.round(r.y),h:Math.round(window.innerHeight),bottom:Math.round(window.innerHeight-r.bottom)};})()})"));
  check('弹幕大战：从大厅点进去能打开（路由 + iframe）', openCard === 'OK' && integ.hash === '#/games/danmaku' && integ.frame === 1, openCard + ' ' + JSON.stringify(integ));
  const inner2 = JSON.parse(await C.js("JSON.stringify((function(){var f=document.querySelector('iframe.danmaku-frame');var d=f.contentDocument;if(!d)return 'NO-DOC';return {cv:d.querySelectorAll('canvas').length,title:d.title,tag:(function(){var t=d.getElementById('playerTag');return t&&!t.classList.contains('hidden')?t.textContent:null;})()};})())"));
  check('弹幕大战：iframe 里 Phaser 游戏真的起来了', inner2 !== 'NO-DOC' && inner2.cv === 1 && /弹幕大战/.test(inner2.title || ''), JSON.stringify(inner2));
  check('弹幕大战：宿主把玩家身份推给游戏内角标', typeof inner2.tag === 'string' && inner2.tag.indexOf('积分') >= 0, JSON.stringify(inner2.tag));
  check('弹幕大战：返回键让开了右上角 HUD，落在屏幕左下', !!integ.back && integ.back.bottom < 90, JSON.stringify(integ.back));
  /* 宿主结算链路：iframe 内 ?autotest=1 强制死亡 → postMessage 上报 → 服务端 +2 积分 → toast */
  await C.js("(function(){var f=document.querySelector('iframe.danmaku-frame');f.contentWindow.location.search='?autotest=1';return 'ok';})()");
  await sleep(3200);
  const ov2 = JSON.parse(await C.js("JSON.stringify((function(){var f=document.querySelector('iframe.danmaku-frame');var d=f.contentDocument;if(!d)return 'NO-DOC';var o=d.getElementById('gameOver');return {over:!!o&&!o.classList.contains('hidden'),sc:d.getElementById('overScore').textContent};})())"));
  check('弹幕大战：iframe 里 GAME OVER 面板弹出 SCORE 042000', ov2.over === true && ov2.sc === 'SCORE 042000', JSON.stringify(ov2));
  const toastTxt = await C.js("JSON.stringify([].slice.call(document.querySelectorAll('.toasts .toast')).map(function(t){return t.textContent.trim();}))");
  check('弹幕大战：宿主办完结算会弹出积分提示', /积分/.test(toastTxt), toastTxt);
  await C.js("(function(){var e=document.querySelector('.danmaku-back');if(e)e.click();return 'ok';})()");
  await sleep(900);
  check('弹幕大战：能正常返回游戏大厅', (await C.js('location.hash')) === '#/games', await C.js('location.hash'));
  await C.clearViewport();

} catch (err) {
  out.push('FAIL  用例异常: ' + err.message);
}

const passed = out.filter((l) => l.startsWith('PASS')).length;
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(out.join('\n'));
console.log('\n=== ' + passed + '/' + (passed + failed) + ' ===');
process.exit(failed ? 1 : 0);
