import { connect, login, BASE, PORTS } from './harness.mjs';
const P = { a: await connect(PORTS[0]) };
const out = []; const log = (...a) => out.push(a.join(' '));
const AUTO = "localStorage.setItem('chat_anon_mode','0');'ok'";
try {
  await login(P.a, 'gt01');
  const stamp = String(Date.now()).slice(-6);

  // ---------- A. 讨论：默认实名 + 匿名开关 ----------
  await P.a.goto(BASE + '/#/chat', 2600);
  await P.a.js(AUTO);
  await P.a.goto(BASE + '/#/chat', 2400);
  log('A1 主界面开关:', await P.a.js("(function(){var b=document.querySelector('.anon-pill');return b?b.textContent.trim()+'|on='+b.classList.contains('on'):'MISS';})()"));
  log('A2 副标题:', await P.a.js("(function(){var p=document.querySelector('.page .sub');return p?p.textContent.trim():'MISS';})()"));
  await P.a.js("__T.clickText('','.topic-card')");  // 打开第一个话题
  await P.a.sleep(2000);
  log('A3 进入话题:', await P.a.js("location.hash"));
  const send = async (text) => {
    await P.a.js("__T.setField('.composer .field','" + text + "')");
    await P.a.sleep(250);
    await P.a.js("__T.clickExact('','.composer .send')");
    await P.a.sleep(1400);
  };
  await send('REAL-' + stamp);
  log('A4 实名发送后 composer 状态:', await P.a.js("(function(){var b=document.querySelector('.anon-toggle');return b?b.textContent.trim():'MISS';})()"));
  await P.a.js("(function(){var b=document.querySelector('.anon-toggle');if(b){b.click();return 'ok';}return 'miss';})()");
  await P.a.sleep(500);
  await send('ANON-' + stamp);
  log('A5 切换后 composer 状态:', await P.a.js("(function(){var b=document.querySelector('.anon-toggle');return b?b.textContent.trim():'MISS';})()"));
  const q = await P.a.js("(async function(){var r=await fetch('/api/chat/search?q=" + stamp + "',{headers:{Authorization:'Bearer '+localStorage.getItem('checkin_token')}});var j=await r.json();return JSON.stringify((j.messages||[]).map(function(m){return {c:m.content.slice(0,5),name:m.name,anon:m.anon};}));})()");
  log('A6 服务端记录:', q);
  await P.a.goto(BASE + '/#/chat', 2400);
  log('A7 返回列表后开关仍是匿名:', await P.a.js("(function(){var b=document.querySelector('.anon-pill');return b?(b.textContent.trim()+'|on='+b.classList.contains('on')):'MISS';})()"));

  // ---------- B. 游戏大厅：积分 + 排行榜 ----------
  await P.a.goto(BASE + '/#/games', 2600);
  log('B1 头部积分:', await P.a.js("(function(){var b=document.querySelector('.pt-chip');return b?b.textContent.trim():'MISS';})()"));
  await P.a.js("__T.clickText('联机榜')");
  await P.a.sleep(1500);
  log('B2 联机榜:', await P.a.js("(function(){var m=document.querySelector('.board-modal');if(!m)return 'MISS';var rows=m.querySelectorAll('.board-list .list-row');var first=rows[0];return JSON.stringify({rows:rows.length,first:first?first.textContent.replace(/\\s+/g,' ').trim():'',tip:m.querySelector('.cap').textContent.slice(0,18)});})()"));
  await P.a.js("__T.clickText('单机榜')");
  await P.a.sleep(1200);
  log('B3 单机榜:', await P.a.js("(function(){var m=document.querySelector('.board-modal');if(!m)return 'MISS';var rows=m.querySelectorAll('.board-list .list-row');return JSON.stringify({rows:rows.length,me:(m.querySelector('.list-row.me')||{textContent:''}).textContent.replace(/\\s+/g,' ').trim().slice(0,30)});})()"));

  // ---------- C. 扫雷难度 ----------
  await P.a.goto(BASE + '/#/games/mine', 2600);
  log('C1 进入即有难度选择:', await P.a.js("!!document.querySelector('.pick-modal')"));
  log('C2 难度选项:', await P.a.js("[].slice.call(document.querySelectorAll('.diff-card')).map(function(b){return b.textContent.replace(/\\s+/g,' ').trim();}).join(' / ')"));
  await P.a.js("__T.clickText('正常','.diff-card')");
  await P.a.sleep(1200);
  log('C3 正常 12x12:', await P.a.js("JSON.stringify({cells:document.querySelectorAll('.mine-cell').length, n:getComputedStyle(document.querySelector('.mine-board')).getPropertyValue('--n').trim(), hint:document.querySelectorAll('.row.gap3.mt5 button')[1].disabled})"));
  await P.a.js("(function(){var b=document.querySelector('.head .chip');if(b){b.click();return 'ok';}return 'miss';})()");
  await P.a.sleep(800);
  await P.a.js("__T.clickText('简单','.diff-card')");
  await P.a.sleep(1200);
  log('C4 简单 9x9 且可提示:', await P.a.js("JSON.stringify({cells:document.querySelectorAll('.mine-cell').length, n:getComputedStyle(document.querySelector('.mine-board')).getPropertyValue('--n').trim(), hint:document.querySelectorAll('.row.gap3.mt5 button')[1].disabled, label:document.querySelectorAll('.row.gap3.mt5 button')[1].textContent.trim()})"));
  await P.a.js("(function(){var b=document.querySelectorAll('.row.gap3.mt5 button')[1];b.click();return 'ok';})()");
  await P.a.sleep(900);
  log('C5 提示一格效果:', await P.a.js("JSON.stringify({opened:document.querySelectorAll('.mine-cell.open').length, state:document.querySelector('.result')?'结束':'进行中'})"));

  // ---------- D. 更新日志 ----------
  await P.a.goto(BASE + '/#/changelog', 2400);
  log('D1 更新日志页:', await P.a.js("(function(){var h=document.querySelector('h1,h2');return JSON.stringify({title:(document.querySelector('.t2')||{}).textContent, cards:document.querySelectorAll('.log-card').length, adminBtn:[].slice.call(document.querySelectorAll('button')).some(function(b){return b.textContent.trim()==='写一条';})});})()"));
  log('D2 错误提示:', await P.a.js("JSON.stringify([].slice.call(document.querySelectorAll('.toast')).map(function(t){return t.className+':'+t.textContent.slice(0,24);}))"));
} catch (e) { log('ERR ' + e.message); }
console.log(out.join('\n'));
process.exit(0);
