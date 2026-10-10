/**
 * frame.js — 楼层内的弹幕框
 *
 * 挂在每轮正文下面的一块"幕布"：从右往左飞，每条颜色独立随机（亮色 + 与背景可分辨）。
 * 播完后按设置留下一份静态列表，方便往回翻。
 *
 * 这个模块只关心渲染，不参与取数；所有东西都是自建的 div，不碰酒馆的消息 DOM。
 */

import { buildPalette } from './color.js';
import { speedOfItem } from './danmaku.js';

const HOST_CLASS = 'std-frame';
const LANE_PAD = 6;

/**
 * 确定弹幕容器该插在哪。
 *
 * 关键：**必须插在整条消息元素（.mes）之后**，不能插进消息内部。
 * 插进消息内部（比如 .mes_block 之后）会破坏酒馆消息容器的布局计算，
 * 表现为"弹幕框把正文挤掉/撑开"。
 */
export function resolveHostAnchor(messageId, doc) {
  try {
    const mes = doc.querySelector(`.mes[mesid="${messageId}"]`);
    if (mes && mes.parentElement) return { mode: 'after', node: mes };
  } catch {
    /* noop */
  }
  // 消息元素找不到（渲染时序问题）时，退到聊天区末尾；不影响消息结构
  const chat = doc.getElementById('chat');
  if (chat) return { mode: 'append', node: chat };
  return null;
}

/** 取背景亮度对应的调色板 */
export function makePalette(count, luminance) {
  return buildPalette(count, { luminance });
}

/**
 * 创建一个弹幕框。
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {object} opts.appearance   settings.appearance
 * @param {number} opts.luminance    背景相对亮度
 * @param {object} opts.meta         { batchNo, messageId, title }
 * @param {object[]} opts.items      [{ 昵称, 内容, 类型, color }]
 * @returns {HTMLElement}
 */
export function createFrame({ doc, appearance, luminance, meta, items }) {
  const app = appearance || {};
  const fontSize = Number(app.fontSize) || 15;
  const lineHeight = Math.round(fontSize * 1.9);
  const height = Math.max(lineHeight + 46, Number(app.frameHeight) || 148);
  const lanes = Math.max(1, Math.floor((height - 40) / lineHeight));

  const colors = items.map((it) => it.color).filter(Boolean);
  const palette = colors.length === items.length ? colors : makePalette(items.length, luminance);
  // 把最终颜色回写进 items，后续静态列表、悬浮层复播都直接复用，保证同一条弹幕颜色不变
  items.forEach((it, i) => {
    it.color = palette[i % palette.length];
  });

  const root = doc.createElement('div');
  root.className = HOST_CLASS;
  root.setAttribute('data-batch', String(meta?.batchNo ?? ''));
  if (meta?.messageId !== undefined) root.setAttribute('data-mesid', String(meta.messageId));
  root.style.setProperty('--std-h', `${height}px`);
  root.style.setProperty('--std-fs', `${fontSize}px`);
  root.style.setProperty('--std-lh', `${lineHeight}px`);
  root.style.setProperty('--std-speed', `${Number(app.speed) || 110}px/s`);
  root.style.setProperty('--std-gap', `${Number(app.gap) || 16}px`);
  root.style.setProperty('--std-opacity', String(app.opacity ?? 1));
  root.style.setProperty('--std-bg', app.frameBackground || 'transparent');

  /* 头部 */
  const head = doc.createElement('div');
  head.className = 'std-frame-head';

  const dot = doc.createElement('span');
  dot.className = 'std-live-dot';
  head.appendChild(dot);

  const title = doc.createElement('span');
  title.className = 'std-frame-title';
  title.textContent = meta?.title || '弹幕';
  head.appendChild(title);

  const metaText = doc.createElement('span');
  metaText.className = 'std-frame-meta';
  metaText.textContent = `${items.length} 条`;
  head.appendChild(metaText);

  const spacer = doc.createElement('span');
  spacer.className = 'std-spacer';
  head.appendChild(spacer);

  const mkBtn = (label, act, titleText) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'std-frame-btn';
    b.setAttribute('data-std-act', act);
    b.textContent = label;
    if (titleText) b.title = titleText;
    return b;
  };
  head.appendChild(mkBtn('↻', 'replay', '重播这一批'));
  head.appendChild(mkBtn('✕', 'hide', '收起来（内容还在，点标题展开）'));
  root.appendChild(head);

  /* 舞台 */
  const stage = doc.createElement('div');
  stage.className = 'std-frame-stage';
  root.appendChild(stage);

  /* 静态列表（keepStatic 时显示） */
  const staticList = doc.createElement('div');
  staticList.className = 'std-frame-static';
  root.appendChild(staticList);

  /** 把 items 按轨道分摊 */
  const laneItems = distributeLanes(items, lanes);

  const frame = {
    el: root,
    stage,
    staticList,
    items,
    lanes,
    lineHeight,
    playing: false,
    timers: [],
    state: 'idle', // idle | playing | done
  };

  // 先渲染好 DOM 节点（不播放），这样即使不播也能立刻看到静态列表
  frame.nodes = laneItems.map(({ item, lane, index }) =>
    buildNode(doc, item, {
      lane,
      index,
      lineHeight,
      color: palette[index % palette.length],
      showName: true,
    }),
  );

  attachControls(frame, doc, app);
  return frame;
}

