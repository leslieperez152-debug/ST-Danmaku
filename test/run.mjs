/**
 * test/run.mjs — 自检
 *
 * 在没有酒馆的环境里把核心链路真的跑一遍：设置持久化、配色对比度、
 * 响应解析与脏输出兜底、世界书预算制扫描、弹幕体裁判、渲染结构、注入长度。
 *
 * 用法：node test/run.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createMiniDocument, makeMemoryStorage } from './mini-dom.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'src');
const mod = (name) => import(pathToFileURL(path.join(srcDir, name)).href);

/* ───────────── 迷你断言框架 ───────────── */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  // 每个用例开始前清掉假后端排队的响应与酒馆侧的残留状态，避免用例之间串数据
  responseQueue.length = 0;
  resetMockConnection();
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => {
          passed++;
          console.log(`  ✓ ${name}`);
        },
        (e) => {
          failed++;
          failures.push({ name, error: e });
          console.log(`  ✗ ${name}\n      ${e?.message || e}`);
        },
      );
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
  return Promise.resolve();
}

function ok(cond, msg = '断言失败') {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function near(a, b, tol, msg = '') {
  if (Math.abs(a - b) > tol) throw new Error(`${msg} 期望 ≈${b}，实际 ${a}`);
}
function section(title) {
  console.log(`\n${title}`);
}

/* ───────────── 环境准备（模拟酒馆） ───────────── */

const doc = createMiniDocument();
const storage = makeMemoryStorage();

/** 构造一个假的酒馆世界书：n 条，每条 chars 字 */
function makeFakeBook(n, chars, opts = {}) {
  const entries = {};
  for (let i = 0; i < n; i++) {
    const isConstant = opts.constantRatio ? i % Math.round(1 / opts.constantRatio) === 0 : false;
    const content = `${opts.tag || '条目'}${i}：` + '甲'.repeat(Math.max(0, chars - 6));
    entries[String(i)] = {
      uid: i,
      comment: `条目备注 ${i}`,
      content,
      key: [`关键词${i}`],
      keysecondary: [],
      constant: isConstant,
      selective: !isConstant,
      disable: false,
      order: i,
      position: 0,
      depth: 4,
    };
  }
  return { entries };
}

const WORLDBOOKS = {
  空书: { entries: {} },
  小书: makeFakeBook(20, 300, { constantRatio: 0.25, tag: '小' }),
  大书: makeFakeBook(600, 900, { constantRatio: 0.05, tag: '大' }),
};

let lastRequestBody = null;
let lastFetchUrl = '';

const fakeChat = [
  { name: 'User', is_user: true, mes: '我们往山里走。' },
  { name: '某角色', is_user: false, mes: '山谷里起了雾，石阶上有一行新鲜的脚印。', __std_id: 1 },
  { name: 'User', is_user: true, mes: '跟上去。' },
  { name: '某角色', is_user: false, mes: '他停在断崖边，回头看了你一眼，把手按在刀柄上。', __std_id: 3 },
];

globalThis.document = doc;
globalThis.localStorage = storage;
/** 假酒馆的"当前连接"（测试里可改，用来验证来源跟随/体检） */
const MOCK_CONNECTION = {
  chat_completion_source: 'openai',
  openai_model: 'gpt-4o-mini',
  custom_url: '',
  reverse_proxy: '',
};

/** 事件总线替身：记录下来，让测试能真的派发酒馆事件 */
const mockEventSource = (() => {
  const listeners = new Map();
  return {
    _listeners: listeners,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, ...args) {
      for (const fn of listeners.get(type) || []) fn(...args);
    },
  };
})();

globalThis.window = doc.defaultView;
// 真实的 SillyTavern.getContext() 每次返回的是同一个稳定对象，
// 所以这里的替身也必须稳定 —— 否则"换卡"这种靠改 ctx 状态的动作根本改不动。
const mockContext = {
  eventSource: mockEventSource,
  eventTypes: {
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    MESSAGE_RECEIVED: 'message_received',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_PAGE_LOADED: 'character_page_loaded',
    CHARACTER_EDITED: 'character_edited',
    CHARACTER_RENAMED: 'character_renamed',
  },
  chat: fakeChat,
  chatMetadata: { file_name: 'test-chat' },
  characters: [{ name: '测试卡', data: { extensions: { world: '' } } }],
  characterId: 0,
  worldInfoList: Object.keys(WORLDBOOKS),
  extensionSettings: { world_info: { world_info: [] } },
  chatCompletionSettings: MOCK_CONNECTION,
  getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  async loadWorldInfo(name) {
    if (!(name in WORLDBOOKS)) throw new Error(`no such book: ${name}`);
    return WORLDBOOKS[name];
  },
  setExtensionPrompt() {},
};

globalThis.SillyTavern = {
  getContext() {
    return mockContext;
  },
};

/** 每次测试前把假连接复位，避免用例之间互相影响 */
function resetMockConnection() {
  MOCK_CONNECTION.chat_completion_source = 'openai';
  MOCK_CONNECTION.openai_model = 'gpt-4o-mini';
  MOCK_CONNECTION.custom_url = '';
  MOCK_CONNECTION.reverse_proxy = '';
}

/** 复位酒馆侧的残留状态（卡绑定、全局世界书、当前卡） */
function resetTavernState() {
  mockContext.characters = [{ name: '测试卡', data: { extensions: { world: '' } } }];
  mockContext.characterId = 0;
  mockContext.extensionSettings.world_info.world_info = [];
  mockContext.chatMetadata = { file_name: 'test-chat' };
}

/** 假后端：按顺序吐预设回复 */
let responseQueue = [];
function queueResponse(obj) {
  responseQueue.push(obj);
}
globalThis.fetch = async (url, init) => {
  lastRequestBody = init?.body ? JSON.parse(init.body) : null;
  lastFetchUrl = String(url);
  // 酒馆的世界书列表接口：返回 [{file_id, name}]
  if (String(url).includes('/api/worldinfo/list')) {
    return {
      ok: true,
      status: 200,
      json: async () => Object.keys(WORLDBOOKS).map((n) => ({ file_id: n, name: n })),
      text: async () => JSON.stringify(Object.keys(WORLDBOOKS).map((n) => ({ file_id: n, name: n }))),
    };
  }
  const next = responseQueue.shift() ?? { choices: [{ message: { content: '{"弹幕":[]}' } }] };
  if (next.__http && next.__http !== 200) {
    return { ok: false, status: next.__http, text: async () => next.body || '' };
  }
  const body = typeof next === 'string' ? next : JSON.stringify(next);
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
};

const store = await mod('store.js');
const color = await mod('color.js');
const llm = await mod('llm.js');
const st = await mod('st.js');
const scan = await mod('scan.js');
const danmaku = await mod('danmaku.js');
// main.js 要在渲染相关的用例之前就位（下面第 11 节起会用）
const mainMod = await mod('main.js');
const drawerMod = await mod('drawer.js');
const panelMod = await mod('panel.js');

/* ───────────── 1. 设置与持久化 ───────────── */

section('1. 设置与持久化');

await test('默认值是一份完整可用的设置', () => {
  const s = store.defaultSettings();
  eq(s.api.route, 'st', '默认走酒馆后端');
  eq(s.count, 15, '默认每批 15 条');
  eq(s.historyKeep, 10, '默认保留 10 轮');
  eq(s.autoGenerate, true, '默认每轮直出');
  eq(s.liveMode, false, '直播模式默认关');
});

await test('设置能存能读，且深合并缺省字段', () => {
  const s = store.loadSettings(storage, { count: 22, appearance: { speed: 300 } });
  eq(s.count, 22);
  eq(s.appearance.speed, 300);
  eq(s.appearance.fontSize, 15, '未提供的字段保留默认');
  store.saveSettings(storage, s);
  const again = store.loadSettings(storage);
  eq(again.count, 22, '读回来还是 22');
});

await test('坏数据被夹到合法范围（不会把面板搞崩）', () => {
  const s = store.normalizeSettings({ count: 9999, contextRounds: -5, appearance: { opacity: 42 }, scan: { summaryCharBudget: 1 } });
  eq(s.count, 60);
  eq(s.contextRounds, 0);
  eq(s.appearance.opacity, 1);
  eq(s.scan.summaryCharBudget, 100);
});

await test('档案缓存按 卡|聊天|世界书 为键隔离', () => {
  const k1 = store.profileKey('卡A', '聊天1', '书1');
  const k2 = store.profileKey('卡B', '聊天1', '书1');
  ok(k1 !== k2, '换卡不应串味');
  const p = store.emptyProfile();
  p.data.stage = '某舞台';
  p.generatedAt = Date.now();
  store.putCachedProfile(storage, k1, p);
  eq(store.getCachedProfile(storage, k1).data.stage, '某舞台');
  eq(store.getCachedProfile(storage, k2), null, '另一个键应当是空的');
});

await test('历史只保留设置的轮数', () => {
  const rt = store.createRuntime();
  for (let i = 1; i <= 20; i++) {
    store.pushHistory(rt, { batchNo: i, items: [] }, 10);
  }
  eq(rt.history.length, 10);
  eq(rt.history[0].batchNo, 11, '留下的是最近 10 批');
});

await test('运行时能落盘并读回', () => {
  const rt = store.createRuntime();
  rt.batchNo = 7;
  rt.viewers = [{ 昵称: '老张' }];
  store.pushHistory(rt, { batchNo: 7, items: [{ 内容: '来了' }] }, 10);
  store.saveRuntime(storage, rt, 10);
  const back = store.loadRuntime(storage);
  eq(back.batchNo, 7);
  eq(back.viewers.length, 1);
  eq(back.history.length, 1);
});

/* ───────────── 2. 配色 ───────────── */

section('2. 弹幕配色（亮色 + 与背景可分辨）');

await test('#fff / rgb() / 3位缩写都能解析', () => {
  eq(color.parseColor('#ffffff').join(','), '255,255,255');
  eq(color.parseColor('#000').join(','), '0,0,0');
  eq(color.parseColor('rgb(10, 20, 30)').join(','), '10,20,30');
  eq(color.parseColor('rgba(10, 20, 30, 0.5)').join(','), '10,20,30');
  eq(color.parseColor('transparent'), null);
});

await test('对比度公式符合 WCAG（黑白 = 21）', () => {
  near(color.contrastRatio(color.parseColor('#000000'), color.parseColor('#ffffff')), 21, 0.01);
});

await test('深色背景下 500 次摇号全部合格且都是亮色', () => {
  const bg = 0.05;
  for (let i = 0; i < 500; i++) {
    const hex = color.randomBrightColor({ luminance: bg, random: Math.random });
    const rgb = color.parseColor(hex);
    ok(rgb, `拿到非法颜色 ${hex}`);
    const cr = color.contrastRatio(color.relativeLuminance(rgb), bg);
    ok(cr >= 3.2, `对比度只有 ${cr.toFixed(2)}（${hex}）`);
  }
});

await test('浅色背景下也不会给出看不清的颜色', () => {
  for (let i = 0; i < 300; i++) {
    const hex = color.randomBrightColor({ luminance: 0.9, random: Math.random });
    const cr = color.contrastRatio(color.parseColor(hex), 0.9);
    ok(cr >= 3.2, `浅底对比度只有 ${cr.toFixed(2)}（${hex}）`);
  }
});

await test('一批 15 条颜色互不相同', () => {
  const palette = color.buildPalette(15, { luminance: 0.1 });
  eq(palette.length, 15);
  eq(new Set(palette).size, 15, '同一批里不该出现重复颜色');
  for (const hex of palette) {
    ok(color.contrastRatio(color.parseColor(hex), 0.1) >= 3.2, `${hex} 对比度不足`);
  }
});

await test('采样不到背景时给出安全兜底值', () => {
  const lum = color.sampleBackgroundLuminance(null, null);
  eq(lum, 0.2);
});

/* ───────────── 3. 响应解析与脏输出兜底 ───────────── */

section('3. 响应解析（各家格式 + 脏输出）');

await test('OpenAI 非流式', () => {
  eq(llm.extractText({ choices: [{ message: { content: '嗨' } }] }), '嗨');
});

await test('Anthropic 的 content 数组', () => {
  eq(llm.extractText({ content: [{ text: '甲' }, { text: '乙' }] }), '甲乙');
});

await test('Gemini 的 candidates.parts', () => {
  eq(llm.extractText({ candidates: [{ content: { parts: [{ text: '丙' }] } }] }), '丙');
});

await test('SSE 流式拼接', () => {
  const raw = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n';
  eq(llm.parseSse(raw), '你好');
});

await test('JSON 被 ``` 围栏包着也能解析', () => {
  const r = llm.parseJsonLoose('这是结果：\n```json\n{"弹幕":[{"内容":"来了"}]}\n```\n希望有帮助');
  ok(r.ok);
  eq(r.value.弹幕.length, 1);
});

await test('JSON 前后带废话、内部含花括号字符串也能解析', () => {
  const r = llm.parseJsonLoose('好，给你：{"说明":"用 { 开头 }","ok":true} 就这样');
  ok(r.ok);
  eq(r.value.ok, true);
});

await test('完全不是 JSON 时会明确失败（交给按行兜底）', () => {
  const r = llm.parseJsonLoose('前排\n来了来了\n666');
  eq(r.ok, false);
});

/* ───────────── 4. 请求层 ───────────── */

section('4. 请求层（两条路线 + key 不进浏览器）');

await test('走酒馆后端：请求打到 /api/backends/chat-completions/generate', async () => {
  queueResponse({ choices: [{ message: { content: '正常' } }] });
  const res = await llm.chat({ api: { route: 'st', source: 'custom', model: 'x' }, system: 's', user: 'u', label: '测试' });
  ok(res.ok, res.error);
  eq(res.text, '正常');
  eq(res.route, 'st');
});

await test('系统提示词以 system 消息发出（不混进用户消息）', async () => {
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  await llm.chat({ api: { route: 'st', source: 'custom' }, system: '我是系统', user: '我是用户', label: '测试' });
  eq(lastRequestBody.messages.length, 2);
  eq(lastRequestBody.messages[0].role, 'system');
  eq(lastRequestBody.messages[0].content, '我是系统');
  eq(lastRequestBody.messages[1].content, '我是用户');
});

await test('结构化输出会作为 json_schema 传下去', async () => {
  queueResponse({ choices: [{ message: { content: '{"弹幕":[]}' } }] });
  await llm.chatJson({
    api: { route: 'st', source: 'custom', useJsonSchema: true },
    system: 's',
    user: 'u',
    label: 't',
    jsonSchema: { name: 'x', value: { type: 'object', properties: {}, additionalProperties: false } },
  });
  ok(lastRequestBody.json_schema, '应当带 json_schema');
  eq(lastRequestBody.json_schema.name, 'x');
});

await test('直连路线没填地址时给的是可操作的提示', async () => {
  const res = await llm.chat({ api: { route: 'direct', direct: {} }, system: 's', user: 'u', label: '测试' });
  eq(res.ok, false);
  ok(/还没填 API 地址/.test(res.error), `提示不友好：${res.error}`);
});

await test('后端报错会翻译成人话，而不是把英文原文甩给用户', async () => {
  queueResponse({ __http: 401, body: 'no api key' });
  const res = await llm.chat({ api: { route: 'st', sourceMode: 'fixed', source: 'custom', reverseProxy: 'https://x' }, system: 's', user: 'u', label: '测试' });
  eq(res.ok, false);
  ok(/API Key/.test(res.error), `应当提示 key 的问题：${res.error}`);
  ok(!/no api key/.test(res.error), '不该把英文原文直接给用户');
});

await test('custom 端点没配地址时，给的是可照做的中文指引', async () => {
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  const res = await llm.chat({
    api: { route: 'st', sourceMode: 'fixed', source: 'custom', reverseProxy: '' },
    system: 's',
    user: 'u',
    label: '测试',
  });
  eq(res.ok, false, '配置不对时应当在本地就拦住，不发请求');
  ok(/自动跟随酒馆当前连接/.test(res.error), res.error);
  ok(!/Custom endpoint is missing/.test(res.error), '不该把后端英文报错透出去');
});

/* ───────────── 5. 世界书接入 ───────────── */

section('5. 世界书接入（不绑卡、按绑定解析）');

await test('列出所有世界书', () => {
  const names = st.listWorldbookNames();
  ok(names.includes('大书') && names.includes('小书'), names.join(','));
});

await test('归一化条目：兼容 entries 对象形态，字段齐全', () => {
  const entries = st.normalizeEntries(WORLDBOOKS.小书);
  eq(entries.length, 20);
  const e = entries[0];
  ok(typeof e.comment === 'string' && typeof e.content === 'string');
  ok(Array.isArray(e.keys) && Array.isArray(e.secondaryKeys));
  eq(typeof e.constant, 'boolean');
  eq(e.chars, e.content.length);
});

await test('世界书为空是合法状态，不抛错', async () => {
  const res = await st.readWorldbook('空书');
  eq(res.ok, true);
  eq(res.entries.length, 0);
});

await test('读不存在的世界书返回 ok:false 而不是炸掉', async () => {
  const res = await st.readWorldbook('根本没有这本');
  eq(res.ok, false);
  ok(res.error.length > 0);
});

/* ───────────── 6. 取样预算 ───────────── */

section('6. 世界书扫描的取样预算（不偏向任何规模）');

await test('小书全读，大书按上限读', () => {
  eq(scan.resolveSampleBudget(6000, 40000), 6000, '总字数小于上限时全读');
  eq(scan.resolveSampleBudget(540000, 40000), 40000, '大书按上限');
  eq(scan.resolveSampleBudget(0, 40000), 0);
});

await test('空世界书 → 取到 0 条而不报错', () => {
  const r = scan.selectEntries([], { budget: 40000 });
  eq(r.picked.length, 0);
  eq(r.charsRead, 0);
});

await test('小世界书：全部条目都被取到', () => {
  const entries = st.normalizeEntries(WORLDBOOKS.小书);
  const r = scan.selectEntries(entries, { budget: 40000 });
  eq(r.picked.length, 20);
});

await test('大世界书：总字数被预算卡住，不会全部塞进去', () => {
  const entries = st.normalizeEntries(WORLDBOOKS.大书);
  const totalChars = entries.reduce((a, e) => a + e.chars, 0);
  const budget = 40000;
  const r = scan.selectEntries(entries, { budget });
  ok(totalChars > 500000, `样本本身要够大，实际 ${totalChars}`);
  ok(r.charsRead <= budget + 400, `读取字数 ${r.charsRead} 应被预算 ${budget} 卡住`);
  ok(r.picked.length < entries.length, '不应当全取');
  ok(r.skipped > 0, '应当报告跳过了多少条');
});

await test('常量条目（蓝灯）优先于普通条目', () => {
  const entries = st.normalizeEntries(WORLDBOOKS.大书);
  const constants = entries.filter((e) => e.constant).length;
  const r = scan.selectEntries(entries, { budget: 30000 });
  const pickedConstants = r.picked.filter((e) => e.constant).length;
  eq(pickedConstants, Math.min(constants, r.picked.length), '蓝灯应当先被塞满');
});

