/**
 * danmaku.js — 弹幕生成
 *
 * 唯一的内容硬约束（来自需求）：**读起来必须是「直播弹幕」，不能像别的体裁。**
 * 世界观档案只回答"这批观众是谁、用什么词"，不改变体裁。
 *
 * 关键设计：
 *   · 一次请求出一批（默认 15 条），不是循环 15 次 —— 省调用、顺带让观众互相接话；
 *   · 观众是"人"：固定 ID 池（有立场、有口癖）+ 随机路过的人；
 *   · 与剧情挂钩：把最近几轮正文作为输入喂进来，所以弹幕天然贴着刚发生的事；
 *   · 正文那边一个 token 都不吃：这条链路是单向的。
 */

import { chatJson } from './llm.js';

/* ───────────── 体裁约束：这是全插件唯一的内容提示词 ───────────── */

export const GENRE_RULES = [
  '体裁铁律（最高优先级，任何情况下不得违反）：你产出的每一句话都必须是**直播弹幕**——直播间观众随手发出来的那种。',
  '· 不是旁白，不是小说，不是影评，不是总结，不是角色台词，也不是"回复"。',
  '· 是真人一边看直播一边随手打出来的短句：短、快、抢话、有情绪、口语化、常常不完整。',
  '· 一条弹幕一般 4~40 字。可以只有两三个字（"草""6""前排"）。禁止写成完整通顺的长句或段落。',
  '· 允许并鼓励：起哄、催更、抬杠、玩梗、@别人、报数、喊招式名、喊口号、突然的关心。',
  '· 禁止出现：解释性长句、"综上所述"式的总结、书面语连接词、对世界观的客观介绍、把设定当资料念出来。',
  '· 禁止解说式或带货式腔调（"接下来就让我们看看……"这种），那是主持人不是弹幕。',
  '',
  '【内容质量硬要求：禁止套话，每条都要咬住正文】',
  '· **禁止空洞的套话**。像"这波稳了""666""前排""来了来了""散了散了""坐等""主播放心飞"',
  '  这类放到任何直播间都成立的话 —— **单条出现即为不合格**。',
  '· 唯一例外：如果它紧跟着**具体指代**（例如"就这剑法也敢拿出来？"），那算合格；',
  '  单独一句"稳了"不算。',
  '· **每条都必须能指出它在回应正文的哪一句、哪个动作、哪个人物、哪个物件或哪个转折。**',
  '  观众是"看见了什么才说什么"，不是"随便说点什么"。',
  '· 宁可写得**具体而琐碎**（某个招式名、某个人物的称呼、某件东西的样子、某个可疑的细节），',
  '  也不要写得**正确而空洞**。',
  '· 观众可以猜错、可以看漏、可以说疯话，但**不能没有由头**。',
].join('\n');

/* ───────────── 观众名册 ───────────── */

export function viewerSystemPrompt() {
  return [
    '你要设计一个直播间里"常驻的老观众"名册。',
    '这些是长期泡在这个直播间的人，各有各的立场、脾气和口癖，之后会反复出现在弹幕里。',
    '',
    '要求：',
    '1. 只输出 JSON，不要解释、不要代码围栏。',
    '2. 昵称要贴合这个世界的语言习惯（不要现代网络昵称套路，除非世界观本身允许），2~10 字。',
    '3. 立场要有区分度：会有人吹、有人黑、有人只看热闹、有人特别懂行、有人专门嗑关系、有人专挑刺、有人只看脸、有人替台上的人干着急。',
    '4. 口癖要具体到能直接造句（一句话以内），不要写"说话幽默"这种废话。',
    '',
    '字段：',
    '- 昵称：这个观众的名字',
    '- 立场：一句话说清他站哪边、在乎什么',
    '- 口癖：他常说的那句话或那个腔调',
    '- 类型：从这些里选一个 —— 铁粉 / 黑子 / 路人 / 懂王 / 嗑CP / 挑刺 / 看脸 / 操碎心',
  ].join('\n');
}

