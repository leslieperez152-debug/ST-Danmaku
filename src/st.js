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

/** 当前角色卡 id（换卡检测用）。拿不到时返回空串。 */
export function getCurrentCharacterId() {
  const ctx = getCtx();
  try {
    if (!ctx) return '';
    const id = ctx.characterId ?? ctx.this_chid;
    return id === undefined || id === null ? '' : String(id);
  } catch {
    return '';
  }
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

/**
 * 世界书清单缓存。
 *
 * 坑点：酒馆的 `getContext()` **并不暴露世界书名数组** —— 它只给了
 * `updateWorldInfoList()`（刷新列表）和 `loadWorldInfo(name)`（按名读）。
 * 真正的 `world_names` 数组是 `world-info.js` 的模块内部变量。
 * 所以这里做多层兜底，依次尝试：
 *   ① ctx.getWorldInfoNames()      某些版本/客户端暴露了这个函数
 *   ② 动态 import 酒馆的 world-info.js，读它导出的 world_names
 *   ③ /api/worldinfo/list          服务端直接列目录，最可靠但需要联网请求
 *   ④ ctx 上各种可能的字段名        旧版本兼容
 */
let bookCache = []; // [{ name, fileId }]
let bookCacheAt = 0;
const BOOK_CACHE_MS = 15000; // 15 秒内不重复问，避免频繁请求

/** 已有的世界书清单（同步，供 UI 直接用；没数据时为空数组） */
export function listWorldbookEntries() {
  return bookCache.slice();
}

/** 只要名字（UI 显示与日志用） */
export function listWorldbookNames() {
  const names = bookCache.map((b) => b.name).filter(Boolean);
  if (names.length) return [...new Set(names)];

  // 兜底：上下文里可能直接有数组（旧版本 / 某些客户端）
  const ctx = getCtx();
  try {
    const list = ctx?.worldInfoList || ctx?.world_info_list || ctx?.world_names || ctx?.worldNames || [];
    if (Array.isArray(list)) {
      const out = list
        .map((n) => (typeof n === 'string' ? n : n?.name || n?.file_id))
        .filter(Boolean)
        .map(String);
      return [...new Set(out)];
    }
  } catch {
    /* noop */
  }
  return [];
}

/** 名字 → 文件名（loadWorldInfo 要的是文件名） */
export function resolveWorldbookFileId(name) {
  const hit = bookCache.find((b) => b.name === name);
  return hit?.fileId || name;
}

async function fetchWorldbookListViaApi() {
  try {
    const res = await fetch('/api/worldinfo/list', { method: 'POST', headers: requestHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data
      .map((it) => ({
        name: String(it?.name || it?.file_id || '').trim(),
        fileId: String(it?.file_id || it?.name || '').trim(),
      }))
      .filter((it) => it.name);
  } catch {
    return null;
  }
}

/**
 * 从所有角色卡的绑定里收集世界书名。
 *
 * 为什么需要这一路：某些客户端（TauriTavern）的原生界面用 IPC 调后端取世界书列表，
 * 前端不一定有 `/api/worldinfo/list` 这个 HTTP 路由，`world_names` 也拿不到。
 * 但"卡绑定了哪本世界书"是**确实能读到**的（进一张卡就能看到它的绑定），
 * 所以从卡上收集是一个不依赖任何接口的兜底。
 */
export function collectWorldbooksFromCharacters() {
  const ctx = getCtx();
  const out = [];
  const push = (n) => {
    const name = String(n || '').trim();
    if (name && !out.some((x) => x.name === name)) out.push({ name, fileId: name });
  };
  try {
    const chars = ctx?.characters || ctx?.getCharacters?.();
    const list = Array.isArray(chars) ? chars : Object.values(chars || {});
    for (const ch of list) {
      if (!ch || typeof ch !== 'object') continue;
      // 卡绑定的主世界书
      push(ch?.data?.extensions?.world);
      // 卡自带的世界书（内嵌 character_book）
      push(ch?.data?.character_book?.name);
      push(ch?.world);
      // 有些客户端把附加世界书也塞在卡上
      const extra = ch?.data?.extensions?.world_info || ch?.data?.extensions?.additional_worlds;
      if (Array.isArray(extra)) extra.forEach(push);
      else if (typeof extra === 'string') push(extra);
    }
  } catch {
    /* noop */
  }
  return out;
}

/**
 * 拿不到清单时的"验证式枚举"：对若干候选名字逐个试 `loadWorldInfo`，
 * 能读出来的就是真实存在的世界书。
 */
async function probeWorldbookNames(candidates) {
  const ctx = getCtx();
  if (!ctx || typeof ctx.loadWorldInfo !== 'function') return [];
  const ok = [];
  for (const name of candidates) {
    try {
      const raw = await ctx.loadWorldInfo(name);
      if (raw) ok.push({ name: String(name), fileId: String(name) });
    } catch {
      /* 读不出来就算了 */
    }
  }
  return ok;
}

/**
 * 诊断：把每一条获取途径都试一遍，报告各自的结果。
 * 在客户端上拿不到控制台时，这是唯一能让用户把实情告诉我的办法。
 */
export async function diagnoseWorldbookSources() {
  const ctx = getCtx();
  const rows = [];
  const record = (label, outcome) => rows.push({ label, outcome });

  record('getContext() 是否可用', ctx ? '✅ 可用' : '❌ 拿不到 context');
  record('loadWorldInfo() 是否存在', typeof ctx?.loadWorldInfo === 'function' ? '✅ 存在' : '❌ 不存在');
  record('updateWorldInfoList() 是否存在', typeof ctx?.updateWorldInfoList === 'function' ? '✅ 存在' : '❌ 不存在');
  record('getWorldInfoNames() 是否存在', typeof ctx?.getWorldInfoNames === 'function' ? '✅ 存在' : '❌ 不存在（多数版本没有）');

  // updateWorldInfoList 跑一次，看有没有副作用
  try {
    if (ctx && typeof ctx.updateWorldInfoList === 'function') {
      await ctx.updateWorldInfoList();
      record('调用 updateWorldInfoList()', '✅ 调用成功（无返回值的可能性很大）');
    }
  } catch (e) {
    record('调用 updateWorldInfoList()', `❌ 抛错：${e?.message || e}`);
  }

  // 官方函数
  try {
    if (ctx && typeof ctx.getWorldInfoNames === 'function') {
      const names = ctx.getWorldInfoNames();
      record('getWorldInfoNames() 返回', Array.isArray(names) ? `${names.length} 本：${names.slice(0, 5).join('、')}` : `非数组：${typeof names}`);
    }
  } catch (e) {
    record('getWorldInfoNames() 抛错', String(e?.message || e));
  }

  // 动态 import
  for (const path of ['/scripts/world-info.js', './world-info.js', '../../world-info.js']) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      const names = mod?.world_names;
      record(`import ${path}`, Array.isArray(names) ? `✅ 拿到 ${names.length} 本` : '⚠️ 能导入但没有 world_names');
      break;
    } catch (e) {
      record(`import ${path}`, `❌ ${String(e?.message || e).slice(0, 60)}`);
    }
  }

  // ctx 上的数组字段
  const fields = ['worldInfoList', 'world_info_list', 'world_names', 'worldNames'];
  const found = fields.filter((f) => Array.isArray(ctx?.[f]) && ctx[f].length);
  record('ctx 上的数组字段', found.length ? `✅ 有：${found.join(', ')}` : `❌ 都没有（试过 ${fields.join(', ')}）`);

  // HTTP 接口
  try {
    const res = await fetch('/api/worldinfo/list', { method: 'POST', headers: requestHeaders() });
    if (!res.ok) {
      record('POST /api/worldinfo/list', `❌ HTTP ${res.status}`);
    } else {
      const data = await res.json();
      record('POST /api/worldinfo/list', Array.isArray(data) ? `✅ 返回 ${data.length} 本` : `⚠️ 返回的不是数组：${typeof data}`);
    }
  } catch (e) {
    record('POST /api/worldinfo/list', `❌ 请求失败：${String(e?.message || e).slice(0, 60)}`);
  }

  // 从角色卡收集
  const fromCards = collectWorldbooksFromCharacters();
  record('从角色卡绑定收集', fromCards.length ? `✅ 收集到 ${fromCards.length} 本` : '❌ 一本都没收集到');

  // 验证式枚举
  if (fromCards.length) {
    const probed = await probeWorldbookNames(fromCards.map((b) => b.name));
    record('逐个试读这些名字', `✅ ${probed.length}/${fromCards.length} 本可读`);
  }

  record('最终清单', bookCache.length ? `${bookCache.length} 本` : '0 本（列表会是空的）');
  return rows;
}

/**
 * 刷新世界书清单。进卡、打开面板、扫描前都可以调。
 * @param {boolean} [force] 忽略缓存强制刷新
 * @returns {Promise<object[]>} 最新的 [{name, fileId}]
 */
export async function refreshWorldbookNames(force = false) {
  if (!force && Date.now() - bookCacheAt < BOOK_CACHE_MS && bookCache.length) return listWorldbookEntries();

  const ctx = getCtx();
  let entries = null;

  // 先让酒馆自己把列表读起来（有些情况下它还没初始化）
  try {
    if (ctx && typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList();
  } catch {
    /* noop */
  }

  // ① 官方函数
  try {
    if (ctx && typeof ctx.getWorldInfoNames === 'function') {
      const names = ctx.getWorldInfoNames();
      if (Array.isArray(names) && names.length) {
        entries = names.map((n) => ({ name: String(n), fileId: String(n) }));
      }
    }
  } catch {
    /* noop */
  }

  // ② 动态 import 酒馆的世界书模块
  if (!entries) {
    for (const path of ['/scripts/world-info.js', './world-info.js', '../../world-info.js']) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        const names = mod?.world_names;
        if (Array.isArray(names) && names.length) {
          entries = names.map((n) => ({ name: String(n), fileId: String(n) }));
          break;
        }
      } catch {
        /* 换下一条路径 */
      }
    }
  }

  // ③ 服务端列目录（ST 上是标准路由；某些客户端可能没有）
  if (!entries) entries = await fetchWorldbookListViaApi();

  // ④ 从角色卡绑定收集（不依赖任何接口，客户端上实测最稳）
  if (!entries || !entries.length) {
    const fromCards = collectWorldbooksFromCharacters();
    if (fromCards.length) {
      // 收集到的名字再用 loadWorldInfo 验一遍，确保是真能读的书
      const probed = await probeWorldbookNames(fromCards.map((b) => b.name));
      entries = probed.length ? probed : fromCards;
    }
  }

  // ⑤ ctx 上旧版本的数组字段
  if (!entries || !entries.length) {
    try {
      const list = ctx?.worldInfoList || ctx?.world_info_list || ctx?.world_names || ctx?.worldNames || [];
      if (Array.isArray(list) && list.length) {
        entries = list
          .map((n) => (typeof n === 'string' ? { name: n, fileId: n } : { name: String(n?.name || n?.file_id || ''), fileId: String(n?.file_id || n?.name || '') }))
          .filter((e) => e.name);
      }
    } catch {
      /* noop */
    }
  }

  if (entries && entries.length) {
    bookCache = entries;
    bookCacheAt = Date.now();
  } else if (entries) {
    // 真的确认是空（比如确实一本都没有）才清空
    bookCache = [];
    bookCacheAt = Date.now();
  }
  // entries 为 null（全部途径都失败）时保留旧缓存，不清空
  return listWorldbookEntries();
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
    // 清单还没拿到时不做过滤，避免"一本都读不到"这种静默失败
    const available = new Set(listWorldbookNames());
    if (!available.size) return sources.map(String);
    return sources.map(String).filter((n) => available.has(n));
  }
  const bound = getBoundWorldbooks();
  const set = new Set();
  if (bound.primary) set.add(bound.primary);
  bound.additional.forEach((n) => set.add(n));
  return [...set];
}

/**
 * 读一本世界书，归一化成插件内部的条目结构。
 * 名字和文件名都试一遍 —— 不同来源给的可能是显示名，也可能是文件 basename。
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

  const fileId = resolveWorldbookFileId(name);
  const tries = fileId && fileId !== name ? [name, fileId] : [name];
  let lastError = '';

  for (const key of tries) {
    try {
      const raw = await ctx.loadWorldInfo(key);
      if (!raw) {
        lastError = '世界书不存在或为空';
        continue;
      }
      result.entries = normalizeEntries(raw);
      result.ok = true;
      result.error = '';
      return result;
    } catch (e) {
      lastError = e?.message ? String(e.message) : String(e);
    }
  }

  result.error = lastError || '读取失败';
  return result;
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