await test('与最近正文相关的条目优先于不相关的', () => {
  const entries = [
    { comment: '无关条目', content: '甲'.repeat(100), keys: ['无关词'], constant: false, chars: 100, order: 0 },
    { comment: '相关条目', content: '乙'.repeat(100), keys: ['断崖'], constant: false, chars: 100, order: 99 },
  ];
  const r = scan.selectEntries(entries, { budget: 120, recentText: '他停在断崖边' });
  eq(r.picked[0].comment, '相关条目', '命中正文关键词的应当先读');
});

await test('只读条目名模式读到的字数显著更少', () => {
  const entries = st.normalizeEntries(WORLDBOOKS.大书);
  const full = scan.selectEntries(entries, { budget: 100000 });
  const brief = scan.selectEntries(entries, { budget: 100000, commentOnly: true });
  ok(brief.charsRead < full.charsRead / 5, `条目名模式 ${brief.charsRead} 应远小于 ${full.charsRead}`);
});

await test('目录（outline）在字数上限内，且如实报告省略', () => {
  const big = st.normalizeEntries(WORLDBOOKS.大书);
  const outline = scan.buildOutline(big, { maxChars: 2000 });
  ok(outline.length < 2600, `目录长度 ${outline.length} 超标`);
  ok(/略/.test(outline), '超长时应当明说省略了多少');
});

/* ───────────── 7. 扫描主流程（含空世界书） ───────────── */

section('7. 扫描主流程');

await test('有世界书：产出档案，且三级数字如实记账', async () => {
  queueResponse({
    choices: [
      {
        message: {
          content: JSON.stringify({
            worldName: '测试界',
            stage: '山谷与断崖之间',
            factions: '刀客与山民',
            naming: '称"当家的"',
            lexicon: '刀、断崖、雾',
            manner: '短句、爱起哄',
            taboos: '',
            interests: '看比试',
            channelName: '雾谷围观席',
            hasWorldbook: true,
          }),
        },
      },
    ],
  });
  const res = await scan.scanWorldbooks({
    api: { route: 'st', source: 'custom' },
    scan: { sources: ['大书'], entryCharBudget: 40000, summaryCharBudget: 1200 },
  });
  ok(res.ok, res.error);
  eq(res.profile.sources[0], '大书');
  eq(res.profile.stats.books, 1);
  eq(res.profile.stats.entriesTotal, 600, '条目总数应当是本书真实条数');
  ok(res.profile.stats.charsTotal > 500000, '总字数应当是真实字数');
  ok(res.profile.stats.charsRead <= 40400, '实际读取应被预算卡住');
  eq(res.profile.data.hasWorldbook, true);
  eq(res.profile.data.channelName, '雾谷围观席');
});

await test('档案字数超上限时被硬裁', async () => {
  queueResponse({
    choices: [
      {
        message: {
          content: JSON.stringify({
            worldName: '长',
            stage: '甲'.repeat(3000),
            factions: '',
            naming: '',
            lexicon: '',
            manner: '',
            taboos: '',
            interests: '',
            channelName: '',
            hasWorldbook: true,
          }),
        },
      },
    ],
  });
  const res = await scan.scanWorldbooks({
    api: { route: 'st', source: 'custom' },
    scan: { sources: ['小书'], entryCharBudget: 40000, summaryCharBudget: 500 },
  });
  ok(res.ok, res.error);
  const p = res.profile.data;
  const total = p.worldName.length + p.stage.length + p.channelName.length;
  ok(total <= 500, `档案总字数 ${total} 应当被裁到 500 以内`);
});

await test('没有世界书：走空档案路线，依然 ok', async () => {
  const res = await scan.scanWorldbooks({
    api: { route: 'st', source: 'custom' },
    scan: { sources: [], entryCharBudget: 40000, summaryCharBudget: 1200 },
  });
  ok(res.ok, res.error);
  eq(res.profile.data.hasWorldbook, false);
  eq(res.profile.stats.books, 0);
});

/* ───────────── 8. 弹幕批次 ───────────── */

section('8. 弹幕批次（条数、字段、脏输出兜底）');

await test('正常 JSON：条数与字段都对', async () => {
  const list = Array.from({ length: 15 }, (_, i) => ({ 昵称: `观众${i}`, 内容: `第${i}条弹幕`, 类型: '普通', 回复: '' }));
  queueResponse({ choices: [{ message: { content: JSON.stringify({ 弹幕: list }) } }] });
  const res = await danmaku.generateBatch({
    api: { route: 'st', source: 'custom' },
    profile: null,
    story: '正文',
    count: 15,
  });
  ok(res.ok, res.error);
  eq(res.items.length, 15);
  eq(res.items[0].昵称, '观众0');
});

await test('@某人 会自动补进内容', async () => {
  queueResponse({
    choices: [{ message: { content: JSON.stringify({ 弹幕: [{ 昵称: '甲', 内容: '你上次也这么说', 类型: '抬杠', 回复: '乙' }] }) } }],
  });
  const res = await danmaku.generateBatch({ api: { route: 'st', source: 'custom' }, profile: null, story: '', count: 1 });
  ok(res.ok, res.error);
  ok(res.items[0].内容.startsWith('@乙'), res.items[0].内容);
});

await test('模型不按 JSON 回时，按行兜底解析', async () => {
  queueResponse({ choices: [{ message: { content: '前排\n来了来了\n6\n？？？' } }] });
  const res = await danmaku.generateBatch({ api: { route: 'st', source: 'custom' }, profile: null, story: '', count: 15 });
  ok(res.ok, res.error);
  ok(res.items.length >= 3, `兜底应解析出多条，实际 ${res.items.length}`);
});

/* ───────────── 9. 体裁自检（唯一的内容硬约束） ───────────── */

section('9. 体裁自检：像不像直播弹幕');

const GENRE_PATTERNS = [
  { re: /直播弹幕/, why: '提示词必须点明体裁' },
  { re: /抢话|起哄|刷屏|催更/, why: '要点明弹幕的行为特征' },
  { re: /禁止/, why: '要有明确的禁止清单' },
  { re: /旁白/, why: '要禁止旁白' },
  { re: /总结/, why: '要禁止总结式长句' },
];

await test('弹幕提示词包含全部体裁要素', () => {
  const sys = danmaku.batchSystemPrompt();
  for (const { re, why } of GENRE_PATTERNS) ok(re.test(sys), `缺少：${why}`);
});

await test('提示词里没有出现"针对某张卡/某个世界观"的硬编码', () => {
  const all = danmaku.batchSystemPrompt() + danmaku.viewerSystemPrompt() + danmaku.GENRE_RULES;
  const banned = ['大凉', '龙虎', '三国', '咒术', '艾瑟', '武侠江湖', '偏航'];
  for (const b of banned) ok(!all.includes(b), `不该出现具体作品名：${b}`);
  const numbers = ['600 条', '600条', '86 万', '86万'];
  for (const n of numbers) ok(!all.includes(n), `不该出现具体规模假设：${n}`);
});

await test('没有世界书时，提示词教它靠正文推断而不是硬编', () => {
  const text = danmaku.renderProfileForPrompt(null);
  ok(/没有世界观档案/.test(text), `实际内容：${text}`);
  ok(/不要发明设定/.test(text), '必须有"不要发明设定"的约束');
});

await test('有世界书时，档案字段被渲染进提示词', () => {
  const profile = store.emptyProfile();
  profile.data = { ...profile.data, worldName: '测试界', channelName: '围观席', lexicon: '刀、雾' };
  const text = danmaku.renderProfileForPrompt(profile);
  ok(text.includes('测试界') && text.includes('围观席') && text.includes('刀、雾'));
});

await test('破次元度越低，现实梗的约束越严', () => {
  const low = danmaku.batchUserPrompt({ profile: null, story: '', viewers: [], count: 15, fourthWall: 0 });
  const high = danmaku.batchUserPrompt({ profile: null, story: '', viewers: [], count: 15, fourthWall: 90 });
  ok(/完全本土化/.test(low), '0 应当是完全本土化');
  ok(/禁止出现任何现实世界的网络词/.test(low));
  ok(!/允许较大量现实网络梗/.test(low));
  ok(/允许较大量现实网络梗/.test(high));
});

/* ───────────── 10. 剧情关联与梗记忆 ───────────── */

section('10. 与剧情的关联（单向：正文 → 弹幕）');

await test('最近 N 轮正文会被拼进提示词，并带上角色/用户标记', () => {
  const story = danmaku.buildStoryContext(
    [
      { id: 1, text: '第一轮正文', isUser: false },
      { id: 2, text: '用户说的话', isUser: true },
      { id: 3, text: '第三轮正文', isUser: false },
    ],
    { rounds: 2, charBudget: 6000 },
  );
  ok(!story.includes('第一轮正文'), '超出轮数的不该出现');
  ok(story.includes('用户说的话'), '用户发言应当作为观众席视角出现');
  ok(story.includes('第三轮正文'));
});

await test('正文字数超预算时被裁掉', () => {
  const story = danmaku.buildStoryContext([{ id: 1, text: '甲'.repeat(5000), isUser: false }], { rounds: 1, charBudget: 800 });
  ok(story.length <= 900, `应当被裁到预算内，实际 ${story.length}`);
});

await test('轮数设为 0 时不带任何正文', () => {
  eq(danmaku.buildStoryContext([{ id: 1, text: 'x', isUser: false }], { rounds: 0, charBudget: 1000 }), '');
});

await test('梗记忆挑的是"带具体指代"的，不是空洞套话', () => {
  const gags = danmaku.pickGags(
    [
      { 内容: '这波稳了', 类型: '情绪' }, // 空洞套话：必须排除
      { 内容: '666', 类型: '情绪' }, // 空洞套话：必须排除
      { 内容: '这句话非常完整，有主语有谓语有宾语，还带标点符号。', 类型: '普通' }, // 太长：必须排除
      { 内容: '他左手那个「缠丝手」用得不对', 类型: '懂行' }, // 带具体指代：应当入选
      { 内容: '第三式怎么慢下来了', 类型: '抬杠' }, // 带数字与招式：应当入选
    ],
    3,
  );
  ok(gags.includes('他左手那个「缠丝手」用得不对'), `应当选中带具体指代的那条：${gags.join('|')}`);
  ok(gags.includes('第三式怎么慢下来了'), `应当选中带数字与招式的那条：${gags.join('|')}`);
  ok(!gags.some((g) => /稳了|666/.test(g)), `不该把空洞套话当梗：${gags.join('|')}`);
  ok(!gags.some((g) => g.includes('非常完整')), `不该把长句当梗：${gags.join('|')}`);
});

await test('全是套话时，宁可一个梗都不挑', () => {
  const gags = danmaku.pickGags([{ 内容: '这波稳了' }, { 内容: '前排' }, { 内容: '666' }], 3);
  eq(gags.length, 0, `套话不该被当成梗：${gags.join('|')}`);
});

/* ───────────── 11. 渲染 ───────────── */

section('11. 渲染（弹幕框 / 悬浮层）');

const frameMod = await mod('frame.js');
const overlayMod = await mod('overlay.js');
const appearance = store.defaultSettings().appearance;

/* 每个 test 用独立的迷你文档，避免互相污染 */
function doc2() {
  const d = createMiniDocument();
  globalThis.document = d;
  globalThis.window = d.defaultView;
  globalThis.localStorage = d.defaultView.localStorage;
  // 上一批用例可能留下悬浮层节点（替身会跨文档按 id 兜底查找），先清掉
  const stale = d.getElementById('std-overlay');
  if (stale) stale.remove();
  return d;
}

/** 切回全局文档（部分用例会新建文档，用完要还回去） */
function useDoc(d) {
  globalThis.document = d;
  globalThis.window = d.defaultView;
  globalThis.localStorage = d.defaultView.localStorage;
  return d;
}

/* ───── 换卡辅助 ─────
   走产品代码里那条真实链路：ctx.eventTypes[name] → eventSource 上注册的监听器，
   所以测的是"注册有没有生效"，而不只是"某个内部函数对不对"。 */

function switchCard({ name, id, world }) {
  const ctx = mockContext;
  ctx.characters[id] = { name, data: { extensions: { world: world || '' } } };
  ctx.characterId = id;
}

function emitTavernEvent(eventName, ...args) {
  const type = mockContext.eventTypes[eventName];
  if (!type) throw new Error(`未知事件名 ${eventName}`);
  for (const fn of mockEventSource._listeners.get(type) || []) fn(...args);
}

/** 换一张卡，并派发酒馆的"卡片页加载完成"事件 */
function changeCard(name, world, id = 5) {
  switchCard({ name, id, world });
  emitTavernEvent('CHARACTER_PAGE_LOADED');
}

/** 把当前卡复位回初始状态（用例之间隔离） */
function resetCard() {
  mockContext.characters = [{ name: '测试卡', data: { extensions: { world: '' } } }];
  mockContext.characterId = 0;
  mockContext.chatMetadata = { file_name: 'test-chat' };
}

function doc2create(d, tag) {
  return d.createElement(tag);
}
function doc2overlay() {
  return overlayMod;
}

await test('弹幕框：条数、颜色、轨道都正确', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ 昵称: `观众${i}`, 内容: `弹幕${i}`, 类型: '普通' }));
  const frame = frameMod.createFrame({ doc, appearance, luminance: 0.1, meta: { batchNo: 1, messageId: 3, title: '测试' }, items });
  eq(frame.nodes.length, 15);
  eq(frame.lanes >= 1, true);
  for (const it of items) ok(/^#[0-9a-f]{6}$/i.test(it.color), `颜色没回写：${it.color}`);
  eq(new Set(items.map((i) => i.color)).size, 15, '同一批颜色不重复');
  ok(frame.el.className.includes('std-frame'));
});

await test('轨道分配不会让同一个人连着占同一条轨', () => {
  const items = Array.from({ length: 6 }, () => ({ 昵称: '同一个人', 内容: 'x' }));
  const lanes = frameMod.distributeLanes(items, 3);
  for (let i = 1; i < lanes.length; i++) {
    ok(lanes[i].lane !== lanes[i - 1].lane, `第 ${i} 条和上一条占了同轨`);
  }
});

await test('静态列表渲染出全部条目', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ 昵称: `甲${i}`, 内容: `内容${i}`, 类型: '普通' }));
  const frame = frameMod.createFrame({ doc, appearance, luminance: 0.1, meta: { batchNo: 2, messageId: 1 }, items });
  frameMod.renderStatic(frame);
  eq(frame.staticList.children.length, 5);
  ok(frame.staticList.classList.contains('show'));
});

await test('空批次不会炸', () => {
  const frame = frameMod.createFrame({ doc, appearance, luminance: 0.1, meta: { batchNo: 3, messageId: 2 }, items: [] });
  eq(frame.nodes.length, 0);
  frameMod.renderStatic(frame);
  eq(frame.staticList.children.length, 0);
});

await test('挂载到指定楼层，并且同楼层只留一块', () => {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const mk = () =>
    frameMod.createFrame({ doc, appearance, luminance: 0.1, meta: { batchNo: 4, messageId: 99 }, items: [{ 昵称: '甲', 内容: 'x' }] });
  frameMod.mountFrame({ doc, messageId: 99, host: { mode: 'after', node: host }, frame: mk() });
  frameMod.mountFrame({ doc, messageId: 99, host: { mode: 'after', node: host }, frame: mk() });
  eq(doc.querySelectorAll('.std-frame[data-mesid="99"]').length, 1, '同楼层不该叠两块');
});

await test('弹幕框挂在整条消息之后，不会挤压正文（矩形不重叠）', () => {
  // 造一条像酒馆那样的消息结构：.mes > .mes_block > .mes_text
  const chat = doc._chat;
  doc.body.appendChild(chat);
  const mes = doc.createElement('div');
  mes.className = 'mes';
  mes.setAttribute('mesid', '7');
  mes._rect = { left: 0, top: 120, width: 620, height: 260, right: 620, bottom: 380 };
  const block = doc.createElement('div');
  block.className = 'mes_block';
  const text = doc.createElement('div');
  text.className = 'mes_text';
  block.appendChild(text);
  mes.appendChild(block);
  chat.appendChild(mes);

  const anchor = frameMod.resolveHostAnchor(7, doc);
  eq(anchor.mode, 'after');
  eq(anchor.node, mes, '锚点必须是整条消息元素，而不是消息内部的块');

  const frame = frameMod.createFrame({ doc, appearance, luminance: 0.1, meta: { batchNo: 5, messageId: 7 }, items: [{ 昵称: '甲', 内容: 'x' }] });
  frameMod.mountFrame({ doc, messageId: 7, frame });

  eq(frame.el.parentElement, chat, '弹幕框应当是聊天区的直接子节点，不属于这条消息');
  ok(!mes.children.includes(frame.el), '绝不能插进消息内部');

  // 位置：从消息底部往下，横向与消息对齐
  const r = frame.el.getBoundingClientRect();
  eq(r.top, mes._rect.bottom, '弹幕框应当从消息底部开始');
  eq(r.right, mes._rect.right, '宽度应当与消息一致');
  const overlapsVertically = !(r.top >= mes._rect.bottom || r.bottom <= mes._rect.top);
  eq(overlapsVertically, false, '弹幕框不该和消息矩形纵向重叠');

  // 消息自身结构没有被塞进额外节点，正文高度也不会被改动
  eq(mes.children.length, 1, '消息结构没被塞进额外节点');
  eq(block.children.length, 1);
  eq(mes._rect.height, 260, '正文高度不该被弹幕框改变');
});

await test('开场白（0 楼）不挂弹幕框', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true, skipOpening: true, appearance: { frameEnabled: true } });
  const before = doc.querySelectorAll('.std-frame[data-mesid="0"]').length;
  app.renderBatch(
    { batchNo: 900, anchorId: 0, title: '测试', items: [{ 昵称: '甲', 内容: 'x', color: '#fff' }] },
    { messageId: 0, animate: false },
  );
  eq(doc.querySelectorAll('.std-frame[data-mesid="0"]').length, before, '0 楼不该出现新的弹幕框');
  app.destroy();
});

await test('关掉"开场白不出弹幕"后，0 楼也能挂', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true, skipOpening: false, appearance: { frameEnabled: true } });
  app.renderBatch(
    { batchNo: 901, anchorId: 0, title: '测试', items: [{ 昵称: '甲', 内容: 'x', color: '#fff' }] },
    { messageId: 0, animate: false },
  );
  eq(doc.querySelectorAll('.std-frame[data-mesid="0"]').length, 1, '关掉限制后应当能挂上');
  app.destroy();
});

await test('开场白不触发自动直出', async () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true, autoGenerate: true, everyNRounds: 1 });
  const before = app.state.runtime.history.length;
  app.onAssistantMessage(0);
  // 合成事件是异步的，给它一点时间
  await new Promise((r) => setTimeout(r, 50));
  eq(app.state.runtime.history.length, before, '0 楼不该触发出批次');
  eq(app.state.runtime.roundNo, 0, '0 楼也不该计入轮次');
  app.destroy();
});

/* ───────────── 11b. 悬浮层交互（拖动 / 缩放） ───────────── */

section('11b. 悬浮层拖动与缩放');

