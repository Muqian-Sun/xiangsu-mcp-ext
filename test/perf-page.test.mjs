import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');
const { PAGE_TIMING } = require('../editor-plugin/features/delivery.cjs');
const { SOURCE_URL } = require('../editor-plugin/features/webpages.cjs');

Object.assign(PAGE_TIMING, { stepMs: 300, closeMs: 300 });

class Bus {
  constructor() {
    this.handlers = new Map();
  }
  on(e, f) {
    this.handlers.set(e, [...(this.handlers.get(e) || []), f]);
  }
  off(e, f) {
    this.handlers.set(e, (this.handlers.get(e) || []).filter((x) => x !== f));
  }
  emit(e, ...args) {
    for (const f of this.handlers.get(e) || []) f(...args);
  }
}

const item = (name, rows = [], help = false) =>
  `<div class="effect-test-item"><div class="effect-test-item-top"><div class="effect-test-item-top-content"><img><div class="effect-test-item-top-text">${name}</div>${help ? '<img class="effect-test-item-top-help">' : ''}</div><img class="effect-test-item-top-icon"></div>${
    rows.length
      ? `<div class="effect-test-item-bottom">${rows.map(([v, l, pass]) => `<div class="effect-test-item-bottom-item"><img class="effect-test-item-bottom-item-img"><span class="effect-test-item-bottom-text${pass ? ' effect-test-item-bottom-text-pass' : ''}">${v}</span><span>/${l}</span></div>`).join('')}</div>`
      : ''
  }</div>`;

// The live 特效检测 page of 2026-11-07 (passed), and the same page with a failed performance check whose
// advice, like the real Semi popover, is only in the DOM while its help icon is hovered.
const PASSED = `<div class="perf-top"><img class="status-icon"><div class="status-title">检测通过</div></div><div class="effect-test-container"><div>${[
  item('包体积检测通过', [['0.1MB', '8.0MB', true]]),
  item('性能检测通过', [['26FPS', '12.5FPS', true], ['26FPS', '13FPS', true]]),
  item('特效相似度检测通过'),
].join('')}</div></div>`;
const FAILED = `<div class="perf-top"><img class="status-icon"><div class="status-title">特效不通过</div></div><div class="effect-test-container"><div>${[
  item('包体积检测通过', [['0.1MB', '8.0MB', true]]),
  item('性能检测不通过', [['9FPS', '12.5FPS', false], ['26FPS', '13FPS', true]], true),
].join('')}</div></div>`;
const ADVICE = '帧率低在中低端机型会出现卡顿，请尝试压缩图片尺寸分辨率';

function perfPage(body, { popover = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"><div class="perf-container"><div class="perf-main">${body}<div class="perf-button"><div class="button">确定</div></div></div></div></div></body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  if (popover) {
    for (const help of window.document.querySelectorAll('.effect-test-item-top-help')) {
      let tip = null;
      help.addEventListener('mouseover', () => {
        tip = window.document.createElement('div');
        tip.className = 'effect-test-item-top-help-content';
        tip.innerHTML = `<div class="effect-test-item-top-help-content-text">${ADVICE}</div>`;
        setTimeout(() => window.document.body.appendChild(tip), 20);
      });
      help.addEventListener('mouseout', () => tip && tip.remove());
    }
  }
  return window;
}

