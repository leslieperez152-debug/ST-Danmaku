/**
 * color.js — 弹幕配色
 *
 * 目标：任意主题下，每一条弹幕的颜色都"亮且看得见"。
 *
 * 做法：
 *   1. 在页面真实背景上采样若干点，算出背景平均相对亮度 L_bg；
 *   2. 只在"高饱和 + 高亮度"的 HSL 里随机取色（保证是亮色）；
 *   3. 用 WCAG 相对亮度算与背景的对比度，对比度不够就丢弃重摇；
 *   4. 重摇若干次仍不合格时，直接根据背景明暗挑一个安全色兜底。
 *
 * 纯函数 + 一个可注入的亮度来源，方便单测。
 */

/* ───────────── 颜色工具 ───────────── */

/** '#rrggbb' / 'rgb()' / 'rgba()' → [r,g,b] | null */
export function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent' || s === 'inherit' || s === 'currentcolor') return null;

  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }

  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [clamp255(+m[1]), clamp255(+m[2]), clamp255(+m[3])];

  return null;
}

function clamp255(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** WCAG 相对亮度 0~1 */
export function relativeLuminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 两条颜色（或亮度值）的对比度 1~21 */
export function contrastRatio(a, b) {
  const la = typeof a === 'number' ? a : relativeLuminance(a);
  const lb = typeof b === 'number' ? b : relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** HSL(0~360, 0~100, 0~100) → '#rrggbb' */
export function hslToHex(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => clamp255((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

/* ───────────── 调色 ───────────── */

/**
 * @typedef {Object} PaletteOptions
 * @property {number} [luminance]     背景相对亮度 0~1。不给则由 sampleBackgroundLuminance 采样。
 * @property {number} [minContrast]   与背景的最小对比度，默认 3.2
 * @property {number} [minLightness]  亮度下限（保证"亮亮的"），默认 62
 * @property {number} [maxLightness]  亮度上限，默认 88
 * @property {number} [minSaturation] 饱和度下限，默认 62
 * @property {number} [tries]         单次摇号的最大重试次数，默认 48
 * @property {() => number} [random]  可注入随机源，便于测试
 */

/**
 * 生成一个"亮且与背景可分辨"的随机颜色。
 * @param {PaletteOptions} [opts]
 * @returns {string} '#rrggbb'
 */
export function randomBrightColor(opts = {}) {
  const {
    minContrast = 3.2,
    minLightness = 62,
    maxLightness = 88,
    minSaturation = 62,
    tries = 48,
    random = Math.random,
  } = opts;
  const bgLum = typeof opts.luminance === 'number' ? opts.luminance : 0.2;

  // 背景偏亮时把亮度上限压下来，否则亮字贴在亮底上必然糊
  const cap = bgLum > 0.6 ? 58 : maxLightness;
  const lo = Math.min(minLightness, cap);
  const hi = Math.max(lo + 2, cap);

  for (let i = 0; i < tries; i++) {
    const h = random() * 360;
    const s = minSaturation + random() * (100 - minSaturation);
    const l = lo + random() * (hi - lo);
    const hex = hslToHex(h, s, l);
    const rgb = parseColor(hex);
    if (!rgb) continue;
    if (contrastRatio(relativeLuminance(rgb), bgLum) >= minContrast) return hex;
  }

  // 兜底：按背景明暗直接给一个安全色（浅底给深彩、深底给浅彩）
  return bgLum > 0.6 ? '#1d4ed8' : '#ffd479';
}

/**
 * 一次生成 n 个颜色，尽量互不重复（色相分层 + 抖动）。
 * @param {number} n
 * @param {PaletteOptions} [opts]
 * @returns {string[]}
 */
export function buildPalette(n, opts = {}) {
  const count = Math.max(0, Math.floor(n) || 0);
  const random = opts.random || Math.random;
  const out = [];
  if (!count) return out;

  // 先用等分色相保证一批里颜色散得开，再各自微抖
  const base = random() * 360;
  for (let i = 0; i < count; i++) {
    const hue = base + (360 * i) / count + (random() - 0.5) * (360 / count) * 0.8;
    const s = 68 + random() * 32;
    const l = (opts.luminance ?? 0.2) > 0.6 ? 44 + random() * 14 : 66 + random() * 22;
    let hex = hslToHex(hue, s, l);
    // 对比度不合格就退回通用摇号
    const bgLum = typeof opts.luminance === 'number' ? opts.luminance : 0.2;
    const rgb = parseColor(hex);
    if (!rgb || contrastRatio(relativeLuminance(rgb), bgLum) < (opts.minContrast ?? 3.2)) {
      hex = randomBrightColor(opts);
    }
    out.push(hex);
  }
  return out;
}

/* ───────────── 真实背景采样 ───────────── */

/**
 * 在页面上采样若干点的实际背景色，返回平均相对亮度。
 * 对"半透明层叠背景"也够用：我们只是要一个明暗基准。
 *
 * @param {Document} doc
 * @param {Window} win
 * @returns {number} 0~1，采样失败返回 0.2（深色主题的常见值）
 */
export function sampleBackgroundLuminance(doc, win) {
  const s = sampleBackground(doc, win);
  return s.luminance;
}

/**
 * 采样背景，并尽量拿到真实颜色（用于"按当前主题取色"）。
 * @returns {{luminance:number, color:string}} color 为 '' 表示没采到
 */
export function sampleBackground(doc, win) {
  const DEFAULT = { luminance: 0.2, color: '' };
  try {
    if (!doc || !doc.body) return DEFAULT;

    // body / 聊天区的实色背景最准
    const chat = doc.getElementById?.('chat');
    for (const el of [chat, doc.body]) {
      if (!el) continue;
      const raw = win.getComputedStyle(el).backgroundColor || '';
      if (/transparent/.test(raw)) continue;
      const alpha = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(raw);
      if (alpha && Number(alpha[1]) < 0.5) continue;
      const rgb = parseColor(raw);
      if (rgb) return { luminance: relativeLuminance(rgb), color: toHex(rgb) };
    }

    const w = win.innerWidth || doc.documentElement.clientWidth || 800;
    const h = win.innerHeight || doc.documentElement.clientHeight || 600;
    const points = [
      [w * 0.5, h * 0.5],
      [w * 0.25, h * 0.4],
      [w * 0.75, h * 0.4],
      [w * 0.5, h * 0.75],
      [w * 0.12, h * 0.2],
    ];

    const lums = [];
    let color = '';
    for (const [x, y] of points) {
      const el = doc.elementFromPoint(x, y);
      if (!el) continue;
      const found = walkUpForBackground(el, win);
      if (found) {
        lums.push(found.luminance);
        if (!color) color = found.color;
      }
      if (lums.length >= 3) break;
    }
    if (!lums.length) return DEFAULT;
    return { luminance: lums.reduce((a, b) => a + b, 0) / lums.length, color };
  } catch {
    return DEFAULT;
  }
}

function toHex([r, g, b]) {
  const h = (v) => clamp255(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 从元素向上找到第一个非透明背景，返回亮度与颜色 */
function walkUpForBackground(el, win) {
  let node = el;
  let guard = 0;
  while (node && node.nodeType === 1 && guard++ < 12) {
    const raw = win.getComputedStyle(node).backgroundColor || '';
    const rgb = parseColor(raw);
    const alpha = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(raw);
    if (rgb && (!alpha || Number(alpha[1]) >= 0.5)) {
      return { luminance: relativeLuminance(rgb), color: toHex(rgb) };
    }
    node = node.parentElement;
  }
  return null;
}

/** '#rrggbb' 提亮/压暗：amount > 0 变亮，< 0 变暗 */
export function shade(hex, amount) {
  const rgb = parseColor(hex);
  if (!rgb) return hex;
  const f = (c) => clamp255(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return toHex([f(rgb[0]), f(rgb[1]), f(rgb[2])]);
}
