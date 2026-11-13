'use strict';

const { createTranslator, shouldSkipText } = require('./translator');

const DEFAULT_IGNORED_SELECTOR = [
  'pre',
  'code',
  'kbd',
  'samp',
  'script',
  'style',
  'noscript',
  'svg',
  'textarea',
  '[contenteditable="true"]',
  '.monaco-editor',
  '.cm-editor',
  '.xterm',
  '.prose',
  '.notebook-code-input',
  '.notebook-code-outputs',
  '[data-message-author-role]',
  '[data-testid="message-content"]',
].join(', ');

const UI_COLLECT_SELECTOR = 'button, label, h1, h2, h3, h4, h5, h6, [role="menuitem"], [role="tab"], [role="option"], [role="dialog"] header, nav, aside, summary';
const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

function createDomTranslator(doc, win, translator, options = {}) {
  const ignoredSelector = options.ignoredSelector || DEFAULT_IGNORED_SELECTOR;
  const textState = new WeakMap();
  const attrState = new WeakMap();
  const TEXT_NODE = (win.Node && win.Node.TEXT_NODE) || 3;
  const ELEMENT_NODE = (win.Node && win.Node.ELEMENT_NODE) || 1;
  const SHOW_TEXT = (win.NodeFilter && win.NodeFilter.SHOW_TEXT) || 4;
  const SHOW_ELEMENT = (win.NodeFilter && win.NodeFilter.SHOW_ELEMENT) || 1;

  let observer = null;
  let scheduled = false;
  const pendingRoots = new Set();

  function isIgnoredElement(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) return false;
    try {
      return typeof el.closest === 'function' && Boolean(el.closest(ignoredSelector));
    } catch {
      return false;
    }
  }

  function isCollectibleUiElement(el) {
    if (!el || typeof el.closest !== 'function') return false;
    try {
      return Boolean(el.closest(UI_COLLECT_SELECTOR));
    } catch {
      return false;
    }
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== TEXT_NODE) return;
    const parent = node.parentElement || node.parentNode;
    if (isIgnoredElement(parent)) return;

    const current = node.nodeValue;
    if (typeof current !== 'string' || !current.trim()) return;

    const prev = textState.get(node);
    if (prev && current === prev.zh) return;

    const collect = isCollectibleUiElement(parent);
    const next = translator.translate(current, { collect });
    if (next !== current) {
      textState.set(node, { raw: current, zh: next });
      node.nodeValue = next;
    }
  }

  function translateElementAttrs(el) {
    if (!el || el.nodeType !== ELEMENT_NODE || isIgnoredElement(el)) return;
    let map = attrState.get(el);
    if (!map) {
      map = Object.create(null);
      attrState.set(el, map);
    }

    const attrsToCheck = TRANSLATABLE_ATTRS.slice();
    if (el.tagName === 'INPUT') {
      const inputType = (el.getAttribute('type') || '').toLowerCase();
      if (inputType === 'button' || inputType === 'submit' || inputType === 'reset') {
        attrsToCheck.push('value');
      }
    }

    for (const attr of attrsToCheck) {
      const cur = el.getAttribute(attr);
      if (typeof cur !== 'string' || !cur.trim()) continue;
      if (map[attr] && cur === map[attr]) continue;
      const next = translator.translate(cur, { collect: true });
      if (next !== cur) {
        map[attr] = next;
        el.setAttribute(attr, next);
      }
    }
  }

  function scan(root) {
    const target = root || doc.body || doc.documentElement;
    if (!target) return;

    if (target.nodeType === TEXT_NODE) {
      translateTextNode(target);
      return;
    }

    if (target.nodeType === ELEMENT_NODE) {
      if (isIgnoredElement(target)) return;
      translateElementAttrs(target);
    }

    const textWalker = doc.createTreeWalker(target, SHOW_TEXT);
    let tNode;
    while ((tNode = textWalker.nextNode())) {
      translateTextNode(tNode);
    }

    const elWalker = doc.createTreeWalker(target, SHOW_ELEMENT);
    let elNode;
    while ((elNode = elWalker.nextNode())) {
      translateElementAttrs(elNode);
    }
  }

  function flushPending() {
    scheduled = false;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    for (const root of roots) {
      scan(root);
    }
  }

  function scheduleScan(root) {
    if (!root) return;
    pendingRoots.add(root);
    if (scheduled) return;
    scheduled = true;
    const raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame : (fn) => win.setTimeout(fn, 16);
    raf(flushPending);
  }

  function observe() {
    const root = doc.body || doc.documentElement;
    if (!root) return;
    scan(root);
    if (observer || typeof win.MutationObserver !== 'function') return;
    observer = new win.MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'characterData') {
          translateTextNode(rec.target);
        } else if (rec.type === 'attributes') {
          translateElementAttrs(rec.target);
        } else if (rec.addedNodes && rec.addedNodes.length > 0) {
          for (let i = 0; i < rec.addedNodes.length; i += 1) {
            scheduleScan(rec.addedNodes[i]);
          }
        } else if (rec.target) {
          scheduleScan(rec.target);
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label', 'alt', 'value'],
    });
  }

  function disconnect() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    pendingRoots.clear();
  }

  return { scan, observe, disconnect };
}

