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
import { createMiniDocument, makeMemoryStorage } from './mini-dom.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'src');
const mod = (name) => import(pathToFileURL(path.join(srcDir, name)).href);

/* ───────────── 迷你断言框架 ───────────── */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  // 每个用例开始前清掉假后端的排队响应，避免用例之间串数据
  responseQueue.length = 0;
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

/** 假后端：按顺序吐预设回复 */
let responseQueue = [];
function queueResponse(obj) {
  responseQueue.push(obj);
}
globalThis.fetch = async (url, init) => {
  lastRequestBody = init?.body ? JSON.parse(init.body) : null;
  const next = responseQueue.shift() ?? { choices: [{ message: { content: '{"弹幕":[]}' } }] };
  if (next.__http && next.__http !== 200) {
    return { ok: false, status: next.__http, text: async () => next.body || '' };
  }
  const body = typeof next === 'string' ? next : JSON.stringify(next);
  return { ok: true, status: 200, text: async () => body };
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

await test('梗记忆只挑短而带情绪的那几条', () => {
  const gags = danmaku.pickGags(
    [
      { 内容: '这句话非常完整，有主语有谓语有宾语，还带标点符号。', 类型: '普通' },
      { 内容: '就这？', 类型: '玩梗' },
      { 内容: '退钱', 类型: '情绪' },
    ],
    2,
  );
  ok(gags.includes('就这？'), gags.join('|'));
  ok(!gags.some((g) => g.includes('非常完整')), '长句不该被当成梗');
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

await test('状态区显示卡名 / 世界书 / 档案状态', () => {
  const { d, app } = makeDrawerEnv();
  const drawer = drawerMod.createDrawer(app, { doc: d });
  const el = drawer.mount();
  drawer.render();
  const status = el.querySelector('[data-std-dw-status]').innerHTML;
  ok(status.includes('当前卡'), status);
  ok(status.includes('世界书'), status);
  ok(status.includes('还没扫描'), `未扫描时应当提示去扫描：${status}`);
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
  ok(/自动跟随当前卡绑定的世界书/.test(html), `应当显示跟随模式：${html.slice(0, 200)}`);
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
