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
  let scanPhase = null; // 扫描进行中的阶段（null = 没在扫）

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
            <div class="menu_button std-dw-btn" data-std-dw-act="demo">本地预览</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="open">打开完整设置</div>
          </div>

          <!-- 世界书模块：勾选就发生在这里，勾哪本扫描就读哪本 -->
          <div class="std-dw-sec">世界书</div>
          <div class="std-dw-mode" data-std-dw-mode></div>
          <div class="std-dw-books" data-std-dw-books></div>
          <div class="std-dw-subbtns">
            <div class="menu_button std-dw-btn" data-std-dw-act="books-reload">重新查找</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="books-all">勾选全部</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="books-none">全不选</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="books-auto">恢复自动跟随</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="books-diag">诊断</div>
          </div>
          <label class="std-dw-check"><input type="checkbox" data-std-dw="scan.followCard"><span>换卡时自动跟随该卡绑定的世界书</span></label>
          <div class="std-dw-btns">
            <div class="menu_button std-dw-btn std-dw-primary" data-std-dw-act="scan">扫描世界书</div>
            <div class="menu_button std-dw-btn" data-std-dw-act="viewers">生成观众名册</div>
          </div>
          <div class="std-dw-progress" data-std-dw-progress></div>
          <div class="std-dw-applied" data-std-dw-applied></div>

          <div class="std-dw-result" data-std-dw-result></div>
          <div class="std-dw-tip">弹幕是独立请求，不占正文 token。勾选可以多选，勾哪本就扫描哪几本。外观 / 连接 / 观众 / 风格这些在「打开完整设置」里。</div>
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
    rootEl.addEventListener('click', onFieldChange);
    rootEl.addEventListener('click', onClick);

    ['settings', 'batch', 'profile', 'viewers', 'busy', 'error', 'chat', 'card', 'books', 'scan', 'cleared'].forEach((evt) => {
      offFns.push(app.on(evt, (payload) => {
        if (evt === 'scan') {
          scanPhase = payload && payload.phase && payload.phase !== 'end' ? payload : null;
        }
        render();
      }));
    });

    render();
    return rootEl;
  }

  function onFieldChange(ev) {
    const el = ev.target;
    if (!el) return;

    // 世界书勾选：单独一条通路
    const book = el.getAttribute?.('data-std-book');
    if (book !== null && book !== undefined) {
      applyBookSelection();
      return;
    }

    const path = el.getAttribute?.('data-std-dw');
    if (!path) return;

    // click 只在真正点到控件本身时才当输入处理，避免误触发
    const kind = resolveKind(el);
    if (ev.type === 'click' && !['checkbox', 'radio', 'range', 'select'].includes(kind)) return;
    let value;
    if (kind === 'checkbox' || kind === 'radio') {
      value = isChecked(el);
    } else if (kind === 'number' || kind === 'range') {
      const raw = readValue(el);
      value = Number(raw);
      if (!Number.isFinite(value)) return; // 输入框被清空时不要写坏设置
    } else {
      value = readValue(el);
    }
    app.updateSettings(setPath({}, path, value));
    render();
  }

  /** 把 'scan.followCard' 这样的路径写成嵌套对象 */
  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
  }

  /** 元素属于哪种输入控件 */
  function resolveKind(el) {
    const attrType = el.getAttribute?.('type');
    if (attrType) return attrType.toLowerCase();
    if (typeof el.type === 'string' && el.type) return el.type.toLowerCase();
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    if (tag === 'INPUT') return 'text';
    return 'text';
  }

  /** 复选框是否勾上：优先读属性设置器，退回读属性 */
  function isChecked(el) {
    if (typeof el.checked === 'boolean') return el.checked;
    return el.getAttribute?.('checked') !== null;
  }

  /** 读输入值 */
  function readValue(el) {
    if (typeof el.value === 'string' && el.value !== '') return el.value;
    return el.getAttribute?.('value') ?? '';
  }

  /** 把世界书勾选写回设置（勾了任意一本 = 切到手动模式） */
  function applyBookSelection() {
    const before = app.stats().worldbooksUsed;
    const boxes = [...rootEl.querySelectorAll('[data-std-book]')];
    const isChecked = (n) => (typeof n.checked === 'boolean' ? n.checked : n.getAttribute('checked') !== null);
    const nowChecked = boxes.filter(isChecked).map((n) => n.getAttribute('data-std-book')).filter((n) => n != null);

    const wasManual = Array.isArray(app.state.settings.scan.sources);
    let names;
    if (wasManual) {
      names = nowChecked;
    } else {
      const unchecked = new Set(boxes.filter((b) => !isChecked(b)).map((b) => b.getAttribute('data-std-book')));
      names = [...new Set([...before.filter((n) => !unchecked.has(n)), ...nowChecked])];
    }

    app.updateSettings({ scan: { sources: names } });
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
      let msg = res.ok
        ? `✅ 档案完成：读 ${res.profile.stats.entriesRead} 条 / ${res.profile.stats.charsRead} 字 → 总结 ${res.profile.stats.summaryChars} 字`
        : `❌ ${res.error}`;
      if (res.ok && res.note) msg += `\nℹ️ ${res.note}`;
      setResult(msg);
      render();
    }

    if (act === 'books-reload') {
      setResult('⏳ 正在重新查找世界书…');
      const list = await app.reloadWorldbooks();
      setResult(list.length ? `✅ 找到 ${list.length} 本：${list.slice(0, 6).map((b) => b.name).join('、')}` : '⚠️ 还是没找到。点「诊断」看看哪条路通。');
      render();
      return;
    }
    if (act === 'books-diag') {
      setResult('⏳ 正在逐条诊断…');
      const rows = await app.diagnoseBooks();
      const text = rows.map((r) => `${r.label}：${r.outcome}`).join('\n');
      setResult(text);
      render();
      return;
    }
    if (act === 'books-all') {
      app.updateSettings({ scan: { sources: app.listAllWorldbooks() } });
      render();
      return;
    }
    if (act === 'books-none') {
      app.updateSettings({ scan: { sources: [] } });
      render();
      return;
    }
    if (act === 'books-auto') {
      app.updateSettings({ scan: { sources: null } });
      render();
      return;
    }
    if (act === 'viewers') {
      setResult('⏳ 正在生成观众名册…');
      const res = await app.buildViewers();
      setResult(res.ok ? `✅ 已生成 ${res.viewers.length} 位常驻观众` : `❌ ${res.error}`);
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
    setCheck('scan.followCard', s.scan.followCard);
    setNum('count', s.count);
    setNum('everyNRounds', s.everyNRounds);

    renderBookList();
    renderScanFeedback();
    renderStatus();
  }

  /** 扫描进度与"已生效"反馈 */
  function renderScanFeedback() {
    const progEl = rootEl.querySelector('[data-std-dw-progress]');
    const appliedEl = rootEl.querySelector('[data-std-dw-applied]');

    if (progEl) {
      if (scanPhase) {
        const label = { start: '准备中', index: '① 索引条目', sample: '② 按预算取样正文', summarize: '③ 总结成观众档案' }[scanPhase.phase] || '处理中';
        progEl.innerHTML = `<span class="std-dw-spin"></span> ${esc(label)}${scanPhase.detail ? `：${esc(scanPhase.detail)}` : ''}`;
        progEl.classList.add('show');
      } else {
        progEl.classList.remove('show');
        progEl.textContent = '';
      }
    }

    if (appliedEl) {
      const st = app.describeProfileStatus();
      appliedEl.className = `std-dw-applied ${st.ready ? 'ok' : 'none'}`;
      appliedEl.innerHTML = `<b>${st.ready ? '✅ ' : '○ '}${esc(st.title)}</b><br>${esc(st.detail)}`;
    }
  }

  /** 世界书勾选列表：勾哪本，扫描就读哪本 */
  function renderBookList() {
    const host = rootEl.querySelector('[data-std-dw-books]');
    const modeEl = rootEl.querySelector('[data-std-dw-mode]');
    if (!host) return;

    const st = app.stats();
    const src = app.describeWorldbookSource();
    const names = app.listAllWorldbooks();
    const used = new Set(st.worldbooksUsed);

    if (modeEl) {
      modeEl.textContent = src.manual
        ? `✍️ 手动选择：扫描只读勾选的书（已勾 ${used.size} 本）`
        : `🔄 自动跟随当前卡：正在读本卡绑定的 + 全局开启的（${used.size} 本）。勾选任意一本即切到手动。`;
      modeEl.classList.toggle('manual', !!src.manual);
    }

    if (!names.length) {
      host.innerHTML = '<div class="std-dw-empty">这个酒馆里一本世界书都没有。插件会走「看正文学」路线，弹幕依然能出。</div>';
      return;
    }

    host.innerHTML = names
      .map((n) => {
        const on = used.has(n);
        return `<label class="std-dw-book${on ? ' on' : ''}"><input type="checkbox" data-std-book="${esc(n)}" ${
          on ? 'checked' : ''
        }><span>${esc(n)}</span>${src.cardBooks.includes(n) ? '<i class="std-dw-tag">本卡</i>' : ''}</label>`;
      })
      .join('');
  }

  function renderStatus() {
    const st = app.stats();
    const src = app.describeWorldbookSource();
    const badge = rootEl.querySelector('[data-std-dw-badge]');
    if (badge) {
      const bits = [];
      if (!app.state.settings.enabled) bits.push('已停用');
      else bits.push('运行中');
      if (app.state.settings.liveMode) bits.push('🔴 直播中');
      badge.textContent = bits.join(' · ');
      badge.classList.toggle('off', !app.state.settings.enabled);
      badge.classList.toggle('live', !!app.state.settings.liveMode);
    }

    const status = rootEl.querySelector('[data-std-dw-status]');
    if (status) {
      const lines = [];
      lines.push(`当前卡：${esc(st.card)}`);
      lines.push(
        src.manual
          ? `世界书：<b>手动选择</b>了 ${src.names.length} 本${src.names.length ? `（${esc(src.names.join('、'))}）` : ''}`
          : `世界书：自动跟随该卡绑定的 ${src.names.length} 本${src.names.length ? `（${esc(src.names.join('、'))}）` : ''}`,
      );
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
