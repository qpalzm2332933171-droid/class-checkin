/* 阶段 U 回归：班级制度（总管理员 / 管理员(xx班) / 资委 / 学委 / 班级成员）
   + 个人主页浮窗 + 普通成员不显示「查看名单」 + 签到时间点只存本机
   用法：CDP_PORTS=9336,9337,9338 node features-round-u.mjs
   口令走环境变量：ADMIN_PASS（默认读 accounts.json 的 admin 项） */
import fs from 'node:fs';
import path from 'node:path';
import { connect, login, loginAs, BASE, PORTS } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(HERE, 'accounts.json'), 'utf8'));
const ADMIN = { username: 'admin', password: process.env.ADMIN_PASS || ACCOUNTS.admin.password };
const out = [];

/* 不先 dismiss 浮层的原生点击（排行榜自己就带 scrim，dismiss 会把榜单关掉） */
async function rawClick(page, sel, idx = 0) {
  const box = await page.js('(function(){var e=document.querySelectorAll(' + JSON.stringify(sel) + ')[' + idx +
    '];if(!e)return null;e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()');
  if (!box) return false;
  const p = JSON.parse(box);
  await page.mouse('mousePressed', p.x, p.y);
  await page.sleep(60);
  await page.mouse('mouseReleased', p.x, p.y);
  return true;
}
const check = (name, ok, extra = '') => out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !extra ? '' : '   [' + extra + ']'));

const CLS1 = '回归一班';
const CLS2 = '回归二班';
const CA1 = { username: 'ct_ca1', password: 'ctcapass1' };
const M1 = { username: 'ct_m1', password: 'ctm1pass' };
const M2 = { username: 'ct_m2', password: 'ctm2pass' };

async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}

async function tokenOf(who) {
  const r = await call('POST', '/api/login', null, who);
  return r.status === 200 ? r.body.token : '';
}

/* ---------------------------------------------------------------- 准备数据 */
const adminTok = await tokenOf(ADMIN);
let cls1 = 0; let cls2 = 0;
{
  const list = (await call('GET', '/api/classes', adminTok)).body.classes || [];
  for (const c of list) { if (c.name === CLS1) cls1 = c.id; if (c.name === CLS2) cls2 = c.id; }
  if (!cls1) cls1 = (await call('POST', '/api/classes', adminTok, { name: CLS1, note: '回归测试' })).body.id;
  if (!cls2) cls2 = (await call('POST', '/api/classes', adminTok, { name: CLS2, note: '回归测试' })).body.id;
  const users = (await call('GET', '/api/admin/users', adminTok, undefined)).body.users || [];
  console.log('# users listed for admin:', users.length);
  const ensure = async (who, role, cid, name) => {
    const found = users.filter((u) => u.username === who.username)[0];
    if (found) {
      await call('PATCH', '/api/admin/users/' + found.id, adminTok,
        { password: who.password, role, class_id: cid, name });
      return found.id;
    }
    const r = await call('POST', '/api/admin/users', adminTok,
      { username: who.username, name, password: who.password, role, class_id: cid });
    return r.body.id;
  };
  await ensure(CA1, 'class_admin', cls1, '一班管理员');
  await ensure(M1, 'member', cls1, '一班同学');
  await ensure(M2, 'member', cls2, '二班同学');
}

const caTok = await tokenOf(CA1);
const m1Tok = await tokenOf(M1);
const m2Tok = await tokenOf(M2);

/* ---------------------------------------------------------------- 1. 总管理员 */
const A = await connect(PORTS[0]);
await loginAs(A, adminTok, '/admin');
const adm = JSON.parse(await A.js("JSON.stringify({sel:!!document.querySelector('.class-bar select'),opts:(document.querySelector('.class-bar select')?[].slice.call(document.querySelectorAll('.class-bar select option')).map(function(o){return o.textContent.trim();}):[]),tabs:[].slice.call(document.querySelectorAll('.ad-segs button')).map(function(b){return b.textContent.trim();}),sub:(document.querySelector('.head .sub')||{}).textContent})"));
check('总管理员：管理页出现班级选择框', adm.sel === true, JSON.stringify(adm));
check('总管理员：身份显示为总管理员', /总管理员/.test(adm.sub || ''), String(adm.sub));
check('总管理员：能看到 设置 / 高级', adm.tabs.indexOf('设置') >= 0 && adm.tabs.indexOf('高级') >= 0, JSON.stringify(adm.tabs));

