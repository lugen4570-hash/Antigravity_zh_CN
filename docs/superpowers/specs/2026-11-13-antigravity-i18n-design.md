# Antigravity 跨版本持久化中文汉化方案设计

**日期**：2026-11-13  
**目标应用**：Antigravity Desktop（Windows，当前实测版本 `44.9.1` / 内部包版本 `2.31.2`，安装路径 `%LOCALAPPDATA%\Programs\antigravity`）  
**工作区目录**：`C:\Users\27200\.gemini\antigravity\scratch\antigravity-zh-cn`

---

## 1. 需求背景与意图

为本机个人使用的 Antigravity 桌面端提供一套**点原版桌面/任务栏图标即可生效、跨版本通用、自动更新（含点击应用内“更新并重启”按钮）后不失效**的简体中文汉化方案。

### 核心痛点与平台约束（已实测确认）

1. **界面分两层，且无官方外置语言包**：
   - **Electron 原生外壳**（`resources/app.asar`）：负责顶部应用菜单（`dist/menu.js`）、系统托盘（`dist/tray.js`）、自动更新状态（`dist/updater.js`）、安装向导/加载遮罩等原生 UI。
   - **核心 Web 主界面**（`resources/bin/language_server.exe`）：聊天画布、侧边栏、设置页、计划任务、Skill/Plugin 管理等主体界面由 `language_server.exe` 在本地启动 HTTPS 服务（`https://127.0.0.1:<port>/`）渲染。前端资源打包在近 200MB 的二进制内，不同版本构建产物名与压缩代码会变化。
2. **更新覆盖机制**：
   - Antigravity 使用 `electron-updater`（`NsisUpdater`）执行自动更新，每次升级都会整包替换 `app.asar` 与 `language_server.exe`。
3. **Electron Fuse 约束**：
   - 已核查 `Antigravity.exe` 内置 Fuse 标志位：`EnableEmbeddedAsarIntegrityValidation = 0`、`OnlyLoadAppFromAsar = 0`，允许在不破坏可执行文件签名的前提下对 `resources/app.asar` 进行非破坏性引导注入。
4. **Windows 文件锁约束**：
   - 运行中的 `Antigravity.exe` 会占用 `resources/app.asar`，因此重写 `app.asar` 必须在进程退出后执行。

---

## 2. 目标、非目标与反目标

### 目标（Goals）
- **点原图标即生效**：不要求改用专用命令行或额外入口，直接点击原版 Antigravity 图标即进入中文界面。
- **全界面覆盖**：同时汉化 Electron 原生菜单/托盘/原生弹窗与 Web 主界面。
- **跨版本兼容**：翻译逻辑与版本解耦；新版新增或微调的英文文案若未命中词典，自动安全回退为英文显示，绝不白屏或崩溃。
- **更新闭环不失效**：
  - 点击应用内“更新并重启”（`Restart to Update`）或菜单更新项时，由钩子接管衔接流程，新版安装完成后自动重注并拉起中文界面；
  - 退出自动安装更新（`autoInstallOnAppQuit`）或用户手动下载覆盖安装包后，也能通过后台自愈任务自动恢复汉化。
- **安全可逆**：保留原版备份，提供一键卸载/还原脚本，随时恢复纯原版。

### 非目标（Non-Goals）
- 不对 `language_server.exe` 做二进制字节码硬改或解包重编。
- 不做跨平台（macOS/Linux）分发安装包，聚焦本机 Windows 环境。
- 不翻译用户聊天消息正文、AI 回复内容、代码块、文件路径、终端输出及内置 `<webview>` 浏览器打开的外部网页。

### 反目标（Anti-Goals）
- **不可破坏 Electron 内部菜单查找**：`dist/menu.js` 会按 `'File'`、`'View'`、`'Help'` 查找子菜单，`dist/updater.js` 会用 `updateActions[menuItem.label]` 查更新动作；直接提前篡改 `.label` 会导致菜单项丢失或点击无效。
- **不可污染内置浏览器**：必须跳过 `contents.getType() === 'webview'` 的外部页面。
- **不可破坏 React Fiber DOM 结构**：前端翻译只能原地更新 `Text` 节点的 `.nodeValue` 与表单/辅助属性，绝不包裹 `<span>` 或增删节点，避免 React 报错。
- **不可丢失 `app.asar.unpacked` 元数据**：重打包 `app.asar` 时必须完整保留 `chrome-devtools-mcp` 等 `unpacked: true` 条目。

---

## 3. 备选方案对比与选型

