import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTranslator } = require('../runtime/translator.js');
const { createDomTranslator, buildInjectionScript } = require('../runtime/domTranslator.js');

function createMockDom() {
  class MockNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.parentElement = null;
    }
  }

  class MockText extends MockNode {
    constructor(value) {
      super(3);
      this.nodeValue = value;
    }
  }

  class MockElement extends MockNode {
    constructor(tagName, attrs = {}) {
      super(1);
      this.tagName = tagName.toUpperCase();
      this._attrs = { ...attrs };
      this.childNodes = [];
    }
    get className() {
      return this._attrs.class || '';
    }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    }
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    }
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name);
    }
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      this.childNodes.push(child);
      return child;
    }
    matches(selectorList) {
      const selectors = selectorList.split(',').map((s) => s.trim()).filter(Boolean);
      for (const sel of selectors) {
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          if (this.className.split(/\s+/).includes(cls)) return true;
        } else if (sel.startsWith('[') && sel.endsWith(']')) {
          const inner = sel.slice(1, -1);
          const eqIdx = inner.indexOf('=');
          if (eqIdx === -1) {
            if (this.hasAttribute(inner)) return true;
          } else {
            const k = inner.slice(0, eqIdx).trim();
            const v = inner.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (this.getAttribute(k) === v) return true;
          }
        } else if (this.tagName === sel.toUpperCase()) {
          return true;
        }
      }
      return false;
    }
    closest(selectorList) {
      let cur = this;
      while (cur) {
        if (cur.nodeType === 1 && cur.matches(selectorList)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
  }

  const observers = [];
  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
    trigger(records) {
      this.cb(records);
    }
  }

  const body = new MockElement('body');
  const doc = {
    body,
    documentElement: body,
    createTreeWalker(root, whatToShow) {
      const flat = [];
      function walk(node) {
        for (const c of node.childNodes || []) {
          if (whatToShow === 4 && c.nodeType === 3) flat.push(c);
          else if (whatToShow === 1 && c.nodeType === 1) flat.push(c);
          walk(c);
        }
      }
      walk(root);
      let idx = -1;
      return {
        nextNode() {
          idx += 1;
          return idx < flat.length ? flat[idx] : null;
        },
      };
    },
  };

  const win = {
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: MockMutationObserver,
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
  };

  return { MockText, MockElement, doc, win, observers };
}

test('translates UI text nodes in-place without replacing node references', () => {
  const { MockText, MockElement, doc, win } = createMockDom();
  const btn = new MockElement('button');
  const txt = new MockText('Settings');
  btn.appendChild(txt);
  doc.body.appendChild(btn);

  const translator = createTranslator({ exactMap: { Settings: '设置' }, patterns: [] });
  const domTranslator = createDomTranslator(doc, win, translator);
  domTranslator.scan(doc.body);

  assert.equal(btn.childNodes[0], txt);
  assert.equal(txt.nodeValue, '设置');

  // Re-scan is idempotent
  domTranslator.scan(doc.body);
  assert.equal(txt.nodeValue, '设置');
});

test('retranslates cleanly when React updates text node to new English label', () => {
  const { MockText, MockElement, doc, win, observers } = createMockDom();
  const span = new MockElement('span');
  const txt = new MockText('Settings');
  span.appendChild(txt);
  doc.body.appendChild(span);

  const translator = createTranslator({
    exactMap: { Settings: '设置', 'New Conversation': '新建对话' },
    patterns: [],
  });
  const domTranslator = createDomTranslator(doc, win, translator);
  domTranslator.observe();

  assert.equal(txt.nodeValue, '设置');

  // Simulate React updating the same Text node
  txt.nodeValue = 'New Conversation';
  observers[0].trigger([{ type: 'characterData', target: txt }]);
  assert.equal(txt.nodeValue, '新建对话');
});

test('skips code blocks, editors, terminal, inputs, and chat prose containers', () => {
  const { MockText, MockElement, doc, win } = createMockDom();
  const containers = [
    new MockElement('code'),
    new MockElement('pre'),
    new MockElement('div', { class: 'monaco-editor' }),
    new MockElement('div', { class: 'xterm' }),
    new MockElement('textarea'),
    new MockElement('div', { contenteditable: 'true' }),
    new MockElement('div', { 'data-message-author-role': 'assistant' }),
    new MockElement('div', { class: 'prose' }),
  ];

  const nodes = containers.map((el) => {
    const inner = new MockElement('span');
    const t = new MockText('Settings');
    inner.appendChild(t);
    el.appendChild(inner);
    doc.body.appendChild(el);
    return t;
  });

  const translator = createTranslator({ exactMap: { Settings: '设置' }, patterns: [] });
  const domTranslator = createDomTranslator(doc, win, translator);
  domTranslator.scan(doc.body);

  for (const t of nodes) {
    assert.equal(t.nodeValue, 'Settings');
  }
});

test('translates allowed UI attributes while leaving text input values untouched', () => {
  const { MockElement, doc, win } = createMockDom();
  const searchInput = new MockElement('input', {
    type: 'text',
    placeholder: 'Search projects...',
    value: 'Settings',
  });
  const submitBtn = new MockElement('input', {
    type: 'submit',
    value: 'Cancel',
  });
  const iconBtn = new MockElement('button', {
    title: 'New Conversation',
    'aria-label': 'Close',
  });
  doc.body.appendChild(searchInput);
  doc.body.appendChild(submitBtn);
  doc.body.appendChild(iconBtn);

  const translator = createTranslator({
    exactMap: {
      'Search projects...': '搜索项目...',
      Settings: '设置',
      Cancel: '取消',
      'New Conversation': '新建对话',
      Close: '关闭',
    },
    patterns: [],
  });
  const domTranslator = createDomTranslator(doc, win, translator);
  domTranslator.scan(doc.body);

  assert.equal(searchInput.getAttribute('placeholder'), '搜索项目...');
  assert.equal(searchInput.getAttribute('value'), 'Settings');
  assert.equal(submitBtn.getAttribute('value'), '取消');
  assert.equal(iconBtn.getAttribute('title'), '新建对话');
  assert.equal(iconBtn.getAttribute('aria-label'), '关闭');
});

test('buildInjectionScript executes cleanly in isolated VM context and is idempotent', () => {
  const { MockText, MockElement, doc, win } = createMockDom();
  const el = new MockElement('button');
  const txt = new MockText('Settings');
  el.appendChild(txt);
  doc.body.appendChild(el);

  const script = buildInjectionScript({
    exactMap: { Settings: '设置' },
    patterns: [{ pattern: '^(\\d+) tasks?$', replace: '$1 个任务' }],
    collectMissing: false,
  });

  const sandbox = {
    window: win,
    document: doc,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    MutationObserver: win.MutationObserver,
    requestAnimationFrame: win.requestAnimationFrame,
    setTimeout: win.setTimeout,
    console,
  };
  win.window = win;
  win.document = doc;

  vm.runInNewContext(script, sandbox);
  assert.equal(txt.nodeValue, '设置');
  assert.equal(win.__AGY_I18N_INSTALLED__, true);

  // Running twice does not crash or re-install
  vm.runInNewContext(script, sandbox);
  assert.equal(txt.nodeValue, '设置');
});
