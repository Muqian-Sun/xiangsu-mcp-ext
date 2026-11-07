'use strict';
// The submit and 特效检测 windows show web pages (effect.douyin.com/ac/submit-orion, /ac/perftest-orion-v2).
// Scripts are run in them through the window's webview and answer through the window's JS bridge, which
// hands page queries (orionJSB://<scope>/<method>?<params>) to the handlers registered for that scope.

const BRIDGE_SCOPE = 'XiangsuMcpExt';
const SOURCE_URL = 'orion://inject/xiangsu-mcp-ext';
// Picked, not measured beyond the live runs on 2026-11-07, where every page script answered within 3 s.
const CALL_TIMEOUT_MS = 15000;

// Runs in the page: calls `fn(arg)` and posts the outcome back through the bridge.
function pageCall(id, scope, fn, arg) {
  const send = (v) =>
    window.orionQuery({ request: `orionJSB://${scope}/result?${encodeURIComponent(JSON.stringify(Object.assign({ id }, v)))}`, onSuccess() {}, onFailure() {} });
  Promise.resolve()
    .then(() => fn(arg))
    .then(
      (value) => send({ ok: true, value: value === undefined ? null : value }),
      (e) => send({ ok: false, error: String((e && e.message) || e) }),
    );
}

// Runs in the page, so it must not use anything from this module. Finds every element by class and label
// text; one that is missing fails with SUBMIT_PAGE_CHANGED rather than being skipped.
async function submitPage(arg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el ? el.textContent.trim() : '');
  const need = (el, what) => {
    if (!el) throw Error(`SUBMIT_PAGE_CHANGED: ${what} not found`);
    return el;
  };
  const shown = (el) => {
    for (let e = el; e; e = e.parentElement) if (e.style && e.style.display === 'none') return false;
    return true;
  };
  // A section title is its first text node; the required-field star and the help icon follow it.
  const titleOf = (el) => {
    const t = el && el.querySelector('.title-main');
    return t && t.firstChild ? t.firstChild.textContent.trim() : '';
  };
  const step = () => text(document.querySelector('header .nav-item.active .nav-item-text'));
  const errors = () => [...document.querySelectorAll('.text-err')].filter(shown).map(text).filter(Boolean);
  const sections = () => [...document.querySelectorAll('main .content-left .section-title')].filter(shown).map((s) => titleOf(s.parentElement));
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  // data: null makes the page's input handler take the whole value, the way it treats a paste.
  const type = (input, value) => {
    input.focus();
    setValue.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: null, inputType: 'insertReplacementText' }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.blur();
  };
  // The selectors open on mousedown and pick tasks on mouseup, which element.click() does not send.
  const press = (el) => {
    for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  };
  const binder = (title) => [...document.querySelectorAll('.bind-wrapper')].filter(shown).find((w) => titleOf(w) === title);
  const shownText = (w) => (w ? text(w.querySelector('.selector-input .text')) : null);
  const optionName = (o) => text(o.querySelector('.option-name'));

  switch (arg.action) {
    case 'state': {
      const requests = performance.getEntriesByType('resource');
      return {
        ready_state: document.readyState,
        step: step(),
        has_form: !!document.querySelector('.name-wrapper input'),
        icons_loaded: document.querySelectorAll('.upload-icon-wrapper .icon-bottom > div').length > 0,
        name_config_loaded: requests.some((r) => /[?&]key=aiName(&|$)/.test(r.name)),
        resources: requests.length,
      };
    }

    case 'basic': {
      if (step() !== '特效基础信息') throw Error(`SUBMIT_PAGE_CHANGED: expected the 特效基础信息 step, the page is on ${step() || '(none)'}`);
      const name = need(document.querySelector('.name-wrapper input'), 'the 特效名称 input');
      type(name, arg.name);
      if (arg.trigger_hint !== undefined) type(need(document.querySelector('.trigger-wrapper input'), 'the 特效触发提示 input'), arg.trigger_hint);
      if (arg.camera !== undefined) {
        const labels = [...document.querySelectorAll('.default-camera-wrapper label')];
        press(need(labels.find((l) => text(l) === arg.camera), `the 默认摄像头方向 option ${arg.camera}`));
      }
      await sleep(arg.settle_ms);
      const hint = document.querySelector('.trigger-wrapper input');
      return {
        name: name.value,
        trigger_hint: hint ? hint.value : null,
        camera: text(document.querySelector('.default-camera-wrapper label.semi-radio-checked')) || null,
        icons: {
          female: !!document.querySelector('.upload-icon-wrapper .icon-bottom.female .finish'),
          male: !!document.querySelector('.upload-icon-wrapper .icon-bottom.male .finish'),
        },
        sections: sections(),
        errors: errors(),
      };
    }

    case 'next': {
      const from = step();
      const button = [...document.querySelectorAll('footer .button.next')].find((b) => text(b) === '下一步');
      press(need(button, 'the 下一步 button'));
      for (let waited = 0; step() === from && waited < arg.wait_ms; waited += 100) await sleep(100);
      return { from, to: step(), errors: errors() };
    }

    case 'bind': {
      if (arg.inspiration !== undefined) {
        const w = need(binder('灵感绑定'), 'the 灵感绑定 selector');
        const match = () => [...w.querySelectorAll('.favor-option')].find((o) => optionName(o) === arg.inspiration);
        press(need(w.querySelector('.selector-input'), 'the 灵感绑定 box'));
        await sleep(200);
        // The list holds the collection a page at a time; the search box covers the rest.
        let hit = match();
        let searched = null;
        if (!hit && w.querySelector('.search-input')) {
          type(w.querySelector('.search-input'), arg.inspiration);
          for (let waited = 0; waited < arg.wait_ms; waited += 200) {
            await sleep(200);
            hit = match();
            searched = text(w.querySelector('.empty-list'));
            if (hit || searched === '暂无搜索结果') break;
          }
        }
        if (!hit) {
          const options = [...w.querySelectorAll('.favor-option')].map(optionName);
          const search = searched === null ? '' : `searching it gave ${searched || 'no exact match'}; `;
          throw Error(`SUBMIT_OPTION_NOT_FOUND: 灵感绑定 has no 「${arg.inspiration}」 among the collected inspirations and hotspots; ${search}it lists: ${options.join(' | ') || text(w.querySelector('.empty-list')) || '(nothing)'}`);
        }
        press(hit);
        await sleep(arg.settle_ms);
      }
      if (arg.task !== undefined) {
        const w = need(binder('任务绑定'), 'the 任务绑定 selector');
        if (w.querySelector('.selector-container.task-disabled')) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务绑定 is unavailable: ${shownText(w)}`);
        press(need(w.querySelector('.selector-input'), 'the 任务绑定 box'));
        await sleep(200);
        const plain = [...w.querySelectorAll('.favor-option')].find((o) => optionName(o) === arg.task);
        const tracked = [...w.querySelectorAll('.selector-list-track-item')].find((t) => text(t.querySelector('.selector-list-track-item-title')) === arg.task);
        const options = () =>
          [...w.querySelectorAll('.favor-option')].map(optionName).concat([...w.querySelectorAll('.selector-list-track-item-title')].map((t) => `${text(t)}（分赛道）`));
        if (!plain && !tracked) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务绑定 has no 「${arg.task}」; it shows: ${options().join(' | ')}`);
        if (tracked) {
          const title = tracked.querySelector('.selector-list-track-item-title');
          press(title);
          await sleep(300);
          const tracks = [...tracked.querySelectorAll('.selector-list-track-item-info')];
          const names = tracks.map((i) => text(i.querySelector('.selector-list-track-item-info-title')));
          if (arg.task_track === undefined) throw Error(`SUBMIT_TASK_NEEDS_TRACK: 任务「${arg.task}」 is split into tracks; pass task_track, one of: ${names.join(' | ')}`);
          const hit = tracks[names.indexOf(arg.task_track)];
          if (!hit) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务「${arg.task}」 has no track 「${arg.task_track}」; tracks: ${names.join(' | ')}`);
          press(hit);
        } else {
          if (arg.task_track !== undefined) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务「${arg.task}」 has no tracks; leave out task_track`);
          press(plain);
        }
        await sleep(arg.settle_ms);
      }
      return { inspiration: shownText(binder('灵感绑定')), task: shownText(binder('任务绑定')), sections: sections(), errors: errors() };
    }

    case 'review': {
      if (step() !== '提交审核') throw Error(`SUBMIT_PAGE_CHANGED: expected the 提交审核 step, the page is on ${step() || '(none)'}`);
      const items = [...document.querySelectorAll('.publish-wrap .effect-content-item')].map(text);
      const field = (label) => {
        const hit = items.find((t) => t.startsWith(label));
        return hit === undefined ? null : hit.slice(label.length);
      };
      const submit = need([...document.querySelectorAll('footer .button')].find((b) => text(b) === '提交审核'), 'the 提交审核 button');
      const agreement = document.querySelector('footer .ip-agreement');
      return {
        title: text(document.querySelector('.publish-wrap .submit-title h1')),
        name: field('特效名称：'),
        trigger_hint: field('特效触发提示：'),
        checks: [...document.querySelectorAll('.publish-wrap .effect-test-item-top-text')].map(text),
        agreed: agreement ? !!agreement.querySelector('.agreed') : null,
        submit_enabled: !submit.classList.contains('disable'),
      };
    }

    default:
      throw Error(`UNKNOWN_ACTION: ${arg.action}`);
  }
}

