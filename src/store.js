/**
 * store.js — 设置、直播间档案、观众名册、弹幕历史的存放处
 *
 * 设计原则（很重要，决定了这个插件"不绑卡"）：
 *   · 不做任何卡专属的假设，也不依赖任何第三方扩展（酒馆助手等）。
 *   · 所有数值都有默认值，且在面板里可调；代码里不出现"某张卡"的魔法数字。
 *   · 世界书规模从 0 条到几十万条，走的是同一套预算制流程，只是实测数字不同。
 *
 * 存储分层：
 *   global   设置（跟着浏览器走，跨卡跨聊天）
 *   profile  世界观档案（按卡/聊天为键缓存，换聊天不会串味）
 *   runtime  观众名册 + 弹幕历史 + 轮次计数（当前聊天，内存为主 + 会话级持久化）
 */

/** 存储键前缀，避免和别的扩展打架 */
const NS = 'stdanmaku';
const K_SETTINGS = `${NS}:settings:v1`;
const K_PROFILE = `${NS}:profile:v1`;
const K_RUNTIME = `${NS}:runtime:v1`;

/** 档案/名册缓存条数上限，防止时间长了撑爆 localStorage */
const PROFILE_CACHE_MAX = 40;

/* ───────────── 默认设置 ───────────── */

export function defaultSettings() {
  return {
    version: 1,

    /* 总开关 */
    enabled: true,
    liveMode: false, // 直播模式：关=角色不知道有弹幕（纯给你看）；开=把弹幕以极短注入告诉角色
    autoGenerate: true, // 每 N 轮自动出一批
    everyNRounds: 1,

    /* 批次 */
    count: 15, // 每批条数

    /* 剧情关联 */
    contextRounds: 2, // 出弹幕前读最近几轮正文（0 = 不读，纯世界观）
    contextCharBudget: 6000, // 送进弹幕 API 的正文总字数上限
    historyKeep: 10, // 弹幕历史保留轮数（内存）
    skipOpening: true, // 开场白（0 楼）不出弹幕：那时还没剧情，观众没什么可说的

    /* 世界书扫描 */
    scan: {
      sources: null, // null = 自动（当前卡绑定的 + 全局开启的）；数组 = 手动指定世界书名
      followCard: true, // 换卡时自动切回"跟随这张卡绑定的世界书"（手动勾选不会被带到别的卡上）
      entryCharBudget: 40000, // 取样预算：从世界书里最多读多少字
      commentOnly: false, // true = 只拿条目名/备注做索引，不读正文（极省，但档案会浅）
      summaryCharBudget: 1200, // 总结后的档案字数上限
      includeDisabled: false, // 是否把停用的条目也算进索引
    },

    /* 观众 */
    audience: {
      poolSize: 10, // 生成名册时固定 ID 的数量
      activePerBatch: 6, // 每批里固定 ID 最多露脸几个
      fourthWall: 20, // 破次元度 0~100：0 完全本土化，100 大量现实网络梗
    },

    /* API */
    api: {
      route: 'st', // 'st' = 走酒馆后端（能复用酒馆里已存的 key）；'direct' = 直连自填地址
      sourceMode: 'auto', // 'auto' = 跟随酒馆当前连接（推荐）；'fixed' = 固定用下面这个源
      source: 'openai', // sourceMode='fixed' 时生效
      proxyPreset: '', // 酒馆代理预设名（填了就优先用它）
      reverseProxy: '', // 覆盖地址（走酒馆后端时用）
      model: '', // 留空 = 用酒馆当前模型 / 直连必须填
      temperature: 1.05, // 弹幕需要发散，默认比正文高
      maxTokens: 2000,
      useJsonSchema: true, // 支持的话用结构化输出，更稳
      timeoutMs: 120000,

      direct: {
        baseUrl: '', // 例：http://127.0.0.1:1234/v1
        apiKey: '',
        model: '',
        extraHeaders: '', // 每行一条 Key: Value
      },
    },

    /* 注入（仅直播模式开启时生效） */
    injection: {
      depth: 4,
      maxChars: 320, // 注入正文的字符上限，硬上限
      sampleCount: 4, // 注入里附带几条弹幕样本
    },

    /* 外观 */
    appearance: {
      frameEnabled: true,
      frameBackground: 'linear-gradient(100deg, #2b3a67 0%, #3f5b8b 38%, #6d4f8f 68%, #8f5f7a 100%)',
      frameBgTouched: false, // 用户是否手动改过弹幕框背景（改过就不再用"按主题取样"覆盖）
      frameHeight: 148,
      speed: 110, // px/s
      fontSize: 15,
      gap: 16, // 同轨最小间隔 px
      opacity: 1,
      showMeta: true, // 显示轨道序号（楼层号）
      keepStatic: true, // 播完后留下一份静态列表，方便回看
      overlayEnabled: true, // 悬浮层默认开：它浮在上面，不占正文版面
      overlayRect: { x: 0.06, y: 0.08, w: 0.88, h: 0.18 }, // 相对视口，拖动/缩放后记忆
      overlayOpacity: 0.35, // 悬浮层整体不透明度（整层一起变，含标题栏与弹幕）
      overlayFade: true, // 每批播完自动淡出
    },

    /* 调试 */
    debug: false,
    seedDemo: false, // 面板里的"本地预览"用假数据渲染，不花 API
  };
}

