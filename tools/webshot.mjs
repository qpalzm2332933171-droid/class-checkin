#!/usr/bin/env node
/* 对 headless Edge/Chrome 的某个页面截图：node tools/webshot.mjs <输出png> [CDP端口] */
import fs from 'node:fs';

const out = process.argv[2] || 'shot.png';
const PORT = process.argv[3] || process.env.CDP_PORT || '9333';
const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome-extension):/.test(t.url || ''));
const page = pages.find((t) => /^https?:/.test(t.url || '')) || pages[0];
if (!page) { console.error('no page'); process.exit(3); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => { const mid = ++id; return new Promise((r) => { pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); }); };
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const res = await send('Page.captureScreenshot', { format: 'png' });
if (!res.result || !res.result.data) { console.error('shot failed', JSON.stringify(res).slice(0, 300)); process.exit(4); }
fs.writeFileSync(out, Buffer.from(res.result.data, 'base64'));
console.log('saved ' + out + ' (' + page.url + ')');
ws.close();
process.exit(0);
