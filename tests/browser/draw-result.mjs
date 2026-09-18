import { connect, login, BASE, PORTS } from './harness.mjs';
const P = { a: await connect(PORTS[0]), b: await connect(PORTS[1]), c: await connect(PORTS[2]) };
const out = []; const log = (...a) => out.push(a.join(' '));
try {
  await login(P.a, 'gt01'); await login(P.b, 'gt02'); await login(P.c, 'cw01');
  const code = String(5000 + Math.floor(Math.random() * 4999));
  log('房间号 ' + code);
  await P.a.goto(BASE + '/#/games', 2200);
  await P.a.js("__T.clickText('井字棋','.game-card')"); await P.a.sleep(400);
  await P.a.js("__T.clickText('创建房间')"); await P.a.sleep(400);
  await P.a.js("__T.setField('.code-input','" + code + "')"); await P.a.sleep(200);
  await P.a.js("__T.clickText('创建')"); await P.a.sleep(2400);
  await P.b.goto(BASE + '/#/games', 2000);
  await P.b.js("__T.clickExact('加入','.room-card .btn')"); await P.b.sleep(2400);
  await P.c.goto(BASE + '/#/games', 2200);
  await P.c.js("__T.clickExact('观战','.room-card .btn')"); await P.c.sleep(2400);
  await P.a.dismiss();
  await P.a.js("__T.clickExact('准备')"); await P.a.sleep(600);
  await P.b.js("__T.clickExact('准备')"); await P.b.sleep(1600);
  log('开局格数: ' + await P.a.js("document.querySelectorAll('.cell').length"));
  const seq = [['a', 0], ['b', 4], ['a', 8], ['b', 2], ['a', 6], ['b', 3], ['a', 5], ['b', 7], ['a', 1]];
  for (const [who, i] of seq) { await P[who].clickSel('.board .cell', i); await P[who].sleep(650); }
  await P.a.sleep(1200);
  log('A(玩家)结束: ' + await P.a.js("JSON.stringify({ov:(document.querySelector('.overlay')||{textContent:''}).textContent})"));
  log('C(观战)结束: ' + await P.c.js("JSON.stringify({ov:(document.querySelector('.overlay')||{textContent:''}).textContent, toast:[].slice.call(document.querySelectorAll('.toast')).map(function(t){return t.textContent;}).join('|'), hasRematchBtn:[].slice.call(document.querySelectorAll('.overlay button')).map(function(b){return b.textContent.trim();}).join('/')})"));
} catch (e) { log('ERR ' + e.message); }
console.log(out.join('\n'));
process.exit(0);
