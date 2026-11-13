import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTranslator } = require('../runtime/translator.js');
const { installMenuHooks } = require('../runtime/menuHook.js');
const { installUpdaterHooks } = require('../runtime/updaterHook.js');
const { createMainLoader } = require('../runtime/loader.js');

function createMockElectron() {
  class MockMenuItem {
    constructor(opts = {}) {
      this._label = opts.label || '';
      this.id = opts.id;
      this.role = opts.role;
      this.click = opts.click;
      this.submenu = opts.submenu;
      this.enabled = opts.enabled;
      this.visible = opts.visible;
    }
    get label() {
      return this._label;
    }
    set label(v) {
      this._label = v;
    }
  }

  class MockMenu {
    constructor() {
      this.items = [];
    }
    insert(pos, item) {
      this.items.splice(pos, 0, item);
    }
    getMenuItemById(id) {
      for (const item of this.items) {
        if (item.id === id) return item;
        if (item.submenu) {
          const found = item.submenu.getMenuItemById(id);
          if (found) return found;
        }
      }
      return null;
    }
    static buildFromTemplate(template) {
      const m = new MockMenu();
      for (const entry of template) {
        const cloned = { ...entry };
        if (Array.isArray(entry.submenu)) {
          cloned.submenu = MockMenu.buildFromTemplate(entry.submenu);
        }
        m.items.push(new MockMenuItem(cloned));
      }
      return m;
    }
    static setApplicationMenu(menu) {
      MockMenu._appMenu = menu;
    }
    static getApplicationMenu() {
      return MockMenu._appMenu || null;
    }
  }

  class MockTray {
    setContextMenu(menu) {
      this._menu = menu;
    }
    setToolTip(tip) {
      this._tip = tip;
    }
  }

  const dialogCalls = [];
  const dialog = {
    showMessageBox(winOrOpts, maybeOpts) {
      const opts = maybeOpts || winOrOpts;
      dialogCalls.push(opts);
      return Promise.resolve({ response: 0 });
    },
    showMessageBoxSync(winOrOpts, maybeOpts) {
      const opts = maybeOpts || winOrOpts;
      dialogCalls.push(opts);
      return 0;
    },
  };

  const webContentsCreatedHandlers = [];
  const app = {
    on(evt, fn) {
      if (evt === 'web-contents-created') webContentsCreatedHandlers.push(fn);
    },
    getVersion() {
      return '44.9.1';
    },
  };

  return {
    Menu: MockMenu,
    MenuItem: MockMenuItem,
    Tray: MockTray,
    dialog,
    app,
    _dialogCalls: dialogCalls,
    _emitWebContentsCreated(contents) {
      for (const fn of webContentsCreatedHandlers) fn({}, contents);
    },
  };
}

test('menuHook translates menus while preserving File/View/Help lookups and updateActions routing', () => {
  const electron = createMockElectron();
  const translator = createTranslator({
    exactMap: {
      File: '文件',
      'New Window': '新建窗口',
      View: '视图',
      Help: '帮助',
      Docs: '文档',
      'Check for Updates': '检查更新',
      'Restart to Update': '重启以更新',
      'No updates available': '暂无可用更新',
      OK: '确定',
    },
    patterns: [],
  });

  installMenuHooks(electron, translator);

  let triggeredAction = null;
  const updateActions = {
    'Check for Updates': () => { triggeredAction = 'check'; },
    'Restart to Update': () => { triggeredAction = 'restart'; },
  };

  const appMenu = electron.Menu.buildFromTemplate([
    { label: 'File', submenu: [] },
    { label: 'View', submenu: [{ label: 'Zoom In' }] },
    {
      label: 'Help',
      submenu: [
        {
          id: 'check-for-updates',
          label: 'Check for Updates',
          click: (menuItem) => {
            updateActions[menuItem.label]?.();
          },
        },
      ],
    },
  ]);

  electron.Menu.setApplicationMenu(appMenu);

  // Top-level labels are translated for display
  assert.equal(appMenu.items[0].label, '文件');
  assert.equal(appMenu.items[1].label, '视图');
  assert.equal(appMenu.items[2].label, '帮助');

  // Subsequent internal lookup by English label still succeeds (like addWslConnectMenu)
  const fileMenu = appMenu.items.find((i) => i.label === 'File');
  assert.ok(fileMenu);
  fileMenu.submenu.insert(0, new electron.MenuItem({ label: 'New Window' }));
  electron.Menu.setApplicationMenu(appMenu);
  assert.equal(fileMenu.submenu.items[0].label, '新建窗口');

  // Dynamic update state label setter translates display while preserving click routing
  const updateItem = appMenu.getMenuItemById('check-for-updates');
  updateItem.label = 'Restart to Update';
  assert.equal(updateItem.label, '重启以更新');
  updateItem.click(updateItem);
  assert.equal(triggeredAction, 'restart');

  // Dialog options are translated
  electron.dialog.showMessageBox({
    title: 'Check for Updates',
    message: 'No updates available',
    buttons: ['OK'],
  });
  assert.equal(electron._dialogCalls[0].title, '检查更新');
  assert.equal(electron._dialogCalls[0].message, '暂无可用更新');
  assert.deepEqual(electron._dialogCalls[0].buttons, ['确定']);
});