function buildNode(doc, item, { lane, index, lineHeight, color, showName = true }) {
  const node = doc.createElement('div');
  node.className = 'std-item';
  node.style.top = `${40 + lane * lineHeight}px`;
  node.style.color = color || '#fff';
  node.setAttribute('data-index', String(index));
  if (item.昵称 && showName) {
    const name = doc.createElement('span');
    name.className = 'std-item-name';
    name.textContent = `${item.昵称}：`;
    node.appendChild(name);
  }
  const text = doc.createElement('span');
  text.className = 'std-item-text';
  text.textContent = String(item.内容 || '');
  node.appendChild(text);
  if (item.类型 && item.类型 !== '普通') {
    const tag = doc.createElement('span');
    tag.className = 'std-item-tag';
    tag.textContent = item.类型;
    node.appendChild(tag);
  }
  return node;
}

/** 均摊到各轨道，同轨不相邻重复发送者 */
export function distributeLanes(items, lanes) {
  const count = Math.max(1, lanes);
  const out = [];
  let lane = 0;
  let lastSpeaker = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.昵称 && item.昵称 === lastSpeaker && count > 1) lane = (lane + 1) % count;
    out.push({ item, lane, index: i });
    lastSpeaker = item.昵称 || '';
    lane = (lane + 1) % count;
  }
  return out;
}

/* ───────────── 播放 ───────────── */

/** 把弹幕播起来（每次重播都重新算位置，所以缩放/改字号后依然正确） */
export function playFrame(frame, opts = {}) {
  const { doc = frame.el.ownerDocument, appearance = {}, stagger = 0.22 } = opts;
  if (!frame || !frame.nodes) return;
  stopFrame(frame);
  frame.stage.innerHTML = '';
  frame.staticList.innerHTML = '';
  frame.staticList.classList.remove('show');
  frame.el.classList.remove('done', 'collapsed', 'paused');
  frame.state = 'playing';
  frame.playing = true;

  const runner = doc.createElement('div');
  runner.className = 'std-runner';
  frame.stage.appendChild(runner);

  const stageWidth = frame.stage.clientWidth || frame.el.clientWidth || 600;
  const baseSpeed = Math.max(20, Number(appearance.speed) || Number(frame.el.style.getPropertyValue('--std-speed').replace('px/s', '')) || 110);
  // 每条弹幕用自己的速度（生成时已定死并存在数据里），这样重播与静态列表都一致。
  // 时长要各自算，不能只算一次。
  const durationFor = (item) => Math.max(4, (stageWidth + 320) / speedOfItem(item, baseSpeed));

  frame.nodes.forEach((node, i) => {
    const clone = node.cloneNode(true);
    const dur = durationFor(frame.items && frame.items[i]);
    clone.style.animationDuration = `${dur.toFixed(2)}s`;
    clone.style.animationDelay = `${(i * stagger).toFixed(2)}s`;
    clone.style.visibility = 'hidden';
    runner.appendChild(clone);
    const timer = setTimeout(() => {
      clone.style.visibility = '';
      clone.classList.add('flying');
    }, i * stagger * 1000);
    frame.timers.push(timer);
  });

  // 整批播完的时刻要按"最慢的那条"算，否则会提前收尾、把还在飞的弹幕切掉
  const durations = frame.nodes.map((_, i) => durationFor(frame.items && frame.items[i]));
  const maxDuration = durations.length ? Math.max(...durations) : 4;
  const totalMs = (frame.nodes.length * stagger + maxDuration) * 1000 + 400;
  const doneTimer = setTimeout(() => finishFrame(frame, appearance), totalMs);
  frame.timers.push(doneTimer);
}

export function stopFrame(frame) {
  if (!frame) return;
  (frame.timers || []).forEach((t) => clearTimeout(t));
  frame.timers = [];
  frame.playing = false;
}

/** 播完：可选留下静态列表 */
export function finishFrame(frame, appearance = {}) {
  if (!frame) return;
  frame.state = 'done';
  frame.playing = false;
  frame.el.classList.add('done');
  frame.stage.innerHTML = '';
  if (appearance.keepStatic !== false) renderStatic(frame);
}

