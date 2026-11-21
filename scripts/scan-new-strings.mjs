import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  extractAllUiStrings,
  resolveDefaultResourceBase,
  resolveLanguageServerPath,
} from './extract-ui-strings.mjs';

const require = createRequire(import.meta.url);
const { createTranslator } = require('../runtime/translator.js');

export function scanNewStrings({ candidates, exactMap = {}, patterns = [], outputPath }) {
  const translator = createTranslator({ exactMap, patterns });
  const unseen = [];
  const seen = new Set();

  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const out = translator.translate(s, { collect: false });
    if (out === s) {
      unseen.push(s);
    }
  }

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(unseen, null, 2), 'utf8');
  }
  return unseen;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const baseDir = process.argv[2] || path.join(os.homedir(), '.antigravity-i18n');
  const resBase = process.argv[3] || resolveDefaultResourceBase();
  const asarPath = path.join(resBase, 'app.asar');
  const lsPath = resolveLanguageServerPath(resBase);

  let exactMap = {};
  let patterns = [];
  try {
    exactMap = JSON.parse(fs.readFileSync(path.join(baseDir, 'dict', 'zh-CN.json'), 'utf8'));
  } catch {}
  try {
    patterns = JSON.parse(fs.readFileSync(path.join(baseDir, 'dict', 'patterns.json'), 'utf8'));
  } catch {}

  const extracted = extractAllUiStrings(asarPath, lsPath);
  const outputPath = path.join(baseDir, 'logs', 'new-strings-pending.json');
  const unseen = scanNewStrings({
    candidates: extracted.combined,
    exactMap,
    patterns,
    outputPath,
  });
  console.log(JSON.stringify({ totalCandidates: extracted.combined.length, unseenCount: unseen.length, outputPath }));
}
