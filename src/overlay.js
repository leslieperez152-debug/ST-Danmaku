/**
 * overlay.js — 悬浮弹幕层
 *
 * 一个浮在整个界面上的弹幕层：可拖动、右下角可拉伸缩放，位置和大小会被记住。
 *
 * 交互约定（避免挡住你正常操作）：
 *   · 平时整个层 pointer-events: none，弹幕从上面飞过但鼠标可以穿透，不影响滚动和点击；
 *   · 鼠标移进来时才接管指针 —— 这时可以拖动、可以拉伸；
 *   · 鼠标离开就恢复穿透。
 */

export const OVERLAY_ID = 'std-overlay';

const MIN_W = 240;
const MIN_H = 80;

/** 拿到（或创建）悬浮层的根节点 */
export function ensureOverlay(doc) {
  let root = doc.getElementById(OVERLAY_ID);
  // 必须是本文档里的那个（多文档环境下别拿错）
  if (root && root.ownerDocument && root.ownerDocument !== doc) root = null;
  if (root) return root;

  root = doc.createElement('div');
  root.id = OVERLAY_ID;
  root.setAttribute('data-std-part', 'overlay');

  const bar = doc.createElement('div');
  bar.className = 'std-ov-bar';
  bar.setAttribute('data-std-drag', '1');

  const grip = doc.createElement('span');
  grip.className = 'std-ov-grip';
  grip.textContent = '⠿ 弹幕层（拖动移动 · 右下角拉伸）';
  bar.appendChild(grip);

  const count = doc.createElement('span');
  count.className = 'std-ov-count';
  bar.appendChild(count);

  const hide = doc.createElement('button');
  hide.type = 'button';
  hide.className = 'std-ov-hide';
  hide.textContent = '✕';
  hide.title = '隐藏悬浮层（面板里可再打开）';
  hide.setAttribute('data-std-ov-hide', '1');
  bar.appendChild(hide);
  root.appendChild(bar);

  const stage = doc.createElement('div');
  stage.className = 'std-ov-stage';
  root.appendChild(stage);

  const resizer = doc.createElement('div');
  resizer.className = 'std-ov-resize';
  resizer.setAttribute('data-std-resize', '1');
  resizer.title = '拖动改变大小';
  root.appendChild(resizer);

  root.__std = { bar, stage, count, resizer };
  doc.body.appendChild(root);
  return root;
}

/** 按设置里的相对矩形摆放 */
export function applyRect(doc, rect) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root || !rect) return;
  const win = doc.defaultView || globalThis;
  const vw = win.innerWidth || 1280;
  const vh = win.innerHeight || 800;
  const w = Math.max(MIN_W, Math.round(rect.w * vw));
  const h = Math.max(MIN_H, Math.round(rect.h * vh));
  const x = Math.max(0, Math.min(vw - w, Math.round(rect.x * vw)));
  const y = Math.max(0, Math.min(vh - h, Math.round(rect.y * vh)));
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  root.style.width = `${w}px`;
  root.style.height = `${h}px`;
}

/** 从当前 DOM 读回相对矩形（拖动/缩放结束后保存用） */
export function readRect(doc) {
  const root = doc.getElementById(OVERLAY_ID);
  const win = doc.defaultView || globalThis;
  if (!root) return null;
  const vw = win.innerWidth || 1280;
  const vh = win.innerHeight || 800;
  const r = root.getBoundingClientRect();
  return {
    x: r.left / vw,
    y: r.top / vh,
    w: r.width / vw,
    h: r.height / vh,
  };
}

/** 悬浮层的飞行速度（没单独设就退回弹幕框的速度） */
export function overlaySpeedOf(appearance) {
  const app = appearance || {};
  const own = Number(app.overlaySpeed);
  if (Number.isFinite(own) && own > 0) return own;
  return Number(app.speed) || 110;
}

