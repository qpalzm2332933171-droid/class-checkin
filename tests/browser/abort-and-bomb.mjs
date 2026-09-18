import { connect, login, BASE, PORTS } from './harness.mjs';
const P = { a: await connect(PORTS[0]), b: await connect(PORTS[1]), c: await connect(PORTS[2]) };
const out = []; const log = (...a) => out.push(a.join(' '));
const BACK = "(function(){var e=document.querySelector('.page-plain button.btn-icon');if(!e)return 'MISS';e.click();return 'OK';})()";
const OV = "JSON.stringify({overlay:document.querySelectorAll('.overlay').length, txt:(document.querySelector('.overlay')||{textContent:''}).textContent, bottom:document.body.innerText.indexOf('再来一局')>=0, quit:document.body.innerText.indexOf('退出观战')>=0, toast:[].slice.call(document.querySelectorAll('.toast')).map(function(t){return t.textContent;}).join('|')})";
const RANGE = "(function(){var m=document.body.innerText.match(/安全区间 (\\d+) ~ (\\d+)/);var rows=[].slice.call(document.querySelectorAll('.list-row')).filter(function(r){return r.querySelector('.num');});var h=rows[0];return JSON.stringify({lo:m?+m[1]:null,hi:m?+m[2]:null,n:h?+h.querySelector('.num').textContent:null,dir:h?h.querySelector('.chip').textContent:null});})()";
async function createRoom(page, code, game) {
  await page.goto(BASE + '/#/games', 2200);
  await page.js("__T.clickText('" + game + "','.game-card')"); await page.sleep(400);
  await page.js("__T.clickText('创建房间')"); await page.sleep(400);
  await page.js("__T.setField('.code-input','" + code + "')"); await page.sleep(200);
  await page.js("__T.clickText('创建')"); await page.sleep(2400);
}
try {
  await login(P.a, 'gt01'); await login(P.b, 'gt02'); await login(P.c, 'cw01');
  const code = String(2000 + Math.floor(Math.random() * 7999));
  log('场景1 房间号 ' + code);
  await createRoom(P.a, code, '井字棋');
  await P.b.goto(BASE + '/#/games', 2000);
  await P.b.js("__T.clickExact('加入','.room-card .btn')"); await P.b.sleep(2400);
  await P.c.goto(BASE + '/#/games', 2200);
  await P.c.js("__T.clickExact('观战','.room-card .btn')"); await P.c.sleep(2400);
  await P.a.dismiss();
  await P.a.js("__T.clickExact('准备')"); await P.a.sleep(600);
  await P.b.js("__T.clickExact('准备')"); await P.b.sleep(1500);
  log('  开局格数: ' + await P.a.js("document.querySelectorAll('.cell').length"));
  await P.b.js(BACK); await P.b.sleep(600);
  log('  B回弹窗: ' + await P.b.js("document.body.innerText.indexOf('确定离开房间吗')>=0"));
  await P.b.js("__T.clickExact('离开房间','.modal button')"); await P.b.sleep(1600);
  log('  观战者C中止态: ' + await P.c.js(OV));
  log('  A(玩家)中止态: ' + await P.a.js(OV));
  await P.c.js(BACK); await P.c.sleep(700);
  log('  C退回弹窗: ' + await P.c.js("JSON.stringify({new:document.body.innerText.indexOf('确定退出观战吗')>=0, old:document.body.innerText.indexOf('不会保存')>=0})"));
  await P.c.js("__T.clickExact('退出观战','.modal button')"); await P.c.sleep(1200);
  const code2 = String(3000 + Math.floor(Math.random() * 6999));
  log('场景2 房间号 ' + code2);
  await createRoom(P.a, code2, '数字炸弹');
  await P.b.goto(BASE + '/#/games', 2000);
  await P.b.js("__T.clickExact('加入','.room-card .btn')"); await P.b.sleep(2400);
  await P.a.dismiss();
  await P.a.js("__T.clickExact('准备')"); await P.a.sleep(600);
  await P.b.js("__T.clickExact('准备')"); await P.b.sleep(1600);
  log('  开局: ' + await P.a.js("document.body.innerText.indexOf('安全区间')>=0 && document.querySelectorAll('.field[type=number]').length>0"));
  let bad = 0;
  for (let round = 0; round < 3; round++) {
    const pre = JSON.parse(await P.a.js(RANGE));
    if (pre.lo === null) { log('  第' + (round + 1) + '轮 已无区间'); break; }
    const target = Math.floor((pre.lo + pre.hi) / 2);
    let guesser = null;
    for (const who of ['a', 'b']) {
      const st = await P[who].js("(function(){var el=document.querySelector('.field[type=number]');return el?String(!!el.disabled):'NONE';})()");
      if (st === 'false') { guesser = who; break; }
    }
    if (!guesser) { log('  第' + (round + 1) + '轮 无人可报数'); break; }
    await P[guesser].js("(function(){var el=document.querySelector('.field[type=number]');var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'" + target + "');el.dispatchEvent(new Event('input',{bubbles:true}));return 'OK';})()");
    await P[guesser].sleep(300);
    await P[guesser].js("__T.clickExact('报数')");
    await P[guesser].sleep(1200);
    const post = JSON.parse(await P[guesser].js(RANGE));
    const okDir = (post.dir === '偏大' && post.hi === target && post.lo === pre.lo) || (post.dir === '偏小' && post.lo === target && post.hi === pre.hi);
    const ended = await P[guesser].js("document.querySelectorAll('.overlay').length");
    if (!okDir) bad++;
    log('  第' + (round + 1) + '轮 ' + guesser + ' 报 ' + target + ' 区间[' + pre.lo + ',' + pre.hi + '] -> [' + post.lo + ',' + post.hi + '] 标记=' + post.dir + ' 一致=' + okDir + ' 结束浮层=' + ended);
    if (ended) break;
  }
  log('  方向一致性判定: ' + (bad === 0 ? 'PASS' : 'FAIL(' + bad + ')'));
} catch (e) { log('ERR ' + e.message); }
console.log(out.join('\n'));
process.exit(0);
