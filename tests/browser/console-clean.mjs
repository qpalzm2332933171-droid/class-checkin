/* 每个角色把每个页面都走一遍，断言控制台没有报错。
   —— 这类问题（比如 setup 里引用了没定义的 computed）node --check 查不出来，
      只有真在浏览器里跑一遍才会暴露：ReferenceError 会让整个 refresh() 静默死掉，
      页面看着"能打开"，其实一条数据都没有。
   用法：CDP_PORTS=9336 node console-clean.mjs */
const PORT = Number((process.env.CDP_PORTS || '9336').split(',')[0]);
const BASE = process.env.CHECKIN_BASE || 'http://127.0.0.1:8081';

/* 口令一律从 CC_ROLES 传进来，别把真口令写进仓库（这是公开仓库）。
   例：CC_ROLES='admin:admin:口令,cw01:cw01:口令,gt01:gt01:口令,ww01:ww01:口令' */
const ROLES = (process.env.CC_ROLES || '')
  .split(',').filter(Boolean)
  .map((x) => { const [who, u, p] = x.split(':'); return { who, u, p }; });
if (!ROLES.length) {
  console.error('需要设置 CC_ROLES，形如 admin:admin:口令,ww01:ww01:口令');
  process.exit(2);
}
const ROUTES = (process.env.CC_ROUTES ||
  '/,/chat,/games,/games/2048,/games/mine,/games/gomoku,/games/xiangqi,/games/me,/records,/changelog,/admin,/login')
  .split(',');

/* 已知的、与本轮无关的噪音（第三方/浏览器自身）——一律白名单化，别把真问题盖掉 */
const IGNORE = [
  /favicon/i,
  /Failed to load resource: net::ERR_(ABORTED|NETWORK|CONNECTION)/i,
  /ResizeObserver loop/i,
];

const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome-extension):/.test(t.url || ''));
const target = pages.find((t) => /^https?:/.test(t.url || '')) || pages[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0; const pending = new Map(); let logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) {
    logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => a.value || a.description || a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('[exception] ' + ((d.exception && d.exception.description) || d.text || ''));
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable', {}); await send('Runtime.enable', {});
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result.result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = [];
const check = (name, ok, extra = '') => out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !extra ? '' : '   [' + extra + ']'));

for (const role of ROLES) {
  let token = '';
  try {
    token = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: role.u, password: role.p }) })).json()).token;
  } catch (err) { token = ''; }
  check('能登录 ' + role.who, !!token);
  if (!token) continue;
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(900);
  await js("localStorage.setItem('checkin_token','" + token + "');'ok'");
  for (const route of ROUTES) {
    logs = [];
    await send('Page.navigate', { url: BASE + '/?t=' + Date.now() + '#' + route });
    await sleep(route === '/admin' ? 3200 : 2400);
    const bad = logs.filter((line) => !IGNORE.some((re) => re.test(line)));
    check(role.who + ' 打开 ' + route + ' 控制台干净', bad.length === 0, bad.join(' ; ').slice(0, 300));
  }
}

console.log(out.join('\n'));
const fails = out.filter((x) => x.startsWith('FAIL')).length;
console.log('\n=== ' + (out.length - fails) + '/' + out.length + ' ===');
ws.close();
