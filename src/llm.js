/**
 * llm.js — 请求层
 *
 * 两条路线，都在这里统一：
 *
 *   route = 'st'      走酒馆后端 /api/backends/chat-completions/generate
 *                     ★ 这是能用上"酒馆里已经存好的 key"的唯一路线
 *                       （config.yaml 里 allowKeysExposure: false 时，
 *                        /api/secrets/view 是 403，插件读不到你的 key；
 *                        但后端是自己 readSecret 的，不受影响）
 *
 *   route = 'direct'  浏览器直连自填的 OpenAI 兼容端点
 *                     ★ 完全独立，但依赖端点允许跨域（CORS）
 *
 * 两条路线都从零拼消息数组，不经过酒馆的提示词组装，
 * 所以弹幕和正文的上下文天然隔离。
 */

import { requestHeaders, getCurrentConnection } from './st.js';

/* ───────────── 消息拼接 ───────────── */

/**
 * 把 system + user 拼成消息数组。
 * 有些后端（如 Gemini）不接受 system role，所以支持 mode 降级。
 * @param {string} system
 * @param {string} user
 * @param {'system'|'merge'} [mode]
 */
export function buildMessages(system, user, mode = 'system') {
  const s = String(system || '').trim();
  const u = String(user || '').trim();
  if (mode === 'merge') {
    const merged = [s, u].filter(Boolean).join('\n\n---\n\n');
    return [{ role: 'user', content: merged }];
  }
  const msgs = [];
  if (s) msgs.push({ role: 'system', content: s });
  msgs.push({ role: 'user', content: u });
  return msgs;
}

/* ───────────── 响应解析 ───────────── */

/**
 * 从各家响应里把正文抠出来。兼容：
 *   · OpenAI 非流式：choices[0].message.content
 *   · 纯文本/流式聚合：字符串
 *   · Anthropic：content[].text
 *   · Gemini：candidates[0].content.parts[].text
 *   · 常见包装：{ content: ... } / { text: ... } / { data: ... }
 */
export function extractText(data) {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return '';

  const fromParts = (parts) =>
    Array.isArray(parts)
      ? parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
      : '';

  if (Array.isArray(data.choices) && data.choices.length) {
    const c = data.choices[0];
    const msgContent = c?.message?.content;
    if (typeof msgContent === 'string') return msgContent;
    if (Array.isArray(msgContent)) return fromParts(msgContent);
    if (typeof c?.text === 'string') return c.text;
    if (typeof c?.delta?.content === 'string') return c.delta.content;
  }
  if (Array.isArray(data.content)) return fromParts(data.content);
  if (typeof data.content === 'string') return data.content;
  if (Array.isArray(data.candidates) && data.candidates.length) {
    return fromParts(data.candidates[0]?.content?.parts);
  }
  if (typeof data.text === 'string') return data.text;
  if (typeof data.response === 'string') return data.response;
  if (data.data) return extractText(data.data);
  return '';
}

/** 解析 SSE 流，把 delta 文本拼起来（万一后端回了流式） */
export function parseSse(raw) {
  let out = '';
  const lines = String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      out += extractText(obj);
    } catch {
      /* 不是 JSON，跳过 */
    }
  }
  return out;
}

/** 判断响应是否像流式 */
function looksLikeSse(text) {
  const head = String(text || '').slice(0, 200);
  return /^\s*data:\s*\{/.test(head) || /event:\s*\w+/.test(head);
}

/**
 * 把模型输出解析成 JSON（允许被 ```json 包着、或前后带废话）。
 * @returns {{ok:boolean, value:any, error:string, raw:string}}
 */
export function parseJsonLoose(text) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, value: null, error: '模型返回空内容', raw };

  const candidates = [];
  candidates.push(trimmed);

  // 去掉 ``` 围栏
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());

  // 抠第一个平衡的 { } 或 [ ]
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = trimmed.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          candidates.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
  }

  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c), error: '', raw };
    } catch {
      /* 试下一个 */
    }
  }
  return { ok: false, value: null, error: '模型输出不是合法 JSON', raw };
}