| 方案 | 原理简述 | 优点 | 缺点与取舍 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **方案一：外置运行时 + `app.asar` 引导钩子 + 更新/自愈闭环** | 词典和翻译器放在安装目录外；向 `app.asar` 仅写入十几行固定引导；钩住 `autoUpdater` 的“更新并重启”流程并配合轻量 Windows 计划任务兜底 | 点原图标生效；菜单+托盘+Web 全汉化；更新后自动恢复；跨版本不依赖特定 JS hash | 需要极轻量计划任务兜底手动覆盖场景；更新重启过程会经过静默安装衔接 | **采用** |
| **方案二：仅快捷方式透明代理启动器** | 把桌面/开始菜单快捷方式改为启动脚本，每次点击先检查再补丁后启动 | 零后台任务 | 若官方大版本更新覆盖了桌面快捷方式，或从文件关联/“更新并重启”直接拉起时，当次会回到英文 | 放弃（不作为主方案，也不强制修改快捷方式） |
| **方案三：纯 CDP 外挂注入** | 不改 `app.asar`，通过启动参数开调试端口外挂注入 JS | 完全不改安装目录 | 无法汉化原生菜单栏/托盘/弹窗；依赖带参快捷方式；首屏易闪英文 | 放弃 |

---

## 4. 系统架构与核心模块设计

系统分为**“外部持久化目录（`%USERPROFILE%\.antigravity-i18n\`）”**与**“注入 `app.asar` 的极简引导（~15 行）”**两部分，代码与词典完全与 Antigravity 安装目录分离。

```text
C:\Users\<user>\.antigravity-i18n\          (升级永不被删)
├── config.json                             (开关、是否记录未翻译词条等)
├── dict\
│   ├── zh-CN.json                          (精确匹配词典：菜单、设置、UI 标签、按钮)
│   └── patterns.json                       (正则模板规则：动态数字、时间、文件数等)
├── runtime\
│   ├── loader.js                           (主进程总入口：挂载菜单/更新/WebContents 钩子)
│   ├── menuHook.js                         (Electron Menu / Tray / Dialog 汉化与原键映射)
│   ├── updaterHook.js                      (拦截 quitAndInstall / install，触发重注衔接)
│   └── domTranslator.js                    (注入渲染进程的 DOM + 属性动态翻译脚本)
├── patcher\
│   └── asar-patch.mjs                      (零依赖 Node.js 外科手术式 ASAR 补丁器)
├── scripts\
│   ├── repatch-after-update.ps1            (更新后等待解锁 -> 重注 -> 拉起 Antigravity)
│   ├── self-heal.ps1                       (自愈检查脚本，供计划任务/手动调用)
│   ├── install.ps1                         (部署、首次打补丁、注册自愈任务)
│   └── uninstall.ps1                       (卸载自愈任务、还原 app.asar 备份)
└── logs\
    ├── i18n.log                            (引导、更新重注日志)
    └── missing-strings.json                (可选：自动收集新版本未收录的 UI 文案)
