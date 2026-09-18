#!/usr/bin/env node
/* WebView 远程调试小工具（安卓壳调试 H5 用）。
 *
 * 用法:
 *   1) adb -s emulator-5556 shell "cat /proc/net/unix | grep -o '@webview_devtools_remote[^ ]*' | sort -u"
 *   2) adb -s emulator-5556 forward tcp:9223 localabstract:webview_devtools_remote_<pid>
 *   3) node tools/cdp.mjs script.js      # script.js 里写一段要执行的 JS（可用 await）
 *
 * 说明: 页面里的 fetch("/api/...") 会失败（file:// 协议），必须写绝对地址，
 *       例如 http://127.0.0.1:8081/api/... 。
 *       注意 WebView 会**静默吞掉** ReferenceError：某段逻辑整块不生效时，
 *       先怀疑是模板里用了没导出的符号（本轮的"话题页白屏"就是这么来的）。
 */
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || '9223';
const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/cdp.mjs <要执行的脚本.js>');
  process.exit(2);
}
const code = fs.readFileSync(file, 'utf8');
const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
/* 挑一个真正的网页标签：优先 about:blank，其次 http(s)，最后才退到任意 page
   （Edge headless 会自带 edge:// 内部页和插件后台页，不能盲选第一个） */
const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome-extension):/.test(t.url || ''));
const page = pages.find((t) => t.url === 'about:blank')
  || pages.find((t) => /^https?:/.test(t.url || ''))
  || pages[0]
  || list.find((t) => t.type === 'page');
if (!page) {
  console.error('没找到可调试页面，检查 adb forward 和 WebView 调试开关');
  process.exit(3);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => {
  const mid = ++id;
  return new Promise((resolve) => {
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
};
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const res = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true });
if (res.result && res.result.exceptionDetails) {
  console.log('EXCEPTION: ' + JSON.stringify(res.result.exceptionDetails).slice(0, 900));
}
const out = res.result && res.result.result;
console.log(JSON.stringify(out && out.value !== undefined ? out.value : out, null, 1));
ws.close();
process.exit(0);
