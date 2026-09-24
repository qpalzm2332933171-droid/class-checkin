#!/usr/bin/env node
/**
 * check_view_template_vars.mjs —— 检查「视图模板里用到的变量，setup() 到底有没有导出」
 * =================================================================================
 *
 * 【它解决什么问题】
 *
 * 本仓库前端免构建，视图长这样：
 *
 *     registerRoute("/games/xxx", defineView("xxx", {
 *       template: `... {{ myTurn }} ...`,      // 模板能用啥，只看 setup 导出了啥
 *       style: `...`,
 *       setup() { return { isMyTurn, ... }; }  // 这里没写 myTurn，模板就引用不到
 *     }));
 *
 * 坑在于：**生产版 Vue（web/assets/vendor/vue.esm-browser.prod.js）把警告代码整个剥掉了**。
 * 模板引用一个不存在的变量时，不报错、不 warn，而是**静默渲染成空**。
 * 症状是"页面上某个按钮/文案凭空消失"，但控制台干干净净，极难排查。
 *
 * 真实案例：骗子酒馆的操作条模板写的是 myTurn，setup 导出的却是 isMyTurn，
 * 于是底部那排「质疑上家 / 盖牌出牌」按钮永远不出现，页面一直停在"等待同学出牌"；
 * 而同一屏顶部的状态文案（用的 isMyTurn）却正常显示"轮到你"——自相矛盾但零报错。
 *
 * 【它怎么做的】
 *   1. 抽出 template 字面量；
 *   2. 收集里面所有表达式（{{ }} 以及 :prop / v-if / v-for / @event 等指令的值）；
 *   3. 剔掉：字符串字面量、JS 关键字与全局对象、v-for 声明的局部变量、箭头函数形参、
 *      对象字面量的 key、`.foo` 形式的属性访问 —— 剩下的就是"模板依赖的裸变量"；
 *   4. 解析 setup() 里 return 的对象，取出所有 key（支持 getter/方法简写/spread）；
 *   5. 求差集，非空就报错并以 1 退出。
 *
 * 【它不做的事】（别指望它替代下面这些）
 *   - 不做 JS 语法检查        -> node --check file.mjs
 *   - 不做模板语法/编译检查   -> 需要 @vue/compiler-dom
 *   - 查不出逻辑错误、CSS 类名不存在、样式没生效这类问题
 *
 * 【用法】
 *   node tools/check_view_template_vars.mjs              # 检查 web/src/views 下所有视图
 *   node tools/check_view_template_vars.mjs <file...>    # 只检查指定文件
 *   node tools/check_view_template_vars.mjs --self-test  # 自检：验证它真能抓到这类 bug
 *
 * 退出码：0 = 全部通过；1 = 有视图引用了未导出的变量（可直接当 CI 断言）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VIEWS_DIR = path.join(REPO, 'web', 'src', 'views');

const KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'in', 'of', 'new', 'typeof', 'instanceof',
  'return', 'if', 'else', 'void', 'delete', 'this', 'function', 'await', 'get', 'set', 'async',
]);
const GLOBALS = new Set([
  'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date', 'RegExp',
  'console', 'window', 'document', 'navigator', 'location', 'localStorage', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'parseInt', 'parseFloat', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'NaN', 'Infinity',
  '$event', '$props', '$attrs', '$slots', '$refs', '$emit', '$el',
]);
/** app.component(...) 全局注册的组件，模板里可以直接写 */
const GLOBAL_COMPONENTS = new Set([
  'Icon', 'MatchChat', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport',
]);

/* ------------------------------------------------------------------ 解析 setup 的 return */

/** 按"顶层逗号"切分对象字面量：括号/方括号/花括号里的逗号不切，字符串与注释里的也不切。
    直接 split(',') 会被 `save() { a(); b(); }` 或 `x: f(1, 2)` 这类写法切坏。 */
