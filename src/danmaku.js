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

/**
 * 认知隔离（观众视角的反全知）。
 *
 * 口径参考社区通用的「心之壁·认知隔离」规则：**情报抵达 = 源 + 通道 + 接收者，缺一不达**。
 * 落到弹幕上就是：观众只知道自己从直播里看到/听到的那部分，
 * 不是读者，不是上帝 —— 他们看不到内心、看不到镜头外、看不到没播出来的前情。
 * 这条比"要像弹幕"还重要：一旦观众开始全知，弹幕就变成了剧透器。
 */
export const KNOWLEDGE_RULES = [
  '【认知隔离 · 反全知（与体裁铁律同级，不得违反）】',
  '这批观众**只是看直播的人**。他们知道什么，完全取决于"直播里放出来了什么"。',
  '',
  '判定口径：**情报抵达 = 源 + 通道 + 接收者，缺一不达。**',
  '· 只对**正文里实际写出来的内容**有反应。正文没写的事，他们不知道、不能提。',
  '· 正文没写出来的**内心活动、动机、真意、后续打算** —— 他们**不可知**，只能猜；',
  '  猜的时候必须用推测语气（"他这是要干嘛""我赌五毛"），**不能当成事实陈述**。',
  '· **不在场发生的事、镜头外的事、没播出来的前情与往事** —— 他们不知道。',
  '  哪怕设定资料里有，只要正文没演出来，观众就不该"早就知道"。',
  '· **未来的走向** —— 他们不可能知道。可以押注、可以预判，但不许笃定地宣布结果。',
  '· 不要替角色解说心理（"他其实是在试探"这种是旁白，不是弹幕）。',
  '· 观众之间**信息量参差**：有人看出来一点，有人完全没看懂，有人看错了 —— 这很正常，',
  '  反而更真实。不要人人都懂、人人都对。',
  '· 他们可以**误解、可以捕风捉影、可以瞎猜**，但**不能凭空知道**。',
].join('\n');

