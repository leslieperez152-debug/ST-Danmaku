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
    '你是"直播观众考古员"。你的任务不是写故事，而是产出一份【观众档案】，交给另一个程序去模仿这批观众发弹幕。',
    '',
    '产出要求：',
    '1. 只输出一个 JSON 对象，不要任何解释、不要代码围栏。',
    '2. 每个字段都要短、要具体、要能直接被用来造句。',
    '',
    '【最重要：两类字段的取数方式完全不同，别搞混】',
    '',
    'A 类 · 世界事实 —— **只能来自材料**',
    '   - worldName（世界名）、stage（舞台与基本样貌）、factions（势力与群像）',
    '   - 材料里没有的，宁可留空字符串，**绝对不要编造**。这些是"这个世界是什么样"的客观信息。',
    '',
    'B 类 · 观众腔调 —— **请你按世界观自己推理生成，不要只从材料里抄**',
    '   - naming（称呼体系）、lexicon（本土词汇）、manner（措辞腔调）、interests（兴奋点）、channelName（直播间名）',
    '   - 理由：原始设定里通常根本不会写"观众怎么称呼台上的人""观众会怎么吐槽"，',
    '     这些必须靠你理解这个世界之后推出来。所以这一类**要主动生成、要具体、要能用**。',
    '   - 推理依据：这个世界的**年代、社会结构、力量体系、身份等级、行业行话**决定了观众会怎么说话。',
    '     例如：',
    '       · 有明确的实力等级体系 → 观众会用等级词相互抬杠（"他这水平也配"）',
    '       · 有门派/组织 → 观众会自称某派支持者、互相拉踩',
    '       · 有官职爵位 → 观众会拿头衔称呼、拿头衔开玩笑',
    '       · 市井年代 → 观众会用行话、口头禅、市井比喻',
    '       · 现代/赛博 → 观众会用平台腔、缩写、数据化表达',
    '   - 无论怎么本土化，**体裁永远是"直播弹幕"**：短句、抢话、起哄、催更、抬杠。',
    '     manner 字段只描述"措辞怎么本土化"，不要去描述别的体裁。',
    '   - 注意：弹幕是网络发言，**百无禁忌**。不要给观众设什么"不该说的话"，',
    '     也不要写"他们会保持礼貌"这类约束 —— 观众该骂就骂、该起哄就起哄，这才是弹幕。',
    '',
    '字段含义：',
    '- worldName：（A）这个世界/作品叫什么。材料没有就留空。',
    '- stage：（A）舞台与基本样貌 —— 什么年代、什么环境、日常在过什么日子、力量或规则体系是什么。',
    '- factions：（A）势力、阵营、组织、群像构成（谁和谁不对付）。',
    '- naming：（B，请生成）观众怎么称呼台上的人（头衔/绰号/门派/职称，给几个具体例子），观众之间怎么互称。',
    '- lexicon：（B，请生成）10~25 个这个世界特有的说法、术语、行话、地名、招式名 —— 要能被直接塞进弹幕里用。',
    '- manner：（B，请生成）观众说话的语气与节奏，用一句话说清（仍然是直播弹幕这个体裁）。',
    '- interests：（B，请生成）这批观众会为什么兴奋、会挑什么刺、爱看什么、爱骂什么。',
    '- channelName：（B，请生成）给这个直播间起个贴合世界观的名字，8~16 字。',
    '- hasWorldbook：材料里是否有可用的世界事实（true / false）。',
    '- voiceNote：一句话说明你的"观众腔调"是从哪些线索推出来的（例如"依据门派等级与江湖行话"）。',
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
  parts.push('【怎么用这些材料】');
  parts.push('· A 类（世界名 / 舞台 / 势力）：**只许照材料写**，材料没说就留空，不要编。');
  parts.push('· B 类（称呼体系 / 本土词汇 / 措辞腔调 / 观众兴奋点 / 直播间名）：**照世界观的逻辑自己推理生成**，');
  parts.push('  要具体到能直接塞进弹幕，不要只抄材料里的原句，也不要写成泛泛而谈。');
  parts.push('');
  if (!stats.entriesRead) {
    parts.push('⚠️ 这次没有读到任何世界书正文。那 A 类全部留空、hasWorldbook 设为 false；');
    parts.push('   B 类仍然要尽量给（可以是很通用的中文口语腔调），但**不要发明具体的专有名词**。');
    parts.push('');
  }
  // 尾部必须把 JSON 的键名列全：结构化输出默认是关的（很多端点不支持），
  // 只说"输出 JSON"的话模型会自己猜键名，猜错就解析不了。
  parts.push('【输出格式】只输出一个 JSON 对象，键名必须完全用下面这些，不要多也不要少：');
  parts.push('{');
  parts.push('  "worldName": "", "stage": "", "factions": "",');
  parts.push('  "naming": "", "lexicon": "", "manner": "", "interests": "", "channelName": "",');
  parts.push('  "hasWorldbook": true, "voiceNote": ""');
  parts.push('}');
  parts.push('（hasWorldbook 是布尔值；其余都是字符串。）');
  parts.push(`所有字符串加起来不要超过 ${stats.summaryBudget} 字。不要输出任何解释文字、不要加代码围栏。`);
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
        interests: str,
        channelName: str,
        hasWorldbook: { type: 'boolean' },
        voiceNote: str,
      },
      required: [
        'worldName',
        'stage',
        'factions',
        'naming',
        'lexicon',
        'manner',
        'interests',
        'channelName',
        'hasWorldbook',
        'voiceNote',
      ],
      additionalProperties: false,
    },
  };
}

