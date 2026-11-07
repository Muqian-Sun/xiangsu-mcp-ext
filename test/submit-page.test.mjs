import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');
const { PAGE_TIMING } = require('../editor-plugin/features/delivery.cjs');
const { BRIDGE_SCOPE, SOURCE_URL } = require('../editor-plugin/features/webpages.cjs');

Object.assign(PAGE_TIMING, { readyMs: 3000, quietMs: 100, pollMs: 20, settleMs: 30, stepMs: 500, checksMs: 1500, closeMs: 300 });

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

// The live submit page of 2026-11-07, reduced to the classes and labels the plugin reads, with just
// enough behaviour: tasks are picked on mouseup only, the name keeps 10 characters, emoji are refused,
// icons without an upload block the first step, and the aiName config request wipes the name field.
function fakePage(options = {}) {
  const o = {
    settingsStep: true,
    iconsUploaded: true,
    collected: ['国风古风花钿妆', '甜妹繁花花环'],
    searchable: ['冬日国风边框'],
    tasks: ['征集最新自拍玩法', '创新滤镜开放赛'],
    tracked: { 'AI 赛道征集': ['图片赛道', '视频赛道'] },
    inspirationTask: {},
    configAt: 0,
    configUrl: 'https://effect.douyin.com/platform/v1/t_conf?key=aiName&app=2',
    trickle: false,
    nextLabel: '下一步',
    agreed: true,
    checksPass: true,
    answer: true,
    extraBasic: '',
    extraSettings: '',
    ...options,
  };
  const steps = o.settingsStep ? ['特效基础信息', '特效发布设置', '提交审核'] : ['特效基础信息', '提交审核'];
  const title = (t) => `<div class="section-title"><div class="title-main">${t}<span class="dot-red">*</span></div></div>`;
  const input = (cls, t, placeholder) => `<div class="${cls}">${title(t)}<div class="input-wrapper"><input placeholder="${placeholder}" value=""><div class="item-counter">0/10</div><div class="text-err"></div></div></div>`;
  const selector = (id, t, text, search) =>
    `<div class="bind-wrapper" id="${id}">${title(t)}<div class="selector-container" tabindex="-1"><div class="selector-input"><div class="text">${text}</div></div><div class="selector-list hidden"><div class="dropdown-container">${search ? '<div class="search-container"><input class="search-input" type="text" value=""></div>' : ''}<div class="favor-list"></div></div></div></div></div>`;
  const html = `<!doctype html><html><body><div id="root"><div class="submit-wrap">
<header class="nav-wrap">${steps.map((s, i) => `<div class="nav-item${i === 0 ? ' active' : ''}"><div class="nav-item-text">${s}</div></div>`).join('')}</header>
<main><div class="content show"><div class="content-left">
<div style="display: block;" data-step="0">
<div class="upload-icon-wrapper">${title('特效图标')}<div class="icon-wrapper"><div class="icon-content"><div class="icon-bottom female"><div class="finish"><img class="icon"></div></div></div><div class="icon-content"><div class="icon-bottom male"><div class="finish"><img class="icon"></div></div></div><div class="text-err"></div></div></div>
<div class="default-camera-wrapper">${title('默认摄像头方向')}<div class="radio-wrapper"><label class="semi-radio semi-radio-checked"><span>前置</span></label><label class="semi-radio"><span>后置</span></label></div></div>
${input('name-wrapper', '特效名称', '示例：纯色海报')}${input('trigger-wrapper', '特效触发提示', '非必填项')}${o.extraBasic}
</div>
${o.settingsStep ? `<div style="display: none;" data-step="1">${selector('insp', '灵感绑定', '选择收藏的灵感或热点', true)}${selector('task', '任务绑定', '选择任务', false)}${o.extraSettings}</div>` : ''}
</div></div>
<div class="publish-wrap" style="display: none;"><div class="submit-title"><h1>特效审核中</h1></div><div class="effect-content"></div><div class="effect-test-container"></div></div>
</main>
<footer><div class="btn-wrapper"><div class="button"><div class="btn-content">取消</div></div><div class="button next"><div class="btn-content">${o.nextLabel}</div></div></div></footer>
</div></div></body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const d = window.document;
  const $ = (s, root = d) => root.querySelector(s);
  const $$ = (s, root = d) => [...root.querySelectorAll(s)];
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

  const requests = [];
  window.performance.getEntriesByType = (type) => (type === 'resource' ? requests.slice() : []);
  let trickle = o.trickle ? window.setInterval(() => requests.push({ name: 'https://log' }), 15) : null;
  const name = $('.name-wrapper input');
  window.setTimeout(() => {
    requests.push({ name: o.configUrl });
    window.clearInterval(trickle);
    // The real page remounts the name field here, dropping what was typed.
    setValue.call(name, '');
  }, o.configAt);

  for (const wrapper of $$('.name-wrapper, .trigger-wrapper')) {
    const el = $('input', wrapper);
    el.addEventListener('input', () => {
      const chars = [...el.value];
      if (chars.length > 10) setValue.call(el, chars.slice(0, 10).join(''));
      $('.text-err', wrapper).textContent = /\p{Extended_Pictographic}/u.test(el.value) ? '请勿输入表情与特殊符号' : '';
    });
  }
  for (const label of $$('.default-camera-wrapper label')) {
    label.addEventListener('click', () => $$('.default-camera-wrapper label').forEach((l) => l.classList.toggle('semi-radio-checked', l === label)));
  }

  let step = 0;
  let inspiration = null;
  const show = (i) => {
    step = i;
    $$('header .nav-item').forEach((n, k) => n.classList.toggle('active', k === i));
    $$('[data-step]').forEach((s) => (s.style.display = Number(s.dataset.step) === i ? 'block' : 'none'));
    if (steps[i] !== '提交审核') return;
    const hint = $('.trigger-wrapper input').value;
    $('.publish-wrap').style.display = 'block';
    $('.effect-content').innerHTML = `<div class="effect-content-item">特效名称：${name.value}</div><div class="effect-content-item">特效触发提示：${hint || '无'}</div>`;
    $('.effect-test-container').innerHTML = '<div class="effect-test-item-top-text">包体积检测通过</div><div class="effect-test-item-top-text">性能检测中...</div>';
    const next = $('footer .button.next');
    next.className = 'button next disable';
    $('.btn-content', next).textContent = '提交审核';
    $('footer').insertAdjacentHTML('beforeend', `<div class="ip-agreement">${o.agreed ? '<span class="agreed">已阅读并同意</span>' : '<span>同意</span>'}</div>`);
    window.setTimeout(() => {
      $$('.effect-test-item-top-text')[1].textContent = o.checksPass ? '性能检测通过' : '性能检测未通过';
      $('.submit-title h1').textContent = o.checksPass ? '检测通过' : '检测未通过';
      if (o.checksPass && o.agreed) next.classList.remove('disable');
    }, 100);
  };
  $('footer .button.next').addEventListener('click', () => {
    if (steps[step] === '特效基础信息') {
      if (!o.iconsUploaded) return void ($('.upload-icon-wrapper .text-err').textContent = '请至少上传一个图标');
      if (!name.value) return void ($('.name-wrapper .text-err').textContent = '请输入特效名称');
    }
    if (step < steps.length - 1) show(step + 1);
  });

  const insp = $('#insp');
  const task = $('#task');
  if (insp) {
    const list = $('.favor-list', insp);
    const render = (names, note = '') =>
      (list.innerHTML = note + ['暂不绑定', ...names].map((n) => `<div class="favor-option"><div class="option-name">${n}</div></div>`).join(''));
    render(o.collected);
    $('.selector-input', insp).addEventListener('mousedown', () => $('.selector-list', insp).classList.toggle('hidden'));
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.favor-option');
      if (!opt) return;
      inspiration = opt.textContent.trim();
      $('.selector-input .text', insp).textContent = inspiration;
      $('.selector-list', insp).classList.add('hidden');
    });
    const search = $('.search-input', insp);
    search.addEventListener('input', () => {
      render([], '<div class="empty-list">搜索中...</div>');
      window.setTimeout(() => {
        const found = [...o.collected, ...o.searchable].filter((n) => n.includes(search.value));
        if (found.length) render(found);
        else render(o.collected, '<div class="empty-list">暂无搜索结果</div>');
      }, 60);
    });
  }
  if (task) {
    const list = $('.favor-list', task);
    list.innerHTML =
      ['暂不参与', ...o.tasks].map((t) => `<div class="favor-option"><div class="option-name">${t}</div></div>`).join('') +
      Object.keys(o.tracked)
        .map((t) => `<div class="selector-list-track"><div class="selector-list-track-item"><div class="selector-list-track-item-title">${t}<div class="arrow down"></div></div><div class="selector-list-track-item-list"></div></div></div>`)
        .join('');
    $('.selector-input', task).addEventListener('mousedown', () => $('.selector-list', task).classList.toggle('hidden'));
    const pick = (shown, picked) => {
      $('.selector-input .text', task).textContent = shown;
      if (inspiration && o.inspirationTask[inspiration] && o.inspirationTask[inspiration] !== picked) {
        inspiration = null;
        $('.selector-input .text', insp).textContent = '选择收藏的灵感或热点';
      }
    };
    list.addEventListener('mouseup', (e) => {
      const opt = e.target.closest('.favor-option');
      const info = e.target.closest('.selector-list-track-item-info');
      if (opt) pick(opt.textContent.trim(), opt.textContent.trim());
      if (info) {
        const t = info.closest('.selector-list-track-item').querySelector('.selector-list-track-item-title').textContent.trim();
        pick(`${t}/${info.textContent.trim()}`, t);
      }
    });
    list.addEventListener('click', (e) => {
      const head = e.target.closest('.selector-list-track-item-title');
      if (!head) return;
      const item = head.closest('.selector-list-track-item');
      $('.selector-list-track-item-list', item).innerHTML = o.tracked[head.textContent.trim()]
        .map((tr) => `<div class="selector-list-track-item-info"><div class="selector-list-track-item-info-title">${tr}</div></div>`)
        .join('');
    });
  }
  return { window, o };
}

// A fake editor whose SubmitEffect opens a new window showing `page` (added to App._windows, as the
// editor's windows are), bridged the way the real webview and JS bridge are: scripts go in through
// evaluateJavascript, answers come back as orionJSB:// queries.
function editor(page, { windowName = 'DYEHEffectSubmissionWindow', left = [] } = {}) {
  const business = new Bus();
  const legacy = new Bus();
  globalThis.App = { _windows: [{ constructor: { name: 'MainWindow' }, isClosed: false }, ...left] };
  const sources = [];
  const handlers = new Map();
  const Win = {
    [windowName]: class {
      constructor() {
        this.isClosed = false;
      }
      closeWindow() {
        setTimeout(() => (this.isClosed = true), 5);
      }
    },
  }[windowName];
  business.on('SubmitEffect', () => {
    const win = new Win();
    globalThis.App._windows.push(win);
    win.JSB = { joinRegisterHandler: (scope, h) => handlers.set(scope, { ...handlers.get(scope), ...h }) };
    win.webview = {
      evaluateJavascript: (code, source) => {
        sources.push(source);
        assert.equal(typeof source, 'string', 'a non-string second argument crashes the editor');
        page.window.eval(code);
      },
    };
    page.window.orionQuery = ({ request }) => {
      const m = /^orionJSB:\/\/([^/]+)\/([^?]+)\?(.*)$/.exec(request);
      if (page.o.answer) handlers.get(m[1])[m[2]](JSON.parse(decodeURIComponent(m[3])));
    };
    legacy.emit('OnSubmitWindowOpened', 1, 0);
  });
  const modules = {
    [M.events]: { BusinessEventManager: { TypeGuard: () => business } },
    [M.ef]: { EventManager_deprecated: { TypeGuard: () => legacy } },
  };
  const lib = new Library((n) => {
    if (!(n in modules)) throw Error(`MODULE_NOT_FOUND: ${n}`);
    return modules[n];
  });
  lib.submitChecks = async () => ({ ok: true, issues: [] });
  const open = () => globalThis.App._windows.filter((w) => w.constructor.name === windowName && !w.isClosed);
  return { lib, sources, handlers, open };
}

const fill = { name: '测试特效名', trigger_hint: '张嘴试试', camera: 'back', inspiration: '国风古风花钿妆', task: '征集最新自拍玩法' };

test('submit_prepare fills every step, reads it back and stops on 提交审核 once the checks are done', async () => {
  const page = fakePage({ trickle: true, configAt: 120 });
  const { lib, sources, handlers, open } = editor(page);
  const out = await lib.submitPrepare(fill);
  assert.equal(out.opened, true);
  assert.equal(out.step, '提交审核');
  assert.deepEqual(out.filled, { icons: { female: true, male: true }, name: '测试特效名', trigger_hint: '张嘴试试', camera: '后置' });
  assert.deepEqual(out.bindings, { inspiration: '国风古风花钿妆', task: '征集最新自拍玩法' });
  assert.deepEqual(out.other_sections, []);
  assert.equal(out.review.name, '测试特效名', 'typed after the name config arrived, so it survived');
  assert.deepEqual(out.review.checks, ['包体积检测通过', '性能检测通过'], 'waited for the checks');
  assert.equal(out.review.submit_enabled, true);
  assert.equal(out.review.agreed, true);
  assert.match(out.next, /press 提交审核/);
  assert.ok(sources.length > 0 && sources.every((s) => s === SOURCE_URL));
  assert.ok(handlers.has(BRIDGE_SCOPE));
  assert.equal(out.closed_previous, 0);
  assert.equal(open().length, 1, 'the filled window stays open');
  assert.ok(!page.window.document.querySelector('footer .button.next').classList.contains('disable'), 'left for the user to press');
});

test('submit_prepare keeps fields it is not given as the page shows them', async () => {
  const { lib } = editor(fakePage());
  const out = await lib.submitPrepare({ name: '只填名字' });
  assert.deepEqual(out.filled, { icons: { female: true, male: true }, name: '只填名字', trigger_hint: '', camera: '前置' });
  assert.deepEqual(out.bindings, { inspiration: '选择收藏的灵感或热点', task: '选择任务' });
  assert.equal(out.review.trigger_hint, '无');
});

test('the summary check catches a name the page wiped after it was typed', async () => {
  // No aiName request to wait for, and the page goes quiet before the remount.
  const { lib } = editor(fakePage({ configUrl: 'https://effect.douyin.com/other', configAt: 400 }));
  await assert.rejects(lib.submitPrepare(fill), /SUBMIT_REVIEW_MISMATCH: the summary shows 名称「」.*left open/);
});

test('submit_prepare fails on a name or hint the page cuts or refuses', async () => {
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ name: '这个特效名称明显超过十个字' }), /SUBMIT_NAME_REJECTED: the page kept 「这个特效名称明显超过」/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ name: '表情😀名' }), /SUBMIT_FIELD_REJECTED; the page says: 请勿输入表情与特殊符号/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ name: '好名字', trigger_hint: '这句触发提示远远超过了十个字' }), /SUBMIT_TRIGGER_HINT_REJECTED/);
});

test('submit_prepare reports a step the page will not leave, with the page text', async () => {
  await assert.rejects(
    editor(fakePage({ iconsUploaded: false })).lib.submitPrepare(fill),
    /SUBMIT_STEP_BLOCKED: 「特效基础信息」 did not move on; the page says: 请至少上传一个图标; set the icon with icon_set/,
  );
});

test('submit_prepare finds an inspiration outside the loaded list through the search box', async () => {
  const { lib } = editor(fakePage());
  const out = await lib.submitPrepare({ ...fill, inspiration: '冬日国风边框' });
  assert.equal(out.bindings.inspiration, '冬日国风边框');
  await assert.rejects(
    editor(fakePage()).lib.submitPrepare({ ...fill, inspiration: '不存在的灵感' }),
    /SUBMIT_OPTION_NOT_FOUND: 灵感绑定 has no 「不存在的灵感」.*searching it gave 暂无搜索结果; it lists: 暂不绑定 \| 国风古风花钿妆 \| 甜妹繁花花环/,
  );
});

test('submit_prepare picks a task on mouseup, and a track when the task has tracks', async () => {
  const out = await editor(fakePage()).lib.submitPrepare({ ...fill, task: 'AI 赛道征集', task_track: '视频赛道' });
  assert.equal(out.bindings.task, 'AI 赛道征集/视频赛道');
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task: 'AI 赛道征集' }), /SUBMIT_TASK_NEEDS_TRACK: .*图片赛道 \| 视频赛道/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task: 'AI 赛道征集', task_track: '音乐赛道' }), /has no track 「音乐赛道」/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task: '没有的任务' }), /SUBMIT_OPTION_NOT_FOUND: 任务绑定 has no 「没有的任务」; it shows: 暂不参与 \| 征集最新自拍玩法 \| 创新滤镜开放赛 \| AI 赛道征集（分赛道）/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task_track: '图片赛道' }), /has no tracks/);
});

test('submit_prepare fails when picking the task drops the inspiration', async () => {
  const page = fakePage({ inspirationTask: { 国风古风花钿妆: '创新滤镜开放赛' } });
  await assert.rejects(editor(page).lib.submitPrepare(fill), /SUBMIT_BINDING_NOT_APPLIED: 灵感绑定 shows 「选择收藏的灵感或热点」, not 「国风古风花钿妆」/);
});

test('submit_prepare handles a page without the 特效发布设置 step, and lists sections it leaves alone', async () => {
  const page = () => fakePage({ settingsStep: false, extraBasic: '<div class="video-wrapper"><div class="section-title"><div class="title-main">特效介绍视频</div></div></div>' });
  const out = await editor(page()).lib.submitPrepare({ name: '即时特效' });
  assert.equal(out.bindings, null);
  assert.deepEqual(out.other_sections, ['特效介绍视频']);
  await assert.rejects(editor(page()).lib.submitPrepare({ name: '即时特效', task: '征集最新自拍玩法' }), /SUBMIT_NO_SETTINGS_STEP/);
});

test('submit_prepare says what is left when the checks fail or the agreement is not ticked', async () => {
  const failed = await editor(fakePage({ checksPass: false })).lib.submitPrepare(fill);
  assert.equal(failed.review.submit_enabled, false);
  assert.match(failed.next, /^the page's checks did not pass: 性能检测未通过; fix the effect/);
  const unagreed = await editor(fakePage({ agreed: false })).lib.submitPrepare(fill);
  assert.equal(unagreed.review.agreed, false);
  assert.equal(unagreed.next, 'tick the agreement (《创作者协议》) at the bottom of the window; then press 提交审核 to submit; this tool never presses it');
});

test('submit_prepare fails loudly when the page or the window is not what it expects', async () => {
  await assert.rejects(editor(fakePage({ nextLabel: '继续' })).lib.submitPrepare(fill), /SUBMIT_PAGE_CHANGED: the 下一步 button not found/);
  await assert.rejects(editor(fakePage({ answer: false })).lib.submitPrepare(fill), /SUBMIT_PAGE_NOT_READY: .*last error PAGE_NO_ANSWER: submitPage state/);
  await assert.rejects(editor(fakePage(), { windowName: 'SomeOtherWindow' }).lib.submitPrepare(fill), /SUBMIT_WINDOW_NOT_FOUND/);
});

test('submit_prepare closes a submit window left open before opening a fresh one', async () => {
  const old = { constructor: { name: 'DYEHEffectSubmissionWindow' }, isClosed: false, closeWindow() { setTimeout(() => (this.isClosed = true), 5); } };
  const { lib, open } = editor(fakePage(), { left: [old] });
  const out = await lib.submitPrepare({ name: '再提交一次' });
  assert.equal(out.closed_previous, 1);
  assert.equal(old.isClosed, true);
  assert.equal(open().length, 1, 'one submit window, the new one');
  const stuck = { constructor: { name: 'DYEHEffectSubmissionWindow' }, isClosed: false, closeWindow() {} };
  const blocked = editor(fakePage(), { left: [stuck] });
  await assert.rejects(blocked.lib.submitPrepare({ name: '再提交一次' }), /WINDOW_NOT_CLOSED: 1 DYEHEffectSubmissionWindow/);
  assert.equal(blocked.open().length, 1, 'no second window while the old one is open');
});
