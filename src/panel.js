/**
 * panel.js — 悬浮球 + 设置面板
 *
 * 纯手写 DOM，不依赖 jQuery / 酒馆助手，也不引入任何样式框架。
 * 所有控件都用 data-std-path 指向设置里的字段路径，改动即时生效并持久化。
 *
 * 面板分页：
 *   总览 / 连接 / 世界书 / 观众 / 外观 / 风格 / 记录
 */

const BALL_ID = 'std-ball';
const PANEL_ID = 'std-panel';

/* 字段声明：一页一组，渲染和读值都靠它 */
function pages(app) {
  return [
    {
      id: 'home',
      label: '总览',
      render: (s) => {
        const st = app.stats();
        const p = st.profile?.data;
        return [
          row2('总开关', toggle('enabled', s.enabled, '关掉后不再自动出弹幕，也不注入任何东西')),
          row2(
            '直播模式',
            toggle('liveMode', s.liveMode, '开 = 角色知道有人在直播看（会注入一句极短的提示，不落盘）；关 = 只有你能看见弹幕'),
          ),
          row2(
            '自动直出',
            toggle('autoGenerate', s.autoGenerate, '每轮正文生成完就自动出一批；关掉就只能手动点"出一批"'),
          ),
          row2('每几轮出一批', number('everyNRounds', s.everyNRounds, 1, 50, 1), s.autoGenerate ? '' : '（自动直出已关，此项暂不生效）'),
          row2('每批条数', number('count', s.count, 1, 60, 1), '一次请求批量生成'),
          sep(),
          kv('当前卡', st.card),
          kv('当前聊天', st.chatId),
          kv('背景亮度（用于配色）', st.luminance.toFixed(3)),
          kv('直播间', p?.channelName || '（还没扫世界书）'),
          kv('已出批次', `${st.batches} 批 / 共处理 ${st.roundNo} 轮`),
          kv('页面上弹幕框', `${st.framesOnPage} 块`),
          kv('悬浮层', st.overlayVisible ? '显示中' : '隐藏'),
          st.lastError ? `<div class="std-warn">最近一次出错：${esc(st.lastError)}</div>` : '',
          sep(),
          btnRow([
            { label: '手动出一批', act: 'batch', primary: true },
            { label: '本地预览（不花钱）', act: 'demo' },
            { label: '重播上一批', act: 'replay-last' },
          ]),
        ].join('');
      },
    },
    {
      id: 'api',
      label: '连接',
      render: (s) => {
        const a = s.api;
        return [
          '<div class="std-hint">弹幕是独立请求，不占正文 token。两条路线选一条即可。</div>',
          row2(
            '路线',
            select(
              'api.route',
              a.route,
              [
                ['st', '甲 · 走酒馆后端（推荐：能直接用酒馆里已存的 key）'],
                ['direct', '乙 · 直连自填地址（端点需允许跨域）'],
              ],
              true,
            ),
          ),
          a.route === 'st'
            ? [
                row2(
                  'AI 来源',
                  select(
                    'api.sourceMode',
                    a.sourceMode,
                    [
                      ['auto', '自动跟随酒馆当前连接（推荐）'],
                      ['fixed', '固定用下面的来源'],
                    ],
                    true,
                  ),
                  app.describeAiSource(),
                ),
                a.sourceMode === 'fixed'
                  ? [
                      row2(
                        '来源',
                        select(
                          'api.source',
                          a.source,
                          [
                            ['custom', 'custom（自定义 OpenAI 兼容端点）'],
                            ['openai', 'openai'],
                            ['deepseek', 'deepseek'],
                            ['makersuite', 'makersuite（Gemini）'],
                            ['openrouter', 'openrouter'],
                            ['claude', 'claude'],
                            ['groq', 'groq'],
                            ['mistralai', 'mistralai'],
                          ],
                          true,
                        ),
                        a.source === 'custom'
                          ? '注意：custom 用的是酒馆里配好的自定义端点地址。没配的话会直接报错。'
                          : '',
                      ),
                    ].join('')
                  : '<div class="std-hint">自动模式下，弹幕会跟着你在酒馆里当前的连接走；你在酒馆里换了连接，弹幕也会跟着换。酒馆里已保存的 key 直接复用，不用在这里重填。</div>',
                row2('代理预设名', text('api.proxyPreset', a.proxyPreset, '留空则不用；填了优先走它')),
                row2('覆盖地址', text('api.reverseProxy', a.reverseProxy, '留空则用酒馆设置里的地址')),
              ].join('')
            : [
                row2('API 地址', text('api.direct.baseUrl', a.direct.baseUrl, '例：http://127.0.0.1:1234/v1')),
                row2('API Key', password('api.direct.apiKey', a.direct.apiKey, '本地端点可留空')),
                row2('模型名', text('api.direct.model', a.direct.model || a.model, '必填')),
                row2('额外请求头', textarea('api.direct.extraHeaders', a.direct.extraHeaders, '每行一条，如：X-Foo: bar')),
                '<div class="std-hint">直连如果报跨域错误，是端点没开 CORS，换甲路线即可。</div>',
              ].join(''),
          sep(),
          row2('模型名', text('api.model', a.model, '留空 = 用酒馆当前模型（仅甲路线）')),
          row2('温度', number('api.temperature', a.temperature, 0, 2, 0.05)),
          row2('最大输出', number('api.maxTokens', a.maxTokens, 64, 32000, 1)),
          row2('超时（毫秒）', number('api.timeoutMs', a.timeoutMs, 5000, 600000, 1000)),
          row2('结构化输出', toggle('api.useJsonSchema', a.useJsonSchema, '让模型按 JSON 返回，成功率更高；某些端点不支持可关掉')),
          sep(),
          btnRow([
            { label: '测试连接', act: 'test-api', primary: true },
            { label: '拉取模型列表', act: 'list-models' },
          ]),
          '<div id="std-api-result" class="std-result"></div>',
        ].join('');
      },
    },
    {
      id: 'world',
      label: '世界书',
      render: (s) => {
        const st = app.stats();
        const prof = st.profile;
        const names = app.listAllWorldbooks();
        const used = new Set(st.worldbooksUsed);
        const rows = names.length
          ? names
              .map((n) => {
                const checked = s.scan.sources ? used.has(n) : used.has(n);
                return `<label class="std-book"><input type="checkbox" data-std-book="${esc(n)}" ${checked ? 'checked' : ''} ${
                  s.scan.sources ? '' : 'data-std-book-auto="1"'
                }><span>${esc(n)}</span></label>`;
              })
              .join('')
          : '<div class="std-hint">没找到任何世界书。插件会走"看正文学"路线，弹幕依然能出，只是没有本土词汇。</div>';

        const auto = s.scan.sources ? '' : '<div class="std-hint">当前是自动模式：读「当前卡绑定的世界书 + 全局开启的」。勾选任意一本会自动切到手动模式。</div>';

        const stats = prof?.stats;
        const statLines = stats
          ? [
              kv('来源世界书', `${stats.books} 本`),
              kv('条目总数', `${stats.entriesTotal} 条 / 合计 ${fmt(stats.charsTotal)} 字`),
              kv('本次实际读取', `${stats.entriesRead} 条 / ${fmt(stats.charsRead)} 字（预算 ${fmt(s.scan.entryCharBudget)} 字）`),
              kv('档案字数', `${stats.summaryChars} 字（上限 ${fmt(s.scan.summaryCharBudget)} 字）`),
              kv('扫描时间', prof.generatedAt ? new Date(prof.generatedAt).toLocaleString('zh-CN') : '—'),
            ].join('')
          : '<div class="std-hint">还没有档案。点下面的"扫描世界书"让 AI 读一遍，生成"这批观众是谁、用什么词"。</div>';

        return [
          '<div class="std-hint">扫描是三步走的，任何规模的世界书都不会一口气全塞给模型：<b>先索引</b>（只读条目名，几乎不花 token）→ <b>再按预算取样正文</b> → <b>最后总结成有字数上限的档案</b>。</div>',
          '<div class="std-sec">要读哪些世界书</div>',
          (() => {
            const src = app.describeWorldbookSource();
            const warn = !src.names.length
              ? '<div class="std-warn">这张卡没有绑定任何世界书，全局也没有开启的世界书。插件仍能出弹幕，但会走「看正文学」的路线：没有本土词汇，弹幕会比较泛。</div>'
              : '';
            return `${kv('跟随模式', src.mode)}${kv('当前卡', src.card || '(无卡)')}${kv(
              '实际会读',
              src.names.length ? src.names.join('、') : '（无）',
            )}${warn}`;
          })(),
          `<div class="std-books">${rows}</div>`,
          auto,
          row2(
            '换卡时自动跟随',
            toggle('scan.followCard', s.scan.followCard, '开着：进哪张卡就读哪张卡绑定的世界书（手动勾选不会带到别的卡上）。关掉则保留你手动选的书'),
          ),
          btnRow([
            { label: '恢复自动', act: 'books-auto' },
            { label: '全选', act: 'books-all' },
            { label: '全不选', act: 'books-none' },
          ]),
          sep(),
          '<div class="std-sec">预算</div>',
          row2('取样正文上限（字）', number('scan.entryCharBudget', s.scan.entryCharBudget, 0, 2000000, 1000), '这本书的总字数是上限；超出部分按优先级取舍'),
          row2('档案字数上限（字）', number('scan.summaryCharBudget', s.scan.summaryCharBudget, 100, 20000, 100)),
          row2('只读条目名（极省）', toggle('scan.commentOnly', s.scan.commentOnly, '不读正文，只拿名字和备注总结。便宜但档案会浅')),
          row2('包含停用条目', toggle('scan.includeDisabled', s.scan.includeDisabled)),
          row2('预览：本次大约会读多少字', `<span class="std-strong">${esc(app.estimateScan())}</span>`),
          sep(),
          '<div class="std-sec">扫描结果</div>',
          statLines,
          btnRow([
            { label: '扫描世界书', act: 'scan', primary: true },
            { label: '清空档案缓存', act: 'clear-profiles' },
          ]),
          sep(),
          '<div class="std-sec">档案内容（可手改）</div>',
          profileEditor(prof),
          btnRow([{ label: '保存档案修改', act: 'save-profile', primary: true }]),
          '<div id="std-scan-log" class="std-result"></div>',
        ].join('');
      },
    },
    {
      id: 'audience',
      label: '观众',
      render: (s) => {
        const vs = app.state.runtime.viewers || [];
        const list = vs.length
          ? vs
              .map(
                (v) =>
                  `<div class="std-viewer"><b>${esc(v.昵称)}</b><span class="std-tag">${esc(v.类型 || '')}</span><span class="std-dim">${esc(
                    v.立场 || '',
                  )}</span>${v.口癖 ? `<span class="std-quote">「${esc(v.口癖)}」</span>` : ''}<span class="std-dim">出现 ${v.出现次数 || 0} 次</span></div>`,
              )
              .join('')
          : '<div class="std-hint">还没有常驻观众。点"生成观众名册"，会按世界观起一批有立场、有口癖的老观众，之后会反复出现。</div>';
        return [
          row2('常驻观众数量', number('audience.poolSize', s.audience.poolSize, 0, 60, 1), '0 = 全部用随机路过的观众'),
          row2('每批最多露脸', number('audience.activePerBatch', s.audience.activePerBatch, 0, 60, 1)),
          sep(),
          '<div class="std-sec">高级</div>',
          row2('破次元度', range('audience.fourthWall', s.audience.fourthWall, 0, 100, 5, '完全本土化 ←→ 大量现实网络梗')),
          '<div class="std-hint">默认偏低：观众按这个世界的语言说话。世界书里没有特定说话方式时，这个滑块影响会变小。</div>',
          sep(),
          '<div class="std-sec">观众名册</div>',
          list,
          btnRow([
            { label: '生成观众名册', act: 'viewers', primary: true },
            { label: '清空名册', act: 'clear-viewers' },
          ]),
        ].join('');
      },
    },
    {
      id: 'look',
      label: '外观',
      render: (s) => {
        const a = s.appearance;
        return [
          '<div class="std-sec">楼层弹幕框</div>',
          row2('启用', toggle('appearance.frameEnabled', a.frameEnabled, '挂在每轮正文下面的一块幕布')),
          row2('背景', text('appearance.frameBackground', a.frameBackground, 'CSS 颜色或渐变')),
          row2('高度（px）', number('appearance.frameHeight', a.frameHeight, 48, 600, 4)),
          row2('字号（px）', number('appearance.fontSize', a.fontSize, 8, 48, 1)),
          row2('速度（px/秒）', number('appearance.speed', a.speed, 20, 900, 5), '越大飞得越快'),
          row2('同轨间隔（px）', number('appearance.gap', a.gap, 0, 200, 1)),
          row2('整体不透明度', range('appearance.opacity', a.opacity, 0.1, 1, 0.05)),
          row2('显示轨道序号', toggle('appearance.showMeta', a.showMeta)),
          row2('播完留静态列表', toggle('appearance.keepStatic', a.keepStatic, '方便往回翻看这一批弹幕')),
          sep(),
          '<div class="std-sec">悬浮弹幕层</div>',
          row2('启用', toggle('appearance.overlayEnabled', a.overlayEnabled, '飘在界面最上层，可拖动、右下角可拉伸')),
          row2('整体透明度', range('appearance.overlayOpacity', a.overlayOpacity, 0.02, 1, 0.02), '要能透出下面的正文'),
          row2('播完自动淡出', toggle('appearance.overlayFade', a.overlayFade)),
          btnRow([
            { label: '重置悬浮层位置', act: 'reset-overlay-rect' },
            { label: '本地预览一批', act: 'demo' },
          ]),
          '<div class="std-hint">悬浮层平时鼠标可以穿透，不挡你点聊天；鼠标移进去才能拖动/拉伸。位置会被记住。</div>',
        ].join('');
      },
    },
    {
      id: 'style',
      label: '风格',
      render: (s) => {
        return [
          '<div class="std-sec">弹幕与剧情的关联</div>',
          row2('读最近几轮正文', number('contextRounds', s.contextRounds, 0, 20, 1), '0 = 不读正文，只按世界观出弹幕'),
          row2('正文总字数上限', number('contextCharBudget', s.contextCharBudget, 0, 200000, 500)),
          row2('历史保留轮数', number('historyKeep', s.historyKeep, 1, 200, 1), '记录页里能看到这些批次'),
          row2(
            '开场白不出弹幕',
            toggle('skipOpening', s.skipOpening, '推荐开着：开场白还没有剧情，观众没什么可说的，也不该被当成弹幕的剧情来源'),
          ),
          sep(),
          '<div class="std-sec">直播模式注入（只有直播模式开着才生效）</div>',
          row2('注入深度', number('injection.depth', s.injection.depth, 0, 100, 1)),
          row2('注入字数上限', number('injection.maxChars', s.injection.maxChars, 40, 4000, 10), '硬上限，保证不吃正文预算'),
          row2('附带几条弹幕样本', number('injection.sampleCount', s.injection.sampleCount, 0, 12, 1)),
          '<div class="std-hint">这条注入是插件伸向正文的唯一通道：它只存在于内存，不写进聊天文件，也不会被世界书扫描到。</div>',
          sep(),
          '<div class="std-sec">调试</div>',
          row2('输出日志提示', toggle('debug', s.debug)),
          row2('本地假数据（不花 API）', toggle('seedDemo', s.seedDemo, '打开后"出一批"会用内置示例弹幕，用来调外观')),
          sep(),
          btnRow([{ label: '恢复默认设置', act: 'reset-settings', danger: true }, { label: '清空弹幕与记录', act: 'clear-all', danger: true }]),
        ].join('');
      },
    },
    {
      id: 'log',
      label: '记录',
      render: (s) => {
        const hist = app.state.runtime.history || [];
        if (!hist.length) return '<div class="std-hint">还没有任何批次。每轮正文生成完会自动出一批（也可以在总览页手动出）。</div>';
        const blocks = hist
          .slice()
          .reverse()
          .map(
            (b) => `
          <div class="std-batch">
            <div class="std-batch-head">
              <b>第 ${b.batchNo} 批</b>
              <span class="std-dim">${new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              <span class="std-dim">楼层 ${b.anchorId}</span>
              <span class="std-dim">${b.items.length} 条</span>
              <button class="std-btn tiny" data-std-act="replay" data-std-batch="${b.batchNo}">重播</button>
            </div>
            <div class="std-batch-items">${b.items
              .map((d) => `<span class="std-chip" style="color:${esc(d.color || 'inherit')}">${esc(d.昵称)}：${esc(d.内容)}</span>`)
              .join('')}</div>
          </div>`,
          )
          .join('');
        return `<div class="std-hint">保留最近 ${s.historyKeep} 轮（在"风格"页可改）。这里只是展示，弹幕不会写进聊天存档。</div>${blocks}`;
      },
    },
  ];
}