test('menuHook translates dynamic Tray context menu labels', () => {
  const electron = createMockElectron();
  const translator = createTranslator({
    exactMap: { Quit: '退出' },
    patterns: [
      { pattern: '^(\\d+) agents? running$', replace: '$1 个代理正在运行' },
    ],
  });
  installMenuHooks(electron, translator);

  const tray = new electron.Tray();
  const trayMenu = electron.Menu.buildFromTemplate([
    { id: 'running-agents', label: '2 agents running' },
    { label: 'Quit' },
  ]);
  tray.setContextMenu(trayMenu);

  assert.equal(trayMenu.items[0].label, '2 个代理正在运行');
  assert.equal(trayMenu.items[1].label, '退出');
});

test('updaterHook intercepts install, forces silent non-force-run, and spawns repatch bridge', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-hook-'));
  const fakeAsar = path.join(tmpDir, 'app.asar');
  fs.writeFileSync(fakeAsar, 'dummy-asar-bytes');

  const installCalls = [];
  class MockBaseUpdater {
    install(isSilent, isForceRunAfter) {
      installCalls.push({ isSilent, isForceRunAfter });
      return true;
    }
    quitAndInstall(isSilent = false, isForceRunAfter = false) {
      return this.install(isSilent, isForceRunAfter);
    }
  }

  const spawns = [];
  const mockSpawn = (cmd, args, opts) => {
    spawns.push({ cmd, args, opts });
    return { unref() {} };
  };

  installUpdaterHooks({
    BaseUpdater: MockBaseUpdater,
    baseDir: tmpDir,
    asarPath: fakeAsar,
    exePath: 'C:\\Antigravity\\Antigravity.exe',
    spawnFn: mockSpawn,
  });

  const updater = new MockBaseUpdater();
  const ok = updater.quitAndInstall(false, true);
  assert.equal(ok, true);
  assert.deepEqual(installCalls, [{ isSilent: true, isForceRunAfter: false }]);
  assert.equal(spawns.length, 1);
  assert.match(spawns[0].cmd, /powershell/i);
  assert.ok(spawns[0].args.includes('-Relaunch'));
  assert.ok(spawns[0].args.includes('1'));
  assert.equal(spawns[0].opts.detached, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loader skips webview guest contents and injects only Antigravity UI windows', () => {
  const electron = createMockElectron();
  const translator = createTranslator({ exactMap: { Settings: '设置' }, patterns: [] });
  const executed = [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
  createMainLoader(electron, {
    baseDir: tmpDir,
    translator,
    buildInjectionScript: () => 'window.__INJECTED__ = true;',
  });

  const makeContents = (type, url) => {
    const listeners = {};
    return {
      getType: () => type,
      getURL: () => url,
      isDestroyed: () => false,
      on: (ev, fn) => {
        (listeners[ev] ||= []).push(fn);
      },
      emit: (ev) => {
        for (const fn of listeners[ev] || []) fn();
      },
      executeJavaScript: (code) => {
        executed.push({ type, url, code });
        return Promise.resolve();
      },
    };
  };

  const guest = makeContents('webview', 'https://example.com');
  const hub = makeContents('window', 'https://127.0.0.1:54321/');

  electron._emitWebContentsCreated(guest);
  electron._emitWebContentsCreated(hub);

  guest.emit('dom-ready');
  hub.emit('dom-ready');

  assert.equal(executed.length, 1);
  assert.equal(executed[0].url, 'https://127.0.0.1:54321/');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
