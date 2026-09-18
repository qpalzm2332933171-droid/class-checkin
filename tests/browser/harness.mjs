/* 浏览器端回归测试的公共驱动：CDP 连接 / 登录 / 真实鼠标点击。
   前置：无头 Edge 已按 CDP_PORTS（默认 9336,9337,9338）开好远程调试端口。
   用法见 README.md。 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BASE = process.env.CHECKIN_BASE || 'http://127.0.0.1:8081';
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(HERE, 'accounts.json'), 'utf8'));
const PORTS = (process.env.CDP_PORTS || '9336,9337,9338').split(',').map((x) => Number(x.trim()));

async function tokenFor(who) {
  const acc = ACCOUNTS[who];
  if (!acc) throw new Error('accounts.json 里没有账号 ' + who);
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: acc.username, password: acc.password }),
  });
  if (!res.ok) throw new Error('登录失败 ' + who + ' -> HTTP ' + res.status);
  return (await res.json()).token;
}

async function connect(port) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome-extension):/.test(t.url || ''));
  const page = pages.find((t) => /^https?:/.test(t.url || '')) || pages.find((t) => t.url === 'about:blank') || pages[0];
  if (!page) throw new Error('no page on ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method) events.push(m.method);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable', {}); await send('Runtime.enable', {});
  /* 关键：不禁用缓存的话，无头浏览器会一直复用内存里的旧模块，改了代码看起来也没生效 */
  await send('Network.enable', {}); await send('Network.setCacheDisabled', { cacheDisabled: true });
  const api = {
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    async goto(url, waitMs = 1500) {
      const before = events.length;
      await send('Page.navigate', { url });
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); if (events.slice(before).includes('Page.loadEventFired')) break; }
      await new Promise((r) => setTimeout(r, waitMs)); return url;
    },
    async js(expr) {
      const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      const r = res.result || {};
      if (r.exceptionDetails) throw new Error('page error: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result ? r.result.value : undefined;
    },
    async mouse(type, x, y) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
    },
    async dismiss() {
      return api.js("(function(){var l=[].slice.call(document.querySelectorAll('.modal button, .scrim'));var e=l.filter(function(x){return /知道了|关闭|确定|取消/.test(x.textContent||'');})[0]||l.filter(function(x){return x.classList.contains('scrim');})[0];if(e){e.click();return 'closed';}return 'none';})()");
    },
    async clickSel(sel, idx = 0) {
      await api.sleep(120);
      await api.dismiss();
      await api.sleep(250);
      const b = await api.js('(function(){var e=document.querySelectorAll(' + JSON.stringify(sel) + ')[' + idx + '];if(!e)return null;e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height});})()');
      if (!b) throw new Error('no element ' + sel + '[' + idx + ']');
      const p = JSON.parse(b);
      await api.mouse('mousePressed', p.x, p.y); await api.sleep(60); await api.mouse('mouseReleased', p.x, p.y);
      return true;
    },
    close() { try { ws.close(); } catch (e) {} },
  };
  return api;
}

const HELPERS = "window.__T={clickExact:function(t,sel){var l=[].slice.call(document.querySelectorAll(sel||'button'));var e=l.filter(function(x){return (x.textContent||'').trim()===t;})[0];if(!e)return 'MISS';e.click();return 'OK';},clickText:function(t,sel){var l=[].slice.call(document.querySelectorAll(sel||'button'));var e=l.filter(function(x){return (x.textContent||'').trim().indexOf(t)>=0;})[0];if(!e)return 'MISS';e.click();return 'OK';},setField:function(sel,val){var el=document.querySelector(sel);if(!el)return 'MISS';var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));return 'OK';}};'ready'";

async function login(page, who, routePath) {
  const token = await tokenFor(who);
  await page.goto(BASE + '/', 600);
  await page.js("localStorage.setItem('checkin_token','" + token + "');'ok'");
  await page.js("location.reload();'r'");
  await page.sleep(2600);
  if (routePath) await page.goto(BASE + '/#' + routePath, 2200);
  await page.js(HELPERS);
}

export { connect, login, HELPERS, BASE, PORTS };
