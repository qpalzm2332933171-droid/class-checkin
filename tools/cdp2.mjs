#!/usr/bin/env node
/* 浏览器调试驱动 v2：可导航 + 执行 + 等待（cdp.mjs 只能执行单段代码）。
 * 用法: node tools/cdp2.mjs <script.js> [port]
 * script.js 内可用: await cdp.goto(url) / await cdp.js(expr) / await cdp.sleep(ms) / cdp.log(...)
 * 脚本最后 return 的值会以 JSON 打印。
 */
import fs from 'node:fs';

const file = process.argv[2];
const PORT = process.argv[3] || process.env.CDP_PORT || '9333';
if (!file) { console.error('用法: node tools/cdp2.mjs <script.js> [port]'); process.exit(2); }
const code = fs.readFileSync(file, 'utf8');

const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome-extension):/.test(t.url || ''));
const page = pages.find((t) => t.url === 'about:blank') || pages.find((t) => /^https?:/.test(t.url || '')) || pages[0];
if (!page) { console.error('没找到可调试页面'); process.exit(3); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method) events.push(m.method);
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable', {});
await send('Runtime.enable', {});

const cdp = {
  results: [],
  log(...args) { console.log('[log]', ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); },
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
  async goto(url, waitMs = 1200) {
    const before = events.length;
    await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (events.slice(before).includes('Page.loadEventFired')) break;
    }
    await new Promise((r) => setTimeout(r, waitMs));
    return url;
  },
  async mouse(type, x, y) {
    await send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
    });
    return type;
  },
  async offline(on) {
    await send('Network.enable', {});
    return send('Network.emulateNetworkConditions', {
      offline: !!on, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
  },
  async hardReload(waitMs = 2600) {
    await send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, waitMs));
    return 'reloaded';
  },
  async js(expr) {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = res.result || {};
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result ? r.result.value : undefined;
  },
};

let out;
try {
  const fn = new Function('cdp', 'return (async () => {\n' + code + '\n})();');
  out = await fn(cdp);
} catch (err) {
  console.error('SCRIPT ERROR: ' + (err && err.message));
  ws.close();
  process.exit(1);
}
console.log(JSON.stringify({ result: out === undefined ? null : out, results: cdp.results }, null, 1));
ws.close();
process.exit(0);
