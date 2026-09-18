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

| 文件 | 验什么 |
|------|--------|
| `ready-and-spectate.mjs` | 联机准备机制（一个人准备不开局、两个人都准备才开局）＋观战者在正常分胜负时的浮层与 toast ＋观战返回弹窗文案 |
| `abort-and-bomb.mjs` | 有人中途退出时观战者的"本局已中止"提示 ＋ 观战返回弹窗文案 ＋ 数字炸弹的"方向标记 / 安全区间"是否自洽 |
| `draw-result.mjs` | 平局时观战者的提示（下满 9 手的井字棋） |

## 运行

```powershell
cd D:\learn\class-checkin
node tests\browser\ready-and-spectate.mjs
node tests\browser\abort-and-bomb.mjs
node tests\browser\draw-result.mjs
```

可用环境变量：`CHECKIN_BASE`（默认 http://127.0.0.1:8081）、`CDP_PORTS`（默认 9336,9337,9338）。

## 坑

- **必须开 `Network.setCacheDisabled`**（harness 里已经做了）。headless 浏览器会把 ESM 模块缓存在内存里，
  不清缓存的话改完代码刷新页面还是旧逻辑，很容易误判成"改动没生效"。
- 页面上的"班级公告"弹窗会盖住棋盘，点击全部落到弹窗上 —— harness 的 `clickSel` 会先自动关掉它。
