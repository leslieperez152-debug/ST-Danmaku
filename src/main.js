/**
 * main.js — 总装
 *
 * 负责把"取数 → 生成 → 渲染 → 注入 → 事件调度"串起来，并对面板暴露一套 API。
 *
 * 两条数据流（刻意分开）：
 *
 *   正文 → 弹幕      单向。弹幕读最近几轮正文，所以贴着剧情走。
 *   弹幕 → 正文      默认完全没有。只有"直播模式"打开时，才用一条极短的
 *                    扩展注入（setExtensionPrompt，不落盘、不被世界书扫描）告诉角色"有人在直播"。
 *
 * 因此：开不开弹幕，正文那一轮的提示词长度不变。
 */

import {
  loadSettings,
  saveSettings,
  normalizeSettings,
  loadRuntime,
  saveRuntime,
  pushHistory,
  createRuntime,
  getCachedProfile,
  putCachedProfile,
  clearProfileCache,
  profileKey,
  emptyProfile,
} from './store.js';
import {
  getCtx,
  getCardName,
  getCurrentCharacterId,
  getChatId,
  getRecentStory,
  resolveWorldbookNames,
  listWorldbookNames,
  getBoundWorldbooks,
  getCurrentConnection,
  setLiveInjection,
  clearLiveInjection,
  onEvents,
  toast,
} from './st.js';
import { scanWorldbooks, estimateScanCost } from './scan.js';
import { generateBatch, buildViewerPool, buildStoryContext, pickGags } from './danmaku.js';
import { chat, chatJson, fetchModelList, resolveStTarget } from './llm.js';
import { buildPalette, sampleBackgroundLuminance, sampleBackground, shade } from './color.js';
import {
  createFrame,
  playFrame,
  mountFrame,
  clearAllFrames,
  clearFrameAt,
  resolveHostAnchor,
  demoSample,
  stopFrame,
  countFrames,
} from './frame.js';
import {
  ensureOverlay,
  applyRect,
  readRect,
  applyOverlayStyle,
  showOverlay,
  playOverlay,
  stopOverlay,
  destroyOverlay,
  enableInteractions,
  isOverlayVisible,
} from './overlay.js';

/** 把一批弹幕按消息归位：同一楼只留最新一批（重 roll 时不叠框），但历史照留 */
const MAX_BATCHES_PER_MESSAGE_KEPT = 12;