export function viewerUserPrompt({ profile, poolSize, existing }) {
  const parts = [];
  parts.push('【本直播间观众档案】');
  parts.push(renderProfileForPrompt(profile));
  parts.push('');
  if (existing?.length) {
    parts.push('【已经存在的观众（不要重复，可以补足缺失的类型）】');
    parts.push(existing.map((v) => `${v.昵称}（${v.类型}）`).join('、'));
    parts.push('');
  }
  parts.push(`请设计 ${poolSize} 位常驻观众。`);
  parts.push('【输出格式】只输出一个 JSON 对象，键名必须完全一致：');
  parts.push('{"观众":[{"昵称":"","立场":"","口癖":"","类型":""}]}');
  parts.push('· "观众" 是数组，正好 ' + poolSize + ' 个元素；');
  parts.push('· "类型" 只能从这些里选一个：铁粉 / 黑子 / 路人 / 懂王 / 嗑CP / 挑刺 / 看脸 / 操碎心。');
  parts.push('不要输出任何解释文字、不要加代码围栏。');
  return parts.join('\n');
}

export function viewerJsonSchema() {
  const str = { type: 'string' };
  return {
    name: 'danmaku_viewer_pool',
    description: '直播间常驻观众名册',
    strict: true,
    value: {
      type: 'object',
      properties: {
        观众: {
          type: 'array',
          items: {
            type: 'object',
            properties: { 昵称: str, 立场: str, 口癖: str, 类型: str },
            required: ['昵称', '立场', '口癖', '类型'],
            additionalProperties: false,
          },
        },
      },
      required: ['观众'],
      additionalProperties: false,
    },
  };
}

/**
 * 生成/补足常驻观众名册。
 * @returns {Promise<{ok:boolean, viewers:object[], error:string}>}
 */
export async function buildViewerPool({ api, profile, poolSize, existing = [] }) {
  const size = Math.max(0, Math.floor(poolSize || 0));
  if (!size) return { ok: true, viewers: [], error: '' };

  const res = await chatJson({
    api,
    label: '观众名册生成',
    system: viewerSystemPrompt(),
    user: viewerUserPrompt({ profile, poolSize: size, existing }),
    jsonSchema: viewerJsonSchema(),
  });

  if (!res.ok || !res.value) {
    return { ok: false, viewers: [], error: res.error || '名册生成失败' };
  }
  const list = Array.isArray(res.value.观众) ? res.value.观众 : [];
  const cleaned = list
    .map((v) => ({
      昵称: String(v?.昵称 || '').trim().slice(0, 16),
      立场: String(v?.立场 || '').trim().slice(0, 60),
      口癖: String(v?.口癖 || '').trim().slice(0, 40),
      类型: String(v?.类型 || '').trim().slice(0, 12),
      出现次数: 0,
    }))
    .filter((v) => v.昵称);

  if (!cleaned.length) return { ok: false, viewers: [], error: '名册生成失败：模型返回里没有观众' };
  return { ok: true, viewers: cleaned, error: '' };
}

/* ───────────── 弹幕批次 ───────────── */

export function batchSystemPrompt() {
  return [
    '你是一个直播间弹幕生成器。你只负责写弹幕，不写别的任何东西。',
    '',
    GENRE_RULES,
    '',
    '身份与用词：',
    '· 这批观众是这个世界里的本地人。他们用这个世界的词、这个世界的常识、这个世界的立场说话。',
    '· 称呼台上的人时，用这个世界的称呼体系（头衔、绰号、门派名等），不要用"角色""主角""玩家"这类元语言。',
    '· 他们知道正在发生什么（下面给了正文），但他们只知道"看到的部分"，不知道内情、不知道未来、不读心。',
    '',
    '与剧情的关系：',
    '· **每一条都应当能从给出的正文里找到由头** —— 某个动作、某句话、某个转折、某个人物的称呼、',
    '  某件物件的细节、某个没兑现的期待。找不出由头的那条就换掉。',
    '· 观众是看见了什么才说什么：尽量在句子里带上**具体的指代**（招式名、人物称呼、器物、地名、',
    '  某个具体动作），这样一句话就咬住了剧情，而不是放在哪都能用。',
    '· 观众会争论、会站队、会互相拆台；同一个事件可以有人叫好、同时有人骂。',
    '· 可以催促、可以押注、可以猜下一步（猜错也无所谓，弹幕本来就是瞎猜）。',
    '',
    '节奏要求：',
    '· 长短句混合，别都是同一个长度。',
    '· 大约每 4 条里有 1 条 @ 别人（用"@昵称"）。',
    '· 不要求每条都长；短句（"这剑法？""他左手在抖"）同样要带具体指代。',
    '',
    '禁止：',
    '· 禁止旁白与舞台指示（不要写"（众人惊呼）"）。',
    '· 禁止对世界观的科普解释。',
    '· 禁止重复同一句话来凑数。',
    '· **禁止空洞套话**：这波稳了 / 666 / 前排 / 来了来了 / 散了散了 / 坐等 / 好家伙 这类',
    '  放到任何直播间都成立的话，单独出现即为不合格（详见体裁铁律）。',
  ].join('\n');
}

