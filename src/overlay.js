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

/** 应用外观设置（透明度 / 字号 / 速度） */
export function applyOverlayStyle(doc, appearance) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root) return;
  const app = appearance || {};
  const fs = Number(app.fontSize) || 15;
  root.style.setProperty('--std-ov-opacity', String(app.overlayOpacity ?? 0.14));
  root.style.setProperty('--std-ov-fs', `${fs}px`);
  root.style.setProperty('--std-ov-lh', `${Math.round(fs * 1.9)}px`);
  root.style.setProperty('--std-ov-speed', `${Number(app.speed) || 110}px/s`);
  // 悬浮层整体略微放大一点，远看更像直播间
  root.classList.toggle('faded', false);
}

export function showOverlay(doc, on = true) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root) return;
  root.style.display = on ? '' : 'none';
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
  const speed = Math.max(20, Number(app.speed) || 110);
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

/** 立刻停止并清空（比如用户关掉了悬浮层） */
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
 * 装上拖动与缩放行为。返回一个卸载函数。
 * @param {Document} doc
 * @param {(rect:object)=>void} onCommit 拖动/缩放结束时回调，用来持久化位置
 */
export function enableInteractions(doc, onCommit) {
  const root = ensureOverlay(doc);
  const win = doc.defaultView || globalThis;
  let drag = null;

  const onPointerDownBar = (ev) => {
    if (ev.target?.closest?.('[data-std-ov-hide]')) return;
    const r = root.getBoundingClientRect();
    drag = { mode: 'move', startX: ev.clientX, startY: ev.clientY, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    root.classList.add('dragging');
    win.addEventListener('pointermove', onPointerMove);
    win.addEventListener('pointerup', onPointerUp);
    ev.preventDefault();
  };

  const onPointerDownResize = (ev) => {
    const r = root.getBoundingClientRect();
    drag = { mode: 'resize', startX: ev.clientX, startY: ev.clientY, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    root.classList.add('dragging');
    win.addEventListener('pointermove', onPointerMove);
    win.addEventListener('pointerup', onPointerUp);
    ev.preventDefault();
    ev.stopPropagation();
  };

  const onPointerMove = (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    const vw = win.innerWidth || 1280;
    const vh = win.innerHeight || 800;
    if (drag.mode === 'move') {
      const x = Math.max(-drag.rect.w * 0.4, Math.min(vw - drag.rect.w * 0.6, drag.rect.x + dx));
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
    drag = null;
    const rect = readRect(doc);
    if (rect && typeof onCommit === 'function') onCommit(rect);
  };

  const bar = root.__std.bar;
  const resizer = root.__std.resizer;
  bar.addEventListener('pointerdown', onPointerDownBar);
  resizer.addEventListener('pointerdown', onPointerDownResize);

  const onHide = (ev) => {
    if (!ev.target?.closest?.('[data-std-ov-hide]')) return;
    showOverlay(doc, false);
    stopOverlay(doc);
    if (typeof onCommit === 'function') onCommit(null); // null 表示"用户主动隐藏了"
  };
  root.addEventListener('click', onHide);

  return () => {
    bar.removeEventListener('pointerdown', onPointerDownBar);
    resizer.removeEventListener('pointerdown', onPointerDownResize);
    root.removeEventListener('click', onHide);
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
  };
}

/** 悬浮层当前是否可见 */
export function isOverlayVisible(doc) {
  const root = doc.getElementById(OVERLAY_ID);
  return !!root && root.style.display !== 'none';
}
