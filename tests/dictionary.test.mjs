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

  // Regression: slash command descriptions, Settings copy, sidebar & chat placeholder reported missing
  for (const key of [
    'Application',
    'Models',
    'Show All',
    'Not in Project',
    'Give Feedback',
    'Configure agent execution, queued message delivery, and permissions.',
    'Knowledge Work',
    'Simplified interface for research, writing, and everyday tasks.',
    'Software Engineering',
    'Full interface for coding, developer tools, and managing agents.',
    'Global Permissions',
    'Configure global allowed and denied resource permissions.',
    'Controls the actions the agent can take.',
    'Modify permissions for file, terminal, and MCP tools.',
    'Configure allowed and denied URLs for reading.',
    'Modified in',
    'and select',
    'to have the agent generate a plan.',
    'Execution',
    'Configure when follow-up messages are sent.',
    'Keyboard shortcuts',
    'Queue',
    'Send Immediately',
    'Ask anything, @ to mention, / for actions',
    'Run until the specified goal is completely finished.',
    'Compact the conversation now (summarize history to free up the context window).',
    'Run an instruction on a recurring schedule or as a one-time timer.',
    'Invoke a browser agent for web tasks.',
    'Plan carefully before executing a task.',
    'Interview me to align on a plan.',
    'Invoke a team of agents to autonomously tackle large projects.',
    'Reflect on recent successes or corrections to capture reusable skills or rules.',
    'Invoke the Boost multi-agent orchestrator for complex tasks.',
  ]) {
    const out = t.translate(key);
    assert.notEqual(out, key, `Expected translation for newly added string: ${key}`);
  }

  assert.equal(t.translate('Select model, current: Gemini 4 Argon'), '选择模型，当前：Gemini 4 Argon');
  assert.equal(t.translate('Turn 2 of 9'), '第 2 / 9 轮');
  assert.equal(t.translate('Load older messages, showing 50 of 294'), '加载更早消息（当前显示 50 / 294）');
  assert.equal(t.translate('Rules: 777 tokens'), '规则：777 tokens');
  assert.equal(t.translate('Skills: 2,401 tokens'), '技能：2,401 tokens');
  assert.equal(t.translate('Mcp Tools: 243 tokens'), 'MCP 工具：243 tokens');
  assert.equal(t.translate('Show 21 breakdowns'), '显示 21 项明细');
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