export function renderProfileForPrompt(profile) {
  // 注意：档案存在但字段全空（没扫世界书 / 扫了但书是空的）时，
  // 也必须走"靠正文推断"的引导分支，否则提示词里会只剩一句"（暂无档案）"。
  const d = profile?.data || {};
  const facts = [
    ['世界名', d.worldName],
    ['舞台', d.stage],
    ['势力', d.factions],
  ].filter(([, v]) => v && String(v).trim());
  const voice = [
    ['称呼体系', d.naming],
    ['本土词汇', d.lexicon],
    ['措辞腔调', d.manner],
    ['观众兴奋点', d.interests],
  ].filter(([, v]) => v && String(v).trim());

  if (!facts.length && !voice.length) {
    return [
      '（还没有世界观档案：没有可读的世界书，或者还没扫描过）',
      '此时请完全依靠下面的正文来判断这是什么样的世界：从人名、称谓、器物、事件、说话方式里推断该用什么口气。',
      '拿不准的时候，就用最普通的中文口语吐槽，不要发明设定、不要编造没出现过的专有名词。',
    ].join('\n');
  }

  const out = [];
  if (d.channelName) out.push(`直播间名：《${d.channelName}》`);
  if (facts.length) {
    out.push('世界事实（照这个世界的实际情况说话）：');
    out.push(facts.map(([k, v]) => `- ${k}：${v}`).join('\n'));
  }
  if (voice.length) {
    out.push('观众腔调（这是这个直播间的观众说话的方式，照着用）：');
    out.push(voice.map(([k, v]) => `- ${k}：${v}`).join('\n'));
  }
  return out.join('\n');
}
export function batchUserPrompt({ profile, story, viewers, count, fourthWall, recentGags }) {
  const parts = [];
  parts.push('【本直播间观众档案】');
  parts.push(renderProfileForPrompt(profile));
  parts.push('');

  // 语风范本：这是让弹幕"像弹幕"的关键 —— 给真实台词当 few-shot，
  // 比给一堆"要短句、要口语"的形容词管用得多。
  const samples = profile?.styleSamples || [];
  if (samples.length) {
    parts.push(`【语风范本】下面这些是**这个直播间观众真实说过的话**（来自语风素材）${profile.styleBookName ? `：《${profile.styleBookName}》` : ''}。`);
    parts.push('照着这个腔调、这个用词、这个长度写新弹幕；**可以借鉴说法，但不要原样照抄重复**。');
    parts.push(samples.map((s) => `· ${s}`).join('\n'));
    parts.push('');
  }

  if (viewers?.length) {
    parts.push('【本直播间的常驻观众（尽量让其中一部分在本批出现，昵称要原样使用）】');
    parts.push(
      viewers
        .map((v) => `- ${v.昵称}｜${v.类型 || '路人'}｜${v.立场 || ''}${v.口癖 ? `｜口癖：${v.口癖}` : ''}`)
        .join('\n'),
    );
    parts.push('其余弹幕可以来自随机路过的观众，自己起符合这个世界语言习惯的昵称。');
    parts.push('');
  } else {
    parts.push('【观众】还没有常驻名册，本批全部用随机路过的观众，昵称要贴合这个世界。');
    parts.push('');
  }

  parts.push('【正在直播的内容（台上刚发生的事，弹幕要贴着它写）】');
  parts.push(story?.trim() ? story : '（没有给出正文：那就只写符合这个世界日常氛围的弹幕，不要编造具体剧情）');
  parts.push('');

  if (recentGags?.length) {
    parts.push('【本直播间已经刷起来的梗（可以自然地复读、接力，但别硬套）】');
    parts.push(recentGags.slice(0, 6).map((g) => `- ${g}`).join('\n'));
    parts.push('');
  }

  parts.push('【破次元度】');
  const fw = Math.max(0, Math.min(100, Number(fourthWall) || 0));
  parts.push(
    fw <= 10
      ? '0~10：完全本土化。禁止出现任何现实世界的网络词、梗、平台名、现代科技名词。'
      : fw <= 35
        ? `${fw}：以本土化为主，只允许极少量通用情绪词（如"6""草"这类），不准出现现实梗与平台名。`
        : fw <= 65
          ? `${fw}：本土化为主，可以掺入少量现实网络流行语，但不要出现具体平台名与现实人物。`
          : `${fw}：允许较大量现实网络梗与流行语，但仍要用这个世界的称呼去说人和事。`,
  );
  parts.push('');

  parts.push(`【任务】生成 ${count} 条弹幕。`);
  parts.push('【自检】交出去之前，逐条问一遍："这条是在回应正文的哪一句？"答不上来的就重写。');
  parts.push('不要把"这波稳了"这类放之四海皆准的话凑进来 —— 每条都要有具体的由头。');
  parts.push('【输出格式】只输出一个 JSON 对象，键名必须完全一致：');
  parts.push('{"弹幕":[{"昵称":"","内容":"","类型":"","回复":""}]}');
  parts.push('· "弹幕" 是数组，必须正好 ' + count + ' 个元素；');
  parts.push('· "昵称"=发这条的人（常驻观众用其昵称，其余自己起贴合世界观的昵称）；');
  parts.push('· "内容"=弹幕正文（4~40 字，禁止空洞套话）；');
  parts.push('· "类型" 只能从这些里选一个：普通 / 懂行 / 起哄 / 催促 / 抬杠 / 玩梗 / 送礼 / 情绪；');
  parts.push('· "回复"=若有 @ 的对象就填那人昵称，否则空字符串。');
  parts.push('不要输出任何解释文字、不要加代码围栏，内容互不重复。');
  return parts.join('\n');
}

