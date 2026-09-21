/**
 * 后台值守连接（watch=1）的行为回归
 *
 * 验证四件事：
 *  1. watch 连接不会把用户算成"在线"，也不该触发 presence 广播；
 *  2. 有新签到发布时，watch 连接能立刻收到 sign.new（安卓端实时通知就靠这个）；
 *  3. sign.new 是全局广播，客户端要自己按班过滤（靠 /api/sign/active 兜底）；
 *  4. /api/sign/active 只返回"我该看见的"签到（跨班看不见）。
 *
 * 用法：node tests/watch-push.mjs [baseUrl]
 */
const BASE = process.argv[2] || "http://127.0.0.1:8081";
// 口令一律走环境变量，别写进仓库（这个仓库是公开的）
const ADMIN = { user: process.env.ADMIN_USER || "admin", pass: process.env.ADMIN_PASS || "" };
const MEMBER = { user: process.env.MEMBER_USER || "ww01", pass: process.env.MEMBER_PASS || "" };
if (!ADMIN.pass || !MEMBER.pass) {
  console.error("需要先设置 ADMIN_PASS 和 MEMBER_PASS 环境变量，例如：");
  console.error('  $env:ADMIN_PASS="..."; $env:MEMBER_PASS="..."; node tests/watch-push.mjs');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log("PASS  " + name + (extra ? "   " + extra : "")); }
  else { fail += 1; console.log("FAIL  " + name + "   " + extra); }
}

async function api(path, body, token) {
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: Object.assign({ "Content-Type": "application/json" },
      token ? { Authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function wsUrl(token, watch) {
  return BASE.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(token)
    + "&device=test" + (watch ? "&watch=1" : "");
}

function open(token, watch) {
  const sock = new WebSocket(wsUrl(token, watch));
  const inbox = [];
  sock.addEventListener("message", (ev) => {
    try { inbox.push(JSON.parse(ev.data)); } catch (err) { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws 打开超时")), 8000);
    sock.addEventListener("open", () => { clearTimeout(timer); resolve({ sock, inbox }); });
    sock.addEventListener("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitFor(inbox, pred, ms = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started > ms) { clearInterval(timer); resolve(null); }
    }, 120);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now() % 100000;

const admin = (await api("/api/login", { username: ADMIN.user, password: ADMIN.pass })).token;
const member = (await api("/api/login", { username: MEMBER.user, password: MEMBER.pass })).token;
ok("admin 登录", !!admin);
ok("成员登录", !!member);

const roster = await api("/api/admin/users", null, admin);
const mine = (roster.users || []).find((u) => u.username === MEMBER.user);
ok("拿得到成员的班级", !!mine, "class_id=" + (mine && mine.class_id));
const myClass = mine ? (mine.class_id | 0) : 0;
const others = (roster.classes || []).map((c) => c.id).filter((id) => id !== myClass);
const otherClass = others.length ? others[0] : 0;

// 先只开一条普通连接，量一次"基线在线情况"
const live = await open(admin, false);
await sleep(500);
const base = await waitFor(live.inbox, (m) => m.t === "presence");
ok("在线连接能收到 presence", !!base);
const baseNames = base ? (base.users || []).map((u) => u.name).sort() : [];
const baseCount = base ? base.count : -1;

// 再开一条"后台值守"连接，它不应该改变在线情况
const watch = await open(member, true);
await sleep(900);
live.inbox.length = 0;
live.sock.send(JSON.stringify({ t: "presence.get" }));
const after = await waitFor(live.inbox, (m) => m.t === "presence");
ok("watch 连接接进来之后仍能取到 presence", !!after);
if (after) {
  const names = (after.users || []).map((u) => u.name).sort();
  ok("watch 连接不把用户算成在线", names.join("|") === baseNames.join("|"),
    "before=" + JSON.stringify(baseNames) + " after=" + JSON.stringify(names));
  ok("在线人数和在线列表对得上", after.count === names.length,
    "count=" + after.count + " users=" + names.length);
  ok("watch 连接没有改变在线人数", after.count === baseCount,
    baseCount + " -> " + after.count);
}

const own = (await api("/api/admin/sign-sessions",
  { title: "watch 推送测试 " + stamp, class_id: myClass, sign_at: "23:55", grace_minutes: 30 }, admin)).id;
ok("建本班签到成功", !!own, "id=" + own);
const pushed = await waitFor(watch.inbox, (m) => m.t === "sign.new" && m.id === own, 6000);
ok("watch 连接立刻收到 sign.new（实时通知的来源）", !!pushed);

const visible = ((await api("/api/sign/active", null, member)).sessions || []).map((s) => s.id);
ok("本班签到在 /api/sign/active 里（客户端据此决定弹不弹）", visible.includes(own),
  "可见=" + JSON.stringify(visible));

if (otherClass) {
  const other = (await api("/api/admin/sign-sessions",
    { title: "别的班的签到 " + stamp, class_id: otherClass, sign_at: "23:54", grace_minutes: 30 }, admin)).id;
  const gotBroadcast = await waitFor(watch.inbox, (m) => m.t === "sign.new" && m.id === other, 4000);
  ok("sign.new 对所有连接都广播（跨班也收得到，但客户端会过滤掉）", !!gotBroadcast, "sid=" + other);
  const after = ((await api("/api/sign/active", null, member)).sessions || []).map((s) => s.id);
  ok("跨班签到在 /api/sign/active 里看不见 → 不会弹通知", !after.includes(other));
} else {
  console.log("SKIP  只有一个班级，跳过跨班过滤的检查");
}

watch.sock.close();
live.sock.close();
await sleep(300);

console.log("\n=== " + pass + "/" + (pass + fail) + " ===");
process.exit(fail ? 1 : 0);