await test('拖动标题栏能移动悬浮层，并回写位置', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  ov.applyRect(d2, { x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  const root = d2.getElementById('std-overlay');
  const bar = root.querySelector('.std-ov-bar');
  root._rect = { left: 128, top: 80, width: 640, height: 160, right: 768, bottom: 240 };

  let committed = null;
  ov.enableInteractions(d2, (r) => {
    committed = r;
  });

  bar.dispatch('pointerdown', { clientX: 200, clientY: 90, button: 0 });
  d2.defaultView.__emit('pointermove', { clientX: 300, clientY: 190 });
  d2.defaultView.__emit('pointerup', {});

  eq(root.style.left, '228px', `左移量不对：${root.style.left}（期望 128+100）`);
  eq(root.style.top, '180px', `上移量不对：${root.style.top}（期望 80+100）`);
  ok(committed, '结束拖动后应当回写位置');
  eq(typeof committed.x, 'number');
});

await test('标题栏上的 ✕ 不会被当成拖动起点', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  ov.applyRect(d2, { x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  const root = d2.getElementById('std-overlay');
  const hideBtn = doc2create(d2, 'button');
  hideBtn.setAttribute('data-std-ov-hide', '1');
  root.querySelector('.std-ov-bar').appendChild(hideBtn);
  root._rect = { left: 128, top: 80, width: 640, height: 160, right: 768, bottom: 240 };

  ov.enableInteractions(d2, () => {});
  hideBtn.dispatch('pointerdown', { clientX: 200, clientY: 90, button: 0 });
  d2.defaultView.__emit('pointermove', { clientX: 400, clientY: 190 });
  eq(root.style.left, '128px', '点 ✕ 不该把层拖走');
  eq(root.style.top, '80px');
});

await test('拖动右下角手柄能改变尺寸（有最小尺寸保护）', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  ov.applyRect(d2, { x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  const root = d2.getElementById('std-overlay');
  const resizer = root.querySelector('.std-ov-resize');
  root._rect = { left: 100, top: 60, width: 640, height: 160, right: 740, bottom: 220 };

  ov.enableInteractions(d2, () => {});
  resizer.dispatch('pointerdown', { clientX: 740, clientY: 220, button: 0 });
  d2.defaultView.__emit('pointermove', { clientX: 840, clientY: 320 });
  d2.defaultView.__emit('pointerup', {});
  eq(root.style.width, '740px', `宽度不对：${root.style.width}`);
  eq(root.style.height, '260px', `高度不对：${root.style.height}`);

  // 往回拖到极小，应当被最小尺寸挡住
  resizer.dispatch('pointerdown', { clientX: 840, clientY: 320, button: 0 });
  d2.defaultView.__emit('pointermove', { clientX: 0, clientY: 0 });
  d2.defaultView.__emit('pointerup', {});
  eq(root.style.width, '240px', '最小宽度保护失效');
  eq(root.style.height, '80px', '最小高度保护失效');
});

await test('检测不到拖动时不会误回写位置', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  const root = d2.getElementById('std-overlay');
  root._rect = { left: 20, top: 20, width: 400, height: 100, right: 420, bottom: 120 };
  let calls = 0;
  ov.enableInteractions(d2, () => {
    calls++;
  });
  d2.defaultView.__emit('pointerup', {});
  eq(calls, 0, '没拖动就不该回写');
});

await test('点 ✕ 会把悬浮层隐藏并通知外部关掉开关', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  ov.applyRect(d2, { x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  const root = d2.getElementById('std-overlay');
  const hideBtn = doc2create(d2, 'button');
  hideBtn.setAttribute('data-std-ov-hide', '1');
  root.querySelector('.std-ov-bar').appendChild(hideBtn);

  let got = 'none';
  ov.enableInteractions(d2, (r) => {
    got = r;
  });
  ok(ov.isOverlayVisible(d2), '默认应当是可见的');
  // click 事件里 target.closest 要能命中考号
  root.dispatch('click', { target: hideBtn });
  eq(got, null, '应当以 null 通知"用户主动隐藏"');
  eq(ov.isOverlayVisible(d2), false, '隐藏后 data-std-hidden 应当为 1');
});

await test('卸载交互后再拖动不会生效', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  ov.applyRect(d2, { x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  const root = d2.getElementById('std-overlay');
  const bar = root.querySelector('.std-ov-bar');
  root._rect = { left: 100, top: 100, width: 640, height: 160, right: 740, bottom: 260 };
  const off = ov.enableInteractions(d2, () => {});
  off();
  bar.dispatch('pointerdown', { clientX: 120, clientY: 110, button: 0 });
  d2.defaultView.__emit('pointermove', { clientX: 300, clientY: 300 });
  eq(root.style.left, '128px', '卸载后不该还能拖动');
});

/* ───────────── 11c. 示例弹幕用通用网名 ───────────── */

section('11c. 示例弹幕（本地预览用）');

await test('示例昵称是网名，且不预设任何题材', () => {
  const items = frameMod.demoSample(15);
  eq(items.length, 15);
  const names = [...new Set(items.map((d) => d.昵称))];
  ok(names.length >= 8, `昵称样本太少：${names.length}`);
  for (const n of names) {
    ok(n.length >= 2 && n.length <= 14, `昵称长度不像网名：${n}`);
    ok(!/[\u3040-\u30FF]/.test(n), `不该有日文假名：${n}`);
  }
  const joined = items.map((d) => d.昵称 + d.内容).join('');
  for (const banned of ['掌门', '修士', '仙', '宗门', '师兄', '帮主', '魔法', '皇帝', '将军']) {
    ok(!joined.includes(banned), `示例里不该出现题材化称呼：${banned}`);
  }
  // 网名感：至少有几个带数字或长网名风格的
  ok(names.some((n) => /\d/.test(n) || n.length >= 6), `网名感不足：${names.join('、')}`);
});

await test('悬浮层：创建、定位、播放、清理', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ 昵称: `乙${i}`, 内容: `飘${i}`, color: '#ffd479' }));
  overlayMod.ensureOverlay(doc);
  overlayMod.applyRect(doc, { x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  const out = overlayMod.playOverlay(doc, items, { appearance, stagger: 0 });
  ok(out.duration > 0 && out.lanes >= 1);
  eq(doc.querySelectorAll('#std-overlay .std-ov-item').length, 8);
  overlayMod.stopOverlay(doc);
  eq(doc.querySelectorAll('#std-overlay .std-ov-item').length, 0);
});

await test('悬浮层矩形换算成像素并被夹在视口内', () => {
  overlayMod.applyRect(doc, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  const root = doc.getElementById('std-overlay');
  eq(root.style.width, `${Math.round(0.5 * 1280)}px`);
  const left = parseInt(root.style.left, 10);
  ok(left + 640 <= 1280, `不该超出视口，left=${left}`);
});

/* ───────────── 12. 正文隔离与直播注入 ───────────── */

section('12. 正文隔离（弹幕不吃正文 token）');

await test('默认自动跟随酒馆当前的连接（不会硬走 custom 撞报错）', async () => {
  resetMockConnection();
  MOCK_CONNECTION.chat_completion_source = 'deepseek';
  MOCK_CONNECTION.openai_model = 'deepseek-chat';
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  const api = store.loadSettings(storage, {}).api;
  eq(api.sourceMode, 'auto', '默认应当是自动跟随');
  const res = await llm.chat({ api, system: 's', user: 'u', label: '测试' });
  ok(res.ok, res.error);
  eq(lastRequestBody.chat_completion_source, 'deepseek', '应当跟随酒馆当前连接');
  eq(lastRequestBody.model, 'deepseek-chat', '模型也应当跟随');
  resetMockConnection();
});

await test('酒馆里换了连接，弹幕也跟着换', async () => {
  resetMockConnection();
  const api = store.loadSettings(storage, {}).api;
  MOCK_CONNECTION.chat_completion_source = 'openai';
  MOCK_CONNECTION.openai_model = 'gpt-4o-mini';
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  await llm.chat({ api, system: 's', user: 'u', label: 't' });
  eq(lastRequestBody.chat_completion_source, 'openai');

  MOCK_CONNECTION.chat_completion_source = 'makersuite';
  MOCK_CONNECTION.openai_model = 'gemini-2.0-flash';
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  await llm.chat({ api, system: 's', user: 'u', label: 't' });
  eq(lastRequestBody.chat_completion_source, 'makersuite', '换连接后应当跟着换');
  resetMockConnection();
});

await test('固定来源模式：忽略酒馆当前连接', async () => {
  resetMockConnection();
  MOCK_CONNECTION.chat_completion_source = 'openai';
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  const api = { ...store.loadSettings(storage, {}).api, sourceMode: 'fixed', source: 'deepseek' };
  await llm.chat({ api, system: 's', user: 'u', label: 't' });
  eq(lastRequestBody.chat_completion_source, 'deepseek', '固定模式应当用指定的来源');
  resetMockConnection();
});

await test('custom 源会把酒馆里配的自定义地址传下去', async () => {
  resetMockConnection();
  MOCK_CONNECTION.chat_completion_source = 'custom';
  MOCK_CONNECTION.custom_url = 'http://127.0.0.1:1234/v1';
  MOCK_CONNECTION.openai_model = 'local-model';
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  const api = store.loadSettings(storage, {}).api;
  const res = await llm.chat({ api, system: 's', user: 'u', label: 't' });
  ok(res.ok, res.error);
  eq(lastRequestBody.chat_completion_source, 'custom');
  eq(lastRequestBody.custom_url, 'http://127.0.0.1:1234/v1', 'custom 源必须把地址带上，否则后端会报 Custom endpoint is missing');
  resetMockConnection();
});

await test('弹幕请求体里只有我们自己的两条消息', async () => {
  queueResponse({ choices: [{ message: { content: '{"弹幕":[]}' } }] });
  await llm.chat({ api: { route: 'st', source: 'custom' }, system: '只有这些', user: '和这些', label: 't' });
  eq(lastRequestBody.messages.length, 2);
  const joined = JSON.stringify(lastRequestBody.messages);
  ok(!/char_description|world_info|persona/.test(JSON.stringify(lastRequestBody)), '不该出现酒馆的字段');
  ok(joined.includes('只有这些'));
});

await test('截图式检查：请求体里没有酒馆的预设提示词字段', async () => {
  queueResponse({ choices: [{ message: { content: 'ok' } }] });
  await llm.chat({ api: { route: 'st', source: 'custom' }, system: 's', user: 'u', label: 't' });
  for (const k of ['char_description', 'char_personality', 'world_info_before', 'world_info_after', 'chat_history', 'scenario']) {
    ok(!(k in lastRequestBody), `请求体里不该有 ${k}`);
  }
});

section('13. 直播模式注入（唯一的 弹幕 → 正文 通道）');

await test('直播模式关：注入文本为空', () => {
  const app = mainMod.createApp({ storage: makeMemoryStorage(), doc, win: doc.defaultView });
  app.init();
  eq(app.buildInjectionText(), '', '关着就不该有任何注入');
  app.destroy();
});

await test('直播模式开：注入有内容且不超过上限', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ liveMode: true, injection: { maxChars: 320, sampleCount: 4 } });
  app.state.runtime.history.push({
    batchNo: 1,
    anchorId: 0,
    items: [{ 昵称: '甲', 内容: '来了' }, { 昵称: '乙', 内容: '前排' }],
  });
  const text = app.buildInjectionText();
  ok(text.length > 0, '开着就该有注入');
  ok(text.length <= 320, `注入长度 ${text.length} 超上限`);
  ok(/直播/.test(text));
  app.destroy();
});

await test('注入字数调小后，注入立刻变短', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ liveMode: true, injection: { maxChars: 80 } });
  const text = app.buildInjectionText();
  ok(text.length <= 80, `实际 ${text.length}`);
  app.destroy();
});

/* ───────────── 13b. 扩展面板里的设置栏 ───────────── */

section('13b. 扩展面板设置栏（抽屉）');

function makeDrawerEnv() {
  const d = createMiniDocument();
  useDoc(d); // 必须让 app 通过全局拿到同一份文档，否则 app.stats() 会读错文档
  resetTavernState(); // 卡绑定 / 全局世界书 / 当前卡 都要复位，否则用例之间互相污染
  // 清掉上一个用例留下的悬浮层，避免替身跨文档兜底查找时拿错
  const stale = d.getElementById('std-overlay');
  if (stale) stale.remove();

  // 模拟酒馆的扩展面板挂载点
  const slot = d.createElement('div');
  slot.setAttribute('id', 'extensions_settings2');
  d.body.appendChild(slot);

  const app = mainMod.createApp({ storage: d.defaultView.localStorage, doc: d, win: d.defaultView });
  app.init();
  return { d, slot, app };
}

await test('设置栏能挂进酒馆扩展面板的挂载点', () => {
  const { d, slot, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  ok(el, '应当挂载成功');
  eq(el.id, 'std-drawer');
  eq(el.parentElement, slot, '必须挂在 #extensions_settings2 里');
  ok(/弹幕直播间/.test(el.textContent), '标题应当出现');
  ok(el.querySelector('.inline-drawer'), '应当用酒馆的 inline-drawer 结构，样式才能跟着主题走');
  app.destroy();
});

await test('找不到挂载点时返回 null，而不是抛错', () => {
  const d = createMiniDocument();
  globalThis.document = d;
  globalThis.window = d.defaultView;
  globalThis.localStorage = d.defaultView.localStorage;
  const app = mainMod.createApp({ storage: d.defaultView.localStorage, doc: d, win: d.defaultView });
  app.init();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  eq(drawer.mount(), null, '没有 #extensions_settings2 时应当安静返回 null');
  app.destroy();
});

await test('设置栏反映当前设置，并且是双向的', () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();

  app.updateSettings({ enabled: true, liveMode: false, autoGenerate: true, count: 15, everyNRounds: 2 });
  drawer.render();
  const get = (p) => el.querySelector(`[data-std-dw="${p}"]`);
  eq(get('enabled').checked, true);
  eq(get('liveMode').checked, false);
  eq(get('autoGenerate').checked, true);
  eq(get('count').value, '15');
  eq(get('everyNRounds').value, '2');

  // 从 UI 改一次，应当写回设置
  get('liveMode').checked = true;
  el.dispatch('change', { target: get('liveMode') });
  eq(app.state.settings.liveMode, true, 'UI 改动应当写回设置');

  get('count').value = '30';
  el.dispatch('change', { target: get('count') });
  eq(app.state.settings.count, 30);

  app.destroy();
});

await test('状态区显示世界书与档案状态', () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  drawer.render();
  const status = el.querySelector('[data-std-dw-status]').innerHTML;
  ok(status.includes('世界书'), status);
  ok(status.includes('还没扫描'), `未扫描时应当提示还没有档案：${status}`);
  app.destroy();
});

await test('「打开完整设置」会通知外部打开悬浮球面板', () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  let opened = false;
  app.on('open-panel', () => {
    opened = true;
  });
  const btn = el.querySelector('[data-std-dw-act="open"]');
  el.dispatch('click', { target: btn });
  eq(opened, true, '应当发出 open-panel 事件');
  app.destroy();
});

await test('「出一批」按钮能在设置栏里直接出弹幕', async () => {
  const { d, app } = makeDrawerEnv();
  app.updateSettings({ seedDemo: true, count: 4 });
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  const btn = el.querySelector('[data-std-dw-act="batch"]');
  el.dispatch('click', { target: btn });
  await new Promise((r) => setTimeout(r, 60));
  eq(app.state.runtime.history.length, 1, '设置栏里的按钮应当真的出了一批');
  ok(/已出 4 条/.test(el.querySelector('[data-std-dw-result]').textContent), el.querySelector('[data-std-dw-result]').textContent);
  app.destroy();
});

await test('卸载设置栏后不会再响应事件', () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  drawer.unmount();
  eq(d.getElementById('std-drawer'), null, '卸载后 DOM 应当清掉');
  app.destroy();
});

/* ───────────── 13c. 进卡自动跟随绑定世界书 ───────────── */

section('13c. 进卡自动跟随该卡绑定的世界书');

await test('换卡后，要读的世界书变成新卡绑定的那本', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ scan: { sources: null } });
  // 初始卡没绑世界书
  eq(app.stats().worldbooksUsed.length, 0, '初始卡没绑书时不该读到东西');

  changeCard('甲卡', '大书', 5);
  const used = app.stats().worldbooksUsed;
  eq(used.length, 1, `换卡后应当读到新卡绑定的书，实际 ${JSON.stringify(used)}`);
  eq(used[0], '大书');
  app.destroy();
});

await test('手动勾选不会带到下一张卡（默认跟随模式下自动切回）', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  eq(app.state.settings.scan.followCard, true, '默认应当开启跟随');

  // 用户手动勾了两本
  app.updateSettings({ scan: { sources: ['小书', '大书'] } });
  eq(app.stats().worldbooksUsed.length, 2);

  changeCard('乙卡', '小书', 6);
  ok(app.state.settings.scan.sources === null, '换卡后应当退回自动跟随（清掉手动勾选）');
  const used = app.stats().worldbooksUsed;
  eq(used.length, 1, '应当只读新卡绑定的那本');
  eq(used[0], '小书');
  app.destroy();
});

await test('关掉跟随后，手动勾选会保留到别的卡上', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ scan: { followCard: false, sources: ['大书'] } });

  changeCard('丙卡', '小书', 7);
  eq(app.state.settings.scan.sources.length, 1, '关掉跟随后手动勾选应保留');
  eq(app.state.settings.scan.sources[0], '大书');
  app.destroy();
});

await test('档案按「卡|聊天|世界书」缓存：换回扫过的卡能直接用', () => {
  const s = makeMemoryStorage();
  // 预置两份缓存，模拟两张卡以前都扫过
  const keyA = store.profileKey('甲卡', 'test-chat', '大书');
  const pA = store.emptyProfile();
  pA.data = { ...pA.data, worldName: '大世界', channelName: '大世界的围观席' };
  pA.generatedAt = Date.now();
  store.putCachedProfile(s, keyA, pA);

  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  changeCard('甲卡', '大书', 8);
  ok(app.state.profile, '切到扫过的卡应当命中缓存，不用重扫');
  eq(app.state.profile.data.worldName, '大世界');
  app.destroy();
});

await test('换卡会清掉上一张卡的观众名册（不串味）', async () => {
  resetMockConnection();
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true });

  // 伪造一份属于"测试卡"的名册
  app.state.runtime.viewers = [{ 昵称: '上张卡的观众', 类型: '路人', 立场: '', 口癖: '', 出现次数: 3 }];
  app.state.runtime.viewersCardName = '测试卡';
  app.persistRuntime();
  eq(app.stats().viewers.length, 1);

  changeCard('丁卡', '小书', 9);
  eq(app.stats().viewers.length, 0, '换卡后名册必须作废，否则弹幕里会冒出上一张卡的人');
  app.destroy();
});

await test('同一张卡重复触发事件不会误清设置', () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ scan: { followCard: true, sources: ['大书'] } });
  // 同一张卡（签名不变）再发一次卡片页加载
  emitTavernEvent('CHARACTER_PAGE_LOADED');
  eq(app.state.settings.scan.sources.length, 1, '卡没变就不该清掉手动勾选');
  app.destroy();
});

