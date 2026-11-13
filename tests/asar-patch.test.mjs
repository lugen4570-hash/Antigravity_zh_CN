import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  readAsar,
  writeAsar,
  isAsarPatched,
  patchAsar,
  unpatchAsar,
  BOOTSTRAP_MARKER,
} from '../patcher/asar-patch.mjs';

function buildSyntheticAsarBuffer(entries, unpackedEntries = []) {
  const fileBuffers = [];
  let offset = 0;
  const header = { files: {} };

  function ensureDir(parts) {
    let cur = header;
    for (const part of parts) {
      if (!cur.files[part]) cur.files[part] = { files: {} };
      cur = cur.files[part];
    }
    return cur;
  }

  for (const [relPath, content] of Object.entries(entries)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const parts = relPath.split('/');
    const fileName = parts.pop();
    const dirNode = ensureDir(parts);
    dirNode.files[fileName] = { size: buf.length, offset: String(offset) };
    fileBuffers.push(buf);
    offset += buf.length;
  }

  for (const [relPath, size] of unpackedEntries) {
    const parts = relPath.split('/');
    const fileName = parts.pop();
    const dirNode = ensureDir(parts);
    dirNode.files[fileName] = { size, unpacked: true };
  }

  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const alignedLen = (jsonBuf.length + 3) & ~3;
  const paddedJson = Buffer.alloc(alignedLen, 0);
  jsonBuf.copy(paddedJson);

  const pickleHeader = Buffer.alloc(16);
  pickleHeader.writeUInt32LE(4, 0);
  pickleHeader.writeUInt32LE(alignedLen + 8, 4);
  pickleHeader.writeUInt32LE(alignedLen + 4, 8);
  pickleHeader.writeUInt32LE(jsonBuf.length, 12);

  return Buffer.concat([pickleHeader, paddedJson, ...fileBuffers]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('roundtrip preserves files and unpacked entries verbatim', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-test-'));
  const asarPath = path.join(tmpDir, 'app.asar');
  const mainContent = '"use strict";\nconsole.log("hello");\n';
  const pkgContent = '{"name":"antigravity","main":"dist/main.js"}\n';
  fs.writeFileSync(
    asarPath,
    buildSyntheticAsarBuffer(
      { 'package.json': pkgContent, 'dist/main.js': mainContent },
      [['node_modules/pkg/native.node', 4096]]
    )
  );

  const parsed = readAsar(asarPath);
  assert.equal(parsed.header.files.node_modules.files.pkg.files['native.node'].unpacked, true);
  assert.equal(parsed.files.get('dist/main.js').toString('utf8'), mainContent);

  const outPath = path.join(tmpDir, 'out.asar');
  writeAsar(outPath, parsed.header, parsed.files);
  const reparsed = readAsar(outPath);

  assert.equal(reparsed.files.get('package.json').toString('utf8'), pkgContent);
  assert.equal(reparsed.files.get('dist/main.js').toString('utf8'), mainContent);
  assert.equal(reparsed.header.files.node_modules.files.pkg.files['native.node'].unpacked, true);
  assert.equal(reparsed.header.files.node_modules.files.pkg.files['native.node'].size, 4096);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('patchAsar injects bootstrap, creates backup once, and is idempotent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-patch-'));
  const asarPath = path.join(tmpDir, 'app.asar');
  const backupPath = path.join(tmpDir, 'app.asar.bak');
  const origMain = '"use strict";\nconsole.log("main");\n';
  fs.writeFileSync(
    asarPath,
    buildSyntheticAsarBuffer({ 'package.json': '{"main":"dist/main.js"}', 'dist/main.js': origMain })
  );

  assert.equal(isAsarPatched(asarPath), false);
  const res1 = patchAsar(asarPath, { backupPath });
  assert.equal(res1.status, 'patched');
  assert.equal(res1.backupCreated, true);
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(isAsarPatched(asarPath), true);

  const parsed = readAsar(asarPath);
  assert.ok(parsed.files.has('dist/zhBootstrap.js'));
  const patchedMain = parsed.files.get('dist/main.js').toString('utf8');
  assert.ok(patchedMain.startsWith(BOOTSTRAP_MARKER));
  assert.ok(patchedMain.endsWith(origMain));

  const res2 = patchAsar(asarPath, { backupPath });
  assert.equal(res2.status, 'already-patched');
  assert.equal(res2.backupCreated, false);

  const cliOut = execFileSync(process.execPath, [
    path.resolve('patcher/asar-patch.mjs'),
    'status',
    asarPath,
  ], { encoding: 'utf8' });
  assert.match(cliOut, /patched/i);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unpatchAsar restores original dist/main.js and removes dist/zhBootstrap.js', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-unpatch-'));
  const asarPath = path.join(tmpDir, 'app.asar');
  const origMain = '"use strict";\nconsole.log("main");\n';
  fs.writeFileSync(
    asarPath,
    buildSyntheticAsarBuffer({ 'package.json': '{"main":"dist/main.js"}', 'dist/main.js': origMain })
  );

  patchAsar(asarPath);
  assert.equal(isAsarPatched(asarPath), true);

  const res = unpatchAsar(asarPath);
  assert.equal(res.status, 'unpatched');
  assert.equal(isAsarPatched(asarPath), false);

  const parsed = readAsar(asarPath);
  assert.equal(parsed.files.has('dist/zhBootstrap.js'), false);
  assert.equal(parsed.files.get('dist/main.js').toString('utf8'), origMain);
  assert.equal(unpatchAsar(asarPath).status, 'not-patched');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('patchAsar works cleanly on copied real Antigravity app.asar without altering other files', () => {
  const realAsar = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs',
    'antigravity',
    'resources',
    'app.asar'
  );
  if (!fs.existsSync(realAsar)) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-real-'));
  const copyPath = path.join(tmpDir, 'app.asar');
  fs.copyFileSync(realAsar, copyPath);

  const before = readAsar(copyPath);
  const menuHashBefore = sha256(before.files.get('dist/menu.js'));

  const res = patchAsar(copyPath);
  assert.equal(res.status, 'patched');
  assert.equal(isAsarPatched(copyPath), true);

  const after = readAsar(copyPath);
  assert.equal(sha256(after.files.get('dist/menu.js')), menuHashBefore);
  assert.ok(after.header.files.node_modules.files['chrome-devtools-mcp']);
  assert.ok(after.files.has('dist/zhBootstrap.js'));

  unpatchAsar(copyPath);
  assert.equal(isAsarPatched(copyPath), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
