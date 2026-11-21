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

function buildRepatchSpawnSpec({
  platform = process.platform,
  baseDir,
  pid,
  asarPath,
  exePath,
  oldHash,
  shouldRelaunch,
}) {
  if (platform === 'darwin') {
    const scriptPath = path.posix.join(String(baseDir).replace(/\\/g, '/'), 'scripts', 'macos', 'repatch-after-update.sh');
    return {
      scriptPath,
      command: '/bin/bash',
      args: [
        scriptPath,
        '--old-pid',
        String(pid),
        '--asar-path',
        asarPath,
        '--exe-path',
        exePath,
        '--old-hash',
        oldHash || 'unknown',
        '--relaunch',
        shouldRelaunch ? '1' : '0',
      ],
      spawnOptions: {
        detached: true,
        stdio: 'ignore',
      },
    };
  }

  if (platform === 'win32') {
    const scriptPath = path.join(baseDir, 'scripts', 'repatch-after-update.ps1');
    const psExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    return {
      scriptPath,
      command: process.env.ComSpec || 'cmd.exe',
      args: [
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
        String(pid),
        '-AsarPath',
        asarPath,
        '-ExePath',
        exePath,
        '-OldHash',
        oldHash || 'unknown',
        '-Relaunch',
        shouldRelaunch ? '1' : '0',
      ],
      spawnOptions: {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    };
  }

  return null;
}

function patchBaseUpdaterClass(BaseUpdater, options) {
  if (!BaseUpdater || !BaseUpdater.prototype || BaseUpdater.prototype.__agyUpdaterHooked) return false;
  BaseUpdater.prototype.__agyUpdaterHooked = true;

  const origInstall = BaseUpdater.prototype.install;
  const spawnFn = options.spawnFn || spawn;
  const platform = options.platform || process.platform;
  const baseDir = options.baseDir;
  const asarPath = options.asarPath;
  const exePath = options.exePath || process.execPath;
  const logger = options.logger || console;

  BaseUpdater.prototype.install = function wrappedInstall(isSilent = false, isForceRunAfter = false) {
    const shouldRelaunch = Boolean(isForceRunAfter || !isSilent);

    if (!this.__agyBridgeSpawned && (platform === 'win32' || platform === 'darwin')) {
      const oldHash = sha256File(asarPath);
      const spec = buildRepatchSpawnSpec({
        platform,
        baseDir,
        pid: process.pid,
        asarPath,
        exePath,
        oldHash,
        shouldRelaunch,
      });
      if (spec && (fs.existsSync(spec.scriptPath) || options.spawnFn)) {
        this.__agyBridgeSpawned = true;
        try {
          appendHookLog(baseDir, `Updater hook triggered (Platform=${platform}, Pid=${process.pid}, Relaunch=${shouldRelaunch ? 1 : 0}).`);
          const child = spawnFn(spec.command, spec.args, spec.spawnOptions);
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

    // Force silent install without auto-launching so repatch bridge patches app.asar first
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