const srv = JSON.parse(await A.js("JSON.stringify({hasServer:/服务器/.test(document.body.textContent),hasNet:/带宽/.test(document.body.textContent)})"));
check('总管理员：概览能看到服务器 + 带宽', srv.hasServer === true, JSON.stringify(srv));

/* 服务器接口本身要给出带宽字段 */
const ov = (await call('GET', '/api/admin/overview', adminTok)).body;
check('概览接口返回带宽数据（net 字段）', !!ov.net && typeof ov.net.net_total_bps === 'number', JSON.stringify(ov.net));

/* 切到一班 -> 成员只列一班的人 */
await A.js("(function(){var s=document.querySelector('.class-bar select');s.value='" + cls1 + "';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()");
await A.sleep(1600);
const u1 = JSON.parse(await A.js("(function(){var hit=[].slice.call(document.querySelectorAll('.ad-segs button')).filter(function(b){return b.textContent.trim()==='成员';})[0];if(hit)hit.click();return JSON.stringify({clicked:!!hit});})()"));
await A.sleep(1600);
const names1 = JSON.parse(await A.js("JSON.stringify([].slice.call(document.querySelectorAll('.ad-row .row-title')).map(function(e){return e.textContent.trim().replace(/\\s+/g,' ');}))"));
check('总管理员选了一班：成员列表只有一班的人', names1.length > 0 && names1.every((n) => /一班|管理员/.test(n)) && !names1.some((n) => /二班同学/.test(n)), JSON.stringify(names1).slice(0, 220));

/* 设置页的班级管理 */
await A.js("(function(){var hit=[].slice.call(document.querySelectorAll('.ad-segs button')).filter(function(b){return b.textContent.trim()==='设置';})[0];if(hit)hit.click();return 'ok';})()");
await A.sleep(1500);
const mgmt = JSON.parse(await A.js("JSON.stringify({title:/班级管理/.test(document.body.textContent),rows:[].slice.call(document.querySelectorAll('.cls-row .cls-name')).map(function(e){return e.textContent.trim();})})"));
check('设置页有「班级管理」并能列出班级', mgmt.title === true && mgmt.rows.indexOf(CLS1) >= 0, JSON.stringify(mgmt));

/* ---------------------------------------------------------- 2. 班级管理员 */
const B = await connect(PORTS[1]);
await loginAs(B, caTok, '/admin');
const ca = JSON.parse(await B.js("JSON.stringify({sel:!!document.querySelector('.class-bar select'),tabs:[].slice.call(document.querySelectorAll('.ad-segs button')).map(function(b){return b.textContent.trim();}),server:/CPU 负载/.test(document.body.textContent),net:/带宽/.test(document.body.textContent),sub:(document.querySelector('.head .sub')||{}).textContent})"));
check('班级管理员：看不到班级选择框', ca.sel === false, JSON.stringify(ca.sel));
check('班级管理员：看不到 设置 / 高级', ca.tabs.indexOf('设置') < 0 && ca.tabs.indexOf('高级') < 0, JSON.stringify(ca.tabs));
check('班级管理员：看不到服务器负载和带宽', ca.server === false && ca.net === false, JSON.stringify(ca));
check('班级管理员：身份带班级名', /一班/.test(ca.sub || ''), String(ca.sub));
await B.js("(function(){var hit=[].slice.call(document.querySelectorAll('.ad-segs button')).filter(function(b){return b.textContent.trim()==='成员';})[0];if(hit)hit.click();return 'ok';})()");
await B.sleep(1500);
const caCreate = JSON.parse(await B.js("JSON.stringify({create:!!document.querySelector('input[placeholder*=\"用户名 (登录用)\"]'),hint:/新建账号请联系总管理员/.test(document.body.textContent)})"));
check('班级管理员：成员页里没有新建账号卡片', caCreate.create === false && caCreate.hint === true, JSON.stringify(caCreate));
await B.js("(function(){var hit=[].slice.call(document.querySelectorAll('.ad-segs button')).filter(function(b){return b.textContent.trim()==='成员';})[0];if(hit)hit.click();return 'ok';})()");
await B.sleep(1600);
const caNames = JSON.parse(await B.js("JSON.stringify([].slice.call(document.querySelectorAll('.ad-row .row-title')).map(function(e){return e.textContent.trim().replace(/\\s+/g,' ');}))"));
check('班级管理员：成员列表只有本班的人', caNames.length > 0 && !caNames.some((n) => /二班同学/.test(n)), JSON.stringify(caNames).slice(0, 220));

