# Antigravity 跨版本持久化汉化包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-external-dependency, update-resilient Simplified Chinese localization system for Antigravity Desktop on Windows that deploys outside the install directory, hooks `app.asar` cleanly, translates Electron native UI and the `language_server.exe` web UI at runtime, and automatically re-patches after updates (including "Restart to Update").

**Architecture:** All translation dictionaries, runtime hooks, and recovery scripts live in `%USERPROFILE%\.antigravity-i18n\`. A surgical pure-Node.js ASAR patcher adds a 15-line version-agnostic `dist/zhBootstrap.js` loader into `resources/app.asar` while preserving `app.asar.unpacked` metadata. At runtime, main-process hooks translate Electron menus/tray/dialogs without breaking internal English lookup keys and intercept `autoUpdater` installs to trigger a detached post-update repatcher; renderer injection translates UI chrome in-place without mutating React DOM tree structure or touching `<webview>` browser tabs.

**Tech Stack:** Node.js `v24.19.0` (`node:test`, `node:assert`, `node:fs`, `node:crypto`, `node:path`), Electron runtime APIs, PowerShell 5.1+ (Windows Task Scheduler, Named Mutex, Toast notification).

**Spec:** [2026-11-13-antigravity-i18n-design.md](file:///C:/Users/27200/.gemini/antigravity/scratch/antigravity-zh-cn/docs/superpowers/specs/2026-11-13-antigravity-i18n-design.md)

## Global Constraints

- Zero third-party npm dependencies for runtime, patcher, and tests (`node:test` only).
- `Antigravity.exe` fuse state: `EnableEmbeddedAsarIntegrityValidation = 0`, `OnlyLoadAppFromAsar = 0`; preserve all `unpacked: true` entries (e.g. `chrome-devtools-mcp`) verbatim in `app.asar`.
- Never modify `resources/bin/language_server.exe`.
- Never break Electron's internal `'File'`, `'View'`, `'Help'` menu lookups or `updateActions[menuItem.label]` routing.
- Never inject into `<webview>` (`contents.getType() === 'webview'`) or translate code blocks, editors, inputs, terminal, file paths, or chat prose.
- Never force-kill a running `Antigravity.exe`; if `app.asar` is locked by an unpatched running instance, notify via Windows Toast and wait silently until exit (Named Mutex `Local\AntigravityI18nHeal`).
- Keep original `app.asar.bak.<version>` backup before first patch and provide clean restore via `uninstall.ps1`.

## Review Focus

- **ASAR 4-byte Pickle & alignment corruption:** Writing an ASAR header whose pickle length or file `offset` values are unaligned or miscalculated breaks Electron startup; every patch test must verify both synthetic ASARs and a copied real `app.asar` parse cleanly and retain exact byte hashes for untouched/unpacked entries.
- **Menu lookup & updater action breakage:** Translating `File`/`View`/`Help` or `Check for Updates` / `Restart to Update` labels naively breaks `menu.js` (`addItemToSubmenu`, `configureViewZoomMenu`) and `updater.js` (`updateActions[menuItem.label]`); tests must prove clicking translated update items and looking up menus still invokes the original handlers.
- **React Fiber / MutationObserver infinite loop or text corruption:** Mutating `textNode.nodeValue` repeatedly or translating content inside `<code>` / `.monaco-editor` / `<webview>` breaks React reconciliation or corrupts code; tests must verify idempotence (`raw -> zh -> unchanged`), re-translation on React text updates, and zero mutation inside ignored containers.
- **Concurrent self-heal / update race condition:** Multiple Task Scheduler triggers (`AtLogOn`, `SessionUnlock`, 30m periodic) or `repatch-after-update.ps1` running simultaneously must synchronize via Named Mutex `Local\AntigravityI18nHeal` and skip/wait cleanly when `Antigravity.exe` holds an exclusive lock on `app.asar`.
- **Broken or missing `%USERPROFILE%\.antigravity-i18n\` files:** If the external directory is deleted or corrupted while `app.asar` still holds `zhBootstrap.js`, Antigravity must still boot normally in English without throwing an uncaught exception.

---

### Task 1: Surgical ASAR Patcher (`patcher/asar-patch.mjs`)

**Files:**
- Create: `patcher/asar-patch.mjs`
- Test: `tests/asar-patch.test.mjs`

**Interfaces:**
- Produces:
  - `readAsar(asarPath: string) -> { header: object, dataOffset: number, rawBuffer: Buffer }`
  - `writeAsar(asarPath: string, header: object, fileBuffers: Map<string, Buffer>) -> void`
  - `isAsarPatched(asarPath: string) -> boolean`
  - `patchAsar(asarPath: string, options?: { bootstrapCode?: string, backupPath?: string }) -> { status: 'patched' | 'already-patched', backupCreated: boolean }`
  - `unpatchAsar(asarPath: string) -> { status: 'unpatched' | 'not-patched' }`
  - CLI mode: `node asar-patch.mjs <patch|unpatch|status> <asarPath> [--backup <backupPath>]`

- [ ] **Step 1: Write the failing tests for ASAR round-trip, unpacked preservation, patch/unpatch idempotency, and CLI status**

Write `tests/asar-patch.test.mjs` using `node:test` and `node:assert/strict`:
- `test_roundtrip_preserves_files_and_unpacked_entries`: builds a synthetic ASAR containing `package.json`, `dist/main.js`, and a simulated `unpacked: true` entry under `node_modules/pkg/bin.node` (no `offset` property, only `size` and `unpacked: true`), runs `readAsar` + `writeAsar`, asserts all bytes match and `unpacked: true` metadata is untouched.
- `test_patchAsar_injects_bootstrap_and_is_idempotent`: patches synthetic ASAR, verifies `isAsarPatched === true`, verifies `dist/zhBootstrap.js` exists in header, `dist/main.js` begins with `/* @antigravity-i18n-bootstrap */`, backup file is created once, and calling `patchAsar` a second time returns `status: 'already-patched'` without overwriting backup.
- `test_unpatchAsar_restores_main_js_and_removes_bootstrap`: calls `unpatchAsar`, verifies `isAsarPatched === false`, `dist/zhBootstrap.js` is removed, and `dist/main.js` matches original bytes exactly.
- `test_patchAsar_on_copied_real_app_asar`: if `%LOCALAPPDATA%\Programs\antigravity\resources\app.asar` exists, copies it to `os.tmpdir()`, patches it, reads back via `readAsar`, asserts every untouched file's SHA256 matches original and `node_modules/chrome-devtools-mcp` unpacked flags remain `true`.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/asar-patch.test.mjs`
Expected: FAIL (`Cannot find module '../patcher/asar-patch.mjs'`)