/* ───────────── 控件构造 ───────────── */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmt = (n) => {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
};

const sep = () => '<div class="std-sep"></div>';
const row2 = (label, control, hint) =>
  `<div class="std-row"><div class="std-label">${esc(label)}</div><div class="std-ctl">${control}${
    hint ? `<div class="std-hint">${esc(hint)}</div>` : ''
  }</div></div>`;
const kv = (k, v) => `<div class="std-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
const btnRow = (btns) =>
  `<div class="std-btns">${btns
    .map(
      (b) =>
        `<button class="std-btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" data-std-act="${b.act}">${esc(b.label)}</button>`,
    )
    .join('')}</div>`;

const toggle = (path, value, hint) =>
  `<label class="std-toggle"><input type="checkbox" data-std-path="${path}" data-std-type="bool" ${
    value ? 'checked' : ''
  }><span class="std-slider"></span>${hint ? `<span class="std-dim">${esc(hint)}</span>` : ''}</label>`;
const number = (path, value, min, max, step) =>
  `<input class="std-input num" type="number" data-std-path="${path}" data-std-type="number" value="${esc(value)}" min="${min}" max="${max}" step="${step}">`;
const text = (path, value, placeholder) =>
  `<input class="std-input" type="text" data-std-path="${path}" data-std-type="string" value="${esc(value)}" placeholder="${esc(
    placeholder || '',
  )}">`;
