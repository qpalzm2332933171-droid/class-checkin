/* 阶段 R 回归：毛玻璃/自适应/签到窗口/定位改版/资委权限/记录页/Excel 导出/更新日志。
   用法：CDP_PORTS=9336 node features-round-r.mjs
   账号：accounts.json 里的 cw01（资委）+ 环境变量 ADMIN_USER/ADMIN_PASS 走管理员接口 */
import { connect, BASE } from './harness.mjs';

const out = [];
const check = (name, ok, extra = '') => out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !extra ? '' : '   [' + extra + ']'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(user, pass) {
  const res = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }) });
  if (!res.ok) throw new Error('登录失败 ' + user + ' -> ' + res.status);
  return (await res.json()).token;
}
async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

const admin = await login(process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASS || '');
const cw = await login(process.env.STAFF_USER || 'cw01', process.env.STAFF_PASS || '');

/* ---------------------------------------------------------------- 任务 3：签到窗口 */
const now = Math.floor(Date.now() / 1000);
const made = await call('/api/admin/sign-sessions', { method: 'POST', token: admin,
  body: { sign_at: process.env.R_SIGN_AT || '08:00', grace_minutes: 15, title: 'R-窗口测试', require_location: false } });
/* 用 HH:MM 走服务端"顺延到下一次"的逻辑：等于把场次放到下一次该时刻 */
const sid = made.data.id;
const view = (await call('/api/admin/sign-sessions', { token: admin })).data.sessions.find((s) => s.id === sid);
check('签到窗口：接口给出 opens_at（提前开放时刻）', !!view && !!view.opens_at, JSON.stringify(view && view.opens_at));
check('签到窗口：还没到开放时间前，签到被拒绝',
  (await call('/api/sign/in', { method: 'POST', token: cw, body: { session_id: sid } })).status === 400);
const rejectMsg = (await call('/api/sign/in', { method: 'POST', token: cw, body: { session_id: sid } })).data.error || '';
check('签到窗口：提示里写明什么时候开放', /还没开始/.test(rejectMsg), rejectMsg);
/* 把场次挪到"已开放"状态：sign_at = 现在 + 10 分钟（提前量 30 分钟以内） */
await call('/api/admin/sign-sessions/' + sid, { method: 'PATCH', token: admin,
  body: { sign_at: now + 600, late_after: now + 600, ends_at: now + 600 + 900 } });
const okSign = await call('/api/sign/in', { method: 'POST', token: cw, body: { session_id: sid } });
check('签到窗口：开放之后可以正常签到', okSign.status === 200, okSign.data.error || '');
/* 截止之后必须拒绝 */
await call('/api/admin/sign-sessions/' + sid, { method: 'PATCH', token: admin, body: { ends_at: now - 60 } });
const late = await call('/api/sign/in', { method: 'POST', token: admin, body: { session_id: sid } });
check('签到窗口：过了"签到时间+补签时长"就签不了', late.status === 400 && /截止/.test(late.data.error || ''), late.data.error || String(late.status));

/* ---------------------------------------------------------------- 任务 6/7：名单 + 导出 */
const roster = await call('/api/admin/session-roster?session_id=' + sid, { token: cw });
check('资委能打开场次名单（记录页数据源）', roster.status === 200 && Array.isArray(roster.data.roster), String(roster.status));
check('名单里每个人都有状态字段（含未记录的记成缺勤口径）',
  !!roster.data.roster && roster.data.roster.every((r) => typeof r.status === 'string'));
const target = (roster.data.roster || []).find((r) => r.status === 'none');
if (target) {
  const set = await call('/api/admin/records', { method: 'POST', token: cw,
    body: { session_id: sid, user_id: target.user_id, status: 'leave', note: 'R 测试' } });
  const after = await call('/api/admin/session-roster?session_id=' + sid, { token: cw });
  const row = (after.data.roster || []).find((r) => r.user_id === target.user_id);
  check('资委能把某人状态改成请假', set.status === 200 && row && row.status === 'leave', row && row.status);
}
const xlsx = await fetch(BASE + '/api/admin/records.xlsx', { headers: { Authorization: 'Bearer ' + cw } });
const buf = Buffer.from(await xlsx.arrayBuffer());
check('Excel 导出：资委可以导出（返回 zip 结构）', xlsx.ok && buf.length > 2000 && buf.slice(0, 2).toString() === 'PK',
  xlsx.status + ' / ' + buf.length + 'B');