/* ───────────── 带超时的 fetch ───────────── */

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (ctrl && timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        ctrl.abort();
      } catch {
        /* noop */
      }
    }, timeoutMs);
  }
  try {
    const res = await fetch(url, ctrl ? { ...init, signal: ctrl.signal } : init);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ───────────── 请求体构造 ───────────── */

/** 确定这次请求要用的酒馆后端参数 */
export function resolveStTarget(api) {
  const preset = String(api.proxyPreset || '').trim();
  const current = getCurrentConnection();
  const explicit = String(api.source || '').trim();

  // 默认"自动"：跟随酒馆当前连接。这样用户已经在酒馆里配好的 key 能直接用，
  // 不会出现"自定义端点没配置"这种因为插件默认值选错而撞上的报错。
  const auto = api.sourceMode !== 'fixed';
  let source = auto ? String(current?.source || '').trim() || explicit || 'openai' : explicit || 'openai';

  const out = {
    chat_completion_source: source,
    custom_url: '',
    reverse_proxy: '',
    proxy_password: '',
    model: String(api.model || '').trim(),
    presetHint: '',
  };

  if (preset) {
    // 代理预设：名字交给后端自己解析
    out.reverse_proxy = preset;
    out.presetHint = preset;
    return out;
  }
  if (api.reverseProxy) out.reverse_proxy = String(api.reverseProxy);

  // custom 源的地址必须显式传下去（后端从 body.custom_url 取），否则会报
  // "Custom endpoint is missing. Please configure custom_url."
  if (source === 'custom') {
    out.custom_url = String(current?.customUrl || api.reverseProxy || '').trim();
  }
  if (!out.model && current?.model) out.model = String(current.model);

  return out;
}

/** 请求前的基本体检：有问题就在这一侧说人话，不去猜后端英文报错 */
export function preflight(api) {
  if (api?.route === 'direct') {
    const d = api.direct || {};
    if (!String(d.baseUrl || '').trim()) return { ok: false, error: '直连路线还没填 API 地址（面板 → 连接）' };
    if (!String(d.model || api.model || '').trim()) return { ok: false, error: '直连路线还没填模型名（面板 → 连接）' };
    return { ok: true };
  }
  const target = resolveStTarget(api || {});
  if (target.chat_completion_source === 'custom' && !target.custom_url) {
    return {
      ok: false,
      error:
        '当前用的是「自定义 OpenAI 兼容端点（custom）」，但酒馆里没配这个地址。两个办法：' +
        '① 把「AI 来源」改成「自动跟随酒馆当前连接」（推荐，直接复用你已配好的连接）；' +
        '② 或在酒馆的「聊天补全」设置里填好自定义端点地址。',
    };
  }
  return { ok: true };
}

/** 走酒馆后端的完整请求体 */
export function buildStRequestBody(api, messages, { jsonSchema } = {}) {
  const target = resolveStTarget(api);
  const body = {
    chat_completion_source: target.chat_completion_source,
    messages,
    model: target.model,
    max_tokens: Number(api.maxTokens) || 2000,
    temperature: Number.isFinite(api.temperature) ? api.temperature : 1.05,
    stream: false,
    // 关掉酒馆的各种"后处理"，我们要的是原样收发
    custom_prompt_post_processing: '',
  };
  if (target.custom_url) body.custom_url = target.custom_url;
  if (target.reverse_proxy) body.reverse_proxy = target.reverse_proxy;
  if (target.proxy_password) body.proxy_password = target.proxy_password;
  if (jsonSchema) body.json_schema = jsonSchema;
  return body;
}

/* ───────────── 主入口 ───────────── */

/**
 * @typedef {Object} ChatRequest
 * @property {string} system
 * @property {string} user
 * @property {object} api          settings.api
 * @property {object} [jsonSchema] { name, description, value, strict }
 * @property {string} [label]      出错提示里显示这次是干嘛的
 */

/**
 * 发一次请求，返回纯文本。
 * @param {ChatRequest} req
 * @returns {Promise<{ok:boolean, text:string, error:string, route:string, httpStatus?:number}>}
 */
export async function chat(req) {
  const { system, user, api, jsonSchema, label = '请求' } = req || {};
  const route = api?.route === 'direct' ? 'direct' : 'st';
  const timeoutMs = Number(api?.timeoutMs) || 120000;

  // 先体检：配置不对就在这一侧给出人话，不去猜后端的英文报错
  const pre = preflight(api);
  if (!pre.ok) return { ok: false, text: '', error: `${label}失败：${pre.error}`, route };

  if (route === 'direct') {
    return chatDirect({ system, user, api, jsonSchema, label, timeoutMs });
  }
  return chatViaSt({ system, user, api, jsonSchema, label, timeoutMs });
}

async function chatViaSt({ system, user, api, jsonSchema, label, timeoutMs }) {
  const target = resolveStTarget(api);
  // Gemini 对 system role 的处理不一致，先按合并模式发，失败再换成标准 system 消息
  const modes = target.chat_completion_source === 'makersuite' ? ['merge', 'system'] : ['system', 'merge'];
  let lastError = '';

  for (const mode of modes) {
    const messages = buildMessages(system, user, mode);
    const body = buildStRequestBody(api, messages, { jsonSchema });
    let res;
    try {
      res = await fetchWithTimeout(
        '/api/backends/chat-completions/generate',
        {
          method: 'POST',
          headers: requestHeaders(),
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (e) {
      lastError = e?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : `网络错误：${e?.message || e}`;
      break; // 网络层错误换 mode 也没用
    }

    if (!res.ok) {
      lastError = humanizeBackendError(res.status, res.text);
      // 4xx 且提到 system，才值得换 mode 重试
      if (res.status >= 400 && res.status < 500 && /system|role|content/i.test(res.text) && mode === modes[0]) {
        continue;
      }
      break;
    }

    let text = res.text;
    if (looksLikeSse(text)) text = parseSse(text);
    else {
      try {
        text = extractText(JSON.parse(text));
      } catch {
        /* 后端直接回了纯文本，保持原样 */
      }
    }
    if (!String(text).trim()) {
      lastError = '酒馆后端返回了空内容（检查连接/模型名是否正确）';
      continue;
    }
    return { ok: true, text, error: '', route: 'st' };
  }

  return {
    ok: false,
    text: '',
    route: 'st',
    error: `${label}失败（路线：酒馆后端 / 源 ${target.chat_completion_source}${target.model ? ` / 模型 ${target.model}` : ''}）：${lastError}`,
  };
}

async function chatDirect({ system, user, api, jsonSchema, label, timeoutMs }) {
  const d = api?.direct || {};
  const base = String(d.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    return { ok: false, text: '', route: 'direct', error: `${label}失败：直连路线还没填 API 地址（面板 → 连接）` };
  }
  const model = String(d.model || api.model || '').trim();
  if (!model) {
    return { ok: false, text: '', route: 'direct', error: `${label}失败：直连路线还没填模型名（面板 → 连接）` };
  }

  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (d.apiKey) headers.Authorization = `Bearer ${d.apiKey}`;
  for (const line of String(d.extraHeaders || '').split(/\r?\n/)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].trim()] = m[2].trim();
  }

  const body = {
    model,
    messages: buildMessages(system, user, 'system'),
    temperature: Number.isFinite(api.temperature) ? api.temperature : 1.05,
    max_tokens: Number(api.maxTokens) || 2000,
    stream: false,
  };
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: jsonSchema.name || 'output',
        strict: jsonSchema.strict !== false,
        schema: jsonSchema.value,
      },
    };
  }

  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  } catch (e) {
    const hint =
      e?.name === 'TypeError'
        ? '（多半是跨域被拦：本地小模型端点一般要开 CORS，或改用"走酒馆后端"路线）'
        : '';
    return {
      ok: false,
      text: '',
      route: 'direct',
      error: `${label}失败：直连 ${url} 网络错误 ${e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e?.message || e}${hint}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      text: '',
      route: 'direct',
      httpStatus: res.status,
      error: `${label}失败：直连返回 ${res.status}：${truncate(res.text, 300)}`,
    };
  }

  let text = res.text;
  if (looksLikeSse(text)) text = parseSse(text);
  else {
    try {
      text = extractText(JSON.parse(text));
    } catch {
      /* 保持原样 */
    }
  }
  if (!String(text).trim()) {
    return { ok: false, text: '', route: 'direct', error: `${label}失败：直连返回空内容` };
  }
  return { ok: true, text, error: '', route: 'direct' };
}

/**
 * 发一次请求并要求 JSON 结果。
 *
 * 结构化输出（json_schema / response_format）不是所有端点都支持 ——
 * 第三方 OpenAI 兼容端点尤其常见：带了就直接 400「Invalid data: Request contains
 * an invalid argument」，而且不给任何降级机会。实测踩到过，所以这里做**自动降级**：
 * 一旦判定失败与结构化输出有关，就去掉它重试一次，改用纯文本 + 宽松解析。
 */
export async function chatJson(req) {
  const wantSchema = req?.api?.useJsonSchema !== false && !!req?.jsonSchema;

  const attempt = async (withSchema) => {
    const res = await chat({ ...req, jsonSchema: withSchema ? req.jsonSchema : undefined });
    if (!res.ok) return { ...res, value: null };
    const parsed = parseJsonLoose(res.text);
    if (!parsed.ok) {
      return { ...res, value: null, error: `${req?.label || '请求'}：${parsed.error}｜原文开头：${truncate(parsed.raw, 200)}` };
    }
    return { ...res, value: parsed.value, error: '' };
  };

  let out = await attempt(wantSchema);

  if (!out.ok && wantSchema && isSchemaRejection(out.error)) {
    const retry = await attempt(false);
    if (retry.ok) {
      return {
        ...retry,
        schemaFallback: true,
        note: '这个端点不支持结构化输出，已自动改用纯文本模式重试并成功。若经常这样，可在「连接」页关掉「结构化输出」。',
      };
    }
    return {
      ...retry,
      error: `${out.error}\n（已尝试去掉结构化输出重试，仍然失败：${retry.error}）`,
    };
  }

  return out;
}

/** 判断失败是不是"端点不支持结构化输出"造成的 */
export function isSchemaRejection(error) {
  const t = String(error || '').toLowerCase();
  return (
    /invalid data|invalid argument|request contains an invalid/.test(t) ||
    /response_format|json_schema|json schema|structured/.test(t) ||
    /unsupported|not support/.test(t)
  );
}

/** 拉模型列表（走酒馆后端） */
export async function fetchModelList(api) {
  const target = resolveStTarget(api);
  const body = {
    chat_completion_source: target.chat_completion_source,
    model: target.model,
  };
  if (target.reverse_proxy) body.reverse_proxy = target.reverse_proxy;
  try {
    const res = await fetchWithTimeout(
      '/api/backends/chat-completions/status',
      { method: 'POST', headers: requestHeaders(), body: JSON.stringify(body) },
      30000,
    );
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const data = JSON.parse(res.text);
    const models = []
      .concat(data?.data || [], data?.models || [])
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || ''))
      .filter(Boolean);
    return { ok: true, models, error: '' };
  } catch (e) {
    return { ok: false, models: [], error: e?.message || String(e) };
  }
}

/* ───────────── 小工具 ───────────── */

/**
 * 把酒馆后端返回的英文报错翻译成能直接照做的提示。
 * 后端有些报错是"配置没填对"，原文对用户几乎没有可操作性。
 */
export function humanizeBackendError(status, text) {
  const raw = String(text || '');
  const low = raw.toLowerCase();

  if (low.includes('custom endpoint is missing') || low.includes('configure custom_url')) {
    return '当前用的是「自定义端点（custom）」但酒馆里没配这个地址 —— 把「AI 来源」改成「自动跟随酒馆当前连接」，或到酒馆的聊天补全设置里填好自定义端点。';
  }
  if (low.includes('no api key') || low.includes('api key is required') || low.includes('missing api key')) {
    return '这个来源没有可用的 API Key —— 到酒馆的「聊天补全」里配好，或把「AI 来源」换成已经配好的那个。';
  }
  if (status === 401 || status === 403) {
    return `认证失败（${status}）—— 检查酒馆里这个来源的 API Key 是否有效。`;
  }
  if (status === 404) {
    return `接口不存在（404）—— 多半是模型名或地址填错了。`;
  }
  if (status === 429) {
    return '被限流了（429）—— 等一会儿再试，或换个来源/模型。';
  }
  if (status >= 500) {
    return `服务端错误（${status}）—— 通常是上游服务的问题，稍后重试。`;
  }
  return `酒馆后端返回 ${status}：${truncate(raw, 160)}`;
}

export function truncate(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return `${str.slice(0, n)}…（共 ${str.length} 字）`;
}

/** 估算字数（中文按字符数，够用了；不引入分词器，避免版本差异） */
export function estimateChars(s) {
  return String(s ?? '').length;
}
