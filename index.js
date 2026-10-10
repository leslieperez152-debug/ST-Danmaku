/**
 * index.js — 扩展入口
 *
 * 酒馆加载扩展时会执行这个文件（manifest.json 里的 "js": "index.js"）。
 * 这里做四件事：等酒馆就绪 → 建 app → 建悬浮球面板 → 把设置栏挂进扩展面板。
 * 真正的逻辑都在 src/ 下，方便单独测试。
 */

import { createApp } from './src/main.js';
import { createPanel } from './src/panel.js';
import { createDrawer } from './src/drawer.js';
import { toast } from './src/st.js';

const GLOBAL_KEY = '__ST_DANMAKU__';

function boot() {
  // 热重载 / 重复加载：先把旧实例清掉，避免两个悬浮球抢事件
  if (globalThis[GLOBAL_KEY]) {
    try {
      globalThis[GLOBAL_KEY].destroy?.();
    } catch {
      /* noop */
    }
    try {
      globalThis.document?.getElementById('std-ball')?.remove();
      globalThis.document?.getElementById('std-panel')?.remove();
    } catch {
      /* noop */
    }
  }

  const app = createApp();
  app.init();

  const panel = createPanel(app);
  panel.build();

  // 扩展面板里的设置栏（酒馆「扩展」区域那一栏）
  const drawer = createDrawer(app);
  drawer.mount();
  // 挂载点可能比扩展加载得晚，稍后补挂几次
  let tries = 0;
  const retry = setInterval(() => {
    tries += 1;
    if (drawer.el || tries > 20) {
      clearInterval(retry);
      return;
    }
    drawer.mount();
  }, 500);

  // 悬浮球面板订阅"从别处打开完整设置"的请求
  app.on('open-panel', () => panel.toggle(true));

  globalThis[GLOBAL_KEY] = {
    app,
    panel,
    drawer,
    destroy: () => {
      clearInterval(retry);
      drawer.unmount();
      app.destroy();
    },
  };

  if (app.state.settings.debug) {
    toast('弹幕直播间已加载：扩展面板里的「弹幕直播间」栏，或右下角「弹」字球', 'info');
  }
  return app;
}

/** 等酒馆的上下文可用再启动；最多等 ~15 秒，超时也照常启动（会退化成"无卡模式"）。 */
function waitForTavern(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const ok =
        typeof SillyTavern !== 'undefined' &&
        typeof SillyTavern.getContext === 'function' &&
        !!SillyTavern.getContext()?.eventSource;
      if (ok || Date.now() - start > timeoutMs) {
        resolve(ok);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function start() {
  const run = () => {
    try {
      boot();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[弹幕直播间] 启动失败', e);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

(async () => {
  await waitForTavern();
  start();
})();