- [ ] **Step 3: Implement `patcher/asar-patch.mjs`**

Implement Chromium Pickle 16-byte header encoding/decoding (`uint32le(4)`, `uint32le(headerSize + 8)`, `uint32le(headerSize + 4)`, `uint32le(jsonByteLength)` + UTF-8 JSON padded with `\0` to 4-byte boundary), recursive tree walker that skips `unpacked: true` / `link` entries when packing file buffers, atomic write (`<path>.tmp` -> verify `readAsar` -> `renameSync`), `BOOTSTRAP_MARKER = '/* @antigravity-i18n-bootstrap */'`, and safe `zhBootstrap.js` payload that wraps `require(path.join(os.homedir(), '.antigravity-i18n', 'runtime', 'loader.js'))` inside `try/catch`.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/asar-patch.test.mjs`
Expected: PASS (4/4 passing)

- [ ] **Step 5: Commit**

```bash
git add patcher/asar-patch.mjs tests/asar-patch.test.mjs
git commit -m "feat: add zero-dependency surgical ASAR patcher"
```

---

### Task 2: Dictionary & Pattern Translation Engine (`runtime/translator.js`)

**Files:**
- Create: `runtime/translator.js`
- Test: `tests/translator.test.mjs`

**Interfaces:**
- Consumes: `dict/zh-CN.json` (`Record<string, string>`), `dict/patterns.json` (`Array<{ pattern: string, flags?: string, replace: string }>`)
- Produces:
  - `createTranslator(options: { exactMap: Record<string, string>, patterns: Array<{ pattern: string, flags?: string, replace: string }>, onMissing?: (text: string) => void })`
  - Returns `{ translate(text: string): string, hasExact(text: string): boolean, stats(): { hits: number, misses: number } }`
  - `loadTranslatorFromDir(baseDir: string) -> Translator` (falls back to empty safe no-op translator if files are missing/corrupt)

- [ ] **Step 1: Write the failing tests**

Write `tests/translator.test.mjs`:
- `test_exact_match_preserves_surrounding_whitespace`: `'  Settings \n'` with `{ "Settings": "设置" }` returns `'  设置 \n'`.
- `test_pattern_match_with_capture_groups`: `'3 files changed'` with `{ pattern: '^(\\d+) files? changed$', replace: '$1 个文件已更改' }` returns `'3 个文件已更改'`; `'No agents running'` -> `'无代理正在运行'`.
- `test_unknown_text_returns_unchanged_and_triggers_onMissing_once`: unknown `'Brand New Feature'` returns `'Brand New Feature'`, calls `onMissing` once even if translated twice.
- `test_non_english_or_code_like_strings_skip_onMissing`: `'12345'`, `'C:\\foo\\bar'`, `'https://example.com'`, `'中文'` return unchanged without triggering `onMissing`.
- `test_loadTranslatorFromDir_missing_dir_returns_noop`: calling `loadTranslatorFromDir` on nonexistent path does not throw and returns identity translator.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/translator.test.mjs`
Expected: FAIL (`Cannot find module '../runtime/translator.js'`)

