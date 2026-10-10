/**
 * test/mini-dom.js — 极简 DOM 替身
 *
 * 只实现插件用到的那部分 API（createElement / classList / style / dataset /
 * 属性 / 增删查 / getBoundingClientRect / 事件派发），不追求完整。
 * 目的是让渲染与配色逻辑能在 Node 里被真的跑一遍。
 */

class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  add(...names) {
    names.filter(Boolean).forEach((n) => this.set.add(n));
    this.sync();
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(n));
    this.sync();
  }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : !!force;
    if (want) this.set.add(name);
    else this.set.delete(name);
    this.sync();
    return want;
  }
  contains(name) {
    return this.set.has(name);
  }
  sync() {
    this.el._className = [...this.set].join(' ');
  }
}

export class MiniElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.style = new Proxy(
      { _props: {} },
      {
        get: (t, k) => (k === '_props' ? t._props : t._props[k] ?? ''),
        set: (t, k, v) => {
          t._props[k] = v;
          return true;
        },
      },
    );
    this.style.setProperty = (k, v) => {
      this.style[k] = v;
    };
    this.style.getPropertyValue = (k) => String(this.style[k] ?? '');
    this.dataset = {};
    this._className = '';
    this.classList = new ClassList(this);
    this._text = '';
    this._listeners = new Map();
    this._rect = { left: 0, top: 0, width: 640, height: 160, right: 640, bottom: 160 };
  }

  get className() {
    return this._className;
  }
  set className(v) {
    this._className = String(v || '');
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v ?? '');
  }

  set innerHTML(v) {
    this.children = [];
    this._text = String(v ?? '');
  }
  get innerHTML() {
    return this._text;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this._id = String(v);
    if (k.startsWith('data-')) {
      const key = k
        .slice(5)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'id') this._id = '';
  }

  /** 和浏览器一样：el.id = 'x' 等价于 setAttribute('id', 'x') */
  get id() {
    return this.attributes.id ?? '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }

  appendChild(node) {
    if (!node) return node;
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  insertAdjacentElement(position, node) {
    const parent = this.parentElement;
    if (!parent) return null;
    const idx = parent.children.indexOf(this);
    if (position === 'afterend') parent.children.splice(idx + 1, 0, node);
    else parent.children.splice(idx, 0, node);
    node.parentElement = parent;
    return node;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const idx = parent.children.indexOf(this);
    if (idx >= 0) parent.children.splice(idx, 1);
    this.parentElement = null;
  }

  get clientWidth() {
    return this._rect.width;
  }
  get clientHeight() {
    return this._rect.height;
  }
  get offsetWidth() {
    return this._rect.width;
  }
  get offsetHeight() {
    return this._rect.height;
  }
  get offsetLeft() {
    return this._rect.left;
  }
  get offsetTop() {
    return this._rect.top;
  }
  getBoundingClientRect() {
    return { ...this._rect };
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatch(type, ev = {}) {
    const e = { type, target: this, stopPropagation() {}, preventDefault() {}, ...ev };
    for (const fn of this._listeners.get(type) || []) fn(e);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  /** 供测试断言：把整棵树的标签列出来 */
  dump(indent = 0) {
    const pad = '  '.repeat(indent);
    const lines = [`${pad}<${this.tagName.toLowerCase()} class="${this.className}">${this.children.length ? '' : this.textContent}`];
    for (const c of this.children) lines.push(c.dump(indent + 1));
    return lines.join('\n');
  }
}

function matches(el, selector) {
  const sel = String(selector || '').trim();
  if (!sel) return false;
  const groups = splitTopLevel(sel, ',');
  return groups.some((g) => matchComplex(el, g.trim()));
}

/** 按分隔符切分，尊重引号（"a[data-x=\"1 2\"]" 不会被空格切开） */
function splitTopLevel(str, sep) {
  const out = [];
  let cur = '';
  let quote = '';
  for (const ch of str) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 后代选择器：后面每一段都要能在前一段的祖先链里找到 */
function matchComplex(el, group) {
  const parts = splitTopLevel(group, ' ').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  if (!matchOne(el, parts[parts.length - 1])) return false;
  let node = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (node) {
      if (matchOne(node, parts[i])) {
        found = true;
        node = node.parentElement;
        break;
      }
      node = node.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

function matchOne(el, partIn) {
  // 去掉伪类（:hover / :active 等），测试替身不需要实现它们
  const part = String(partIn).replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
  if (!part) return true;

  // [#]id
  const idMatch = /#([\w-]+)/.exec(part);
  if (idMatch && el.getAttribute('id') !== idMatch[1]) return false;

  // [attr] / [attr="v"]
  const attrRe = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]"']*)))?\]/g;
  let m;
  while ((m = attrRe.exec(part))) {
    const v = el.getAttribute(m[1]);
    if (v === null) return false;
    const want = m[2] ?? m[3] ?? m[4];
    if (want !== undefined && v !== want) return false;
  }

  // tag（注意：".std-frame" 里的 std-frame 不是标签名，不能被当成 tag 匹配）
  const tag = /^([a-zA-Z][\w-]*)/.exec(part.replace(/\.[\w-]+/g, ''));
  if (tag && tag[1] !== '*' && el.tagName !== tag[1].toUpperCase()) return false;

  // .class
  const classes = [...part.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  for (const c of classes) {
    if (!el.classList.contains(c)) return false;
  }
  return true;
}

export function createMiniDocument() {
  const doc = {
    body: null,
    documentElement: null,
    head: null,
    readyState: 'complete',
    _byId: new Map(),
    _listeners: new Map(),
    createElement(tag) {
      return new MiniElement(tag, doc);
    },
    getElementById(id) {
      return doc._byId.get(id) || null;
    },
    querySelector(sel) {
      return doc.body.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
    elementFromPoint() {
      return doc.body;
    },
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) doc._listeners.set(type, new Set());
      doc._listeners.get(type).add(fn);
    },
    defaultView: null,
  };
  doc.body = new MiniElement('body', doc);
  doc.documentElement = new MiniElement('html', doc);
  doc.head = new MiniElement('head', doc);

  // 让 appendChild 到 body 的带 id 元素能被 getElementById 找到
  const origAppend = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = (node) => {
    const out = origAppend(node);
    if (node?.getAttribute?.('id')) doc._byId.set(node.getAttribute('id'), node);
    return out;
  };

  doc.defaultView = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: makeMemoryStorage(),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(255,255,255)' }),
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView.document = doc;

  return doc;
}

export function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    _map: map,
  };
}
