import { connect, login, BASE, PORTS } from './harness.mjs';
const P = { a: await connect(PORTS[0]), b: await connect(PORTS[1]), c: await connect(PORTS[2]) };
const out = [];
const log = (...a) => out.push(a.join(' '));
try {
  await login(P.a, 'gt01'); await login(P.b, 'gt02'); await login(P.c, 'cw01');
  const code = String(1000 + Math.floor(Math.random() * 8999));
  log('房间号 ' + code);
  await P.a.goto(BASE + '/#/games', 2200);
  await P.a.js("__T.clickText('井字棋','.game-card')"); await P.a.sleep(400);
  await P.a.js("__T.clickText('创建房间')"); await P.a.sleep(400);
  await P.a.js("__T.setField('.code-input','" + code + "')"); await P.a.sleep(200);
  await P.a.js("__T.clickText('创建')"); await P.a.sleep(2400);
  await P.b.goto(BASE + '/#/games', 2000);
  await P.b.js("__T.clickExact('加入','.room-card .btn')"); await P.b.sleep(2400);
  await P.c.goto(BASE + '/#/games', 2200);
  await P.c.js("(function(){var l=[].slice.call(document.querySelectorAll('button'));var e=l.filter(function(x){return x.textContent.trim()==='观战';})[0];if(e)e.click();return !!e;})()");
  await P.c.sleep(2400);
  log('三方就位 A:', await P.a.js('location.hash.slice(-4)'), 'B:', await P.b.js('location.hash.slice(-4)'), 'C观战:', await P.c.js("document.body.innerText.indexOf('观战模式')>=0"));
  await P.a.dismiss();
  log('A 点准备:', await P.a.js("__T.clickExact('准备')"));
  await P.a.sleep(900);
  log('  开局了吗(应未):', await P.a.js("document.querySelectorAll('.cell .stone').length"), '| A提示:', await P.a.js("document.body.innerText.split(String.fromCharCode(10)).filter(function(l){return l.indexOf('已准备')>=0;})[0]||''"));
  log('  B看到A已准备:', await P.b.js("document.body.innerText.indexOf('已准备')>=0"));
  log('B 点准备:', await P.b.js("__T.clickExact('准备')"));
  await P.b.sleep(1500);
  log('  开局了吗(应该开局):', await P.a.js("JSON.stringify({started:document.body.innerText.indexOf('落子')>=0||document.body.innerText.indexOf('等待对手落子')>=0, cells:document.querySelectorAll('.cell').length})"));
  for (const [who, i] of [['A',0],['B',3],['A',1],['B',4],['A',2]]) {
    const p = (who === 'A') ? P.a : P.b;
    await p.clickSel('.board .cell', i); await p.sleep(600);
  }
  await P.a.sleep(900);
  log('观战者C结束态:', await P.c.js("JSON.stringify({overlay:document.querySelectorAll('.overlay').length, txt:(document.querySelector('.overlay')||{textContent:''}).textContent, hasRematch:document.body.innerText.indexOf('再来一局')>=0, toast:[].slice.call(document.querySelectorAll('.toast')).map(function(t){return t.textContent;}).join('|')})"));
  log('C 返回按钮:', await P.c.js("(function(){var e=document.querySelector('.page-plain button.btn-icon');if(!e)return 'MISS';e.click();return 'OK';})()"));
  await P.c.sleep(700);
  log('C 弹窗文案:', await P.c.js("JSON.stringify({hasText:document.body.innerText.indexOf('确定退出观战吗')>=0, hasOld:document.body.innerText.indexOf('不会保存')>=0, txt:123})"));
} catch (e) { log('ERR ' + e.message); }
console.log(out.join('\n'));
process.exit(0);
