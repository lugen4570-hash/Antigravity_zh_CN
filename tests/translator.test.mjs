import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTranslator, loadTranslatorFromDir } = require('../runtime/translator.js');

test('exact match preserves surrounding whitespace', () => {
  const t = createTranslator({
    exactMap: { Settings: '设置' },
    patterns: [],
  });
  assert.equal(t.translate('Settings'), '设置');
  assert.equal(t.translate('  Settings \n'), '  设置 \n');
  assert.equal(t.hasExact('Settings'), true);
  assert.equal(t.hasExact('Unknown'), false);
});

test('pattern match translates dynamic values using capture groups', () => {
  const t = createTranslator({
    exactMap: {},
    patterns: [
      { pattern: '^(\\d+) files? changed$', replace: '$1 个文件已更改' },
      { pattern: '^(No|\\d+) agents? running$', replace: (m, c) => (c === 'No' ? '无代理正在运行' : `${c} 个代理正在运行`) },
      { pattern: '^Updated (\\d+)m ago$', replace: '$1 分钟前更新' },
    ],
  });
  assert.equal(t.translate('3 files changed'), '3 个文件已更改');
  assert.equal(t.translate('1 file changed'), '1 个文件已更改');
  assert.equal(t.translate('No agents running'), '无代理正在运行');
  assert.equal(t.translate('Updated 5m ago'), '5 分钟前更新');
});

test('unknown text returns unchanged and triggers onMissing once per unique string', () => {
  const missed = [];
  const t = createTranslator({
    exactMap: { Settings: '设置' },
    patterns: [],
    onMissing: (s) => missed.push(s),
  });
  assert.equal(t.translate('Brand New Feature'), 'Brand New Feature');
  assert.equal(t.translate('Brand New Feature'), 'Brand New Feature');
  assert.deepEqual(missed, ['Brand New Feature']);
  assert.equal(t.stats().misses, 2);
});

test('non-english, numbers, paths, URLs, and long text skip onMissing', () => {
  const missed = [];
  const t = createTranslator({
    exactMap: {},
    patterns: [],
    onMissing: (s) => missed.push(s),
  });
  for (const s of [
    '',
    '   ',
    '12345',
    'v44.9.1',
    'C:\\Users\\demo\\file.txt',
    '/usr/local/bin/node',
    'https://antigravity.google/docs',
    '已经是中文了',
    'A'.repeat(200),
  ]) {
    assert.equal(t.translate(s), s);
  }
  assert.deepEqual(missed, []);
});

test('loadTranslatorFromDir loads dict files and falls back safely when missing', () => {
  const missingDir = path.join(os.tmpdir(), `nonexistent-i18n-${Date.now()}`);
  const fallback = loadTranslatorFromDir(missingDir);
  assert.equal(fallback.translate('Settings'), 'Settings');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-dict-'));
  fs.mkdirSync(path.join(tmpDir, 'dict'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'dict', 'zh-CN.json'), JSON.stringify({ Projects: '项目' }));
  fs.writeFileSync(
    path.join(tmpDir, 'dict', 'patterns.json'),
    JSON.stringify([{ pattern: '^(\\d+) tasks?$', replace: '$1 个任务' }])
  );
  const loaded = loadTranslatorFromDir(tmpDir);
  assert.equal(loaded.translate('Projects'), '项目');
  assert.equal(loaded.translate('4 tasks'), '4 个任务');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
