# 手机界面与 PWA

- 日期：2026-10-18（已实现于 fork，合入上游前补 Issue/Discussion）
- 相关：#315、讨论 #50
- 代码：`ds-bot/src/client/`（多处）、`ds-bot/src/host/pwa.js`（新增）、`ds-bot/index.js`（MODULES 挂载）、`ds-bot/src/host/pwa/`（图标资源）

## 为什么

DS Bot 的界面是桌面优先的：360–430px 视口下聊天列塌到接近 0、设置页只剩约 144px、消息操作靠 hover 在触屏上根本点不到（#315 有逐条清单）。而 `dsh web`（尤其 Docker/NAS 部署）天然能被手机浏览器访问，愿景第 8、9 条也要一个精良、独立的界面。

目标是：手机浏览器把 DS Bot 装到主屏，用起来像 app；手机锁屏后轮询会停，Bot 等用户回答的事（问题、审批）要靠 Web Push 送达——这是推送的实际价值，不是锦上添花。

## 已定的行为

### 断点

- 手机布局阈值 `max-width:768px`；JS 分支和 CSS 断点共用 `src/client/mobile.js` 里的一个 `matchMedia` helper，不散落裸数值。
- 768–1024px 沿用 DSH 自有的窄窗口行为（侧栏收起成 56px rail），不做额外布局。

### 窄屏布局（≤768px）

- 侧栏改成全屏抽屉遮罩，不再留下占位的窄条；点 scrim 关闭，仍由 `ctx.layout.toggleSidebar()` 驱动。
- 详情/Bot 浏览器面板全屏覆盖：不再对会话列写 `margin-right` 挤压（修 #315 A1），不可拖拽改宽，顶部给返回。
- 设置、用量、记忆、新建对话、定时任务：全屏单列，页签可横向滚动；对话框高度用 `100dvh`，padding 算 `env(safe-area-inset-*)`。
- 上下文菜单、模型/思考等级菜单、composer「+」菜单改为贴底 sheet；`@` 菜单保留原位，高度跟 `visualViewport`。
- 消息操作（表情/回复/更多）在触屏上常显于气泡下方（修 #315 C1、C2，沿用 `.bt-mem-remove` 已有的 `hover:none` 思路）。
- 触控目标 ≥40px；删掉「看不见但点得到」的关闭按钮（#315 C3）；面板拖拽 grip 窄屏隐藏。
- 输入框字号 ≥16px，避免 iOS 聚焦自动放大。
- 桌面端的一切布局、菜单、弹窗行为不变。

### PWA（仅 `dsh web`）

- 新模块 `src/host/pwa.js`：`ctx.get('webServer')` 为空即整体不挂载，Desktop 与 headless 不受影响。
- `webServer.register` 路由：`/ds-bot/manifest.webmanifest`（exact）、`/ds-bot/icons/<file>`（prefix）、`/sw.js`（exact）。SW 必须挂在源站根路径——放 `/ds-bot/` 下 scope 就只有 `/ds-bot/`，管不到整站。这些是公开静态资源，不要求登录（index 的 `authorizeIndex` 和 `/api` 的 Host 校验都不覆盖插件路由）。
- index meta 走 `webserver/index-inject` 结构化注入行（kind `html`，进 `<head>`）：manifest 链接、`theme-color`、`mobile-web-app-capable`、`apple-mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style`、`apple-touch-icon`；`viewport-fit=cover` 由 `webServer.tapIndex` 补进已有的 viewport meta。页面品牌为 DS Bot。
- Manifest：`name`/`short_name` "DS Bot"，`start_url "./"`，`scope "./"`，`display "standalone"`，`theme_color`/`background_color` 取默认主题；icons 给 192/512（any）+ maskable。图标原创，用 `characters.js` 的 mark 形象经脚本渲成 PNG，提交进 `src/host/pwa/`（`files` 已含 `src/host/`）。
- 客户端在 `client.js` 里注册 SW（scope `/`）。SW 策略：导航和插件脚本走 network-first（插件更新不被旧缓存卡住），带 hash 的静态资源 cache-first，断网时导航回落到缓存过的页面。

### Web Push

- Host 启动时生成 VAPID 密钥对，私钥与订阅都存 `DSH_HOME/bot/push.json`（0600，与 state.json、模型请求隔离）；公钥经 `api/bot` 的 `push-key` 端点下发给客户端。
- 客户端在「设置 → 本设备」里手动开关：开启时请求通知权限 → `pushManager.subscribe` → 订阅经 `push-subscribe` 端点上报（按 endpoint 去重）；推送返回 404/410 即清掉该订阅。
- 第一期只推「等用户介入」的事：`ask_user` 提问、权限审批、secret 请求（`rt.pushWait` 在 approvals/tools/secrets 三处挂点，按条目 id 去重）。普通回合完成、普通消息不推。
- payload 最小化：只有「哪个 Bot + 需要哪类介入 + 条目 id」，不含消息正文——payload 要经过浏览器厂商的 push 服务（FCM / Mozilla autopush），是第三方通道。点通知聚焦或打开应用。
- 发送用 `web-push@3.6.7`（钉死版本）。
- 推送相关端点（公钥、订阅）一律走 `ctx.connection.fetch.register`（`/api/...`），白拿 Host/Origin fence + 会话 cookie；公开 `webServer.register` 只放 manifest、图标、SW 这类非敏感静态资源。

### 远程访问：本地配对 PIN 门（pair-gate）

