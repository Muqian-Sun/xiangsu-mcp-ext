'use strict';
// Getting an effect ready to ship: icons, pre-submit checks, the cloud effect check, filling in the
// submit window, and the phone preview upload. Publishing itself stays in the submit window: its
// 提交审核 button is left for the user to press.
const fs = require('fs');
const path = require('path');
const { M, scratchDir, exportEffectPackage, nextEvent } = require('./common.cjs');
const { submitPageBridge } = require('./submitpage.cjs');

// IconPreviewManager.iconTypeToProjectIconPathMap keys (IconType: Female 0, Male 1, Common 2).
const ICON_TYPES = { female: 0, male: 1, common: 2 };
// PerfTestButton's getPerfTestStatus codes.
const PERF_STATUS = { 1: 'passed', 2: 'not_passed', 3: 'needs_optimization', 4: 'failed' };
// MobilePreviewPopupContent: the server's answer when the effect fails content moderation.
const MODERATION_FAILED = 2706;
// Picked, not measured: the submit window normally opens within a few seconds of the export.
const SUBMIT_WINDOW_WAIT_MS = 60000;
const SUBMIT_WINDOW = 'DYEHEffectSubmissionWindow';
// The submit page's 默认摄像头方向 options.
const CAMERA = { front: '前置', back: '后置' };
// Steps of the submit page, by their header labels.
const STEP = { basic: '特效基础信息', settings: '特效发布设置', review: '提交审核' };
// Sections each step fills; others on the page are reported as left as the page shows them.
const FILLED_SECTIONS = ['特效图标', '默认摄像头方向', '特效名称', '特效触发提示', '灵感绑定', '任务绑定'];
// The page loaded within 4 s in the live runs of 2026-11-07; the other values are picked. Its aiName config
// request (done 2.4 s in, after the form appeared) remounts the name field and wipes what was typed (seen
// live), so filling waits for that request, or, should the page stop making it, until no request has
// finished for quietMs. settleMs lets a picked option or typed text render before it is read back.
// The 提交审核 step's checks (performance, similarity…) finished within a minute live; checksMs is picked.
const PAGE_TIMING = { readyMs: 30000, quietMs: 1500, pollMs: 300, settleMs: 800, stepMs: 5000, checksMs: 180000 };
const checkPending = (c) => c.endsWith('中...');
const checkPassed = (c) => c.endsWith('通过') && !/[未不]通过$/.test(c);

function activeProject(lib) {
  const p = lib.mod(M.ef).ProjectManager.getInstance().getActiveProject();
  if (!p || !p.path) throw Error('NO_ACTIVE_PROJECT');
  return p;
}