export function createApp({ storage = globalThis.localStorage, doc = globalThis.document, win = globalThis } = {}) {
  const state = {
    storage,
    doc,
    win,
    settings: loadSettings(storage),
    runtime: loadRuntime(storage),
    profile: null,
    luminance: 0.2,
    busy: false,
    lastError: '',
    lastCost: null,
    offEvents: [],
    offOverlay: null,
    frames: new Map(), // messageId -> frame 对象
    cardSig: '', // 当前卡+聊天签名（换卡检测用）
    initialized: false,
  };

  /* ───────────── 生命周期 ───────────── */

  function init() {
    if (state.initialized) return api;
    state.initialized = true;

    try {
      state.luminance = sampleBackgroundLuminance(doc, win);
    } catch {
      state.luminance = 0.2;
    }

    state.profile = loadCurrentProfile();
    state.cardSig = cardSignature();

    ensureOverlay(doc);
    applyOverlayStyle(doc, state.settings.appearance);
    // 先给一个默认矩形，避免用户还没拖过时层是 0×0 而看不见
    applyRect(doc, state.settings.appearance.overlayRect);
    showOverlay(doc, state.settings.appearance.overlayEnabled);
    state.offOverlay = enableInteractions(doc, (rect) => {
      if (rect === null) {
        // 用户点了 ✕：把开关也一起关掉，避免界面与设置不一致
        state.settings.appearance.overlayEnabled = false;
      } else if (rect) {
        state.settings.appearance.overlayRect = rect;
      }
      persistSettings();
      api.emit('settings', state.settings);
    });

    bindEvents();
    return api;
  }

  function destroy() {
    state.offEvents.forEach((f) => f());
    state.offEvents = [];
    if (state.offOverlay) state.offOverlay();
    state.frames.forEach((f) => stopFrame(f));
    state.frames.clear();
    clearAllFrames(doc);
    clearLiveInjection();
    destroyOverlay(doc);
    state.initialized = false;
  }

  function bindEvents() {
    state.offEvents.push(
      onEvents(['CHARACTER_MESSAGE_RENDERED'], (payload) => {
        const id = Array.isArray(payload) ? payload[0] : payload;
        onAssistantMessage(Number.isFinite(Number(id)) ? Number(id) : undefined);
      }),
    );
    state.offEvents.push(
      onEvents(['MESSAGE_RECEIVED'], (payload) => {
        const id = Array.isArray(payload) ? payload[0] : payload;
        onAssistantMessage(Number.isFinite(Number(id)) ? Number(id) : undefined);
      }),
    );
    // 进卡 / 换卡：这两类事件都会到，靠卡签名去重
    state.offEvents.push(onEvents(['CHAT_CHANGED'], () => onChatChanged()));
    state.offEvents.push(onEvents(['CHARACTER_PAGE_LOADED', 'CHARACTER_EDITED', 'CHARACTER_RENAMED'], () => onCardMaybeChanged()));
    state.offEvents.push(
      onEvents(['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED'], (payload) => {
        const id = Array.isArray(payload) ? payload[0] : payload;
        const mid = Number.isFinite(Number(id)) ? Number(id) : undefined;
        // 楼层被重写/换 swipe：把它上面那块旧弹幕收起，避免和新正文对不上
        if (mid !== undefined) {
          clearFrameAt(doc, mid);
          state.frames.delete(mid);
        }
      }),
    );
  }

  /** 当前卡 + 聊天的签名，用来判断"是不是真的换了一张卡" */
  function cardSignature() {
    const ch = getCurrentCharacterId();
    return `${ch}::${getCardName()}::${getChatId()}`;
  }

  function purgeVisuals() {
    clearAllFrames(doc);
    state.frames.forEach((f) => stopFrame(f));
    state.frames.clear();
    stopOverlay(doc);
    clearLiveInjection();
  }

  function onChatChanged() {
    purgeVisuals();
    state.runtime = loadRuntime(storage);
    state.profile = loadCurrentProfile();
    state.cardSig = cardSignature();
    // 换聊天时，名册属于上一张卡就作废
    if (state.runtime.viewersCardName && state.runtime.viewersCardName !== getCardName()) {
      state.runtime.viewers = [];
      state.runtime.viewersProfileKey = '';
      state.runtime.viewersCardName = '';
      persistRuntime();
    }
    api.emit('chat');
  }

  /**
   * 进卡 / 换卡的处理。
   *
   * 这是"进一张卡就自动抓那张卡绑定的世界书"的落点：
   *   · 自动模式下世界书本来就是按当前卡绑定的现算的，所以换卡即换书；
   *   · 但用户手动勾过世界书时，勾选会被记住 —— 那套书是上一张卡的，
   *     带到新卡上就是串味。所以换卡时把手动勾选清掉、退回自动跟随。
   *   · 档案按「卡|聊天|世界书」缓存，换回以前扫过的卡会直接命中缓存，不用重扫。
   */
  function onCardMaybeChanged() {
    const sig = cardSignature();
    if (sig === state.cardSig) return;
    const prevCard = state.cardSig ? state.cardSig.split('::')[1] : '';
    const nextCard = getCardName();

    purgeVisuals();
    state.cardSig = sig;

    if (state.settings.scan.followCard && state.settings.scan.sources !== null) {
      state.settings.scan.sources = null;
      persistSettings();
    }

    state.profile = loadCurrentProfile();
    state.runtime = loadRuntime(storage);

    // 观众名册是按上一张卡的世界观起的，换卡必须重做
    if (state.runtime.viewersCardName && state.runtime.viewersCardName !== nextCard) {
      state.runtime.viewers = [];
      state.runtime.viewersProfileKey = '';
      state.runtime.viewersCardName = '';
      persistRuntime();
    }

    const books = resolveWorldbookNames(state.settings.scan.sources);
    api.emit('card', { prevCard, nextCard, books, profile: state.profile });
    logLine(
      state.profile
        ? `已切到《${nextCard || '无卡'}》：用回已缓存的观众档案（世界书 ${books.length} 本）`
        : `已切到《${nextCard || '无卡'}》：世界书 ${books.length} 本，还没扫描过这张卡的档案`,
      'info',
    );
  }

  /* ───────────── 档案 ───────────── */

  function currentProfileKey() {
    const names = resolveWorldbookNames(state.settings.scan.sources);
    return profileKey(getCardName(), getChatId(), names.slice().sort().join(','));
  }

  function loadCurrentProfile() {
    const cached = getCachedProfile(storage, currentProfileKey());
    return cached || null;
  }

  /* ───────────── 生成一批 ───────────── */

  /** 从最近正文里裁出给弹幕看的"正在直播的内容" */
  function collectStory() {
    const take = state.settings.contextRounds > 0 ? 12 : 0;
    let msgs = getRecentStory(take);
    // 开场白只是卡的自我介绍，谈不上"正在发生什么"：默认把它排除在剧情来源外
    if (state.settings.skipOpening && msgs.some((m) => m.id === 0)) {
      msgs = msgs.filter((m) => m.id !== 0);
    }
    return buildStoryContext(msgs, {
      rounds: state.settings.contextRounds,
      charBudget: state.settings.contextCharBudget,
    });
  }

  /**
   * 出一批弹幕并渲染。
   * @param {object} [opts]
   * @param {number} [opts.messageId] 挂到哪一楼（不传则挂在最后一楼）
   * @param {boolean} [opts.manual]   是否用户手动点的
   * @param {boolean} [opts.dryRun]   只生成不渲染（测试用）
   */
  async function runBatch(opts = {}) {
    if (!state.settings.enabled) return { ok: false, error: '插件未启用' };
    if (state.busy) return { ok: false, error: '上一批还没出完' };

    state.busy = true;
    state.lastError = '';
    api.emit('busy', true);
    try {
      const s = state.settings;

      /* 取素材 */
      const story = collectStory();
      const count = s.count;
      const recentGags = collectRecentGags();

      let items;
      let raw = '';
      if (s.seedDemo) {
        items = demoSample(count);
      } else {
        const viewers = s.audience.poolSize > 0 ? state.runtime.viewers : [];
        const res = await generateBatch({
          api: s.api,
          profile: state.profile,
          story,
          viewers,
          count,
          fourthWall: s.audience.fourthWall,
          recentGags,
          log: (m, lv) => logLine(m, lv),
        });
        if (!res.ok) {
          state.lastError = res.error;
          api.emit('error', res.error);
          return { ok: false, error: res.error };
        }
        items = res.items;
        raw = res.raw;
      }

      /* 上色（同一批颜色互不相同，且与背景可分辨） */
      const palette = buildPalette(items.length, { luminance: state.luminance });
      items.forEach((it, i) => {
        it.color = palette[i % palette.length];
      });

      /* 记账 */
      const batchNo = ++state.runtime.batchNo;
      const batch = {
        batchNo,
        at: Date.now(),
        anchorId: opts.messageId ?? lastMessageId(),
        title: batchTitle(batchNo),
        items,
      };
      pushHistory(state.runtime, batch, s.historyKeep);
      state.runtime.lastRaw = raw;
      bumpViewerCounts(items);
      pruneBatchFrames();
      persistRuntime();

      /* 渲染 */
      if (!opts.dryRun) {
        renderBatch(batch, { messageId: batch.anchorId, animate: true });
      }

      /* 直播模式：把"有人在看直播"这件事极短地告诉角色 */
      refreshInjection();

      api.emit('batch', batch);
      return { ok: true, batch };
    } finally {
      state.busy = false;
      api.emit('busy', false);
    }
  }

  function batchTitle(batchNo) {
    const p = state.profile?.data;
    const channel = p?.channelName ? `《${p.channelName}》` : '弹幕直播间';
    return `${channel} · 第 ${batchNo} 批`;
  }

  function collectRecentGags() {
    const last = state.runtime.history[state.runtime.history.length - 1];
    if (!last) return [];
    return last.items
      .filter((d) => /玩梗|情绪|起哄/.test(String(d.类型 || '')))
      .map((d) => String(d.内容 || '').replace(/^@\S+\s*/, ''))
      .slice(0, 4);
  }

  function bumpViewerCounts(items) {
    if (!state.runtime.viewers.length) return;
    const byName = new Map(state.runtime.viewers.map((v) => [v.昵称, v]));
    for (const it of items) {
      const v = byName.get(it.昵称);
      if (v) v.出现次数 = (v.出现次数 || 0) + 1;
    }
    // 长期不出现的可以排到后面，但不清除（保持"还是这批人"的感觉）
    state.runtime.viewers.sort((a, b) => (b.出现次数 || 0) - (a.出现次数 || 0));
  }

  /** 内存里最多留这么多批带框的，防止长时间聊天把 DOM 堆爆 */
  function pruneBatchFrames() {
    const list = state.runtime.history;
    if (list.length <= MAX_BATCHES_PER_MESSAGE_KEPT) return;
    const drop = list.slice(0, list.length - MAX_BATCHES_PER_MESSAGE_KEPT);
    for (const b of drop) {
      clearFrameAt(doc, b.anchorId);
      state.frames.delete(b.anchorId);
    }
  }

  function lastMessageId() {
    try {
      const msgs = getRecentStory(1);
      return msgs.length ? msgs[msgs.length - 1].id : -1;
    } catch {
      return -1;
    }
  }

  /* ───────────── 渲染 ───────────── */

  /**
   * 判断某一楼是不是"开场白"。
   * 开场白（0 楼）是卡的自我介绍，那时还没有任何剧情，
   * 观众没什么可说的 —— 所以默认不给它挂弹幕，也不拿它当弹幕的剧情来源。
   */
  function isOpeningMessage(messageId) {
    return Number(messageId) === 0;
  }

  /** 把一批弹幕渲染到楼层框（以及可选的悬浮层） */
  function renderBatch(batch, { messageId, animate = true } = {}) {
    const s = state.settings;
    const app = s.appearance;
    const mid = messageId ?? batch.anchorId;

    // 楼层框：开场白不挂（可选），或者拿不到有效楼层时干脆不挂（悬浮层照常放）
    const canMountFrame = Number.isFinite(Number(mid)) && Number(mid) >= 0 && !(s.skipOpening && isOpeningMessage(mid));

    if (app.frameEnabled && canMountFrame) {
      // 同一楼已有框就先停掉旧的
      const old = state.frames.get(mid);
      if (old) stopFrame(old);

      const frame = createFrame({
        doc,
        appearance: app,
        luminance: state.luminance,
        meta: { batchNo: batch.batchNo, messageId: mid, title: batch.title },
        items: batch.items,
      });
      const mounted = mountFrame({ doc, messageId: mid, frame });
      if (mounted) {
        state.frames.set(mid, frame);
        if (animate) {
          // 等浏览器完成布局再播，否则宽度算不准
          const kick = () => playFrame(frame, { doc, appearance: app });
          if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(kick);
          else setTimeout(kick, 30);
        } else {
          playFrame(frame, { doc, appearance: app });
        }
      }
    }

    if (app.overlayEnabled) {
      ensureOverlay(doc);
      applyOverlayStyle(doc, app);
      applyRect(doc, app.overlayRect);
      showOverlay(doc, true);
      if (animate) playOverlay(doc, batch.items, { appearance: app });
    }
  }

  /** 重播某一批（历史面板用） */
  function replayBatch(batchNo) {
    const batch = state.runtime.history.find((b) => b.batchNo === batchNo);
    if (!batch) return false;
    if (state.settings.appearance.overlayEnabled) {
      playOverlay(doc, batch.items, { appearance: state.settings.appearance });
    }
    const mid = batch.anchorId;
    renderBatch(batch, { messageId: mid, animate: true });
    return true;
  }

  /* ───────────── 注入（唯一的"弹幕 → 正文"通道） ───────────── */

  /**
   * 生成一段极短的注入文本。原则：
   *   · 只在直播模式开启时有内容；
   *   · 只说"有人在直播看你们"这个事实 + 观众刚在说什么；
   *   · 字数硬上限（默认 320 字），不落盘、不被世界书扫描。
   */
  function buildInjectionText() {
    if (!state.settings.liveMode) return '';
    const s = state.settings;
    const last = state.runtime.history[state.runtime.history.length - 1];
    const p = state.profile?.data;
    const samples = last
      ? last.items.slice(0, Math.max(0, s.injection.sampleCount)).map((d) => `${d.昵称}：${d.内容}`)
      : [];

    const parts = [];
    parts.push(
      `【直播提示】此刻你的一举一动正被一档${p?.channelName ? `名为《${p.channelName}》的` : ''}直播放送出去，有一群观众正在实时发弹幕看着你们（他们只是旁观者，不在场、不会被你们直接看到，但你知道有这回事）。`,
    );
    if (samples.length) {
      parts.push(`他们刚在说：${samples.join('｜')}`);
    }
    parts.push('你可以偶尔对此有一丝反应（瞥一眼、嘟囔、被气到、故意表演），但不要长篇回应观众，也不要让观众变成剧情里的角色。');

    let text = parts.join('\n');
    const cap = Math.max(40, s.injection.maxChars);
    if (text.length > cap) text = `${text.slice(0, cap - 1)}…`;
    return text;
  }

  function refreshInjection() {
    if (!state.settings.liveMode) {
      clearLiveInjection();
      return '';
    }
    const text = buildInjectionText();
    setLiveInjection(text, state.settings.injection.depth);
    state.runtime.lastInjection = text;
    return text;
  }

  /* ───────────── 事件入口 ───────────── */

  async function onAssistantMessage(messageId) {
    if (!state.initialized) return;
    if (!state.settings.enabled || !state.settings.autoGenerate) return;
    if (state.busy) return;
    // 开场白不触发：这时还没有剧情
    if (Number(messageId) === 0) return;

    state.runtime.roundNo += 1;
    persistRuntime();
    const every = Math.max(1, state.settings.everyNRounds);
    if (state.runtime.roundNo % every !== 0) return;

    await runBatch({ messageId, manual: false });
  }

  /* ───────────── 扫描世界书 ───────────── */

  async function scan(opts = {}) {
    if (state.busy) return { ok: false, error: '有任务在进行中' };
    state.busy = true;
    api.emit('busy', true);
    api.emit('scan', { phase: 'start', detail: '开始扫描世界书' });
    try {
      const story = collectStory();
      const res = await scanWorldbooks({
        api: state.settings.api,
        scan: state.settings.scan,
        recentText: story,
        log: (m, lv) => logLine(m, lv),
        // 三个阶段原样透出去，面板/设置栏照着显示进度
        progress: (p) => api.emit('scan', p),
      });
      if (!res.ok) {
        state.lastError = res.error;
        api.emit('error', res.error);
        return { ok: false, error: res.error };
      }
      state.profile = res.profile;
      putCachedProfile(storage, currentProfileKey(), res.profile);
      // 档案换了，旧名册是按旧档案起的，作废
      state.runtime.viewers = [];
      state.runtime.viewersProfileKey = '';
      state.runtime.viewersCardName = '';
      // 已经开着直播模式的话，把注入也按新档案刷新一遍
      if (state.settings.liveMode) refreshInjection();
      persistRuntime();
      api.emit('profile', res.profile);
      return { ok: true, profile: res.profile };
    } finally {
      state.busy = false;
      api.emit('busy', false);
      api.emit('scan', { phase: 'end', detail: '' });
    }
  }

  /**
   * 档案是否已经生效？面板与设置栏用它给用户一个明确交代。
   * 扫描是"扫完即生效"的：写进缓存后，下一批弹幕立刻用新档案，不需要额外点应用。
   */
  function describeProfileStatus() {
    const p = state.profile;
    if (!p) {
      return {
        ready: false,
        title: '还没扫描',
        detail: '弹幕现在会靠正文临场推断用词，没有这个世界的本土词汇。点「扫描世界书」让 AI 读一遍。',
      };
    }
    const d = p.data || {};
    const s = p.stats || {};
    const when = p.generatedAt ? new Date(p.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
    return {
      ready: true,
      title: d.channelName ? `《${d.channelName}》` : '档案已生成',
      detail:
        `已生效（${when}）：来源 ${s.books} 本 / 读 ${s.entriesRead} 条 ${s.charsRead} 字 → 档案 ${s.summaryChars} 字` +
        (state.settings.liveMode ? '；直播模式的注入也按新档案刷新了' : '') +
        '。下一批弹幕就会用上它，不需要再点别的。',
    };
  }

  /** 生成/补足常驻观众名册 */
  async function buildViewers() {
    if (state.busy) return { ok: false, error: '有任务在进行中' };
    const size = state.settings.audience.poolSize;
    if (size <= 0) return { ok: false, error: '观众数量设为 0，不需要生成名册' };
    state.busy = true;
    api.emit('busy', true);
    try {
      const res = await buildViewerPool({
        api: state.settings.api,
        profile: state.profile,
        poolSize: size,
        existing: [],
      });
      if (!res.ok) {
        state.lastError = res.error;
        api.emit('error', res.error);
        return { ok: false, error: res.error };
      }
      state.runtime.viewers = res.viewers;
      state.runtime.viewersProfileKey = currentProfileKey();
      state.runtime.viewersCardName = getCardName();
      persistRuntime();
      api.emit('viewers', res.viewers);
      return { ok: true, viewers: res.viewers };
    } finally {
      state.busy = false;
      api.emit('busy', false);
    }
  }

  /* ───────────── 设置与持久化 ───────────── */

  function persistSettings() {
    saveSettings(storage, state.settings);
  }

  function persistRuntime() {
    saveRuntime(storage, state.runtime, state.settings.historyKeep);
  }

  function updateSettings(patch, { silent = false } = {}) {
    state.settings = normalizeSettings(deepMergeLocal(state.settings, patch));
    persistSettings();
    // 外观类设置立刻反映到页面
    applyOverlayStyle(doc, state.settings.appearance);
    if (state.settings.appearance.overlayEnabled) {
      ensureOverlay(doc);
      showOverlay(doc, true);
      applyRect(doc, state.settings.appearance.overlayRect);
    } else {
      showOverlay(doc, false);
    }
    if (!state.settings.liveMode) clearLiveInjection();
    else refreshInjection();
    if (!silent) api.emit('settings', state.settings);
    return state.settings;
  }

  function resetSettings() {
    return updateSettings(loadSettings(storage, {}));
  }

  function clearAll() {
    clearAllFrames(doc);
    state.frames.forEach((f) => stopFrame(f));
    state.frames.clear();
    stopOverlay(doc);
    state.runtime = createRuntime();
    persistRuntime();
    clearLiveInjection();
    api.emit('cleared');
  }

  /* ───────────── 小工具 ───────────── */

  function logLine(msg, level = 'info') {
    if (state.settings.debug || level === 'warn' || level === 'error') {
      const fn = level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info';
      toast(`[弹幕] ${msg}`, fn === 'warning' ? 'warning' : fn === 'error' ? 'error' : 'info');
    }
  }

  /** 统计信息（面板顶部显示） */
  function stats() {
    const names = listWorldbookNames();
    const used = resolveWorldbookNames(state.settings.scan.sources);
    return {
      card: getCardName() || '(无卡)',
      chatId: getChatId() || '(未命名聊天)',
      worldbooksAvailable: names.length,
      worldbooksUsed: used,
      profile: state.profile,
      profileKey: currentProfileKey(),
      luminance: state.luminance,
      batches: state.runtime.history.length,
      batchNo: state.runtime.batchNo,
      roundNo: state.runtime.roundNo,
      viewers: state.runtime.viewers,
      framesOnPage: countFrames(doc),
      busy: state.busy,
      lastError: state.lastError,
      history: state.runtime.history,
      liveInjection: state.runtime.lastInjection || '',
      overlayVisible: isOverlayVisible(doc),
      overlayRect: readRect(doc),
    };
  }

  /* ───────────── 对外 API ───────────── */

  const listeners = new Map();

  const api = {
    init,
    destroy,
    state,
    stats,
    updateSettings,
    resetSettings,
    clearAll,
    scan,
    buildViewers,
    runBatch,
    onAssistantMessage,
    replayBatch,
    renderBatch,
    refreshInjection,
    buildInjectionText,
    persistSettings,
    persistRuntime,
    /** 面板用：所有可用世界书名 */
    listAllWorldbooks() {
      return listWorldbookNames();
    },
    /** 面板用：说清当前到底会读哪些世界书、是不是在跟随当前卡 */
    describeWorldbookSource() {
      const s = state.settings.scan;
      const names = resolveWorldbookNames(s.sources);
      const manual = Array.isArray(s.sources) && s.sources.length > 0;
      const none = Array.isArray(s.sources) && s.sources.length === 0;
      const mode = manual
        ? s.followCard
          ? '手动指定（换卡自动切回跟随该卡）'
          : '手动指定（换卡也保留）'
        : none
          ? '手动指定：一本都不读'
          : '自动跟随当前卡绑定的世界书';
      // 卡片本身绑定的书（用来在列表里打标记）
      const cardBooks = [];
      const bound = getBoundWorldbooks();
      if (bound.primary) cardBooks.push(bound.primary);
      for (const b of bound.additional) if (!cardBooks.includes(b)) cardBooks.push(b);
      return { mode, names, card: getCardName(), cardBooks, manual };
    },
    /** 面板用：档案是不是已经生效（扫描即生效，这里只是给个明确交代） */
    describeProfileStatus,
    /** 面板用：说清弹幕现在到底会用哪个 AI 来源 */    describeAiSource() {
      const api = state.settings.api;
      if (api.route === 'direct') {
        return api.direct?.baseUrl ? `直连：${api.direct.baseUrl}` : '直连：还没填地址';
      }
      if (String(api.proxyPreset || '').trim()) return `走代理预设：${api.proxyPreset}`;
      const cur = getCurrentConnection();
      const target = resolveStTarget(api);
      const parts = [`来源 ${target.chat_completion_source || '未知'}`];
      if (target.model) parts.push(`模型 ${target.model}`);
      else parts.push('模型：跟随酒馆当前模型');
      if (api.sourceMode === 'auto' && !cur?.source) parts.push('（未能读到酒馆当前连接，请检查是否已选好聊天补全）');
      if (target.chat_completion_source === 'custom' && !target.custom_url) parts.push('⚠ 自定义端点没配地址');
      return parts.join('　|　');
    },
    /** 面板用：按当前主题给弹幕框取一个协调的背景色 */
    sampleFrameBackground() {
      let sampled = null;
      try {
        // 采样前先把面板藏起来，否则采到的是面板自己的背景
        const panelEl = doc.getElementById('std-panel');
        const wasHidden = panelEl?.classList?.contains('std-hidden');
        if (panelEl && !wasHidden) panelEl.style.visibility = 'hidden';
        try {
          sampled = sampleBackground(doc, win);
        } finally {
          if (panelEl && !wasHidden) panelEl.style.visibility = '';
        }
      } catch {
        sampled = null;
      }
      if (!sampled || !sampled.color) return '';
      const base = sampled.color;
      // 用主题色做一个"亮 → 深"的渐变，保证弹幕文字始终看得清
      const css = `linear-gradient(100deg, ${shade(base, 0.28)} 0%, ${shade(base, 0.05)} 45%, ${shade(base, -0.32)} 100%)`;
      updateSettings({ appearance: { frameBackground: css, frameBgTouched: true } });
      return css;
    },
    /** 面板用：本次扫描大约要读多少字（让用户心里有数） */
    estimateScan() {
      const st = state.profile?.stats;
      const est = estimateScanCost({
        entryCharBudget: state.settings.scan.entryCharBudget,
        charsTotal: st?.charsTotal || 0,
      });
      if (!st?.charsTotal) return `未知（还没扫过，取样上限 ${est.sampleChars} 字）`;
      return `约 ${est.sampleChars} 字（这本书合计 ${st.charsTotal} 字，小于上限时全读）`;
    },
    /** 面板用：清空档案缓存 */
    clearProfileCache() {
      clearProfileCache(storage);
      state.profile = null;
      api.emit('profile', null);
      return true;
    },
    /** 面板用：把当前档案写回缓存（手改档案后调用） */
    persistProfile() {
      if (!state.profile) return false;
      putCachedProfile(storage, currentProfileKey(), state.profile);
      api.emit('profile', state.profile);
      return true;
    },
    /** 面板用：测试当前连接 */
    async testApi() {
      const res = await chat({
        api: state.settings.api,
        label: '连接测试',
        system: '你是一个测试用的助手。',
        user: '只回复两个字：正常',
      });
      return res.ok
        ? { ok: true, message: `通了（路线 ${res.route}）返回：${String(res.text).slice(0, 60)}` }
        : { ok: false, message: res.error };
    },
    /** 面板用：拉模型列表（走酒馆后端） */
    async listModels() {
      return fetchModelList(state.settings.api);
    },
    renderDemo(n = 15) {
      const items = demoSample(n);
      const palette = buildPalette(items.length, { luminance: state.luminance });
      items.forEach((it, i) => {
        it.color = palette[i % palette.length];
      });
      const batch = { batchNo: ++state.runtime.batchNo, at: Date.now(), anchorId: lastMessageId(), title: batchTitle(state.runtime.batchNo), items };
      renderBatch(batch, { messageId: batch.anchorId, animate: true });
      return batch;
    },
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      const set = listeners.get(evt);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(payload);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[弹幕直播间] 监听器异常', evt, e);
        }
      }
    },
    resolveHostAnchor: (id) => resolveHostAnchor(id, doc),
  };

  return api;
}

/** 局部深合并（避免为此把 store 的 clone 再导一遍） */
function deepMergeLocal(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const b = base?.[k];
    const p = patch[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && p && typeof p === 'object' && !Array.isArray(p)
      ? deepMergeLocal(b, p)
      : p;
  }
  return out;
}