- [ ] **Step 3: Implement `runtime/translator.js`**

CommonJS module (`module.exports`) so Electron main process can `require()` it directly and renderer injection can serialize/bundle its pure logic cleanly. Compiles regex patterns safely with `try/catch` (ignoring malformed patterns), trims leading/trailing whitespace while preserving padding around translated core text, deduplicates `onMissing` via a `Set`, and guards `shouldSkipString(trimmed)` (empty, pure numbers/punctuation, URLs, file paths, non-ASCII text, strings > 180 chars).

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/translator.test.mjs`
Expected: PASS (5/5 passing)

- [ ] **Step 5: Commit**

```bash
git add runtime/translator.js tests/translator.test.mjs
git commit -m "feat: add dictionary and pattern translation engine"
```

---

### Task 3: Electron Main-Process Hooks (`runtime/menuHook.js`, `runtime/updaterHook.js`, `runtime/loader.js`)

**Files:**
- Create: `runtime/menuHook.js`
- Create: `runtime/updaterHook.js`
- Create: `runtime/loader.js`
- Test: `tests/main-hooks.test.mjs`

**Interfaces:**
- Consumes: `runtime/translator.js` (`translate`)
- Produces:
  - `installMenuHooks(electron, translator, logger)`
  - `installUpdaterHooks(electron, options: { baseDir: string, asarPath: string, exePath: string, spawnFn?: Function, logger?: object })`
  - `installLoader(electron, options?)` (default export `module.exports = function init(electron)` called by `zhBootstrap.js`)

- [ ] **Step 1: Write the failing tests for Menu lookup preservation, Tray dynamic count translation, Update action routing, and Updater silent repatch hook**

Write `tests/main-hooks.test.mjs` using lightweight mock `electron` (`Menu`, `MenuItem`, `Tray`, `dialog`, `app`) and mock `BaseUpdater`:
- `test_menu_lookup_by_original_english_label_survives_translation`: builds menu with `'File'`, `'View'`, `'Help'`, runs `installMenuHooks` + `Menu.setApplicationMenu(menu)`, asserts displayed `label` is Chinese (`'文件'`, `'视图'`, `'帮助'`) while `menu.items.find(i => i.label === 'File')` or helper wrapper / deferred translation still allows `addItemToSubmenu(menu, 'File', ...)` style code to succeed.
  - Design decision: to guarantee `item.label === 'File'` works inside `menu.js` AND Electron displays `'文件'`: hook `Menu.setApplicationMenu(menu)` and `Menu.buildFromTemplate(template)` cleanly:
    1. Keep `item.__agyRawLabel` on every `MenuItem` and wrap `Menu.buildFromTemplate` to translate template labels/tooltips *except* top-level `'File'`/`'Edit'`/`'View'`/`'Window'`/`'Help'` if `setApplicationMenu` hasn't run yet—even cleaner: on `MenuItem` instances created by `Menu.buildFromTemplate`, intercept `Menu.setApplicationMenu(menu)` using `queueMicrotask` / post-setup hook? Wait: `menu.js` mutates `menu` synchronously (`addItemToSubmenu` + `configureViewZoomMenu`) and THEN calls `electron.Menu.setApplicationMenu(menu)`! AND `addWslConnectMenu` mutates asynchronously and calls `electron.Menu.setApplicationMenu(menu)` again! Wait: the second time `setupApplicationMenu` runs or `addWslConnectMenu` runs, `menu.items.find(item => item.label === 'File')` checks `item.label`! So if `setApplicationMenu` translated `item.label` from `'File'` to `'文件'` on the first call, `addWslConnectMenu`'s `addItemToSubmenu(menu, 'File', 1, ...)` would fail to find `'File'`!
    - **Exact solution:** Do NOT mutate `item.label` in-place to Chinese until building a cloned display menu OR intercept `Menu.setApplicationMenu(menu)` by building a translated clone `cloneTranslatedMenu(menu)` (preserving `click` closures bound to original `menuItem`!), OR monkey-patch `Array.prototype`? Never patch `Array.prototype`! Cloning a `Menu` for `Menu.setApplicationMenu`? Wait: `updateMenuState` in `updater.js` calls `Menu.getApplicationMenu().getMenuItemById('check-for-updates')` and sets `item.label = step` (`'Restart to Update'`), and `click` does `updateActions[menuItem.label]`!
    - Look how clean this is if `Menu.setApplicationMenu(menu)` translates `item.label` in-place AND ALSO patches `menu.items.find` (on that `menu` instance!) + `updateActions` (or intercepts `click` on `check-for-updates` / wraps `Menu.prototype.getMenuItemById` / `item.label` property):
      - Patch `menu.items.find` on the `menu` instance (or `Menu.items` wrapper): if predicate returns falsy, temporarily evaluate with `item.__rawLabel`? Even simpler and zero-hack: keep `Object.defineProperty`? No, if `item.label` returns `'文件'` for native Electron C++ `setApplicationMenu`, `menu.items.find(i => i.label === 'File')` sees `'文件'`. So patching `menu.items.find` (on that `items` array instance, NOT `Array.prototype`!) so when `addItemToSubmenu` searches `menu.items.find(...)`, if native `.find` returns `undefined`, it checks items with a proxy `{ ...item, label: item.__rawLabel }` — wait: `addItemToSubmenu` accesses `submenuItem.submenu.insert(...)` on the returned item! So if predicate matches `{ label: item.__rawLabel }`, return the real `item`!
      - AND for `check-for-updates` (`updater.js`): wrap `item.click` (or `MenuItem` property setter when `id === 'check-for-updates'`) so when `item.label` is set to `'Restart to Update'`, `__rawLabel` updates to `'Restart to Update'`, display `label` becomes `'重启以更新'`, and `click(menuItem, ...)` passes a proxy or restores `rawLabel` before calling original `click`!
- `test_update_menu_item_click_routes_correctly_when_translated`: sets `id: 'check-for-updates'`, updates `item.label = 'Restart to Update'`, verifies displayed `item.label === '重启以更新'`, invokes `item.click(item)`, and asserts `updateActions['Restart to Update']` was triggered!
- `test_tray_setContextMenu_translates_dynamic_agent_count`: calls `tray.setContextMenu(menu)` with `'2 agents running'`, verifies translated `'2 个代理正在运行'`.
- `test_updater_hook_forces_silent_no_force_run_and_spawns_repatcher`: mocks `BaseUpdater` (`install(isSilent, isForceRunAfter)`), triggers `install(false, true)`, verifies underlying `install` is called with `(true, false)` and detached PowerShell `repatch-after-update.ps1` is spawned with `-Relaunch 1` and current PID + `app.asar` path.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/main-hooks.test.mjs`
Expected: FAIL (`Cannot find module '../runtime/menuHook.js'`)

