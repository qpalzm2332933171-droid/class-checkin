# 骗子酒馆（Liar's Bar）实现说明

> **这份文档是给审核用的。** 分四块：①我实现了什么规则 ②架构接入点在哪 ③我定了哪些约定
> ④哪些是我自己拍板的、哪些是有意没做的。每条都标了文件:行号，可以直接对照代码看。
>
> 对应分支：`game/liarsbar`

---

## 一、做了什么

给班级签到系统加了一款 4 人联机纸牌游戏「骗子酒馆」，照 Steam 原版纸牌模式实现。

| 产物 | 位置 | 行数 |
|---|---|---|
| 服务端游戏状态机 | `server/liar.py` | 502 |
| 前端牌桌视图 | `web/src/views/game-liar.js` | 570 |
| 纯逻辑单测（假 Room 直接驱动） | `tests/liar_rules.py` | 54 项断言 |
| 协议端到端（4 个真实 WS 客户端） | `tests/liar_flow.py` | 26 项断言 |
| 浏览器 UI 回归（Playwright + Firefox 真点击） | `tests/browser/liar-ui.mjs` | 28 项断言 |

对**既有文件的改动只有 38 行、5 个文件**，没有动任何已有游戏的逻辑：

```
README.md               +5   目录结构补上新的游戏模块
server/games.py        +29   六处挂载点（见第二节）
web/src/app.js          +1   注册视图
web/src/icons.js        +2   扑克牌图标
web/src/views/games.js  +2   大厅卡片 + 路由映射
.gitignore              +3   浏览器用例的截图产物
tests/browser/README.md +20  新增用例的说明
```

---

## 二、架构：一款联机游戏是怎么接进来的

`server/games.py` 里的 `Room` 是**所有联机游戏共用的房间壳子**：房间号、座位、全员准备才开局、
观战、掉线 120 秒宽限重连、中途退出判负、战绩入库、积分 +2/-1、再来一局投票、房间列表广播，
这些统统白送。**新游戏只需要在壳子上挂一个状态机模块**——`werewolf.py` 就是这个范式的样板，
`liar.py` 完全同构（都是 `start / act / tick / view / drop` 五个入口）。

### 后端六处挂载点

| # | 位置 | 做了什么 |
|---|---|---|
| 1 | `server/games.py:10` | `import liar` |
| 2 | `server/games.py:58` | `GAME_META` 加一条 `{name, min:4, max:4, desc}`。大厅、人数校验、房间列表、结算全认它 |
| 3 | `server/games.py:213` | `Room.begin()` 加分支 → 开局 |
| 4 | `server/games.py:729` | `restart()` 加分支 → 再来一局 |
| 5 | `server/games.py:1084` | `handle()` 的 `action=="act"` 分支 → 唯一自定义指令入口 |
| 6 | `server/games.py:1174` | 新增 `liar_tick()`，在 `ticker()`（`:1191`，每 2 秒一跳）里调用 → 回合超时与开牌展示期 |

另外两处是**改已有分支**而不是新增：

- `server/games.py:152` `settle_leave()` —— 中途退出走 `liar.drop()`，把人判出局但**本局继续**
  （和狼人杀一致；默认的"多人局"逻辑只会给退出的人记 -1 分然后留着他继续占座位，对这个游戏是错的）
- `server/games.py:313` `public_state()` —— 按观看者裁剪状态，转发给 `liar.view()`

### 前端四处接入点

| # | 位置 | 做了什么 |
|---|---|---|
| 7 | `web/src/views/games.js:17` | 大厅 `ONLINE` 数组加卡片（图标 `cards`） |
| 8 | `web/src/views/games.js:417` | `routeFor()` 加 `liar → /games/liar?room=` 映射 |
| 9 | `web/src/app.js:24` | `import "./views/game-liar.js"` |
| 10 | `web/src/icons.js` | 新增 `cards` 图标（一叠牌 + 黑桃，纯描边 path，跟其余图标同一套风格） |

前端**免构建**：改完刷新浏览器即生效，不需要任何打包步骤。

---

## 三、规则实现