/** 应用外观设置（透明度 / 字号 / 速度 / 背景） */
export function applyOverlayStyle(doc, appearance) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root) return;
  const app = appearance || {};
  const fs = Number(app.fontSize) || 15;
  root.style.setProperty('--std-ov-opacity', String(app.overlayOpacity ?? 0.35));
  root.style.setProperty('--std-ov-fs', `${fs}px`);
  root.style.setProperty('--std-ov-lh', `${Math.round(fs * 1.9)}px`);
  root.style.setProperty('--std-ov-speed', `${overlaySpeedOf(app)}px/s`);
  // 悬浮层背景：由用户在面板里选（预设色块或自由填写），默认给一层很淡的暗色
  root.style.setProperty(
    '--std-ov-bg',
    app.overlayBg || 'linear-gradient(180deg, rgba(0, 0, 0, 0.30) 0%, rgba(0, 0, 0, 0.06) 100%)',
  );
  // 悬浮层整体略微放大一点，远看更像直播间
  root.classList.toggle('faded', false);
}

export function showOverlay(doc, on = true) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root) return;
  if (on) root.removeAttribute('data-std-hidden');
  else root.setAttribute('data-std-hidden', '1');
}

/** 悬浮层当前是否可见 */
export function isOverlayVisible(doc) {
  const root = doc.getElementById(OVERLAY_ID);
  return !!root && root.getAttribute('data-std-hidden') !== '1';
}

export function destroyOverlay(doc) {
  const root = doc.getElementById(OVERLAY_ID);
  if (root) root.remove();
}

/**
 * 播放一批弹幕。
 * @param {Document} doc
 * @param {object[]} items  已带 color 的弹幕
 * @param {object} opts { appearance, stagger, onDone }
 */
export function playOverlay(doc, items, opts = {}) {
  const root = ensureOverlay(doc);
  const stage = root.__std.stage;
  const app = opts.appearance || {};
  const stagger = opts.stagger ?? 0.22;
  const countEl = root.__std.count;

  // 清掉上一批的定时器
  (root.__std.timers || []).forEach((t) => clearTimeout(t));
  root.__std.timers = [];
  stage.innerHTML = '';
  root.classList.remove('faded');

  const laneH = Math.round((Number(app.fontSize) || 15) * 1.9);
  const lanes = Math.max(1, Math.floor(root.clientHeight / laneH));
  const speed = Math.max(20, overlaySpeedOf(app));
  const width = root.clientWidth || 800;
  const duration = Math.max(4, (width + 340) / speed);

  items.forEach((item, i) => {
    const node = doc.createElement('div');
    node.className = 'std-ov-item';
    node.style.top = `${(i % lanes) * laneH}px`;
    node.style.color = item.color || '#fff';
    node.style.animationDuration = `${duration.toFixed(2)}s`;
    node.style.animationDelay = `${(i * stagger).toFixed(2)}s`;

    if (item.昵称) {
      const n = doc.createElement('span');
      n.className = 'std-item-name';
      n.textContent = `${item.昵称}：`;
      node.appendChild(n);
    }
    const t = doc.createElement('span');
    t.textContent = String(item.内容 || '');
    node.appendChild(t);

    stage.appendChild(node);
  });

  if (countEl) countEl.textContent = `${items.length} 条`;

  const totalMs = (items.length * stagger + duration) * 1000 + 300;
  const timer = setTimeout(() => {
    if (app.overlayFade !== false) root.classList.add('faded');
    if (typeof opts.onDone === 'function') opts.onDone();
  }, totalMs);
  root.__std.timers.push(timer);

  return { duration, totalMs, lanes };
}

/**
 * 立刻停止并清空（比如用户关掉了悬浮层）
 */
export function stopOverlay(doc) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root || !root.__std) return;
  (root.__std.timers || []).forEach((t) => clearTimeout(t));
  root.__std.timers = [];
  root.__std.stage.innerHTML = '';
  root.__std.count.textContent = '';
}

/* ───────────── 拖动 / 缩放 ───────────── */

