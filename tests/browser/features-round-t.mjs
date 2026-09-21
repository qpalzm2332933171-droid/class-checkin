/* 阶段 T 回归：观战「讨论」悬浮按钮被压扁 · 弹幕全员可见 · 弹幕大战重写（体积/横屏/能玩/记分）
   用法：CDP_PORTS=9336,9337,9338 node features-round-t.mjs
   账号：gt01 / gt02（两位棋手）、cw01（观战者）、ww01（用来验积分，避开 10 秒冷却）
   口令走环境变量：SOLO_USER / SOLO_PASS（默认 ww01，口令不写进仓库）、ADMIN_PASS、STAFF_PASS */
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

  /* ---------------------------------------------------------- 5. 弹幕大战：体积 */
  const dir = path.resolve(HERE, '../../web/games/danmaku');
  const files = fs.readdirSync(dir);
  const size = fs.statSync(path.join(dir, 'index.html')).size;
  check('弹幕大战：整包只剩一个 index.html（Phaser 已删）', files.length === 1 && files[0] === 'index.html', JSON.stringify(files));
  check('弹幕大战：体积 ' + (size / 1024).toFixed(1) + 'KB（要求 <=257KB）', size <= 257 * 1024, size + ' bytes');

  /* ---------------------------------------------------------- 6. 弹幕大战：能玩、能记分（页面内 ?test=1 钩子） */
  await C.viewport(932, 430, 1);
  await C.goto(BASE + '/games/danmaku/index.html?test=1', 1800);
  const boot0 = JSON.parse(await C.js("JSON.stringify({hook:!!window.__dm,cv:[document.getElementById('cv').clientWidth,document.getElementById('cv').clientHeight],menu:!document.getElementById('menu').hidden,rot:document.getElementById('rotate').hidden,title:document.title})"));
  check('弹幕大战：横屏下正常加载（画布铺开、菜单可见、不弹竖屏提示）',
        boot0.hook === true && boot0.cv[0] > 600 && boot0.cv[1] > 300 && boot0.menu === true && boot0.rot === true, JSON.stringify(boot0));
  await C.clickSel('#go'); await sleep(600);
  let st = JSON.parse(await C.js("JSON.stringify(window.__dm.st())"));
  check('弹幕大战：点开始进入战斗状态', st.state === 'play', JSON.stringify(st));
  /* 左右小幅度摆动扫怪。
     注意别用大幅横扫：操控是「相对位移 + 撞墙截断」，一次拖 588px 会把飞船死死顶在左右墙上，
     子弹只从墙边往上升，中间落下来的怪反而一个都打不到（本轮就偶发过一次 kills=0）。 */
  const midX = 466;
  for (let i = 0; i < 5 && st.kills === 0; i++) {
    await C.mouse('mousePressed', midX, 340);
    for (let k = 1; k <= 10; k++) { await C.mouse('mouseMoved', midX - k * 20, 340); await sleep(40); }
    await C.mouse('mouseReleased', midX - 200, 340);
    await sleep(200);
    await C.mouse('mousePressed', midX, 340);
    for (let k = 1; k <= 10; k++) { await C.mouse('mouseMoved', midX + k * 20, 340); await sleep(40); }
    await C.mouse('mouseReleased', midX + 200, 340);
    await sleep(650);
    st = JSON.parse(await C.js("JSON.stringify(window.__dm.st())"));
  }
  check('弹幕大战：真的能打（拖动操控 + 自动开火能击破，得分 ' + st.score + '）', st.kills > 0 && st.score > 0, JSON.stringify(st));
  const ink = await C.js("JSON.stringify((function(){var c=document.getElementById('cv');var g=c.getContext('2d');" +
    "var d=g.getImageData(0,0,c.width,c.height).data;var n=0;for(var i=3;i<d.length;i+=4*53){if(d[i]>8)n++;}return n;})())");
  check('弹幕大战：画布确实在画东西（不是黑屏）', Number(ink) > 20, ink);
  const errs = await C.js("JSON.stringify(window.__errs || [])");
  check('弹幕大战：运行期零 JS 报错', errs === '[]', errs);

  /* 结算上报：分数 -> 积分（2 万分 = 1 分） */
  await C.js("window.__dm.set({score:42500});'ok'");
  await C.js("window.__dm.over();'ok'");
  await sleep(400);
  const over = JSON.parse(await C.js("JSON.stringify({over:!document.getElementById('over').hidden,sc:document.getElementById('ovScore').textContent,aw:document.getElementById('ovAward').textContent,sent:window.__dm.st().sent})"));
  const posted = over.sent.filter((m) => m && m.type === 'danmaku-score' && m.score === 42500);
  check('弹幕大战：GAME OVER 会把分数 postMessage 给宿主', posted.length === 1, JSON.stringify(over.sent));
  check('弹幕大战：结算面板显示分数与 +2 积分', over.over === true && over.sc === '42500' && over.aw.indexOf('+2') >= 0, over.sc + ' / ' + over.aw);

  /* 竖屏要有引导，但不能卡死玩家 */
  await C.viewport(390, 844, 1);
  await sleep(500);
  const rot = JSON.parse(await C.js("JSON.stringify({rot:!document.getElementById('rotate').hidden,w:document.getElementById('cv').clientWidth,h:document.getElementById('cv').clientHeight})"));
  check('弹幕大战：竖屏会提示横屏', rot.rot === true && rot.h > rot.w, JSON.stringify(rot));
  await C.clickSel('#rotSkip'); await sleep(400);
  const rot2 = await C.js("document.getElementById('rotate').hidden");
  check('弹幕大战：竖屏也能继续玩（有退路，不会卡住）', rot2 === true, String(rot2));
  await C.viewport(932, 430, 1);

  /* ---------------------------------------------------------- 7. 服务器积分接口（2 万分 = 1 分，上限 10） */
  const tokenW = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.SOLO_USER || 'ww01', password: process.env.SOLO_PASS || '' }) })).json();
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
  const inner2 = JSON.parse(await C.js("JSON.stringify((function(){var f=document.querySelector('iframe.danmaku-frame');var d=f.contentDocument;return {cv:d.querySelectorAll('canvas').length,title:d.title,menu:!d.getElementById('menu').hidden};})())"));
  check('弹幕大战：iframe 里游戏真的起来了', inner2.cv === 1 && inner2.menu === true, JSON.stringify(inner2));
  check('弹幕大战：返回键让开了右上角 HUD，落在屏幕左下', !!integ.back && integ.back.bottom < 90, JSON.stringify(integ.back));
  /* 宿主结算链路：模拟 iframe 上报分数 */
  await C.js("(function(){var f=document.querySelector('iframe.danmaku-frame');f.contentWindow.location.search='?test=1';return 'ok';})()");
  await sleep(2200);
  const hook2 = await C.js("(function(){var f=document.querySelector('iframe.danmaku-frame');return !!(f.contentWindow.__dm);})()");
  check('弹幕大战：iframe 里能挂上测试钩子（真·端到端上报用）', hook2 === true, String(hook2));
  await C.js("(function(){var f=document.querySelector('iframe.danmaku-frame');f.contentWindow.__dm.set({score:42500});f.contentWindow.__dm.over();return 'ok';})()");
  await sleep(2200);
  const toastTxt = await C.js("JSON.stringify([].slice.call(document.querySelectorAll('.toasts .toast')).map(function(t){return t.textContent.trim();}))");
  check('弹幕大战：宿主办完结算会弹出积分提示', /积分/.test(toastTxt), toastTxt);
  await C.js("(function(){var e=document.querySelector('.danmaku-back');if(e)e.click();return 'ok';})()");
  await sleep(900);
  check('弹幕大战：能正常返回游戏大厅', (await C.js('location.hash')) === '#/games', await C.js('location.hash'));
  await C.clearViewport();

  /* ---------------------------------------------------------- 9. 2048：16 个背景块必须各就各位（曾经全叠在左上角 → 黑块，见 #1） */
  await A.viewport(420, 860);
  await A.goto(BASE + '/?t=' + Date.now() + '#/games/2048', 2400);
  const b2048 = JSON.parse(await A.js("JSON.stringify((function(){var cs=[].slice.call(document.querySelectorAll('.cell-bg'));" +
    "if(!cs.length)return {n:0};var rs=cs.map(function(e){var b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top)].join(',');});" +
    "var u={};rs.forEach(function(x){u[x]=1;});var r0=rs[0];var stack=rs.filter(function(x){return x===r0;}).length;" +
    "return {n:cs.length,uniq:Object.keys(u).length,stack:stack,bg:getComputedStyle(cs[0]).backgroundColor};})())"));
  check('2048：16 个背景块各自独立定位（不再叠成左上角黑块）', b2048.n === 16 && b2048.uniq === 16 && b2048.stack === 1, JSON.stringify(b2048));
  check('2048：单个背景块只有 10% 白（没有叠成不透明黑）', b2048.bg === 'rgba(255, 255, 255, 0.1)', String(b2048.bg));
  await A.dismiss();
  await A.clearViewport();

} catch (err) {

  out.push('FAIL  用例异常: ' + err.message);
}

const passed = out.filter((l) => l.startsWith('PASS')).length;
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(out.join('\n'));
console.log('\n=== ' + passed + '/' + (passed + failed) + ' ===');
process.exit(failed ? 1 : 0);