```

### 4.1 极简引导层（注入 `resources/app.asar`）
- 在 `app.asar` 中新增 `dist/zhBootstrap.js`（约 15 行通用代码，不依赖任何版本号或内部文件路径），并在 `dist/main.js` 顶部插入一行带标记注释的 `try { require('./zhBootstrap'); } catch (_) {}`。
- `zhBootstrap.js` 解析 `path.join(os.homedir(), '.antigravity-i18n', 'runtime', 'loader.js')`，若存在则执行 `require(loaderPath)(electron)`；若文件缺失或异常则静默跳过，**确保任何情况下都不会阻塞 Antigravity 正常启动**。

### 4.2 零依赖外科手术式 ASAR 补丁器（`patcher/asar-patch.mjs`）
- 使用系统已安装的 Node.js（`v24.19.0`）直接解析与重写 Electron ASAR 二进制格式（Chromium Pickle 头部 + 4 字节对齐 JSON 头 + 文件数据区）：
  - **原地保留**：所有未修改文件、`node_modules` 与 `unpacked: true` 元数据（如 `chrome-devtools-mcp`）逐字节保留，仅替换 `dist/main.js` 与写入 `dist/zhBootstrap.js`，重新计算后续文件的 `offset`。
  - **幂等与备份**：通过标记识别是否已注入；首次注入前保存 `app.asar.bak.<version>` 备份（若文件未注入过）；写入临时文件并回读校验 ASAR 头部解析无误后再原子替换目标 `app.asar`。

### 4.3 原生外壳汉化（`runtime/menuHook.js`）
针对已验证的 `menu.js`、`tray.js`、`updater.js` 源码陷阱做安全兼容：
1. **菜单查找兼容**：
   - 不在 `setupApplicationMenu` 执行前硬改顶级菜单标签；而是通过代理/拦截 `Menu.setApplicationMenu`、`Menu.prototype.insert`、`Menu.buildFromTemplate` 在菜单构建及提交给系统显示时统一翻译 `label` 与 `toolTip`。
   - 保留 `originalLabel` 隐藏属性，或同时拦截 `appMenu.items.find`（或将翻译后置到 `setupApplicationMenu` 与 `addWslConnectMenu` 完成渲染阶段），确保 `File` / `View` / `Help` 的查找永远成功。
2. **更新状态菜单兼容**：
   - `updater.js` 通过 `updater_1.updateActions[menuItem.label]` 触发动作，而 `updateMenuState` 会动态改写 `id === 'check-for-updates'` 的 `item.label`。
   - 处理方式：拦截 `MenuItem` 对 `label` 属性的赋值或 `updateActions` 查表，在显示层展示中文（如 `检查更新` / `正在检查更新...` / `正在下载更新...` / `重启以更新`），同时保证点击回调函数按原始英文键或 `id` 正确路由。
3. **系统托盘动态计数**：
   - `tray.js` 的 `updateTrayAgentCount` 会动态拼接 `No agents running` / `2 agents running` 并直接赋给 `countItem.label` 后调用 `tray.setContextMenu(contextMenu)`。在 `Tray.prototype.setContextMenu` 拦截中对整个 `contextMenu.items` 执行精确+正则模板翻译，即可自动覆盖 WSL 列表、运行中代理计数等所有动态菜单项。
4. **原生弹窗与托盘提示**：
   - 拦截 `dialog.showMessageBox` / `showMessageBoxSync`，翻译 `title`、`message`、`detail`、`buttons`（如 `"No updates available"` -> `"暂无可用更新"`）。

### 4.4 Web 主界面动态汉化引擎（`runtime/domTranslator.js`）
1. **注入时机与窗口过滤**：
   - 在主进程监听 `app.on('web-contents-created', ...)`。
   - **严格过滤**：若 `contents.getType() === 'webview'`（内置浏览器网页）则直接跳过；仅对 `https://127.0.0.1:*`、`data:`（如 `loadingOverlay` / `provisionSplash` / `wizardHtml`）等 Antigravity 自有界面注入。
   - 在 `dom-ready`、`did-finish-load` 与 `did-navigate-in-page` 时幂等执行注入（挂 `window.__AGY_I18N_INSTALLED__` 防重复）。
2. **翻译与 React 兼容性**：
   - 使用 `TreeWalker(NodeFilter.SHOW_TEXT)` + `MutationObserver({ childList: true, subtree: true, characterData: true, attributes: true })`。
   - **原地改值**：仅修改 `textNode.nodeValue` 以及白名单属性（`placeholder`、`title`、`aria-label`、`alt`、`value` of button/submit）。使用 `WeakMap<Text, { raw: string, translated: string }>` 记录状态：若 `nodeValue === translated` 则跳过；若 React 刷新了文本导致 `nodeValue` 变化，重新匹配翻译，避免死循环与 DOM 引用失效。
   - **批处理防抖**：对高频流式输出（AI 打字机输出）使用 `requestAnimationFrame` / 微任务批处理队列，对新插入子树做节流扫描。
3. **严格隔离防误翻规则**：
   以下区域及其后代节点**一律跳过**（不翻译文本节点，仅在明确为 UI 按钮提示时允许属性翻译）：
   - 代码与编辑器：`pre`, `code`, `.monaco-editor`, `.cm-editor`, `.xterm`
   - 用户输入区：`textarea`, `input:not([type="button"]):not([type="submit"])`, `[contenteditable="true"]`
   - 对话正文与用户/文件名数据区域（安装阶段通过检查主界面实际 DOM 类名精确定位消息气泡正文容器、文件路径显示元素、变量名徽章，并在源码中做成可配置选择器黑名单 `IGNORED_SELECTORS`）。
   - 明显不是英文 UI 文案的内容：纯数字、版本号、路径（含 `/` 或 `\`）、URL、长段落（超过阈值如 180 字符且未命中整句词典/模板的段落默认不猜译）。
4. **可维护的缺失词收集器（可选开关）**：
   - 当 `config.json` 中开启 `collectMissing: true` 时，自动记录未被词典命中的短 UI 英文文本（去重，仅收集疑似 UI 控件 `button`, `label`, `h1-h6`, `[role="menuitem"]`, `[role="tab"]`, `placeholder` 等内的短文本）到 `logs/missing-strings.json`，方便版本大更后快速补充词典。

### 4.5 更新链路接管与自愈机制（“更新并重启”核心闭环）

```text
用户点击“更新并重启” (或退出触发 autoInstallOnAppQuit)
        │
        ▼
