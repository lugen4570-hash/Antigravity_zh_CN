import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { isAsarPatched, readAsar, writeAsar } from '../patcher/asar-patch.mjs';

function makeTempAsar(dir, mainJs = '"use strict";\nconsole.log("ok");\n') {
  const asarPath = path.join(dir, 'app.asar');
  const bufMain = Buffer.from(mainJs, 'utf8');
  const bufPkg = Buffer.from('{"name":"antigravity","version":"2.31.2","main":"dist/main.js"}', 'utf8');
  const header = {
    files: {
      'package.json': { size: bufPkg.length, offset: '0' },
      dist: {
        files: {
          'main.js': { size: bufMain.length, offset: String(bufPkg.length) },
        },
      },
    },
  };
  writeAsar(asarPath, header, new Map([
    ['package.json', bufPkg],
    ['dist/main.js', bufMain],
  ]));
  return asarPath;
}

function runPs(scriptPath, args) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8' }
  );
}

test('install.ps1 deploys to BaseDir, patches temp app.asar, and uninstall.ps1 cleanly restores it', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-e2e-'));
  const fakeHome = path.join(tmpRoot, 'home-i18n');
  const fakeRes = path.join(tmpRoot, 'resources');
  fs.mkdirSync(path.join(fakeRes, 'bin'), { recursive: true });
  const asarPath = makeTempAsar(fakeRes);

  runPs(path.resolve('scripts/install.ps1'), [
    '-SourceDir', path.resolve('.'),
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-SkipTaskRegister',
    '-NoWait',
  ]);

  assert.equal(fs.existsSync(path.join(fakeHome, 'config.json')), true);
  assert.equal(fs.existsSync(path.join(fakeHome, 'runtime', 'loader.js')), true);
  assert.equal(fs.existsSync(path.join(fakeHome, 'dict', 'zh-CN.json')), true);
  assert.equal(isAsarPatched(asarPath), true);

  // User customizes config.json; re-running install preserves it
  const cfgPath = path.join(fakeHome, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, collectMissing: false }), 'utf8');
  runPs(path.resolve('scripts/install.ps1'), [
    '-SourceDir', path.resolve('.'),
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-SkipTaskRegister',
    '-NoWait',
  ]);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).collectMissing, false);

  runPs(path.resolve('scripts/uninstall.ps1'), [
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-SkipTaskRemove',
    '-RemoveData',
  ]);
  assert.equal(isAsarPatched(asarPath), false);
  assert.equal(fs.existsSync(fakeHome), false);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('repatch-after-update.ps1 detects updated unpatched ASAR, repatches it, and scans unseen strings', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-repatch-'));
  const fakeHome = path.join(tmpRoot, 'home-i18n');
  const fakeRes = path.join(tmpRoot, 'resources');
  fs.mkdirSync(path.join(fakeRes, 'bin'), { recursive: true });
  const asarPath = makeTempAsar(fakeRes, '"use strict";\nconst brandNewLabel = "Super Unseen Feature";\n');

  runPs(path.resolve('scripts/install.ps1'), [
    '-SourceDir', path.resolve('.'),
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-SkipTaskRegister',
    '-SkipPatch',
  ]);

  runPs(path.join(fakeHome, 'scripts', 'repatch-after-update.ps1'), [
    '-OldPid', '0',
    '-AsarPath', asarPath,
    '-ExePath', 'C:\\NonExistent\\Antigravity.exe',
    '-OldHash', 'different-old-hash',
    '-Relaunch', '0',
    '-BaseDir', fakeHome,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-SkipRelaunch',
    '-MaxWaitSeconds', '5',
  ]);

  assert.equal(isAsarPatched(asarPath), true);
  const parsed = readAsar(asarPath);
  assert.ok(parsed.files.has('dist/zhBootstrap.js'));

  const pendingFile = path.join(fakeHome, 'logs', 'new-strings-pending.json');
  assert.equal(fs.existsSync(pendingFile), true);
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.ok(pending.includes('Super Unseen Feature'));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('self-heal.ps1 skips fast when patched and heals when unpatched', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-heal-'));
  const fakeHome = path.join(tmpRoot, 'home-i18n');
  const fakeRes = path.join(tmpRoot, 'resources');
  fs.mkdirSync(path.join(fakeRes, 'bin'), { recursive: true });
  const asarPath = makeTempAsar(fakeRes);

  runPs(path.resolve('scripts/install.ps1'), [
    '-SourceDir', path.resolve('.'),
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-SkipTaskRegister',
    '-SkipPatch',
  ]);

  assert.equal(isAsarPatched(asarPath), false);
  runPs(path.join(fakeHome, 'scripts', 'self-heal.ps1'), [
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-NoWait',
  ]);
  assert.equal(isAsarPatched(asarPath), true);

  // Second run when already patched exits cleanly
  runPs(path.join(fakeHome, 'scripts', 'self-heal.ps1'), [
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-NoWait',
  ]);
  assert.equal(isAsarPatched(asarPath), true);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('repatch-after-update.ps1 waits for mutex released by another process instead of aborting', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n mutex space-'));
  const fakeHome = path.join(tmpRoot, 'home i18n');
  const fakeRes = path.join(tmpRoot, 'res dir');
  fs.mkdirSync(path.join(fakeRes, 'bin'), { recursive: true });
  const asarPath = makeTempAsar(fakeRes);

  // Also tests paths with spaces in install.ps1
  runPs(path.resolve('scripts/install.ps1'), [
    '-SourceDir', path.resolve('.'),
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-SkipTaskRegister',
    '-SkipPatch',
  ]);

  // Hold Local\AntigravityI18nHeal mutex for 1.5s in a background PowerShell process
  const holder = spawn('powershell.exe', [
    '-NoProfile',
    '-Command',
    "$m = New-Object System.Threading.Mutex($false, 'Local\\AntigravityI18nHeal'); $null = $m.WaitOne(5000); Start-Sleep -Milliseconds 1500; $m.ReleaseMutex(); $m.Dispose()",
  ], { stdio: 'ignore' });

  // Wait briefly so holder acquires mutex first
  await new Promise((r) => setTimeout(r, 400));

  runPs(path.join(fakeHome, 'scripts', 'repatch-after-update.ps1'), [
    '-OldPid', '0',
    '-AsarPath', asarPath,
    '-ExePath', 'C:\\NonExistent\\Antigravity.exe',
    '-OldHash', 'different-old-hash',
    '-Relaunch', '0',
    '-BaseDir', fakeHome,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-SkipRelaunch',
    '-MaxWaitSeconds', '10',
  ]);

  await new Promise((r) => holder.on('exit', r));
  assert.equal(isAsarPatched(asarPath), true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('install.ps1 quotes paths with spaces when spawning background heal', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n space spawn-'));
  const fakeHome = path.join(tmpRoot, 'home with spaces');
  const fakeRes = path.join(tmpRoot, 'res with spaces');
  fs.mkdirSync(path.join(fakeRes, 'bin'), { recursive: true });
  const asarPath = makeTempAsar(fakeRes);

  runPs(path.resolve('scripts/install.ps1'), [
    '-SourceDir', path.resolve('.'),
    '-BaseDir', fakeHome,
    '-AsarPath', asarPath,
    '-ProcessName', 'NonExistentTestProcessNameXYZ',
    '-SkipTaskRegister',
  ]);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !isAsarPatched(asarPath)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(isAsarPatched(asarPath), true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