照 [#10545393](https://www.9game.cn/news/10545393.html) / [#10532187](https://www.9game.cn/news/10532187.html) 两份规则文实现：

- 牌堆 **20 张** = Q/K/A 各 6 张 + 赖子 J 2 张（`server/liar.py:27`），4 人各发 5 张刚好分完
- 每轮翻一张 **Table 牌**（Q/K/A 之一），全场只能"报"这张牌
- 轮到你：**盖着出 1~3 张并报数量**，或者**质疑上家**（第一手不能质疑自己）
- 质疑开牌：全是 Table/赖子 → **质疑者**挨枪；否则**出牌者**挨枪
- **左轮**：每人一把，6 个弹巢 1 颗实弹，位置随机落在第 1~6 发；头顶 `(x/6)` 是已开枪数
- **出完手牌**：下家不质疑 → 他就是本轮胜利者，本轮结束；下家质疑 → 开牌判枪，本轮同样结束
- 打光子弹的人出局，**最后一个活着的人赢**

### 状态机只有四个阶段（`server/liar.py:50` 起的 `make_state`）

| phase | 含义 |
|---|---|
| `play` | 正常回合，可以出牌 / 质疑上家 |
| `final` | 上家已经出完手牌 —— 本轮的下家**只能**质疑或者放过 |
| `reveal` | 开牌 + 挨枪的展示期，到点自动开下一轮 |
| `over` | 对局结束 |

### 我拍板的 4 条细节（原文没写死，**审核重点看这里**）

1. **质疑时只翻开"最后一手"牌，不是翻开整堆。**
   依据是原文"上家的牌会亮出"。翻开整堆会白送信息、把诈唬博弈废掉。
   → `server/liar.py:308` 的 `truthful = all(c == table or c == JOKER for c in last["cards"])`

2. **每轮先手往后轮一位**（原版没说谁先手）。避免固定某个人总先出。
   → `server/liar.py:231` 的 `state["start_i"]` 递推

3. **新一轮只给存活的人重发 5 张**，死人不再参与发牌。
   → `server/liar.py:216` 的 `for u in alive`

4. **回合超时自动出 1 张随机的牌**（不是自动质疑），可能撒谎。
   选它的理由：对局永远往前走，而且**不会因为超时白送一次质疑机会**给拖时间的人。
   `final` 阶段没有"出牌"这个选项，所以那里超时是**自动放过**。
   → `server/liar.py:379` 的 `auto_turn()`

---

## 四、约定

### 4.1 协议

复用现有联机游戏的通道，没有新增任何消息类型：

```
客户端 → 服务端   {t:"game.act", action:"act", what:"play",  cards:[0,2]}   # cards 是手牌下标
                 {t:"game.act", action:"act", what:"doubt"}
                 {t:"game.act", action:"act", what:"pass"}                # 只在 final 阶段可用
服务端 → 客户端   game.state / game.event / game.over / game.chat / game.rooms（房间壳子统一发）
```

### 4.2 状态字段（`server/liar.py:140` 的 `view()` 返回的东西）

前端能拿到的：`phase / round / table / order / names / seats / alive / turn / deadline /
round_wins / winners / revolver(已开枪数) / cylinder / hand_count / pile / last / pile_total /
reveal / log / my_hand / my_alive / my_turn / can{play,doubt,pass,max}`

三个**必须遵守的秘密约定**：

1. **`state["hands"]`（所有人的手牌）绝不能出现在 `view()` 里**，别人的手牌只暴露张数
   （`hand_count`）。前端拿不到就是拿不到，不靠前端自觉。
2. **`state["revolver"][uid]["bullet"]`（实弹在第几发）对所有人保密，包括本人** ——
   原版就这样，玩家只知道"我开过几枪"，不知道下一枪会不会响。`view()` 只输出 `fired`。
3. **未开牌时盖牌的牌面不外泄** —— `pile` 只给 `{uid, n}`，真实牌面只在 `reveal` 阶段
   通过 `state["reveal"]["cards"]` 公开，而且只公开被质疑的那一手。

`can` 是**服务端算好的**"你此刻能做什么"，前端只负责把按钮点亮/置灰，不在前端重复判断规则。

### 4.3 toast 分级（这条是踩坑之后定的，别改回去）

`announce(room, text, kind, toast=True)`（`server/liar.py:180`）。

**只有高信号事件才 `toast=True`**：开牌结论（合并成一条摘要）、放过、超时、中途退出、对局结束。
**常规流水一律 `toast=False`**：轮次开始、Table 牌、每一手"谁盖了几张"。

原因：最初每手出牌都弹 toast，一回合几十条，**直接把牌桌上半屏糊死**（浏览器截图才看出来）。
现在流水进牌桌下方的「战报」面板（`state["log"]`），由 `web/src/views/game-liar.js` 自己渲染。
开牌环节原本会连弹 5 条（质疑/开牌/举枪/枪响/结束），**合并成 1 条摘要**。

### 4.4 测试/调参旋钮

`db.setting("liar_speed")` 可以把所有阶段时长整体加速（默认 1），给自动化测试用：
`server/liar.py:40` 的 `secs()`，下限 2 秒。狼人杀有同款 `ww_speed`。
**这只是测试用的，生产别设。**

### 4.5 前端约定

- **CSS 类名一律加 `liar-` 前缀**。`defineView` 的 `style` 是**全局注入**的（不是 scoped），
  现有视图里已经出现过 `.head` / `.code-btn` / `.overlay` 撞名互相覆盖的情况。
- **牌面花色用内联 SVG path，不用 `♠♥♦` 字符**。Unicode 花色在部分安卓 WebView 上会被
  渲染成 emoji（大小和颜色失控）。花色按点数固定（Q=♠ K=♥ A=♦ J=★），
  这样同一张牌整局花色不变，横扫一眼就能分清点数。
- **倒计时用服务端时间校准**：服务端 `deadline` 是 unix 秒，手机时间不准会显示成负数或乱跳。
  视图通过 WS `ping/pong`（`pong.ts` 是服务端时间）算时钟差再渲染。
- **手牌用稳定 key**（`tokens`）：打出去的牌要准确地飞走，而不是让 Vue 把数组最后一张删掉。

---

## 五、怎么验

```bash
# 1) 纯逻辑，不用起服务器（改完逻辑几秒跑一遍）
python tests/liar_rules.py                      # 54/54

# 2) 协议端到端：4 个真实 WS 客户端打完整一局
python tests/liar_flow.py [base] u1:p1 u2:p2 u3:p3 u4:p4        # 26/26

# 3) 浏览器真点击（Playwright + Firefox，Linux 上跑）
LIAR_ACCOUNTS='u1:p1 u2:p2 u3:p3 u4:p4' node tests/browser/liar-ui.mjs   # 28/28
```

跑 2)3) 之前建议把 `liar_speed` 设成 5，否则开牌展示期太长跑不完。

