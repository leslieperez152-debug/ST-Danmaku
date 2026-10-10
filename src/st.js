/**
 * st.js — 酒馆接入层
 *
 * 全部走酒馆自带的接口，不依赖任何第三方扩展：
 *   SillyTavern.getContext()        —— 上下文、事件、请求头、提示词注入
 *   context.loadWorldInfo(name)     —— 读世界书
 *   /api/backends/chat-completions/*—— 走酒馆后端发请求（能用酒馆里已存的 key）
 *
 * 这一层刻意写得"防弹"：任何拿不到的 API 都退化处理，不让插件把酒馆搞崩。
 */

/** 本插件的注入标签（直播模式的唯一注入点） */
export const INJECT_TAG = 'ST_DANMAKU_LIVE_NOTE';

/* ───────────── 基础取用 ───────────── */

export function getCtx() {
  try {
    if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
      return SillyTavern.getContext();
    }
  } catch {
    /* noop */
  }
  return null;
}

export function getEventSource() {
  const ctx = getCtx();
  return ctx?.eventSource || null;
}

export function getEventTypes() {
  const ctx = getCtx();
  return ctx?.eventTypes || ctx?.event_types || null;
}

/** 统一请求头（含 CSRF），拿不到时退回手搓的等价物 */
export function requestHeaders(omitContentType = false) {
  const ctx = getCtx();
  try {
    if (ctx && typeof ctx.getRequestHeaders === 'function') {
      return ctx.getRequestHeaders({ omitContentType });
    }
  } catch {
    /* noop */
  }
  const headers = {};
  try {
    const token = typeof document !== 'undefined' ? document.querySelector('meta[name="csrf-token"]')?.content : '';
    if (token) headers['X-CSRF-Token'] = token;
  } catch {
    /* noop */
  }
  if (!omitContentType) headers['Content-Type'] = 'application/json';
  return headers;
}

export function getToastr() {
  try {
    if (typeof toastr !== 'undefined') return toastr;
  } catch {
    /* noop */
  }
  return null;
}

export function toast(message, type = 'info') {
  const t = getToastr();
  if (t && typeof t[type] === 'function') {
    try {
      t[type](String(message));
      return;
    } catch {
      /* noop */
    }
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`[弹幕直播间] ${message}`);
  } catch {
    /* noop */
  }
}

/* ───────────── 聊天 / 角色信息 ───────────── */

export function getCurrentCharacter() {
  const ctx = getCtx();
  try {
    if (!ctx) return null;
    const id = ctx.characterId ?? ctx.this_chid;
    const list = ctx.characters || [];
    if (id === undefined || id === null || id === '') return null;
    return list[id] || list[Number(id)] || null;
  } catch {
    return null;
  }
}

/** 卡名（世界书绑定要靠它）。群聊 / 无卡时返回空串。 */
export function getCardName() {
  const ch = getCurrentCharacter();
  if (!ch) return '';
  return String(ch.name || '').trim();
}

/** 当前聊天文件名，用作档案缓存的键之一 */
export function getChatId() {
  const ctx = getCtx();
  try {
    if (!ctx) return '';
    const meta = ctx.chatMetadata || ctx.chat_metadata;
    if (meta && typeof meta === 'object') {
      return String(meta.file_name || meta.chat_id || meta.chat_metadata?.file_name || '').trim();
    }
  } catch {
    /* noop */
  }
  return '';
}

/**
 * 取聊天消息。优先用酒馆自己的 chat 数组；数量不足时不做任何补全。
 * @returns {{id:number, name:string, role:string, text:string, isUser:boolean, isSystem:boolean}[]}
 */
export function getMessages() {
  const ctx = getCtx();
  const out = [];
  try {
    if (ctx && Array.isArray(ctx.chat)) {
      ctx.chat.forEach((m, i) => {
        if (!m || typeof m !== 'object') return;
        out.push({
          id: Number.isFinite(m.__std_id) ? m.__std_id : i,
          name: String(m.name || ''),
          role: String(m.is_user ? 'user' : m.is_system ? 'system' : 'assistant'),
          text: String(m.mes ?? m.message ?? ''),
          isUser: !!m.is_user,
          isSystem: !!m.is_system,
        });
      });
    }
  } catch {
    /* noop */
  }
  return out;
}

