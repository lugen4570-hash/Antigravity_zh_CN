import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAsarPatched, writeAsar } from '../patcher/asar-patch.mjs';
import {
  computeAsarHeaderSha256,
  patchPlistIntegrityFile,
} from '../scripts/macos/update-plist-integrity.mjs';

const require = createRequire(import.meta.url);
const { resolveDefaultAsarPath } = require('../runtime/loader.js');
const { installUpdaterHooks } = require('../runtime/updaterHook.js');

function findBashExe() {
  if (process.platform !== 'win32') return '/bin/bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function toForwardSlash(p) {
  return String(p).replace(/\\/g, '/');
}

function makeTempAsar(dir, mainJs = '"use strict";\nconsole.log("ok");\n') {
  const asarPath = path.join(dir, 'app.asar');
  const bufMain = Buffer.from(mainJs, 'utf8');
  const bufPkg = Buffer.from('{"name":"antigravity","version":"2.32.2","main":"dist/main.js"}', 'utf8');
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

function makeTempMacAppBundle(rootDir) {
  const appPath = path.join(rootDir, 'Antigravity.app');
  const contentsDir = path.join(appPath, 'Contents');
  const resDir = path.join(contentsDir, 'Resources');
  const macOsDir = path.join(contentsDir, 'MacOS');
  fs.mkdirSync(resDir, { recursive: true });
  fs.mkdirSync(macOsDir, { recursive: true });
  const asarPath = makeTempAsar(resDir);
  const origHeaderHash = computeAsarHeaderSha256(asarPath);
  const plistPath = path.join(contentsDir, 'Info.plist');
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>2.32.2</string>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>${origHeaderHash}</string>
    </dict>
  </dict>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plistXml, 'utf8');
  return { appPath, asarPath, plistPath, origHeaderHash };
}

test('resolveDefaultAsarPath resolves macOS bundle Contents/Resources/app.asar', () => {
  assert.equal(
    resolveDefaultAsarPath({
      platform: 'darwin',
      execPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      resourcesPath: '',
    }),
    '/Applications/Antigravity.app/Contents/Resources/app.asar',
  );
  assert.equal(
    resolveDefaultAsarPath({
      platform: 'win32',
      execPath: 'C:\\Apps\\Antigravity\\Antigravity.exe',
      resourcesPath: '',
    }),
    'C:\\Apps\\Antigravity\\resources\\app.asar',
  );
  assert.equal(
    resolveDefaultAsarPath({
      platform: 'darwin',
      execPath: '/Applications/Custom.app/Contents/MacOS/Antigravity',
      resourcesPath: '/Applications/Custom.app/Contents/Resources',
    }),
    '/Applications/Custom.app/Contents/Resources/app.asar',
  );
});

test('updaterHook on darwin spawns /bin/bash repatch-after-update.sh', () => {
  const spawns = [];
  class MockBaseUpdater {
    install() {
      return true;
    }
  }

  installUpdaterHooks({
    BaseUpdater: MockBaseUpdater,
    platform: 'darwin',
    baseDir: '/Users/demo/.antigravity-i18n',
    asarPath: '/Applications/Antigravity.app/Contents/Resources/app.asar',
    exePath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
    spawnFn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return { unref() {}, on() {} };
    },
  });

  const updater = new MockBaseUpdater();
  updater.install(false, true);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, '/bin/bash');
  assert.equal(spawns[0].args[0], '/Users/demo/.antigravity-i18n/scripts/macos/repatch-after-update.sh');
  assert.ok(spawns[0].args.includes('--relaunch'));
  assert.equal(spawns[0].args[spawns[0].args.indexOf('--relaunch') + 1], '1');
});