三个套件职责不重叠：①钉规则 ②钉协议与秘密隔离 ③钉渲染与交互。
外加既有 `python tests/smoke.py` 无回归（39/39）。

**浏览器用例抓出来的 4 个真 bug**（纯协议测试和模板编译都发现不了，记在这里提醒以后别只跑前两个）：

1. 模板引用 `myTurn`，setup 导出的是 `isMyTurn`；`nameOf(turn)` 里 `turn` 也没导出。
   生产版 Vue 静默渲染 `undefined`，症状是**底部操作条永远停在"等待"**。
2. toast 洪水（见 4.3）。
3. 开牌环节连弹 5 条 toast。
4. 结束浮层被固定操作条压住；右下角"讨论"悬浮球盖住战报最后两行。

---

## 六、已知限制 / 有意没做

1. **没做「魔鬼牌」变体**（单张打出、被质疑且开牌是魔鬼牌时全场除出牌者外各挨一枪）。
   按约定 v1 只做基础牌局，当 v2 彩蛋。牌堆常量在 `server/liar.py:27`，加牌不难。
2. **人数锁死 4 人**。20 张牌刚好 4×5 分完，最接近原版；2~3 人会让诈唬张力变弱，
   所以 `MIN_PLAYERS == MAX_PLAYERS == 4`。
3. **一轮 6~10 分钟**（真人节奏）。课间想打两局的话需要"每人 3 张"的快节奏选项，
   `HAND_SIZE` 已经是常量，改动很小，但会牵动建房选项 UI —— 没做。
4. **"已准备"的 toast 会连弹 N 条**（4 个人一起准备就是 4 条）。这来自共享的
   `Room.toggle_ready()`，**是既有问题不是本次引入的**，狼人杀 12 人局更夸张。
   要修的话是改共享代码，影响所有游戏，所以这次没动。
5. **观众看不到手牌信息**。观战者拿到的是 `viewer.uid = 0` 的裁剪结果，看不到任何人的手牌 ——
   这是对的（观战不能作弊），但观战体验也相应地只剩下公开信息。
6. **`tests/browser/shots/` 里的截图**已加进 `.gitignore`。它们是每次跑都会变的人眼验收材料，
   如果想入库当文档，说一声我挪到 `docs/shots/`。

---

## 七、我建议你审核时重点看的

1. **第三节那 4 条拍板细节** —— 这几处原文没写死，改起来现在最便宜。
2. **`server/liar.py:140` 的 `view()`** —— 秘密信息有没有漏。这是唯一一处"漏了就等于开挂"的地方，
   `tests/liar_rules.py` 里有 6 条断言专门钉它，`tests/liar_flow.py` 里还有 4 条走网络的。
3. **`server/games.py:152`** —— 中途退出的处理，我改了共享函数里的分支。
4. **第四节 4.3 的 toast 分级** —— 如果觉得某个事件该弹而没弹（或反之），改 `toast=` 参数即可。