[updaterHook.js] 拦截 BaseUpdater.prototype.install(isSilent, isForceRunAfter)
        │
        ├─ 1. 记录原 app.asar SHA256 与是否需要重启 (shouldRelaunch = isForceRunAfter || 显式重启)
        ├─ 2. 强制以 (isSilent = true, isForceRunAfter = false) 调用原 install() 启动 NSIS 安装器
        └─ 3. 启动脱离主进程的后台脚本 repatch-after-update.ps1 (隐藏窗口)
                  │
                  ▼
        旧 Antigravity.exe 退出 -> NSIS 静默替换新版 app.asar 与 language_server.exe 并退出
                  │
                  ▼
        [repatch-after-update.ps1] 检测到原进程退出 & app.asar 哈希变化（且文件解锁）
                  │
                  ├─ 调用 asar-patch.mjs 立即向新版 app.asar 注入 zhBootstrap.js
                  ├─ （非阻塞）快速扫描新版 app.asar / 前端区段，把未收录词典的候选新词记入 logs/new-strings-pending.json
                  └─ 若 shouldRelaunch == true -> 拉起新版 Antigravity.exe（打开即中文！）
```

- **极端情况容错与温和自愈策略（已确认采用选项 A）**：
  - 无论是在 `repatch-after-update.ps1` 还是 `self-heal.ps1` 中，如果检测到**未汉化**的 `Antigravity.exe` 正在运行并占用 `app.asar` 文件锁：
    1. **绝不强杀进程**（避免中断用户正在运行的 Agent 任务）；
    2. 通过单实例互斥锁（Named Mutex `Local\AntigravityI18nHeal`）防并发重复提示，发送一条不打扰工作的 Windows 桌面通知（Toast）：`“Antigravity 已更新，关闭并重新打开后将自动恢复中文界面”`；
    3. 当前等待循环（或在 `Antigravity.exe` 进程退出时释放文件锁后）静默驻留等待所有 `Antigravity.exe` 进程退出，锁释放瞬间立即调用 `asar-patch.mjs` 完成补丁并退出。
- **自愈兜底触发机制（`self-heal.ps1` + Windows 计划任务，已定方案）**：
  - 安装时注册当前用户权限（无需管理员提权）的计划任务 `AntigravityI18nSelfHeal`，设置三类轻量触发器以适配“长期休眠不重启”的场景：
    1. **用户登录时（AtLogOn）**
    2. **工作站解锁时（SessionUnlock）**
    3. **每 30 分钟一次极速巡检（Periodic Repetition）**
  - `self-heal.ps1` 每次启动先读取 `app.asar` 头部是否包含汉化引导条目 `dist/zhBootstrap.js`：若已存在则在 ~50ms 内直接退出，平时零常驻进程；若缺失（例如用户手动下载官网安装包覆盖安装）且无进程锁则立即补丁，若正被占用则按上述选项 A 提示并等待进程退出后补回。

---

## 5. 词典初始化策略（由 Builder 执行）

为确保第一版就具备高可用覆盖率而非空架子：
1. 在实现阶段，从当前本机 `app.asar`（`menu.js`、`tray.js`、`updater.js`、`wizardHtml.js`、`loadingOverlay.js`、`provisionSplash.js` 等）提取全部原生英文字符串。
2. 从 `language_server.exe` 中只读提取常见前端 UI 字符串（侧边栏、设置项、模型选择、权限策略、按钮、弹窗、快捷键提示等），整理并人工校验后生成初始 `dict/zh-CN.json` 与 `dict/patterns.json`。

---

## 6. Builder 需在实现时自决的细节

- Antigravity 渲染进程中聊天消息正文、文件树、终端等区域的具体 DOM class/attribute 选择器定位（通过实际启动或读取前端文本特征确定）。
- `asar-patch.mjs` 中 Electron ASAR Pickle 格式的 4 字节对齐与 `app.asar.unpacked` 路径引用测试验证。
- 对完整模块编写自动化测试（ASAR 往返加壳/解包、词典与正则替换、防误翻选择器隔离、菜单与更新器 Hook 行为模拟）。