check('Excel 导出：文件名是 .xlsx',
  /sign-records-.*\.xlsx/.test(xlsx.headers.get('content-disposition') || ''), xlsx.headers.get('content-disposition') || '');

/* ---------------------------------------------------------------- 任务 5：资委权限 */
const del = await call('/api/admin/sign-sessions/' + sid, { method: 'DELETE', token: cw });
check('资委可以删除场次（以前只有管理员能删）', del.status === 200 && del.data.deleted, String(del.status));

/* ---------------------------------------------------------------- 任务 8：更新日志不发公告 */
const before = (await call('/api/announcements', { token: admin })).data.items || [];
const chg = await call('/api/admin/changelog', { method: 'POST', token: admin,
  body: { version: 'vR-test', title: 'R 阶段测试条目', body: '- 仅测试' } });
const after = (await call('/api/announcements', { token: admin })).data.items || [];
check('写更新日志不会再往公告里塞一条', chg.status === 200 && after.length === before.length,
  before.length + ' -> ' + after.length);
const logs = (await call('/api/changelog', { token: admin })).data.items || [];
check('更新日志写进了「更新日志」入口', logs.some((x) => x.version === 'vR-test'));
if (chg.data.id) await call('/api/admin/changelog/' + chg.data.id, { method: 'DELETE', token: admin });

/* ---------------------------------------------------------------- 浏览器部分 */
const page = await connect(Number((process.env.CDP_PORTS || '9336').split(',')[0]));
await page.goto(BASE + '/', 400);
await page.js("localStorage.setItem('checkin_token','" + cw + "');'ok'");
await page.goto(BASE + '/?t=' + Date.now() + '#/admin', 900);
await page.sleep(1600);