function splitTopLevel(block) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (quote) {
      cur += c;
      if (c === quote && block[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '/' && block[i + 1] === '/') { while (i < block.length && block[i] !== '\n') i += 1; continue; }
    if (c === '/' && block[i + 1] === '*') {
      i += 2;
      while (i < block.length && !(block[i] === '*' && block[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 从 `{` 开始按大括号配对取出整块内容（忽略字符串里的花括号） */
function matchBraces(src, openIndex) {
  let depth = 0;
  let quote = '';
  for (let j = openIndex; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote && src[j - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, j);
    }
  }
  return '';
}

/** setup() 返回的对象字面量内容。支持两种写法：
 *    setup() { ...; return { a, b }; }
 *    setup: () => ({ a, b })          <- 简洁箭头体，仓库里 notfound.js 就是这种 */
function extractReturnBlock(src) {
  const arrow = src.lastIndexOf('=> ({');
  const plain = src.lastIndexOf('return {');
  if (arrow > plain && arrow >= 0) return matchBraces(src, src.indexOf('{', arrow));
  if (plain >= 0) return matchBraces(src, src.indexOf('{', plain));
  return '';
}

/** 取出返回对象的 key 与展开来源。 */
function exportedKeys(block) {
  const keys = new Set();
  const spreads = [];
  for (const raw of splitTopLevel(block)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith('...')) { spreads.push(entry.slice(3).trim()); continue; }
    /* get foo() / set foo() / async foo() / foo() 这类简写 */
    const method = entry.match(/^(?:get\s+|set\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/);
    if (method) { keys.add(method[1]); continue; }
    /* foo / foo: expr */
    const name = entry.split(':')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name);
  }
  return [keys, spreads];
}

/* ------------------------------------------------------------------ 解析模板 */

function templateIdentifiers(tpl) {
  const exprs = [];
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.push(m[1]);
  for (const m of tpl.matchAll(/(?:^|\s)(?::|v-|@)[\w.:-]*(?:\.[\w-]+)?="([^"]*)"/g)) exprs.push(m[1]);

  /* 模板里的局部变量：v-for 声明的、作用域插槽解构的、箭头函数形参 */
  const locals = new Set();
  for (const m of tpl.matchAll(/v-for="\(?([^)"]*?)\)?\s+in\s/g)) {
    m[1].split(',').forEach((x) => locals.add(x.trim()));
  }
  for (const m of tpl.matchAll(/(?:v-slot|#[\w-]+)="\{([^}]*)\}"/g)) {
    m[1].split(',').forEach((x) => locals.add(x.split(':').pop().trim()));
  }
  for (const m of tpl.matchAll(/(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
    (m[1] || m[2] || '').split(',').forEach((x) => locals.add(x.trim()));
  }

  const ids = new Set();
  for (const raw of exprs) {
    const e = raw.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    for (const m of e.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g)) {
      const id = m[2];
      if (KEYWORDS.has(id) || GLOBALS.has(id) || GLOBAL_COMPONENTS.has(id) || locals.has(id)) continue;
      /* 后面紧跟冒号 -> 对象字面量的 key（`{ on: x }`），不是变量引用 */
      if (/^\s*:/.test(e.slice(m.index + m[0].length))) continue;
      ids.add(id);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ 主流程 */

/** useRoom() 提供了哪些东西（视图里用 `...roomApi` 展开，静态分析看不到） */
const ROOM_API_KEYS = [
  'roomId', 'room', 'roomCode', 'roomName', 'players', 'spectators', 'isSpectator', 'others',
  'finished', 'aborted', 'winners', 'reason', 'notice', 'peerLeft', 'iWantRematch',
  'othersWantRematch', 'canRematch', 'ready', 'readyNeeded', 'myReady', 'canReady',
  'isReady', 'toggleReady', 'applyRoom', 'leaveRoom', 'rematch', 'join', 'copyCode', 'me',
];

/** 一个文件里可能注册了多个视图（chat.js 就同时注册了 /chat 和 /chat/topic）。
    必须按 defineView(...) 切段，让每段模板只跟它自己的 setup 配对，
    否则会拿第一个视图的模板去比第二个视图的返回值，报出一大堆假阳性。 */
function viewSegments(src) {
  const positions = [];
  const re = /defineView\s*\(/g;
  let m = re.exec(src);
  while (m) { positions.push(m.index); m = re.exec(src); }
  return positions.map((start, i) => {
    const end = i + 1 < positions.length ? positions[i + 1] : src.length;
    /* 往前找最近的 registerRoute("...") 当作这条视图的标签 */
    const before = src.slice(0, start);
    const route = [...before.matchAll(/registerRoute\(\s*"([^"]+)"/g)].pop();
    return { label: route ? route[1] : '', src: src.slice(start, end) };
  });
}

function checkSegment(seg) {
  const tplMatch = seg.src.match(/template:\s*`([\s\S]*?)`\s*,\s*\n\s*style:/);
  if (!tplMatch) return null;
  const block = extractReturnBlock(seg.src);
  const [keys, spreads] = exportedKeys(block);
  if (spreads.includes('roomApi') || /\.\.\.roomApi/.test(seg.src)) {
    ROOM_API_KEYS.forEach((k) => keys.add(k));
  }
  const ids = templateIdentifiers(tplMatch[1]);
  return { label: seg.label, ids: ids.size, keys: keys.size,
           missing: [...ids].filter((id) => !keys.has(id)).sort() };
}

function checkSource(src) {
  const results = viewSegments(src).map(checkSegment).filter(Boolean);
  if (!results.length) return [{ skipped: true }];
  return results;
}

function checkFile(file) {
  return checkSource(fs.readFileSync(file, 'utf8'));
}

function targetFiles(args) {
  if (args.length) return args;
  return fs.readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(VIEWS_DIR, f));
}

/** 自检：往模板里塞一个 setup 肯定没导出的变量，验证它真的会报出来。
    （一个永远通过的检查等于没有检查，所以这个必须有。） */
function selfTest() {
  const sample = path.join(VIEWS_DIR, 'game-liar.js');
  if (!fs.existsSync(sample)) { console.error('自检失败：找不到样本文件 ' + sample); process.exit(2); }
  const src = fs.readFileSync(sample, 'utf8');
  const bogus = '__definitely_not_exported__';
  const miss = (results) => results.flatMap((r) => r.missing || []);

  const clean = miss(checkSource(src));
  const dirty = miss(checkSource(src.replace(/v-else-if="isMyTurn"/, 'v-else-if="' + bogus + '"')));

  const okClean = clean.length === 0;
  const okDirty = dirty.includes(bogus);
  console.log('自检 1/2  原文件应通过            : ' + (okClean ? 'PASS' : 'FAIL ' + clean.join(',')));
  console.log('自检 2/2  注入未导出变量应被抓到  : ' + (okDirty ? 'PASS' : 'FAIL'));
  if (okClean && okDirty) { console.log('=== 自检通过，这个检查是真会失败的 ==='); process.exit(0); }
  console.error('=== 自检失败：检查本身不可信，别拿它的结果当依据 ===');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  let bad = 0;
  let skipped = 0;
  for (const file of targetFiles(args)) {
    const rel = path.relative(REPO, path.resolve(file)) || file;
    let results;
    try { results = checkFile(file); } catch (err) { console.log('ERR   ' + rel + '  ' + err.message); bad += 1; continue; }
    if (results.length === 1 && results[0].skipped) {
      skipped += 1;
      console.log('SKIP  ' + rel + '  （没有 template 字面量）');
      continue;
    }
    for (const r of results) {
      const tag = r.label ? rel + '  [' + r.label + ']' : rel;
      if (r.missing.length) {
        bad += 1;
        console.log('FAIL  ' + tag);
        console.log('      模板用到但 setup 没导出（生产版 Vue 会静默渲染成空，不报错）：');
        r.missing.forEach((m) => console.log('        - ' + m));
      } else {
        console.log('OK    ' + tag + '   （模板 ' + r.ids + ' 个变量 / setup 导出 ' + r.keys + ' 个）');
      }
    }
  }

  console.log('');
  if (bad) {
    console.log('=== ' + bad + ' 个视图引用了未导出的变量，页面上会静默少东西 ===');
    process.exit(1);
  }
  console.log('=== 全部通过' + (skipped ? '（跳过 ' + skipped + ' 个无模板文件）' : '') + ' ===');
}

main();
