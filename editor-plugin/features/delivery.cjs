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
// MobilePreviewPopupContent: the server's answer when the effect fails content moderation.
const MODERATION_FAILED = 2706;
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

const methods = {
  // `png_path` is a square PNG prepared by the MCP server; it becomes the project's icon for each of
  // `types`, the same files the icon creation window saves, and the editor's icon state is reloaded.
  // The submit window asks for the female and male icons, hence the default.
  iconSet({ types = ['female', 'male'], png_path }) {
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
      written.push(dest);
    }
    icons.saveIconJson();
    return { types, icon_paths: written, removed, project_icons: projectIcons(this, project) };
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
  // window. Nothing is uploaded or published until the user confirms in that window.
  async submitPrepare() {
    this.ensureCompatible('submit');
    const check = await this.submitChecks();
    if (!check.ok) return { opened: false, check };
    const EF = this.mod(M.ef);
    const opened = nextEvent(EF.EventManager_deprecated.TypeGuard(), 'OnSubmitWindowOpened', SUBMIT_WINDOW_WAIT_MS, () => null);
    this.mod(M.events).BusinessEventManager.TypeGuard().emit('SubmitEffect');
    const hit = await opened;
    return hit
      ? { opened: true, check, next: 'fill in the name and hints in the submit window; publishing happens only when the user confirms there' }
      : { opened: false, check, note: 'the submit window did not open; the editor shows the reason (e.g. login, size limit) in a toast or dialog' };
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

module.exports = { methods, METHODS, ICON_TYPES, PERF_STATUS };