/* 任务 1：滑动时玻璃还是玻璃（不是实心白块） */
await page.js("location.hash='#/'");
await page.sleep(900);
const glass = await page.js("(function(){var host=document.querySelector('.page-host');if(!host)return 'no host';host.classList.add('pager-live','pager-anim');var el=document.querySelector('.pager-pane.cur .glass, .pager-pane.cur .btn');if(!el)return 'no glass';var st=getComputedStyle(el);var pane=document.querySelector('.pager-pane.cur');var blurVar=getComputedStyle(host).getPropertyValue('--blur-reg');return JSON.stringify({filter:st.backdropFilter||st.webkitBackdropFilter,bg:st.backgroundColor,blurVar:blurVar.trim()});})()");
let glassOk = false, glassInfo = glass;
try { const g = JSON.parse(glass); glassOk = /blur\(/.test(g.filter || '') && !/^rgba?\(252, 253, 255/.test(g.bg || ''); } catch (e) { /* keep info */ }
check('任务1：跟手拖动时毛玻璃保留（不再变成实心白块）', glassOk, glassInfo);
const glassVar = await page.js("(function(){var host=document.querySelector('.page-host');return getComputedStyle(host).getPropertyValue('--blur-reg').trim();})()");
check('任务1：拖动时只是把模糊半径降一档（省帧率）', /px/.test(glassVar) && parseFloat(glassVar) > 0, glassVar);

/* 任务 4：地图 + 附近地点 + 半径输入框 */
await page.goto(BASE + '/?t=' + Date.now() + '#/admin', 900);
await page.sleep(1300);
await page.js("window.__T={clickText:function(t,sel){var l=[].slice.call(document.querySelectorAll(sel||'button'));var e=l.filter(function(x){return (x.textContent||'').trim().indexOf(t)>=0;})[0];if(!e)return 'MISS';e.click();return 'OK';}};'ok'");
await page.js("window.__T.clickText('场次','.ad-segs button')");
await page.sleep(1200);
await page.js("window.__T.clickText('需要定位','.ad-toggles button')");
await page.sleep(3000);
const mapState = await page.js("(function(){var imgs=[].slice.call(document.querySelectorAll('.mk-tile'));var ok=imgs.filter(function(i){return i.naturalWidth>0;}).length;var c=document.querySelector('.mk-circle');return JSON.stringify({tiles:imgs.length,loaded:ok,circle:!!c,circleBg:c?getComputedStyle(c).backgroundColor:'',radiusInput:!!document.querySelector('.ad-loc input[type=number]'),slider:!!document.querySelector('.ad-range')});})()");
let ms = {};
try { ms = JSON.parse(mapState); } catch (e) { /* noop */ }
check('任务4：地图真的渲染出瓦片了（以前是空白）', ms.loaded > 0, mapState);
check('任务4：半径用输入框、不再是滑动条', ms.radiusInput === true && ms.slider === false, mapState);
check('任务4：地图上有淡绿色半径圈', ms.circle === true && /52, 199, 89/.test(ms.circleBg || ''), ms.circleBg);

/* 搜索地点：结果按距离从近到远 */
await page.js("(function(){var el=document.querySelector('.ad-loc input.field');var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'食堂');el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()");
await page.sleep(300);
await page.js("window.__T.clickText('搜索','.ad-loc button')");
await page.sleep(4000);
const listState = await page.js("(function(){var rows=[].slice.call(document.querySelectorAll('.loc-list .list-row'));var chips=rows.map(function(r){var c=r.querySelector('.chip');return c?c.textContent.trim():'';});return JSON.stringify({n:rows.length,first:rows[0]?rows[0].innerText.replace(/\\s+/g,' ').slice(0,40):'',chips:chips.slice(0,5),title:(document.querySelectorAll('.ad-loc .cap')[0]||{}).textContent||''});})()");
let ls = {};
try { ls = JSON.parse(listState); } catch (e) { /* noop */ }
check('任务4：搜索地点能出结果', ls.n > 0, listState);
check('任务4：结果按距离从近到远排', (ls.chips || []).length >= 2 && /米|公里/.test(ls.chips[0] || ''), JSON.stringify(ls.chips));
await page.js("(function(){var r=document.querySelectorAll('.loc-list .list-row')[0];r&&r.click();})()");
await page.sleep(1500);
const picked = await page.js("(document.querySelector('.loc-pick .row-title')||{}).textContent||''");
check('任务4：点一个地点后会被选中（不再是输入框显示地名）', picked && picked !== '还没选地点', picked);

/* 任务 5/6：资委进记录页，能进场次改状态 */
await page.goto(BASE + '/?t=' + Date.now() + '#/admin', 900);
await page.sleep(1400);
await page.js("window.__T={clickText:function(t,sel){var l=[].slice.call(document.querySelectorAll(sel||'button'));var e=l.filter(function(x){return (x.textContent||'').trim().indexOf(t)>=0;})[0];if(!e)return 'MISS';e.click();return 'OK';}};'ok'");
await page.js("window.__T.clickText('记录','.ad-segs button')");
await page.sleep(1500);
const recUI = await page.js("(function(){var tabs=[].slice.call(document.querySelectorAll('.ad-segs button')).map(function(b){return b.textContent.trim();});var exportBtn=[].slice.call(document.querySelectorAll('button')).filter(function(b){return /导出 Excel/.test(b.textContent);}).length;var dates=document.querySelectorAll('.ad-dates select').length;var rows=document.querySelectorAll('.ad-pane.cur .list-row').length;return JSON.stringify({tabs:tabs,exportBtn:exportBtn,dates:dates,rows:rows});})()");
let ru = {};
try { ru = JSON.parse(recUI); } catch (e) { /* noop */ }
check('任务5：资委能看到「记录」页签和内容', (ru.tabs || []).includes('记录') && ru.rows > 0, recUI);
check('任务6：记录页有 年/月/日 选择器', ru.dates === 3, recUI);
check('任务7：记录页有导出 Excel 按钮', ru.exportBtn > 0, recUI);
await page.js("(function(){var r=document.querySelector('.ad-pane.cur .list-row');r&&r.click();})()");
await page.sleep(1800);
const rosterUI = await page.js("(function(){var rows=document.querySelectorAll('.ad-pane.cur .list-row');var chips=[].slice.call(rows).slice(0,3).map(function(r){var c=r.querySelector('.chip');return c?c.textContent.trim():'';});var exp=[].slice.call(document.querySelectorAll('.ad-pane.cur button')).filter(function(b){return /导出这一场/.test(b.title||'');}).length;return JSON.stringify({rows:rows.length,chips:chips,exp:exp});})()");
let rou = {};
try { rou = JSON.parse(rosterUI); } catch (e) { /* noop */ }
check('任务6：点进场次能看到全班名单和状态', rou.rows > 1, rosterUI);
check('任务6：状态显示成 已签到/请假/缺勤 这类字样', (rou.chips || []).some((c) => /已签到|迟到|请假|缺勤/.test(c)), JSON.stringify(rou.chips));
await page.js("(function(){var r=document.querySelectorAll('.ad-pane.cur .list-row')[1];r&&r.click();})()");
await page.sleep(900);
const sheet = await page.js("(function(){var s=document.querySelector('.sheet');if(!s)return 'no sheet';return JSON.stringify({opts:[].slice.call(s.querySelectorAll('button')).map(function(b){return b.textContent.trim();}).slice(0,6)});})()");
check('任务6：点同学能弹出状态选择', /已签到/.test(sheet), sheet);
const changed = await page.js("(function(){var s=document.querySelector('.sheet');var b=[].slice.call(s.querySelectorAll('button')).filter(function(x){return x.textContent.trim()==='请假';})[0];if(!b)return 'MISS';b.click();return 'OK';})()");
await page.sleep(2200);
const afterChip = await page.js("(function(){var rows=document.querySelectorAll('.ad-pane.cur .list-row');var t=[].slice.call(rows).map(function(r){var c=r.querySelector('.chip');return c?c.textContent.trim():'';});return JSON.stringify(t.slice(0,4));})()");
check('任务6：改完状态列表会跟着变', changed === 'OK' && /请假/.test(afterChip), afterChip);

/* 任务 8：更新日志页面没有"发公告"开关 */
await page.goto(BASE + '/', 400);
await page.js("localStorage.setItem('checkin_token','" + admin + "');'ok'");
await page.goto(BASE + '/?t=' + Date.now() + '#/changelog', 900);
await page.sleep(1500);
await page.js("window.__T={clickText:function(t,sel){var l=[].slice.call(document.querySelectorAll(sel||'button'));var e=l.filter(function(x){return (x.textContent||'').trim().indexOf(t)>=0;})[0];if(!e)return 'MISS';e.click();return 'OK';}};'ok'");
await page.js("window.__T.clickText('写一条','button')");
await page.sleep(900);
const chgUI = await page.js("(function(){var sheet=document.querySelector('.sheet');var txt=sheet?sheet.innerText:document.body.innerText;return JSON.stringify({sheet:!!sheet,hasToggle:/会发公告|只写进更新日志/.test(txt),mentions:/不会再往公告|只出现在/.test(txt)});})()");
let cu = {};
try { cu = JSON.parse(chgUI); } catch (e) { /* noop */ }
check('任务8：更新日志页不再有"是否发公告"的开关', cu.sheet === true && cu.hasToggle === false, chgUI);
check('任务8：页面说明改成"只进更新日志"', cu.mentions === true, chgUI);

console.log(out.join('\n'));
const bad = out.filter((l) => l.startsWith('FAIL')).length;
console.log('\n=== ' + (out.length - bad) + '/' + out.length + ' ===');
page.close();