/** 取最近 n 条"角色/AI"消息的文本（弹幕的剧情来源） */
export function getRecentStory(n) {
  const count = Math.max(0, Math.floor(n) || 0);
  if (!count) return [];
  const msgs = getMessages().filter((m) => !m.isSystem && m.text.trim());
  return msgs.slice(-count);
}

/* ───────────── 世界书 ───────────── */

/** 列出所有世界书名（按需去重） */
export function listWorldbookNames() {
  const names = new Set();
  const ctx = getCtx();
  try {
    const list = ctx?.worldInfoList || ctx?.world_info_list || ctx?.world_names || [];
    if (Array.isArray(list)) {
      list.forEach((n) => {
        const name = typeof n === 'string' ? n : n?.name;
        if (name) names.add(String(name));
      });
    }
  } catch {
    /* noop */
  }
  // 全局开启的世界书（有些版本挂在 extensionSettings 上）
  try {
    const settings = ctx?.extensionSettings || ctx?.extension_settings;
    const globalBooks = settings?.world_info?.world_info;
    if (Array.isArray(globalBooks)) globalBooks.forEach((n) => n && names.add(String(n)));
  } catch {
    /* noop */
  }
  return [...names];
}

/** 当前卡绑定的世界书：{ primary, additional } */
export function getBoundWorldbooks() {
  const ctx = getCtx();
  const out = { primary: '', additional: [] };
  const ch = getCurrentCharacter();
  try {
    const book = ch?.data?.extensions?.world || ch?.data?.character_book?.name || ch?.world || '';
    if (book) out.primary = String(book);
    const extra = ctx?.extensionSettings?.world_info?.world_info;
    if (Array.isArray(extra)) out.additional = extra.map(String).filter(Boolean);
  } catch {
    /* noop */
  }
  return out;
}

/**
 * 决定这次要读哪些世界书。
 * 规则（不做任何卡专属假设）：
 *   sources 显式给了 → 只读这些
 *   否则 → 当前卡绑定的主世界书 + 全局开启的 + 世界书列表里"名字被卡绑过"的
 * 读不到任何书是合法状态：此时档案会标注 hasWorldbook=false，转为"看正文学"。
 */
export function resolveWorldbookNames(sources) {
  if (Array.isArray(sources) && sources.length) {
    const available = new Set(listWorldbookNames());
    return sources.map(String).filter((n) => !available.size || available.has(n));
  }
  const bound = getBoundWorldbooks();
  const set = new Set();
  if (bound.primary) set.add(bound.primary);
  bound.additional.forEach((n) => set.add(n));
  return [...set];
}

/**
 * 读一本世界书，归一化成插件内部的条目结构。
 * @param {string} name
 * @returns {Promise<{name:string, ok:boolean, error:string, entries:object[]}>}
 */
export async function readWorldbook(name) {
  const ctx = getCtx();
  const result = { name, ok: false, error: '', entries: [] };
  if (!ctx || typeof ctx.loadWorldInfo !== 'function') {
    result.error = '当前酒馆没有暴露 loadWorldInfo()，无法读取世界书';
    return result;
  }
  try {
    const raw = await ctx.loadWorldInfo(name);
    if (!raw) {
      result.error = '世界书不存在或为空';
      return result;
    }
    result.entries = normalizeEntries(raw);
    result.ok = true;
    return result;
  } catch (e) {
    result.error = e?.message ? String(e.message) : String(e);
    return result;
  }
}

