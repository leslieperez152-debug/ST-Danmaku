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

import { speedOfItem, delayOfItem } from './danmaku.js';
import { effectiveLanes } from './frame.js';

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

  // 「生成中…」提示：由 CSS 按层的 data-std-generating 决定显不显示
  const genHint = doc.createElement('span');
  genHint.className = 'std-gen-hint';
  bar.appendChild(genHint);
  genHint.textContent = '生成中…';

  // 悬浮层自己的操作按钮：看弹幕的地方就能直接再要一批 / 重播 / 中断
  const mkOvBtn = (label, act, titleText) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'std-ov-btn';
    b.textContent = label;
    b.title = titleText;
    b.setAttribute('data-std-ov-act', act);
    return b;
  };
  bar.appendChild(mkOvBtn('↻ 重播', 'replay', '重播最近一批（不重新请求模型）'));
  bar.appendChild(mkOvBtn('＋ 生成', 'generate', '按当前正文再出一批新弹幕'));
  const abortBtn = mkOvBtn('■ 中断', 'abort', '中断这次生成（中断后这一批不会显示）');
  abortBtn.setAttribute('data-std-ov-abort', '1');
  bar.appendChild(abortBtn);

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
  if (on) {
    root.removeAttribute('data-std-hidden');
    // 显出来的时候顺手把"播完淡出"的状态清掉。
    // 否则一旦被淡出过（opacity 0.03），下一次生成时层虽然"在"、却几乎看不见 ——
    // 表现就是"框本来好好的，生成之后直接消失了"。
    root.classList.remove('faded');
  } else {
    root.setAttribute('data-std-hidden', '1');
  }
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
  const stagger = Number(opts.stagger) > 0 ? Number(opts.stagger) : Number(app.stagger) > 0 ? Number(app.stagger) : 0.22;
  const countEl = root.__std.count;

  // 清掉上一批的定时器，并把"停止闸门"打开（上一批可能刚被 stopOverlay 关掉）
  (root.__std.timers || []).forEach((t) => clearTimeout(t));
  root.__std.timers = [];
  root.__std.stopped = false;
  stage.innerHTML = '';
  root.classList.remove('faded');

  const laneH = Math.round((Number(app.fontSize) || 15) * 1.9);
  /**
   * 轨道数一律用**舞台里真能放下的行数**（不含标题栏）。
   *
   * ❌ 不要用 `max(计划轨道数, 能放的行数)`：那样行高会变成 `stageH / 行数`，
   * **比文字本身还矮**，相邻两行的字就叠在一起 —— 看起来就是"弹幕重合"，
   * 而且怎么调间隔都没用（问题不在间隔）。
   */
  const stageH = stage.clientHeight || root.clientHeight || 160;
  const lanes = Math.max(1, Math.floor(stageH / laneH));
  const baseSpeed = Math.max(20, overlaySpeedOf(app));
  const width = root.clientWidth || 800;
  // 每条用自己的速度（生成时定死），重播保持一致
  const durationFor = (item) => Math.max(4, (width + 340) / speedOfItem(item, baseSpeed));

  /**
   * 悬浮层的行分配：**均摊**，而不是照搬计划轨道号。
   *
   * 为什么要区别对待：悬浮层常常"只有几条弹幕、却能放 6 行"，
   * 照搬计划轨道号的话几条会全挤在最上面、**底下整片空着**（用户拉高之后尤其明显）。
   * 均摊能把有限的几条铺满整块高度。
   */
  const spread = spreadLanes(items.length, lanes);

  items.forEach((item, i) => {
    const node = doc.createElement('div');
    node.className = 'std-ov-item';
    const lane = spread[i];
    node.style.top = `${lane * laneH}px`;
    node.style.color = item.color || '#fff';
    const dur = durationFor(item);
    const delay = delayOfItem(item, i, stagger);
    node.style.animationDuration = `${dur.toFixed(2)}s`;
    // 出现时刻：优先用每条自己定好的（带浮动），没有就退回等间隔
    node.style.animationDelay = `${delay.toFixed(2)}s`;
    // 循环时要靠这两个值把"延时 + 时长"重新贴回去（见下面的 restart），
    // 所以记在节点上，而不是每轮重新算（重算会跟首轮不一致）
    node.__stdTiming = { dur, delay };

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

  // 按"最晚结束的那条"算收尾时刻（出现时刻 + 飞行时长），否则会提前把还在飞的弹幕清掉
  const endTimes = items.map((it, i) => delayOfItem(it, i, stagger) + durationFor(it));
  const maxEnd = endTimes.length ? Math.max(...endTimes) : 4;
  const batchMs = maxEnd * 1000 + 300;

  /**
   * 循环播放：弹幕流本来就不该"播一次就没了"。
   *
   * 做法是把每一轮的动画**原地重启**，而不是删掉重建节点 —— 后者每轮都要重排 DOM，久了会卡。
   *
   * 两个坑：
   *   · `animation` 是简写属性，置 `'none'` 会**连内联的 animation-delay / duration 一起清掉**。
   *     只恢复 `animation = ''` 的话，第二轮会变成"所有弹幕同时冒出来 + 用 CSS 默认时长"。
   *     所以必须把记好的时长/延时贴回去。
   *   · `void node.offsetWidth` 是最常见的强制回流手法，但在某些 WebView 里读到的是缓存值、
   *     不一定真触发回流，于是动画不重启（表现就是"播几轮就不动了"）。
   *     所以优先用 Web Animations API 直接 cancel + play（最可靠），
   *     没有才退回"置 none + 回流 + 恢复"。
   */
  const restart = () => {
    for (const node of stage.children) {
      const timing = node.__stdTiming || {};
      // 首选：Web Animations API（现代浏览器与较新的 WebView 都有）
      try {
        if (typeof node.getAnimations === 'function') {
          const anims = node.getAnimations();
          if (anims && anims.length) {
            for (const a of anims) {
              try {
                a.cancel();
                a.play();
              } catch {
                /* 单个动画出问题不该影响其它 */
              }
            }
            continue;
          }
        }
      } catch {
        /* 退回下面的写法 */
      }
      // 退回：置 none → 强制回流 → 恢复，并把时长/延时贴回去
      node.style.animation = 'none';
      void node.offsetWidth;
      node.style.animation = '';
      if (timing.dur) node.style.animationDuration = `${Number(timing.dur).toFixed(2)}s`;
      if (timing.delay !== undefined) node.style.animationDelay = `${Number(timing.delay).toFixed(2)}s`;
    }
  };

  let timer;
  if (app.overlayLoop === true) {
    /**
     * 用 setTimeout 递归自重排，而不是 setInterval。
     *
     * setInterval 会一直挂着一个定时器，stopOverlay 清掉当前 id 之后
     * 后面还会继续触发，等于停不干净、还泄漏。
     * 自重排的话任何时刻只有一个待触发的 id，清掉它就真的停了。
     *
     * 另外用 root.__std.stopped 做闸门：光 clearTimeout 挡不住"已经被排进队列、
     * 马上就要跑"的那一个，闸门才能真正停住（否则测试进程永远不退出）。
     *
     * ⚠️ 两个曾经让"播几轮就不重播了"的坑：
     *   1. tick 里只要抛一次异常，链条就断了，而且**没有任何补救** ——
     *      于是播几轮之后永远停住。所以整个 tick 用 try/catch 包住，
     *      并且把"排下一次"放进 finally（出错也继续排）。
     *   2. 以前写 `root.__std.timers = [next]` **覆盖整个数组**，
     *      会把还在等的其它定时器 id 丢掉。现在只登记自己的那个，不动别人。
     */
    const cycle = Math.max(1500, batchMs);
    root.__std.stopped = false;
    const tick = () => {
      if (root.__std.stopped) return;
      try {
        restart();
      } catch (e) {
        // 单轮重启失败不该让整条循环链断掉
        if (typeof console !== 'undefined' && console.warn) console.warn('[弹幕] 重启动画失败', e);
      } finally {
        if (!root.__std.stopped) {
          const next = setTimeout(tick, cycle);
          // Node 里 unref 让这个定时器不阻止进程退出（浏览器里没有这个方法，会被忽略）。
          if (typeof next?.unref === 'function') next.unref();
          // 登记"当前这一个"（替换自己上一轮的登记），但别清掉别人的定时器
          root.__std.loopTimer = next;
        }
      }
    };
    timer = setTimeout(tick, cycle);
    root.__std.loopTimer = timer;
    if (typeof timer?.unref === 'function') timer.unref();
  } else {
    timer = setTimeout(() => {
      if (app.overlayFade === true) {
        // 用户明确要求"播完淡出"：整层淡下去（层还在，鼠标移进去仍能拖动）
        root.classList.add('faded');
      } else {
        // 默认：**层保持可见**，只是把飞完的弹幕清掉。
        stage.innerHTML = '';
        if (countEl) countEl.textContent = '';
      }
      if (typeof opts.onDone === 'function') opts.onDone();
    }, batchMs);
  }
  root.__std.timers.push(timer);

  // 把"这批弹幕 + 行高"记在层上：用户拉伸之后要能按新高度重排（relayoutOverlay）
  root.__std.items = items;
  root.__std.laneH = laneH;
  root.__std.lanes = lanes;

  return { duration: maxEnd, totalMs: batchMs, lanes, loop: app.overlayLoop === true };
}

/**
 * 立刻停止并清空（比如用户关掉了悬浮层）
 */
export function stopOverlay(doc) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root || !root.__std) return;
  // 先把闸门关上：光 clearTimeout 挡不住"已排进队列、马上就要跑"的那一个
  root.__std.stopped = true;
  (root.__std.timers || []).forEach((t) => clearTimeout(t));
  root.__std.timers = [];
  // 循环定时器单独记着，也要清掉，否则它还会把自己排回来
  if (root.__std.loopTimer) {
    clearTimeout(root.__std.loopTimer);
    root.__std.loopTimer = null;
  }
  root.__std.stage.innerHTML = '';
  if (root.__std.count) root.__std.count.textContent = '';
}