// Runs in the 特效检测 page once its result is in. Reads the verdict and each check with its figures
// (package size, Android then iOS frame rate, each against its limit). A check that did not pass has a help
// icon whose advice only renders while it is hovered, so it is hovered and read.
async function perfPage(arg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el ? el.textContent.trim() : '');
  const title = document.querySelector('.perf-top .status-title');
  const items = [...document.querySelectorAll('.effect-test-container .effect-test-item')];
  if (!title || !items.length) throw Error('PERF_PAGE_CHANGED: the 特效检测 page shows no verdict or checks');
  const hover = (el, on) => {
    el.dispatchEvent(new MouseEvent(on ? 'mouseenter' : 'mouseleave', { bubbles: false, view: window }));
    el.dispatchEvent(new MouseEvent(on ? 'mouseover' : 'mouseout', { bubbles: true, view: window }));
  };
  const checks = [];
  for (const item of items) {
    const check = { name: text(item.querySelector('.effect-test-item-top-text')) };
    const rows = [...item.querySelectorAll('.effect-test-item-bottom-item')];
    if (rows.length) {
      check.figures = rows.map((row) => {
        const [value, limit] = row.querySelectorAll('span');
        return { value: text(value), limit: text(limit).replace(/^\//, ''), passed: !!value && value.classList.contains('effect-test-item-bottom-text-pass') };
      });
      if (rows.length === 2) check.figures.forEach((f, i) => (f.platform = ['android', 'ios'][i]));
    }
    const help = item.querySelector('.effect-test-item-top-help');
    if (help) {
      const before = new Set(document.querySelectorAll('.effect-test-item-top-help-content-text'));
      hover(help, true);
      let tip = null;
      for (let waited = 0; !tip && waited < arg.wait_ms; waited += 100) {
        await sleep(100);
        tip = [...document.querySelectorAll('.effect-test-item-top-help-content-text')].find((t) => !before.has(t)) || null;
      }
      hover(help, false);
      if (tip) check.advice = text(tip);
      else check.advice_unavailable = `its help popup did not open in ${arg.wait_ms} ms`;
    }
    checks.push(check);
  }
  const desc = document.querySelector('.perf-top .status-desc');
  return { verdict: text(title), ...(desc ? { verdict_detail: text(desc) } : {}), checks };
}

// Returns run(arg, ms): runs pageFn(arg) in the window's page and resolves with what it returns.
function pageBridge(win, pageFn) {
  const pending = new Map();
  let seq = 0;
  win.JSB.joinRegisterHandler(BRIDGE_SCOPE, {
    result: (p) => {
      const done = p && pending.get(p.id);
      if (done) {
        pending.delete(p.id);
        done(p);
      }
      return '';
    },
  });
  return (arg, ms = CALL_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`PAGE_NO_ANSWER: ${pageFn.name}${arg.action ? ` ${arg.action}` : ''} got no answer from the page in ${ms} ms`));
      }, ms);
      pending.set(id, (p) => {
        clearTimeout(timer);
        if (p.ok) resolve(p.value);
        else reject(Error(p.error));
      });
      // The second argument is the script's source URL: a callback there crashes the editor process.
      win.webview.evaluateJavascript(`(${pageCall})(${JSON.stringify(id)}, ${JSON.stringify(BRIDGE_SCOPE)}, ${pageFn}, ${JSON.stringify(arg)});`, SOURCE_URL);
    });
}

const submitPageBridge = (win) => pageBridge(win, submitPage);
const perfPageBridge = (win) => pageBridge(win, perfPage);

module.exports = { submitPageBridge, perfPageBridge, submitPage, perfPage, BRIDGE_SCOPE, SOURCE_URL };