const password = (path, value, placeholder) =>
  `<input class="std-input" type="password" data-std-path="${path}" data-std-type="string" value="${esc(value)}" placeholder="${esc(
    placeholder || '',
  )}" autocomplete="off">`;
const textarea = (path, value, placeholder) =>
  `<textarea class="std-input" rows="2" data-std-path="${path}" data-std-type="string" placeholder="${esc(placeholder || '')}">${esc(
    value,
  )}</textarea>`;
const select = (path, value, options, raw) =>
  `<select class="std-input" data-std-path="${path}" data-std-type="string">${options
    .map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${raw ? label : esc(label)}</option>`)
    .join('')}</select>`;
const range = (path, value, min, max, step, hint) =>
  `<div class="std-range"><input type="range" data-std-path="${path}" data-std-type="number" value="${esc(value)}" min="${min}" max="${max}" step="${step}"><span class="std-range-val">${esc(
    value,
  )}</span>${hint ? `<div class="std-hint">${esc(hint)}</div>` : ''}</div>`;

function profileEditor(prof) {
  const d = prof?.data || {};
  const fields = [
    ['worldName', '世界名'],
    ['channelName', '直播间名'],
    ['stage', '舞台与基本样貌'],
    ['factions', '势力与群像'],
    ['naming', '称呼体系'],
    ['lexicon', '本土词汇'],
    ['manner', '语气与措辞'],
    ['taboos', '禁区'],
    ['interests', '观众兴奋点'],
  ];
  return (
    `<div class="std-profile">${fields
      .map(
        ([k, label]) =>
          `<div class="std-row"><div class="std-label">${esc(label)}</div><div class="std-ctl"><textarea class="std-input" rows="2" data-std-profile="${k}">${esc(
            d[k] || '',
          )}</textarea></div></div>`,
      )
      .join('')}</div>`
  );
}

/* ───────────── 面板本体 ───────────── */

export function createPanel(app, { doc = globalThis.document } = {}) {
  let panelEl = null;
  let bodyEl = null;
  let tabEl = null;
  let ballEl = null;
  let activeTab = 'home';
  let refreshTimer = null;
  let boundDoc = null; // 面板当前挂在哪个文档上

  const defs = pages(app);

  /** 挂载点：优先用当前文档，拿不到再退回全局 document */
  function mountDoc() {
    return doc && doc.body ? doc : globalThis.document;
  }

  function build() {
    const d = mountDoc();
    if (!d || !d.body) return;
    // 文档变了（重载 / 多文档环境）就重建，避免拿着已经不属于当前文档的旧节点
    if (boundDoc && boundDoc !== d) {
      panelEl = null;
      bodyEl = null;
      tabEl = null;
      ballEl = null;
    }
    if (d.getElementById(PANEL_ID)) {
      boundDoc = d;
      return;
    }
    boundDoc = d;

    ballEl = d.createElement('div');
    ballEl.id = BALL_ID;
    ballEl.title = '弹幕直播间 · 单击展开设置，可拖动';
    // 不留任何文字：纯渐变小球
    d.body.appendChild(ballEl);

    panelEl = d.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.className = 'std-hidden';
    panelEl.innerHTML = `
      <div class="std-head" data-std-dragpanel="1">
        <span class="std-title">弹幕直播间</span>
        <span class="std-head-status" data-std-status></span>
        <button class="std-btn tiny" data-std-act="batch" title="立刻出一批">出一批</button>
        <button class="std-btn tiny" data-std-act="close">✕</button>
      </div>
      <div class="std-tabs">${defs
        .map((dd) => `<button class="std-tab" data-std-tab="${dd.id}">${esc(dd.label)}</button>`)
        .join('')}</div>
      <div class="std-body"></div>
      <div class="std-foot"><span data-std-foot>就绪</span></div>
    `;
    d.body.appendChild(panelEl);

    bodyEl = panelEl.querySelector('.std-body');
    tabEl = panelEl.querySelector('.std-tabs');

    /* 面板自身的拖动 */
    makeDraggable(panelEl, panelEl.querySelector('[data-std-dragpanel]'), d, 'std_panel_pos');

    /* 悬浮球拖动 */
    makeDraggable(ballEl, ballEl, d, 'std_ball_pos', () => toggle(false));

    panelEl.addEventListener('click', onPanelClick);
    panelEl.addEventListener('input', onFieldInput);
    panelEl.addEventListener('change', onFieldInput);
    const tabs = tabEl;
    const ball = ballEl;
    const styles = d;
    tabs.addEventListener('click', (ev) => {
      const id = ev.target?.getAttribute?.('data-std-tab');
      if (!id) return;
      activeTab = id;
      render();
    });
    ball.addEventListener('click', () => toggle());

    // 建完就先渲染一次：否则首次打开面板会是一片空白（内容只在切换页签时才填）
    render();
  }

  function toggle(open) {
    if (!panelEl) build();
    if (!panelEl) return;
    const want = open === undefined ? panelEl.classList.contains('std-hidden') : !!open;
    panelEl.classList.toggle('std-hidden', !want);
    if (want) {
      render();
      clampIntoView(panelEl, boundDoc);
    }
  }

  function render() {
    if (!panelEl) return;
    const s = app.state.settings;
    [...tabEl.children].forEach((b) => b.classList.toggle('sel', b.getAttribute('data-std-tab') === activeTab));
    const def = defs.find((d) => d.id === activeTab) || defs[0];
    bodyEl.innerHTML = def.render(s);
    updateStatus();
  }

  function updateStatus() {
    const st = app.stats();
    const el = panelEl?.querySelector('[data-std-status]');
    if (el) {
      const bits = [];
      bits.push(st.busy ? '⏳ 进行中' : '✔ 就绪');
      if (app.state.settings.liveMode) bits.push('🔴 直播中');
      bits.push(`${st.batches} 批`);
      el.textContent = bits.join('　');
    }
    const foot = panelEl?.querySelector('[data-std-foot]');
    if (foot) {
      foot.textContent = `${st.card}　|　世界书 ${st.worldbooksUsed.length}/${st.worldbooksAvailable}　|　${st.profile ? '档案已就绪' : '档案未生成'}`;
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (panelEl && !panelEl.classList.contains('std-hidden')) render();
      else updateStatus();
    }, 120);
  }

  /* 事件订阅：任何状态变化都尽量反映到面板 */
  ['settings', 'batch', 'profile', 'viewers', 'busy', 'error', 'chat', 'card', 'cleared', 'scan'].forEach((evt) =>
    app.on(evt, scheduleRefresh),
  );

  /* ───────────── 交互 ───────────── */

  async function onPanelClick(ev) {
    const btn = ev.target?.closest?.('[data-std-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-std-act');
    const batchNo = btn.getAttribute('data-std-batch');

    switch (act) {
      case 'close':
        toggle(false);
        break;
      case 'batch': {
        btn.disabled = true;
        const res = await app.runBatch({ manual: true });
        btn.disabled = false;
        if (!res.ok) setResult('std-api-result', `❌ ${res.error}`);
        else setResult('std-api-result', `✅ 已出 ${res.batch.items.length} 条`);
        render();
        break;
      }
      case 'demo': {
        app.renderDemo(app.state.settings.count);
        break;
      }
      case 'replay-last': {
        const last = app.state.runtime.history[app.state.runtime.history.length - 1];
        if (last) app.replayBatch(last.batchNo);
        else setResult('std-api-result', '还没有可重播的批次');
        break;
      }
      case 'replay': {
        if (batchNo) app.replayBatch(Number(batchNo));
        break;
      }
      case 'scan': {
        btn.disabled = true;
        setResult('std-scan-log', '⏳ 正在扫描…');
        const res = await app.scan();
        setResult('std-scan-log', res.ok ? `✅ 档案完成：${res.profile.stats.summaryChars} 字` : `❌ ${res.error}`);
        btn.disabled = false;
        render();
        break;
      }
      case 'viewers': {
        btn.disabled = true;
        const res = await app.buildViewers();
        if (!res.ok) setResult('std-api-result', `❌ ${res.error}`);
        btn.disabled = false;
        render();
        break;
      }
      case 'clear-viewers':
        app.state.runtime.viewers = [];
        app.persistRuntime();
        render();
        break;
      case 'clear-profiles': {
        const cacheKey = app.stats().profileKey;
        app.clearProfileCache?.();
        setResult('std-scan-log', `已清空档案缓存（当前键：${cacheKey}）`);
        render();
        break;
      }
      case 'save-profile': {
        const patch = collectProfileEdits();
        if (app.state.profile) {
          app.state.profile.data = { ...app.state.profile.data, ...patch };
          app.persistProfile?.();
          setResult('std-scan-log', '✅ 档案修改已保存');
        }
        break;
      }
      case 'books-auto':
        app.updateSettings({ scan: { sources: null } });
        render();
        break;
      case 'books-all':
        app.updateSettings({ scan: { sources: app.listAllWorldbooks() } });
        render();
        break;
      case 'books-none':
        app.updateSettings({ scan: { sources: [] } });
        render();
        break;
      case 'test-api': {
        btn.disabled = true;
        setResult('std-api-result', '⏳ 正在测试…');
        const out = await app.testApi?.();
        setResult('std-api-result', out?.ok ? `✅ ${out.message}` : `❌ ${out?.message || '测试失败'}`);
        btn.disabled = false;
        break;
      }
      case 'list-models': {
        btn.disabled = true;
        setResult('std-api-result', '⏳ 正在拉取…');
        const out = await app.listModels?.();
        setResult(
          'std-api-result',
          out?.ok ? `✅ ${out.models.length} 个模型：${out.models.slice(0, 40).join('、')}` : `❌ ${out?.error || '拉取失败'}`,
        );
        btn.disabled = false;
        break;
      }
      case 'reset-overlay-rect':
        app.updateSettings({ appearance: { overlayRect: { x: 0.06, y: 0.08, w: 0.88, h: 0.2 } } });
        render();
        break;
      case 'reset-settings':
        if (confirm('恢复默认设置？（档案与观众名册不受影响）')) app.resetSettings();
        render();
        break;
      case 'clear-all':
        if (confirm('清空页面上所有弹幕框、悬浮层内容与历史记录？（设置不受影响）')) {
          app.clearAll();
          render();
        }
        break;
      default:
        break;
    }
  }

  function onFieldInput(ev) {
    const el = ev.target;
    if (!el) return;

    // 世界书勾选：严格判断（空名字的书也要能勾），并且 click 也要兜一次，
    // 因为某些环境下 change 事件不一定会到达委托的父节点
    const book = el.getAttribute?.('data-std-book');
    if (book !== null && book !== undefined) {
      if (ev.type === 'click' && ev.target !== el) return;
      applyBookSelection();
      return;
    }

    const path = el.getAttribute?.('data-std-path');
    if (!path) return;

    const type = el.getAttribute('data-std-type') || 'string';
    let value;
    if (type === 'bool') value = typeof el.checked === 'boolean' ? el.checked : el.getAttribute('checked') !== null;
    else if (type === 'number') {
      const raw = typeof el.value === 'string' && el.value !== '' ? el.value : el.getAttribute('value');
      value = Number(raw);
      if (!Number.isFinite(value)) return; // 清空输入框时不要写坏设置
    } else value = typeof el.value === 'string' ? el.value : el.getAttribute('value') ?? '';

    app.updateSettings(setPath({}, path, value), { silent: true });

    // 滑块旁边的数字实时更新
    if ((el.getAttribute('type') || el.type) === 'range') {
      const out = el.parentElement?.querySelector('.std-range-val');
      if (out) out.textContent = String(value);
    }
    // 需要整页重绘的控件（切换路线 / 开关联动）即时刷新
    if (type === 'bool' || path === 'api.route') render();
    else updateStatus();
  }

  /** 把世界书勾选写回设置（勾了任意一本 = 切到手动模式） */
  function applyBookSelection() {
    const names = [...panelEl.querySelectorAll('[data-std-book]')]
      .filter((n) => (typeof n.checked === 'boolean' ? n.checked : n.getAttribute('checked') !== null))
      .map((n) => n.getAttribute('data-std-book'))
      .filter((n) => n !== null && n !== undefined);
    app.updateSettings({ scan: { sources: names } }, { silent: true });
    render();
  }

  function collectProfileEdits() {
    const out = {};
    panelEl.querySelectorAll('[data-std-profile]').forEach((el) => {
      out[el.getAttribute('data-std-profile')] = el.value;
    });
    return out;
  }

  function setResult(id, text) {
    const el = panelEl?.querySelector(`#${id}`);
    if (el) el.textContent = text;
    else if (text) app.emit('notice', text);
  }

  return { build, toggle, render, scheduleRefresh, get el() { return panelEl; } };
}

