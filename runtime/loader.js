'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTranslatorFromDir } = require('./translator');
const { installMenuHooks } = require('./menuHook');
const { installUpdaterHooks } = require('./updaterHook');

function loadConfig(baseDir) {
  try {
    const cfgPath = path.join(baseDir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch {
    // Fallback to defaults
  }
  return { enabled: true, collectMissing: true };
}

function readDictPayload(baseDir) {
  const readJson = (rel, fallback) => {
    try {
      const full = path.join(baseDir, rel);
      if (fs.existsSync(full)) return JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      // Ignore malformed file
    }
    return fallback;
  };
  return {
    exactMap: readJson(path.join('dict', 'zh-CN.json'), {}),
    patterns: readJson(path.join('dict', 'patterns.json'), []),
  };
}

function isTargetAppUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return (
    url.startsWith('https://127.0.0.1:') ||
    url.startsWith('http://127.0.0.1:') ||
    url.startsWith('https://localhost:') ||
    url.startsWith('http://localhost:') ||
    url.startsWith('data:text/html') ||
    url.startsWith('file://')
  );
}

function appendMissingStrings(baseDir, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  try {
    const logsDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, 'missing-strings.json');
    let existing = [];
    if (fs.existsSync(file)) {
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];
      }
    }
    const merged = new Set(existing);
    let changed = false;
    for (const s of items) {
      if (typeof s === 'string' && s && !merged.has(s)) {
        merged.add(s);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(file, JSON.stringify([...merged], null, 2), 'utf8');
    }
  } catch {
    // Ignore logging failures
  }
}

function getBuildInjectionScript(customBuilder) {
  if (typeof customBuilder === 'function') return customBuilder;
  try {
    const mod = require('./domTranslator');
    if (mod && typeof mod.buildInjectionScript === 'function') {
      return mod.buildInjectionScript;
    }
  } catch {
    // domTranslator may not exist in isolated unit tests
  }
  return null;
}

function createMainLoader(electron, options = {}) {
  const baseDir = options.baseDir || path.join(os.homedir(), '.antigravity-i18n');
  const config = options.config || loadConfig(baseDir);
  if (config.enabled === false) return { enabled: false };

  const pendingMissing = new Set();
  const translator =
    options.translator ||
    loadTranslatorFromDir(baseDir, {
      onMissing: config.collectMissing
        ? (s) => pendingMissing.add(s)
        : undefined,
    });

  installMenuHooks(electron, translator);

  const asarPath =
    options.asarPath ||
    path.join(path.dirname(process.execPath), 'resources', 'app.asar');
  installUpdaterHooks({
    baseDir,
    asarPath,
    exePath: process.execPath,
  });

  const payload = options.payload || readDictPayload(baseDir);
  const buildScript = getBuildInjectionScript(options.buildInjectionScript);
  const injectionCode = buildScript
    ? buildScript({
        exactMap: payload.exactMap,
        patterns: payload.patterns,
        collectMissing: Boolean(config.collectMissing),
      })
    : null;

  if (electron.app && typeof electron.app.on === 'function') {
    electron.app.on('web-contents-created', (_event, contents) => {
      if (!contents || (typeof contents.getType === 'function' && contents.getType() === 'webview')) {
        return;
      }

      const tryInject = () => {
        if (!injectionCode || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) {
          return;
        }
        const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
        if (!isTargetAppUrl(url)) return;
        Promise.resolve(contents.executeJavaScript(injectionCode, true)).catch(() => undefined);
      };

      contents.on('dom-ready', tryInject);
      contents.on('did-finish-load', tryInject);
      contents.on('did-navigate-in-page', tryInject);

      if (config.collectMissing) {
        contents.on('console-message', (_ev, _level, message) => {
          if (typeof message === 'string' && message.startsWith('__AGY_I18N_MISSING__:')) {
            try {
              const list = JSON.parse(message.slice('__AGY_I18N_MISSING__:'.length));
              for (const item of list) pendingMissing.add(item);
            } catch {
              // Ignore malformed console message
            }
          }
        });
      }
    });

    if (config.collectMissing) {
      const flushTimer = setInterval(() => {
        if (pendingMissing.size > 0) {
          const batch = [...pendingMissing];
          pendingMissing.clear();
          appendMissingStrings(baseDir, batch);
        }
      }, 15000);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();

      electron.app.on('will-quit', () => {
        if (pendingMissing.size > 0) {
          appendMissingStrings(baseDir, [...pendingMissing]);
          pendingMissing.clear();
        }
      });
    }
  }

  return { enabled: true };
}

function init(electron) {
  if (global.__AGY_I18N_MAIN_LOADED__) return;
  global.__AGY_I18N_MAIN_LOADED__ = true;
  createMainLoader(electron);
}

module.exports = init;
module.exports.createMainLoader = createMainLoader;