function projectIcons(lib, project) {
  const map = lib.mod(M.iconPreview).iconTypeToProjectIconPathMap;
  return Object.keys(ICON_TYPES).filter((name) => fs.existsSync(path.join(project.path, map[ICON_TYPES[name]])));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (list) => (list.length ? `; the page says: ${list.join(' | ')}` : '');

// Emits the toolbar's SubmitEffect and returns the submit window it opens (null when it does not open).
// The editor keeps no reference to that window, so it is caught as it is shown.
async function openSubmitWindow(lib) {
  const { EHWebWindow } = lib.mod(M.webWindow);
  const show = EHWebWindow.prototype.showWindow;
  let win = null;
  EHWebWindow.prototype.showWindow = function (...args) {
    if (this.constructor && this.constructor.name === SUBMIT_WINDOW) win = this;
    return show.apply(this, args);
  };
  try {
    const opened = nextEvent(lib.mod(M.ef).EventManager_deprecated.TypeGuard(), 'OnSubmitWindowOpened', SUBMIT_WINDOW_WAIT_MS, () => null);
    lib.mod(M.events).BusinessEventManager.TypeGuard().emit('SubmitEffect');
    if (!(await opened)) return null;
  } finally {
    EHWebWindow.prototype.showWindow = show;
  }
  if (!win) throw Error(`SUBMIT_WINDOW_NOT_FOUND: a submit window opened but none was a ${SUBMIT_WINDOW}; the editor changed`);
  return win;
}

async function waitForForm(run) {
  const until = Date.now() + PAGE_TIMING.readyMs;
  let state = null;
  let lastError = null;
  let resources = null;
  let quietSince = 0;
  while (Date.now() < until) {
    // The page has not loaded the bridge yet while it is still opening; such calls get no answer.
    state = await run({ action: 'state' }, PAGE_TIMING.pollMs * 10).catch((e) => ((lastError = e.message), state));
    if (state && state.ready_state === 'complete' && state.has_form && state.icons_loaded) {
      if (state.name_config_loaded) return;
      if (state.resources !== resources) {
        resources = state.resources;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= PAGE_TIMING.quietMs) {
        return;
      }
    }
    await sleep(PAGE_TIMING.pollMs);
  }
  throw Error(`SUBMIT_PAGE_NOT_READY: the submit page did not finish loading in ${PAGE_TIMING.readyMs} ms; last seen ${JSON.stringify(state)}, last error ${lastError}`);
}

async function nextStep(run) {
  const { from, to, errors } = await run({ action: 'next', wait_ms: PAGE_TIMING.stepMs });
  if (to === from) {
    const icon = errors.includes('请至少上传一个图标') ? '; set the icon with icon_set, which uploads it' : '';
    throw Error(`SUBMIT_STEP_BLOCKED: 「${from}」 did not move on${quote(errors)}${icon}`);
  }
  return to;
}

// Fills the submit page and stops on its 提交审核 step. Fields left undefined keep what the page shows
// (the editor passes the project's bound inspiration and task, and the trigger hint of AI assets).
async function fillSubmitPage(run, { name, trigger_hint, camera, inspiration, task, task_track }) {
  await waitForForm(run);
  const basic = await run({ action: 'basic', name, trigger_hint, camera, settle_ms: PAGE_TIMING.settleMs });
  if (basic.errors.length) throw Error(`SUBMIT_FIELD_REJECTED${quote(basic.errors)}`);
  if (basic.name !== name) throw Error(`SUBMIT_NAME_REJECTED: the page kept 「${basic.name}」 of 「${name}」 (特效名称 takes at most 10 characters, two Latin letters or digits counting as one)`);
  if (trigger_hint !== undefined && basic.trigger_hint !== trigger_hint) {
    throw Error(`SUBMIT_TRIGGER_HINT_REJECTED: the page kept 「${basic.trigger_hint}」 of 「${trigger_hint}」 (特效触发提示 takes at most 10 characters)`);
  }
  if (camera !== undefined && basic.camera !== camera) throw Error(`SUBMIT_CAMERA_NOT_APPLIED: 默认摄像头方向 shows ${basic.camera}, not ${camera}`);
  const otherSections = basic.sections.filter((s) => !FILLED_SECTIONS.includes(s));
  let step = await nextStep(run);
  let bindings = null;
  if (step === STEP.settings) {
    bindings = await run({ action: 'bind', inspiration, task, task_track, settle_ms: PAGE_TIMING.settleMs, wait_ms: PAGE_TIMING.stepMs });
    if (inspiration !== undefined && bindings.inspiration !== inspiration) {
      throw Error(`SUBMIT_BINDING_NOT_APPLIED: 灵感绑定 shows 「${bindings.inspiration}」, not 「${inspiration}」 (an inspiration that belongs to a task is dropped when another task is picked)`);
    }
    const wantTask = task_track === undefined ? task : `${task}/${task_track}`;
    if (task !== undefined && bindings.task !== wantTask) throw Error(`SUBMIT_BINDING_NOT_APPLIED: 任务绑定 shows 「${bindings.task}」, not 「${wantTask}」`);
    otherSections.push(...bindings.sections.filter((s) => !FILLED_SECTIONS.includes(s)));
    step = await nextStep(run);
  } else if (inspiration !== undefined || task !== undefined) {
    throw Error(`SUBMIT_NO_SETTINGS_STEP: this effect's submit page has no 「${STEP.settings}」 step, so inspiration and task cannot be set`);
  }
  if (step !== STEP.review) throw Error(`SUBMIT_PAGE_CHANGED: expected the 「${STEP.review}」 step, the page moved to 「${step}」`);
  let review = await run({ action: 'review' });
  // The summary is what gets submitted; a field that was wiped after it was typed shows up here.
  const hint = basic.trigger_hint || '无';
  if (review.name !== basic.name || review.trigger_hint !== hint) {
    throw Error(`SUBMIT_REVIEW_MISMATCH: the summary shows 名称「${review.name}」 触发提示「${review.trigger_hint}」, filled 「${basic.name}」 「${hint}」`);
  }
  for (const until = Date.now() + PAGE_TIMING.checksMs; review.checks.some(checkPending) && Date.now() < until; ) {
    await sleep(PAGE_TIMING.pollMs * 10);
    review = await run({ action: 'review' });
  }
  const failing = review.checks.filter((c) => !checkPassed(c) && !checkPending(c));
  const todo = [];
  if (review.agreed === false) todo.push('tick the agreement (《创作者协议》) at the bottom of the window');
  if (review.checks.some(checkPending)) todo.push(`the page's checks were still running after ${PAGE_TIMING.checksMs} ms; wait until 提交审核 can be pressed`);
  else if (failing.length) todo.push(`the page's checks did not pass: ${failing.join(' | ')}; fix the effect and run submit_prepare again`);
  else if (!review.submit_enabled && review.agreed !== false) todo.push(`提交审核 is still disabled (the page says ${review.title}); look at the window`);
  todo.push('press 提交审核 to submit; this tool never presses it');
  return {
    step,
    filled: { icons: basic.icons, name: basic.name, trigger_hint: basic.trigger_hint, camera: basic.camera },
    bindings: bindings && { inspiration: bindings.inspiration, task: bindings.task },
    other_sections: otherSections,
    review,
    next: todo.join('; then '),
  };
}

const methods = {
  // `png_path` is a square PNG prepared by the MCP server; it becomes the project's icon for each of
  // `types`, the same files the icon creation window saves, and is uploaded the way that window's 完成
  // button does: the submit page only accepts icons the platform already has. The submit window asks
  // for the female and male icons, hence the default.
  async iconSet({ types = ['female', 'male'], png_path }) {
    this.ensureCompatible('icon');
    const bad = (Array.isArray(types) && types.length ? types : [null]).filter((t) => !Object.prototype.hasOwnProperty.call(ICON_TYPES, t));
    if (bad.length) throw Error(`INVALID_ICON_TYPE: ${bad.join(', ')}; valid: ${Object.keys(ICON_TYPES).join(', ')}`);
    if (typeof png_path !== 'string' || !fs.existsSync(png_path)) throw Error(`ICON_FILE_NOT_FOUND: ${png_path}`);
    const project = activeProject(this);
    const { IconPreviewManager, iconTypeToProjectIconPathMap } = this.mod(M.iconPreview);
    const icons = IconPreviewManager.getInstance();
    // The submit window takes the common icon whenever one exists and then ignores the female and male
    // ones (seen live), so the two modes are kept exclusive, removing the other mode the way the icon
    // window deletes an icon.
    const other = types.includes('common') ? ['female', 'male'] : ['common'];
    const removed = [];
    for (const type of other) {
      const t = ICON_TYPES[type];
      if (!fs.existsSync(path.join(project.path, iconTypeToProjectIconPathMap[t])) && !icons.isIconCreated(t)) continue;
      icons.deleteIcon(t);
      icons.uploadDeleteIcon(t);
      removed.push(type);
    }
    const written = [];
    for (const type of types) {
      const t = ICON_TYPES[type];
      const dest = path.join(project.path, iconTypeToProjectIconPathMap[t]);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(png_path, dest);
      icons.importAndCreateIcon(t, project.path);
      icons.setIconExistState(t, true);
      // The uri of an earlier upload names the old image; kept after a failed upload, it would be submitted.
      icons.updateIcon(t, { iconUri: undefined, uploadData: undefined });
      written.push(dest);
    }
    const uploaded = await this.mod(M.iconUpload).default.uploadIcon();
    icons.saveIconJson();
    if (!uploaded) throw Error('ICON_UPLOAD_FAILED: the icon files are written but the platform did not take the upload (network or login); call icon_set again');
    return { types, icon_paths: written, removed, uploaded, project_icons: projectIcons(this, project) };
  },

  iconOpen() {
    this.ensureCompatible('icon');
    activeProject(this);
    this.mod(M.iconWindow).showIconCreationWindow('tool_bar');
    return { opened: true };
  },

  // submit_prepare's gate: what the submit flow would refuse, checked locally so the agent learns the
  // reason (the editor only shows it in a toast): package size against the submit limit,
  // unchanged-template detection, login and icons. The editor's minimum-SDK helper is left out: it
  // resolves a relative export folder against the process cwd ('/') and fails here.
  async submitChecks() {
    this.ensureCompatible('check');
    const project = activeProject(this);
    const api = this.mod(M.orionui).ExtensionManager.host.getAPI(this.mod(M.submission).EffectSubmissionAPIKey);
    const dir = scratchDir(this, 'check');
    let pkg;
    try {
      pkg = await exportEffectPackage(this, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const issues = [];
    const maxBytes = api.maxEffectPackageSize;
    if (pkg.size >= maxBytes) issues.push(`PACKAGE_TOO_LARGE: ${pkg.size} bytes, limit ${maxBytes}`);
    const effectIdOk = api.checkEffectIdConsistency();
    if (!effectIdOk) issues.push('TEMPLATE_TAMPERED: the template this project came from was modified in a way the submit check rejects');
    const sameAsTemplate = api.checkResourceConsistency();
    if (sameAsTemplate) issues.push('SAME_AS_TEMPLATE: resources are identical to the template; change the effect before submitting');
    const { isLoggedIn } = await this.mod(M.login).loginContribution.getLoginStatus();
    if (!isLoggedIn) issues.push('NOT_LOGGED_IN: log in to 像塑 first');
    const icons = projectIcons(this, project);
    if (!icons.length) issues.push('NO_ICON: set one with icon_set or icon_open');
    return {
      ok: issues.length === 0,
      issues,
      package_bytes: pkg.size,
      package_limit_bytes: maxBytes,
      icons,
      logged_in: !!isLoggedIn,
      saved: typeof project.isSaved === 'function' ? project.isSaved() : null,
      unsaved_changes: typeof project.isProjectChanged === 'function' ? project.isProjectChanged() : null,
    };
  },

  // The toolbar's 特效检测 button (PerfTestButton) only opens this window; its page uploads the package
  // and runs the cloud check, then reports a status code back through getPerfTestStatus. Details stay
  // visible in that window.
  async effectCheck({ timeout_ms = 300000 } = {}) {
    this.ensureCompatible('check');
    activeProject(this);
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const result = nextEvent(bus, 'getPerfTestStatus', timeout_ms, () => null);
    this.mod(M.orionui).ExtensionManager.host.getAPI(this.mod(M.perfTest).PerfTestAPIKey).showWindow();
    const hit = await result;
    if (!hit) return { finished: false, result: 'timeout', note: 'the 特效检测 window is still open; read the result there' };
    const code = hit.args[0];
    return { finished: true, status_code: code, result: PERF_STATUS[code] || 'unknown' };
  },

  // Same entry as the toolbar's 提交特效 button: the editor runs its own pre-checks and opens the submit
  // window. The window's page is then filled in step by step and left on its 提交审核 step; every value is
  // read back from the page, and anything the page refused or changed fails the call with the window open.
  async submitPrepare({ name, trigger_hint, camera, inspiration, task, task_track } = {}) {
    this.ensureCompatible('submit');
    if (typeof name !== 'string' || !name) throw Error('INVALID_NAME: pass the effect name');
    if (camera !== undefined && !Object.prototype.hasOwnProperty.call(CAMERA, camera)) throw Error(`INVALID_CAMERA: ${camera}; valid: ${Object.keys(CAMERA).join(', ')}`);
    if (task_track !== undefined && task === undefined) throw Error('INVALID_TASK: task_track needs task');
    const check = await this.submitChecks();
    if (!check.ok) return { opened: false, check };
    const win = await openSubmitWindow(this);
    if (!win) return { opened: false, check, note: 'the submit window did not open; the editor shows the reason (e.g. login, size limit) in a toast or dialog' };
    const run = submitPageBridge(win);
    try {
      return { opened: true, check, ...(await fillSubmitPage(run, { name, trigger_hint, camera: camera && CAMERA[camera], inspiration, task, task_track })) };
    } catch (e) {
      throw Error(`${e.message} (the submit window is left open)`);
    }
  },

  // What the toolbar's 手机预览 popup does (MobilePreviewPopupContent): register the SDK version
  // mapping, export a preview package, upload it, and turn `data` of a code-0 answer into the QR text
  // the Douyin app scans. The package is uploaded to Douyin's preview service.
  async mobilePreview() {
    this.ensureCompatible('mobile');
    const project = activeProject(this);
    const helper = this.mod(M.mobilePreview);
    await helper.getCookie();
    this.mod(M.bizUtils).ExportEffectPackageUtils.registerSDKVersionMapping();
    const dir = scratchDir(this, 'preview');
    let res;
    let pkg;
    try {
      pkg = await exportEffectPackage(this, dir, 'preview');
      res = await helper.requestMobilePreviewURL(pkg.packagePath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (!res || res.statusCode !== 200) throw Error(`MOBILE_PREVIEW_HTTP_${res && res.statusCode}`);
    const body = JSON.parse(res.body);
    if (body.code === MODERATION_FAILED) throw Error(`MOBILE_PREVIEW_MODERATION_FAILED: ${body.message || ''}`);
    if (body.code !== 0 || !body.data) throw Error(`MOBILE_PREVIEW_FAILED: code=${body.code} message=${body.message || ''}`);
    return { project_path: project.path, qr_text: JSON.stringify(body.data), expires_in_sec: body.data.ttl ?? null, package_bytes: pkg.size };
  },
};

const METHODS = {
  icon_set: 'iconSet',
  icon_open: 'iconOpen',
  effect_check: 'effectCheck',
  submit_prepare: 'submitPrepare',
  mobile_preview: 'mobilePreview',
};

module.exports = { methods, METHODS, ICON_TYPES, PERF_STATUS, PAGE_TIMING };