test('patchPlistIntegrityFile updates ElectronAsarIntegrity SHA-256 hash and saves backup', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-plist-'));
  const { asarPath, plistPath, origHeaderHash } = makeTempMacAppBundle(tmpRoot);
  const backupPath = path.join(tmpRoot, 'backups', 'Info.plist.bak');

  // Re-write ASAR with extra entry to alter header hash
  const modDir = path.join(tmpRoot, 'modified');
  fs.mkdirSync(modDir, { recursive: true });
  const asarPath2 = makeTempAsar(modDir, '"use strict";\nconsole.log("patched");\n');
  const newHash = computeAsarHeaderSha256(asarPath2);
  assert.notEqual(newHash, origHeaderHash);

  const res = patchPlistIntegrityFile(plistPath, asarPath2, { backupPath });
  assert.equal(res.status, 'updated');
  assert.equal(res.backupCreated, true);
  assert.equal(res.hash, newHash);

  const updatedText = fs.readFileSync(plistPath, 'utf8');
  assert.ok(updatedText.includes(`<string>${newHash}</string>`));
  assert.ok(fs.readFileSync(backupPath, 'utf8').includes(`<string>${origHeaderHash}</string>`));

  // Verify graceful skip when no ElectronAsarIntegrity key exists
  const plainPlist = path.join(tmpRoot, 'Plain.plist');
  fs.writeFileSync(plainPlist, '<plist><dict><key>CFBundleName</key><string>Antigravity</string></dict></plist>', 'utf8');
  const skipped = patchPlistIntegrityFile(plainPlist, asarPath2);
  assert.equal(skipped.status, 'no-integrity-key');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const bashExe = findBashExe();

test('macOS bash scripts pass bash -n syntax check and end-to-end install/self-heal/repatch/uninstall', { skip: !bashExe }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-macos-e2e-'));
  const fakeHome = path.join(tmpRoot, 'home');
  const fakeBase = path.join(fakeHome, '.antigravity-i18n');
  const stubBin = path.join(tmpRoot, 'stub-bin');
  const logCalls = path.join(tmpRoot, 'stub-calls.log');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(stubBin, { recursive: true });

  // Create stub macOS tools (codesign, xattr, launchctl, open, osascript, plutil)
  for (const tool of ['codesign', 'xattr', 'launchctl', 'open', 'osascript', 'plutil']) {
    const stubPath = path.join(stubBin, tool);
    fs.writeFileSync(stubPath, `#!/usr/bin/env bash\necho "${tool} $*" >> "${toForwardSlash(logCalls)}"\nexit 0\n`, { mode: 0o755 });
  }

  const { appPath, asarPath, plistPath, origHeaderHash } = makeTempMacAppBundle(tmpRoot);
  const env = {
    ...process.env,
    HOME: toForwardSlash(fakeHome),
    PATH: `${toForwardSlash(stubBin)}:${process.env.PATH || ''}`,
  };

  // Syntax check all scripts
  for (const name of ['common.sh', 'install.sh', 'self-heal.sh', 'repatch-after-update.sh', 'uninstall.sh', 'remote-install.sh']) {
    execFileSync(bashExe, ['-n', toForwardSlash(path.resolve('scripts/macos', name))], { encoding: 'utf8', env });
  }

  // Install + register LaunchAgent plist + patch .app bundle
  execFileSync(bashExe, [
    toForwardSlash(path.resolve('scripts/macos/install.sh')),
    '--source-dir', toForwardSlash(path.resolve('.')),
    '--base-dir', toForwardSlash(fakeBase),
    '--app-path', toForwardSlash(appPath),
    '--asar-path', toForwardSlash(asarPath),
    '--process-name', 'NonExistentTestProcessNameXYZ',
    '--no-wait',
  ], { encoding: 'utf8', env });

  assert.equal(isAsarPatched(asarPath), true);
  assert.ok(fs.existsSync(path.join(fakeHome, 'Library', 'LaunchAgents', 'com.antigravity.i18n.selfheal.plist')));
  const patchedHash = computeAsarHeaderSha256(asarPath);
  assert.notEqual(patchedHash, origHeaderHash);
  assert.ok(fs.readFileSync(plistPath, 'utf8').includes(`<string>${patchedHash}</string>`));
  assert.ok(fs.readFileSync(logCalls, 'utf8').includes('codesign --force --deep --sign -'));

  // Simulate app update replacing ASAR & run repatch-after-update.sh
  const fakeRes = path.dirname(asarPath);
  makeTempAsar(fakeRes, '"use strict";\nconsole.log("v2.33.0");\n');
  assert.equal(isAsarPatched(asarPath), false);

  execFileSync(bashExe, [
    toForwardSlash(path.join(fakeBase, 'scripts/macos/repatch-after-update.sh')),
    '--old-pid', '0',
    '--asar-path', toForwardSlash(asarPath),
    '--exe-path', toForwardSlash(path.join(appPath, 'Contents', 'MacOS', 'Antigravity')),
    '--old-hash', 'different-old-hash',
    '--relaunch', '1',
    '--base-dir', toForwardSlash(fakeBase),
    '--process-name', 'NonExistentTestProcessNameXYZ',
    '--max-wait-seconds', '10',
  ], { encoding: 'utf8', env });

  assert.equal(isAsarPatched(asarPath), true);
  assert.ok(fs.readFileSync(logCalls, 'utf8').includes(`open -a ${toForwardSlash(appPath)}`));

  // Uninstall cleanly restores ASAR & Info.plist
  execFileSync(bashExe, [
    toForwardSlash(path.join(fakeBase, 'scripts/macos/uninstall.sh')),
    '--base-dir', toForwardSlash(fakeBase),
    '--asar-path', toForwardSlash(asarPath),
    '--process-name', 'NonExistentTestProcessNameXYZ',
    '--remove-data',
  ], { encoding: 'utf8', env });

  assert.equal(isAsarPatched(asarPath), false);
  assert.ok(fs.readFileSync(plistPath, 'utf8').includes(`<string>${origHeaderHash}</string>`));
  assert.equal(fs.existsSync(fakeBase), false);
  assert.equal(fs.existsSync(path.join(fakeHome, 'Library', 'LaunchAgents', 'com.antigravity.i18n.selfheal.plist')), false);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('macOS remote-install.sh downloads tar.gz archive and installs', { skip: !bashExe }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-macos-remote-'));
  const pkgRoot = path.join(tmpRoot, 'Antigravity_zh_CN-main');
  const tgzPath = path.join(tmpRoot, 'repo.tar.gz');
  const fakeHome = path.join(tmpRoot, 'home');
  const fakeBase = path.join(fakeHome, '.antigravity-i18n');
  fs.mkdirSync(fakeHome, { recursive: true });

  for (const dir of ['runtime', 'dict', 'patcher', 'scripts']) {
    fs.cpSync(path.resolve(dir), path.join(pkgRoot, dir), { recursive: true });
  }
  fs.copyFileSync(path.resolve('config.default.json'), path.join(pkgRoot, 'config.default.json'));

  const { appPath, asarPath } = makeTempMacAppBundle(tmpRoot);

  // Create tar.gz using built-in Windows/macOS tar (available on Win10+/macOS)
  execFileSync('tar', ['-czf', tgzPath, '-C', tmpRoot, 'Antigravity_zh_CN-main'], { encoding: 'utf8' });
  const tgzBytes = fs.readFileSync(tgzPath);

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(tgzBytes.length),
    });
    res.end(tgzBytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bashExe, [
        toForwardSlash(path.resolve('scripts/macos/remote-install.sh')),
        '--archive-url', `http://127.0.0.1:${port}/repo.tar.gz`,
        '--base-dir', toForwardSlash(fakeBase),
        '--app-path', toForwardSlash(appPath),
        '--asar-path', toForwardSlash(asarPath),
        '--process-name', 'NonExistentTestProcessNameXYZ',
        '--skip-agent-register',
        '--no-wait',
      ], {
        env: { ...process.env, HOME: toForwardSlash(fakeHome) },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`remote-install.sh exited ${code}: ${stderr}`));
      });
    });

    assert.equal(isAsarPatched(asarPath), true);
    assert.equal(fs.existsSync(path.join(fakeBase, 'dict', 'zh-CN.json')), true);
  } finally {
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