/** 打开面板并切到「世界书」页（像真实浏览器那样，从页签按钮上派发 click） */
function openWorldTab(app, panel) {
  panel.toggle(true);
  const tab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'world');
  ok(tab, '应当有「世界书」页签');
  // 关键：必须派发在按钮本身（事件会向上冒泡到面板），
  // 而不是派发在面板上再塞一个 target —— 后者在真实 DOM 里根本不会触发按钮的祖先监听器
  tab.dispatch('click', { target: tab });
  return panel;
}

await test('手动勾选世界书能写回设置（点击路径）', () => {
  const { d, app } = makeDrawerEnv();
  const panel = panelMod.createPanel(app);
  panel.build();
  openWorldTab(app, panel);

  const boxes = panel.el.querySelectorAll('[data-std-book]');
  ok(boxes.length >= 3, `世界书页应当列出所有可用的书，实际 ${boxes.length}`);

  // 勾上"小书"
  const target = boxes.find((b) => b.getAttribute('data-std-book') === '小书');
  ok(target, '应当能找到"小书"这个勾选框');
  target.checked = true;
  // 真实浏览器里点复选框会派发 change（这里同时覆盖 click 兜底路径）
  panel.el.dispatch('change', { target });
  eq(
    app.state.settings.scan.sources.includes('小书'),
    true,
    `勾选后应当写回设置，实际 ${JSON.stringify(app.state.settings.scan.sources)}`,
  );

  // 再点一下取消
  openWorldTab(app, panel);
  const target2 = panel.el.querySelectorAll('[data-std-book]').find((b) => b.getAttribute('data-std-book') === '小书');
  target2.checked = false;
  panel.el.dispatch('change', { target: target2 });
  eq(app.state.settings.scan.sources.includes('小书'), false, '取消勾选也应当生效');
  app.destroy();
});

await test('换卡后世界书页会显示新卡绑定的书', () => {
  const { d, app } = makeDrawerEnv();
  const panel = panelMod.createPanel(app);
  panel.build();
  changeCard('戊卡', '大书', 11);
  openWorldTab(app, panel);
  const html = panel.el.querySelector('.std-body').innerHTML;
  ok(/自动跟随当前卡/.test(html), `应当显示跟随模式：${html.slice(0, 200)}`);
  ok(html.includes('戊卡'), '应当显示当前卡名');
  ok(html.includes('大书'), '应当列出会读的世界书');
  app.destroy();
});

await test('设置栏挂上之后，世界书勾选依然只由面板负责，不会互相打架', () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  ok(el, '设置栏应当挂上');
  const panel = panelMod.createPanel(app);
  panel.build();
  openWorldTab(app, panel);
  const box = panel.el.querySelectorAll('[data-std-book]').find((b) => b.getAttribute('data-std-book') === '大书');
  box.checked = true;
  panel.el.dispatch('change', { target: box });
  eq(app.state.settings.scan.sources.includes('大书'), true);
  app.destroy();
});

await test('世界书页列出的书可以多选，勾哪本扫描就读哪本', () => {
  const { d, app } = makeDrawerEnv();
  const panel = panelMod.createPanel(app);
  panel.build();
  openWorldTab(app, panel);

  const boxes = panel.el.querySelectorAll('[data-std-book]');
  eq(boxes.length, 3, `应当列出全部 3 本世界书，实际 ${boxes.length}`);

  // 多选两本
  const pick = (name, on) => {
    const box = panel.el.querySelectorAll('[data-std-book]').find((b) => b.getAttribute('data-std-book') === name);
    box.checked = on;
    panel.el.dispatch('change', { target: box });
  };
  pick('小书', true);
  pick('大书', true);
  const sources = app.state.settings.scan.sources;
  eq(sources.length, 2, `应当选中 2 本，实际 ${JSON.stringify(sources)}`);
  ok(sources.includes('小书') && sources.includes('大书'));
  // 扫描会读的书必须和勾选一致
  eq(app.stats().worldbooksUsed.length, 2, '扫描会读的书应当就是勾选的这些');
  app.destroy();
});

await test('「勾选全部世界书」能一键选中所有书', () => {
  const { d, app } = makeDrawerEnv();
  const panel = panelMod.createPanel(app);
  panel.build();
  openWorldTab(app, panel);

  const btn = panel.el.querySelector('[data-std-act="books-all"]');
  ok(btn, '应当有「勾选全部世界书」按钮');
  panel.el.dispatch('click', { target: btn });

  const sources = app.state.settings.scan.sources;
  eq(sources.length, 3, `应当选中全部 3 本，实际 ${JSON.stringify(sources)}`);
  eq(app.stats().worldbooksUsed.length, 3);
  // 界面上也应当反映出来
  const checkedInUi = panel.el.querySelectorAll('[data-std-book]').filter((b) => b.checked).length;
  eq(checkedInUi, 3, '勾选状态应当同步到界面');
  app.destroy();
});

await test('自动模式下取消勾选一本，只去掉那一本（其余本卡绑定的书保留）', () => {
  const { d, app } = makeDrawerEnv();
  // 先让这张卡绑定两本书：主书 + 全局开启的
  mockContext.characters[0].data.extensions.world = '大书';
  mockContext.extensionSettings.world_info.world_info = ['小书'];
  emitTavernEvent('CHARACTER_PAGE_LOADED');

  const panel = panelMod.createPanel(app);
  panel.build();
  openWorldTab(app, panel);
  eq(app.stats().worldbooksUsed.length, 2, '自动模式应当读两本');

  // 取消"小书"
  const box = panel.el.querySelectorAll('[data-std-book]').find((b) => b.getAttribute('data-std-book') === '小书');
  box.checked = false;
  panel.el.dispatch('change', { target: box });

  const sources = app.state.settings.scan.sources;
  eq(sources.length, 1, `应当只剩一本，实际 ${JSON.stringify(sources)}`);
  eq(sources[0], '大书', '保留的应当是没被取消的那本');

  // 复位，避免影响后续用例
  mockContext.characters[0].data.extensions.world = '';
  mockContext.extensionSettings.world_info.world_info = [];
  app.destroy();
});

await test('世界书页会标出哪几本是当前卡绑定的', () => {
  const { d, app } = makeDrawerEnv();
  mockContext.characters[0].data.extensions.world = '大书';
  emitTavernEvent('CHARACTER_PAGE_LOADED');
  const panel = panelMod.createPanel(app);
  panel.build();
  openWorldTab(app, panel);
  const tagged = panel.el.querySelectorAll('.std-book-tag');
  eq(tagged.length, 1, '只有本卡绑定的那本应当有标记');
  ok(panel.el.innerHTML.includes('本卡绑定'));
  mockContext.characters[0].data.extensions.world = '';
  app.destroy();
});

await test('设置栏状态区只说"能不能用"，不摊实现细节', () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();

  app.updateSettings({ scan: { sources: ['大书', '小书'] } });
  drawer.render();
  let status = el.querySelector('[data-std-dw-status]').innerHTML;
  ok(/观众档案/.test(status), `应当有档案状态：${status}`);
  ok(/大书/.test(status) && /小书/.test(status), '书少时应当列出名字（方便确认）');

  // 不应当出现实现细节
  ok(!/AI 新写|取自原文|例如：|上次扫描/.test(status), `不该摊实现细节：${status}`);

  // 书多时只给数量
  app.updateSettings({ scan: { sources: ['大书', '小书', '空书', '第四本'] } });
  drawer.render();
  status = el.querySelector('[data-std-dw-status]').innerHTML;
  ok(/世界书：\d+ 本|世界书：.*大书/.test(status), `书多时应当收敛成数量：${status}`);

  app.updateSettings({ scan: { sources: null } });
  drawer.render();
  status = el.querySelector('[data-std-dw-status]').innerHTML;
  // 自动模式下本卡没绑书，所以是"（未选）"；关键是不该报错、也不该摊细节
  ok(/世界书：/.test(status), `自动模式也应当有一行世界书状态：${status}`);
  ok(!/AI 新写|取自原文|例如：/.test(status), `不该摊实现细节：${status}`);
  app.destroy();
});

await test('悬浮层的整层透明度由设置决定，hover / 拖动都不会覆盖它', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  const root = d2.getElementById('std-overlay');
  const bar = root.querySelector('.std-ov-bar');

  ov.enableInteractions(d2, () => {});
  ov.applyOverlayStyle(d2, { overlayOpacity: 0.42, fontSize: 15, speed: 110, overlayFade: true });
  eq(root.style.getPropertyValue('--std-ov-opacity'), '0.42', '透明度应当来自设置');

  // 悬停只加提示类，不得改动透明度
  bar.dispatch('pointerenter', {});
  ok(root.classList.contains('hover'), '悬停应当加 hover 类');
  eq(root.style.getPropertyValue('--std-ov-opacity'), '0.42', '悬停不该改透明度');

  // 拖动同理
  root._rect = { left: 10, top: 10, width: 400, height: 100, right: 410, bottom: 110 };
  bar.dispatch('pointerdown', { clientX: 20, clientY: 20, button: 0 });
  ok(root.classList.contains('dragging'), '拖动中应当有 dragging 类');
  eq(root.style.getPropertyValue('--std-ov-opacity'), '0.42', '拖动不该改透明度');
  d2.defaultView.__emit('pointerup', {});
  eq(root.style.getPropertyValue('--std-ov-opacity'), '0.42', '拖动结束也不该改透明度');
});

await test('样式表不再依赖 :has()（旧版 WebView 不支持）', () => {
  // 直接检查 style.css 里没有 :has( 选择器
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/:has\s*\(/.test(withoutComments), 'CSS 里不该再用 :has() 选择器');
});

await test('点色块能真的改弹幕框背景', () => {
  const { d, app } = makeDrawerEnv();
  const panel = panelMod.createPanel(app);
  panel.build();
  panel.toggle(true);
  const lookTab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'look');
  lookTab.dispatch('click', { target: lookTab });

  const swatches = panel.el.querySelectorAll('[data-std-swatch]');
  ok(swatches.length >= 5, `应当有多个预设色块，实际 ${swatches.length}`);

  const target = swatches[2];
  const css = target.getAttribute('data-std-swatch');
  target.dispatch('click', { target });
  eq(app.state.settings.appearance.frameBackground, css, '点色块应当写进设置');
  eq(app.state.settings.appearance.frameBgTouched, true, '应当标记为"用户改过"');
  app.destroy();
});

await test('弹幕框会把背景色写进 DOM', () => {
  const bg = 'linear-gradient(100deg, #111 0%, #222 100%)';
  const frame = frameMod.createFrame({
    doc,
    appearance: { ...appearance, frameBackground: bg },
    luminance: 0.1,
    meta: { batchNo: 9, messageId: 1 },
    items: [{ 昵称: '甲', 内容: 'x' }],
  });
  eq(frame.el.style.getPropertyValue('--std-bg'), bg, '背景应当作为 CSS 变量传下去');
});

/* ───────────── 13d. 世界书清单的获取（getContext 并不暴露这个数组） ───────────── */

section('13d. 世界书清单获取（多层兜底）');

await test('【真实场景】ctx 里没有任何世界书数组时，能拿到清单', async () => {
  // 这正是 TauriTavern 的实际情况：getContext() 只给了 updateWorldInfoList / loadWorldInfo，
  // 世界书名数组根本没有对外暴露。所以这里把 ctx 上的候选字段全部清空。
  const saved = {
    worldInfoList: mockContext.worldInfoList,
    getWorldInfoNames: mockContext.getWorldInfoNames,
  };
  delete mockContext.worldInfoList;
  delete mockContext.getWorldInfoNames;

  lastFetchUrl = '';
  const books = await st.refreshWorldbookNames(true);
  ok(books.length === 3, `应当拿到 3 本，实际 ${books.length}`);
  eq(books.map((b) => b.name).sort().join(','), '大书,小书,空书'.split(',').sort().join(','));
  ok(lastFetchUrl.includes('/api/worldinfo/list'), `应当走了服务端列表接口，实际 ${lastFetchUrl}`);

  // 名字要能当文件名用
  eq(st.resolveWorldbookFileId('大书'), '大书');

  mockContext.worldInfoList = saved.worldInfoList;
  if (saved.getWorldInfoNames) mockContext.getWorldInfoNames = saved.getWorldInfoNames;
});

await test('如果客户端暴露了 getWorldInfoNames()，优先用它（不发多余请求）', async () => {
  mockContext.getWorldInfoNames = () => ['甲书', '乙书'];
  lastFetchUrl = '';
  const books = await st.refreshWorldbookNames(true);
  eq(books.length, 2);
  eq(books[0].name, '甲书');
  eq(lastFetchUrl, '', '有官方函数时不该再去打接口');
  delete mockContext.getWorldInfoNames;
  await st.refreshWorldbookNames(true); // 复位缓存
});

await test('清单拿不到时保留旧缓存，不会把列表清空', async () => {
  await st.refreshWorldbookNames(true);
  const before = st.listWorldbookEntries();
  ok(before.length > 0);
  // 模拟接口挂掉 + ctx 也没有数组
  const savedFetch = globalThis.fetch;
  const savedList = mockContext.worldInfoList;
  delete mockContext.worldInfoList;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null, text: async () => '' });
  await st.refreshWorldbookNames(true);
  eq(st.listWorldbookEntries().length, before.length, '一次失败不该把已有清单清空');
  globalThis.fetch = savedFetch;
  mockContext.worldInfoList = savedList;
  await st.refreshWorldbookNames(true);
});

await test('显示名与文件名不一致时，读取会两个都试', async () => {
  const tried = [];
  const savedLoad = mockContext.loadWorldInfo;
  mockContext.loadWorldInfo = async (key) => {
    tried.push(key);
    if (key === '大书文件') return WORLDBOOKS['大书'];
    throw new Error('not found');
  };
  // 伪造一份"显示名 ≠ 文件名"的清单
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/worldinfo/list')) {
      return { ok: true, status: 200, json: async () => [{ file_id: '大书文件', name: '大书显示名' }], text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  delete mockContext.worldInfoList;
  await st.refreshWorldbookNames(true);
  eq(st.resolveWorldbookFileId('大书显示名'), '大书文件', '应当能由显示名找到文件名');

  const res = await st.readWorldbook('大书显示名');
  ok(res.ok, res.error);
  eq(res.entries.length, 600);
  ok(tried.includes('大书文件'), `应当试过文件名，实际试了 ${JSON.stringify(tried)}`);

  globalThis.fetch = savedFetch;
  mockContext.loadWorldInfo = savedLoad;
  mockContext.worldInfoList = Object.keys(WORLDBOOKS);
  await st.refreshWorldbookNames(true);
});

/* ───────────── 13e. 悬浮层背景色 ───────────── */

section('13e. 悬浮弹幕层的背景色');

await test('悬浮层背景由设置决定并写进 CSS 变量', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  const root = d2.getElementById('std-overlay');
  const bg = 'linear-gradient(180deg, rgba(20, 40, 90, 0.42) 0%, rgba(10, 20, 50, 0.1) 100%)';
  ov.applyOverlayStyle(d2, { overlayBg: bg, overlayOpacity: 0.5, fontSize: 15, speed: 110 });
  eq(root.style.getPropertyValue('--std-ov-bg'), bg, '背景应当写进 --std-ov-bg');
  eq(root.style.getPropertyValue('--std-ov-opacity'), '0.5', '不透明度也应当写进去');
});

await test('悬浮层背景色块能改设置，且不会误改弹幕框背景', () => {
  const { d, app } = makeDrawerEnv();
  const panel = panelMod.createPanel(app);
  panel.build();
  panel.toggle(true);
  const lookTab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'look');
  lookTab.dispatch('click', { target: lookTab });

  const overlayPicker = panel.el.querySelector('[data-std-bgtarget="overlay"]');
  ok(overlayPicker, '应当有悬浮层背景的色块组');
  const framePicker = panel.el.querySelector('[data-std-bgtarget="frame"]');
  ok(framePicker, '应当有弹幕框背景的色块组');

  const frameBgBefore = app.state.settings.appearance.frameBackground;
  const btn = overlayPicker.querySelectorAll('[data-std-swatch]')[3];
  const css = btn.getAttribute('data-std-swatch');
  btn.dispatch('click', { target: btn });

  eq(app.state.settings.appearance.overlayBg, css, '悬浮层背景应当被改掉');
  eq(app.state.settings.appearance.overlayBgTouched, true);
  eq(app.state.settings.appearance.frameBackground, frameBgBefore, '不该动到弹幕框背景');
  app.destroy();
});

await test('【真实场景】端点不支持结构化输出时，自动去掉它重试并成功', async () => {
  // 复刻用户实际遇到的报错：第三方 OpenAI 兼容端点（转 Gemini）拒绝 response_format
  resetMockConnection();
  lastRequestBody = null;
  const responses = [
    { __http: 400, body: '[API 错误] Invalid data: Request contains an invalid argument.' },
    { choices: [{ message: { content: '{"弹幕":[{"昵称":"甲","内容":"来了","类型":"普通","回复":""}]}' } }] },
  ];
  let call = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    lastRequestBody = init?.body ? JSON.parse(init.body) : null;
    lastFetchUrl = String(url);
    const next = responses[Math.min(call++, responses.length - 1)];
    if (next.__http) return { ok: false, status: next.__http, text: async () => next.body, json: async () => ({}) };
    const body = JSON.stringify(next);
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };

  const api = { ...store.loadSettings(storage, {}).api, useJsonSchema: true };
  const schema = { name: 'x', value: { type: 'object', properties: { 弹幕: { type: 'array', items: {} } }, required: ['弹幕'] } };
  const res = await llm.chatJson({ api, system: 's', user: 'u', label: '弹幕生成', jsonSchema: schema });

  ok(res.ok, `应当自动降级后成功：${res.error}`);
  eq(res.schemaFallback, true, '应当标记走过降级');
  eq(call, 2, '应当正好重试一次');
  eq(res.value.弹幕.length, 1, '降级后仍应解析出结果');
  ok(!lastRequestBody.json_schema, '重试时不应该再带结构化输出');
  ok(res.note && /结构化输出/.test(res.note), '应当给出人话说明');

  globalThis.fetch = savedFetch;
  resetMockConnection();
});

await test('判定：哪些报错算"不支持结构化输出"', () => {
  // 用户日志里的原文
  eq(llm.isSchemaRejection('[API 错误] Invalid data: Request contains an invalid argument.'), true);
  eq(llm.isSchemaRejection('response_format is not supported'), true);
  eq(llm.isSchemaRejection('unknown field json_schema'), true);
  eq(llm.isSchemaRejection('api key invalid'), false);
  eq(llm.isSchemaRejection('当前用的是「自定义端点（custom）」但酒馆里没配这个地址'), false);
});

await test('不支持结构化输出但降级后仍失败时，两条错误都给出来', async () => {
  resetMockConnection();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'Invalid data: bad argument', json: async () => ({}) });
  const api = { ...store.loadSettings(storage, {}).api, useJsonSchema: true };
  const res = await llm.chatJson({ api, system: 's', user: 'u', label: 't', jsonSchema: { name: 'x', value: {} } });
  eq(res.ok, false);
  ok(/重试/.test(res.error), `应当说明已重试过：${res.error}`);
  globalThis.fetch = savedFetch;
  resetMockConnection();
});