/** 渲染静态列表（回看用） */
export function renderStatic(frame) {
  if (!frame) return;
  frame.staticList.innerHTML = '';
  for (const item of frame.items || []) {
    const chip = frame.el.ownerDocument.createElement('span');
    chip.className = 'std-chip';
    chip.style.color = item.color || '';
    chip.textContent = item.昵称 ? `${item.昵称}：${item.内容}` : String(item.内容 || '');
    frame.staticList.appendChild(chip);
  }
  if (frame.staticList.children.length) frame.staticList.classList.add('show');
}

function attachControls(frame, doc, appearance) {
  frame.el.addEventListener('click', (ev) => {
    const target = ev.target;
    const act = target?.getAttribute?.('data-std-act');
    if (act === 'replay') {
      ev.stopPropagation();
      playFrame(frame, { doc, appearance });
      return;
    }
    if (act === 'hide') {
      ev.stopPropagation();
      toggleCollapse(frame, true);
      return;
    }
    // 点标题栏也能展开/收起
    if (target?.closest?.('.std-frame-head')) {
      toggleCollapse(frame, !frame.el.classList.contains('collapsed'));
    }
  });
}

export function toggleCollapse(frame, collapsed) {
  if (!frame) return;
  const want = collapsed === undefined ? !frame.el.classList.contains('collapsed') : !!collapsed;
  frame.el.classList.toggle('collapsed', want);
}

/* ───────────── 插入与清理 ───────────── */

/**
 * 把弹幕框挂到某个楼层下面。已存在同 data-batch 的框会先被移除（重播/重生成时用）。
 * @returns {HTMLElement|null} 插入的根节点
 */
export function mountFrame({ doc, messageId, host, frame }) {
  if (!doc || !frame?.el) return null;
  // 同楼层的旧框先清掉，避免重复（重播 / 重 roll 时会发生）
  try {
    doc.querySelectorAll(`.${HOST_CLASS}[data-mesid="${messageId}"]`).forEach((n) => n.remove());
  } catch {
    /* noop */
  }

  const anchor = host || resolveHostAnchor(messageId, doc);
  if (!anchor) return null;
  if (anchor.mode === 'after') {
    anchor.node.insertAdjacentElement('afterend', frame.el);
    // 测试替身（以及任何没有真实布局引擎的环境）靠这两个知道：
    // "我插在锚点下方、宽度跟锚点一致"
    if (anchor.node._rect) {
      frame.el._hostRect = anchor.node._rect;
      frame.el._autoWidth = anchor.node._rect.width;
    }
  } else {
    anchor.node.appendChild(frame.el);
  }
  return frame.el;
}
/** 清掉所有本次会话插入的弹幕框 */
export function clearAllFrames(doc) {
  if (!doc) return 0;
  const nodes = doc.querySelectorAll(`.${HOST_CLASS}`);
  nodes.forEach((n) => n.remove());
  return nodes.length;
}

/** 清掉某一楼的弹幕框 */
export function clearFrameAt(doc, messageId) {
  if (!doc) return 0;
  const nodes = doc.querySelectorAll(`${HOST_CLASS}[data-mesid="${messageId}"]`);
  nodes.forEach((n) => n.remove());
  return nodes.length;
}

/** 数一下现在页面上有几块弹幕框 */
export function countFrames(doc) {
  if (!doc) return 0;
  return doc.querySelectorAll(`.${HOST_CLASS}`).length;
}

/**
 * 生成一份"演示用"的假弹幕，让用户在没花 API 钱的情况下看到效果。
 * 这里用的是**通用网名**（不预设任何题材）：只用来调外观，
 * 真实弹幕的昵称由 AI 按当前世界观起。
 */
export function demoSample(n = 15) {
  const names = [
    '前排吃瓜群众',
    '咸鱼不翻身',
    '今天也没睡醒',
    '路人甲9527',
    '看戏不嫌事大',
    '表情包仓库',
    '三点半起来喝热水',
    '隔壁老王在线',
    '键盘侠本侠',
    '嗑到停不下来',
    '潜水十年的我',
    '一个没有感情的观众',
  ];
  const texts = [
    '来了来了',
    '？？？这什么操作',
    '我就说会这样',
    '前排蹲一个结果',
    '这段能截下来吗',
    '别急，还有后手',
    '笑死，谁给他的胆子',
    '这段我熟，等着看吧',
    '主播别停啊',
    '有点东西',
    '666',
    '散了散了',
    '这波稳了',
    '不会真有人信吧',
    '催更催更',
    '终于等到这段',
    '这也能行？',
    '我赌五毛他要栽',
    '安静看戏',
    '好家伙，直接开摆',
  ];
  const types = ['普通', '懂行', '起哄', '催促', '抬杠', '玩梗', '情绪'];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      昵称: names[i % names.length],
      内容: texts[i % texts.length],
      类型: types[i % types.length],
      回复: '',
    });
  }
  return out;
}
