import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTranslator } = require('../runtime/translator.js');

test('zh-CN.json and patterns.json are valid and translate critical Antigravity UI strings', () => {
  const exactMap = JSON.parse(fs.readFileSync(path.resolve('dict/zh-CN.json'), 'utf8'));
  const patterns = JSON.parse(fs.readFileSync(path.resolve('dict/patterns.json'), 'utf8'));

  assert.equal(typeof exactMap, 'object');
  assert.ok(Object.keys(exactMap).length >= 150, 'Expected rich dictionary coverage');
  assert.ok(Array.isArray(patterns));

  for (const [k, v] of Object.entries(exactMap)) {
    assert.equal(typeof k, 'string');
    assert.equal(typeof v, 'string');
    assert.ok(v.trim().length > 0, `Empty translation for key: ${k}`);
  }

  for (const rule of patterns) {
    assert.equal(typeof rule.pattern, 'string');
    assert.equal(typeof rule.replace, 'string');
    assert.doesNotThrow(() => new RegExp(rule.pattern, rule.flags || ''));
  }

  const t = createTranslator({ exactMap, patterns });

  for (const key of [
    'File',
    'Edit',
    'View',
    'Window',
    'Help',
    'New Window',
    'Check for Updates',
    'Checking for Updates...',
    'Downloading Update...',
    'Restart to Update',
    'No updates available',
    'Connect to WSL',
    'Reopen Locally',
    'Docs',
    'Settings',
    'Projects',
    'Scheduled Tasks',
    'New Conversation',
    'Terminal Sandbox',
    'Permission Grants',
    'Artifact Review Mode',
    'Cancel',
    'OK',
  ]) {
    const out = t.translate(key);
    assert.notEqual(out, key, `Expected translation for: ${key}`);
  }

  assert.equal(t.translate('No agents running'), '无代理正在运行');
  assert.equal(t.translate('2 agents running'), '2 个代理正在运行');
  assert.equal(t.translate('3 files changed'), '3 个文件已更改');
});

test('scan-new-strings writes unseen UI candidates without crashing', async () => {
  const { scanNewStrings } = await import('../scripts/scan-new-strings.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const outPath = path.join(tmpDir, 'new-strings-pending.json');
  const exactMap = JSON.parse(fs.readFileSync(path.resolve('dict/zh-CN.json'), 'utf8'));
  const patterns = JSON.parse(fs.readFileSync(path.resolve('dict/patterns.json'), 'utf8'));

  const res = scanNewStrings({
    candidates: ['Settings', 'Brand Unseen Button', 'Check for Updates'],
    exactMap,
    patterns,
    outputPath: outPath,
  });

  assert.deepEqual(res, ['Brand Unseen Button']);
  assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), ['Brand Unseen Button']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
