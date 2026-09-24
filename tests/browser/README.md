# 浏览器端回归测试（headless Edge + CDP）

这里跑的是**真浏览器、真点击**的端到端用例，和 `tests/games_ws.py`（纯协议）、
`tests/smoke.py`（REST/WS 冒烟）互补：界面上的浮层、toast、按钮这类只有渲染层才看得见的东西靠它们兜底。

## 前置

1. 本地服务跑起来（`_start_local.ps1` 或手动 `CHECKIN_PORT=8081 python server/app.py`）。
2. 开三个无头 Edge 的远程调试端口（默认 9336 / 9337 / 9338，对应三个学生/管理端账号）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --remote-debugging-port=9336 `
  --remote-allow-origins=* --no-first-run --user-data-dir=D:\learn\_ep9336 --window-size=430,932 about:blank
# 9337 / 9338 同理
```

3. 在 `accounts.json` 里填三个测试账号的用户名/密码（`admin` 一项只有个别用例会用到）。

## 用例

| 文件 | 验什么 | 需要的环境变量 |
|------|--------|----------------|
| `ready-and-spectate.mjs` | 联机准备机制（一个人准备不开局、两个人都准备才开局）＋观战者在正常分胜负时的浮层与 toast ＋观战返回弹窗文案 | — |
| `abort-and-bomb.mjs` | 有人中途退出时观战者的"本局已中止"提示 ＋ 观战返回弹窗文案 ＋ 数字炸弹的"方向标记 / 安全区间"是否自洽 | — |
| `draw-result.mjs` | 平局时观战者的提示（下满 9 手的井字棋） | — |
| `features-round-m.mjs` | M 阶段：讨论匿名按钮、积分排行榜、扫雷难度、更新日志入口 | — |
| `features-round-o.mjs` | O 阶段：头像上传与展示、管理端滑块、管理端头像 | — |
| `features-round-p.mjs` | P 阶段：滑页手势（模拟微信那种跟手切换，含联机/单机、管理页签的二级联动） | — |
| `features-round-q.mjs` | Q 阶段：围棋 9/19 路、画猜词库与打码、观战弹幕、象棋将军/绝杀动画 | — |
| `features-round-r.mjs` | R 阶段：滑页时毛玻璃不降级成白块、签到窗口、定位选点+搜索按远近排序、资委记录页、Excel 导出、更新日志不再发公告 | `ADMIN_USER`/`ADMIN_PASS`、`STAFF_USER`/`STAFF_PASS` |
| `layout-audit.mjs` | **布局审计**：16 个页面 × 9 种尺寸（窄屏/宽屏/平板/横屏/超宽），检查组件越界与"不该发生的换行"，用于拦住不同分辨率下 UI 被挤到下一行的问题 | `AUDIT_USER`/`AUDIT_PASS` |
| `liar-ui.mjs` | 骗子酒馆牌桌：建房/4 人加入/准备开局、牌面与弹巢渲染、选牌与按钮文案、开牌面板、当事人区分、结束浮层、再来一局。**用系统自带的 Firefox（WebDriver BiDi）**（不是下面的 CDP/Edge 那套），关键画面截图到 `shots/` | `LIAR_ACCOUNTS`（4 个账号） |

### liar-ui.mjs 单独说明

它是唯一一个**不用 CDP/Edge** 的用例：在 Linux 上跑，浏览器用**系统自带的 Firefox**，
通过 `bidi-firefox.mjs`（WebDriver BiDi，Firefox 129+ 原生支持）驱动。
**不需要 Playwright、不需要下载任何浏览器**，只要 `which firefox` 能找到就行。

```bash
# 零依赖直接跑
CHECKIN_BASE=http://127.0.0.1:8081 \
LIAR_ACCOUNTS='u1:p1 u2:p2 u3:p3 u4:p4' \
node tests/browser/liar-ui.mjs
```

跑之前建议把 `liar_speed` 调大（例如 5）让开牌展示期变短，整局才跑得完。

`bidi-firefox.mjs` 是一层 **Playwright 风格的薄封装**（`launch / newContext / addInitScript /
newPage / goto / evaluate / locator().click() / screenshot`），用法跟 Playwright 很像，
但有两处不一样：

- `page.url()` 是**异步**的（Playwright 那个是同步的），记得 `await`。
- `locator` 只实现了 `count / click / first / nth / last / isDisabled / textContent`；
  选择器支持 CSS 和 Playwright 的 `text=xxx`，`{ hasText }` 也支持。

**踩过的坑（改这个 harness 时注意）**
Firefox 默认**节流后台标签页** —— 后台标签页不跑 CSS 过渡，于是 Vue 的 `<Transition>`
永远等不到 `transitionend`：离场元素不回收（手牌区一度堆到 89 张）、结束浮层停在
`opacity:0` 迟迟不出现，看起来像应用出了 bug。harness 里做了两件事治它：
profile 里写 `user.js` 关掉后台节流，并且**每次交互前用 `browsingContext.activate`
把目标标签页切到前台**。加新用例时不要绕过这两点。

## 运行

```powershell
cd D:\learn\class-checkin\tests\browser
$env:CDP_PORTS='9336'
node ready-and-spectate.mjs
node features-round-q.mjs

# 需要管理员/资委口令的用例：口令只从环境变量进，绝不写进仓库
$env:ADMIN_USER='admin'; $env:ADMIN_PASS='<本地管理员口令>'
$env:STAFF_USER='cw01';  $env:STAFF_PASS='<本地资委口令>'
node features-round-r.mjs

$env:AUDIT_USER=$env:ADMIN_USER; $env:AUDIT_PASS=$env:ADMIN_PASS
node layout-audit.mjs
```

可用环境变量：`CHECKIN_BASE`（默认 http://127.0.0.1:8081）、`CDP_PORTS`（默认 9336,9337,9338，
审计脚本只取第一个）、`ADMIN_USER`/`ADMIN_PASS`、`STAFF_USER`/`STAFF_PASS`、`AUDIT_USER`/`AUDIT_PASS`。

## 坑

- **必须开 `Network.setCacheDisabled`**（harness 里已经做了）。headless 浏览器会把 ESM 模块缓存在内存里，
  不清缓存的话改完代码刷新页面还是旧逻辑，很容易误判成"改动没生效"。
- 页面上的"班级公告"弹窗会盖住棋盘，点击全部落到弹窗上 —— harness 的 `clickSel` 会先自动关掉它。
- **换 hash 后要整页重载**：只改 `location.hash` 属于 same-document 导航，紧接着 `location.reload()` 会拿到**旧 hash**。
  正确做法是 `page.goto(BASE + '/?t=' + Date.now() + '#/route')`。
- **判断"当前是哪个页面"别用裸的 `.page`**：分页轨道会把左右相邻页也渲染在 DOM 里，要用 `.pager-pane.cur` /
  `.ad-pane.cur` / `.x-pane.cur` 这种 `.cur` 标记；审计脚本要跳过非 `cur` 的分页轨。
- 管理页页签点击要**循环点几次并校验 `.ad-segs button.on` 的文案**才算切成功（点击与滚动动画有竞争）。
- 祖先里有 `overflow-x: auto/scroll` 的元素属于设计内横向滚动，**不算**布局溢出。
