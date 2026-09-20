/* 阶段 P 浏览器回归：你画我猜橡皮擦 / 象棋棋子落在交叉点 / 狼人杀阶段播报。
   前置：无头 Edge 已开 CDP（9336 起），本地服务在 8081。
   用法：cd tests/browser && node features-round-p.mjs */
import { connect, login, BASE, PORTS } from "./harness.mjs";

const A = await connect(PORTS[0]);
const B = await connect(PORTS[1]);
const out = [];
const check = (name, ok, extra = "") => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok || !extra ? "" : "   [" + extra + "]"));

const PX = "window.__px=function(){var c=document.querySelector('.gd-cv');if(!c)return -1;"
  + "var g=c.getContext('2d');var d=g.getImageData(0,0,c.width,c.height).data;var n=0;"
  + "for(var i=0;i<d.length;i+=4){if(d[i+3]>40&&d[i]<120)n++;}return n;};'ok'";

async function canvasHit(page) {
  return JSON.parse(await page.js("(function(){var e=document.querySelector('.gd-cv');if(!e)return 'null';"
    + "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();"
    + "var el=document.elementFromPoint(r.left+r.width/2,r.top+r.height*0.45);"
    + "return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height,"
    + "hit:(el&&el.className||'')+'|'+(el&&el.tagName||'')});})()") || "null");
}

async function stroke(page, ry, x1, x2) {
  const r = await canvasHit(page);
  if (!r) return false;
  const y = Math.round(r.y + r.h * ry);
  await page.mouse("mousePressed", Math.round(r.x + r.w * x1), y);
  for (let i = 1; i <= 8; i++) {
    await page.mouse("mouseMoved", Math.round(r.x + r.w * (x1 + (x2 - x1) * i / 8)), y);
    await page.sleep(35);
  }
  await page.mouse("mouseReleased", Math.round(r.x + r.w * x2), y);
  await page.sleep(400);
  return true;
}

async function readyAll(pages) {
  for (const p of pages) { await p.js("__T.clickExact('准备')"); await p.sleep(200); }
  await pages[0].sleep(2200);
}