// A fake editor whose 特效检测 API opens a window showing `page` and reports `status` a moment later.
function editor(page, { status = 1 } = {}) {
  const business = new Bus();
  const sources = [];
  globalThis.App = { _windows: [{ constructor: { name: 'MainWindow' }, isClosed: false }] };
  class DYEHPerfTestWebWindow {
    constructor() {
      const handlers = new Map();
      this.isClosed = false;
      this.JSB = { joinRegisterHandler: (scope, h) => handlers.set(scope, h) };
      this.webview = {
        evaluateJavascript: (code, source) => {
          sources.push(source);
          assert.equal(typeof source, 'string', 'a non-string second argument crashes the editor');
          page.eval(code);
        },
      };
      page.orionQuery = ({ request }) => {
        const m = /^orionJSB:\/\/([^/]+)\/([^?]+)\?(.*)$/.exec(request);
        handlers.get(m[1])[m[2]](JSON.parse(decodeURIComponent(m[3])));
      };
    }
    closeWindow() {
      setTimeout(() => (this.isClosed = true), 5);
    }
  }
  const perfApi = {
    showWindow: () => {
      globalThis.App._windows.push(new DYEHPerfTestWebWindow());
      setTimeout(() => business.emit('getPerfTestStatus', status), 5);
    },
  };
  const modules = {
    [M.ef]: {
      ProjectManager: { getInstance: () => ({ getActiveProject: () => ({ path: '/proj' }) }) },
      Resource: { EditorFoundation: { env: { getInstancePath: () => '/inst' } } },
    },
    [M.orionui]: { ExtensionManager: { host: { getAPI: (key) => (key === 'perfKey' ? perfApi : {}) } } },
    [M.submission]: { EffectSubmissionAPIKey: 'submitKey' },
    [M.perfTest]: { PerfTestAPIKey: 'perfKey' },
    [M.events]: { BusinessEventManager: { TypeGuard: () => business } },
    [M.login]: { loginContribution: { getLoginStatus: async () => ({ isLoggedIn: true }) } },
    [M.remoteAssets]: { RemoteAssetManager: { getInstance: () => ({}) } },
  };
  const lib = new Library((n) => {
    if (!(n in modules)) throw Error(`MODULE_NOT_FOUND: ${n}`);
    return modules[n];
  });
  const open = () => globalThis.App._windows.filter((w) => w.constructor.name === 'DYEHPerfTestWebWindow' && !w.isClosed);
  return { lib, sources, open };
}

test('effect_check reads the verdict and every check with its figures, then closes the window', async () => {
  const { lib, sources, open } = editor(perfPage(PASSED));
  const out = await lib.effectCheck({ timeout_ms: 1000 });
  assert.deepEqual(out, {
    finished: true,
    status_code: 1,
    result: 'passed',
    closed_previous: 0,
    verdict: '检测通过',
    checks: [
      { name: '包体积检测通过', figures: [{ value: '0.1MB', limit: '8.0MB', passed: true }] },
      {
        name: '性能检测通过',
        figures: [
          { value: '26FPS', limit: '12.5FPS', passed: true, platform: 'android' },
          { value: '26FPS', limit: '13FPS', passed: true, platform: 'ios' },
        ],
      },
      { name: '特效相似度检测通过' },
    ],
    window_closed: true,
  });
  assert.ok(sources.length && sources.every((s) => s === SOURCE_URL));
  assert.equal(open().length, 0);
});

test('effect_check hovers a failed check to read the advice that only shows in its popup', async () => {
  const { lib } = editor(perfPage(FAILED), { status: 2 });
  const out = await lib.effectCheck({ timeout_ms: 1000 });
  assert.equal(out.result, 'not_passed');
  assert.equal(out.verdict, '特效不通过');
  assert.deepEqual(out.checks[1], {
    name: '性能检测不通过',
    figures: [
      { value: '9FPS', limit: '12.5FPS', passed: false, platform: 'android' },
      { value: '26FPS', limit: '13FPS', passed: true, platform: 'ios' },
    ],
    advice: ADVICE,
  });
  assert.equal(out.checks[0].advice, undefined, 'a passed check has no help icon');
});

test('effect_check says so when a help popup does not open, and still returns the rest', async () => {
  const { lib } = editor(perfPage(FAILED, { popover: false }), { status: 2 });
  const out = await lib.effectCheck({ timeout_ms: 1000 });
  assert.match(out.checks[1].advice_unavailable, /help popup did not open in 300 ms/);
  assert.equal(out.checks[1].advice, undefined);
  assert.equal(out.window_closed, true);
});

test('effect_check leaves the window open when the page details cannot be read', async () => {
  const { lib, open } = editor(perfPage('<div class="perf-top"></div>'));
  const out = await lib.effectCheck({ timeout_ms: 1000 });
  assert.equal(out.result, 'passed');
  assert.equal(out.window_closed, false);
  assert.match(out.details_error, /PERF_PAGE_CHANGED: .*left open to read there/);
  assert.equal(open().length, 1);
});