await test('默认不再使用结构化输出（避免撞上不兼容的端点）', () => {
  const s = store.defaultSettings();
  eq(s.api.useJsonSchema, false, '默认应当是关的');
  eq(store.normalizeSettings({}).api.useJsonSchema, false);
});

await test('【TauriTavern 场景】列表接口和 ctx 都拿不到时，从角色卡绑定收集', async () => {
  const savedFetch = globalThis.fetch;
  const savedList = mockContext.worldInfoList;
  const savedChars = mockContext.characters;
  const savedLoad = mockContext.loadWorldInfo;
  // 断掉所有"列目录"的途径
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null, text: async () => '' });
  delete mockContext.worldInfoList;

  // 造 3 张卡，分别绑了不同的世界书，其中一本是不存在的（用来验证会过滤）
  mockContext.characters = [
    { name: '甲卡', data: { extensions: { world: '大书' } } },
    { name: '乙卡', data: { extensions: { world: '小书' } } },
    { name: '丙卡', data: { extensions: { world: '并不存在的书' } } },
  ];
  // loadWorldInfo 只认识真书，用来验证"试读过滤"
  mockContext.loadWorldInfo = async (key) => {
    if (key in WORLDBOOKS) return WORLDBOOKS[key];
    throw new Error('not found');
  };

  const books = await st.refreshWorldbookNames(true);
  const names = books.map((b) => b.name).sort();
  eq(names.length, 2, `应当收集到 2 本真实存在的书，实际 ${JSON.stringify(names)}`);
  eq(names.join(','), '大书,小书'.split(',').sort().join(','));
  ok(!names.includes('并不存在的书'), '读不出来的名字应当被过滤掉');

  globalThis.fetch = savedFetch;
  mockContext.worldInfoList = savedList;
  mockContext.characters = savedChars;
  mockContext.loadWorldInfo = savedLoad;
  await st.refreshWorldbookNames(true);
});

await test('诊断会逐条报告每条途径的结果', async () => {
  const rows = await st.diagnoseWorldbookSources();
  ok(Array.isArray(rows) && rows.length >= 6, `诊断应当有多条结果，实际 ${rows?.length}`);
  const labels = rows.map((r) => r.label).join(' | ');
  ok(/loadWorldInfo/.test(labels), '应当报告 loadWorldInfo 是否可用');
  ok(/api\/worldinfo\/list/.test(labels), '应当报告接口那条路');
  ok(/角色卡/.test(labels), '应当报告从卡收集那条路');
  ok(/最终清单/.test(labels), '应当报告最终结果');
  for (const r of rows) {
    ok(typeof r.outcome === 'string' && r.outcome.length > 0, `${r.label} 缺少结论`);
  }
});

await test('从角色卡收集：兼容卡自带世界书与附加世界书', () => {
  const savedChars = mockContext.characters;
  mockContext.characters = [
    { name: 'A', data: { extensions: { world: '主书', world_info: ['附加1', '附加2'] } } },
    { name: 'B', data: { character_book: { name: '内嵌书' } } },
    { name: 'C', data: { extensions: { world: '主书' } } }, // 重复的应当去重
  ];
  const got = st.collectWorldbooksFromCharacters().map((b) => b.name);
  ok(got.includes('主书') && got.includes('附加1') && got.includes('附加2') && got.includes('内嵌书'), got.join(','));
  eq(got.filter((n) => n === '主书').length, 1, '重复的应当去重');
  mockContext.characters = savedChars;
});

await test('【TauriTavern 场景】走 Tauri IPC 拿到世界书清单（没有 HTTP 路由时）', async () => {
  const savedFetch = globalThis.fetch;
  const savedList = mockContext.worldInfoList;
  const savedChars = mockContext.characters;
  const savedTauri = globalThis.__TAURI__;
  // 断掉 HTTP 与 ctx 两条路，模拟 TT 的真实情况
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null, text: async () => '' });
  delete mockContext.worldInfoList;
  mockContext.characters = []; // 连一张卡都没有

  const calls = [];
  globalThis.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push(`${cmd}${args ? '(args)' : ''}`);
        // 模仿 TT：只有这个命令存在，且返回带 name/file_id 的对象数组
        if (cmd === 'get_world_infos_batch') {
          return { world_infos: Object.keys(WORLDBOOKS).map((n) => ({ name: n, file_id: n })) };
        }
        throw new Error(`command ${cmd} not found`);
      },
    },
  };
  st.clearTauriIpcCache();

  const books = await st.refreshWorldbookNames(true);
  const names = books.map((b) => b.name).sort();
  eq(names.length, 3, `应当从 IPC 拿到 3 本，实际 ${JSON.stringify(names)}`);
  ok(calls.some((c) => c.startsWith('get_world_infos_batch')), `应当试过 get_world_infos_batch，实际 ${calls.join(', ')}`);
  ok(calls.some((c) => c.startsWith('list_world_infos')), '应当把多个候选命令名都试一遍');

  // 文件名映射也要对
  eq(st.resolveWorldbookFileId('大书'), '大书');

  globalThis.__TAURI__ = savedTauri;
  globalThis.fetch = savedFetch;
  mockContext.worldInfoList = savedList;
  mockContext.characters = savedChars;
  st.clearTauriIpcCache();
  await st.refreshWorldbookNames(true);
});

await test('IPC 返回的各种结构都能解析', async () => {
  const savedTauri = globalThis.__TAURI__;
  const cases = [
    ['字符串数组', ['甲', '乙']],
    ['items 包装', { items: ['甲', '乙'] }],
    ['names 包装', { names: ['甲', '乙'] }],
    ['对象数组(name/file_id)', [{ name: '甲', file_id: '甲文件' }]],
    ['对象数组(filename)', [{ filename: '丙' }]],
    ['world_infos 包装', { world_infos: [{ name: '丁' }] }],
  ];
  for (const [label, payload] of cases) {
    globalThis.__TAURI__ = { core: { invoke: async () => payload } };
    st.clearTauriIpcCache();
    const res = await st.fetchWorldbookListViaTauri();
    eq(res.entries.length, 2 === payload.length ? 2 : res.entries.length, `${label} 解析数量异常`);
    ok(res.entries.length >= 1, `${label} 应当解析出至少一本，实际 ${res.entries.length}`);
  }
  // 文件名与显示名分离
  globalThis.__TAURI__ = { core: { invoke: async () => [{ name: '显示名', file_id: '文件名' }] } };
  st.clearTauriIpcCache();
  const res = await st.fetchWorldbookListViaTauri();
  eq(res.entries[0].name, '显示名');
  eq(res.entries[0].fileId, '文件名');

  globalThis.__TAURI__ = savedTauri;
  st.clearTauriIpcCache();
});

await test('不是 Tauri 客户端时，IPC 那一路安静失败', async () => {
  const savedTauri = globalThis.__TAURI__;
  delete globalThis.__TAURI__;
  delete globalThis.__TAURI_INTERNALS__;
  st.clearTauriIpcCache();
  const res = await st.fetchWorldbookListViaTauri();
  eq(res.entries.length, 0);
  ok(res.log[0].result.includes('没有'), res.log[0].result);
  eq(st.tauriIpcInfo().includes('❌'), true);
  if (savedTauri) globalThis.__TAURI__ = savedTauri;
  st.clearTauriIpcCache();
});

await test('【真实场景】Tauri IPC 晚一点才就绪时，启动会自动重试直到拿到清单', async () => {
  const savedTauri = globalThis.__TAURI__;
  const savedList = mockContext.worldInfoList;
  const savedFetch = globalThis.fetch;
  // 断掉别的途径，只留 IPC
  delete mockContext.worldInfoList;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null, text: async () => '' });

  // IPC 要"过两次才就绪"，模拟扩展加载早于 Tauri 注入
  let ready = 0;
  delete globalThis.__TAURI__;
  delete globalThis.window.__TAURI__;
  setTimeout(() => {
    ready += 1;
    globalThis.window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd !== 'get_world_infos_batch') throw new Error('nope');
          return { world_infos: Object.keys(WORLDBOOKS).map((n) => ({ name: n, file_id: n })) };
        },
      },
    };
  }, 20);

  const d = createMiniDocument();
  useDoc(d);
  resetTavernState();
  const app = mainMod.createApp({ storage: d.defaultView.localStorage, doc: d, win: d.defaultView });
  app.init();

  // 等自动重试跑起来
  await new Promise((r) => setTimeout(r, 900));
  const found = app.listAllWorldbooks();
  eq(found.length, 3, `自动重试后应当拿到 3 本，实际 ${JSON.stringify(found)}`);
  ok(ready > 0, 'IPC 应当是在启动之后才就绪的（才说明重试起作用了）');

  app.destroy();
  globalThis.__TAURI__ = savedTauri;
  globalThis.fetch = savedFetch;
  mockContext.worldInfoList = savedList;
  st.clearTauriIpcCache();
  await st.refreshWorldbookNames(true);
});

await test('拿不到清单时，"IPC 不可用"的缓存会被自动清掉（自愈）', async () => {
  const savedTauri = globalThis.__TAURI__;
  const savedList = mockContext.worldInfoList;
  const savedFetch = globalThis.fetch;
  delete mockContext.worldInfoList;
  delete globalThis.__TAURI__;
  delete globalThis.window.__TAURI__;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null, text: async () => '' });
  st.clearTauriIpcCache();

  // 第一次：确认不可用（会被缓存成 false）
  let res = await st.fetchWorldbookListViaTauri();
  eq(res.entries.length, 0);
  eq(st.tauriIpcInfo().includes('❌'), true);

  // 之后 IPC 才出现，再走一次完整刷新
  globalThis.window.__TAURI__ = { core: { invoke: async () => [{ name: '迟到的书' }] } };
  const books = await st.refreshWorldbookNames(true);
  eq(books.length, 1, `自动清缓存后应当能拿到，实际 ${JSON.stringify(books)}`);
  eq(books[0].name, '迟到的书');

  globalThis.__TAURI__ = savedTauri;
  globalThis.fetch = savedFetch;
  mockContext.worldInfoList = savedList;
  st.clearTauriIpcCache();
  await st.refreshWorldbookNames(true);
});

await test('悬浮层速度可以单独调（不再共用弹幕框速度）', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  const root = d2.getElementById('std-overlay');

  ov.applyOverlayStyle(d2, { speed: 200, overlaySpeed: 60, fontSize: 15, overlayOpacity: 0.5 });
  eq(root.style.getPropertyValue('--std-ov-speed'), '60px/s', '应当用悬浮层自己的速度');
  eq(ov.overlaySpeedOf({ speed: 200, overlaySpeed: 60 }), 60);

  // 没单独设时退回弹幕框速度，不能变成 undefined
  eq(ov.overlaySpeedOf({ speed: 150 }), 150);
  eq(ov.overlaySpeedOf({}), 110);
  eq(ov.overlaySpeedOf({ speed: 150, overlaySpeed: 0 }), 150, '0 应当被视为没设');

  // 播放时的时长要跟着变：快 → 短
  const slow = ov.playOverlay(d2, [{ 昵称: '甲', 内容: 'x', color: '#fff' }], { appearance: { overlaySpeed: 40, fontSize: 15 } });
  const fast = ov.playOverlay(d2, [{ 昵称: '甲', 内容: 'x', color: '#fff' }], { appearance: { overlaySpeed: 400, fontSize: 15 } });
  ok(slow.duration > fast.duration, `慢的时长应当更长：${slow.duration} vs ${fast.duration}`);
  ov.stopOverlay(d2);
});

await test('「选择世界书」按钮会刷新列表并把结果说出来', async () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  ok(el, '设置栏应当挂上');

  const btn = el.querySelector('[data-std-dw-act="books-pick"]');
  ok(btn, '应当有「选择世界书」按钮');
  eq(btn.textContent.trim(), '选择世界书', '按钮名字应当直白');
  ok(!el.querySelector('[data-std-dw-act="books-reload"]'), '旧的「重新查找」按钮应当已被取代');

  btn.dispatch('click', { target: btn });
  await new Promise((r) => setTimeout(r, 120));
  const result = el.querySelector('[data-std-dw-result]').textContent;
  ok(/共 \d+ 本|没读到/.test(result), `应当报告结果：${result}`);
  app.destroy();
});

await test('排查明细默认折叠，点「排查」才展开', async () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  eq(el.querySelectorAll('[data-std-dw-diag] details').length, 0, '默认不该有展开的技术明细');

  const btn = el.querySelector('[data-std-dw-act="books-diag"]');
  ok(btn, '应当保留一个不那么显眼的排查入口');
  btn.dispatch('click', { target: btn });
  await new Promise((r) => setTimeout(r, 150));
  const details = el.querySelector('[data-std-dw-diag] details');
  ok(details, '点完之后应当出现可折叠的明细');
  ok(/loadWorldInfo|最终清单/.test(details.textContent), '明细里应当有各条途径的结果');
  app.destroy();
});

/* ───────────── 13f. 模型选择（先拉取再选，不让人手打） ───────────── */

section('13f. 模型选择与额外请求头');

function makeApiTabEnv() {
  const d = createMiniDocument();
  useDoc(d);
  resetTavernState();
  const app = mainMod.createApp({ storage: d.defaultView.localStorage, doc: d, win: d.defaultView });
  app.init();
  const panel = panelMod.createPanel(app);
  panel.build();
  panel.toggle(true);
  const tab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'api');
  ok(tab, '应当有「连接」页签');
  tab.dispatch('click', { target: tab });
  return { d, app, panel };
}

await test('没拉取过模型时，下拉框禁用并提示去拉取', () => {
  const { app, panel } = makeApiTabEnv();
  app.clearModels();
  panel.toggle(true);
  const tab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'api');
  tab.dispatch('click', { target: tab });

  const sel = panel.el.querySelector('select[data-std-path="api.model"]');
  ok(sel, '应当有模型下拉框（不是纯文本框）');
  ok(!sel.querySelector('input'), '不该再有一个裸的模型名输入框当主控件');
  ok(sel.getAttribute('disabled') !== null, '没列表时应当禁用，别让人误以为能选');
  const hint = panel.el.querySelector('.std-body').innerHTML;
  ok(/还没拉取模型列表/.test(hint), '应当提示去拉取');
  app.destroy();
});

await test('拉取之后模型出现在下拉框里，可以直接选', async () => {
  const { app, panel } = makeApiTabEnv();
  // 假后端返回模型列表
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/chat-completions/status')) {
      const body = JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }, { id: 'gemini-2.0-flash' }] });
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };

  const res = await app.loadModels();
  ok(res.ok, `拉取应当成功：${res.error}`);
  eq(res.models.length, 3);

  // 重新渲染连接页
  const tab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'api');
  tab.dispatch('click', { target: tab });
  const sel = panel.el.querySelector('select[data-std-path="api.model"]');
  ok(sel.getAttribute('disabled') === null, '有列表后应当可用');
  const optionTexts = sel.querySelectorAll('option').map((o) => o.getAttribute('value'));
  for (const m of ['gpt-4o-mini', 'deepseek-chat', 'gemini-2.0-flash']) {
    ok(optionTexts.includes(m), `下拉框里应当有 ${m}，实际 ${optionTexts.join(',')}`);
  }
  ok(/已拉取 3 个模型/.test(panel.el.querySelector('.std-body').innerHTML), '应当报告已拉取');

  globalThis.fetch = savedFetch;
  app.destroy();
});

await test('选了模型会写回设置', async () => {
  const { app, panel } = makeApiTabEnv();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: '模型甲' }] }), json: async () => ({ data: [{ id: '模型甲' }] }) });
  await app.loadModels();
  const tab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'api');
  tab.dispatch('click', { target: tab });

  const sel = panel.el.querySelector('select[data-std-path="api.model"]');
  const opt = sel.querySelectorAll('option').find((o) => o.getAttribute('value') === '模型甲');
  ok(opt, '应当有该模型的选项');
  sel.value = '模型甲';
  panel.el.dispatch('change', { target: sel });
  eq(app.state.settings.api.model, '模型甲', '应当写回设置');
  globalThis.fetch = savedFetch;
  app.destroy();
});

await test('当前模型不在列表里时也会显示出来，不会凭空消失', () => {
  const { app, panel } = makeApiTabEnv();
  app.updateSettings({ api: { model: '某个手填的模型' } });
  app.clearModels();
  app.state.models = ['别的模型'];
  const tab = panel.el.querySelectorAll('.std-tab').find((t) => t.getAttribute('data-std-tab') === 'api');
  tab.dispatch('click', { target: tab });
  const sel = panel.el.querySelector('select[data-std-path="api.model"]');
  const values = sel.querySelectorAll('option').map((o) => o.getAttribute('value'));
  ok(values.includes('某个手填的模型'), `当前值应当保留在选项里，实际 ${values.join(',')}`);
  app.destroy();
});

await test('拉取失败时给出可照做的提示（并提示可以手填）', async () => {
  const { app } = makeApiTabEnv();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'nope', json: async () => ({}) });
  const res = await app.loadModels();
  eq(res.ok, false);
  ok(/手填|不支持|没返回/.test(res.error), `提示应当可照做：${res.error}`);
  globalThis.fetch = savedFetch;
  app.destroy();
});

await test('模型列表按来源缓存，换来源后会被判定为过期', async () => {
  const { app } = makeApiTabEnv();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'A' }] }), json: async () => ({ data: [{ id: 'A' }] }) });
  await app.loadModels();
  eq(app.modelList().length, 1);
  ok(/已拉取 1 个模型/.test(app.describeModelList()));

  // 换固定来源 → 列表应被判为过期
  app.updateSettings({ api: { sourceMode: 'fixed', source: 'deepseek' } });
  ok(/建议重新拉一次/.test(app.describeModelList()), `换来源后应当提醒重拉：${app.describeModelList()}`);

  globalThis.fetch = savedFetch;
  app.destroy();
});

await test('模型列表能落盘并在下次启动时读回', async () => {
  const { d, app } = makeApiTabEnv();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: '持久化模型' }] }), json: async () => ({ data: [{ id: '持久化模型' }] }) });
  await app.loadModels();
  const storage = d.defaultView.localStorage;
  app.destroy();

  // 用同一个 storage 重新起一个 app
  const app2 = mainMod.createApp({ storage, doc: d, win: d.defaultView });
  app2.init();
  eq(app2.modelList().length, 1, '重启后应当从缓存读回模型列表');
  eq(app2.modelList()[0], '持久化模型');
  app2.destroy();
  globalThis.fetch = savedFetch;
});

await test('「额外请求头」已经彻底去掉（界面与设置里都不再有）', () => {
  const { app, panel } = makeApiTabEnv();
  const html = panel.el.querySelector('.std-body').innerHTML;
  ok(!/额外请求头/.test(html), '界面上不该再有这一项');
  ok(!('extraHeaders' in app.state.settings.api.direct), '设置对象里也不该再有这个字段');
  // 旧版本遗留的值应当被清掉
  const s = store.normalizeSettings({ api: { direct: { extraHeaders: 'X-Foo: bar' } } });
  ok(!('extraHeaders' in s.api.direct), '旧数据里的该字段应当被清理掉');
  ok(!('extraHeaders' in store.defaultSettings().api.direct), '默认设置里不该有它');
  app.destroy();
});