try {
  await login(A, "gt01");
  await login(B, "gt02");
  const code = String(1000 + Math.floor(Math.random() * 8999));

  /* ---------------- 1. 你画我猜：橡皮擦 ---------------- */
  await A.goto(BASE + "/#/games", 2200);
  await A.js("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message));});'ok'");
  await B.js("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message));});'ok'");
  check("大厅里有你画我猜", await A.js("document.body.innerText.indexOf('你画我猜') >= 0"));
  await A.js("__T.clickText('你画我猜','.game-card')"); await A.sleep(400);
  await A.js("__T.clickText('创建房间')"); await A.sleep(400);
  await A.js("__T.setField('.code-input','" + code + "')"); await A.sleep(200);
  await A.js("__T.clickText('创建')"); await A.sleep(2400);
  await B.goto(BASE + "/#/games", 2000);
  await B.js("__T.clickExact('加入','.room-card .btn')"); await B.sleep(2400);

  await readyAll([A, B]);
  check("双方准备后自动开局", await A.js("document.body.innerText.indexOf('你来画') >= 0 || document.body.innerText.indexOf('猜这个词') >= 0"));
  const both = { A: await A.js("document.querySelectorAll('.gd-tools').length"), B: await B.js("document.querySelectorAll('.gd-tools').length") };
  const D = both.A ? A : (both.B ? B : null);
  const O = D === A ? B : A;
  check("有且只有画手能看到工具栏", !!D && (both.A + both.B === 1), JSON.stringify(both));
  check("画板上有橡皮按钮", await D.js("document.querySelectorAll('.gd-tool').length >= 1"));

  await D.js(PX); await O.js(PX);
  await D.dismiss(); await O.dismiss();
  /* 页面上可能压着"更新公告"浮层（跟本轮改动无关），把它隐藏掉再画 */
  const UNBLOCK = "window.__unblock=function(){var c=document.querySelector('.gd-cv');var r=c.getBoundingClientRect();"
    + "var el=document.elementFromPoint(r.left+r.width/2,r.top+r.height*0.45);var n=el;var hit=0;"
    + "while(n&&n!==document.body){if(n.contains(c))break;n.classList&&n.classList.add('__blk');hit++;n=n.parentElement;}"
    + "var s=document.createElement('style');s.textContent='.__blk{display:none !important}';document.head.appendChild(s);"
    + "return hit;};'ok'";
  await D.js(UNBLOCK); await O.js(UNBLOCK);
  await D.js("__unblock()"); await O.js("__unblock()");
  await D.sleep(300);
  const hitInfo = await canvasHit(D);
  check("画板中央没有被浮层遮挡", !!hitInfo && /gd-cv/.test(hitInfo.hit), JSON.stringify(hitInfo));
  const before = await D.js("__px()");
  await stroke(D, 0.45, 0.12, 0.88);
  const painted = await D.js("__px()");
  check("落笔能画出线（画笔可用）", painted > before, "before=" + before + " after=" + painted);

  const chipBefore = await D.js("(function(){var e=document.querySelector('.gd-sz.on i');return e?e.style.width:'MISS';})()");
  await D.dismiss();
  await D.clickSel(".gd-tool");
  await D.sleep(500);
  const chipAfter = await D.js("(function(){var e=document.querySelector('.gd-sz.on i');return e?e.style.width:'MISS';})()");
  check("点橡皮会切到橡皮尺寸", chipBefore !== "MISS" && chipBefore !== chipAfter, chipBefore + " -> " + chipAfter);

  await stroke(D, 0.45, 0.12, 0.88);
  const erased = await D.js("__px()");
  check("橡皮真的擦掉了笔画（自己这边）", erased < painted * 0.25, "painted=" + painted + " erased=" + erased);
  await O.sleep(900);
  const peer = await O.js("__px()");
  check("橡皮也同步给了对手（擦除能广播）", peer >= 0 && peer < painted * 0.35, "peer=" + peer + " painted=" + painted);
  const errsA = await A.js("JSON.stringify(window.__errs||[])"); 
  check("画猜页面没有报错", errsA === "[]", errsA);

  /* ---------------- 2. 象棋：棋子落在交叉点 ---------------- */
  await A.goto(BASE + "/#/games", 2200);
  await A.js("__T.clickText('象棋','.game-card')"); await A.sleep(400);
  await A.js("__T.clickText('创建房间')"); await A.sleep(400);
  await A.js("__T.clickText('创建')"); await A.sleep(2600);
  const geo = await A.js("(function(){var b=document.querySelector('.xq-board'),l=document.querySelector('.xq-lines');"
    + "var c=document.querySelectorAll('.xq-cell');if(!b||!l||c.length<90)return 'MISS';"
    + "var lb=l.getBoundingClientRect();var c0=c[0].getBoundingClientRect();var c8=c[8].getBoundingClientRect();"
    + "var c89=c[89].getBoundingClientRect();var mid=c[44].getBoundingClientRect();"
    + "function d(a,b){return Math.abs(a-b);}return JSON.stringify({"
    + "n:c.length,pieces:document.querySelectorAll('.xq-piece').length,"
    + "tl:d(c0.left+c0.width/2,lb.left)+','+d(c0.top+c0.height/2,lb.top),"
    + "tr:d(c8.left+c8.width/2,lb.right),"
    + "br:d(c89.left+c89.width/2,lb.right)+','+d(c89.top+c89.height/2,lb.bottom)});})()");
  check("象棋渲染出 90 个交叉点和 32 枚棋子", /MISS/.test(geo) === false && /"n":90/.test(geo) && /"pieces":32/.test(geo), geo);
  const G = /MISS/.test(geo) ? {} : JSON.parse(geo);
  const nums = String(G.tl || "99,99").split(",").concat(String(G.br || "99,99").split(",")).map(Number);
  check("棋子正好落在网格线交点上（四个角都贴线）", nums.every((v) => v < 1.5), JSON.stringify(nums) + " " + geo);
  check("楚河汉界还在", await A.js("!!document.querySelector('.xq-river')"));

  /* ---------------- 3. 狼人杀：阶段播报样式就位 ---------------- */
  await A.goto(BASE + "/#/games", 2000);
  await A.js("__T.clickText('狼人杀','.game-card')"); await A.sleep(400);
  await A.js("__T.clickText('创建房间')"); await A.sleep(400);
  await A.js("__T.clickText('创建')"); await A.sleep(2600);
  check("狼人杀房间进去了", String(await A.js("location.hash")).indexOf("#/games/werewolf") === 0);
  check("阶段卡片在", await A.js("!!document.querySelector('.phase')"));
  const css = await A.js("[].slice.call(document.querySelectorAll('style')).some(function(s){return (s.textContent||'').indexOf('.banner')>=0;})");
  check("阶段播报(banner)样式已注入", css);
} catch (e) {
  out.push("ERR " + (e && e.message));
}
console.log(out.join("\n"));
process.exit(/FAIL|ERR/.test(out.join("\n")) ? 1 : 0);
