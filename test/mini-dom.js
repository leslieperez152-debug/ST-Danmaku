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
    // 默认"有布局"：显式 _rect 优先；没有则按父元素宽度自动排布（见 _computedRect）
    this._rect = null;
    this._autoLayout = true;
    this._autoWidth = 640;
    this._autoHeight = 160;
  }

  get className() {
    return this._className;
  }
  set className(v) {
    this._className = String(v || '');
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
    this.attributes.class = this._className;
  }

  /**
   * 文本/HTML 的存储约定（必须和真实 DOM 一致，否则会出现"文本莫名消失"的假故障）：
   *   · 元素自己那段文本放在 _text；
   *   · 有子节点时，textContent = 自己那段 + 所有子节点的 textContent；
   *   · innerHTML 由子树重新生成。
   */
  get textContent() {
    if (!this.children.length) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v ?? '');
  }

  set innerHTML(v) {
    this.children = [];
    this._text = '';
    const html = String(v ?? '');
    if (!html.trim()) {
      this._text = html;
      return;
    }
    // 真正解析，让用 innerHTML 构建的 UI 在自检里也能被查询与断言
    parseHtmlInto(this, html);
  }
  get innerHTML() {
    return this._text + this.children.map((c) => serializeNode(c)).join('');
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this._id = String(v);
    // class 属性与 classList 必须同步（真实 DOM 就是这样，缺了它解析出的节点查不到类）
    if (k === 'class') {
      this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
      this._className = [...this.classList.set].join(' ');
    }
    // 布尔属性：浏览器里"有该属性"就等于 true，缺了它"取消勾选"这类判断会读错
    if (k === 'checked') this._checked = true;
    if (k === 'value') this._value = String(v);
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
    if (k === 'checked') this._checked = false;
  }

  /** 和浏览器一样：el.id = 'x' 等价于 setAttribute('id', 'x') */
  get id() {
    return this.attributes.id ?? '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }

  /** 表单元素的 IDL 属性：type / value / checked 读写都会落到属性上 */
  get type() {
    return this.attributes.type ?? '';
  }
  set type(v) {
    this.setAttribute('type', v);
  }
  get value() {
    return this._value !== undefined ? this._value : this.attributes.value ?? '';
  }
  set value(v) {
    this._value = String(v ?? '');
    this.attributes.value = this._value;
  }
  get checked() {
    return !!this._checked;
  }
  set checked(v) {
    this._checked = !!v;
    if (v) this.attributes.checked = '';
    else delete this.attributes.checked;
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
    // 关键：必须设置 parentElement，否则后续 querySelectorAll / 位置计算全错，
    // 之前这个替身漏了这一步，导致"弹幕框是否挤压正文"的检查形同虚设。
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
    return this._rect ? this._rect.width : this._computedRect().width;
  }
  get clientHeight() {
    return this._rect ? this._rect.height : this._computedRect().height;
  }
  get offsetWidth() {
    return this.clientWidth;
  }
  get offsetHeight() {
    return this.clientHeight;
  }
  get offsetLeft() {
    return this._computedRect().left;
  }
  get offsetTop() {
    return this._computedRect().top;
  }

  getBoundingClientRect() {
    return { ...this._computedRect() };
  }

  /** 深拷贝（playFrame 会给每条弹幕做一份克隆） */
  cloneNode(deep = false) {
    const copy = new MiniElement(this.tagName, this.ownerDocument);
    copy._className = this._className;
    copy.classList.set = new Set(this.classList.set);
    copy._text = this._text;
    copy.attributes = { ...this.attributes };
    copy.dataset = { ...this.dataset };
    copy._autoWidth = this._autoWidth;
    copy._autoHeight = this._autoHeight;
    copy._hostRect = this._hostRect ? { ...this._hostRect } : null;
    copy.style = this.style;
    if (deep) {
      for (const child of this.children) copy.appendChild(child.cloneNode(true));
    }
    return copy;
  }

  /**
   * 计算矩形。没有显式 _rect 时：
   *   · 宽度/横向继承最近的有布局的祖先（浏览器里块级元素就是占满父宽）；
   *   · 纵向从锚点下方开始（insertAdjacentElement('afterend') 的真实效果）。
   * 这样"弹幕框有没有压住消息"才能被真的验证出来。
   */
  _computedRect() {
    if (this._rect) return this._rect;

    // 显式挂载锚点：块级元素插在锚点之后，就从锚点下方开始
    if (this._hostRect) {
      const w = this._autoWidth || this._hostRect.width;
      const h = this._autoHeight || 160;
      return {
        left: this._hostRect.left,
        top: this._hostRect.bottom,
        width: w,
        height: h,
        right: this._hostRect.left + w,
        bottom: this._hostRect.bottom + h,
      };
    }

    let node = this.parentElement;
    while (node) {
      if (node._rect) {
        const w = this._autoWidth || node._rect.width;
        const h = this._autoHeight || 160;
        return { left: node._rect.left, top: node._rect.bottom, width: w, height: h, right: node._rect.left + w, bottom: node._rect.bottom + h };
      }
      node = node.parentElement;
    }
    const root = this.ownerDocument?.defaultView || {};
    const w = this._autoWidth || root.innerWidth || 1280;
    const h = this._autoHeight || root.innerHeight || 800;
    return { left: 0, top: 0, width: w, height: h, right: w, bottom: h };
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
    // 先给本节点，再冒泡给祖先（真实 DOM 的事件流）。
    // 监听器抛错要暴露出来，不能静默吞掉 —— 否则测试会出现"事件没生效"的假象。
    let node = this;
    while (node) {
      for (const fn of node._listeners.get(type) || []) fn(e);
      node = node.parentElement;
    }
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

/**
 * 按分隔符切分，尊重引号**和方括号**。
 *
 * 关键：必须跟踪方括号深度 —— 否则 `select[data-std-path="api.model"]` 会在
 * 引号内的空格处被切断（这个 bug 曾让所有属性选择器在自检里静默失效）。
 */
function splitTopLevel(str, sep) {
  const out = [];
  let cur = '';
  let quote = '';
  let depth = 0;
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
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
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

  // 关键：先把 [ ... ] 里的内容遮掉，再做 tag / class 解析。
  // 否则 `[data-std-path="api.route"]` 里的那个点会被当成类名 `.route`，
  // 导致"元素没有这个类" → 静默不匹配（这个 bug 曾让所有带点的属性选择器失效）。
  const masked = part.replace(/\[[^\]]*\]/g, '');

  // tag（注意：".std-frame" 里的 std-frame 不是标签名，不能被当成 tag 匹配）
  const tag = /^([a-zA-Z][\w-]*)/.exec(masked.replace(/\.[\w-]+/g, ''));
  if (tag && tag[1] !== '*' && el.tagName !== tag[1].toUpperCase()) return false;

  // .class
  const classes = [...masked.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  for (const c of classes) {
    if (!el.classList.contains(c)) return false;
  }
  return true;
}

/** 已创建的迷你文档（真实环境只有一份 document，替身用它来兜底按 id 查找） */
const MINI_DOCUMENTS = [];

/* ───────────── 极简 HTML 解析 ─────────────
   只覆盖插件自己生成的那部分 HTML：
   标签 / 属性（带引号或不带）/ 自闭合 / 文本 / 常见实体。
   目的是让 innerHTML 构建的界面在自检里真的存在，而不是一串死字符串。 */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'track', 'wbr', 'col', 'area', 'base', 'embed', 'param']);

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseHtmlInto(root, html) {
  const doc = root.ownerDocument;
  if (!doc) return;
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      appendText(top(), html.slice(i));
      break;
    }
    if (lt > i) appendText(top(), html.slice(i, lt));

    // 注释
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      appendText(top(), html.slice(lt));
      break;
    }
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tagName === name.toUpperCase()) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([a-zA-Z][\w-]*)/.exec(body);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const el = new MiniElement(tag, doc);
    applyAttrs(el, body.slice(m[1].length));

    top().appendChild(el);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
  }
}

