/* 阶段 S 回归：五子棋/围棋开局自动播放背景音乐 + 关闭按钮 + 井字棋不播 +
   音乐开关记忆 + 对局结束自动停。弹幕大战插件式游戏的路由与积分也在里面顺手验一下。
   用法：CDP_PORTS=9336,9337,9338 node features-round-s.mjs
   账号：accounts.json 里的 gt01 / gt02（两个玩家）、cw01（第三个页面，跑井字棋对照） */
import { connect, login, BASE, PORTS, HELPERS } from './harness.mjs';

const out = [];
const check = (name, ok, extra = '') => out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !extra ? '' : '   [' + extra + ']'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = await connect(PORTS[0]);
const B = await connect(PORTS[1]);
const C = await connect(PORTS[2]);

/* 页面上查背景音乐元素：bgm.js 把 <audio data-bgm> 挂在文档里，方便直接读状态 */
const AUDIO = "JSON.stringify((function(){var a=document.querySelector('audio[data-bgm]');" +
  "return a?{paused:a.paused,loop:a.loop,src:a.src,time:a.currentTime,ready:a.readyState}:null;})())";
const BTN = "JSON.stringify((function(){var b=document.querySelector('.bgm-toggle');" +
  "return b?{on:true,cls:b.className,label:b.getAttribute('aria-label')}:{on:false};})())";

async function openRoom(page, gameText, roomCode) {
  await page.goto(BASE + '/#/games', 2200);
  await page.js("__T.clickText('" + gameText + "','.game-card')");
  await page.sleep(500);
  await page.js("__T.clickText('创建房间','.room-modal .btn')");
  await page.sleep(400);
  await page.js("__T.setField('.room-modal .code-input','" + roomCode + "')");
  await page.sleep(200);
  await page.js("__T.clickText('创建','.room-modal .btn')");
  await page.sleep(2600);
}

async function joinRoom(page, gameText, roomCode) {
  await page.goto(BASE + '/#/games', 2200);
  await page.js("__T.clickText('" + gameText + "','.game-card')");
  await page.sleep(500);
  await page.js("__T.clickText('加入房间','.room-modal .btn')");
  await page.sleep(400);
  await page.js("__T.setField('.room-modal .code-input','" + roomCode + "')");
  await page.sleep(200);
  await page.js("__T.clickText('加入','.room-modal .btn')");
  await page.sleep(2600);
}