- `dsh web` 强制只绑 `127.0.0.1`；挂隧道（cloudflared / 反向代理）把手机接进来是部署方的事。暴露到公网后，`?token=` URL 本身是 bearer 凭证——泄漏即等于交出整台机器的操作权（Bot 有工具、能写文件）。单靠这个 URL 不够，前面要加一道本地配对门。
- `pwa.js` 在插件进程内再开一个 HTTP 服务（`config.pairPort` 或环境变量 `DS_BOT_PAIR_PORT`，不配置则不监听），做反向代理门：无 gate cookie 的请求只回 PIN 表单页，不转发；有合法 cookie 才把请求（含 WS upgrade 的裸 socket 透传）代理到 `127.0.0.1:<dsh 端口>`。隧道一律指向 gate 端口。来自本机回环地址且 Host 也是回环的请求直接放行（本机进程本来就够得着 dsh，PIN 只会卡住显示 PIN 的那个界面），因此同一端口上本地浏览器照旧用 dsh 的 token/cookie 登录，远程流量才走 PIN。
- PIN 流程：手机首次打开 → 表单页触发 `mintPin` 生成 6 位 PIN（TTL 5 分钟）→ **PIN 只显示在本地已登录的界面里**（侧栏横幅 + 「设置 → 本设备」卡片，经 `live().pair` 随状态下发到已鉴权浏览器）→ 手机输入 → `POST /pair` 校验通过 → gate 自签 cookie（`dsb_pair`，HMAC-SHA256、HttpOnly、30 天）→ 303 回跳表单里保存的原 URL（`next`）。结果是用户只看到一道 PIN——dsh 的 token 换 cookie 由 gate 代答（见下条）。
- Token 代答：gate 代理 index 请求（`GET /`、`GET /index.html`）时若 dsh 回 401，就用 `ctx.connection.authenticatedUrl()` 读到的 launch token 重写一次上游请求——dsh 照常验 token、照常 mint 自己绑定该 authority 的 cookie，但 token 永不出现在浏览器 URL/历史里。dsh cookie 过期也被同一机制静默续上；远端用户全程只输过 PIN。
- 防爆破：PIN 比对用 `timingSafeEqual`；连续 5 次错误作废该 PIN 并冷却 60 秒；PIN 一次性，验证成功即失效；没有进行中的 `pair-begin` 就不存在可猜的 PIN。
- Gate 签名密钥 32 字节随机，存 `DSH_HOME/bot/pair-gate.json`；不经会话、不进模型请求。
- 隧道侧仍需 HTTPS（SW/push 的硬门槛同样适用于这条链路）；`dsh web` 侧按实际域名加 `--trusted-host`。
- 定位：gate 管传输层准入，dsh 的 token/cookie 仍是第二层；两者都不省——只是第二层对远端用户不可见。

## 不做什么

- 不做原生或套壳 app；不改 DSH。Desktop 端不做 PWA——Electron 本身就是 app。
- 第一期不推普通消息和回合完成；不做通知分组/折叠。
- 不做离线编辑和发送队列；离线只读缓存过的界面。
- 不做滑动手势、下拉刷新。
- 手机端不做 Bot 浏览器面板：`read_browser` 本来只有 Desktop 有，手机上面板只有 details 视图。

## 已知限制

- **HTTPS 是硬门槛**：SW 注册和 Push 都要求 secure context，`http://<局域网 IP>` 上只能安装 manifest，SW 和推送不工作。Docker README 要写明：手机用全功能必须在前面挂 HTTPS 反代；公网暴露（隧道/反代）要同时配置 pair-gate 端口与 `--trusted-host`，且 `?token=` URL 按密码保管。
- iOS 推送需要 16.4+ 且已「添加到主屏幕」；完全离网的部署发不出推送（push 服务在公网）。
- 移动端样式继续覆盖 DSH 私有 DOM，DSH 改版可能弄坏布局（同 C7）。
- 推送是尽力送达：浏览器厂商服务可能延迟或丢弃，不能当可靠通道用。
- 讨论 #50 有一套社区 fork 实现（团队抽屉、全屏设置页、底部 sheet），方向与本文一致；本文是它的定稿版，实现时在 `dev` 分支上重写，不直接 cherry-pick（它基于 `main` 旧版）。

## 变更

- 2026-10-18：初稿（提案）。
- 2026-10-18：补充远程接入安全设计——插件内嵌 pairing gate（独立端口反代门 + 本地界面显示的 6 位一次性 PIN + HMAC gate cookie + 爆破限流）；push 端点改走已鉴权的 `/api`。
- 2026-10-18：实现定稿。与草案的出入：SW 改挂 `/sw.js`（`/ds-bot/` 下 scope 只有 `/ds-bot/`）；meta 用 `webserver/index-inject` 注入行而非 tapIndex（viewport-fit 仍走 tapIndex）；订阅与 VAPID 存 `push.json` 而非 state.json；gate 端口由 `config.pairPort`/`DS_BOT_PAIR_PORT` 控制；推送开关在「设置 → 本设备」，PIN 同时显示在侧栏横幅。已在 test bench 验证 manifest/icon/SW 路由、meta 注入、PIN 端到端与 push 端点。
- 2026-10-18：gate 代答 dsh token——代理 index 遇 401 时用 `ctx.connection.authenticatedUrl()` 注入 launch token 重试一次，token 不进浏览器；远端登录只剩 PIN 一步。已在真实部署（cloudflared → gate:3080 → dsh:3090 + `--trusted-host`）验证全链路。
- 2026-10-19：gate cookie 从 `SameSite=Strict` 改 `Lax`：Android 上安装的 WebAPK 冷启动是一次 cross-site 顶层导航，Strict cookie 不随该请求发送，每次回到 app 都被打回 PIN 页；Lax 只在顶层 GET 导航放行，跨站子请求/POST 仍然不带。dsh 自己的 Strict cookie 在同一次冷启动里由 gate 的 token 代答静默续上。已配对设备存的旧 Strict cookie 会在随后的已鉴权响应里重写为 Lax。