function buildInjectionScript(payload = {}) {
  const exactMap = payload.exactMap || {};
  const patterns = payload.patterns || [];
  const collectMissing = Boolean(payload.collectMissing);

  // Pull compilePatterns helper via regex-safe inline definition sharing translator.js functions
  return `(function(){
  if (window.__AGY_I18N_INSTALLED__) return;
  window.__AGY_I18N_INSTALLED__ = true;

  var DEFAULT_IGNORED_SELECTOR = ${JSON.stringify(DEFAULT_IGNORED_SELECTOR)};
  var UI_COLLECT_SELECTOR = ${JSON.stringify(UI_COLLECT_SELECTOR)};
  var TRANSLATABLE_ATTRS = ${JSON.stringify(TRANSLATABLE_ATTRS)};
  var EXACT_MAP = ${JSON.stringify(exactMap)};
  var PATTERNS = ${JSON.stringify(patterns)};
  var COLLECT_MISSING = ${JSON.stringify(collectMissing)};

  ${shouldSkipText.toString()}
  function compilePatterns(patterns) {
    var compiled = [];
    if (!Array.isArray(patterns)) return compiled;
    for (var i = 0; i < patterns.length; i++) {
      var item = patterns[i];
      if (!item || typeof item.pattern !== 'string' || typeof item.replace !== 'string') continue;
      try {
        compiled.push({ regex: new RegExp(item.pattern, item.flags || ''), replace: item.replace });
      } catch (e) {}
    }
    return compiled;
  }
  ${createTranslator.toString()}
  ${createDomTranslator.toString()}

  var missingQueue = [];
  var flushTimer = null;
  function queueMissing(text) {
    if (!COLLECT_MISSING) return;
    missingQueue.push(text);
    if (!flushTimer) {
      flushTimer = setTimeout(function() {
        flushTimer = null;
        if (missingQueue.length > 0) {
          var batch = missingQueue.splice(0, missingQueue.length);
          try { console.debug('__AGY_I18N_MISSING__:' + JSON.stringify(batch)); } catch (e) {}
        }
      }, 2000);
    }
  }

  var translator = createTranslator({
    exactMap: EXACT_MAP,
    patterns: PATTERNS,
    onMissing: COLLECT_MISSING ? queueMissing : null
  });

  var domTranslator = createDomTranslator(document, window, translator);
  function start() {
    if (document.body || document.documentElement) {
      domTranslator.observe();
    } else if (typeof window.addEventListener === 'function') {
      window.addEventListener('DOMContentLoaded', function() { domTranslator.observe(); }, { once: true });
    }
  }
  start();
})();`;
}

module.exports = {
  DEFAULT_IGNORED_SELECTOR,
  createDomTranslator,
  buildInjectionScript,
};