export function batchJsonSchema(count) {
  const str = { type: 'string' };
  return {
    name: 'danmaku_batch',
    description: '一批直播弹幕',
    strict: true,
    value: {
      type: 'object',
      properties: {
        弹幕: {
          type: 'array',
          items: {
            type: 'object',
            properties: { 昵称: str, 内容: str, 类型: str, 回复: str },
            required: ['昵称', '内容', '类型', '回复'],
            additionalProperties: false,
          },
          minItems: Math.max(1, Math.floor(count * 0.5)),
        },
      },
      required: ['弹幕'],
      additionalProperties: false,
    },
  };
}

/**
 * 生成一批弹幕。
 *
 * @param {object} input
 * @param {object} input.api
 * @param {object} input.profile
 * @param {string} input.story           最近正文（已按字数预算裁好）
 * @param {object[]} input.viewers       常驻观众
 * @param {number} input.count           条数
 * @param {number} input.fourthWall      破次元度 0~100
 * @param {number} [input.activeViewers] 本批最多让几个常驻观众露脸（提示用）
 * @param {string[]} [input.recentGags]
 * @param {(msg:string, level?:string)=>void} [input.log]
 * @returns {Promise<{ok:boolean, items:object[], error:string, raw:string}>}
 */
export async function generateBatch(input) {
  const {
    api,
    profile,
    story,
    viewers = [],
    count = 15,
    fourthWall = 20,
    recentGags = [],
    log = () => {},
  } = input || {};

  const res = await chatJson({
    api,
    label: '弹幕生成',
    system: batchSystemPrompt(),
    user: batchUserPrompt({ profile, story, viewers, count, fourthWall, recentGags }),
    jsonSchema: batchJsonSchema(count),
  });

  if (!res.ok) return { ok: false, items: [], error: res.error || '生成失败', raw: res.text || '' };

  let list = null;
  if (res.value && Array.isArray(res.value.弹幕)) list = res.value.弹幕;
  else if (Array.isArray(res.value)) list = res.value;
  else if (res.value && Array.isArray(res.value.danmaku)) list = res.value.danmaku;

  if (!list) {
    // 兜底：模型没按 JSON 回，就按行拆
    const lines = String(res.text || '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^[\s\-*\d.、）)]+/, '').trim())
      .filter((l) => l && l.length >= 2 && l.length <= 80);
    if (!lines.length) {
      return { ok: false, items: [], error: '生成失败：模型没有返回可解析的弹幕', raw: res.text || '' };
    }
    log(`模型没按 JSON 返回，已按行兜底解析出 ${lines.length} 条`, 'warn');
    list = lines.slice(0, count).map((text, i) => ({ 昵称: '', 内容: text, 类型: '普通', 回复: '', _fallback: true }));
  }

  const items = list
    .map((d, i) => {
      let text = String(d?.内容 ?? d?.text ?? d?.content ?? '').trim();
      const reply = String(d?.回复 ?? d?.reply ?? '').trim();
      if (reply && !text.includes('@')) text = `@${reply} ${text}`;
      return {
        i,
        昵称: String(d?.昵称 ?? d?.name ?? '').trim().slice(0, 16) || '路过的观众',
        内容: text.slice(0, 120),
        类型: String(d?.类型 ?? d?.tone ?? '普通').trim().slice(0, 8),
        回复: reply.slice(0, 16),
      };
    })
    .filter((d) => d.内容);

  if (!items.length) {
    return { ok: false, items: [], error: '生成失败：解析后没有任何有效弹幕', raw: res.text || '' };
  }

  return { ok: true, items, error: '', raw: res.text || '' };
}

/* ───────────── 剧情来源与梗记忆 ───────────── */

/**
 * 把最近几轮正文拼成"正在直播的内容"，并裁到字数预算内。
 * 这是弹幕与剧情挂钩的唯一来源；反向不成立（正文拿不到弹幕）。
 */
export function buildStoryContext(messages, { rounds = 2, charBudget = 6000 } = {}) {
  if (!Array.isArray(messages) || !messages.length || rounds <= 0) return '';
  const picked = messages.slice(-Math.max(1, Math.floor(rounds)));
  let budget = Math.max(0, Math.floor(charBudget || 0));
  const chunks = [];
  // 从最近一条往前拼，超预算就从更早的条目开始截断尾部
  for (let i = picked.length - 1; i >= 0; i--) {
    const m = picked[i];
    const label = m.isUser ? '【观众席上的那个人说】' : `【台上】`;
    const text = String(m.text || '').trim();
    if (!text) continue;
    if (budget <= 0) break;
    const body = text.length > budget ? `${text.slice(text.length - budget)}` : text;
    budget -= body.length;
    chunks.unshift(`${label}\n${body}`);
  }
  return chunks.join('\n\n');
}

/**
 * 从一批弹幕里挑出"可以被复读的梗"。
 *
 * 注意取舍方向和以前相反：以前优先挑最短最情绪化的，结果挑出来的全是
 * "稳了""666"这类空洞套话。现在优先挑**带具体指代**的（提到了某个人物、某个招式、
 * 某件东西），因为那才是这个直播间独有的梗，复读起来才有味道。
 */
export function pickGags(items, max = 3) {
  if (!Array.isArray(items)) return [];
  // 纯套话：放到任何直播间都成立，单条出现就排除。
  // 「这波…稳…」用两个变体：短式（这波稳了/这波真的稳）与"稳X"式，
  // 都不跨标点，避免误吞正经句子。
  // 之前写成 `这波[^，。；]{0,6}稳` 是错的：列表匹配要求整串命中，
  // 而末尾的"了"没被吃掉 → "这波稳了"匹配不上。
  const GENERIC =
    /^(稳了|稳了稳了|6+|草|前排|来了来了|散了散了|坐等|好家伙|卧槽|笑死|就这|退钱|沙发|？？？|来了|这波[^，。；]{0,6}稳[^，。；]{0,6})[？！!。…~\s]*$/;
  const scored = items
    .map((d) => {
      const t = String(d.内容 || '').replace(/^@\S+\s*/, '').trim();
      // 太长的不是弹幕梗，是句子 —— 直接排除
      if (t.length < 2 || t.length > 24) return { t, score: -99 };
      // 纯套话直接排除
      if (GENERIC.test(t)) return { t, score: -99 };

      let score = 1;
      // 带具体指代的更值钱：引号、数字、专名、招式/器物词
      if (/[「『"'"']/.test(t)) score += 2;
      if (/\d/.test(t)) score += 1;
      if (/[A-Za-z]{2,}/.test(t)) score += 1;
      if (/(波|招|剑|刀|掌|术|法|气|阵|丹|符|枪|拳|腿|身法|心法)/.test(t)) score += 2;
      if (d.类型 && /玩梗|懂行|抬杠/.test(d.类型)) score += 2;
      if (d.类型 && /情绪|起哄/.test(d.类型)) score += 1;
      // 完整句子感（有逗号句号）说明它更像正经发言，不适合当梗
      if (/[，。；]/.test(t)) score -= 2;
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, max)).map((x) => x.t);
}

/** 给每条弹幕分配一个颜色（延后到渲染时做，这里只留占位） */
export function attachColors(items, palette) {
  return items.map((d, i) => ({ ...d, color: palette?.[i % (palette?.length || 1)] || '' }));
}