/**
 * 把 items 摊到 `lanes` 条轨道上。
 *
 * 和弹幕框用的 `distributeLanes` 不同：这里**优先均摊**，因为悬浮层常常"只有几条弹幕、
 * 却能放 6 行"——如果只按计划轨道号，几条弹幕会全挤在最上面，**底下整片空着**。
 * 用户把层拉高之后尤其明显。
 *
 * 所以：
 *   · 条数 ≤ 轨道数 → 每条各占一行，均匀铺开；
 *   · 条数 > 轨道数 → 按序轮流，保证同轨的相邻两条尽量不是同一个发送者。
 */
export function spreadLanes(count, lanes) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const total = Math.max(1, Math.floor(Number(lanes) || 1));
  const out = [];
  if (!n) return out;
  if (n <= total) {
    // 均匀取行：6 行放 3 条 → 0, 2, 4（而不是 0, 1, 2 挤在顶上）
    for (let i = 0; i < n; i += 1) out.push(Math.round((i * (total - 1)) / Math.max(1, n - 1)));
    return out;
  }
  for (let i = 0; i < n; i += 1) out.push(i % total);
  return out;
}

/**
 * 按**当前尺寸**重排已经摆好的弹幕（只改行位置，不重播）。
 *
 * 用途：用户把悬浮层拉高/压矮之后，行数变了，弹幕必须跟着重新铺开；
 * 否则行数还是旧的，弹幕只占上面几行、底下整片空着。
 * 不重播动画（延时不动），所以不会打断正在飞的弹幕。
 */