/* ───────────── 工具 ───────────── */

export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return clone(base);
  if (Array.isArray(base) || Array.isArray(patch)) return clone(patch);
  if (typeof base !== 'object' || typeof patch !== 'object') return clone(patch);
  const out = clone(base);
  for (const k of Object.keys(patch)) {
    out[k] = k in out ? deepMerge(out[k], patch[k]) : clone(patch[k]);
  }
  return out;
}

export function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

export function num(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (typeof min === 'number') out = Math.max(min, out);
  if (typeof max === 'number') out = Math.min(max, out);
  return out;
}

export function clamp01(v, fallback = 0) {
  return num(v, fallback, 0, 1);
}

export function asBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/* ───────────── 设置读写 ───────────── */

/**
 * @param {Storage} storage
 * @param {any} [raw] 已解析的设置对象（可选，测试用）
 */
export function loadSettings(storage, raw) {
  let stored = raw;
  if (stored === undefined) {
    try {
      stored = JSON.parse(storage.getItem(K_SETTINGS) || 'null');
    } catch {
      stored = null;
    }
  }
  const merged = deepMerge(defaultSettings(), stored || {});
  return normalizeSettings(merged);
}

export function saveSettings(storage, settings) {
  try {
    storage.setItem(K_SETTINGS, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** 把设置里的数字夹到合法范围，防止手改/坏数据把 UI 搞崩 */
export function normalizeSettings(s) {
  // 先兜底补全结构，再夹范围 —— 这样半截的设置（外部写入、旧版本、测试）也不会炸
  const out = deepMerge(defaultSettings(), s || {});
  out.enabled = asBool(out.enabled, true);
  out.liveMode = asBool(out.liveMode, false);
  out.autoGenerate = asBool(out.autoGenerate, true);
  out.everyNRounds = num(out.everyNRounds, 1, 1, 50);
  out.count = num(out.count, 15, 1, 60);
  out.contextRounds = num(out.contextRounds, 2, 0, 20);
  out.contextCharBudget = num(out.contextCharBudget, 6000, 0, 200000);
  out.historyKeep = num(out.historyKeep, 10, 1, 200);
  out.skipOpening = asBool(out.skipOpening, true);

  out.scan.entryCharBudget = num(out.scan.entryCharBudget, 40000, 0, 2000000);
  out.scan.summaryCharBudget = num(out.scan.summaryCharBudget, 1200, 100, 20000);
  out.scan.commentOnly = asBool(out.scan.commentOnly, false);
  out.scan.includeDisabled = asBool(out.scan.includeDisabled, false);
  out.scan.followCard = asBool(out.scan.followCard, true);
  if (!Array.isArray(out.scan.sources)) out.scan.sources = null;

  out.audience.poolSize = num(out.audience.poolSize, 10, 0, 60);
  out.audience.activePerBatch = num(out.audience.activePerBatch, 6, 0, 60);
  out.audience.fourthWall = num(out.audience.fourthWall, 20, 0, 100);

  if (!['st', 'direct'].includes(out.api.route)) out.api.route = 'st';
  if (!['auto', 'fixed'].includes(out.api.sourceMode)) out.api.sourceMode = 'auto';
  out.api.temperature = num(out.api.temperature, 1.05, 0, 2);
  out.api.maxTokens = num(out.api.maxTokens, 2000, 64, 32000);
  out.api.timeoutMs = num(out.api.timeoutMs, 120000, 5000, 600000);
  out.api.useJsonSchema = asBool(out.api.useJsonSchema, true);
  out.api.model = String(out.api.model || '');
  out.api.source = String(out.api.source || 'custom');
  out.api.proxyPreset = String(out.api.proxyPreset || '');
  out.api.reverseProxy = String(out.api.reverseProxy || '');
  out.api.direct = out.api.direct || {};
  out.api.direct.baseUrl = String(out.api.direct.baseUrl || '');
  out.api.direct.apiKey = String(out.api.direct.apiKey || '');
  out.api.direct.model = String(out.api.direct.model || '');
  out.api.direct.extraHeaders = String(out.api.direct.extraHeaders || '');

  out.injection.depth = num(out.injection.depth, 4, 0, 100);
  out.injection.maxChars = num(out.injection.maxChars, 320, 40, 4000);
  out.injection.sampleCount = num(out.injection.sampleCount, 4, 0, 12);

  out.appearance.speed = num(out.appearance.speed, 110, 20, 900);
  out.appearance.fontSize = num(out.appearance.fontSize, 15, 8, 48);
  out.appearance.frameHeight = num(out.appearance.frameHeight, 148, 48, 600);
  out.appearance.gap = num(out.appearance.gap, 16, 0, 200);
  out.appearance.opacity = clamp01(out.appearance.opacity, 1);
  out.appearance.overlayOpacity = num(out.appearance.overlayOpacity, 0.35, 0.02, 1);
  out.appearance.frameBgTouched = asBool(out.appearance.frameBgTouched, false);
  out.appearance.frameEnabled = asBool(out.appearance.frameEnabled, true);
  out.appearance.overlayEnabled = asBool(out.appearance.overlayEnabled, true);
  out.appearance.showMeta = asBool(out.appearance.showMeta, true);
  out.appearance.keepStatic = asBool(out.appearance.keepStatic, true);
  out.appearance.overlayFade = asBool(out.appearance.overlayFade, true);
  out.appearance.frameBackground = String(out.appearance.frameBackground || defaultSettings().appearance.frameBackground);

  const r = out.appearance.overlayRect || {};
  out.appearance.overlayRect = {
    x: clamp01(r.x, 0.06),
    y: clamp01(r.y, 0.08),
    w: num(r.w, 0.88, 0.15, 1),
    h: num(r.h, 0.2, 0.08, 1),
  };

  out.debug = asBool(out.debug, false);
  out.seedDemo = asBool(out.seedDemo, false);
  return out;
}

/* ───────────── 世界观档案 ───────────── */

export function emptyProfile() {
  return {
    generatedAt: 0,
    sources: [], // 用了哪些世界书
    stats: {
      books: 0,
      entriesTotal: 0,
      charsTotal: 0,
      entriesRead: 0,
      charsRead: 0,
      summaryChars: 0,
    },
    data: blankProfileData(),
  };
}

/**
 * 档案的字段是"任何世界观都成立"的中性槽位，不预设题材。
 * hasWorldbook=false 时，这些槽位会被"边看边学"的正文观察逐步填上。
 */
export function blankProfileData() {
  return {
    worldName: '',
    stage: '', // 舞台/年代/世界运转的基本样貌
    factions: '', // 势力、阵营、群像构成
    naming: '', // 称呼体系：观众怎么称呼台上的人、怎么自称
    lexicon: '', // 本土词汇、专有名词、该世界特有的说法
    manner: '', // 说话的语气与节奏（仍然是"直播弹幕"这个体裁，只是措辞本土化）
    taboos: '', // 该世界观里不该出现的说法/禁区
    interests: '', // 这批观众会为什么兴奋、会挑什么刺
    channelName: '', // 直播间名字（面板与弹幕框标题用）
    hasWorldbook: false,
  };
}

export function profileKey(cardName, chatId, bookSignature) {
  return [cardName || '(无卡)', chatId || '(无聊天)', bookSignature || ''].join(' | ');
}

export function loadProfileCache(storage) {
  try {
    const raw = JSON.parse(storage.getItem(K_PROFILE) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function getCachedProfile(storage, key) {
  const cache = loadProfileCache(storage);
  const hit = cache[key];
  if (!hit || !hit.data) return null;
  return { ...emptyProfile(), ...hit, data: { ...blankProfileData(), ...hit.data } };
}

export function putCachedProfile(storage, key, profile) {
  const cache = loadProfileCache(storage);
  cache[key] = profile;
  const keys = Object.keys(cache);
  if (keys.length > PROFILE_CACHE_MAX) {
    // 丢最旧的
    keys
      .sort((a, b) => (cache[a]?.generatedAt || 0) - (cache[b]?.generatedAt || 0))
      .slice(0, keys.length - PROFILE_CACHE_MAX)
      .forEach((k) => delete cache[k]);
  }
  try {
    storage.setItem(K_PROFILE, JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

export function clearProfileCache(storage) {
  try {
    storage.removeItem(K_PROFILE);
  } catch {
    /* noop */
  }
}

/* ───────────── 运行时状态（名册 / 历史 / 轮次） ───────────── */

export function createRuntime() {
  return {
    batchNo: 0, // 已生成批次
    roundNo: 0, // 已处理轮次（用于 everyNRounds）
    viewers: [], // 观众名册
    viewersProfileKey: '', // 名册是按哪个档案生成的
    viewersCardName: '', // 名册属于哪张卡（换卡就必须重做，否则会串味）
    history: [], // [{ batchNo, anchorId, at, items:[{id,text,tone,ref,color}], played:false }]
    lastInjection: '',
    lastError: '',
    lastRequest: null,
  };
}

export function loadRuntime(storage) {
  try {
    const raw = JSON.parse(storage.getItem(K_RUNTIME) || 'null');
    if (!raw || typeof raw !== 'object') return createRuntime();
    const rt = createRuntime();
    rt.batchNo = num(raw.batchNo, 0, 0, 1e9);
    rt.roundNo = num(raw.roundNo, 0, 0, 1e9);
    rt.viewers = Array.isArray(raw.viewers) ? raw.viewers : [];
    rt.viewersProfileKey = String(raw.viewersProfileKey || '');
    rt.viewersCardName = String(raw.viewersCardName || '');
    rt.history = Array.isArray(raw.history) ? raw.history : [];
    rt.lastInjection = String(raw.lastInjection || '');
    return rt;
  } catch {
    return createRuntime();
  }
}

export function saveRuntime(storage, rt, historyKeep) {
  try {
    const keep = Math.max(1, Math.floor(historyKeep || 10));
    const payload = {
      batchNo: rt.batchNo,
      roundNo: rt.roundNo,
      viewers: rt.viewers,
      viewersProfileKey: rt.viewersProfileKey,
      viewersCardName: rt.viewersCardName || '',
      history: rt.history.slice(-keep),
      lastInjection: rt.lastInjection || '',
    };
    storage.setItem(K_RUNTIME, JSON.stringify(payload));
    return true;
  } catch {
    // 超配额时退化成"只存名册"，历史丢了不影响功能
    try {
      storage.setItem(
        K_RUNTIME,
        JSON.stringify({
          batchNo: rt.batchNo,
          roundNo: rt.roundNo,
          viewers: rt.viewers,
          viewersProfileKey: rt.viewersProfileKey,
          viewersCardName: rt.viewersCardName || '',
          history: [],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

export function pushHistory(rt, batch, keep) {
  rt.history.push(batch);
  const k = Math.max(1, Math.floor(keep || 10));
  if (rt.history.length > k) rt.history = rt.history.slice(-k);
  return rt.history;
}

/* 供测试与外部使用 */
export const _internal = { NS, K_SETTINGS, K_PROFILE, K_RUNTIME, PROFILE_CACHE_MAX };