/* ───────────── 语风语料（单独的"语风世界书"） ───────────── */

/**
 * 把语风世界书的正文拆成候选行。
 * 语风书可能是人工整理的"弹幕/台词/口癖"清单（一行一条，带序号、引号、markdown 标记），
 * 也可能就是一份普通设定资料 —— 后者会被当成"素材"交给 AI 去改写成弹幕语料。
 */
export function candidateStyleLines(text) {
  const out = [];
  const seen = new Set();
  for (let raw of String(text || '').split(/\r?\n/)) {
    let line = raw
      .replace(/^\s*[-*•·]\s+/, '') // 列表符号
      .replace(/^\s*\d+[.、)]\s*/, '') // 序号
      .replace(/^\s*[「『"'"'【\[]\s*/, '') // 左引号/括号
      .replace(/\s*[」』"'"'】\]]\s*$/, '') // 右引号/括号
      .replace(/\*\*/g, '') // markdown 粗体
      .trim();
    if (!line) continue;
    if (line.length < 2 || line.length > 60) continue; // 太长的不像一句弹幕
    if (/^#{1,6}\s/.test(line)) continue; // 标题
    if (/^[=—\-_~]{3,}$/.test(line)) continue; // 分隔线
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/* 语料的产出方式 */
export const STYLE_MODES = [
  ['auto', '自动（书上已有像弹幕的就用原文，没有就照着写）'],
  ['generate', '全部由 AI 生成（照这本世界书重新写一批弹幕语料）'],
  ['extract', '只用原文（书里已经有现成弹幕台词时用这个）'],
];

export function styleBookPrompt() {
  return [
    '你的任务：看一份"世界观素材"，然后产出**这个世界的直播间里，观众会说的弹幕语料**。',
    '',
    '【最终产物是什么】',
    '一批**可以直接当成弹幕范本的短句**。之后会拿它们当例句，去生成更多的弹幕。',
    '所以每一条都必须读起来就是一条弹幕 —— 短、口语、带情绪、常常不完整。',
    '',
    '【最关键：称呼必须落在语料里】',
    '观众怎么称呼台上的人（头衔、绰号、门派、职称、代号），不要写成"他们会称呼为某某"',
    '这种说明句，而要**直接把它用在句子里**。例如：',
    '  ✗ 错误写法：「观众称首领为凤皇」（这是说明，不是弹幕）',
    '  ✓ 正确写法：「凤皇这波操作我是没想到的」「媚姐别上头啊」',
    '同样，素材里的行话、术语、地名、招式名、梗，都要**用进句子里**，不要罗列成清单。',
    '',
    '【可以生成，不要只做摘抄】',
    '素材里如果本来就有像弹幕的句子，可以原样采用；但**不要只做摘抄** ——',
    '如果素材是设定资料、人物介绍、剧情描述，那你必须**照着它的用词和逻辑，自己写出弹幕**。',
    '一条合格的语料应当能让读者看出"这是哪个世界的观众在说话"，而不需要任何解释。',
    '',
    '【覆盖不同的说话姿态】',
    '起哄、抬杠、催更、玩梗、@人、纯情绪（"？？？""6"）、懂行解说、站队拉踩、',
    '突然的关心、看热闹不嫌事大……尽量让这批语料在不同姿态上都有样本。',
    '',
    '【硬性要求】',
    '1. 每条 4~40 字，必须是完整的口语短句，不要写成段落。',
    '2. **绝对不要**出现：旁白、舞台指示、设定说明、"xx是xx"式的介绍句、书面语连接词。',
    '3. 不要给观众设"不该说的话"这类约束 —— 观众该骂就骂、该起哄就起哄。',
    '4. 不要重复同一句；用词要贴着这个世界的语言习惯。',
    '5. 可以少量保留素材里的原句（如果它本来就是弹幕），但要标注来源。',
    '',
    '只输出 JSON：{"语料":[{"内容":"","来源":"原文|新写","说明":""}]}',
    '其中"来源"填 原文 或 新写；"说明"一句话讲这条用到了素材里的什么（可留空）。',
  ].join('\n');
}

export function styleBookUserPrompt({ lines, bookName, want, mode }) {
  const parts = [];
  const modeHint =
    mode === 'extract'
      ? '只从素材里挑现成的句子，尽量少改动，挑不出够多就少给几条。'
      : mode === 'generate'
        ? '主要靠你自己写；素材只提供用词、称呼、行话与氛围，不要大量照抄原句。'
        : '素材里有像弹幕的就采用原文，其余照着素材的用词与逻辑自己写。';
  parts.push(`【素材来源】《${bookName}》`);
  parts.push(`【本次要求】${modeHint}`);
  parts.push('');
  parts.push('【素材（可能是设定资料、人物介绍、剧情，也可能已经是弹幕清单）】');
  parts.push(lines.slice(0, 500).map((l) => `· ${l}`).join('\n'));
  parts.push('');
  // 同样：结构化输出默认关，尾部要把键名与取值写死
  parts.push('【输出格式】只输出一个 JSON 对象，键名必须完全一致：');
  parts.push('{"语料":[{"内容":"一条弹幕","来源":"原文","说明":""}]}');
  parts.push(`· "语料" 是最多 ${want} 条的数组；`);
  parts.push('· "来源" 只能是 "原文" 或 "新写" 两个值之一（原文=照抄素材里的句子，新写=你自己写的）；');
  parts.push('· "说明" 一句话讲这条用到了素材里的什么，可以留空字符串。');
  parts.push('不要输出任何解释文字、不要加代码围栏。');
  return parts.join('\n');
}

export function styleBookJsonSchema(want) {
  return {
    name: 'danmaku_style_corpus',
    description: '直播间弹幕语料',
    strict: true,
    value: {
      type: 'object',
      properties: {
        语料: {
          type: 'array',
          maxItems: Math.max(1, want),
          items: {
            type: 'object',
            properties: {
              内容: { type: 'string' },
              来源: { type: 'string' },
              说明: { type: 'string' },
            },
            required: ['内容', '来源', '说明'],
            additionalProperties: false,
          },
        },
      },
      required: ['语料'],
      additionalProperties: false,
    },
  };
}

/**
 * 读"语风世界书"，产出弹幕语料样本。
 *
 * 两种来源都支持：
 *   · 书里本来就有弹幕台词 → 直接用原文（一字不改）
 *   · 书是设定资料 / 人物介绍 → 照着它的用词与逻辑，让 AI 写出这个世界的弹幕
 * 称呼、行话、梗都要求**落在句子里**，所以语料本身就带着这个直播间的腔调。
 *
 * @returns {Promise<{ok:boolean, samples:string[], detail:object[], bookName:string, chars:number, generated:number, error:string}>}
 */
export async function extractStyleSamples(input) {
  const { api, scan } = input || {};
  const log = typeof input?.log === 'function' ? input.log : () => {};
  const progress = typeof input?.progress === 'function' ? input.progress : () => {};
  const bookName = String(scan?.styleBook || '').trim();
  const result = { ok: false, samples: [], detail: [], bookName, chars: 0, generated: 0, error: '' };
  if (!bookName) return result;

  progress({ phase: 'style', detail: `正在读语风世界书《${bookName}》…` });
  const res = await readWorldbook(bookName);
  if (!res.ok) {
    result.error = `语风世界书《${bookName}》读取失败：${res.error}`;
    log(result.error, 'warn');
    return result;
  }

  // 只读预算内的正文
  const budget = Math.max(1000, Number(scan?.styleBookBudget) || 12000);
  let text = '';
  for (const e of res.entries) {
    if (text.length >= budget) break;
    const chunk = [e.comment ? `〔${e.comment}〕` : '', e.content].filter(Boolean).join('\n');
    text += `${chunk}\n`;
  }
  text = text.slice(0, budget);
  result.chars = text.length;

  // 候选行放宽长度限制：设定资料里的句子会长一些，它们是"素材"而不是最终语料
  const lines = candidateStyleLines(text);
  const longLines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 60);
  const material = [...lines, ...longLines.slice(0, 80)];
  if (!material.length) {
    result.error = `语风世界书《${bookName}》里没找到可用素材`;
    log(result.error, 'warn');
    return result;
  }

  const want = Math.max(4, Number(scan?.styleSampleCount) || 24);
  const mode = String(scan?.styleMode || 'auto');
  progress({ phase: 'style', detail: `正在从《${bookName}》产出弹幕语料…` });

  const picked = await chatJson({
    api,
    label: '语风语料',
    system: styleBookPrompt(),
    user: styleBookUserPrompt({ lines: material, bookName, want, mode }),
    jsonSchema: styleBookJsonSchema(want),
  });

  if (picked.ok && picked.value && Array.isArray(picked.value.语料)) {
    const detail = picked.value.语料
      .map((it) => ({
        内容: String(it?.内容 || '').trim(),
        来源: String(it?.来源 || '').trim() === '原文' ? '原文' : '新写',
        说明: String(it?.说明 || '').trim(),
      }))
      .filter((it) => it.内容.length >= 2 && it.内容.length <= 60);
    const uniq = [];
    const seen = new Set();
    for (const it of detail) {
      if (seen.has(it.内容)) continue;
      seen.add(it.内容);
      uniq.push(it);
    }
    if (uniq.length) {
      result.ok = true;
      result.detail = uniq.slice(0, want);
      result.samples = result.detail.map((it) => it.内容);
      result.generated = result.detail.filter((it) => it.来源 === '新写').length;
      log(
        `语风语料：《${bookName}》产出 ${result.samples.length} 条（其中新写 ${result.generated} 条、取自原文 ${
          result.samples.length - result.generated
        } 条）`,
        'info',
      );
      return result;
    }
  }

  // 产不出来就退化成"直接用候选行"，至少不空手
  result.ok = true;
  result.samples = lines.slice(0, want);
  result.detail = result.samples.map((s) => ({ 内容: s, 来源: '原文', 说明: '' }));
  result.error = '';
  log(`语风语料：AI 产出没成功，改用素材里的 ${result.samples.length} 条原句（不影响使用）`, 'warn');
  return result;
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
  // 超过上限就硬裁，宁可截断也不让下游 prompt 失控。
  // 顺序有讲究：先保事实层（前面几个），再保观众腔调层；voiceNote 这种解释性文字放最后。
  let total = 0;
  for (const k of [
    'worldName',
    'stage',
    'factions',
    'naming',
    'lexicon',
    'manner',
    'interests',
    'channelName',
    'voiceNote',
  ]) {
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

  /* ④ 语风语料：单独读一本，产出这个直播间的弹幕语料 */
  if (String(scan?.styleBook || '').trim()) {
    const style = await extractStyleSamples({ api, scan, log, progress });
    profile.styleSamples = style.samples;
    profile.styleDetail = style.detail || [];
    profile.styleBookName = style.bookName;
    profile.stats.styleSamples = style.samples.length;
    profile.stats.styleGenerated = style.generated || 0;
    profile.stats.styleChars = style.chars;
    if (!style.ok && style.error) log(style.error, 'warn');
  } else {
    profile.styleSamples = [];
    profile.styleDetail = [];
    profile.styleBookName = '';
  }

  progress({ phase: 'done', detail: `档案完成：${total} 字${profile.styleSamples.length ? ` + ${profile.styleSamples.length} 条语风范本` : ''}` });
  log(
    `档案完成：${total} 字（上限 ${summaryBudget} 字）` +
      (profile.styleSamples.length ? `，语风范本 ${profile.styleSamples.length} 条` : ''),
  );
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
