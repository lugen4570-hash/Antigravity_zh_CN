'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { spawn } = require('child_process');

function sha256File(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
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

  let bridgeSpawned = false;

  BaseUpdater.prototype.install = function wrappedInstall(isSilent = false, isForceRunAfter = false) {
    const shouldRelaunch = Boolean(isForceRunAfter || !isSilent || this.autoRunAppAfterInstall);

    if (!bridgeSpawned && process.platform === 'win32') {
      const scriptPath = path.join(baseDir, 'scripts', 'repatch-after-update.ps1');
      if (fs.existsSync(scriptPath) || options.spawnFn) {
        bridgeSpawned = true;
        const oldHash = sha256File(asarPath);
        const args = [
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
          oldHash,
          '-Relaunch',
          shouldRelaunch ? '1' : '0',
        ];
        try {
          const child = spawnFn('powershell.exe', args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child && typeof child.unref === 'function') {
            child.unref();
          }
        } catch (err) {
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