try {
  await login(A, 'gt01'); await login(B, 'gt02'); await login(C, 'cw01');

  /* 背景音乐的"关掉过就记住"是设计行为，测试要回到首次使用状态，
     否则上一轮跑完留下的 checkin_bgm_off=1 会让"默认不是关闭态"假失败。 */
  for (const page of [A, B]) {
    await page.js("localStorage.setItem('checkin_bgm_off','0');'ok'");
    await page.js("location.reload();'r'");
    await sleep(2300);
    await page.js(HELPERS);
  }

  /* ---------------------------------------------------------- 五子棋 */
  const gomokuCode = String(1000 + Math.floor(Math.random() * 8999));
  await openRoom(A, '五子棋', gomokuCode);
  await joinRoom(B, '五子棋', gomokuCode);
  await A.js("__T.clickText('准备')");
  await sleep(700);
  const beforeStart = await A.js(AUDIO);
  check('五子棋：只有一个准备时不播音乐', JSON.parse(beforeStart || 'null') ? JSON.parse(beforeStart).paused !== false : true,
        beforeStart);
  await B.js("__T.clickText('准备')");
  await sleep(1800);

  const audioA = JSON.parse((await A.js(AUDIO)) || 'null');
  const audioB = JSON.parse((await B.js(AUDIO)) || 'null');
  check('五子棋：房主这边对局一开始就自动播放', !!audioA && audioA.paused === false, JSON.stringify(audioA));
  check('五子棋：对手那边也自动播放', !!audioB && audioB.paused === false, JSON.stringify(audioB));
  check('五子棋：放的是 /media/game-start.mp3', !!audioA && /\/media\/game-start\.mp3/.test(audioA.src || ''), audioA && audioA.src);
  check('五子棋：是循环播放', !!audioA && audioA.loop === true, JSON.stringify(audioA));

  const btnA = JSON.parse((await A.js(BTN)) || 'null');
  check('五子棋：底部出现关闭音乐按钮', !!btnA && btnA.on === true, JSON.stringify(btnA));
  check('五子棋：按钮默认不是关闭态', !!btnA && /bgm-off/.test(btnA.cls || '') === false, btnA && btnA.cls);

  /* 点一下按钮关掉 */
  await A.clickSel('.bgm-toggle');
  await sleep(600);
  const pausedA = JSON.parse((await A.js(AUDIO)) || 'null');
  const btnOff = JSON.parse((await A.js(BTN)) || 'null');
  check('五子棋：点按钮后音乐停了', !!pausedA && pausedA.paused === true, JSON.stringify(pausedA));
  check('五子棋：按钮变成"已关闭"状态', !!btnOff && /bgm-off/.test(btnOff.cls || ''), btnOff && btnOff.cls);
  check('五子棋：关掉的选择被记住了',
        (await A.js("localStorage.getItem('checkin_bgm_off')")) === '1', await A.js("localStorage.getItem('checkin_bgm_off')"));

  /* 再点一下恢复 */
  await A.clickSel('.bgm-toggle');
  await sleep(700);
  const resumed = JSON.parse((await A.js(AUDIO)) || 'null');
  check('五子棋：再点一下能重新播放', !!resumed && resumed.paused === false, JSON.stringify(resumed));
  check('五子棋：重新播放后记忆被清掉',
        (await A.js("localStorage.getItem('checkin_bgm_off')")) === '0', await A.js("localStorage.getItem('checkin_bgm_off')"));

  /* 下完一局：A 横着连五子 */
  const moves = [[0, 40], [1, 41], [2, 42], [3, 43], [4]];
  for (const pair of moves) {
    await A.clickSel('.board .cell', pair[0]);
    await sleep(320);
    if (pair.length > 1) { await B.clickSel('.board .cell', pair[1]); await sleep(320); }
  }
  await sleep(1400);
  const afterEnd = JSON.parse((await A.js(AUDIO)) || 'null');
  const btnAfter = JSON.parse((await A.js(BTN)) || 'null');
  check('五子棋：对局结束音乐自动停', !!afterEnd && afterEnd.paused === true, JSON.stringify(afterEnd));
  check('五子棋：对局结束后按钮收起', !!btnAfter && btnAfter.on === false, JSON.stringify(btnAfter));
  check('五子棋：确实已经结算', (await A.js("document.body.innerText.indexOf('再来一局')>=0")) === true, '');

  /* ---------------------------------------------------------- 围棋 */
  const goCode = String(1000 + Math.floor(Math.random() * 8999));
  await openRoom(A, '围棋', goCode);
  await joinRoom(B, '围棋', goCode);
  await A.js("__T.clickText('准备')");
  await sleep(600);
  await B.js("__T.clickText('准备')");
  await sleep(1800);
  const goAudio = JSON.parse((await A.js(AUDIO)) || 'null');
  check('围棋：对局一开始也自动播放', !!goAudio && goAudio.paused === false, JSON.stringify(goAudio));
  check('围棋：也有关闭音乐按钮', (await A.js("!!document.querySelector('.bgm-toggle')")) === true, '');
  await A.js("__T.clickText('认输')");
  await sleep(500);
  await A.js("__T.clickText('认输','.modal .btn')");
  await sleep(1500);
  const goEnd = JSON.parse((await A.js(AUDIO)) || 'null');
  check('围棋：认输结束后音乐停', !!goEnd && goEnd.paused === true, JSON.stringify(goEnd));

  /* ---------------------------------------------------------- 井字棋不该播 */
  const ttt2 = String(1000 + Math.floor(Math.random() * 8999));
  await openRoom(B, '井字棋', ttt2);
  await joinRoom(C, '井字棋', ttt2);
  await C.js("__T.clickText('准备')");
  await sleep(600);
  await B.js("__T.clickText('准备')");
  await sleep(1700);
  const tttAudio = JSON.parse((await C.js(AUDIO)) || 'null');
  check('井字棋：不播背景音乐（只有五子棋/围棋播）', !tttAudio || tttAudio.paused === true, JSON.stringify(tttAudio));
  check('井字棋：也不显示音乐按钮', (await C.js("!!document.querySelector('.bgm-toggle')")) === false, '');

  /* ---------------------------------------------------------- 弹幕大战（协作同学新加的游戏） */
  await C.goto(BASE + '/#/games', 2400);
  /* 先切到「单机休闲」页签（点击与滑块动画有竞争，点不顺就再点几次） */
  let soloOn = false;
  for (let i = 0; i < 6 && !soloOn; i++) {
    await C.js("__T.clickExact('单机休闲')");
    await sleep(700);
    soloOn = (await C.js("(function(){var c=[].slice.call(document.querySelectorAll('.game-card-wide'));" +
      "return c.length>0 && c.every(function(x){return x.offsetParent!==null;});})()")) === true;
  }
  const cards = await C.js("JSON.stringify([].slice.call(document.querySelectorAll('.game-card-wide')).map(function(c){return c.textContent.trim().slice(0,10);}))");
  check('弹幕大战：单机休闲里能看到这张卡片', cards.indexOf('弹幕大战') >= 0, cards);

  await C.viewport(932, 430, 1);   /* 弹幕大战是横屏游戏，先切横屏再看 iframe 尺寸 */
  const clickCard = await C.js("(function(){var c=[].slice.call(document.querySelectorAll('.game-card-wide')).filter(function(x){return x.textContent.indexOf('弹幕大战')>=0;})[0];if(!c)return 'MISS';c.click();return 'OK';})()");
  await sleep(3200);
  const frameInfo = JSON.parse((await C.js("JSON.stringify({hash:location.hash," +
    "frame:document.querySelectorAll('iframe.danmaku-frame').length})")) || '{}');
  check('弹幕大战：点进去能打开游戏页', clickCard === 'OK' && frameInfo.hash === '#/games/danmaku' && frameInfo.frame === 1,
        clickCard + ' ' + JSON.stringify(frameInfo));
  const box = await C.js("(function(){var f=document.querySelector('iframe.danmaku-frame');if(!f)return 'MISS';" +
    "return JSON.stringify({src:f.src,w:f.clientWidth,h:f.clientHeight});})()");
  const inner = await C.js("(function(){var f=document.querySelector('iframe.danmaku-frame');if(!f)return 'MISS';" +
    "var d=f.contentDocument;if(!d)return 'NO-DOC';return JSON.stringify({title:d.title,canvas:d.querySelectorAll('canvas').length," +
    "phaser:!!f.contentWindow.Phaser,txt:(d.body.innerText||'').replace(/\\s+/g,' ').slice(0,50)});})()");
  const b = JSON.parse(box === 'MISS' ? 'null' : box);
  check('弹幕大战：iframe 铺满屏幕（没被压成 0）', !!b && b.w > 200 && b.h > 300, box);
  check('弹幕大战：里面真的是游戏（Canvas2D 画布起来了）',
        inner !== 'MISS' && inner !== 'NO-DOC' && (function () { const d = JSON.parse(inner); return d.canvas > 0 && /弹幕大战/.test(d.title || ''); })(), inner);
  await C.js("(function(){var e=document.querySelector('.danmaku-back');if(e)e.click();return 'ok';})()");
  await sleep(900);
  check('弹幕大战：能正常返回游戏大厅', (await C.js("location.hash")) === '#/games', await C.js("location.hash"));
  await C.clearViewport();

} catch (err) {
  out.push('FAIL  用例异常: ' + err.message);
}

const passed = out.filter((l) => l.startsWith('PASS')).length;
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(out.join('\n'));
console.log('\n=== ' + passed + '/' + (passed + failed) + ' ===');
process.exit(failed ? 1 : 0);
