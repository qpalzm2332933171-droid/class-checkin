/**
 * 骗子酒馆 UI 回归（真浏览器 + 真点击）
 *
 * 验的是纯协议测试覆盖不到的那一层：牌面渲染、选牌、按钮可用态、
 * 开牌面板、当事人区分、结束浮层、控制台有没有报错。
 * 顺带把关键画面截图到 tests/browser/shots/，方便人眼过一遍设计。
 *
 * 用 bidi-firefox.mjs 驱动**系统自带的 Firefox**（WebDriver BiDi），
 * 不需要 Playwright、不需要下载任何浏览器 —— 只要 `which firefox` 能找到就行。
 *
 * 前置：
 *   - 本地服务已起（CHECKIN_DATA / CHECKIN_WEB 指向本仓库）
 *   - 4 个测试账号；口令从环境变量进，绝不写进仓库
 *
 * 用法（口令只从环境变量进，绝不写进仓库）：
 *   CHECKIN_BASE=http://127.0.0.1:8081 \
 *   LIAR_ACCOUNTS='u1:p1 u2:p2 u3:p3 u4:p4' \
 *   node tests/browser/liar-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { firefox } from './bidi-firefox.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE = process.env.CHECKIN_BASE || 'http://127.0.0.1:8081';
const SHOTS = path.join(HERE, 'shots');
const ACCOUNTS = (process.env.LIAR_ACCOUNTS || '')
  .split(/[\s,]+/).filter(Boolean).map((x) => {
    const [username, ...rest] = x.split(':');
    return { username, password: rest.join(':') };
  });
if (ACCOUNTS.length < 4) {
  console.error("需要 4 个账号：LIAR_ACCOUNTS='u1:p1 u2:p2 u3:p3 u4:p4'");
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('PASS  ' + name + (extra ? '   [' + extra + ']' : '')); }
  else { fail += 1; failures.push(name); console.log('FAIL  ' + name + '   [' + extra + ']'); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tokenFor(acc) {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(acc),
  });
  if (!res.ok) throw new Error('登录失败 ' + acc.username + ' -> ' + res.status);
  return (await res.json()).token;
}

/** 页面级的操作探针：全部走真实 DOM，不碰内部状态 */
const PROBE = `(() => {
  const bar = document.querySelector('.liar-bar');
  const over = document.querySelector('.liar-over');
  // 不能用 offsetParent 判可见：position:fixed 的元素 offsetParent 恒为 null，
  // 而操作条和结束浮层都是 fixed 的。
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const btns = bar ? [...bar.querySelectorAll('button')].filter(visible) : [];
  const find = (re) => btns.find((b) => re.test(b.textContent || ''));
  // 注意：「盖牌出」按钮在没选牌时本来就是 disabled 的，
  // 所以"轮到我出牌"要看按钮在不在，而不是看它 disabled 与否。
  const play = find(/盖牌出/);
  const doubt = find(/质疑/);
  const pass = find(/放过/);
  const handCount = document.querySelectorAll('.liar-hand .liar-card').length;
  return {
    hasBar: !!bar,
    over: visible(over),
    overTitle: over ? (over.querySelector('.t2') || {}).textContent : '',
    waiting: !!document.querySelector('.liar-wait'),
    hand: handCount,
    selected: document.querySelectorAll('.liar-hand .liar-card.sel').length,
    table: (document.querySelector('.liar-card-table .liar-rank') || {}).textContent || '',
    opps: document.querySelectorAll('.liar-opp').length,
    chambers: document.querySelectorAll('.liar-opp .liar-chamber').length,
    /* 开牌时中央面板整块切成结果视图（.liar-center.is-reveal），不再是单独一块浮框 */
    reveal: visible(document.querySelector('.liar-center.is-reveal')),
    revealCards: document.querySelectorAll('.liar-rv-cards .liar-card').length,
    revealVerdict: ((document.querySelector('.liar-rv-verdict') || {}).textContent || '').trim(),
    centerUrgent: !!document.querySelector('.liar-center.urgent'),
    /* 当事人特殊设计：开牌时质疑者/被质疑者要有身份标签，底栏要播报"我的结局" */
    revealTags: [...document.querySelectorAll('.liar-tag')].map((e) => e.textContent.trim()),
    revealMine: !!document.querySelector('.liar-card-rv.mine'),
    personal: ((document.querySelector('.liar-personal') || {}).textContent || '').trim(),
    underFire: !!document.querySelector('.liar-me.under-fire'),
    logLines: document.querySelectorAll('.liar-log-line').length,
    playLabel: play ? play.textContent.trim() : '',
    myTurn: !!play && handCount > 0,
    playReady: !!(play && !play.disabled && handCount > 0),
    canDoubt: !!(doubt && !doubt.disabled),
    canPass: !!pass,
    barText: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
    status: (document.querySelector('.liar-head .sub') || {}).textContent || '',
  };
})()`;

