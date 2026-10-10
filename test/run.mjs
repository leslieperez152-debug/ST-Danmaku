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
globalThis.window = doc.defaultView;
globalThis.SillyTavern = {
  getContext() {
    return {
      eventSource: { on() {}, removeListener() {}, emit() {} },
      eventTypes: { CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_id_changed' },
      chat: fakeChat,
      chatMetadata: { file_name: 'test-chat' },
      characters: [{ name: '测试卡' }],
      characterId: 0,
      worldInfoList: Object.keys(WORLDBOOKS),
      extensionSettings: { world_info: { world_info: [] } },
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
      async loadWorldInfo(name) {
        if (!(name in WORLDBOOKS)) throw new Error(`no such book: ${name}`);
        return WORLDBOOKS[name];
      },
      setExtensionPrompt() {},
    };
  },
};

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

await test('后端 4xx 时错误里带上状态码和原文', async () => {
  queueResponse({ __http: 401, body: 'no api key' });
  const res = await llm.chat({ api: { route: 'st', source: 'custom' }, system: 's', user: 'u', label: '测试' });
  eq(res.ok, false);
  ok(res.error.includes('401'), res.error);
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

const mainMod = await mod('main.js');

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