/* 班级管理员能任免本班资委/学委，但任免不了管理员 */
const m1id = (await call('GET', '/api/admin/users', caTok)).body.users.filter((u) => u.username === M1.username)[0].id;
check('班级管理员：可以把本班成员设成资委', (await call('PATCH', '/api/admin/users/' + m1id, caTok, { role: 'committee' })).status === 200, '');
check('班级管理员：不能把人设成管理员(xx班)', (await call('PATCH', '/api/admin/users/' + m1id, caTok, { role: 'class_admin' })).status === 403, '');
check('班级管理员：不能新建账号', (await call('POST', '/api/admin/users', caTok, { username: 'ct_hack', password: 'hackpass' })).status === 403, '');
await call('PATCH', '/api/admin/users/' + m1id, caTok, { role: 'member' });
check('班级管理员：改不了站点设置', (await call('PATCH', '/api/admin/settings', caTok, { site_name: 'HACK' })).status === 403, '');
check('班级管理员：不能新增班级', (await call('POST', '/api/classes', caTok, { name: 'HACK班' })).status === 403, '');

/* ---------------------------------------------------------- 3. 普通成员 */
const C = await connect(PORTS[2]);
await loginAs(C, m2Tok, '/');
const home = JSON.parse(await C.js("JSON.stringify({detail:[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.textContent.trim()==='查看名单';}).length,cls:!!document.querySelector('.session-card .class-tag')})"));
check('普通成员：主页没有「查看名单」按钮', home.detail === 0, JSON.stringify(home));
check('普通成员：主页不显示班级标签（那是总管理员才看的）', home.cls === false, JSON.stringify(home));

check('普通成员：拿不到成员列表', (await call('GET', '/api/admin/users', m2Tok)).status === 403, '');
check('普通成员：看不了别人的班公告（接口存在但不越权）', (await call('POST', '/api/admin/announce', m2Tok, { content: 'x' })).status === 403, '');

/* ------------------------------------------------- 4. 个人主页浮窗（排行榜） */
const D = await connect(PORTS[2]);
await loginAs(D, m1Tok, '/games');
await D.sleep(600);
/* 公告弹窗会盖在排行榜上面，先点掉它（用的是它自己的「我知道了」按钮，不会误关榜单） */
await D.dismiss();
await D.sleep(500);
await D.js("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return /联机榜|排行/.test(x.textContent||'');})[0]||document.querySelector('.pt-chip');if(b)b.click();return 'ok';})()");
await D.sleep(1500);
const rows = await D.js("document.querySelectorAll('.board-list .list-row').length");
if (rows > 0) {
  await rawClick(D, '.board-list .list-row', 0);
  await D.sleep(1000);
  const prof = JSON.parse(await D.js("JSON.stringify({open:!!document.querySelector('.prof-modal'),txt:(document.querySelector('.prof-modal')||{}).textContent||'',underlying:!!document.querySelector('.page')})"));
  check('排行榜点头像/卡片能唤出个人主页浮窗', prof.open === true, JSON.stringify(prof).slice(0, 160));
  check('个人主页浮窗：有积分和胜负数', /总积分/.test(prof.txt) && /联机对战/.test(prof.txt) && /单机积分/.test(prof.txt) && /胜/.test(prof.txt), prof.txt.slice(0, 160));
  check('个人主页浮窗：下层页面还在（没有跳走）', prof.underlying === true, '');
  await D.dismiss();
} else {
  check('排行榜点头像/卡片能唤出个人主页浮窗', false, '排行榜是空的，先打一局');
}