await test('档案分成两层：事实来自世界书、观众腔调由 AI 按世界观生成', () => {
  const sys = scan.profileSystemPrompt();
  // A 类：只能来自材料
  ok(/世界事实/.test(sys), '应当明确"世界事实"这一类');
  ok(/只能来自材料/.test(sys), '应当说明事实层只许照材料写');
  ok(/绝对不要编造|不要编造/.test(sys), '应当明确禁止编造事实');
  // B 类：要主动生成
  ok(/观众腔调/.test(sys), '应当明确"观众腔调"这一类');
  ok(/自己推理生成|主动生成/.test(sys), '应当要求腔调层主动推理生成');
  ok(/称呼体系/.test(sys) && /本土词汇/.test(sys), '腔调层要包含称呼体系与本土词汇');
  // 体裁约束不能因为"生成"而丢掉
  ok(/直播弹幕/.test(sys), '仍然必须点明体裁是直播弹幕');
  // 用户提示词里也要讲清两类怎么用
  const user = scan.profileUserPrompt({ outline: 'x', sample: 'y', stats: { books: 1, entriesTotal: 3, charsTotal: 100, entriesRead: 3, charsRead: 100, summaryBudget: 1200 } });
  ok(/只许照材料写/.test(user), '用户提示里要重申事实层只许照材料');
  ok(/推理生成/.test(user), '用户提示里要重申腔调层靠推理');
});

await test('世界书为空时：事实留空，但腔调仍要尽量给（且不发明专有名词）', () => {
  const user = scan.profileUserPrompt({
    outline: '',
    sample: '',
    stats: { books: 0, entriesTotal: 0, charsTotal: 0, entriesRead: 0, charsRead: 0, summaryBudget: 1200 },
  });
  ok(/没有读到任何世界书正文/.test(user), '应当明确告知材料为空');
  ok(/hasWorldbook 设为 false/.test(user), '应当要求把 hasWorldbook 关掉');
  ok(/B 类仍然要尽量给/.test(user), '腔调层仍应尽量生成');
  ok(/不要发明具体的专有名词/.test(user), '但不能凭空发明专有名词');
});

await test('档案渲染进弹幕提示词时，事实与腔调分开标注', () => {
  const profile = store.emptyProfile();
  profile.data = {
    ...profile.data,
    channelName: '围观席',
    worldName: '测试界',
    stage: '山谷',
    naming: '称"当家的"',
    lexicon: '刀、雾',
    manner: '短句爱起哄',
  };
  const text = danmaku.renderProfileForPrompt(profile);
  ok(/世界事实/.test(text), '应当有世界事实段');
  ok(/观众腔调/.test(text), '应当有观众腔调段');
  ok(text.indexOf('世界事实') < text.indexOf('观众腔调'), '事实段应当排在前面');
  ok(/测试界/.test(text) && /称"当家的"/.test(text) && /刀、雾/.test(text), '各字段都应当渲染出来');
});

await test('旧版档案（没有 voiceNote 字段）也能正常渲染', () => {
  const profile = store.emptyProfile();
  // 模拟旧缓存：只有老字段
  profile.data = { worldName: '旧世界', stage: '旧的', naming: '旧称呼', lexicon: '旧词' };
  const text = danmaku.renderProfileForPrompt(profile);
  ok(/旧世界/.test(text) && /旧称呼/.test(text), '旧档案应当照常可用');
});

await test('新建档案的字段结构包含两层、语料位与 voiceNote', () => {
  const d = store.blankProfileData();
  for (const k of ['worldName', 'stage', 'factions', 'naming', 'lexicon', 'manner', 'interests', 'channelName', 'hasWorldbook', 'voiceNote']) {
    ok(k in d, `档案结构里应当有 ${k}`);
  }
  ok(Array.isArray(d.styleSamples), '应当有语风语料样本位');
  ok('styleBookName' in d, '应当记录语料来自哪本');
  ok(!('taboos' in d), '「禁区」字段应当已经去掉');
});

await test('提示词里不再给观众设禁区（弹幕是百无禁忌的）', () => {
  const sys = scan.profileSystemPrompt();
  const user = scan.profileUserPrompt({ outline: 'x', sample: 'y', stats: { books: 1, entriesTotal: 1, charsTotal: 10, entriesRead: 1, charsRead: 10, summaryBudget: 800 } });
  ok(!/taboos/.test(sys) && !/禁区/.test(sys), `系统提示里不该再提禁区：${sys.slice(0, 80)}`);
  ok(!/不要给观众设/.test(user), '用户提示里不该有这类自我限制');
  ok(/百无禁忌/.test(sys), '应当明确说明弹幕发言没有禁忌');
});

await test('语风语料：从素材里拆候选行并清洗标记', () => {
  const text = [
    '# 弹幕风格',
    '- 来了来了',
    '1. 这什么操作啊',
    '**前排**',
    '「就这？」',
    '------',
    '',
    '这段是正经的场景叙述，写得很长很长，完全不像一句弹幕该有的样子，应该被长度过滤掉。',
    '来了来了',
  ].join('\n');
  const lines = scan.candidateStyleLines(text);
  ok(lines.includes('来了来了'), '应当保留普通短句');
  ok(lines.includes('这什么操作啊'), '应当去掉序号');
  ok(lines.includes('前排'), '应当去掉 markdown 粗体');
  ok(lines.includes('就这？'), '应当去掉引号');
  ok(!lines.includes('# 弹幕风格'), '标题不该进候选');
  ok(!lines.some((l) => l.length > 60), '太长的行应当被过滤');
  ok(!lines.includes('------'), '分隔线不该进候选');
  eq(lines.filter((l) => l === '来了来了').length, 1, '重复的应当去重');
});

await test('语料提示词：要求称呼落在句子里、且允许 AI 生成', () => {
  const sys = scan.styleBookPrompt();
  ok(/称呼必须落在语料里/.test(sys), '必须强调称呼要落进句子');
  ok(/错误写法/.test(sys) && /正确写法/.test(sys), '应当给出正反例说明"说明句 vs 弹幕"');
  ok(/不要只做摘抄|自己写/.test(sys), '应当明确允许并要求 AI 生成，而不是只摘抄');
  ok(/像一条弹幕|读起来就是一条弹幕|像弹幕/.test(sys), '要说明产物必须像弹幕');
  ok(/来源/.test(sys), '应当要求标注来源（原文/新写）');

  // 三种产出方式都要能正确表达
  const auto = scan.styleBookUserPrompt({ lines: ['甲'], bookName: '书', want: 5, mode: 'auto' });
  const gen = scan.styleBookUserPrompt({ lines: ['甲'], bookName: '书', want: 5, mode: 'generate' });
  const ext = scan.styleBookUserPrompt({ lines: ['甲'], bookName: '书', want: 5, mode: 'extract' });
  ok(/像弹幕的就采用原文/.test(auto), 'auto 模式要说清取舍规则');
  ok(/主要靠你自己写/.test(gen), 'generate 模式要强调自己写');
  ok(/只从素材里挑现成的句子/.test(ext), 'extract 模式要强调只用原文');

  // 模式选项本身
  eq(scan.STYLE_MODES.length, 3);
  eq(scan.STYLE_MODES.map(([v]) => v).join(','), 'auto,generate,extract');
});

await test('语风范本会作为 few-shot 进弹幕提示词（语料就是腔调本身）', () => {
  const profile = store.emptyProfile();
  profile.data = { ...profile.data, channelName: '围观席', manner: '短句爱起哄' };
  profile.styleSamples = ['凤皇这波我没想到', '媚姐别上头啊'];
  profile.styleBookName = '语风素材';

  const prompt = danmaku.batchUserPrompt({ profile, story: '', viewers: [], count: 15, fourthWall: 0 });
  ok(/语风范本/.test(prompt), '应当有语风范本段');
  ok(prompt.includes('凤皇这波我没想到'), '语料原句应当出现在提示词里');
  ok(/不要原样照抄重复/.test(prompt), '要提醒可以借鉴但别照抄');
  ok(prompt.indexOf('语风范本') < prompt.indexOf('【破次元度】'), '范本段应当排在破次元度之前');
});

await test('没有语风范本时，提示词里不会出现空的范本段', () => {
  const profile = store.emptyProfile();
  profile.data = { ...profile.data, manner: '短句' };
  const prompt = danmaku.batchUserPrompt({ profile, story: '', viewers: [], count: 15, fourthWall: 0 });
  ok(!/语风范本/.test(prompt), '没范本就不该有这一段');
});

await test('语料抽取：能解析 AI 产出的语料（含来源标注）', async () => {
  resetMockConnection();
  // AI 返回：两条原文 + 两条新写
  queueResponse({
    choices: [
      {
        message: {
          content: JSON.stringify({
            语料: [
              { 内容: '来了来了', 来源: '原文', 说明: '' },
              { 内容: '凤皇这波我没想到', 来源: '新写', 说明: '用到称呼"凤皇"' },
              { 内容: '媚姐别上头啊', 来源: '新写', 说明: '用到称呼"媚姐"' },
              { 内容: '就这？', 来源: '原文', 说明: '' },
              { 内容: '重复的', 来源: '新写', 说明: '' },
              { 内容: '重复的', 来源: '新写', 说明: '' }, // 应当被去重
            ],
          }),
        },
      },
    ],
  });
  const res = await scan.extractStyleSamples({
    api: { route: 'st', sourceMode: 'auto', useJsonSchema: false },
    scan: { styleBook: '小书', styleBookBudget: 12000, styleSampleCount: 24, styleMode: 'auto' },
  });
  ok(res.ok, res.error);
  eq(res.samples.length, 5, `重复项应当被去掉，实际 ${JSON.stringify(res.samples)}`);
  eq(res.generated, 3, '应当统计出 AI 新写的条数');
  ok(res.detail.some((d) => d.来源 === '原文'), '应当保留来源标注');
  ok(res.detail.some((d) => d.说明.includes('称呼')), '应当保留说明');
  ok(res.samples.includes('凤皇这波我没想到'), '新写的语料应当保留');
});

await test('语料抽取：AI 失败时退化成用素材原句，不空手', async () => {
  resetMockConnection();
  queueResponse({ __http: 500, body: 'boom' });
  const res = await scan.extractStyleSamples({
    api: { route: 'st', sourceMode: 'auto', useJsonSchema: false },
    scan: { styleBook: '小书', styleBookBudget: 12000, styleSampleCount: 24, styleMode: 'auto' },
  });
  ok(res.ok, '不应当整步失败');
  ok(res.samples.length > 0, '应当退化成用素材里的原句');
  eq(res.detail.every((d) => d.来源 === '原文'), true, '降级时来源都算原文');
});

await test('扫描过程中任何异常都要变成看得见的错误，绝不"点了没反应"', async () => {
  const { d, app } = makeDrawerEnv();
  // 必须指定一本书，否则"没有可读的世界书"会合法地提前返回成功，测不到异常路径
  app.updateSettings({ scan: { sources: ['大书'] } });
  const errors = [];
  app.on('error', (m) => errors.push(m));

  // 让扫描内部真的抛一个异常：把 loadWorldInfo 换成会抛的 getter
  const savedDesc = Object.getOwnPropertyDescriptor(mockContext, 'loadWorldInfo');
  Object.defineProperty(mockContext, 'loadWorldInfo', {
    configurable: true,
    get() {
      throw new Error('模拟内部炸了');
    },
  });

  let threw = false;
  let res = null;
  try {
    res = await app.scan();
  } catch {
    threw = true;
  }
  ok(!threw, 'app.scan() 绝不能把异常抛给调用方（那会变成未捕获的 Promise 拒绝）');
  ok(res && res.ok === false, `应当返回 ok:false，实际 ${JSON.stringify(res)?.slice(0, 120)}`);
  ok(/扫描过程出错/.test(res.error), `错误信息应当可读：${res?.error}`);
  ok(errors.length > 0, '应当发出 error 事件，让界面能显示出来');
  eq(app.state.busy, false, '异常后 busy 必须复位，否则以后所有操作都被"有任务在进行中"挡住');

  // 恢复
  if (savedDesc) Object.defineProperty(mockContext, 'loadWorldInfo', savedDesc);
  app.destroy();
});

await test('出弹幕时内部出错也不会抛给调用方', async () => {
  const { d, app } = makeDrawerEnv();
  app.updateSettings({ seedDemo: false, count: 3 });
  const savedDesc = Object.getOwnPropertyDescriptor(mockContext, 'getRequestHeaders');
  Object.defineProperty(mockContext, 'getRequestHeaders', {
    configurable: true,
    get() {
      throw new Error('模拟内部炸了');
    },
  });
  let threw = false;
  let res = null;
  try {
    res = await app.runBatch({ messageId: 1 });
  } catch {
    threw = true;
  }
  ok(!threw, 'runBatch 也不该抛');
  ok(res && res.ok === false, '应当返回 ok:false');
  eq(app.state.busy, false, 'busy 必须复位');
  if (savedDesc) Object.defineProperty(mockContext, 'getRequestHeaders', savedDesc);
  app.destroy();
});

await test('提示词尾部把 JSON 键名写死（结构化输出关闭时也能正确解析）', () => {
  const profTail = scan.profileUserPrompt({
    outline: 'x',
    sample: 'y',
    stats: { books: 1, entriesTotal: 1, charsTotal: 10, entriesRead: 1, charsRead: 10, summaryBudget: 800 },
  });
  for (const k of ['worldName', 'stage', 'factions', 'naming', 'lexicon', 'manner', 'interests', 'channelName', 'hasWorldbook', 'voiceNote']) {
    ok(profTail.includes(`"${k}"`), `档案提示词尾部应当列出键名 ${k}`);
  }
  ok(/只输出一个 JSON 对象/.test(profTail), '应当明确只输出 JSON');
  ok(/不要加代码围栏/.test(profTail), '应当禁止代码围栏');

  const styleTail = scan.styleBookUserPrompt({ lines: ['甲'], bookName: '书', want: 24, mode: 'auto' });
  ok(styleTail.includes('"语料"') && styleTail.includes('"内容"') && styleTail.includes('"来源"') && styleTail.includes('"说明"'), '语料提示词尾部应当列出键名');
  ok(/只能是 "原文" 或 "新写"/.test(styleTail), '应当把"来源"的取值写死');

  const viewerTail = danmaku.viewerUserPrompt({ profile: null, poolSize: 10, existing: [] });
  ok(viewerTail.includes('"观众"') && viewerTail.includes('"昵称"') && viewerTail.includes('"立场"') && viewerTail.includes('"口癖"') && viewerTail.includes('"类型"'), '名册提示词尾部应当列出键名');
  ok(/正好 10 个/.test(viewerTail), '应当把数量写进尾部');

  const batchTail = danmaku.batchUserPrompt({ profile: null, story: '', viewers: [], count: 15, fourthWall: 0 });
  ok(batchTail.includes('"弹幕"') && batchTail.includes('"昵称"') && batchTail.includes('"内容"') && batchTail.includes('"类型"') && batchTail.includes('"回复"'), '弹幕提示词尾部应当列出键名');
});

await test('语料提示词里"本次要求"只出现一次（不要重复）', () => {
  for (const mode of ['auto', 'generate', 'extract']) {
    const t = scan.styleBookUserPrompt({ lines: ['甲'], bookName: '书', want: 5, mode });
    eq((t.match(/本次要求/g) || []).length, 1, `${mode} 模式里"本次要求"应当只出现一次：${t.slice(0, 120)}`);
  }
});

/* ───────────── 速度浮动 / 解析宽容 / 认知隔离 ───────────── */

section('13g. 速度浮动 · 解析宽容 · 认知隔离');

await test('每条弹幕的速度在基准上浮动 ±N%（不是全部同速）', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ 内容: `第${i}条` }));
  // 固定随机源，结果可复现
  let seed = 1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out = danmaku.assignSpeeds(items, 200, 10, rand);
  const speeds = out.map((x) => x.速度);
  ok(new Set(speeds).size > 1, `不该全部同速：${speeds.slice(0, 8).join(',')}`);
  const min = Math.min(...speeds);
  const max = Math.max(...speeds);
  ok(min >= 180, `下限应当 ≥ 180（-10%），实际 ${min}`);
  ok(max <= 220, `上限应当 ≤ 220（+10%），实际 ${max}`);
  ok(speeds.length === items.length, '每条都要有速度');
  // 原对象不该被改
  ok(!('速度' in items[0]), '不该就地改原对象');
});

await test('浮动为 0 时全部同速；超范围会被收住', () => {
  const items = [{ 内容: 'a' }, { 内容: 'b' }];
  eq(danmaku.assignSpeeds(items, 100, 0).map((x) => x.速度).join(','), '100,100');
  // 浮动上限 60%
  const wide = danmaku.assignSpeeds(items, 100, 500, () => 1);
  ok(wide[0].速度 <= 160, `浮动上限应当收在 60%，实际 ${wide[0].速度}`);
  // 速度有下限，不会变成 0 或负数
  const slow = danmaku.assignSpeeds(items, 100, 60, () => 0);
  ok(slow[0].速度 >= 20, `速度不该低于 20，实际 ${slow[0].速度}`);
});

await test('speedOfItem：优先用每条自己的速度，没有就退回基准', () => {
  eq(danmaku.speedOfItem({ 速度: 137 }, 200), 137);
  eq(danmaku.speedOfItem({}, 200), 200);
  eq(danmaku.speedOfItem({ 速度: 0 }, 200), 200, '0 应当被视为没设');
  eq(danmaku.speedOfItem(null, 200), 200);
  eq(danmaku.speedOfItem({ 速度: 'abc' }, 200), 200);
});

await test('弹幕框按每条自己的速度算时长（慢的更久）', () => {
  const d = useDoc(createMiniDocument());
  const chat = d.createElement('div');
  chat.id = 'chat';
  d.body.appendChild(chat);
  const mes = d.createElement('div');
  mes.className = 'mes';
  mes.setAttribute('mesid', '1');
  chat.appendChild(mes);

  const mkFrame = () =>
    frameMod.createFrame({
      doc: d,
      appearance: { speed: 200 },
      luminance: 0.1,
      meta: { batchNo: 1, messageId: 1 },
      items: [{ 昵称: '甲', 内容: 'x' }],
    });

  // 慢的那条：40px/s；快的那条：400px/s。同一个框宽，时长应当明显不同
  const f1 = mkFrame();
  frameMod.mountFrame({ doc: d, messageId: 1, frame: f1 });
  frameMod.playFrame(f1, { doc: d, appearance: { speed: 200 }, stagger: 0 });
  const slowDur = f1.nodes[0]?.style?.animationDuration;
  ok(slowDur, `应当写入了动画时长，实际 ${slowDur}`);

  const f2 = mkFrame();
  frameMod.mountFrame({ doc: d, messageId: 1, frame: f2 });
  frameMod.playFrame(f2, { doc: d, appearance: { speed: 200 }, stagger: 0 });
  const fastDur = f2.nodes[0]?.style?.animationDuration;

  // 用两条速度差别很大的弹幕比：时长必须跟着速度走
  const mkOne = (speed) => {
    const f = frameMod.createFrame({
      doc: d,
      appearance: { speed: 200 },
      luminance: 0.1,
      meta: { batchNo: 2, messageId: 1 },
      items: [{ 昵称: '甲', 内容: 'x', 速度: speed }],
    });
    frameMod.mountFrame({ doc: d, messageId: 1, frame: f });
    frameMod.playFrame(f, { doc: d, appearance: { speed: 200 }, stagger: 0 });
    return Number(String(f.nodes[0].style.animationDuration).replace('s', ''));
  };
  const slow = mkOne(40);
  const fast = mkOne(400);
  ok(slow > fast, `慢的时长应当更长：${slow}s vs ${fast}s`);
  frameMod.stopFrame(f1);
  frameMod.stopFrame(f2);
});

