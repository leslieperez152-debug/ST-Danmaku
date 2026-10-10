/**
 * index.js — 扩展入口
 *
 * 酒馆加载扩展时会执行这个文件（manifest.json 里的 "js": "index.js"）。
 * 这里只做三件事：等酒馆就绪 → 建 app → 建面板。
 * 真正的逻辑都在 src/ 下，方便单独测试。
 */

import { createApp } from './src/main.js';
import { createPanel } from './src/panel.js';
import { toast } from './src/st.js';

const GLOBAL_KEY = '__ST_DANMAKU__';

function boot() {
  if (globalThis[GLOBAL_KEY]) {
    // 热重载 / 重复加载：先清掉旧的，避免两个实例抢同一个悬浮球
    try {
      globalThis[GLOBAL_KEY].destroy?.();
      globalThis[GLOBAL_KEY].panel?.el?.remove();
      globalThis.document?.getElementById('std-ball')?.remove();
    } catch {
      /* noop */
    }
  }

  const app = createApp();
  app.init();
  const panel = createPanel(app);
  panel.build();
  globalThis[GLOBAL_KEY] = { app, panel, destroy: () => app.destroy() };

  // 插件状态挂到酒馆的扩展设置上，方便别处查（可选的便利，不影响功能）
  try {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
      const ctx = SillyTavern.getContext();
      if (ctx?.extensionSettings) {
        ctx.extensionSettings.st_danmaku = ctx.extensionSettings.st_danmaku || { version: '0.1.0' };
      }
    }
  } catch {
    /* noop */
  }

  if (app.state.settings.debug) {
    toast('弹幕直播间已加载：右下角"弹"字球打开设置', 'info');
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

(async () => {
  try {
    const ok = await waitForTavern();
    if (!ok) {
      // 酒馆还没就绪：不报错，等 DOM 好了再试一次
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
      return;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[弹幕直播间] 启动失败', e);
  }
})();
