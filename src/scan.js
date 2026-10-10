/**
 * scan.js — 世界书扫描：索引 → 取样 → 总结
 *
 * 为什么必须分三层：
 *   世界书的规模可能从 0 条到几十万条，任何"直接读全本塞给 API"的写法都会炸。
 *   所以这里全程是"预算制"：
 *
 *   ① 索引   只读条目的名字/备注/字数（几乎不花 token）
 *            → 得到"这本书有什么、有多大"的全貌
 *   ② 取样   在给定字数预算内挑条目（常量条目优先，其次与最近正文相关的）
 *            → 这一步决定花多少钱，而不是由世界书大小决定
 *   ③ 总结   把取样结果压成一份有字数上限的《观众档案》
 *
 * 不做任何题材/卡专属假设：预算按实测总字数动态计算，
 * 世界书很小时自然只读它有的那点，一本都没有时也能走"空档案"路径。
 */

import { readWorldbook, resolveWorldbookNames } from './st.js';
import { chatJson } from './llm.js';
import { emptyProfile, blankProfileData } from './store.js';

/* ───────────── 取样策略 ───────────── */

/**
 * 从条目集合里按预算取样。
 *
 * 优先级（粗略但通用）：
 *   1. 常量条目（蓝灯）—— 通常是世界观铁律，信息密度最高
 *   2. 与最近正文有交集的条目 —— 观众只关心"现在台上在演什么"
 *   3. 其余按 order 升序
 *
 * @param {object[]} entries
 * @param {object} opts
 * @param {number} opts.budget            读取字数上限
 * @param {string} [opts.recentText]      最近正文（用于相关性打分）
 * @param {boolean} [opts.commentOnly]    只拿名字/备注，不读正文
 * @returns {{picked:object[], charsRead:number, skipped:number, budget:number}}
 */
export function selectEntries(entries, opts = {}) {
  const budget = Math.max(0, Math.floor(opts.budget ?? 40000));
  const commentOnly = !!opts.commentOnly;
  const recent = String(opts.recentText || '').slice(-12000);

  const scored = (entries || []).map((e, idx) => {
    const hay = `${e.comment}\n${e.keys.join('\n')}`;
    let related = 0;
    for (const k of [e.comment, ...e.keys].filter(Boolean)) {
      const key = String(k);
      if (key.length >= 2 && recent.includes(key)) related += 1;
    }
    return { e, idx, related, tier: e.constant ? 0 : related > 0 ? 1 : 2 };
  });

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.related !== b.related) return b.related - a.related;
    if (a.e.order !== b.e.order) return a.e.order - b.e.order;
    return a.idx - b.idx;
  });

  const picked = [];
  let charsRead = 0;
  let skipped = 0;

  for (const { e } of scored) {
    const body = commentOnly
      ? `【${e.comment || '(无名条目)'}】`
      : [e.comment ? `【${e.comment}】` : '', e.content].filter(Boolean).join('\n');
    const cost = body.length;

    if (charsRead + cost <= budget) {
      picked.push({ ...e, pickedBody: body, truncated: false });
      charsRead += cost;
      continue;
    }

    // 还能塞一点：把这个条目从尾部截断塞进去，比整个丢掉信息多
    const left = budget - charsRead;
    if (left >= 200) {
      const head = body.slice(0, left);
      picked.push({ ...e, pickedBody: `${head}…（本条已截断）`, truncated: true });
      charsRead += head.length;
      skipped += 1;
      continue;
    }
    skipped += 1;
  }

  return { picked, charsRead, skipped, budget };
}

/**
 * 索引：把整本世界书的"目录"压成一段紧凑文本。
 * 这是唯一一个无论多大都敢跑的步骤（只吃 comment + 字数）。
 */
export function buildOutline(entries, opts = {}) {
  const max = Math.max(0, Math.floor(opts.maxChars ?? 6000));
  const constants = entries.filter((e) => e.constant);
  const selective = entries.filter((e) => !e.constant);

  const line = (e) =>
    `${e.constant ? '[常]' : '[键]'}${e.comment || '(无名)'}${e.keys.length ? `（${e.keys.slice(0, 4).join('/')}）` : ''}·${e.chars}字`;

  const lines = [];
  lines.push(`常量条目 ${constants.length} 条：`);
  for (const e of constants) {
    const l = line(e);
    if (lines.join('\n').length + l.length > max) {
      lines.push(`…（其余 ${constants.length - constants.indexOf(e)} 条常量条目略）`);
      break;
    }
    lines.push(l);
  }
  lines.push('');
  lines.push(`关键词条目 ${selective.length} 条（按 order 取前若干）：`);
  for (const e of selective) {
    const l = line(e);
    if (lines.join('\n').length + l.length > max) {
      lines.push(`…（其余 ${selective.length - selective.indexOf(e)} 条关键词条目略）`);
      break;
    }
    lines.push(l);
  }
  return lines.join('\n');
}

/* ───────────── 提示词 ───────────── */

