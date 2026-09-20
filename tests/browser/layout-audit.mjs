/* 布局审计：把每个页面/页签在多种屏幕尺寸下跑一遍，找出
   (1) 溢出视口右边界元素（真溢出，不算横向滚动容器里的）
   (2) 不该换行却换行的 flex 容器
   用法：CDP_PORTS=9336 AUDIT_USER=xxx AUDIT_PASS=yyy node layout-audit.mjs            */
import { connect, BASE } from './harness.mjs';

const ENV_SIZES = process.env.AUDIT_SIZES; // 形如 280x640,320x568
const DEFAULT_SIZES = [
  [320, 568, 'SE1'], [360, 640, '安卓小屏'], [375, 667, 'SE'],
  [390, 844, 'iPhone14'], [412, 915, 'Pixel'], [430, 932, 'ProMax'],
  [600, 960, '小平板'], [768, 1024, 'iPad竖'], [1024, 1366, 'iPad横'],
];
const SIZES = ENV_SIZES ? ENV_SIZES.split(',').map((x) => { const [w, h] = x.split('x').map(Number); return [w, h, w + 'x' + h]; }) : DEFAULT_SIZES;
const SCENES = [
  ['/', null, '签到首页'],
  ['/chat', null, '讨论列表'],
  ['/games', null, '游戏·联机'],
  ['/games', '单机休闲', '游戏·单机'],
  ['/me', null, '我的'],
  ['/changelog', null, '更新日志'],
  ['/admin', null, '管理·概览'],
  ['/admin', '成员', '管理·成员'],
  ['/admin', '场次', '管理·场次'],
  ['/admin', '记录', '管理·记录'],
  ['/admin', '讨论', '管理·讨论'],
  ['/admin', '签到设置', '管理·签到设置'],
  ['/admin', '设置', '管理·设置'],
  ['/games/2048', null, '游戏·2048'],
  ['/games/mine', null, '游戏·扫雷'],
  ['/records', null, '我的·记录'],
];

const DETECT = `(function(){
  var vw = document.documentElement.clientWidth, panes = 0, over = [];
  function offPane(el) {
    var n = el;
    while (n && n !== document.body) {
      var cl = n.classList;
      if (cl && (cl.contains('pager-pane') || cl.contains('ad-pane') || cl.contains('x-pane'))) { if (!cl.contains('cur')) return true; }
      n = n.parentElement;
    }
    return false;
  }
  function inScroller(el) {
    var n = el.parentElement;
    while (n && n !== document.body) {
      var ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
      n = n.parentElement;
    }
    return false;
  }
  function hidden(el) {
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.position === 'fixed') return true;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    var o = 0, n = el;
    while (n && n !== document.body) { o = Math.max(o, Number(getComputedStyle(n).opacity) || 0); n = n.parentElement; }
    return o === 0;
  }
  [].slice.call(document.querySelectorAll('body *')).forEach(function(el){
    if (hidden(el) || offPane(el) || inScroller(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    var name = el.tagName.toLowerCase() + '.' + (el.className || '').toString().slice(0, 40);
    var txt = (el.textContent || '').trim().slice(0, 24);
    if (Math.round(r.right - vw) > 1) over.push({ what: name, txt: txt, by: Math.round(r.right - vw) });
  });
  var wrap = [];
  [].slice.call(document.querySelectorAll('body *')).forEach(function(el){
    if (hidden(el) || offPane(el)) return;
    var st = getComputedStyle(el);
    if (st.display !== 'flex' || st.flexWrap !== 'wrap') return;
    var kids = [].slice.call(el.children).filter(function(k){
      var r = k.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(k).position !== 'absolute';
    });
    if (kids.length < 2) return;
    var tops = {}; kids.forEach(function(k){ tops[Math.round(k.getBoundingClientRect().top)] = 1; });
    var lines = Object.keys(tops).length;
    if (lines < 2) return;
    wrap.push({ what: (el.className || '').toString().slice(0, 40), txt: (el.textContent || '').trim().slice(0, 22),
                lines: lines, kids: kids.length });
  });
  return JSON.stringify({ vw: vw, elements: document.querySelectorAll('body *').length, docScroll: document.documentElement.scrollWidth, over: over, wrap: wrap });
})()`;

