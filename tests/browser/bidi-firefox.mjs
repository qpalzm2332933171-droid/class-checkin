/**
 * bidi-firefox.mjs —— 用**系统自带的 Firefox** 驱动浏览器回归，不需要任何下载
 *
 * 【为什么不用 Playwright】
 *   Playwright 靠的是它自己那版打过 juggler 补丁的 Firefox，所以得额外下 300MB+，
 *   而且拿系统 firefox 去 launch 会直接失败。
 *   但 Firefox 129+ 原生支持 **WebDriver BiDi**：`--remote-debugging-port` 会暴露
 *   `ws://127.0.0.1:<port>/session`，导航 / 求值 / 真实点击 / 截图 / 独立上下文全都有。
 *   用系统那个 firefox 就够了 —— 零下载、零残留。
 *
 * 【它是什么】
 *   一层薄薄的 **Playwright 风格 API**，让现有用例只换 import 那一行就能跑：
 *
 *     import { firefox } from './bidi-firefox.mjs';   // 原来是 playwright-core
 *     const browser = await firefox.launch({ headless: true });
 *     const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
 *     await ctx.addInitScript((tok) => localStorage.setItem('t', tok), token);
 *     const page = await ctx.newPage();
 *     await page.goto(url);
 *     await page.evaluate('document.title');
 *     await page.locator('.btn', { hasText: '确定' }).click();   // 真实鼠标事件
 *     await page.screenshot({ path: 'x.png' });
 *     await ctx.close(); await browser.close();
 *
 *   只实现用例真正用到的那部分 Playwright API，不是完整实现。
 *   `locator` 支持 count / click / first / nth / last / isDisabled / textContent。
 *
 * 【注意】
 *   进程要自己管生命周期：脚本 spawn 出 Firefox，跑完 kill 掉、删掉临时 profile。
 *   （沙箱里每次命令都是独立 PID 命名空间，别指望外部预先开好一个浏览器。）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连上 BiDi 端点：把 id/响应配成 Promise，同时收集服务端推送的事件 */
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method) listeners.forEach((fn) => fn(m));
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('连不上 BiDi 端点 ws://127.0.0.1:' + port + '/session')));
  });
  const raw = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  /** 失败就抛，别让上层拿到 undefined 之后炸在莫名其妙的地方 */
  const cmd = async (method, params) => {
    const r = await raw(method, params);
    if (r.type === 'error') throw new Error(method + ' -> ' + String(r.message || JSON.stringify(r)).slice(0, 200));
    return r.result;
  };
  return { cmd, raw, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

/** 包成"一定返回 JSON 字符串"，Node 这边再 parse，省得处理 BiDi 的类型包装。
    必须用 async IIFE 且把 await 放在里面 —— 否则表达式返回 Promise 时
    JSON.stringify(Promise) 会得到 "{}"，拿回来的就不是真实结果了。
    （BiDi 那边开了 awaitPromise，会等这个 IIFE 的 promise 落定。） */
const asJson = (js) => `(async () => { try { return JSON.stringify(await (${js})); } catch (e) { return JSON.stringify({ __pageErr: String(e) }); } })()`;

const VISIBLE = `((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')`;

/** 生成一段"按选择器 + 可选文字过滤取元素"的页面内 JS。
 *  支持 Playwright 的 `text=xxx` 文字选择器：取**最内层**包含该文字的元素，
 *  跟 Playwright 的行为对齐（否则会点到大到 body 的元素上）。 */
function picker(selector, hasText, index, body) {
  if (selector.startsWith('text=')) {
    const want = JSON.stringify(selector.slice(5));
    return `(() => {
      const want = ${want};
      const all = [...document.querySelectorAll('*')].filter(${VISIBLE})
        .filter((e) => (e.textContent || '').includes(want));
      const inner = all.filter((e) => ![...e.children].some((c) => (c.textContent || '').includes(want)));
      const pool = inner.length ? inner : all;
      const el = pool[${index} < 0 ? pool.length + (${index}) : ${index}];
      ${body}
    })()`;
  }
  const sel = JSON.stringify(selector);
  const filt = hasText ? `filter((e) => (e.textContent || '').includes(${JSON.stringify(String(hasText))}))` : '';
  return `(() => {
    const all = [...document.querySelectorAll(${sel})].filter(${VISIBLE})${filt ? '.' + filt : ''};
    const el = all[${index} < 0 ? all.length + (${index}) : ${index}];
    ${body}
  })()`;
}

export const firefox = {
  async launch({ headless = true, port = 0, firefoxPath = process.env.FIREFOX_BIN || 'firefox' } = {}) {
    const actualPort = port || (9300 + Math.floor(Math.random() * 400));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bidi-ff-'));
    /* Firefox 默认会节流后台标签页：不跑 CSS 过渡 → Vue 的 <Transition> 永远等不到
       transitionend → 离场元素不回收（手牌区能堆到 89 张）、浮层停在 opacity:0 迟迟不消失。
       而这个用法天生要同时开好几个标签页（4 个账号），所以必须把节流关掉。 */
    fs.writeFileSync(path.join(profile, 'user.js'), [
      'user_pref("dom.min_background_timeout_value", 4);',
      'user_pref("dom.timeout.background_throttling_max_budget", -1);',
      'user_pref("dom.timeout.enable_budget_timer_throttling", false);',
      'user_pref("widget.windows.window_occlusion_tracking.enabled", false);',
    ].join('\n'));
    const args = [`--remote-debugging-port=${actualPort}`, '--no-remote', '--profile', profile];
    if (headless) args.unshift('--headless');
    args.push('about:blank');

    const proc = spawn(firefoxPath, args, { stdio: 'ignore' });
    let exited = false;
    proc.on('exit', () => { exited = true; });

    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      if (exited) break;
      try { await fetch(`http://127.0.0.1:${actualPort}/session`); up = true; } catch (e) { await sleep(250); }
    }
    if (!up) {
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      throw new Error('Firefox 没起来：检查 `which firefox`、或端口 ' + actualPort + ' 是否被占用');
    }

    const conn = await connect(actualPort);
    await conn.cmd('session.new', { capabilities: {} });
    await conn.cmd('session.subscribe', { events: ['log.entryAdded'] });

    /* 浏览器级控制台事件，广播给每个已注册的页面 */
    const sinks = [];
    conn.on((m) => { if (m.method === 'log.entryAdded') sinks.forEach((fn) => fn(m.params)); });

    /* 当前在前台的标签页。后台标签页不跑 CSS 过渡，Vue 的 <Transition> 会一直卡在
       enter-from（元素停在 opacity:0、离场元素不回收），所以每次交互前都要先把
       目标标签页切到前台。只在切换时才发命令，避免每步都多一次往返。 */
    let activeContext = null;
    const activate = async (context) => {
      if (!context || activeContext === context) return;
      activeContext = context;
      try { await conn.cmd('browsingContext.activate', { context }); } catch (e) { /* ignore */ }
    };

    return {
      async newContext({ viewport, devicePixelRatio = 1 } = {}) {
        const view = viewport || { width: 1280, height: 800 };
        /* 每个客户端一个独立 userContext：4 个窗口各自独立 localStorage，
           否则它们会共用同一个登录态，根本没法同时扮 4 个人 */
        const { userContext } = await conn.cmd('browser.createUserContext', {});
        const preloads = [];
        const pageErrors = [];
        const consoleErrors = [];
        let contextId = null;

        const report = (params) => {
          const e = params && params.entry;
          if (!e) return;
          const text = e.text || '';
          if (e.level === 'error') {
            if (e.type === 'javascript') pageErrors.push(text);
            else consoleErrors.push(text);
          }
        };
        sinks.push(report);

        async function ensureContext() {
          if (contextId) return contextId;
          const c = await conn.cmd('browsingContext.create', { type: 'tab', userContext });
          contextId = c.context;
          await conn.cmd('browsingContext.setViewport', { context: contextId, viewport: view, devicePixelRatio });
          for (const decl of preloads) {
            await conn.cmd('script.addPreloadScript', { functionDeclaration: decl, contexts: [contextId] });
          }
          return contextId;
        }

        const evaluate = async (expr, arg) => {
          const context = await ensureContext();
          await activate(context);
          const js = typeof expr === 'function'
            ? asJson(`(${expr.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`)
            : asJson(String(expr));
          const r = await conn.cmd('script.evaluate', { expression: js, target: { context }, awaitPromise: true });
          const value = typeof r.result.value === 'string' ? JSON.parse(r.result.value) : r.result.value;
          if (value && value.__pageErr) throw new Error('页面内求值出错: ' + value.__pageErr);
          return value;
        };

        const ctx = {
          _pageErrors: pageErrors,
          _consoleErrors: consoleErrors,
          _preloads: preloads,
          async addInitScript(fn, arg) {
            /* 每次导航前都会跑，正是"注入登录态"想要的时机 */
            preloads.push(`() => { (${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)}); }`);
          },
          async newPage() {
            await ensureContext();
            const page = {
              async goto(url, opts = {}) {
                const context = await ensureContext();
                await activate(context);
                await conn.cmd('browsingContext.navigate', { context, url, wait: 'complete' });
                await sleep(opts.waitMs != null ? opts.waitMs : 300);
                return url;
              },
              async url() { return String(await evaluate('location.href')); },
              evaluate,
              async screenshot({ path: file } = {}) {
                const context = await ensureContext();
                await activate(context);
                const r = await conn.cmd('browsingContext.captureScreenshot', { context });
                if (file) {
                  fs.mkdirSync(path.dirname(file), { recursive: true });
                  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
                }
              },
              on() { /* 控制台/异常统一从 ctx._pageErrors / ctx._consoleErrors 取 */ },
              async close() { /* 上下文由 ctx.close() 统一回收 */ },

              locator(selector, { hasText } = {}) {
                let index = 0;
                const api = {
                  first() { index = 0; return api; },
                  nth(i) { index = i; return api; },
                  last() { index = -1; return api; },
                  async count() {
                    return await evaluate(picker(selector, hasText, 0, 'return all.length;'));
                  },
                  async _info() {
                    return await evaluate(picker(selector, hasText, index, `if (!el) return null;
                      el.scrollIntoView({ block: 'center' });
                      const r = el.getBoundingClientRect();
                      return { x: r.x + r.width / 2, y: r.y + r.height / 2,
                               disabled: !!el.disabled, text: (el.textContent || '').trim() };`));
                  },
                  async isDisabled() { const i = await api._info(); return !i || !!i.disabled; },
                  async textContent() { const i = await api._info(); return i ? i.text : ''; },
                  /** 真实鼠标事件（不是 dispatchEvent 的合成点击） */
                  async click() {
                    const info = await api._info();
                    if (!info) throw new Error('点不到元素：' + selector + (hasText ? '（含文字「' + hasText + '」）' : ''));
                    const context = await ensureContext();
                    await activate(context);
                    await conn.cmd('input.performActions', {
                      context,
                      actions: [{
                        type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
                        actions: [
                          { type: 'pointerMove', x: Math.round(info.x), y: Math.round(info.y) },
                          { type: 'pointerDown', button: 0 },
                          { type: 'pointerUp', button: 0 },
                        ],
                      }],
                    });
                  },
                };
                return api;
              },
            };
            return page;
          },
          async close() {
            const i = sinks.indexOf(report);
            if (i >= 0) sinks.splice(i, 1);
            try { await conn.cmd('browser.removeUserContext', { userContext }); } catch (e) { /* ignore */ }
          },
        };
        return ctx;
      },

      async close() {
        try { await conn.raw('session.end', {}); } catch (e) { /* ignore */ }
        conn.close();
        try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      },
    };
  },
};

export default firefox;