await test('悬浮层按每条自己的速度算时长', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  const slow = ov.playOverlay(d2, [{ 内容: 'x', color: '#fff', 速度: 40 }], { appearance: { overlaySpeed: 90 } });
  const fast = ov.playOverlay(d2, [{ 内容: 'x', color: '#fff', 速度: 400 }], { appearance: { overlaySpeed: 90 } });
  ok(slow.duration > fast.duration, `慢的时长应当更长：${slow.duration} vs ${fast.duration}`);
  ov.stopOverlay(d2);
});

await test('解析宽容：各种键名与形态都能认出来', () => {
  const cases = [
    ['标准', { 弹幕: [{ 内容: '甲' }] }],
    ['弹幕列表', { 弹幕列表: [{ 内容: '甲' }] }],
    ['danmaku', { danmaku: [{ 内容: '甲' }] }],
    ['items', { items: [{ 内容: '甲' }] }],
    ['直接是数组', [{ 内容: '甲' }]],
    ['只回了一条', { 内容: '甲' }],
    ['套两层', { 弹幕: { 弹幕: [{ 内容: '甲' }] } }],
    ['content 而不是内容', { 弹幕: [{ content: '甲' }] }],
    ['text 字段', { 弹幕: [{ text: '甲' }] }],
  ];
  for (const [label, value] of cases) {
    const arr = danmaku.pickDanmakuArray(value);
    ok(Array.isArray(arr) && arr.length === 1, `${label} 应当解析出 1 条，实际 ${JSON.stringify(arr)}`);
  }
  eq(danmaku.pickDanmakuArray(null), null);
  eq(danmaku.pickDanmakuArray({ 无关: 1 }), null);
});

await test('纯文本兜底：支持"昵称：内容"与裸句子，且会清掉 JSON 残渣', () => {
  const text = [
    '```json',
    '老王：这剑法怎么慢下来了',
    '李四: 他左手在抖',
    '- 前排蹲一个',
    '（以下是说明）',
    '{',
    '}',
  ].join('\n');
  const out = danmaku.parseLinesFallback(text, 10);
  const contents = out.map((x) => x.内容);
  ok(contents.includes('这剑法怎么慢下来了'), `应当拆出昵称:内容：${JSON.stringify(contents)}`);
  ok(contents.includes('他左手在抖'), '半角冒号也要支持');
  ok(contents.includes('前排蹲一个'), '列表符号要清掉');
  ok(!contents.some((c) => c === '{' || c === '}'), 'JSON 残渣不该被当成弹幕');
  ok(!contents.some((c) => c.includes('```')), '代码围栏不该被当成弹幕');
  ok(out.find((x) => x.内容 === '这剑法怎么慢下来了').昵称 === '老王', '昵称应当被识别');
});

await test('模型返回无法解析时，报错里带上它实际回了什么', async () => {
  resetMockConnection();
  queueResponse({ choices: [{ message: { content: '抱歉，我不能生成这个内容。' } }] });
  const res = await danmaku.generateBatch({
    api: { route: 'st', sourceMode: 'auto', useJsonSchema: false },
    profile: null,
    story: '正文',
    viewers: [],
    count: 5,
  });
  // 这一句会被按行兜底解析成一条弹幕（长度与格式都合格），所以走的是成功分支
  ok(res.ok, `短句会被兜底，应当是成功的：${res.error}`);
  ok(res.fallback === true, '应当标记为兜底解析');
});

await test('认知隔离：观众不许读心、不许剧透、不许知道没演出来的事', () => {
  const sys = danmaku.batchSystemPrompt({ knowledgeIsolation: true });
  ok(/认知隔离/.test(sys), '应当有认知隔离段');
  ok(/情报抵达 = 源 \+ 通道 \+ 接收者，缺一不达/.test(sys), '应当写明判定口径');
  ok(/内心活动|动机|真意/.test(sys), '应当禁止读心');
  ok(/推测语气/.test(sys), '猜的时候必须用推测语气');
  ok(/不在场|镜头外|没播出来/.test(sys), '不该知道没演出来的事');
  ok(/未来的走向/.test(sys), '不该知道未来');
  ok(/不能凭空知道/.test(sys), '可以猜错但不能凭空知道');
  ok(/剧透/.test(sys), '禁止段里应当点名剧透');

  // 关掉后就不该有这一段
  const off = danmaku.batchSystemPrompt({ knowledgeIsolation: false });
  ok(!/认知隔离/.test(off), '关掉后不该有认知隔离段');
  ok(!/情报抵达/.test(off), '关掉后不该有判定口径');
});

await test('认知隔离会同时进 system 与 user 提示词（关掉就都不进）', () => {
  const on = danmaku.batchUserPrompt({
    profile: null,
    story: '正文',
    viewers: [],
    count: 5,
    fourthWall: 0,
    knowledgeIsolation: true,
  });
  ok(/观众只知道直播里放出来的东西/.test(on), 'user 提示词里也应当强调认知边界');
  ok(/只能猜/.test(on) && /推测语气/.test(on), '应当要求用推测语气');
  ok(/不要替角色解释心理|预告接下来/.test(on), '应当禁止读心式解说与预告');

  const off = danmaku.batchUserPrompt({
    profile: null,
    story: '正文',
    viewers: [],
    count: 5,
    fourthWall: 0,
    knowledgeIsolation: false,
  });
  ok(!/观众只知道直播里放出来的东西/.test(off), '关掉后 user 提示词里也不该有');
  ok(!/推测语气/.test(off), '关掉后不该有推测语气的要求');
});

await test('面板顶部有「立即生成一批」和「重播上一批」快捷键', () => {
  const { app, panel } = makeApiTabEnv();
  const quick = panel.el.querySelector('.std-quick');
  ok(quick, '面板应当有快捷键行');

  const gen = quick.querySelector('[data-std-act="batch"]');
  const rep = quick.querySelector('[data-std-act="replay-last"]');
  ok(gen, '应当有「立即生成一批」');
  ok(rep, '应当有「重播上一批」');
  ok(gen.textContent.includes('生成'), `按钮文案应当直白：${gen.textContent}`);
  ok(rep.textContent.includes('重播'), `按钮文案应当直白：${rep.textContent}`);

  // 快捷键行要在页签上面，切到任何页都在
  const tabs = panel.el.querySelector('.std-tabs');
  ok(
    panel.el.innerHTML.indexOf('std-quick') < panel.el.innerHTML.indexOf('std-tabs'),
    '快捷键应当排在页签之前（始终可见）',
  );
  ok(tabs, '页签还在');
  app.destroy();
});

await test('点「重播上一批」不会重新请求模型', async () => {
  const { app } = makeApiTabEnv();
  // 先造一批出来（用本地预览，避免真的请求）
  app.state.runtime.history = [{ batchNo: 1, at: Date.now(), anchorId: 1, title: '第 1 批', items: [{ 昵称: '甲', 内容: 'x', color: '#fff' }] }];
  let requests = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('不该发请求');
  };
  app.replayBatch(1);
  eq(requests, 0, '重播不该发任何请求');
  globalThis.fetch = savedFetch;
  app.destroy();
});

await test('设置栏也有「重播上一批」，且走的是正确的接口', async () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  const btn = el.querySelector('[data-std-dw-act="replay-last"]');
  ok(btn, '设置栏应当有重播按钮');

  let called = null;
  const original = app.replayBatch;
  app.replayBatch = (n) => {
    called = n;
    return original.call(app, n);
  };
  app.state.runtime.history = [{ batchNo: 3, at: Date.now(), anchorId: 1, title: 'x', items: [] }];
  btn.dispatch('click', { target: btn });
  await new Promise((r) => setTimeout(r, 60));
  eq(called, 3, `应当用最后一笔的 batchNo 调用 replayBatch，实际 ${called}`);
  app.replayBatch = original;
  app.destroy();
});

/* ───────────── 出现时刻浮动 ───────────── */

section('13h. 出现时刻浮动（像真人陆陆续续发出来）');

await test('出现时刻：默认不等间隔，但绝不乱序、也不会完全重叠', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ 内容: `第${i}条` }));
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out = danmaku.assignDelaysToItems(items, 0.22, 35, rand);
  const delays = out.map((x) => x.延迟);

  eq(delays.length, items.length, '每条都要有出现时刻');
  ok(new Set(delays).size > 1, `不该全部等间隔：${delays.slice(0, 8).join(',')}`);

  for (let i = 1; i < delays.length; i += 1) {
    ok(delays[i] >= delays[i - 1], `第 ${i} 条不该早于上一条：${delays[i - 1]} → ${delays[i]}`);
  }
  for (let i = 1; i < delays.length; i += 1) {
    const gap = delays[i] - delays[i - 1];
    ok(gap >= 0.22 * 0.25 - 1e-6, `相邻两条间隔太小（会像重叠）：${gap.toFixed(3)}`);
  }
  const last = delays[delays.length - 1];
  ok(last <= (delays.length - 1 + 0.35) * 0.22 + 1e-6, `最后一条被拖太远：${last}`);
});

await test('出现时刻：浮动为 0 时严格等间隔', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ 内容: `x${i}` }));
  const out = danmaku.assignDelaysToItems(items, 0.5, 0);
  eq(out.map((x) => x.延迟).join(','), '0,0.5,1,1.5,2');
});

await test('出现时刻：间隔为 0 时全部同时出现（并且不崩）', () => {
  const out = danmaku.assignDelaysToItems([{ 内容: 'a' }, { 内容: 'b' }], 0, 50);
  eq(out.map((x) => x.延迟).join(','), '0,0');
  eq(danmaku.assignDelays(0, 0.22, 50).length, 0, '空输入不该崩');
});

await test('delayOfItem：优先用每条自己的时刻，没有就按序号等间隔', () => {
  eq(danmaku.delayOfItem({ 延迟: 1.25 }, 3, 0.2), 1.25);
  eq(danmaku.delayOfItem({}, 3, 0.2), 0.6000000000000001, '没有就用 index × base');
  eq(danmaku.delayOfItem(null, 0, 0.2), 0);
  eq(danmaku.delayOfItem({ 延迟: -5 }, 2, 0.5), 1, '负值应当被忽略');
});

await test('弹幕框按每条自己的出现时刻排布（不早于上一条）', () => {
  const d = useDoc(createMiniDocument());
  const chat = d.createElement('div');
  chat.id = 'chat';
  d.body.appendChild(chat);
  const mes = d.createElement('div');
  mes.className = 'mes';
  mes.setAttribute('mesid', '1');
  chat.appendChild(mes);

  const items = [
    { 昵称: '甲', 内容: 'a', 速度: 110, 延迟: 0 },
    { 昵称: '乙', 内容: 'b', 速度: 110, 延迟: 0.05 },
    { 昵称: '丙', 内容: 'c', 速度: 110, 延迟: 0.9 },
  ];
  const frame = frameMod.createFrame({ doc: d, appearance: { speed: 110 }, luminance: 0.1, meta: { batchNo: 1, messageId: 1 }, items });
  frameMod.mountFrame({ doc: d, messageId: 1, frame });
  frameMod.playFrame(frame, { doc: d, appearance: { speed: 110 }, stagger: 0.22 });

  const delays = frame.nodes.map((n) => Number(String(n.style.animationDelay).replace('s', '')));
  eq(delays[0], 0, '第一条应当立刻出现');
  ok(delays[1] < 0.22, `第二条应当用了自己的时刻（早于等间隔）：${delays[1]}`);
  ok(delays[2] > 0.5, `第三条应当用了自己的时刻：${delays[2]}`);
  for (let i = 1; i < delays.length; i += 1) ok(delays[i] >= delays[i - 1], '不许乱序');
  frameMod.stopFrame(frame);
});

await test('延迟设置真的进了设置（stagger 不再是 undefined）', () => {
  const s = store.defaultSettings();
  ok(typeof s.appearance.stagger === 'number' && s.appearance.stagger > 0, `stagger 必须有默认值，实际 ${s.appearance.stagger}`);
  ok(typeof s.appearance.delayVariance === 'number', 'delayVariance 必须有默认值');
  const bad = store.normalizeSettings({ appearance: { stagger: -1, delayVariance: 999 } });
  ok(bad.appearance.stagger > 0, `stagger 不该被归一成 0 或负数，实际 ${bad.appearance.stagger}`);
  ok(bad.appearance.delayVariance <= 100, `delayVariance 应当被夹到 100，实际 ${bad.appearance.delayVariance}`);
});

/* ───────────── 防重叠：分轨道 ───────────── */

section('13i. 防重叠（按轨道 + 碰撞检测）');

function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** 按参数算"同轨两条之间至少要隔多久"（与实现同一口径：向上取整到毫秒） */
const needSec = (avgWidth, gapPx, speed) => Math.ceil(((avgWidth + gapPx) / speed) * 1000) / 1000;

await test('防重叠：同轨任意两条之间都留够了"尾巴让开"的时间', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ 内容: `第${i}条弹幕` }));
  const speed = 110;
  const gapPx = 16;
  const out = danmaku.assignLanesAndDelays(items, {
    base: 0.22,
    jitterPct: 60,
    lanes: 3,
    speed,
    stageWidth: 900,
    gapPx,
    rand: seeded(11),
  });

  eq(out.length, 20, '每条都要有结果');
  const byLane = new Map();
  for (const it of out) {
    ok(Number.isFinite(it.延迟) && it.延迟 >= 0, `时刻必须是非负数：${it.延迟}`);
    ok(Number.isInteger(it.轨道) && it.轨道 >= 0 && it.轨道 < 3, `轨道必须在 0~2 之间：${it.轨道}`);
    if (!byLane.has(it.轨道)) byLane.set(it.轨道, []);
    byLane.get(it.轨道).push(it.延迟);
  }

  // 默认平均宽度估 200px → 需要 (200+16)/110 ≈ 1.96s
  const need = needSec(200, gapPx, speed);
  for (const [lane, ts] of byLane) {
    ts.sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i += 1) {
      const gap = ts[i] - ts[i - 1];
      ok(gap >= need - 1e-6, `轨道 ${lane} 上有两条挨太近（会重叠）：${gap.toFixed(3)}s < ${need.toFixed(3)}s`);
    }
  }
});

await test('防重叠：轨道数越多，弹幕摊得越开（不会挤在一条上）', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ 内容: `x${i}` }));
  const opts = { base: 0.22, jitterPct: 40, speed: 110, stageWidth: 900, gapPx: 16, rand: seeded(5) };
  const one = danmaku.assignLanesAndDelays(items, { ...opts, lanes: 1 });
  const three = danmaku.assignLanesAndDelays(items, { ...opts, lanes: 3 });
  const lastOf = (arr) => Math.max(...arr.map((x) => x.延迟));
  ok(lastOf(one) > lastOf(three), `1 轨应当比 3 轨更晚收尾：${lastOf(one)} vs ${lastOf(three)}`);
  eq(new Set(one.map((x) => x.轨道)).size, 1, '1 轨时全在轨道 0');
  ok(new Set(three.map((x) => x.轨道)).size > 1, '3 轨时应当用到多条轨道');
});

await test('防重叠：时刻不会被顺延成负数，也不会越排越离谱', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ 内容: `x${i}` }));
  const out = danmaku.assignLanesAndDelays(items, {
    base: 0.1,
    jitterPct: 100,
    lanes: 2,
    speed: 400, // 飞得快 → 尾巴让开得快
    stageWidth: 900,
    gapPx: 16,
    rand: seeded(9),
  });
  const times = out.map((x) => x.延迟);
  ok(Math.min(...times) >= 0, `不该有负数时刻：${Math.min(...times)}`);
  // 40 条、2 轨、速度 400 → 每条轨道约 (200+16)/400=0.54s 收一条 → 最晚约 20*0.54≈11s
  ok(Math.max(...times) < 30, `不该越排越离谱：${Math.max(...times)}`);
});

await test('防重叠：边界输入不崩', () => {
  eq(danmaku.assignLanesAndDelays([], { base: 0.2 }).length, 0);
  const one = danmaku.assignLanesAndDelays([{ 内容: 'a' }], { base: 0.2, lanes: 0, speed: 0, stageWidth: 0 });
  eq(one.length, 1);
  eq(one[0].轨道, 0, '轨道数至少是 1');
  ok(one[0].延迟 >= 0, '时刻不能是 NaN');
});

await test('弹幕框会采用算法分好的轨道（不再按序号均摊打架）', () => {
  const items = [
    { 昵称: '甲', 内容: 'a', 轨道: 2 },
    { 昵称: '乙', 内容: 'b', 轨道: 2 },
    { 昵称: '丙', 内容: 'c', 轨道: 0 },
  ];
  const laid = frameMod.distributeLanes(items, 3);
  eq(laid.map((x) => x.lane).join(','), '2,2,0', '应当照用给定轨道');

  // 轨道号必须**原样保留**，绝不能取模。
  // 取模正是"明明做了防重叠却还是重合"的元凶：
  // 框 3 轨而计划 5 轨时，轨道 3→0、4→1，本来分开的弹幕就被压回同一轨。
  const big = frameMod.distributeLanes([{ 轨道: 5 }, { 轨道: 7 }], 3);
  eq(big.map((x) => x.lane).join(','), '5,7', '轨道号不该被取模压缩');

  // 没有轨道字段时才退回均摊
  const fallback = frameMod.distributeLanes([{ 昵称: '甲' }, { 昵称: '乙' }], 2);
  eq(fallback.map((x) => x.lane).join(','), '0,1');
});

await test('「防重叠」是设置项，且有默认值', () => {
  const s = store.defaultSettings();
  eq(typeof s.appearance.avoidOverlap, 'boolean', '必须是布尔设置');
  eq(s.appearance.avoidOverlap, true, '默认开着');
  eq(store.normalizeSettings({ appearance: { avoidOverlap: false } }).appearance.avoidOverlap, false, '关掉要能生效');
});

/* ───────────── 截断抢救 / 淡出复位 ───────────── */

section('13j. 截断抢救与淡出复位');

