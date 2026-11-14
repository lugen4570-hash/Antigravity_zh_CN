'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { spawn } = require('child_process');

function getRawFs() {
  try {
    return require('original-fs');
  } catch {
    return fs;
  }
}

function sha256File(filePath) {
  try {
    const rawFs = getRawFs();
    if (!filePath || !rawFs.existsSync(filePath)) return '';
    return crypto.createHash('sha256').update(rawFs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function appendHookLog(baseDir, message) {
  if (!baseDir) return;
  try {
    const logDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    fs.appendFileSync(path.join(logDir, 'i18n.log'), `[${ts}] ${message}\r\n`, 'utf8');
  } catch {
    // Logging failures must never break updater flow
  }
}

function patchBaseUpdaterClass(BaseUpdater, options) {
  if (!BaseUpdater || !BaseUpdater.prototype || BaseUpdater.prototype.__agyUpdaterHooked) return false;
  BaseUpdater.prototype.__agyUpdaterHooked = true;

  const origInstall = BaseUpdater.prototype.install;
  const spawnFn = options.spawnFn || spawn;
  const baseDir = options.baseDir;
  const asarPath = options.asarPath;
  const exePath = options.exePath || process.execPath;
  const logger = options.logger || console;

  BaseUpdater.prototype.install = function wrappedInstall(isSilent = false, isForceRunAfter = false) {
    const shouldRelaunch = Boolean(isForceRunAfter || !isSilent);

    if (!this.__agyBridgeSpawned && process.platform === 'win32') {
      const scriptPath = path.join(baseDir, 'scripts', 'repatch-after-update.ps1');
      if (fs.existsSync(scriptPath) || options.spawnFn) {
        this.__agyBridgeSpawned = true;
        const oldHash = sha256File(asarPath);
        const psExe = process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : 'powershell.exe';
        const args = [
          '/d',
          '/c',
          psExe,
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          scriptPath,
          '-OldPid',
          String(process.pid),
          '-AsarPath',
          asarPath,
          '-ExePath',
          exePath,
          '-OldHash',
          oldHash || 'unknown',
          '-Relaunch',
          shouldRelaunch ? '1' : '0',
        ];
        try {
          appendHookLog(baseDir, `Updater hook triggered (Pid=${process.pid}, Relaunch=${shouldRelaunch ? 1 : 0}).`);
          const child = spawnFn(process.env.ComSpec || 'cmd.exe', args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child && typeof child.on === 'function') {
            child.on('error', (err) => {
              appendHookLog(baseDir, `Repatch bridge spawn error: ${err && err.message ? err.message : err}`);
            });
          }
          if (child && typeof child.unref === 'function') {
            child.unref();
          }
        } catch (err) {
          appendHookLog(baseDir, `Failed to spawn repatch bridge: ${err && err.message ? err.message : err}`);
          logger.error('[antigravity-i18n] Failed to spawn repatch bridge:', err);
        }
      }
    }

    // Force silent NSIS install without auto-launching so repatch-after-update.ps1 patches app.asar first
    return origInstall.call(this, true, false);
  };

  return true;
}

function installUpdaterHooks(options = {}) {
  if (options.BaseUpdater) {
    return patchBaseUpdaterClass(options.BaseUpdater, options);
  }

  // Check if electron-updater/BaseUpdater is already in require.cache
  for (const cached of Object.values(require.cache)) {
    if (cached && cached.exports && cached.exports.BaseUpdater) {
      patchBaseUpdaterClass(cached.exports.BaseUpdater, options);
    }
  }

  // Intercept future require('electron-updater') calls
  if (!Module.__agyUpdaterLoadWrapped) {
    Module.__agyUpdaterLoadWrapped = true;
    const origLoad = Module._load;
    Module._load = function wrappedModuleLoad(request, parent, isMain) {
      const exported = origLoad.call(this, request, parent, isMain);
      try {
        if (request === 'electron-updater' || (typeof request === 'string' && request.endsWith('/BaseUpdater'))) {
          if (exported && exported.BaseUpdater) {
            patchBaseUpdaterClass(exported.BaseUpdater, options);
          } else if (exported && exported.autoUpdater && exported.autoUpdater.constructor) {
            const proto = Object.getPrototypeOf(Object.getPrototypeOf(exported.autoUpdater));
            if (proto && typeof proto.install === 'function') {
              patchBaseUpdaterClass({ prototype: proto }, options);
            }
          }
        }
      } catch {
        // Never break module loading
      }
      return exported;
    };
  }
  return true;
}

module.exports = {
  installUpdaterHooks,
  patchBaseUpdaterClass,
};