export function batchSystemPrompt({ knowledgeIsolation = true } = {}) {
  return [
    '你是一个直播间弹幕生成器。你只负责写弹幕，不写别的任何东西。',
    '',
    GENRE_RULES,
    ...(knowledgeIsolation ? ['', KNOWLEDGE_RULES] : []),
    '',
    '身份与用词：',
    '· 这批观众是这个世界里的本地人。他们用这个世界的词、这个世界的常识、这个世界的立场说话。',
    '· 称呼台上的人时，用这个世界的称呼体系（头衔、绰号、门派名等），不要用"角色""主角""玩家"这类元语言。',
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
    '· 禁止剧透式发言：不许把"接下来他会……""其实他早就……"这种全知内容当成弹幕。',
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
export function batchUserPrompt({ profile, story, viewers, count, fourthWall, recentGags, knowledgeIsolation = true }) {
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

  if (knowledgeIsolation) {
    // 放到任务前面再强调一次：单靠 system 容易被长材料淹没
    parts.push('【再次强调 · 观众只知道直播里放出来的东西】');
    parts.push('· 下面【正在直播的内容】就是他们**全部**的信息来源；档案里的世界事实只是背景常识，');
    parts.push('  **不等于**他们知道这一段里发生了什么。');
    parts.push('· 没写出来的内心、动机、真意、往事、镜头外的事、后续走向 —— 他们不知道，只能猜；');
    parts.push('  猜就必须用推测语气（"他这是要干嘛""我赌五毛"），不许说成事实。');
    parts.push('· 不要替角色解释心理，也不要预告接下来会发生什么。');
    parts.push('');
  }

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
 * 从模型返回值里找出弹幕数组。
 * 结构化输出默认是关的，各家模型写法五花八门，所以这里要宽容：
 *   {弹幕:[…]} / {弹幕列表:[…]} / {danmaku:[…]} / {items:[…]} / 直接就是数组 / 单条对象
 * 甚至 {弹幕:{弹幕:[…]}} 这种套两层。
 */
export function pickDanmakuArray(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return null;
  const keys = ['弹幕', '弹幕列表', 'danmaku', 'danmakus', 'items', 'list', 'barrage', 'comments', '评论'];
  for (const k of keys) {
    if (Array.isArray(value[k])) return value[k];
    // 套了一层（例如 {弹幕:{弹幕:[…]}}）
    if (value[k] && typeof value[k] === 'object') {
      const inner = pickDanmakuArray(value[k]);
      if (inner) return inner;
    }
  }
  // 只返回了一条的情况：看它有没有弹幕内容的字段
  if (typeof value.内容 === 'string' || typeof value.content === 'string' || typeof value.text === 'string') {
    return [value];
  }
  return null;
}

/**
 * 纯文本兜底：把一段话按行拆成弹幕。
 * 支持 "昵称：内容" / "昵称: 内容" / "内容" 三种形态。
 */
export function parseLinesFallback(text, limit) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw
      .replace(/^\s*[-*•·]\s+/, '')
      .replace(/^\s*\d+[.、)]\s*/, '')
      .replace(/^\s*[「『"'"']\s*/, '')
      .trim();
    // 去掉尾部逗号，避免最后一条被 JSON 残渣污染
    line = line.replace(/[",]\s*$/, '').replace(/」|』$/,'').trim();
    if (!line || line.length < 2 || line.length > 80) continue;
    // 跳过看起来像 JSON 结构、代码围栏或说明文字的行
    if (/^[{}\[\]"']*$/.test(line)) continue;
    if (/^```/.test(line)) continue;
    if (/^(弹幕|输出|说明|以下是|JSON)/.test(line)) continue;

    const m = /^([^：:]{1,16})[：:]\s*(.+)$/.exec(line);
    if (m) {
      out.push({ 昵称: m[1].trim(), 内容: m[2].trim(), 类型: '普通', 回复: '' });
    } else {
      out.push({ 昵称: '', 内容: line, 类型: '普通', 回复: '' });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从**被截断**的 JSON 文本里抢救出完整的对象。
 *
 * 为什么需要：模型输出有 token 上限，一批 15 条中文弹幕很容易在最后一条上被切断，
 * 于是整段 JSON 不合法、一条都用不了。但前面那些对象其实是**完整可用**的。
 *
 * 做法：按花括号配平扫描（跳过字符串内的括号与转义），每凑齐一个平衡的 `{...}`
 * 就尝试解析一次，成功的就收下；遇到配不平的（就是被截断的那条）就停。
 */
/**
 * 从**被截断**的 JSON 文本里抢救出完整的对象。
 *
 * 为什么需要：模型输出有 token 上限，一批 15 条中文弹幕很容易在最后一条上被切断，
 * 于是整段 JSON 不合法、一条都用不了。但前面那些对象其实是**完整可用**的。
 *
 * 做法（不依赖固定的嵌套层级）：
 *   1. 先找 `"弹幕": [ …`（或 `"语料"` 之类）的数组起点；
 *   2. 从数组起点开始扫描，每凑齐一个**配平**的 `{...}` 就尝试解析一次，成功就收下；
 *   3. 遇到配不平的（就是被截断的那条）就停 —— 后面的都不可信了。
 *   字符串内的花括号与转义都会被正确跳过。
 *
 * 为什么不用"深度等于几"来判断：顶层对象在深度 1、数组元素在深度 2，
 * 写死哪一个都会在另一种输入上失效（我第一版就是这么错的）。
 */
export function salvageObjects(text) {
  const s = String(text || '');
  if (!s) return [];

  // 第一遍：找数组起点。优先找"弹幕"这类键，找不到就退回第一个 '['。
  let from = -1;
  for (const key of ['弹幕', '语料', 'danmaku', 'items']) {
    const k = s.indexOf(`"${key}"`);
    if (k < 0) continue;
    const bracket = s.indexOf('[', k);
    if (bracket >= 0) {
      from = bracket + 1;
      break;
    }
  }
  if (from < 0) {
    const bracket = s.indexOf('[');
    from = bracket >= 0 ? bracket + 1 : 0;
  }

  // 第二遍：从数组里捞出配平的对象
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue; // 多余的右括号，忽略
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = s.slice(start, i + 1);
        try {
          const parsed = JSON.parse(chunk);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
        } catch {
          /* 这一段不合法就丢掉 */
        }
        start = -1;
      }
      continue;
    }
    if (ch === ']' && depth === 0) break; // 数组结束
    // 配平扫描里遇到配不平的 '{' 起头就说明被截断了；其它字符忽略
  }
  return out;
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
 * @param {boolean} [input.knowledgeIsolation] 是否给观众加"认知隔离"约束
 * @param {(msg:string, level?:string)=>void} [input.log]
 * @returns {Promise<{ok:boolean, items:object[], error:string, raw:string, fallback?:boolean}>}
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
    knowledgeIsolation = true,
    log = () => {},
  } = input || {};

  const res = await chatJson({
    api,
    label: '弹幕生成',
    system: batchSystemPrompt({ knowledgeIsolation }),
    user: batchUserPrompt({ profile, story, viewers, count, fourthWall, recentGags, knowledgeIsolation }),
    jsonSchema: batchJsonSchema(count),
  });

  if (!res.ok) return { ok: false, items: [], error: res.error || '生成失败', raw: res.text || '' };

  let list = pickDanmakuArray(res.value);
  let fallback = false;
  let truncated = false;

  if (!list) {
    // 兜底：模型没按 JSON 回，就按行拆
    // 先试**截断抢救**：一批 15 条中文弹幕很容易在最后一条被 token 上限切断，
    // 整段 JSON 于是不合法，但前面那些对象是完整可用的，不该一起丢掉。
    const salvaged = salvageObjects(res.text);
    if (salvaged.length) {
      list = salvaged;
      fallback = true;
      truncated = true;
      log(
        `模型输出被截断了（多半是 token 上限），已抢救出前 ${salvaged.length} 条完整弹幕。` +
          `把「最大输出」调大可以要满整批`,
        'warn',
      );
    } else {
      list = parseLinesFallback(res.text, count);
      fallback = list.length > 0;
    }
    if (!list.length) {
      const head = String(res.text || '').slice(0, 200).replace(/\s+/g, ' ');
      return {
        ok: false,
        items: [],
        error: `生成失败：模型没有返回可解析的弹幕${head ? `｜它实际回的是：${head}` : '（返回为空）'}`,
        raw: res.text || '',
      };
    }
    if (!truncated) log(`模型没按 JSON 返回，已按行兜底解析出 ${list.length} 条`, 'warn');
  }

  const items = list
    .map((d, i) => {
      let text = String(d?.内容 ?? d?.text ?? d?.content ?? d?.message ?? '').trim();
      const reply = String(d?.回复 ?? d?.reply ?? d?.at ?? '').trim();
      if (reply && !text.includes('@')) text = `@${reply} ${text}`;
      return {
        i,
        昵称: String(d?.昵称 ?? d?.name ?? d?.user ?? '').trim().slice(0, 16) || '路过的观众',
        内容: text.slice(0, 120),
        类型: String(d?.类型 ?? d?.type ?? d?.tone ?? '普通').trim().slice(0, 8),
        回复: reply.slice(0, 16),
      };
    })
    .filter((d) => d.内容);

  if (!items.length) {
    return { ok: false, items: [], error: '生成失败：解析后没有任何有效弹幕（内容字段可能为空）', raw: res.text || '' };
  }

  return { ok: true, items, error: '', raw: res.text || '', fallback };
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
 * 安排出现时刻 + 分配轨道，**保证同轨不重叠**。
 *
 * 为什么必须做碰撞检测：速度是恒定的（每条只在自己基准上浮一点点），
 * 所以"时间上挨得近"的两条弹幕会**一直挨得近** —— 光随机时刻是治不了重叠的。
 * 唯一可靠的办法是：算清楚前一条的尾巴什么时候让开，再决定这一条能不能进这条轨道。
 *
 * 算法（贪心 + 提前量）：
 *   1. 先给每条一个带浮动的理想时刻（assignDelays）；
 *   2. 按时刻排序，依次为每条挑一条**留有余量**的轨道：
 *      该轨道上一条的尾端要让开 `gapPx` 才算可以进；
 *   3. 首选"能让开的轨道中最早空出来的那条"，都让不开就选最快让开的，
 *      并把这一条的时刻顺延到那个时刻（宁可晚一点出现，也不要叠在一起）。
 *
 * @param {object[]} items
 * @param {object} opts
 * @param {number} opts.base        基准间隔（秒）
 * @param {number} opts.jitterPct   间隔浮动百分比
 * @param {number} opts.lanes       可用轨道数
 * @param {number} opts.speed       基准速度 px/s（用来算尾巴什么时候让开）
 * @param {number} opts.stageWidth  舞台宽度 px
 * @param {number} [opts.avgWidth]  每条弹幕的平均宽度 px（估的，没法精确测量）
 * @param {number} [opts.gapPx]     同轨最小净间隔 px
 * @param {()=>number} [opts.rand]
 * @returns {object[]} 带 `延迟` 与 `轨道` 的新数组
 */
export function assignLanesAndDelays(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (!n) return [];
  const base = Math.max(0, Number(opts.base) || 0.22);
  const jitterPct = Math.max(0, Number(opts.jitterPct) || 0);
  const lanes = Math.max(1, Math.floor(Number(opts.lanes) || 1));
  const speed = Math.max(20, Number(opts.speed) || 110);
  const stageWidth = Math.max(120, Number(opts.stageWidth) || 800);
  const avgWidth = Math.max(24, Number(opts.avgWidth) || 200);
  const gapPx = Math.max(0, opts.gapPx === undefined ? 26 : Number(opts.gapPx));
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;

  // ① 理想时刻
  const delays = assignDelays(n, base, jitterPct, rand);

  // ② 按时刻排序后逐条安排（同刻的按原顺序）
  const order = list.map((it, i) => ({ it, i, t: delays[i] })).sort((a, b) => a.t - b.t || a.i - b.i);

  // 每条进入时占据的空间：它的宽度 + 想要的净间隔。
  // 尾巴让开所需秒数 = 这个空间 / 速度。
  const occupySec = (avgWidth + gapPx) / speed;
  // 上一条彻底离开舞台所需秒数（之后它就不占了）
  const clearSec = (stageWidth + avgWidth) / speed;

  const laneFreeAt = new Array(lanes).fill(0); // 每条轨道下一次可进入的时刻
  const out = new Array(n);

  for (const entry of order) {
    let t = entry.t;
    // 找一条能立刻进的轨道：它的空闲时刻不晚于这一条的时刻
    let pick = -1;
    let bestFree = Infinity;
    for (let l = 0; l < lanes; l += 1) {
      if (laneFreeAt[l] <= t + 1e-6) {
        pick = l;
        break;
      }
      if (laneFreeAt[l] < bestFree) {
        bestFree = laneFreeAt[l];
        pick = l;
      }
    }
    if (laneFreeAt[pick] > t) t = laneFreeAt[pick]; // 都让不开就顺延
    // 先**向上**取整到毫秒，再用取整后的值记账 ——
    // 内部记账与对外给出的值必须是同一个数，否则四舍五入/取整的误差
    // 会让"尾巴让开"的约束在小数位上失效，同轨两条真的叠上。
    t = Math.ceil(t * 1000) / 1000;

    out[entry.i] = {
      ...entry.it,
      延迟: t,
      轨道: pick,
    };
    // 这条占据轨道到 t + occupySec；如果它很快飞出舞台，之后就完全自由了
    laneFreeAt[pick] = t + occupySec;
    // 若某条轨道上的弹幕已经飞出去了，轨道就空出来（用"完全离开"兜底，避免越排越后）
    for (let l = 0; l < lanes; l += 1) {
      if (laneFreeAt[l] > 0 && laneFreeAt[l] - clearSec > t) laneFreeAt[l] = t;
    }
  }
  return out;
}

/**
 * 给一批弹幕安排出现时刻（秒），带浮动。
 *
 * 真实弹幕不是等间隔出来的：有时挤在一起刷屏，有时空一下。
 * 所以先算出"理想等间隔时刻"，再加抖动。
 *
 * 两个约束必须守住，否则会看起来像掉帧或卡顿：
 *   · **不乱序** —— 后一条不早于前一条出现（用下界夹住）；
 *   · **不完全重叠** —— 相邻两条至少间隔 base 的一个小比例（默认 25%）。
 *
 * 注意：这只管"时刻别挨太近"，**真正的防重叠要靠 assignLanesAndDelays 分轨道**。
 * 速度恒定意味着同时刻挨得近的两条会一直挨得近。
 *
 * @param {number} n           条数
 * @param {number} base        基准间隔（秒）
 * @param {number} jitterPct   抖动幅度（百分比，相对 base，0~100）
 * @param {()=>number} [rand]  随机源
 * @returns {number[]} 每条的出现时刻（秒）
 */
export function assignDelays(n, base, jitterPct, rand = Math.random) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const b = Math.max(0, Number(base) || 0);
  const pct = Math.min(100, Math.max(0, Number(jitterPct) || 0));
  const out = [];
  if (!count) return out;
  if (!b) return Array.from({ length: count }, () => 0);
  if (!pct) return Array.from({ length: count }, (_, i) => i * b);

  const headroom = pct / 100;
  const minGap = b * 0.25; // 相邻两条的最小间隔
  for (let i = 0; i < count; i += 1) {
    const lo = i === 0 ? 0 : out[i - 1] + minGap;
    const hi = Math.max(lo, (i + headroom) * b);
    out.push(lo + rand() * (hi - lo));
  }
  return out;
}

/**
 * 给每条弹幕定一个自己的飞行速度：以设定速度为基准上下浮动。
 *
 * 为什么要"定死在数据里"而不是渲染时随机：这样**重播和静态列表的快慢都一致**，
 * 回看同一批时不会每条都变速度。
 *
 * @param {object[]} items
 * @param {number} baseSpeed    基准速度 px/s
 * @param {number} variancePct  浮动幅度（百分比，例如 5 表示 ±5%）
 * @param {()=>number} [rand]   随机源，便于测试注入
 */
export function assignSpeeds(items, baseSpeed, variancePct, rand = Math.random) {
  const base = Math.max(20, Number(baseSpeed) || 110);
  // 浮动上限收在 60%：再大就不像"同一场直播里的弹幕"了
  const pct = Math.min(60, Math.max(0, Number(variancePct) || 0));
  return (items || []).map((it) => {
    if (!pct) return { ...it, 速度: Math.round(base) };
    const factor = 1 + ((rand() * 2 - 1) * pct) / 100;
    return { ...it, 速度: Math.max(20, Math.round(base * factor)) };
  });
}

/**
 * 把出现时刻写进每条弹幕（存在数据里，重播时保持一致）。
 * assignDelays 已经保证不乱序，所以按序号直接对应即可。
 */
export function assignDelaysToItems(items, base, jitterPct, rand = Math.random) {
  const list = items || [];
  const delays = assignDelays(list.length, base, jitterPct, rand);
  return list.map((it, i) => ({ ...it, 延迟: Number((delays[i] || 0).toFixed(2)) }));
}

/** 取一条弹幕的出现时刻（秒）：优先用它自己定好的，否则按序号等间隔 */
export function delayOfItem(item, index, base) {
  const own = Number(item?.延迟);
  if (Number.isFinite(own) && own >= 0) return own;
  return Math.max(0, Number(index) || 0) * Math.max(0, Number(base) || 0);
}

/** 取一条弹幕的飞行速度：优先用它自己定好的，否则退回基准 */
export function speedOfItem(item, baseSpeed) {
  const own = Number(item?.速度);
  if (Number.isFinite(own) && own > 0) return own;
  return Math.max(20, Number(baseSpeed) || 110);
}

/** 从一批弹幕里挑出"可以被复读的梗"。
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