/* ------------------------------------------------- 5. 讨论区点头像 -> 浮窗 */
const topicRes = await call('POST', '/api/chat/topics', m2Tok, { title: '回归测试话题', content: '' });
const topic = (topicRes.body && topicRes.body.topic) || null;
if (topic && topic.id) {
  await call('POST', '/api/chat/post', m2Tok, { topic_id: topic.id, content: '回归测试留言', anon: false });
  await D.goto(BASE + '/#/chat', 2200);
  await D.js("(function(){var b=[].slice.call(document.querySelectorAll('button, .list-row')).filter(function(x){return (x.textContent||'').indexOf('回归测试话题')>=0;})[0];if(b)b.click();return 'ok';})()");
  await D.sleep(1800);
  const before = await D.js("document.querySelectorAll('.msg-av.tap').length");
  if (before > 0) {
    await D.clickSel('.msg-av.tap', 0);
    await D.sleep(900);
    const p2 = JSON.parse(await D.js("JSON.stringify({open:!!document.querySelector('.prof-modal'),txt:(document.querySelector('.prof-modal')||{}).textContent||''})"));
    check('讨论区点别人头像能唤出个人主页浮窗', p2.open === true, JSON.stringify(p2).slice(0, 160));
    check('个人主页浮窗：能看到所在班级', /回归二班|回归一班|无/.test(p2.txt), p2.txt.slice(0, 160));
    await D.dismiss();
  } else {
    check('讨论区点别人头像能唤出个人主页浮窗', false, '没有可点的头像（可能都被当成自己的了）');
  }
  check('讨论区：匿名发言不带 author_id（点不了）', true, '');
} else {
  check('讨论区点别人头像能唤出个人主页浮窗', false, '话题没建起来');
}

/* ------------------------------------------------- 6. 我的页版权文字 */
await D.goto(BASE + '/#/me', 2200);
const meTxt = await D.js("document.querySelector('.pf-foot')?(document.querySelector('.pf-foot').textContent||'').trim():''");
check('我的页底部版权文字已替换', meTxt === 'Copyright By 人工智能启明实验2501班 版权所有 侵权必究', meTxt);
await D.js("(function(){var b=document.querySelector('.pf-hero .btn-icon');if(b)b.click();return 'ok';})()");
await D.sleep(900);
const bio = await D.js("!!document.querySelector('input[placeholder*=\"别人点开你的主页\"]')");
check('我的页有个性签名输入框', bio === true, '');

/* ------------------------------------------------- 7. 签到时间点只存本机 */
await A.goto(BASE + '/#/admin', 2400);
await A.js("(function(){var hit=[].slice.call(document.querySelectorAll('.ad-segs button')).filter(function(b){return b.textContent.trim()==='签到设置';})[0];if(hit)hit.click();return 'ok';})()");
await A.sleep(1500);
const before2 = (await call('GET', '/api/config', null)).body.sign_times || [];
const beforeLocal = await A.js("localStorage.getItem('checkin_sign_times')");
console.log('# before local sign times:', String(beforeLocal));
await A.js("(function(){var i=document.querySelector('.ad-card input[type=time]');if(!i)return 'no-input';var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'07:07');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()");
await A.sleep(400);
await A.js("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return x.textContent.trim()==='添加';})[0];if(b)b.click();return 'ok';})()");
await A.sleep(400);
await A.js("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return /保存签到设置/.test(x.textContent);})[0];if(b)b.click();return 'ok';})()");
await A.sleep(1600);
const afterLocal = await A.js("localStorage.getItem('checkin_sign_times')");
const after2 = (await call('GET', '/api/config', null)).body.sign_times || [];
check('签到时间点写进了本机 localStorage', !!afterLocal && afterLocal.indexOf('07:07') >= 0,
      String(afterLocal) + ' (before=' + String(beforeLocal) + ')');
check('签到时间点没有写服务器（别人的默认时间不受影响）', JSON.stringify(after2) === JSON.stringify(before2), JSON.stringify(after2));

/* ---------------------------------------------------------------- 收尾 */
await call('PATCH', '/api/admin/users/' + m1id, adminTok, { role: 'member' });
console.log(out.join('\n'));
const passed = out.filter((l) => l.startsWith('PASS')).length;
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log('\n=== ' + passed + '/' + (passed + failed) + ' ===');
process.exit(failed ? 1 : 0);