export function relayoutOverlay(doc) {
  const root = doc.getElementById(OVERLAY_ID);
  if (!root || !root.__std) return 0;
  const { stage, items, laneH } = root.__std;
  if (!stage || !items || !items.length) return 0;
  const stageH = stage.clientHeight || root.clientHeight || 160;
  const lh = Math.max(10, Number(laneH) || 29);
  const lanes = Math.max(1, Math.floor(stageH / lh));
  const spread = spreadLanes(items.length, lanes);
  const nodes = [...stage.children];
  nodes.forEach((node, i) => {
    if (spread[i] === undefined) return;
    node.style.top = `${spread[i] * lh}px`;
  });
  root.__std.lanes = lanes;
  return lanes;
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
 * @param {((rect:object|null)=>void)|{onRect?:Function, onAction?:Function}} onCommitOrOpts
 *        兼容旧写法：直接传函数等于 onRect。onRect(null) 表示用户点了 ✕ 隐藏。
 *        onAction('replay'|'generate') 用于标题栏上的两个按钮。
 * @returns {() => void} 卸载函数
 */
export function enableInteractions(doc, onCommitOrOpts) {
  const opts = typeof onCommitOrOpts === 'function' ? { onRect: onCommitOrOpts } : onCommitOrOpts || {};
  const onCommit = opts.onRect;
  const root = ensureOverlay(doc);
  const win = doc.defaultView || globalThis;
  const { bar, resizer } = root.__std;
  let drag = null;

  const begin = (ev, mode) => {
    // 标题栏上的按钮不是拖动把手
    if (mode === 'move' && ev.target?.closest?.('[data-std-ov-hide], [data-std-ov-act]')) return;
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
    const mode = drag?.mode;
    const wasDrag = !!drag;
    drag = null;
    if (!wasDrag) return;
    // 拉伸之后**立刻按新高度重排**：不然行数还是旧的，
    // 弹幕只占上面几行、底下整片空着（这就是"拉高了还是只有几行"）。
    if (mode === 'resize') relayoutOverlay(doc);
    const rect = readRect(doc);
    if (rect && typeof onCommit === 'function') onCommit(rect);
  };

  const onHideClick = (ev) => {
    // 标题栏上的两个操作按钮
    const actBtn = ev.target?.closest?.('[data-std-ov-act]');
    if (actBtn) {
      const act = actBtn.getAttribute('data-std-ov-act');
      if (typeof opts.onAction === 'function') opts.onAction(act);
      return;
    }
    if (!ev.target?.closest?.('[data-std-ov-hide]')) return;
    showOverlay(doc, false);
    stopOverlay(doc);
    if (typeof onCommit === 'function') onCommit(null);
  };

  // hover 只加一个类，透明度由 CSS 变量决定，绝不覆盖用户设置
  const onEnter = () => root.classList.add('hover');
  const onLeave = () => root.classList.remove('hover');

  // 窗口尺寸变了（或页面缩放）可用高度也会变，顺手重排一次
  let resizeTimer = null;
  const onWinResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayoutOverlay(doc), 180);
  };
  if (bar.addEventListener) {
    bar.addEventListener('pointerenter', onEnter);
    bar.addEventListener('pointerleave', onLeave);
    resizer.addEventListener('pointerenter', onEnter);
    resizer.addEventListener('pointerleave', onLeave);
  }

  bar.addEventListener('pointerdown', onBarDown);
  resizer.addEventListener('pointerdown', onResizeDown);
  root.addEventListener('click', onHideClick);
  if (win.addEventListener) win.addEventListener('resize', onWinResize);

  return () => {
    bar.removeEventListener('pointerenter', onEnter);
    bar.removeEventListener('pointerleave', onLeave);
    resizer.removeEventListener('pointerenter', onEnter);
    resizer.removeEventListener('pointerleave', onLeave);
    bar.removeEventListener('pointerdown', onBarDown);
    resizer.removeEventListener('pointerdown', onResizeDown);
    root.removeEventListener('click', onHideClick);
    if (win.removeEventListener) win.removeEventListener('resize', onWinResize);
    if (resizeTimer) clearTimeout(resizeTimer);
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
  };
}
