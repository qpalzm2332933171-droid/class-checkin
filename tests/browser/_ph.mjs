import { connect, login, BASE, PORTS } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await connect(PORTS[0]);
await page.send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message||e));});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('rej:'+String(e.reason));});" +
  "window.__c=[];['error','warn'].forEach(function(k){var o=console[k].bind(console);console[k]=function(){window.__c.push(k+':'+[].slice.call(arguments).join(' ').slice(0,140));o.apply(null,arguments);};});" });
await page.viewport(932, 430, 1);
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await page.goto(BASE + '/games/danmaku/index.html', 2500);
console.log('boot:', await page.js("JSON.stringify({phaser:typeof window.Phaser,canvas:document.querySelectorAll('canvas').length,body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,90)})"));
// 完全不动，看多久死
for (const t of [3, 6, 9, 12]) {
  await sleep(3000);
  const st = await page.js("JSON.stringify({t:" + t + ",txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,70)})");
  console.log('idle', st);
}
const fs = await import('node:fs');
let s = await page.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('D:/learn/_dm_ph1.png', Buffer.from(s.result.data, 'base64'));
// 试试玩家能动起来并打死敌人（模拟手指拖动）
await page.js("(function(){var c=document.querySelector('canvas');if(c){var r=c.getBoundingClientRect();['mousedown','mousemove','mouseup'].forEach(function(){});}return 'ok';})()");
await page.mouse('mousePressed', 700, 300);
for (let i = 1; i <= 16; i++) { await page.mouse('mouseMoved', 700 - i * 30, 250 + i * 4); await sleep(60); }
await page.mouse('mouseReleased', 220, 314);
await sleep(6000);
console.log('after drag:', await page.js("JSON.stringify({txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,90)})"));
s = await page.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('D:/learn/_dm_ph2.png', Buffer.from(s.result.data, 'base64'));
console.log('errs:', await page.js("JSON.stringify(window.__errs.slice(0,4))"), 'cons:', await page.js("JSON.stringify(window.__c.slice(0,4))"));
process.exit(0);
