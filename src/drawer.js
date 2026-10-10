/**
 * drawer.js — 酒馆「扩展」面板里的设置栏
 *
 * 官方惯例是把设置挂进 `#extensions_settings2`。绝大多数扩展用
 * `context.renderExtensionTemplateAsync()` 读自己的 settings.html，
 * 但那是服务端渲染接口，在不同客户端上不一定可用 —— 所以这里把抽屉
 * 直接内联在 JS 里构建，零依赖、到哪都能用。
 *
 * 抽屉里放的是最常用的几项（开关、条数、扫描、出一批），
 * 完整设置（外观 / 连接 / 观众 / 风格 / 记录）仍然在悬浮球面板里，
 * 抽屉底部有按钮一键打开。
 */

const DRAWER_ID = 'std-drawer';

/** 酒馆扩展设置栏的挂载点（按优先级找） */
const CONTAINERS = ['#extensions_settings2', '#extensions_settings'];

export function createDrawer(app, { doc = globalThis.document } = {}) {
  let rootEl = null;
  let offFns = [];

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function findContainer() {
    for (const sel of CONTAINERS) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function mount() {
    const existing = doc.getElementById(DRAWER_ID);
    // 必须是本文档里的那个（重载/多文档场景下别拿到旧节点）
    if (existing && existing.ownerDocument === doc) {
      rootEl = existing;
      return rootEl;
    }
    if (existing && existing.ownerDocument !== doc) existing.remove();

    const host = findContainer();
    if (!host) return null;

    rootEl = doc.createElement('div');
    rootEl.id = DRAWER_ID;
    rootEl.className = 'extension_container';
    rootEl.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header std-dw-head">
          <b>弹幕直播间</b>
          <span class="std-dw-badge" data-std-dw-badge>—</span>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="std-dw-status" data-std-dw-status></div>

          <label class="std-dw-check"><input type="checkbox" data-std-dw="enabled"><span>启用插件</span></label>
          <label class="std-dw-check"><input type="checkbox" data-std-dw="liveMode"><span>直播模式（角色知道在直播）</span></label>
          <label class="std-dw-check"><input type="checkbox" data-std-dw="autoGenerate"><span>每轮正文自动出弹幕</span></label>

          <div class="std-dw-row">
            <span>每批条数</span>
            <input class="text_pole std-dw-num" type="number" min="1" max="60" step="1" data-std-dw="count">
            <span>每几轮出一批</span>
            <input class="text_pole std-dw-num" type="number" min="1" max="50" step="1" data-std-dw="everyNRounds">
          </div>
          <label class="std-dw-check"><input type="checkbox" data-std-dw="skipOpening"><span>开场白不出弹幕</span></label>

          <div class="std-dw-btns">
            <div class="menu_button std-dw-btn" data-std-dw-act="batch">出一批</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="scan">扫描世界书</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="demo">本地预览</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="open">打开完整设置</div>
          </div>

          <div class="std-dw-result" data-std-dw-result></div>
          <div class="std-dw-tip">弹幕是独立请求，不占正文 token。完整设置（连接 / 外观 / 观众 / 风格 / 记录）在悬浮球面板里。</div>
        </div>
      </div>
    `;
    host.appendChild(rootEl);

    // 展开/收起：复用酒馆自己的 inline-drawer 行为约定
    const header = rootEl.querySelector('.std-dw-head');
    const content = rootEl.querySelector('.inline-drawer-content');
    const icon = rootEl.querySelector('.inline-drawer-icon');
    content.style.display = 'none';
    header.addEventListener('click', () => {
      const open = content.style.display === 'none';
      content.style.display = open ? '' : 'none';
      icon?.classList.toggle('down', open);
      icon?.classList.toggle('up', !open);
      if (open) render();
    });

    rootEl.addEventListener('change', onFieldChange);
    rootEl.addEventListener('input', onFieldChange);
    rootEl.addEventListener('click', onClick);

    ['settings', 'batch', 'profile', 'viewers', 'busy', 'error', 'chat', 'scan', 'cleared'].forEach((evt) => {
      offFns.push(app.on(evt, () => render()));
    });

    render();
    return rootEl;
  }

  function onFieldChange(ev) {
    const el = ev.target;
    const path = el?.getAttribute?.('data-std-dw');
    if (!path) return;

    // 用"属性 + 属性值"双重判断，而不是只信 el.type：
    // 某些环境下 IDL 属性（el.type / el.value）拿不到，只信它会导致改动被静默忽略。
    const kind = el.type || el.getAttribute?.('type') || (el.tagName === 'INPUT' ? 'text' : el.tagName === 'TEXTAREA' ? 'textarea' : '');
    let value;
    if (kind === 'checkbox' || kind === 'radio') {
      value = 'checked' in el ? !!el.checked : el.getAttribute?.('checked') !== null;
    } else if (kind === 'number' || kind === 'range') {
      const raw = el.value !== undefined && el.value !== '' ? el.value : el.getAttribute?.('value');
      value = Number(raw);
      if (!Number.isFinite(value)) return; // 输入框被清空时不要写坏设置
    } else {
      value = el.value !== undefined ? el.value : el.getAttribute?.('value') ?? '';
    }

    app.updateSettings({ [path]: value });
    render();
  }

  async function onClick(ev) {
    const btn = ev.target?.closest?.('[data-std-dw-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-std-dw-act');

    if (act === 'open') {
      app.emit('open-panel');
      return;
    }

    if (act === 'batch') {
      setResult('⏳ 正在生成…');
      const res = await app.runBatch({ manual: true });
      setResult(res.ok ? `✅ 已出 ${res.batch.items.length} 条弹幕` : `❌ ${res.error}`);
      render();
      return;
    }

    if (act === 'demo') {
      app.renderDemo(app.state.settings.count);
      setResult('✅ 已用本地示例弹幕预览（没有花 API）');
      return;
    }

    if (act === 'scan') {
      setResult('⏳ 正在扫描世界书…');
      const res = await app.scan();
      setResult(
        res.ok
          ? `✅ 档案完成：读 ${res.profile.stats.entriesRead} 条 / ${res.profile.stats.charsRead} 字 → 总结 ${res.profile.stats.summaryChars} 字`
          : `❌ ${res.error}`,
      );
      render();
    }
  }

  function setResult(text) {
    const el = rootEl?.querySelector('[data-std-dw-result]');
    if (el) el.textContent = text;
  }

  function render() {
    if (!rootEl) return;
    const s = app.state.settings;
    const st = app.stats();

    const setCheck = (path, value) => {
      const el = rootEl.querySelector(`[data-std-dw="${path}"]`);
      if (el && el.checked !== value) el.checked = value;
    };
    const setNum = (path, value) => {
      const el = rootEl.querySelector(`[data-std-dw="${path}"]`);
      // 正在输入的框不要被覆盖
      if (el && doc.activeElement !== el) el.value = String(value);
    };

    setCheck('enabled', s.enabled);
    setCheck('liveMode', s.liveMode);
    setCheck('autoGenerate', s.autoGenerate);
    setCheck('skipOpening', s.skipOpening);
    setNum('count', s.count);
    setNum('everyNRounds', s.everyNRounds);

    const badge = rootEl.querySelector('[data-std-dw-badge]');
    if (badge) {
      const bits = [];
      if (!s.enabled) bits.push('已停用');
      else bits.push('运行中');
      if (s.liveMode) bits.push('🔴 直播中');
      badge.textContent = bits.join(' · ');
      badge.classList.toggle('off', !s.enabled);
      badge.classList.toggle('live', !!s.liveMode);
    }

    const status = rootEl.querySelector('[data-std-dw-status]');
    if (status) {
      const lines = [];
      lines.push(`当前卡：${esc(st.card)}`);
      lines.push(`世界书：用了 ${st.worldbooksUsed.length} 本 / 共 ${st.worldbooksAvailable} 本`);
      lines.push(
        st.profile
          ? `观众档案：${st.profile.data?.channelName ? `《${esc(st.profile.data.channelName)}》` : '已生成'}（${st.profile.stats.summaryChars} 字）`
          : '观众档案：<b>还没扫描</b>（先点下面的「扫描世界书」，弹幕才会用上这个世界的词）',
      );
      lines.push(`已出弹幕：${st.batches} 批　|　观众名册：${st.viewers.length} 人`);
      if (st.busy) lines.push('<b>⏳ 有任务在进行中…</b>');
      if (st.lastError) lines.push(`<span class="std-dw-err">最近出错：${esc(st.lastError)}</span>`);
      status.innerHTML = lines.join('<br>');
    }
  }

  function unmount() {
    offFns.forEach((f) => {
      try {
        f();
      } catch {
        /* noop */
      }
    });
    offFns = [];
    if (rootEl) rootEl.remove();
    rootEl = null;
  }

  return { mount, render, unmount, get el() { return rootEl; } };
}