/* ───────────── 通用小工具 ───────────── */

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

function makeDraggable(target, handle, doc, storageKey, onClickOnly) {
  if (!target || !handle) return;
  const win = doc.defaultView || globalThis;
  let drag = null;
  let moved = false;

  try {
    const saved = JSON.parse(win.localStorage.getItem(storageKey) || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      target.style.left = `${saved.left}px`;
      target.style.top = `${saved.top}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';
    }
  } catch {
    /* noop */
  }

  handle.addEventListener('pointerdown', (ev) => {
    const r = target.getBoundingClientRect();
    drag = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top };
    moved = false;
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
  });

  function onMove(ev) {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    const vw = win.innerWidth || 1280;
    const vh = win.innerHeight || 800;
    const w = target.offsetWidth;
    const h = target.offsetHeight;
    const left = Math.max(0, Math.min(vw - w, drag.left + dx));
    const top = Math.max(0, Math.min(vh - h, drag.top + dy));
    target.style.left = `${Math.round(left)}px`;
    target.style.top = `${Math.round(top)}px`;
    target.style.right = 'auto';
    target.style.bottom = 'auto';
    if (typeof onClickOnly === 'function') target.__stdDragged = true;
  }

  function onUp() {
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    if (drag && moved) {
      try {
        win.localStorage.setItem(storageKey, JSON.stringify({ left: target.offsetLeft, top: target.offsetTop }));
      } catch {
        /* noop */
      }
    }
    drag = null;
    setTimeout(() => {
      target.__stdDragged = false;
    }, 0);
  }

  if (typeof onClickOnly === 'function') {
    handle.addEventListener('click', (ev) => {
      if (target.__stdDragged) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    });
  }
}

function clampIntoView(el, doc) {
  const win = doc.defaultView || globalThis;
  const r = el.getBoundingClientRect();
  const vw = win.innerWidth || 1280;
  const vh = win.innerHeight || 800;
  if (r.right > vw || r.bottom > vh || r.left < 0 || r.top < 0) {
    el.style.left = `${Math.max(8, Math.min(vw - r.width - 8, r.left))}px`;
    el.style.top = `${Math.max(8, Math.min(vh - r.height - 8, r.top))}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
}

export const _internal = { esc, fmt, setPath, makeDraggable };