export function profileSystemPrompt() {
  return [
    '你是"直播观众考古员"。你的任务不是写故事，而是看材料、产出一份【观众档案】，交给另一个程序去模仿这批观众发弹幕。',
    '',
    '产出要求：',
    '1. 只输出一个 JSON 对象，不要任何解释、不要代码围栏。',
    '2. 每个字段都要短、要具体、要能直接被用来造句。写不出东西的字段就留空字符串，不要编造。',
    '3. 材料里没有的信息，宁可留空也不要脑补。',
    '',
    '字段含义：',
    '- worldName：这个世界/这部作品的名字（材料里没有就留空）',
    '- stage：舞台与基本样貌 —— 什么年代、什么环境、日常在过什么日子、力量/规则体系是什么',
    '- factions：势力、阵营、组织、群像的构成（谁和谁不对付）',
    '- naming：**称呼体系** —— 观众会怎么称呼台上的人（用什么头衔、什么绰号），观众之间怎么互相称呼',
    '- lexicon：本土词汇与专有名词 —— 这个世界特有的说法、术语、行话、地名、招式名，列 10~25 个',
    '- manner：观众说话的语气与节奏。注意：**体裁永远是"直播弹幕"**（短句、抢话、@人、刷屏、催更、起哄），这个字段只描述"措辞怎么本土化"，不要描述别的体裁',
    '- taboos：这个世界观里不该出现的说法或禁区（比如某些词在设定里是禁忌、某些称呼是冒犯）',
    '- interests：这批观众会为什么兴奋、会挑什么刺、爱看什么、爱骂什么',
    '- channelName：给这个直播间起个名字，要贴合世界观（8~16 字）',
    '- hasWorldbook：材料里是否有可用的世界观信息（true / false）',
  ].join('\n');
}

export function profileUserPrompt({ outline, sample, stats }) {
  const parts = [];
  parts.push('【材料 A · 世界书目录（只有名字和字数，用来了解全貌）】');
  parts.push(outline || '（无）');
  parts.push('');
  parts.push('【材料 B · 世界书正文取样（预算内挑出来的部分，可能有截断）】');
  parts.push(sample || '（无）');
  parts.push('');
  parts.push('【本次扫描实测】');
  parts.push(
    `世界书 ${stats.books} 本；条目共 ${stats.entriesTotal} 条、合计约 ${stats.charsTotal} 字；` +
      `本次实际读取 ${stats.entriesRead} 条、${stats.charsRead} 字；档案字数上限 ${stats.summaryBudget} 字。`,
  );
  parts.push('');
  parts.push(`请输出观众档案 JSON，所有字段加起来不要超过 ${stats.summaryBudget} 字。`);
  parts.push('如果材料不足以判断世界观（比如材料为空），就把 hasWorldbook 设为 false，其余字段尽量留空 —— 不要硬编。');
  return parts.join('\n');
}

export function profileJsonSchema() {
  const str = { type: 'string' };
  return {
    name: 'danmaku_viewer_profile',
    description: '直播间观众档案',
    strict: true,
    value: {
      type: 'object',
      properties: {
        worldName: str,
        stage: str,
        factions: str,
        naming: str,
        lexicon: str,
        manner: str,
        taboos: str,
        interests: str,
        channelName: str,
        hasWorldbook: { type: 'boolean' },
      },
      required: ['worldName', 'stage', 'factions', 'naming', 'lexicon', 'manner', 'taboos', 'interests', 'channelName', 'hasWorldbook'],
      additionalProperties: false,
    },
  };
}

/* ───────────── 主流程 ───────────── */

/**
 * @typedef {Object} ScanInput
 * @property {object} api    settings.api
 * @property {object} scan   settings.scan
 * @property {string} [recentText]
 * @property {(msg:string, level?:string)=>void} [log]
 * @property {(p:{phase:string, detail:string})=>void} [progress]
 */

/**
 * 跑一次扫描，返回新的档案。
 * @param {ScanInput} input
 * @returns {Promise<{ok:boolean, profile:object, error:string}>}
 */