async function probe(page) {
  try { return await page.evaluate(PROBE); } catch (err) { return { err: String(err.message || err) }; }
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  } catch (err) { /* 截图失败不影响用例判定 */ }
}

/** 关掉可能盖住页面的浮层：班级公告弹窗 / 通用 scrim / 确认框。
    不关掉的话所有点击都会落到浮层上（仓库 README 里记过这个坑）。 */
async function dismiss(page) {
  for (let i = 0; i < 6; i++) {
    const hit = await page.evaluate(() => {
      const byText = [...document.querySelectorAll('.announce-modal button, .modal button')]
        .filter((b) => /我知道了|知道了|关闭|确定|取消/.test(b.textContent || ''))[0];
      if (byText) { byText.click(); return 'modal-btn'; }
      const scrim = document.querySelector('.scrim');
      if (scrim) { scrim.click(); return 'scrim'; }
      return null;
    });
    if (!hit) return;
    await sleep(250);
  }
}

async function main() {
  const tokens = [];
  for (const acc of ACCOUNTS) tokens.push(await tokenFor(acc));

  /* 先把已读回执打掉，否则"班级公告"弹窗会盖住牌桌、所有点击都落到它身上 */
  for (const token of tokens) {
    try {
      const list = await (await fetch(BASE + '/api/announcements', {
        headers: { Authorization: 'Bearer ' + token },
      })).json();
      const ids = (list.items || []).filter((x) => !x.read).map((x) => x.id);
      if (ids.length) {
        await fetch(BASE + '/api/announcements/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ ids }),
        });
      }
    } catch (err) { /* 没公告就算了 */ }
  }

  const browser = await firefox.launch({ headless: true });
  const contexts = [];
  const pages = [];

  for (let i = 0; i < 4; i++) {
    /* 每个账号一个独立 userContext：4 个窗口各有各的 localStorage，
       否则它们会共用同一个登录态，没法同时扮 4 个人 */
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((tok) => {
      try { localStorage.setItem('checkin_token', tok); } catch (e) { /* ignore */ }
    }, tokens[i]);
    const page = await ctx.newPage();
    contexts.push(ctx);
    pages.push(page);
  }
  /* 控制台报错/未捕获异常由 harness 在上下文上攒着，这里统一取出来（见 bidi-firefox.mjs） */
  const collectErrors = () => contexts.flatMap((c, i) => [
    ...(c._pageErrors || []).map((t) => '[' + i + '] pageerror: ' + t),
    ...(c._consoleErrors || []).map((t) => '[' + i + '] console: ' + t),
  ]);

  // ---------------------------------------------------------------- 建房
  const host = pages[0];
  await host.goto(BASE + '/#/games', { waitUntil: 'load' });
  await sleep(1200);
  await dismiss(host);
  await sleep(300);

  const card = host.locator('.game-card', { hasText: '骗子酒馆' }).first();
  ok('大厅出现「骗子酒馆」卡片', await card.count() > 0);
  await card.click();
  await sleep(500);
  ok('弹出「创建房间 / 加入房间」对话框',
    (await host.locator('text=创建房间').count()) > 0);
  await host.locator('button', { hasText: '创建房间' }).first().click();
  await sleep(400);
  await host.locator('button', { hasText: '创建' }).last().click();

  let room = '';
  for (let i = 0; i < 60 && !room; i++) {
    await sleep(200);
    const url = await host.url();   // harness 的 url() 是异步的（Playwright 那个是同步的）
    const m = url.match(/room=(\d+)/);
    if (m) room = m[1];
  }
  ok('创建后自动进入牌桌页并带上房间号', !!room, room);
  if (!room) { await browser.close(); return finish(); }

  // ---------------------------------------------------------------- 其他三人加入
  for (let i = 1; i < 4; i++) {
    await pages[i].goto(BASE + '/#/games/liar?room=' + room, { waitUntil: 'load' });
    await sleep(700);
  }
  await sleep(800);
  const p0 = await probe(host);
  ok('四个人都进了房间（等待卡里出现 4 个座位）',
    await host.locator('.liar-wait .chip-av').count() === 4,
    String(await host.locator('.liar-wait .chip-av').count()));
  ok('未开局时不渲染牌桌（只有等待卡）', p0.hand === 0 && p0.waiting === true);
  await shot(host, 'liar-01-waiting');

  // ---------------------------------------------------------------- 准备开局
  for (const page of pages) {
    const btn = page.locator('.liar-wait button', { hasText: '准备' }).first();
    if (await btn.count()) { await btn.click(); await sleep(200); }
  }
  let started = false;
  for (let i = 0; i < 50 && !started; i++) {
    await sleep(250);
    started = (await probe(host)).hand === 5;
  }
  ok('全员准备后自动开局，手上发到 5 张牌', started);

  const st = await probe(host);
  ok('中央显示了本轮 Table 牌', ['Q', 'K', 'A'].includes(st.table), st.table);
  ok('渲染了 3 个对手', st.opps === 3, String(st.opps));
  ok('每个对手都有一把 6 发弹巢', st.chambers === 18, String(st.chambers));
  ok('手牌渲染成 5 张可点的牌', st.hand === 5, String(st.hand));
  ok('底部操作条出现了', st.hasBar === true);
  ok('战报面板在渲染流水（每手出牌只进战报、不弹 toast）', st.logLines >= 2, String(st.logLines));
  await shot(host, 'liar-02-dealt');

  // ---------------------------------------------------------------- 选牌交互
  let picker = null;
  for (let i = 0; i < 60 && !picker; i++) {
    for (const page of pages) {
      const s = await probe(page);
      if (s.myTurn) { picker = page; break; }
    }
    if (!picker) { await dismiss(pages[0]); await sleep(220); }
  }
  ok('轮到某个人时出现了「盖牌出」按钮', !!picker);

  if (picker) {
    const cards = picker.locator('.liar-hand .liar-card');
    await cards.nth(0).click();
    await sleep(250);
    let s = await probe(picker);
    ok('点一张牌 -> 抬起并进入选中态', s.selected === 1, String(s.selected));
    ok('按钮文案跟着变成「盖牌出 1 张」', /盖牌出\s*1\s*张/.test(s.playLabel), s.playLabel);
    await cards.nth(1).click();
    await cards.nth(2).click();
    await sleep(250);
    s = await probe(picker);
    ok('最多可选 3 张', s.selected === 3, String(s.selected));
    await shot(picker, 'liar-03-picked');
    await cards.nth(0).click();
    await sleep(200);
    s = await probe(picker);
    ok('再点一次取消选中', s.selected === 2, String(s.selected));
    await picker.locator('.liar-hand .liar-card.sel').first().click();
    await sleep(200);
    ok('取消到只剩 1 张时按钮文案同步',
      /盖牌出\s*1\s*张/.test((await probe(picker)).playLabel));
  }

  // ---------------------------------------------------------------- 打完整局
  const seen = { reveal: 0, doubt: 0, pass: 0, played: 0 };
  let revealShot = false;
  let finished = null;
  let toggle = 0;
  /* 用户反馈的两点，专门拦：
       ① 开牌时要整块替换中央面板（不再和 Table 牌并排两块）
       ② 开牌期间中央面板不能变红抢注意力 */
  const rv = { verdicts: 0, urgentDuringReveal: 0, withCards: 0, tagRounds: 0,
               barFilled: 0, personal: 0, generic: 0, mine: false, underFireSeen: false };
  const deadline = Date.now() + 330000;
  while (Date.now() < deadline) {
    let acted = false;
    for (const page of pages) {
      const s = await probe(page);
      if (s.err) continue;
      if (s.over) { finished = s; break; }
      if (s.reveal) {
        seen.reveal += 1;
        if (s.revealVerdict) rv.verdicts += 1;
        if (s.centerUrgent) rv.urgentDuringReveal += 1;
        if (s.revealCards > 0) rv.withCards += 1;
        if (s.revealTags.length > 0) rv.tagRounds += 1;
        /* 底栏在开牌期间总该有话说：当事人是「✅/❌ 我个人」的结局，其他人是一句短的第三方播报 */
        if (s.personal) rv.barFilled += 1;
        if (/^[✅❌]/.test(s.personal)) rv.personal += 1;
        else if (s.personal) rv.generic += 1;
        if (s.revealMine) rv.mine = true;
        if (s.underFire) rv.underFireSeen = true;
        /* 优先抓"质疑 + 翻牌"那一帧：身份标签和翻牌动画都在，是最值得人眼看的一张。
           截图前先把 toast 藏掉 —— 它在页面顶部正好压住对手卡片，而测试把 liar_speed
           调到 5 之后开牌期只有 2 秒、比 toast 的 2.8 秒还短，不藏的话人眼看到的
           永远是"对手区糊了一层 toast"，会误以为身份标签没做出来。 */
        if (!revealShot && s.revealCards > 0) {
          revealShot = true;
          await page.evaluate("(() => { document.querySelectorAll('.toasts').forEach((e) => { e.style.display = 'none'; }); })()");
          await shot(page, 'liar-04-reveal');
        }
      }
      if (s.canPass) {
        // 三分之二质疑、三分之一放过：两条分支都要在 UI 上真走过
        const want = toggle++ % 3 === 0 ? '放过' : '质疑';
        const btn = page.locator('.liar-bar button', { hasText: want }).first();
        if (await btn.count()) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          acted = true;
          if (want === '放过') seen.pass += 1; else seen.doubt += 1;
          await sleep(120);
          continue;
        }
      }
      if (s.myTurn) {
        // 一次尽量多盖几张，轮次推进快一点（浏览器往返比纯协议慢很多）
        const want = Math.min(3, s.hand);
        const cards = page.locator('.liar-hand .liar-card');
        for (let k = 0; k < want; k++) {
          const c = cards.nth(k);
          if (await c.count()) await c.click({ timeout: 3000 }).catch(() => {});
          await sleep(60);
        }
        const go = page.locator('.liar-bar button', { hasText: '盖牌出' }).first();
        if (await go.count() && !(await go.isDisabled())) {
          await go.click({ timeout: 3000 }).catch(() => {});
          acted = true;
          seen.played += 1;
        }
        await sleep(120);
        continue;
      }
      if (s.canDoubt) {
        const btn = page.locator('.liar-bar button', { hasText: '质疑' }).first();
        if (await btn.count()) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          acted = true; seen.doubt += 1; await sleep(120);
        }
      }
    }
    if (finished) break;
    if (!acted) await sleep(150);
  }

  ok('对局能打到结束（出现结束浮层）', !!finished && finished.over === true,
    finished ? finished.overTitle : '超时');
  ok('过程中真的在 UI 上点着出牌了（不是全靠超时兜底）', seen.played > 3, 'played=' + seen.played);
  ok('过程中出现过开牌浮层', seen.reveal > 0, String(seen.reveal));
  ok('开牌时中央面板整块换成结果视图（判决语渲染出来了）', rv.verdicts > 0, String(rv.verdicts));
  ok('开牌期间中央面板不会变红抢注意力', rv.urgentDuringReveal === 0,
    '误红 ' + rv.urgentDuringReveal + ' 次');
  ok('被质疑的牌真的翻出来给所有人看了', rv.withCards > 0, String(rv.withCards));
  ok('开牌时质疑者/被质疑者被打上身份标签', rv.tagRounds > 0, String(rv.tagRounds));
  ok('开牌期间底栏不留空（一直看得到刚发生了什么）', rv.barFilled > 0, String(rv.barFilled));
  ok('当事人看到的底栏文案是"我个人"的结局（✅/❌ 开头）',
    rv.personal > 0, 'personal=' + rv.personal);
  ok('非当事人看到的是简短的第三方播报（不抢中央面板的戏）',
    rv.generic > 0, 'generic=' + rv.generic);
  /* 这两项没有稳定的采样窗口（要恰好抓到"我挨枪/我的牌被翻开"那一刻），
     所以只做诊断展示、不断言，免得偶发失败。 */
  console.log('      （诊断）我的牌被翻开过：' + (rv.mine ? '是' : '否')
    + ' · 我挨枪时自己的区域高亮过：' + (rv.underFireSeen ? '是' : '否'));
  ok('过程中开过枪（有人挨了左轮）', seen.doubt > 0 || seen.pass > 0,
    'doubt=' + seen.doubt + ' pass=' + seen.pass);
  if (finished) {
    ok('结束浮层给出了明确结论',
      /活到了最后|出局了|本局结束|中止/.test(finished.overTitle || ''), finished.overTitle);
    /* 结束浮层和底部操作条都是 fixed，容易互相压住 —— 这条专门拦它 */
    const geo = await pages[0].evaluate(() => {
      const o = document.querySelector('.liar-over');
      const b = document.querySelector('.liar-bar');
      if (!o || !b) return null;
      return { overBottom: Math.round(o.getBoundingClientRect().bottom),
               barTop: Math.round(b.getBoundingClientRect().top) };
    });
    ok('结束浮层没有被底部操作条压住',
      !!geo && geo.overBottom <= geo.barTop + 1, JSON.stringify(geo));
    await shot(pages[0], 'liar-05-over');
  }

  // ---------------------------------------------------------------- 再来一局 / 离开
  const again = pages[0].locator('.liar-over button', { hasText: '再来一局' }).first();
  if (await again.count()) {
    ok('结束浮层里有「再来一局」按钮', true);
    /* 诊断：点之前先看看按钮中心坐标上"真正会收到点击"的是谁 —— 被别的浮层挡住的话一眼就能看出来 */
    const diag = await pages[0].evaluate(`(() => JSON.stringify([...document.querySelectorAll('.liar-over button')].map((b) => {
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return { text: b.textContent.trim(), x: Math.round(cx), y: Math.round(cy),
               hit: hit ? hit.tagName + '.' + String(hit.className).split(' ')[0] : null };
    })))()`);
    const urlBefore = await pages[0].url();
    await again.click();
    await sleep(700);
    const solo = await probe(pages[0]);
    if (solo.over !== true) {
      const dump = await pages[0].evaluate(`(() => {
        const o = document.querySelector('.liar-over');
        return JSON.stringify({
          overCount: document.querySelectorAll('.liar-over').length,
          opacity: o ? getComputedStyle(o).opacity : null,
          rect: o ? JSON.stringify(o.getBoundingClientRect()) : null,
          overlayHTML: o ? o.outerHTML.replace(/\\s+/g, ' ').slice(0, 200) : null,
          waitingCard: !!document.querySelector('.liar-wait'),
        });
      })()`);
      console.log('      （诊断）按钮=' + diag);
      console.log('      （诊断）点前 ' + urlBefore + ' -> 点后 ' + await pages[0].url());
      console.log('      （诊断）浮层现状=' + dump);
      console.log('      （诊断）probe=' + JSON.stringify(solo));
    }
    ok('只有一个人点「再来一局」时不会重开（浮层还在，等其他人）',
      solo.over === true, 'over=' + solo.over);
    // 四个人都点才会真的重开
    for (const page of pages.slice(1)) {
      const b = page.locator('.liar-over button', { hasText: '再来一局' }).first();
      if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(160); }
    }
    let restarted = false;
    for (let i = 0; i < 50 && !restarted; i++) {
      await sleep(300);
      const s = await probe(pages[0]);
      restarted = s.over === false && s.hand === 5;
    }
    ok('四个人都点「再来一局」-> 真开了新一局（浮层收起、重新发到 5 张牌）', restarted);
  } else {
    ok('结束浮层里有「再来一局」按钮', false, '没找到按钮');
  }

  // ---------------------------------------------------------------- 控制台干净
  /* 浏览器自己会为 favicon / 断开的请求报错，那些不算我们的问题 */
  const noisy = collectErrors().filter((e) => !/favicon|net::ERR|Failed to load resource|NS_ERROR/i.test(e));
  ok('整局没有 JS 报错', noisy.length === 0, noisy.slice(0, 3).join(' | '));

  for (const ctx of contexts) await ctx.close();
  await browser.close();
  return finish();
}

function finish() {
  console.log('\n截图目录: ' + SHOTS);
  console.log('=== %d passed, %d failed ===', pass, fail);
  if (failures.length) console.log('失败项: ' + failures.join(' / '));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