const PORT = Number((process.env.CDP_PORTS || '9336').split(',')[0]);
const page = await connect(PORT);
const res = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.AUDIT_USER, password: process.env.AUDIT_PASS }) });
if (!res.ok) throw new Error('登录失败 HTTP ' + res.status);
const token = (await res.json()).token;
await page.goto(BASE + '/', 500);
await page.js("localStorage.setItem('checkin_token','" + token + "');'ok'");
await page.js("location.reload();'r'");
await page.sleep(2400);
await page.js("window.__T={clickText:function(t,sel){var l=[].slice.call(document.querySelectorAll(sel||'button'));var e=l.filter(function(x){return (x.textContent||'').trim().indexOf(t)>=0;})[0];if(!e)return 'MISS';e.click();return 'OK';}};'ready'");

const findings = new Map();
const bump = (key, label, extra) => {
  const rec = findings.get(key) || { key, sizes: [], worst: '', extra: extra || '' };
  if (!rec.sizes.includes(label)) rec.sizes.push(label);
  findings.set(key, rec);
};
for (const [route, click, label] of SCENES) {
  /* 只改 hash 是 same-document 导航，reload 会拿到旧 hash（踩过坑）；加时间戳强制整页加载 */
  await page.goto(BASE + '/?t=' + Date.now() + '#' + route, 900);
  await page.sleep(300);
  await page.js("window.__T={clickText:function(t,sel){var l=[].slice.call(document.querySelectorAll(sel||'button'));var e=l.filter(function(x){return (x.textContent||'').trim().indexOf(t)>=0;})[0];if(!e)return 'MISS';e.click();return 'OK';}};'ready'");
  if (click) {
    /* 点页签后必须确认它真的被选中（点早了会点到上一屏的 DOM，踩过一次） */
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.js("(function(){var l=[].slice.call(document.querySelectorAll('.ad-segs button,.seg button'));var e=l.filter(function(x){return (x.textContent||'').trim()===" + JSON.stringify(click) + ";})[0];if(!e)return 'MISS';e.click();return 'OK';})()");
      await page.sleep(700);
      const active = await page.js("(function(){var e=document.querySelector('.ad-segs button.on,.seg button.on');return e?(e.textContent||'').trim():'';})()");
      if (active === click) break;
    }
    await page.sleep(600);
  }
  if (process.env.AUDIT_VERBOSE) {
    const seen = await page.js("(function(){var a=document.querySelector('.ad-segs button.on,.seg button.on');var pane=document.querySelector('.ad-pane.cur')||document.querySelector('.x-pane.cur');var t=(pane?pane.innerText:(document.querySelector('.pager-pane.cur')||document.body).innerText)||'';return (a?'[tab='+a.textContent.trim()+'] ':'')+t.replace(/\\s+/g,' ').trim().slice(0,52);})()");
    console.log('  场景 ' + label + ' -> ' + seen);
  }
  for (const [w, h, sizeLabel] of SIZES) {
    await page.viewport(w, h, 2);
    await page.sleep(260);
    let raw;
    try { raw = JSON.parse(await page.js(DETECT)); } catch (err) { console.log('ERR', label, sizeLabel, err.message); continue; }
    for (const o of raw.over) bump(label + ' 越界 | ' + o.what + ' | ' + o.txt, sizeLabel, '超出 ' + o.by + 'px');
    if (raw.docScroll > raw.vw + 1) bump(label + ' 整页横滚 | html', sizeLabel, '超 ' + (raw.docScroll - raw.vw) + 'px');
    for (const wr of raw.wrap) bump(label + ' 换行 | .' + wr.what + ' | ' + wr.txt, sizeLabel + '(' + wr.lines + '行/' + wr.kids + '项)');
  }
}
await page.clearViewport();
const list = [...findings.values()];
console.log('=== 布局审计：' + SCENES.length + ' 个页面 × ' + SIZES.length + ' 种尺寸，问题 ' + list.length + ' 条 ===');
for (const f of list) console.log(f.key + '   ->  ' + f.sizes.join(', ') + (f.extra ? '  ' + f.extra : ''));
if (!list.length) console.log('全部页面在这些尺寸下都没有越界、也没有不该有的换行');
page.close();