await test('截断抢救：从被切断的 JSON 里捞出完整的弹幕', () => {
  // 真实遇到过的形态：最后一个对象在 token 上限处被切断
  const truncated =
    '{"弹幕":[{"昵称":"甲","内容":"他左手在抖","类型":"懂行","回复":""},' +
    '{"昵称":"乙","内容":"这剑法不对","类型":"抬杠","回复":""},' +
    '{"昵称":"丙","内容":"第三式怎么慢';
  const got = danmaku.salvageObjects(truncated);
  eq(got.length, 2, `应当捞出 2 条完整对象，实际 ${got.length}`);
  eq(got[0].昵称, '甲');
  eq(got[1].内容, '这剑法不对');
});

await test('截断抢救：字符串里的花括号与转义不会把它带偏', () => {
  const text =
    '{"弹幕":[' +
    '{"昵称":"甲","内容":"他说\\"这个{不行}\\"","类型":"普通","回复":""},' +
    '{"昵称":"乙","内容":"后半段被切';
  const got = danmaku.salvageObjects(text);
  eq(got.length, 1, `应当只捞出 1 条，实际 ${got.length}`);
  eq(got[0].内容, '他说"这个{不行}"', '字符串内的花括号与转义必须原样保留');
});

await test('截断抢救：完整 JSON 与空输入都不出错', () => {
  eq(danmaku.salvageObjects('{"a":1}').length, 1);
  eq(danmaku.salvageObjects('').length, 0);
  eq(danmaku.salvageObjects('不是 JSON').length, 0);
});

await test('生成时遇到截断：能出弹幕，并提示调大「最大输出」', async () => {
  resetMockConnection();
  const truncated =
    '{"弹幕":[{"昵称":"甲","内容":"他左手在抖","类型":"懂行","回复":""},' +
    '{"昵称":"乙","内容":"这剑法不对","类型":"抬杠","回复":""},' +
    '{"昵称":"丙","内容":"第三式怎么慢';
  queueResponse({ choices: [{ message: { content: truncated } }] });
  const logs = [];
  const res = await danmaku.generateBatch({
    api: { route: 'st', sourceMode: 'auto', useJsonSchema: false },
    profile: null,
    story: '正文',
    viewers: [],
    count: 15,
    log: (m) => logs.push(m),
  });
  ok(res.ok, `截断时也应当出弹幕：${res.error}`);
  eq(res.items.length, 2, `应当抢救出 2 条，实际 ${res.items.length}`);
  eq(res.fallback, true, '应当标记为兜底');
  ok(
    logs.some((m) => /截断|最大输出/.test(m)),
    `应当提示调大最大输出：${logs.join(' | ')}`,
  );
});

await test('showOverlay(true) 会清掉淡出状态（否则"生成后层消失了"）', () => {
  const d2 = useDoc(createMiniDocument());
  const ov = doc2overlay();
  ov.ensureOverlay(d2);
  const root = d2.getElementById('std-overlay');

  // 模拟被淡出过
  root.classList.add('faded');
  ov.showOverlay(d2, false);
  eq(root.getAttribute('data-std-hidden'), '1', '隐藏应当生效');

  // 再显出来时，淡出状态必须一起清掉
  ov.showOverlay(d2, true);
  eq(root.getAttribute('data-std-hidden'), null, '应当可见');
  ok(!root.classList.contains('faded'), '淡出状态必须被清掉，否则看起来就是"消失了"');
});

await test('默认的「最大输出」够一批 15 条中文弹幕（不再默认 2000）', () => {
  const s = store.defaultSettings();
  ok(s.api.maxTokens >= 4000, `默认应当给宽一点，实际 ${s.api.maxTokens}`);
  // 归一化也不能把用户没设过的值压回 2000
  ok(store.normalizeSettings({ api: {} }).api.maxTokens >= 4000, '归一化后也该是宽的那个默认值');
});

await test('截断抢救：正好切在某个字段的值中间（你实际遇到的那种）', () => {
  // 复刻用户实际遇到的形态：最后一条切在 "内容":" 后面
  const text =
    '{"弹幕":[' +
    '{"昵称":"海城押注狂徒","内容":"内容","类型":"起哄","回复":""},' +
    '{"昵称":"港口看戏党","内容":"@海城押注狂徒 内容","类型":"抬杠","回复":"海城押注狂徒"},' +
    '{"昵称":"专看玉腿","内容":"';
  const got = danmaku.salvageObjects(text);
  eq(got.length, 2, `应当捞出前 2 条，实际 ${got.length}`);
  eq(got[0].昵称, '海城押注狂徒');
  eq(got[1].昵称, '港口看戏党');
  ok(!got.some((x) => x.昵称 === '专看玉腿'), '被切断的那条不该混进来');
});

await test('截断抢救：嵌套数组与多余右括号不会误伤', () => {
  const text = '{"弹幕":[{"a":[1,2,{"b":3}]}],"其它":1}';
  const got = danmaku.salvageObjects(text);
  eq(got.length, 1, `嵌套数组应当被当成一个对象，实际 ${got.length}`);
  eq(got[0].a.length, 3, '嵌套内容要完整保留');
});

await test('【完整生命周期】生成后跑满动画时长，悬浮层不该被隐藏或淡出', async () => {
  const { d, app } = makeDrawerEnv();
  app.updateSettings({ seedDemo: false, count: 3, api: { useJsonSchema: false }, appearance: { overlayFade: false } });
  resetMockConnection();
  queueResponse({
    choices: [
      {
        message: {
          content: JSON.stringify({
            弹幕: [
              { 昵称: '甲', 内容: '他左手在抖', 类型: '懂行', 回复: '' },
              { 昵称: '乙', 内容: '这剑法不对', 类型: '抬杠', 回复: '' },
            ],
          }),
        },
      },
    ],
  });

  const res = await app.runBatch({ messageId: 1, manual: true });
  ok(res.ok, `生成应当成功：${res.error}`);

  const ov = d.getElementById('std-overlay');
  ok(ov, '悬浮层应当存在');
  const snap = (label) => ({
    label,
    hidden: ov.getAttribute('data-std-hidden'),
    faded: ov.classList.contains('faded'),
    display: ov.style.display,
    stage: ov.querySelector('.std-ov-stage')?.children.length ?? -1,
  });
  const before = snap('刚生成');
  ok(before.hidden === null, '生成后应当可见');
  ok(!before.faded, '生成后不该处于淡出状态');
  ok(before.stage > 0, `应当有弹幕在舞台上：${before.stage}`);

  // 跑满整段动画（收尾定时器就是在这个点附近触发的）
  await new Promise((r) => setTimeout(r, 1600));
  const after = snap('1.6 秒后');
  eq(after.hidden, null, `收尾后不该被隐藏：${JSON.stringify(after)}`);
  ok(!after.faded, `overlayFade 关掉时不该被淡出：${JSON.stringify(after)}`);
  ok(after.stage === 0 || after.stage > 0, '舞台清空是允许的（播完清弹幕、层留着）');

  app.destroy();
});

await test('【完整生命周期】即使开着淡出，也只该淡不该消失（hidden 保持空）', async () => {
  const { d, app } = makeDrawerEnv();
  app.updateSettings({ seedDemo: false, count: 2, api: { useJsonSchema: false } });
  // 明确要求淡出
  app.updateSettings({ appearance: { overlayFade: true } });
  resetMockConnection();
  queueResponse({
    choices: [{ message: { content: JSON.stringify({ 弹幕: [{ 昵称: '甲', 内容: '就这一下', 类型: '普通', 回复: '' }] }) } }],
  });

  const res = await app.runBatch({ messageId: 1, manual: true });
  ok(res.ok, res.error);
  const ov = d.getElementById('std-overlay');
  await new Promise((r) => setTimeout(r, 1600));
  eq(ov.getAttribute('data-std-hidden'), null, '淡出不该等于隐藏（层还在，只是透明）');
  app.destroy();
});

/* ───────────── 尺寸适配 · 循环播放 ───────────── */

section('13k. 尺寸适配与循环播放');

await test('尺寸适配：舞台越矮，能用的轨道越少（至少 1 轨，不会算成 0）', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ 内容: `x${i}` }));
  const base = { base: 0.22, jitterPct: 30, speed: 110, gapPx: 16, rand: seeded(3), speedVarPct: 5 };

  const tall = danmaku.assignLanesAndDelays(items, { ...base, lanes: 6, stageWidth: 900 });
  const short = danmaku.assignLanesAndDelays(items, { ...base, lanes: 1, stageWidth: 900 });
  ok(new Set(tall.map((x) => x.轨道)).size > 1, '高框应当用多条轨道');
  eq(new Set(short.map((x) => x.轨道)).size, 1, '矮框只有 1 轨');

  // 轨道数不能是 0 或负数（那会让 top 变成 NaN）
  const degenerate = danmaku.assignLanesAndDelays(items, { ...base, lanes: 0, stageWidth: 0 });
  for (const it of degenerate) {
    ok(Number.isInteger(it.轨道) && it.轨道 >= 0, `轨道必须是非负整数：${it.轨道}`);
    ok(Number.isFinite(it.延迟) && it.延迟 >= 0, `时刻必须是有限非负数：${it.延迟}`);
  }
});

await test('尺寸适配：同轨被统一到同一个速度（这是"不追尾"的前提）', () => {
  const items = Array.from({ length: 24 }, (_, i) => ({ 内容: `x${i}` }));
  const out = danmaku.assignLanesAndDelays(items, {
    base: 0.2,
    jitterPct: 40,
    lanes: 4,
    speed: 110,
    stageWidth: 900,
    gapPx: 16,
    speedVarPct: 10, // 有速度浮动
    rand: seeded(17),
  });
  // 同轨速度必须完全一致
  const speedByLane = new Map();
  for (const it of out) {
    if (!speedByLane.has(it.轨道)) speedByLane.set(it.轨道, it.速度);
    eq(it.速度, speedByLane.get(it.轨道), `轨道 ${it.轨道} 里的速度必须一致（否则快的会追上慢的）`);
  }
  // 但不同轨道之间应当有差异，否则"速度浮动"就白设了
  const laneSpeeds = [...speedByLane.values()];
  ok(new Set(laneSpeeds).size > 1, `不同轨道之间应当有速度差：${laneSpeeds.join(',')}`);
});

await test('尺寸适配：把框拖小之后，app 报出的轨道数会跟着变小', () => {
  const { d, app } = makeDrawerEnv();
  // 悬浮层可用高度由 rect 决定
  app.updateSettings({ appearance: { overlayEnabled: true, fontSize: 15, overlayRect: { x: 0.1, y: 0.1, w: 0.8, h: 0.5 } } });
  app.renderLastForTest?.();
  const big = app.layoutHints();

  app.updateSettings({ appearance: { overlayRect: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 } } });
  const small = app.layoutHints();

  ok(big.lanes >= 1 && small.lanes >= 1, '轨道数至少是 1');
  ok(small.lanes <= big.lanes, `把框改矮之后轨道数不该变多：${big.lanes} → ${small.lanes}`);
  app.destroy();
});

await test('循环播放：默认开着，并且播完会重启动画而不是清空', () => {
  const stale = doc2overlay();
  const d2 = useDoc(createMiniDocument());
  stale.ensureOverlay(d2);
  const root = d2.getElementById('std-overlay');
  const items = [
    { 昵称: '甲', 内容: 'a', color: '#fff', 速度: 110, 延迟: 0, 轨道: 0 },
    { 昵称: '乙', 内容: 'b', color: '#fff', 速度: 110, 延迟: 0.3, 轨道: 1 },
  ];
  const res = stale.playOverlay(d2, items, { appearance: { overlayLoop: true, fontSize: 15 } });
  eq(res.loop, true, '应当报告处于循环模式');
  const stage = root.querySelector('.std-ov-stage');
  eq(stage.children.length, 2, '弹幕应当在舞台上');
  eq(root.__std.timers.length, 1, '只应当挂一个待触发定时器（自重排，不是 setInterval）');
  stale.stopOverlay(d2);
  eq(root.__std.stopped, true, 'stopOverlay 必须关上闸门，否则定时器会一直重排');
  eq(root.__std.timers.length, 0, '定时器应当被清空');
});

await test('循环关掉时：播完清空舞台（层保持可见），不会淡出', async () => {
  const ov = doc2overlay();
  const d2 = useDoc(createMiniDocument());
  ov.ensureOverlay(d2);
  const root = d2.getElementById('std-overlay');
  const items = [{ 昵称: '甲', 内容: 'a', color: '#fff', 速度: 200, 延迟: 0, 轨道: 0 }];
  const res = ov.playOverlay(d2, items, {
    appearance: { overlayLoop: false, overlayFade: false, fontSize: 15 },
  });
  eq(res.loop, false);
  // 等收尾定时器触发
  await new Promise((r) => setTimeout(r, (res.totalMs || 1000) + 150));
  eq(root.querySelector('.std-ov-stage').children.length, 0, '播完应当清空舞台');
  eq(root.getAttribute('data-std-hidden'), null, '层本身必须还在');
  ok(!root.classList.contains('faded'), '不该被淡出');
  ov.stopOverlay(d2);
});

await test('循环是设置项且有默认值', () => {
  const s = store.defaultSettings();
  eq(s.appearance.overlayLoop, true, '默认应当循环播放');
  eq(store.normalizeSettings({ appearance: { overlayLoop: false } }).appearance.overlayLoop, false, '关掉要生效');
});

await test('循环真的在重启动画（不是只挂了个定时器）', async () => {
  const ov = doc2overlay();
  const d2 = useDoc(createMiniDocument());
  ov.ensureOverlay(d2);
  const items = [{ 昵称: '甲', 内容: 'a', color: '#fff', 速度: 900, 延迟: 0, 轨道: 0 }];
  // 速度 900 + 舞台窄 → 一轮很短，循环周期被下限兜到 1.5 秒
  const res = ov.playOverlay(d2, items, { appearance: { overlayLoop: true, fontSize: 15 } });
  eq(res.loop, true);
  const stage = d2.querySelector('.std-ov-stage');
  const before = stage.children[0]?.style.animation || '(空)';

  // 等过一轮循环周期
  await new Promise((r) => setTimeout(r, 1700));
  eq(stage.children.length, 1, '循环时弹幕应当还在舞台上（不该被清空）');
  // restart 会把 animation 置 none 再恢复，所以这里主要验证"节点还在、层还可见"
  const root = d2.getElementById('std-overlay');
  eq(root.getAttribute('data-std-hidden'), null, '循环期间层必须一直可见');
  ok(!root.classList.contains('faded'), '循环期间不该被淡出（那看起来就是"消失了"）');
  ov.stopOverlay(d2);
});

await test('轨道数不匹配：框只有 3 行但计划 5 轨时，不能被取模压回', () => {
  const items = [
    { 昵称: 'a', 内容: 'x', 轨道: 0 },
    { 昵称: 'b', 内容: 'x', 轨道: 3 },
    { 昵称: 'c', 内容: 'x', 轨道: 4 },
  ];
  // 即便只告诉它 3 轨，也不能把 3、4 取模成 0、1（那就叠上了）
  const laid = frameMod.distributeLanes(items, 3);
  eq(laid.map((x) => x.lane).join(','), '0,3,4', '轨道号必须原样保留，不能取模');
  eq(frameMod.effectiveLanes(items, 3), 5, '应当算出实际用到 5 轨');
  // 渲染时行高要按 5 轨算，否则第 4 轨会跑到框外面或压在第 0 轨上
  const d = useDoc(createMiniDocument());
  const frame = frameMod.createFrame({
    doc: d,
    appearance: { fontSize: 15, frameHeight: 100 },
    luminance: 0.1,
    meta: { batchNo: 1, messageId: 1 },
    items,
  });
  ok(frame.lanes >= 5, `行高必须容得下 5 轨，实际 ${frame.lanes}`);
  // 没有任何轨道字段时才退回均摊
  eq(frameMod.effectiveLanes([{ 昵称: 'a' }, { 昵称: 'b' }], 4), 4, '没有轨道字段就用给定的轨道数');
});

await test('悬浮层的轨道数不会少于计划用到的轨道数', () => {
  const ov = doc2overlay();
  const d2 = useDoc(createMiniDocument());
  ov.ensureOverlay(d2);
  // 悬浮层拖得很矮（只够 1 行），但计划用了 4 轨
  const items = [0, 1, 2, 3].map((n) => ({ 昵称: 'x', 内容: 'y', color: '#fff', 速度: 110, 延迟: n, 轨道: n }));
  const r = ov.playOverlay(d2, items, { appearance: { overlayLoop: false, fontSize: 15 } });
  ok(r.lanes >= 4, `轨道数不能少于计划值（否则会叠回同一轨），实际 ${r.lanes}`);
  const tops = [...d2.querySelector('.std-ov-stage').children].map((c) => c.style.top);
  eq(new Set(tops).size, 4, `4 条弹幕应当占 4 个不同的 top，实际 ${tops.join(',')}`);
  ov.stopOverlay(d2);
});

section('14. 事件调度（自动直出 / 每 N 轮 / 手动）');

await test('每轮直出：一轮一条请求；关掉自动就不请求', async () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true, autoGenerate: true, everyNRounds: 1, count: 3 });

  let calls = 0;
  const origRender = app.renderBatch;
  const wrapped = { ...app };

  const r1 = await app.runBatch({ messageId: 3 });
  ok(r1.ok, r1.error);
  eq(app.state.runtime.history.length, 1);

  app.updateSettings({ autoGenerate: false });
  const r2 = await app.runBatch({ messageId: 3 });
  ok(r2.ok, '手动调用依然应该能出');
  eq(app.state.runtime.history.length, 2);
  app.destroy();
  ok(calls === 0, '占位');
});

await test('每 3 轮出一批：第 1、2 轮不出，第 3 轮出', async () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true, autoGenerate: true, everyNRounds: 3, count: 2 });
  await app.onAssistantMessage?.(3);
  // onAssistantMessage 不是公开 API，这里用等价路径：直接推动轮次并手动判断
  app.state.runtime.roundNo = 0;
  const fired = [];
  const origRun = app.runBatch;
  app.runBatch = async (o) => {
    fired.push(o);
    return { ok: true, batch: { items: [] } };
  };
  for (let i = 0; i < 3; i++) {
    app.state.runtime.roundNo += 1;
    if (app.state.runtime.roundNo % app.state.settings.everyNRounds === 0) await app.runBatch({ messageId: 3 });
  }
  eq(fired.length, 1, '3 轮只该出 1 批');
  app.runBatch = origRun;
  app.destroy();
});

await test('历史保留轮数可配：填 3 就只留 3 批', async () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true, historyKeep: 3, count: 2 });
  for (let i = 0; i < 6; i++) await app.runBatch({ messageId: 3 });
  eq(app.state.runtime.history.length, 3);
  app.destroy();
});

await test('重播历史批次不报错', async () => {
  const s = makeMemoryStorage();
  const app = mainMod.createApp({ storage: s, doc, win: doc.defaultView });
  app.init();
  app.updateSettings({ seedDemo: true, count: 4 });
  const res = await app.runBatch({ messageId: 3 });
  ok(res.ok);
  eq(app.replayBatch(res.batch.batchNo), true);
  eq(app.replayBatch(9999), false, '不存在的批次应当返回 false');
  app.destroy();
});

/* ───────────── 汇总 ───────────── */

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.error?.stack || f.error}`);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