/** 兼容 entries 是对象（uid→entry）或数组（老版本）两种形态 */
export function normalizeEntries(raw) {
  const list = [];
  const src = raw?.entries ?? raw;
  const push = (key, entry) => {
    if (!entry || typeof entry !== 'object') return;
    const content = String(entry.content ?? '');
    const comment = String(entry.comment ?? entry.name ?? '');
    const keys = []
      .concat(entry.key ?? entry.keys ?? [])
      .map((k) => (k instanceof RegExp ? String(k.source) : String(k || '')))
      .filter(Boolean);
    const secondary = []
      .concat(entry.keysecondary ?? entry.secondary_keys ?? [])
      .map((k) => (k instanceof RegExp ? String(k.source) : String(k || '')))
      .filter(Boolean);
    list.push({
      uid: entry.uid ?? key,
      comment,
      content,
      keys,
      secondaryKeys: secondary,
      constant: !!entry.constant,
      selective: !!entry.selective,
      disabled: entry.disable === true || entry.enabled === false,
      order: Number.isFinite(entry.order) ? Number(entry.order) : 100,
      position: entry.position ?? 0,
      depth: Number.isFinite(entry.depth) ? Number(entry.depth) : 4,
      chars: content.length,
    });
  };

  if (Array.isArray(src)) {
    src.forEach((e, i) => push(i, e));
  } else if (src && typeof src === 'object') {
    for (const k of Object.keys(src)) push(k, src[k]);
  }
  return list;
}

/* ───────────── 注入（直播模式） ───────────── */

/**
 * 写一条扩展注入。这是插件伸向正文的唯一通道：
 *   · position = 1 (IN_CHAT)，插在对话历史里而不是提示词开头；
 *   · scan = false，不被世界书扫描；
 *   · 只存在于内存，不写进聊天文件。
 * @returns {boolean} 是否成功
 */
export function setLiveInjection(text, depth = 4) {
  const ctx = getCtx();
  const value = String(text || '');
  // 清空时用极深的位置，等价于不注入
  const pos = value ? 1 : 0;
  const d = value ? Math.max(0, Math.floor(depth)) : 0;
  try {
    if (ctx && typeof ctx.setExtensionPrompt === 'function') {
      ctx.setExtensionPrompt(INJECT_TAG, value, pos, d, false, 0);
      return true;
    }
  } catch {
    /* 落到下一路 */
  }
  try {
    // 有些版本把 setExtensionPrompt 挂在扩展全局而不是 context 上
    if (typeof setExtensionPrompt === 'function') {
      // eslint-disable-next-line no-undef
      setExtensionPrompt(INJECT_TAG, value, pos, d, false, 0);
      return true;
    }
  } catch {
    /* noop */
  }
  return false;
}

export function clearLiveInjection() {
  return setLiveInjection('', 0);
}

/* ───────────── 事件 ───────────── */

/**
 * 订阅酒馆事件，事件名在运行时解析，任何名字取不到就静默跳过。
 * @param {string[]} names 事件常量名，如 ['MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED']
 * @param {(payload:any, eventName:string) => void} handler
 * @returns {() => void} 取消订阅
 */
export function onEvents(names, handler) {
  const es = getEventSource();
  const types = getEventTypes();
  const offs = [];
  if (!es || !types || typeof es.on !== 'function') return () => {};
  for (const n of names) {
    const evt = types[n];
    if (!evt) continue;
    const wrapped = (...args) => {
      try {
        handler(args.length <= 1 ? args[0] : args, n);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[弹幕直播间] 事件处理异常', n, e);
      }
    };
    try {
      es.on(evt, wrapped);
      offs.push(() => {
        try {
          es.removeListener?.(evt, wrapped);
        } catch {
          /* noop */
        }
      });
    } catch {
      /* noop */
    }
  }
  return () => offs.forEach((f) => f());
}

/** 主动触发一次事件（用于让正文重新生成时带上/去掉注入） */
export function emitEvent(name, ...args) {
  const es = getEventSource();
  const types = getEventTypes();
  const evt = types?.[name];
  if (!es || !evt) return false;
  try {
    es.emit(evt, ...args);
    return true;
  } catch {
    return false;
  }
}

/* ───────────── 当前连接信息（给"跟随酒馆当前连接"用） ───────────── */

export function getCurrentConnection() {
  const ctx = getCtx();
  try {
    const s = ctx?.chatCompletionSettings || ctx?.oai_settings || null;
    if (!s) return null;
    return {
      source: String(s.chat_completion_source || ''),
      model: String(s.custom_model || s.openai_model || s.claude_model || ''),
      reverseProxy: String(s.reverse_proxy || ''),
      proxyPassword: String(s.proxy_password || ''),
      customUrl: String(s.custom_url || ''),
    };
  } catch {
    return null;
  }
}
