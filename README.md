# Antigravity 跨版本持久化汉化包 (`antigravity-zh-cn`)

专为 Windows 版 Antigravity 桌面端设计的跨版本中文汉化方案：点原版图标即可生效，更新不失效，不破坏原安装安全与正文内容。

## 安装与激活

克隆仓库后在项目根目录的 PowerShell 中执行：

```powershell
git clone https://github.com/JUN-Genyan/Antigravity_zh_CN.git
cd Antigravity_zh_CN
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install.ps1"
```

- 脚本会将运行时与词典部署到 `%USERPROFILE%\.antigravity-i18n\`（脱离 Antigravity 安装目录，更新不会被删），并注册当前用户权限的自愈计划任务 `AntigravityI18nSelfHeal`（登录时 + 解锁屏幕时 + 每 30 分钟极速巡检）。
- 如果执行安装时 Antigravity 正在运行，会在后台静默等待本次关闭后自动完成补丁写入，下次点击原版图标打开即为中文界面。

## 更新不失效机制

1. 点击应用内**“更新并重启”**（或菜单检查更新安装、退出自动安装）时，注入主进程的 `updaterHook.js` 会触发独立衔接脚本 `repatch-after-update.ps1`，等官方安装器替换完新版文件后自动重注引导钩子并重新启动，打开直接为中文。
2. `repatch-after-update.ps1` 还会自动扫描新版提取出的未收录 UI 词条，输出到 `%USERPROFILE%\.antigravity-i18n\logs\new-strings-pending.json`。
3. 如遇手动下载官方安装包覆盖更新，计划任务会在解锁/巡检时温和自愈（若正在运行则弹通知并在关闭后自动补回，绝不强杀进程）。

## 补充词典

- 精确词典：`%USERPROFILE%\.antigravity-i18n\dict\zh-CN.json`
- 动态模板：`%USERPROFILE%\.antigravity-i18n\dict\patterns.json`
- 运行时收集到的未翻译 UI 短词：`%USERPROFILE%\.antigravity-i18n\logs\missing-strings.json`

## 一键卸载与还原

先关闭 Antigravity，然后执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.antigravity-i18n\scripts\uninstall.ps1" -RemoveData
```

## 运行测试

```powershell
node --test tests/*.test.mjs
```