function appendText(el, text) {
  const decoded = decodeEntities(text);
  if (!decoded) return;
  el._text += decoded;
}

/** 把节点序列化回 HTML（innerHTML 的 getter 用） */
function serializeNode(el) {
  const tag = el.tagName.toLowerCase();
  const attrs = Object.keys(el.attributes)
    .map((k) => ` ${k}="${String(el.attributes[k]).replace(/"/g, '&quot;')}"`)
    .join('');
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  const inner = el._text + el.children.map((c) => serializeNode(c)).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** 找到标签的结束 '>'，跳过引号里的内容 */
function findTagEnd(html, from) {
  let quote = '';
  for (let i = from + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function applyAttrs(el, attrStr) {
  const re = /([\w:@-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))|([\w:@-]+)/g;
  let m;
  while ((m = re.exec(attrStr))) {
    if (m[5]) {
      el.setAttribute(m[5], '');
      continue;
    }
    const name = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    el.setAttribute(name, decodeEntities(value));
  }
}

export function createMiniDocument() {
  const doc = {
    body: null,
    documentElement: null,
    head: null,
    readyState: 'complete',
    activeElement: null,
    _byId: new Map(),
    _listeners: new Map(),    createElement(tag) {
      return new MiniElement(tag, doc);
    },
    getElementById(id) {
      // 真实 DOM 里 getElementById 只能找到"还在文档里"的节点。
      // 这里必须做同样的可达性校验，否则被移除的旧节点会被重新拿出来，
      // 造成"事件不生效""状态区不更新"这类假故障。
      const reachable = (el) => {
        if (!el) return false;
        if (el.ownerDocument !== doc) return false;
        let node = el;
        while (node) {
          if (node === doc.body) return true;
          node = node.parentElement;
        }
        return false;
      };
      const own = doc._byId.get(id);
      if (reachable(own)) return own;
      for (const other of MINI_DOCUMENTS) {
        if (other !== doc) continue;
        const hit = other._byId.get(id);
        if (reachable(hit)) return hit;
      }
      return null;
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
  doc.body._rect = { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 };
  doc.documentElement = new MiniElement('html', doc);
  doc.head = new MiniElement('head', doc);
  // 对话区：铺满视口的块级容器，插件定位 / 挂载都要用到
  doc._chat = new MiniElement('div', doc);
  doc._chat.className = 'chat';
  doc._chat.setAttribute('id', 'chat');

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
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    },
    /** 测试专用：派发 window 级事件 */
    __emit(type, ev = {}) {
      const e = { type, stopPropagation() {}, preventDefault() {}, ...ev };
      for (const fn of this._listeners.get(type) || []) fn(e);
    },
  };
  doc.defaultView.document = doc;

  MINI_DOCUMENTS.push(doc);
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