- [ ] **Step 3: Implement `runtime/menuHook.js`, `runtime/updaterHook.js`, and `runtime/loader.js`**

- `menuHook.js`: wraps `Menu.buildFromTemplate`, `Menu.setApplicationMenu`, `Tray.prototype.setContextMenu`, `dialog.showMessageBox` / `showMessageBoxSync`; tracks `__rawLabel` on `MenuItem`s, installs per-array instance `.find` fallback on `menu.items` so `addItemToSubmenu`/`configureViewZoomMenu` always find `'File'`/`'View'`/`'Help'`, and wraps `click` on items so `updateActions[menuItem.label]` receives raw English `label`.
- `updaterHook.js`: resolves `electron-updater` via `require.cache` or `require(path.join(appPath, 'node_modules/electron-updater'))` (safe fallback if module path differs), wraps `BaseUpdater.prototype.install` (and `quitAndInstall` if called directly) to compute current `app.asar` SHA256, spawn `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <repatch-after-update.ps1> ...` detached (`unref()`), and force `(true, false)` when installing via NSIS so NSIS exits cleanly without racing `Antigravity.exe` relaunch.
- `loader.js`: initializes `translator`, `menuHook`, `updaterHook`, and attaches `app.on('web-contents-created', ...)` (skipping `contents.getType() === 'webview'`, allowing `https://127.0.0.1:` and `data:`/`file:` internal pages, injecting `domTranslator.js` + serialized dictionary on `dom-ready` & `did-finish-load`). Also flushes collected `missing-strings.json` periodically/on quit if `collectMissing: true`.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/main-hooks.test.mjs`
Expected: PASS (4/4 passing)

- [ ] **Step 5: Commit**

```bash
git add runtime/menuHook.js runtime/updaterHook.js runtime/loader.js tests/main-hooks.test.mjs
git commit -m "feat: add Electron main-process menu, tray, and updater hooks"
```

---

### Task 4: Renderer DOM & Attribute Dynamic Translator (`runtime/domTranslator.js`)

**Files:**
- Create: `runtime/domTranslator.js`
- Test: `tests/dom-translator.test.mjs`

**Interfaces:**
- Consumes: serialized dictionary `{ exactMap, patterns }` and config `{ collectMissing }`
- Produces:
  - `buildInjectionScript(payload: { exactMap: Record<string, string>, patterns: Array<object>, collectMissing?: boolean }) -> string`
  - `createDomTranslator(doc, windowObj, translator, options?) -> { scan(root), observe(), disconnect() }` (testable standalone factory used inside `buildInjectionScript`)

- [ ] **Step 1: Write the failing tests**

Write `tests/dom-translator.test.mjs` with a lightweight fake DOM tree (`TextNode`, `Element` with `attributes`, `closest()`, `childNodes`, `nodeType`, `MutationObserver` stub):
- `test_translates_ui_text_nodes_in_place_without_changing_dom_structure`: verifies `Text` node identity (`===`) is preserved while `.nodeValue` updates from `'Settings'` to `'设置'`, and re-scanning does not double-translate or modify `.nodeValue`.
- `test_react_text_update_retranslates_correctly`: changes `textNode.nodeValue` from `'设置'` to `'New Conversation'` (simulating React re-render) and notifies observer, asserts `.nodeValue` becomes `'新建对话'`.
- `test_skips_code_editor_input_terminal_and_prose_containers`: places `'Settings'` inside `<code>`, `<pre>`, `.monaco-editor`, `.xterm`, `<textarea>`, `[contenteditable="true"]`, and `[data-testid="message-content"]` / `.prose`; asserts `.nodeValue` stays `'Settings'`.
- `test_translates_allowed_ui_attributes`: translates `placeholder="Search projects..."`, `title="New Conversation"`, `aria-label="Close"`, and `<input type="button" value="Cancel">` while leaving `<input type="text" value="Settings">` untouched.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/dom-translator.test.mjs`
Expected: FAIL (`Cannot find module '../runtime/domTranslator.js'`)