/**
 * 装上拖动与缩放行为。
 *
 * 指针策略是关键（之前写错的地方）：
 *   · 整个悬浮层 pointer-events: none —— 保证它永远不吃聊天区的事件；
 *   · **只有标题栏和右下角手柄** pointer-events: auto —— 所以拖动/拉伸永远有效，
 *     不依赖 hover 状态（第一次实现挂在 hover 上，结果经常拖不动）；
 *   · 幕布区域（.std-ov-stage）始终穿透，正文该怎么点还怎么点。
 *
 * hover 高亮用**显式类 + 事件**实现，不用 CSS `:has()` ——
 * 旧版 WebView 不支持 `:has()`，而且"hover 时强制 opacity:1"会把用户在面板里设的
 * 整体透明度整个盖掉（这就是"调透明度没反应"的原因）。
 *
 * @param {Document} doc
 * @param {(rect:object|null)=>void} onCommit 拖动/缩放结束时回调；null 表示用户点了 ✕ 隐藏
 * @returns {() => void} 卸载函数
 */
export function enableInteractions(doc, onCommit) {
  const root = ensureOverlay(doc);
  const win = doc.defaultView || globalThis;
  const { bar, resizer } = root.__std;
  let drag = null;

  const begin = (ev, mode) => {
    if (mode === 'move' && ev.target?.closest?.('[data-std-ov-hide]')) return;
    if (ev.button !== undefined && ev.button !== 0) return; // 只响应左键
    const r = root.getBoundingClientRect();
    drag = { mode, startX: ev.clientX, startY: ev.clientY, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    root.classList.add('dragging');
    win.addEventListener('pointermove', onPointerMove);
    win.addEventListener('pointerup', onPointerUp);
    ev.preventDefault?.();
  };

  const onBarDown = (ev) => begin(ev, 'move');
  const onResizeDown = (ev) => {
    ev.stopPropagation?.();
    begin(ev, 'resize');
  };

  const onPointerMove = (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    const vw = win.innerWidth || 1280;
    const vh = win.innerHeight || 800;
    if (drag.mode === 'move') {
      // 允许左右各露出一部分，纵向别跑出屏幕
      const x = Math.max(-drag.rect.w * 0.5, Math.min(vw - drag.rect.w * 0.5, drag.rect.x + dx));
      const y = Math.max(0, Math.min(vh - 24, drag.rect.y + dy));
      root.style.left = `${Math.round(x)}px`;
      root.style.top = `${Math.round(y)}px`;
    } else {
      const w = Math.max(MIN_W, Math.min(vw, drag.rect.w + dx));
      const h = Math.max(MIN_H, Math.min(vh, drag.rect.h + dy));
      root.style.width = `${Math.round(w)}px`;
      root.style.height = `${Math.round(h)}px`;
    }
  };

  const onPointerUp = () => {
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
    root.classList.remove('dragging');
    const wasDrag = !!drag;
    drag = null;
    if (!wasDrag) return;
    const rect = readRect(doc);
    if (rect && typeof onCommit === 'function') onCommit(rect);
  };

  const onHideClick = (ev) => {
    if (!ev.target?.closest?.('[data-std-ov-hide]')) return;
    showOverlay(doc, false);
    stopOverlay(doc);
    if (typeof onCommit === 'function') onCommit(null);
  };

  // hover 只加一个类，透明度由 CSS 变量决定，绝不覆盖用户设置
  const onEnter = () => root.classList.add('hover');
  const onLeave = () => root.classList.remove('hover');
  if (bar.addEventListener) {
    bar.addEventListener('pointerenter', onEnter);
    bar.addEventListener('pointerleave', onLeave);
    resizer.addEventListener('pointerenter', onEnter);
    resizer.addEventListener('pointerleave', onLeave);
  }

  bar.addEventListener('pointerdown', onBarDown);
  resizer.addEventListener('pointerdown', onResizeDown);
  root.addEventListener('click', onHideClick);

  return () => {
    bar.removeEventListener('pointerenter', onEnter);
    bar.removeEventListener('pointerleave', onLeave);
    resizer.removeEventListener('pointerenter', onEnter);
    resizer.removeEventListener('pointerleave', onLeave);
    bar.removeEventListener('pointerdown', onBarDown);
    resizer.removeEventListener('pointerdown', onResizeDown);
    root.removeEventListener('click', onHideClick);
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
  };
}
