'use strict';
// Getting an effect ready to ship: icons, pre-submit checks, the cloud effect check, opening the
// submit window, and the phone preview upload. Publishing itself stays in the submit window, which
// only the user can confirm.
const fs = require('fs');
const path = require('path');
const { M, scratchDir, exportEffectPackage, nextEvent } = require('./common.cjs');

// IconPreviewManager.iconTypeToProjectIconPathMap keys (IconType: Female 0, Male 1, Common 2).
const ICON_TYPES = { female: 0, male: 1, common: 2 };
// PerfTestButton's getPerfTestStatus codes.
const PERF_STATUS = { 1: 'passed', 2: 'not_passed', 3: 'needs_optimization', 4: 'failed' };
// Picked, not measured: the submit window normally opens within a few seconds of the export.
const SUBMIT_WINDOW_WAIT_MS = 60000;

function activeProject(lib) {
  const p = lib.mod(M.ef).ProjectManager.getInstance().getActiveProject();
  if (!p || !p.path) throw Error('NO_ACTIVE_PROJECT');
  return p;
}

function projectIcons(lib, project) {
  const map = lib.mod(M.iconPreview).iconTypeToProjectIconPathMap;
  return Object.keys(ICON_TYPES).filter((name) => fs.existsSync(path.join(project.path, map[ICON_TYPES[name]])));
}

function findUrl(v, depth = 0) {
  if (depth > 4 || v == null) return null;
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? v : null;
  if (typeof v !== 'object') return null;
  const entries = Object.entries(v).sort(([a], [b]) => Number(/url|link|qr/i.test(b)) - Number(/url|link|qr/i.test(a)));
  for (const [, x] of entries) {
    const hit = findUrl(x, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const methods = {
  // `png_path` is a square PNG prepared by the MCP server; it becomes the project's icon of that type,
  // the same file the icon creation window saves, and the editor's icon state is reloaded from it.
  iconSet({ type = 'common', png_path }) {
    this.ensureCompatible('icon');
    if (!Object.prototype.hasOwnProperty.call(ICON_TYPES, type)) throw Error(`INVALID_ICON_TYPE: ${type}; valid: ${Object.keys(ICON_TYPES).join(', ')}`);
    if (typeof png_path !== 'string' || !fs.existsSync(png_path)) throw Error(`ICON_FILE_NOT_FOUND: ${png_path}`);
    const project = activeProject(this);
    const { IconPreviewManager, iconTypeToProjectIconPathMap } = this.mod(M.iconPreview);
    const t = ICON_TYPES[type];
    const dest = path.join(project.path, iconTypeToProjectIconPathMap[t]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(png_path, dest);
    const icons = IconPreviewManager.getInstance();
    icons.importAndCreateIcon(t, project.path);
    icons.setIconExistState(t, true);
    icons.saveIconJson();
    return { type, icon_path: dest, project_icons: projectIcons(this, project) };
  },

  iconOpen() {
    this.ensureCompatible('icon');
    activeProject(this);
    this.mod(M.iconWindow).showIconCreationWindow('tool_bar');
    return { opened: true };
  },

  // Local checks the submit flow would fail on, without uploading anything: package size against the
  // submit limit, unchanged-template detection, login, minimum SDK version and icons.
  async effectCheck() {
    this.ensureCompatible('check');
    const EF = this.mod(M.ef);
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
    const minSdk = await project.effectExporter.getMinimumSdkVersionOnSave(EF.EffectExport.ExportType.MOBILE_PREVIEW);
    const limit = this.mod(M.sdkLimit).getLimitSdkVersionInfo();
    const limitVersion = limit && limit.limitVersion;
    const sdkTooNew = !!(limitVersion && minSdk && limitVersion.isLessThan(minSdk));
    if (sdkTooNew) issues.push(`SDK_TOO_NEW: needs SDK ${minSdk}, some phones only run ${limitVersion}`);
    const icons = projectIcons(this, project);
    if (!icons.length) issues.push('NO_ICON: set one with icon_set or icon_open');
    return {
      ok: issues.length === 0,
      issues,
      package_bytes: pkg.size,
      package_limit_bytes: maxBytes,
      min_sdk_version: minSdk ? String(minSdk) : null,
      sdk_limit_version: limitVersion ? String(limitVersion) : null,
      icons,
      logged_in: !!isLoggedIn,
      saved: typeof project.isSaved === 'function' ? project.isSaved() : null,
      unsaved_changes: typeof project.isProjectChanged === 'function' ? project.isProjectChanged() : null,
    };
  },

  // The toolbar's 特效检测: opens its window, whose page uploads the package and runs the cloud check,
  // then reports a status code back through getPerfTestStatus. Details stay visible in that window.
  async effectCheckCloud({ timeout_ms = 300000 } = {}) {
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
  // window. Nothing is uploaded or published until the user confirms in that window.
  async submitPrepare() {
    this.ensureCompatible('submit');
    const check = await this.effectCheck();
    if (!check.ok) return { opened: false, check };
    const EF = this.mod(M.ef);
    const opened = nextEvent(EF.EventManager_deprecated.TypeGuard(), 'OnSubmitWindowOpened', SUBMIT_WINDOW_WAIT_MS, () => null);
    this.mod(M.events).BusinessEventManager.TypeGuard().emit('SubmitEffect');
    const hit = await opened;
    return hit
      ? { opened: true, check, next: 'fill in the name and hints in the submit window; publishing happens only when the user confirms there' }
      : { opened: false, check, note: 'the submit window did not open; the editor shows the reason (e.g. login, size limit) in a toast or dialog' };
  },

  // Same upload the toolbar's 手机预览 popup makes; returns the server's answer and the preview link
  // in it. The package is uploaded to Douyin's preview service.
  async mobilePreview() {
    this.ensureCompatible('mobile');
    activeProject(this);
    const helper = this.mod(M.mobilePreview);
    await helper.getCookie();
    const dir = scratchDir(this, 'preview');
    let res;
    let pkg;
    try {
      pkg = await exportEffectPackage(this, dir);
      res = await helper.requestMobilePreviewURL(pkg.packagePath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    let payload = res && res.body !== undefined ? res.body : res;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (_) {}
    }
    const url = findUrl(payload);
    if (!url) throw Error(`MOBILE_PREVIEW_NO_URL: ${JSON.stringify(payload).slice(0, 500)}`);
    return { preview_url: url, package_bytes: pkg.size, response: payload };
  },
};

const METHODS = {
  icon_set: 'iconSet',
  icon_open: 'iconOpen',
  effect_check: 'effectCheck',
  effect_check_cloud: 'effectCheckCloud',
  submit_prepare: 'submitPrepare',
  mobile_preview: 'mobilePreview',
};

module.exports = { methods, METHODS, ICON_TYPES, PERF_STATUS, findUrl };
