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
    get nextSibling() {
      if (!this.parentNode || !Array.isArray(this.parentNode.childNodes)) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode.childNodes.length
        ? this.parentNode.childNodes[idx + 1]
        : null;
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
            if (k.endsWith('*')) {
              const attrName = k.slice(0, -1);
              const val = this.getAttribute(attrName);
              if (typeof val === 'string' && val.includes(v)) return true;
            } else if (this.getAttribute(k) === v) {
              return true;
            }
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
    createTreeWalker(root, whatToShow, filter) {
      const flat = [];
      const FILTER_ACCEPT = 1;
      const FILTER_REJECT = 2;
      const FILTER_SKIP = 3;
      function walk(node) {
        for (const c of node.childNodes || []) {
          const matchesMask =
            (c.nodeType === 1 && (whatToShow & 1)) ||
            (c.nodeType === 3 && (whatToShow & 4));
          let decision = matchesMask ? FILTER_ACCEPT : FILTER_SKIP;
          if (matchesMask && filter && typeof filter.acceptNode === 'function') {
            decision = filter.acceptNode(c);
          }
          if (decision === FILTER_REJECT) continue;
          if (decision === FILTER_ACCEPT) flat.push(c);
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
    NodeFilter: {
      SHOW_TEXT: 4,
      SHOW_ELEMENT: 1,
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
      FILTER_SKIP: 3,
    },
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
    new MockElement('div', { class: 'agy-user-bubble' }),
    new MockElement('div', { 'data-testid': 'user-message-content' }),
    new MockElement('div', { 'data-testid': 'user-message-bubble' }),
  ];

  const nodes = containers.map((el) => {
    const inner = new MockElement('span');
    const t = new MockText('Settings');
    inner.appendChild(t);
    el.appendChild(inner);
    doc.body.appendChild(el);
    return t;
  });

  let translateCalls = 0;
  const baseTranslator = createTranslator({ exactMap: { Settings: '设置' }, patterns: [] });
  const countingTranslator = {
    translate(text, opts) {
      translateCalls += 1;
      return baseTranslator.translate(text, opts);
    },
  };
  const domTranslator = createDomTranslator(doc, win, countingTranslator);
  domTranslator.scan(doc.body);

  for (const t of nodes) {
    assert.equal(t.nodeValue, 'Settings');
  }
  assert.equal(translateCalls, 0, 'Ignored subtrees must be pruned before translate() is called');
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

test('disambiguates inline "Type" before <code>/<kbd> while keeping standalone "Type" and sibling <p> placeholder working', () => {
  const { MockText, MockElement, doc, win } = createMockDom();

  const inlineWrap = new MockElement('span');
  const typeLead = new MockText('Type ');
  const slashCode = new MockElement('code');
  slashCode.appendChild(new MockText('/'));
  const middleTxt = new MockText(' and select ');
  const planCode = new MockElement('code');
  planCode.appendChild(new MockText('plan'));
  const tailTxt = new MockText(' to have the agent generate a plan.');
  inlineWrap.appendChild(typeLead);
  inlineWrap.appendChild(slashCode);
  inlineWrap.appendChild(middleTxt);
  inlineWrap.appendChild(planCode);
  inlineWrap.appendChild(tailTxt);

  const labelCell = new MockElement('span');
  const typeLabel = new MockText('Type');
  labelCell.appendChild(typeLabel);

  const composerWrap = new MockElement('div', { class: 'relative w-full' });
  const placeholderP = new MockElement('p', { class: 'pointer-events-none' });
  const placeholderTxt = new MockText('Ask anything, @ to mention, / for actions');
  placeholderP.appendChild(placeholderTxt);
  const editorDiv = new MockElement('div', { contenteditable: 'true' });
  const userDraft = new MockText('and select');
  editorDiv.appendChild(userDraft);
  composerWrap.appendChild(placeholderP);
  composerWrap.appendChild(editorDiv);

  doc.body.appendChild(inlineWrap);
  doc.body.appendChild(labelCell);
  doc.body.appendChild(composerWrap);

  const translator = createTranslator({
    exactMap: {
      Type: '类型',
      'and select': '并选择',
      'to have the agent generate a plan.': '即可让代理生成计划。',
      'Ask anything, @ to mention, / for actions': '随意提问，输入 @ 引用内容，输入 / 调用操作',
    },
    patterns: [],
  });
  const domTranslator = createDomTranslator(doc, win, translator);
  domTranslator.scan(doc.body);

  assert.equal(typeLead.nodeValue, '输入 ');
  assert.equal(middleTxt.nodeValue, ' 并选择 ');
  assert.equal(tailTxt.nodeValue, ' 即可让代理生成计划。');
  assert.equal(slashCode.childNodes[0].nodeValue, '/');
  assert.equal(planCode.childNodes[0].nodeValue, 'plan');
  assert.equal(typeLabel.nodeValue, '类型');
  assert.equal(placeholderTxt.nodeValue, '随意提问，输入 @ 引用内容，输入 / 调用操作');
  assert.equal(userDraft.nodeValue, 'and select');
});