export async function scanWorldbooks(input) {
  const { api, scan } = input || {};
  const log = typeof input?.log === 'function' ? input.log : () => {};
  const progress = typeof input?.progress === 'function' ? input.progress : () => {};
  const profile = emptyProfile();

  /* ① 索引 */
  progress({ phase: 'index', detail: '正在找出要读的世界书…' });
  const names = resolveWorldbookNames(scan?.sources);
  profile.sources = names;
  profile.stats.books = names.length;

  if (!names.length) {
    // 合法状态：没有世界书。走"看正文学"路线。
    log('没有找到可用的世界书，档案转为空档案（插件会靠正文学着认人认事）', 'warn');
    profile.generatedAt = Date.now();
    profile.stats.summaryChars = 0;
    profile.data = { ...blankProfileData(), hasWorldbook: false };
    return { ok: true, profile, error: '' };
  }

  progress({ phase: 'index', detail: `正在索引 ${names.length} 本世界书…` });
  const all = [];
  const bookStats = [];
  for (const name of names) {
    const res = await readWorldbook(name);
    if (!res.ok) {
      log(`世界书《${name}》读取失败：${res.error}`, 'warn');
      bookStats.push({ name, ok: false, error: res.error, entries: 0, chars: 0 });
      continue;
    }
    const entries = scan?.includeDisabled ? res.entries : res.entries.filter((e) => !e.disabled);
    const chars = entries.reduce((a, e) => a + e.chars, 0);
    bookStats.push({ name, ok: true, error: '', entries: entries.length, chars });
    all.push(...entries);
  }

  const charsTotal = all.reduce((a, e) => a + e.chars, 0);
  profile.stats.entriesTotal = all.length;
  profile.stats.charsTotal = charsTotal;
  log(`索引完成：${all.length} 条，合计 ${charsTotal} 字`);

  if (!all.length) {
    profile.generatedAt = Date.now();
    profile.data = { ...blankProfileData(), hasWorldbook: false };
    return { ok: true, profile, error: '' };
  }

  /* ② 取样 */
  const budget = resolveSampleBudget(charsTotal, scan?.entryCharBudget);
  progress({ phase: 'sample', detail: `正在按 ${budget} 字预算取样…` });
  const outline = buildOutline(all, { maxChars: Math.min(6000, Math.max(1200, Math.round(budget / 6))) });
  const { picked, charsRead, skipped } = selectEntries(all, {
    budget,
    recentText: input?.recentText,
    commentOnly: scan?.commentOnly,
  });

  profile.stats.entriesRead = picked.length;
  profile.stats.charsRead = charsRead;
  log(`取样完成：读 ${picked.length} 条 / ${charsRead} 字（预算 ${budget} 字，未纳入 ${skipped} 条）`);

  const sample = picked
    .map((e) => (e.keys.length ? `〔${e.comment}｜键：${e.keys.slice(0, 3).join('/')}〕\n${e.pickedBody}` : `〔${e.comment}〕\n${e.pickedBody}`))
    .join('\n\n');

  /* ③ 总结 */
  const summaryBudget = Math.max(100, Math.floor(scan?.summaryCharBudget ?? 1200));
  progress({ phase: 'summarize', detail: `正在总结成 ${summaryBudget} 字以内的档案…` });

  const res = await chatJson({
    api,
    label: '世界观扫描',
    system: profileSystemPrompt(),
    user: profileUserPrompt({
      outline,
      sample,
      stats: {
        books: names.length,
        entriesTotal: all.length,
        charsTotal,
        entriesRead: picked.length,
        charsRead,
        summaryBudget,
      },
    }),
    jsonSchema: profileJsonSchema(),
  });

  if (!res.ok || !res.value || typeof res.value !== 'object') {
    return { ok: false, profile, error: res.error || '总结失败：模型没有返回可用的档案' };
  }
  if (res.schemaFallback && res.note) log(res.note, 'warn');

  const data = { ...blankProfileData() };
  for (const k of Object.keys(data)) {
    if (k === 'hasWorldbook') {
      data.hasWorldbook = res.value.hasWorldbook === true;
      continue;
    }
    data[k] = typeof res.value[k] === 'string' ? res.value[k].trim() : '';
  }
  // 超过上限就硬裁，宁可截断也不让下游 prompt 失控
  let total = 0;
  for (const k of ['stage', 'factions', 'naming', 'lexicon', 'manner', 'taboos', 'interests', 'worldName', 'channelName']) {
    const v = data[k];
    if (!v) continue;
    const room = summaryBudget - total;
    if (room <= 0) {
      data[k] = '';
      continue;
    }
    if (v.length > room) data[k] = v.slice(0, room);
    total += data[k].length;
  }
  if (!data.hasWorldbook && !data.stage && !data.lexicon) data.hasWorldbook = false;

  profile.generatedAt = Date.now();
  profile.stats.summaryChars = total;
  profile.data = data;
  profile.books = bookStats;

  progress({ phase: 'done', detail: `档案完成：${total} 字` });
  log(`档案完成：${total} 字（上限 ${summaryBudget} 字）`);
  return { ok: true, profile, error: '', note: res.note || '' };
}

/**
 * 取样预算 = min(设置上限, 总字数的一定比例)。
 * 比例保底的意义：世界书很小的时候不要为了"凑预算"反复重读；
 * 世界书很大的时候也不要让设置里的一个大数字变成一次巨额请求。
 */
export function resolveSampleBudget(charsTotal, configured) {
  const cfg = Number.isFinite(configured) ? Math.max(0, configured) : 40000;
  const total = Math.max(0, Number(charsTotal) || 0);
  if (!total) return 0;
  // 小书全读（不超过上限），大书按上限读
  if (total <= cfg) return total;
  return cfg;
}

/** 估算一次扫描大概要花多少输入字（面板上显示，让用户心里有数） */
export function estimateScanCost(stats) {
  const outlineChars = Math.min(6000, Math.max(1200, Math.round((stats?.entryCharBudget || 40000) / 6)));
  const sampleChars = Math.min(stats?.entryCharBudget || 40000, stats?.charsTotal || 0);
  return {
    outlineChars,
    sampleChars,
    inputCharsApprox: outlineChars + sampleChars + 600,
  };
}
