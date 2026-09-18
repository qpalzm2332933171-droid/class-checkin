# 班级签到系统 (class-checkin)

25 人小班的一体化工具：签到 / 匿名讨论 / 小游戏 / 安卓客户端（含热更新）。
后端 **零第三方依赖**（Python 标准库），前端 **免构建**（Vue 3 浏览器版 ESM）。

## 目录结构

```
class-checkin/
├── server/         后端（stdlib asyncio HTTP + 自研 WebSocket）
│   ├── app.py        HTTP 核心：路由 / 静态文件 / ETag / WS 升级
│   ├── api.py        全部 REST 接口
│   ├── ws.py         WebSocket：握手 / 帧编解码 / 在线状态 / 匿名聊天
│   ├── games.py      房间模型 + 4 款联机游戏的服务端权威逻辑
│   ├── db.py         SQLite 表结构与访问层
│   ├── auth.py       pbkdf2 口令 + 会话 token
│   └── bootstrap.py  首次启动生成初始账号
├── web/            前端 H5（免构建，改完即生效）
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── assets/       图标 + Vue 运行时
│   └── src/
│       ├── styles.css   设计系统（毛玻璃 / 液态玻璃 / 深浅色 / 动效降级）
│       ├── ui.js        Vue 导出 + 视图注册器 + 路由 + api + WS 客户端
│       ├── icons.js     内联 SVG 图标
│       ├── app.js       根组件（底栏 / toast / 全局确认框）
│       └── views/       各页面
├── android/       安卓壳工程（WebView + 热更新）
├── tests/         冒烟测试（35 项接口断言）
├── tools/         provision.py（批量开号）/ make_icon.py（生成图标）
└── docs/          部署说明 / 账号表 / 界面截图
```

## 本地运行

```powershell
cd D:\learn\class-checkin\server
$env:CHECKIN_PORT='8081'; $env:CHECKIN_DATA='D:\learn\class-checkin\data'; $env:CHECKIN_WEB='D:\learn\class-checkin\web'
python app.py
python D:\learn\class-checkin\tests\smoke.py http://127.0.0.1:8081 <管理员密码>
```

## 服务器

- 地址：`http://<你的公网IP>:<外网端口>/`（面板 NAT 映射 外网端口 → 内网 18100）
- 服务：`systemctl {status|restart} class-checkin`，日志 `/opt/class-checkin/data/server.log`
- 数据库：`/opt/class-checkin/data/app.db`（后台"高级"页可一键下载备份）
- 重新部署：`deploy\redeploy.ps1`（默认 ssh 别名 `vanmc`，可 `-Remote <别名>` 覆盖）

## 权限模型

| 角色 | 能力 |
|---|---|
| 普通成员 | 签到 / 请假 / 看自己的记录 / 匿名讨论 / 全部小游戏 / 改自己的资料与密码 |
| 管理员 | 以上全部 + 成员增删改（含封禁、禁言、重置密码、改角色）+ 场次管理 + 补签改签 + 讨论管理 + 公告群发 + 系统开关 + H5 热更新包上传 + 数据库备份 + 审计日志 + SQL 控制台 |

## 安卓客户端

```powershell
cd D:\learn\class-checkin\android
.\build.ps1                                   # 用默认服务器地址打包
.\build.ps1 -Server http://你的地址:端口       # 换服务器
```

产物在 `android/dist/class-checkin-<版本>.apk`，可直接发给同学安装。
换服务器地址、改包名、换签名密钥都在 `build.ps1` 的参数与 `app/AndroidManifest.xml` 里。

## 热更新（两种方式，任选）

**方式一（推荐，一条命令）**

```powershell
python tools\publish_h5.py http://<你的服务器>:<端口> <管理员密码> "本次改了什么"
```

**方式二**：后台 →「高级」→ 上传 H5 热更新包（选 zip，填版本号）

之后客户端的表现：每次启动静默检查一次；也可以在「我的 → 检查更新」手动拉。
更新包下载后会在本地原子替换，**不需要重新安装 APK**。

## 技术选型理由

- 签到峰值仅 25 人 / 3 分钟，2 核 4G 的服务器用标准库单进程足够，省掉依赖地狱
- 免构建前端 = 改一个文件立刻生效，适合课间五分钟改需求
- WebSocket 自研让整个系统只需 1 个公网端口（HTTP 与 WS 共用）