- [ ] **Step 3: Implement `runtime/domTranslator.js`**

Implements `createDomTranslator` with `WeakMap` tracking `{ raw, zh }` per `Text` node and attribute key, `IGNORED_SELECTOR = 'pre, code, kbd, samp, script, style, noscript, svg, textarea, [contenteditable="true"], .monaco-editor, .cm-editor, .xterm, .prose, [data-message-author-role]'`, batch scheduling via `requestAnimationFrame` / `setTimeout(fn, 16)`, and `buildInjectionScript` wrapping the self-contained IIFE guarded by `window.__AGY_I18N_INSTALLED__`. Reports missing short UI strings (only inside UI controls like `button`, `label`, `h1-h6`, `[role=menuitem]`, `[role=tab]`, `[role=dialog]`, `nav`, `aside`, `header`) via `console.debug('__AGY_I18N_MISSING__:' + JSON.stringify(list))` or `ipc` if `collectMissing` is enabled so `loader.js` can listen on `console-message` without exposing new `contextBridge` APIs.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/dom-translator.test.mjs`
Expected: PASS (4/4 passing)

- [ ] **Step 5: Commit**

```bash
git add runtime/domTranslator.js tests/dom-translator.test.mjs
git commit -m "feat: add renderer DOM and attribute translator"
```

---

### Task 5: Real UI String Extraction & Curated Chinese Dictionary (`scripts/extract-ui-strings.mjs`, `scripts/scan-new-strings.mjs`, `dict/zh-CN.json`, `dict/patterns.json`)

**Files:**
- Create: `scripts/extract-ui-strings.mjs`
- Create: `scripts/scan-new-strings.mjs`
- Create: `dict/zh-CN.json`
- Create: `dict/patterns.json`
- Test: `tests/dictionary.test.mjs`

**Interfaces:**
- Produces:
  - `scripts/extract-ui-strings.mjs`: reads `app.asar` (`dist/*.js`) and `language_server.exe` embedded frontend strings to output candidate UI strings JSON for authoring/verification.
  - `scripts/scan-new-strings.mjs`: compares `app.asar` + `language_server.exe` UI strings against `dict/zh-CN.json` and `dict/patterns.json`, writes unseen UI candidates to `logs/new-strings-pending.json`.
  - `dict/zh-CN.json` & `dict/patterns.json`: curated Simplified Chinese dictionary covering Electron menus/tray/dialogs/updater/WSL/wizard AND Antigravity 2.0 sidebar, chat canvas, settings, permissions, sandbox, scheduled tasks, skills/plugins/MCP, and common UI controls.

- [ ] **Step 1: Write `scripts/extract-ui-strings.mjs` and run read-only extraction on local Antigravity install**

Extract string literals from `app.asar` (`dist/menu.js`, `dist/tray.js`, `dist/updater.js`, `dist/ideInstall/wizardHtml.js`, `dist/loadingOverlay.js`, `dist/provisionSplash.js`, `dist/deviceChooser.js`, `dist/ipcHandlers.js`, `dist/webviewBrowser.js`) and readable UI labels from `language_server.exe` to inspect actual strings used by v44.9.1.

- [ ] **Step 2: Author `dict/zh-CN.json` and `dict/patterns.json` from extracted real strings + `antigravity_guide` UI terms**

Curate clean, natural Simplified Chinese translations (preserving technical terms like `MCP`, `WSL`, `Agent`, `Skill`, `Subagent` appropriately where idiomatic, e.g., `Agent Settings` -> `Agent 设置` or `代理设置`, consistent across the whole app).

- [ ] **Step 3: Write `scripts/scan-new-strings.mjs` and `tests/dictionary.test.mjs`**

`tests/dictionary.test.mjs` verifies:
- `dict/zh-CN.json` and `dict/patterns.json` are valid JSON, all regex patterns compile cleanly without throwing, no empty translation values exist, and critical known menu/tray/settings strings (`File`, `View`, `Help`, `Check for Updates`, `Restart to Update`, `New Conversation`, `Scheduled Tasks`, `Settings`, `Terminal Sandbox`, `2 agents running`) all translate to non-empty Chinese strings.
- `scan-new-strings.mjs` outputs valid JSON array when run against a mock/real ASAR.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/dictionary.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-ui-strings.mjs scripts/scan-new-strings.mjs dict/zh-CN.json dict/patterns.json tests/dictionary.test.mjs
git commit -m "feat: add real UI string extractor and curated zh-CN dictionary"
```

---

### Task 6: Windows Installer, Post-Update Bridge, Self-Heal & Uninstaller (`scripts/*.ps1`)

**Files:**
- Create: `config.default.json`
- Create: `scripts/install.ps1`
- Create: `scripts/repatch-after-update.ps1`
- Create: `scripts/self-heal.ps1`
- Create: `scripts/uninstall.ps1`
- Test: `tests/scripts-e2e.test.mjs`

**Interfaces:**
- Deployed target: `%USERPROFILE%\.antigravity-i18n\`
- Scheduled Task name: `AntigravityI18nSelfHeal` (current user, triggers: `AtLogOn`, `SessionUnlock` via Task XML/CIM, and 30-minute repetition)
- Named Mutex: `Local\AntigravityI18nHeal`

- [ ] **Step 1: Write `tests/scripts-e2e.test.mjs` covering simulated update + locked-file waiting + self-heal + uninstall**

Tests (operating strictly against a temp sandbox directory simulating `%USERPROFILE%\.antigravity-i18n` and `%LOCALAPPDATA%\Programs\antigravity` — never touching real files during unit test):
- `test_install_and_uninstall_on_temp_asar`: deploys files to temp home, patches temp `app.asar`, verifies `status === 'patched'` and backup exists, runs uninstall logic, verifies original `app.asar` restored.
- `test_repatch_after_update_detects_changed_asar_and_repatches`: replaces temp `app.asar` with an unpatched copy (simulating NSIS update), runs `repatch-after-update.ps1 -AsarPath ... -SkipRelaunch`, verifies new `app.asar` is patched and `new-strings-pending.json` is generated.
- `test_self_heal_exits_fast_when_already_patched`: runs `self-heal.ps1 -AsarPath ...` on already-patched temp `app.asar`, verifies exit code 0 in fast path.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/scripts-e2e.test.mjs`
Expected: FAIL (`scripts/self-heal.ps1` / `scripts/repatch-after-update.ps1` not found)

- [ ] **Step 3: Implement `config.default.json` and `scripts/install.ps1`, `repatch-after-update.ps1`, `self-heal.ps1`, `uninstall.ps1`**

Key behaviors:
- `self-heal.ps1` & `repatch-after-update.ps1`: acquire `Local\AntigravityI18nHeal` mutex; check `node asar-patch.mjs status`; if unpatched and `Antigravity.exe` is running & locking `app.asar`, emit quiet Windows Toast (`Windows.UI.Notifications.ToastNotificationManager` via PowerShell, falling back to log if unavailable) `"Antigravity 已更新，关闭并重新打开后将自动恢复中文界面"`, wait cleanly for `Antigravity` processes to exit (polling every 2s), then run `node asar-patch.mjs patch` + non-blocking `scan-new-strings.mjs`.
- `repatch-after-update.ps1`: waits up to 90s for old PID + NSIS installer (`Antigravity Setup` / temp updater) to exit and `app.asar` SHA256 to differ from `-OldHash` (or unlock), runs `asar-patch.mjs patch` + `scan-new-strings.mjs`, and if `-Relaunch 1` and `Antigravity.exe` is not running, launches `Antigravity.exe`.
- `install.ps1`: copies `runtime/`, `dict/`, `patcher/`, `scripts/`, `config.json` (preserving user edits if `config.json` already exists!) to `%USERPROFILE%\.antigravity-i18n\`; registers `AntigravityI18nSelfHeal` Scheduled Task (`AtLogOn` + `SessionUnlock` + `PT30M` interval, hidden window); runs `self-heal.ps1` immediately (if `Antigravity.exe` is currently open, notifies & waits or tells user to close/reopen once to activate!).
- `uninstall.ps1`: unregisters `AntigravityI18nSelfHeal`, restores `app.asar` from backup or runs `asar-patch.mjs unpatch`, optionally removes `%USERPROFILE%\.antigravity-i18n\`.

- [ ] **Step 4: Run full test suite to verify pass**

Run: `node --test tests/*.test.mjs`
Expected: PASS (all tests passing)

- [ ] **Step 5: Commit**

```bash
git add config.default.json scripts/*.ps1 tests/scripts-e2e.test.mjs
git commit -m "feat: add Windows installer, update bridge, self-heal, and uninstaller"
```

---

### Task 7: Verification & Live Deployment Readiness

- [ ] **Step 1: Run complete automated test suite**

Run: `node --test tests/*.test.mjs`
Expected: All test files pass with 0 failures and 0 skipped tests.

- [ ] **Step 2: Smoke-test `install.ps1` deployment into `%USERPROFILE%\.antigravity-i18n\` and verify `Antigravity.exe` readiness**

Note: Because `Antigravity.exe` is currently running this very session (holding a file lock on `resources/app.asar`), `install.ps1` will deploy `%USERPROFILE%\.antigravity-i18n\`, register `AntigravityI18nSelfHeal`, and either stage the silent wait-until-exit patcher or instruct the user to close and reopen Antigravity once via the normal icon so the patch applies cleanly without interrupting the active session!
