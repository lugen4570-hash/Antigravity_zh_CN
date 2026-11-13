'use strict';

const fs = require('fs');
const path = require('path');

function shouldSkipText(trimmed) {
  if (!trimmed || trimmed.length > 180) return true;
  if (!/[A-Za-z]/.test(trimmed)) return true;
  if (/[\u4e00-\u9fff]/.test(trimmed)) return true;
  if (/^(https?|wss?|file|plugin|agy-[a-z-]+):\/\//i.test(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (/^(\/[\w.-]+){2,}/.test(trimmed) || /^[\w.-]+\\[\w.-]+/.test(trimmed)) return true;
  if (/^v?\d+(?:\.\d+)+(?:-[\w.-]+)?$/i.test(trimmed)) return true;
  return false;
}

function compilePatterns(patterns) {
  const compiled = [];
  if (!Array.isArray(patterns)) return compiled;
  for (const item of patterns) {
    if (!item || typeof item.pattern !== 'string') continue;
    if (typeof item.replace !== 'string' && typeof item.replace !== 'function') continue;
    try {
      const regex = new RegExp(item.pattern, item.flags || '');
      compiled.push({ regex, replace: item.replace });
    } catch {
      // Ignore malformed pattern entries so user dictionary edits cannot crash app
    }
  }
  return compiled;
}

function createTranslator(options = {}) {
  const exactMap = new Map();
  const rawExact = options.exactMap || {};
  for (const [k, v] of Object.entries(rawExact)) {
    if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
      exactMap.set(k, v);
    }
  }

  const compiledPatterns = compilePatterns(options.patterns);
  const onMissing = typeof options.onMissing === 'function' ? options.onMissing : null;
  const reportedMissing = new Set();
  const counters = { hits: 0, misses: 0 };

  function hasExact(text) {
    if (typeof text !== 'string') return false;
    return exactMap.has(text.trim());
  }

  function translate(text, opts) {
    if (typeof text !== 'string' || !text) return text;
    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const leading = match ? match[1] : '';
    const core = match ? match[2] : text;
    const trailing = match ? match[3] : '';

    if (shouldSkipText(core)) {
      return text;
    }

    const exactHit = exactMap.get(core);
    if (exactHit !== undefined) {
      counters.hits += 1;
      return `${leading}${exactHit}${trailing}`;
    }

    for (const rule of compiledPatterns) {
      if (rule.regex.test(core)) {
        const replaced = core.replace(rule.regex, rule.replace);
        if (replaced !== core) {
          counters.hits += 1;
          return `${leading}${replaced}${trailing}`;
        }
      }
    }

    counters.misses += 1;
    const allowCollect = !opts || opts.collect !== false;
    if (onMissing && allowCollect && core.length >= 2 && !reportedMissing.has(core)) {
      reportedMissing.add(core);
      try {
        onMissing(core);
      } catch {
        // Ignore collector callback errors
      }
    }
    return text;
  }

  return {
    translate,
    hasExact,
    stats: () => ({ ...counters }),
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadTranslatorFromDir(baseDir, options = {}) {
  const exactMap = readJsonSafe(path.join(baseDir, 'dict', 'zh-CN.json'), {});
  const patterns = readJsonSafe(path.join(baseDir, 'dict', 'patterns.json'), []);
  return createTranslator({
    exactMap,
    patterns,
    onMissing: options.onMissing,
  });
}

module.exports = {
  createTranslator,
  loadTranslatorFromDir,
  shouldSkipText,
};
