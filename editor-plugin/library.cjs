'use strict';
// Official asset library operations, implemented on the editor's own modules so requests carry
// the editor's login state and imports follow the same path as the asset library panel.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const M = {
  nav: '@orion/Business/AssetsLibrary/Core/Control/AssetsLibraryNav/util',
  navConst: '@orion/Business/AssetsLibrary/Core/Control/AssetsLibraryNav/const',
  category: '@orion/Business/AssetsLibrary/Core/Api/getAssetCategory',
  list: '@orion/Business/AssetsLibrary/Core/Api/getAssetList',
  search: '@orion/Business/AssetsLibrary/Core/Api/search',
  util: '@orion/Business/AssetsLibrary/Core/Control/util',
  ef: '@orion/orion-sdk/EditorFramework',
  scene: '@orion/Business/Common/Scene',
};

// Editor internals this module relies on; checked up front so an editor upgrade fails with a precise list.
const REQUIRED = [
  [M.nav, 'getDefaultNavList'],
  [M.navConst, 'SearchNavItemKeys'],
  [M.category, 'getAssetCategory'],
  [M.list, 'getAssetList'],
  [M.search, 'searchAsset'],
  [M.util, 'downloadLokiFile'],
  [M.ef, 'Resource.EditorFoundation.env.getSharedResourcesPath'],
  [M.ef, 'Resource.AssetPackageManager.instance.import'],
  [M.ef, 'Resource.ResourceUndoManager.createImportUndoID'],
  [M.ef, 'ProjectManager.getInstance'],
  [M.ef, 'PreviewSyncer.getInstance'],
  [M.ef, 'UndoSystem.instance.start'],
  [M.ef, 'UndoSystem.instance.end'],
  [M.scene, 'SceneModule.getEditingSceneService'],
];
const MAX_PREVIEW = 8;

// Only plain asset lists can be applied; AI generation panels (妆容/图片/视频/实时变脸 UGC) cost quota
// and use a different flow, so they are not exposed.
const APPLICABLE_TYPE = 'GeneralAssetsList';

function body(res, what) {
  const b = res && res.body;
  if (!b || b.statusCode !== 0) throw Error(`${what}_FAILED: statusCode=${b && b.statusCode} message=${(b && (b.message || b.statusMsg)) || ''}`);
  return b.data || {};
}

function slim(item) {
  const extra = item.businessExtra || {};
  const file = Object.values(extra.fileMap || {})[0] || {};
  const cover = Object.values(extra.coverMap || {})[0] || {};
  return {
    template_id: String(item.templateId),
    title: item.title,
    panel_key: item.panelKey || null,
    desc: item.desc || '',
    material_type: extra.originalMaterialType || null,
    file_size: file.fileSize ?? null,
    cover_url: cover.url || null,
  };
}

class Library {
  constructor(mod) {
    this.mod = mod;
    this.items = new Map();
    this.applying = false;
  }

  selfCheck() {
    const missing = [];
    for (const [name, prop] of REQUIRED) {
      try {
        let v = this.mod(name);
        for (const k of prop.split('.')) v = v == null ? undefined : v[k];
        if (v == null) missing.push(`${name} :: ${prop}`);
      } catch (e) {
        missing.push(`${name} :: ${prop} (${e.message})`);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  ensureCompatible() {
    const { ok, missing } = this.selfCheck();
    if (!ok) throw Error(`INCOMPATIBLE_EDITOR: missing ${missing.join('; ')}`);
  }

  covers({ template_ids }) {
    if (!Array.isArray(template_ids) || !template_ids.length || template_ids.length > MAX_PREVIEW) {
      throw Error(`INVALID_TEMPLATE_IDS: pass 1-${MAX_PREVIEW} template ids`);
    }
    return template_ids.map((id) => {
      const it = this.items.get(String(id));
      if (!it) throw Error(`UNKNOWN_TEMPLATE: ${id}; call library_list or library_search first`);
      const s = slim(it);
      return { template_id: s.template_id, title: s.title, cover_url: s.cover_url };
    });
  }

  remember(items) {
    for (const it of items) if (it && it.templateId) this.items.set(String(it.templateId), it);
    return items.map(slim);
  }

  navEntries() {
    const groups = this.mod(M.nav).getDefaultNavList();
    const out = [];
    for (const group of groups) {
      for (const item of group) {
        const children = item.children || [];
        if (children.length) {
          for (const c of children) out.push({ panel_key: c.id, name: c.name, group: item.name, applicable: c.componentType === APPLICABLE_TYPE });
        } else {
          out.push({ panel_key: item.id, name: item.name, group: null, applicable: item.componentType === APPLICABLE_TYPE });
        }
      }
    }
    return out;
  }

  nav() {
    this.ensureCompatible();
    return { panels: this.navEntries().filter((e) => e.applicable) };
  }

  async list({ panel_key, category_id, cursor = 0, count = 30 }) {
    this.ensureCompatible();
    const valid = this.nav().panels.map((p) => p.panel_key);
    if (!valid.includes(panel_key)) throw Error(`INVALID_PANEL_KEY: ${panel_key}; valid: ${valid.join(', ')}`);
    const catData = body(await this.mod(M.category).getAssetCategory({ cursor: 0, count: 50, panelKey: panel_key }), 'GET_CATEGORY');
    const categories = (catData.categories || []).map((c) => ({ id: String(c.id), name: c.name }));
    if (!categories.length) throw Error(`NO_CATEGORIES: panel ${panel_key} returned no categories`);
    const catId = category_id === undefined ? categories[0].id : String(category_id);
    if (!categories.some((c) => c.id === catId)) throw Error(`INVALID_CATEGORY_ID: ${category_id}; valid: ${categories.map((c) => `${c.id}(${c.name})`).join(', ')}`);
    const data = body(await this.mod(M.list).getAssetList({ cursor, count, categoryIds: JSON.stringify([catId]) }), 'GET_ASSET_LIST');
    const info = data.dataInfos || {};
    const raw = (info.template || []).map((t) => ({ ...t, panelKey: t.panelKey || panel_key }));
    return { panel_key, categories, category_id: catId, items: this.remember(raw), next_cursor: info.cursor ?? null, has_more: !!info.hasNext };
  }

  async search({ query }) {
    this.ensureCompatible();
    if (typeof query !== 'string' || !query.trim()) throw Error('INVALID_QUERY: query must be a non-empty string');
    const q = query.trim();
    const applicable = this.nav().panels.map((p) => p.panel_key);
    const searchable = new Set(this.mod(M.navConst).SearchNavItemKeys.flat());
    const server = await Promise.all(
      applicable
        .filter((k) => searchable.has(k))
        .map(async (k) => {
          const data = body(await this.mod(M.search).searchAsset({ searchWord: q, panelList: k, getCategoryInfo: true, getAuthorInfo: true }), 'SEARCH');
          return ((data.dataInfos && data.dataInfos.template) || []).map((t) => ({ ...t, panelKey: t.panelKey || k }));
        }),
    );
    const allowed = new Set(applicable);
    const seen = new Map();
    for (const it of server.flat()) {
      if (!it || !it.templateId || !allowed.has(it.panelKey)) continue;
      if (!seen.has(String(it.templateId))) seen.set(String(it.templateId), it);
    }
    return { query: q, items: this.remember([...seen.values()]) };
  }

  async download(item) {
    const EF = this.mod(M.ef);
    const file = Object.values((item.businessExtra && item.businessExtra.fileMap) || {})[0];
    if (!file || !file.url || !file.md5) throw Error(`NO_PACKAGE_FILE: template ${item.templateId} has no downloadable package`);
    const root = path.join(EF.Resource.EditorFoundation.env.getSharedResourcesPath(), 'LokiDownload', 'assets');
    fs.mkdirSync(root, { recursive: true });
    const pkg = path.join(root, `${item.templateId}.ehpackage`);
    const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
    if (fs.existsSync(pkg) && md5(pkg) === file.md5) return { pkg, cached: true };
    const tmp = `${pkg}_temp`;
    const code = await this.mod(M.util).downloadLokiFile(file.url, tmp);
    if (!(code > -1) || !fs.existsSync(tmp)) throw Error(`DOWNLOAD_FAILED: template ${item.templateId} code=${code}`);
    const got = md5(tmp);
    if (got !== file.md5) {
      fs.rmSync(tmp, { force: true });
      throw Error(`MD5_MISMATCH: template ${item.templateId} expected ${file.md5} got ${got}`);
    }
    fs.renameSync(tmp, pkg);
    return { pkg, cached: false };
  }

  async apply({ template_id, auto_instantiate = true }) {
    this.ensureCompatible();
    const item = this.items.get(String(template_id));
    if (!item) throw Error(`UNKNOWN_TEMPLATE: ${template_id}; call library_list or library_search first`);
    const EF = this.mod(M.ef);
    if (!EF.ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
    const sceneService = this.mod(M.scene).SceneModule.getEditingSceneService();
    const sceneEditor = sceneService && sceneService.sceneEditor;
    if (!sceneEditor) throw Error('NO_EDITING_SCENE');
    if (this.applying) throw Error('APPLY_IN_PROGRESS');
    this.applying = true;
    try {
      const { pkg, cached } = await this.download(item);
      const syncer = EF.PreviewSyncer.getInstance();
      syncer.lockReloadSticker('ImportAssetFromAssetLibrary');
      EF.UndoSystem.instance.start(`import asset library: ${item.title}`);
      let res;
      try {
        res = await EF.Resource.AssetPackageManager.instance.import({
          path: pkg,
          assetPackageName: item.title,
          assetPackageID: String(item.templateId),
          autoInstantiate: !!auto_instantiate,
          windowID: '',
          undoID: EF.Resource.ResourceUndoManager.createImportUndoID(String(item.templateId)),
          sceneEditor,
        });
      } finally {
        EF.UndoSystem.instance.end();
        syncer.unlockReloadSticker('ImportAssetFromAssetLibrary');
      }
      if (!res || !res.result || res.errorCode !== undefined) throw Error(`IMPORT_FAILED: template ${item.templateId} errorCode=${res && res.errorCode}`);
      if (auto_instantiate) syncer.requestReloadSticker();
      const resources = (res.result.resourceItems || []).map((r) => {
        try {
          return { name: r.name, path: r.path || r.filePath || null };
        } catch (_) {
          return {};
        }
      });
      return { template_id: String(item.templateId), title: item.title, package_path: pkg, package_cached: cached, auto_instantiated: !!auto_instantiate, resources };
    } finally {
      this.applying = false;
    }
  }
}

// ---- Editor "add object" menu (toolbar 美妆/美型/AI 实时变脸 and the hierarchy add menu) ----
const MENU = {
  orionui: '@orion/orion-sdk/orionui',
  dynamic: '@orion/Business/BusinessCommon/MenuConfig/DynamicMenuConfig/DynamicMenuConfig',
  sceneOps: '@orion/Business/Agent/SceneOps/SceneOpsService',
};
// Cloud AI generation / chat entries: they consume account quota or need user uploads, so they are not exposed.
const MENU_DENY = new Set(['AIDraw', 'AIVideo', 'AIImageCaption', 'Audio_AIMusic', 'AICombine', 'AIChat', 'AIObjectLens']);

Library.prototype.menuApi = function () {
  const ui = this.mod(MENU.orionui);
  const EF = this.mod(M.ef);
  return { I18n: ui.I18n, emc: ui.ExtensionManager.host.getAPI(EF.Extension.MenuConfig.MenuConfigAPIKey).getEntityMenuConfig(), dyn: this.mod(MENU.dynamic).DynamicMenuConfigInfo.instance };
};

Library.prototype.menuEntries = function () {
  const { I18n, emc, dyn } = this.menuApi();
  const tr = (k) => (k ? I18n.t(k) || k : '');
  const out = [];
  const walk = (node, trail) => {
    const cfg = emc.getConfig(node.id) || node;
    const name = tr(cfg.displayKey) || tr(node.displayKey) || node.displayName || node.id;
    const kids = node.children || [];
    if (kids.length) {
      kids.forEach((c) => walk(c, [...trail, name]));
      return;
    }
    if (MENU_DENY.has(node.id)) return;
    out.push({
      menu_id: node.id,
      name,
      path: trail.join('/'),
      kind: cfg.hasPrefab ? 'package' : 'builtin',
      components: (cfg.components || []).map((c) => c.extraType || c.rttiType).filter(Boolean),
    });
  };
  const tree = dyn.updateOrderEntityMenuConfigs();
  (Array.isArray(tree) ? tree : [tree]).forEach((n) => walk(n, []));
  return out;
};

Library.prototype.menuList = function ({ query } = {}) {
  const all = this.menuEntries();
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const items = q ? all.filter((e) => `${e.path}/${e.name}/${e.menu_id}`.toLowerCase().includes(q)) : all;
  return { total: all.length, items };
};

function countSceneObjects(sceneEditor) {
  return sceneEditor.getAllSceneObjectEditors().length;
}

Library.prototype.menuAdd = async function ({ menu_id }) {
  if (typeof menu_id !== 'string' || !menu_id) throw Error('INVALID_MENU_ID: menu_id must be a non-empty string');
  if (MENU_DENY.has(menu_id)) throw Error(`MENU_ITEM_NOT_ALLOWED: ${menu_id} is a cloud AI generation entry`);
  const entry = this.menuEntries().find((e) => e.menu_id === menu_id);
  if (!entry) throw Error(`UNKNOWN_MENU_ID: ${menu_id}; call menu_list to find ids`);
  const EF = this.mod(M.ef);
  if (!EF.ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
  const service = this.mod(M.scene).SceneModule.getEditingSceneService();
  const sceneEditor = service && service.sceneEditor;
  if (!sceneEditor) throw Error('NO_EDITING_SCENE');
  const { emc, dyn } = this.menuApi();
  const before = countSceneObjects(sceneEditor);
  let created = null;
  if (entry.kind === 'package') {
    if (!dyn.downloadTaskMap.has(menu_id)) throw Error(`PACKAGE_NOT_REGISTERED: ${menu_id} has no download task in this editor session`);
    await dyn.handleDownloadPromise(menu_id);
  } else {
    const config = emc.getConfig(menu_id);
    if (!config) throw Error(`UNKNOWN_MENU_ID: ${menu_id}`);
    const target = await this.mod(MENU.sceneOps).createEntity(sceneEditor, config, entry.name, () => {});
    created = target && target.name ? target.name : null;
  }
  const after = countSceneObjects(sceneEditor);
  if (after <= before) throw Error(`MENU_ADD_NO_EFFECT: ${menu_id} did not add scene objects (see editor log)`);
  return { menu_id, name: entry.name, path: entry.path, kind: entry.kind, created_object: created, scene_objects_added: after - before };
};

// 塑型画笔 (FaceWarpX) components store brush data per item next to its intensity; the official MCP can
// read the intensity but cannot write it back without the brush data, so these go through the editor.
const WARP_EDITORS = { FaceWarpXComponentEditor: 'Human', CatFaceWarpXComponentEditor: 'Cat', DogFaceWarpXComponentEditor: 'Dog' };

function sceneObjectPath(so) {
  const names = [];
  for (let p = so; p; p = p.parent) names.unshift(p.name);
  return names.join('/');
}

Library.prototype.faceWarps = function () {
  const EF = this.mod(M.ef);
  if (!EF.ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
  const service = this.mod(M.scene).SceneModule.getEditingSceneService();
  const sceneEditor = service && service.sceneEditor;
  if (!sceneEditor) throw Error('NO_EDITING_SCENE');
  return sceneEditor
    .getAllComponentEditors()
    .filter((c) => Object.prototype.hasOwnProperty.call(WARP_EDITORS, c.constructor.name))
    .map((c) => ({ comp: c, path: sceneObjectPath(c.sceneObject), face: WARP_EDITORS[c.constructor.name] }));
};

function describeWarp({ comp, path: p, face }) {
  return {
    object_path: p,
    face,
    enabled: !!comp.enabled,
    items: (comp.items || []).map((it, index) => ({ index, label: it.labelName || null, intensity: it.intensity })),
  };
}

Library.prototype.faceWarpList = function () {
  return { face_warps: this.faceWarps().map(describeWarp) };
};

Library.prototype.faceWarpSetIntensity = async function ({ object_path, intensity, item_index }) {
  if (typeof object_path !== 'string' || !object_path.trim()) throw Error('INVALID_OBJECT_PATH: object_path must be a non-empty string');
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 100) throw Error('INVALID_INTENSITY: intensity must be a number in [0, 100]');
  const want = object_path.trim().replace(/^\/+|\/+$/g, '');
  const all = this.faceWarps();
  const hits = all.filter((w) => w.path === want || w.path.endsWith(`/${want}`));
  if (hits.length === 0) throw Error(`FACE_WARP_NOT_FOUND: ${want}; available: ${all.map((w) => w.path).join(' | ') || '(none)'}`);
  if (hits.length > 1) throw Error(`AMBIGUOUS_OBJECT_PATH: ${want} matches ${hits.map((w) => w.path).join(' | ')}; pass a longer path`);
  const { comp } = hits[0];
  const items = comp.items || [];
  if (!items.length) throw Error(`NO_WARP_ITEMS: ${hits[0].path} has no brush items`);
  if (item_index !== undefined && (!Number.isInteger(item_index) || item_index < 0 || item_index >= items.length)) {
    throw Error(`INVALID_ITEM_INDEX: ${item_index}; ${hits[0].path} has ${items.length} item(s)`);
  }
  const before = describeWarp(hits[0]);
  const next = items.map((it, i) => (item_index === undefined || i === item_index ? it.withIntensity(intensity) : it));
  const EF = this.mod(M.ef);
  EF.UndoSystem.instance.start(`set face warp intensity: ${hits[0].path}`);
  let res;
  try {
    res = comp.setProperty('items', next);
  } finally {
    EF.UndoSystem.instance.end();
  }
  if (res instanceof Error) throw Error(`SET_PROPERTY_FAILED: ${res.message}`);
  const after = describeWarp(hits[0]);
  const changed = after.items.filter((it) => item_index === undefined || it.index === item_index);
  if (changed.some((it) => it.intensity !== intensity)) throw Error(`WRITE_NOT_APPLIED: ${JSON.stringify(after.items)}`);
  return { object_path: hits[0].path, before: before.items, after: after.items };
};

const CONFIG_PATH = path.join(__dirname, '..', 'config.local.json');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Dev-only escape hatch for probing editor internals. The flag is read on every call, so turning
// devEval off in config.local.json disables it immediately without reopening editor windows.
Library.prototype.devEval = async function ({ code }) {
  let devEval = false;
  try {
    devEval = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).devEval === true;
  } catch (_) {}
  if (!devEval) throw Error('EVAL_DISABLED');
  if (typeof code !== 'string' || !code) throw Error('code must be a non-empty string');
  const value = await new AsyncFunction('mod', 'require', code)(this.mod, require);
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
};

// RPC method name -> Library method. The runtime dispatches through this table, so adding a method
// here takes effect without reopening editor windows.
const METHODS = {
  self_check: 'selfCheck',
  library_nav: 'nav',
  library_list: 'list',
  library_search: 'search',
  library_covers: 'covers',
  library_apply: 'apply',
  menu_list: 'menuList',
  menu_add: 'menuAdd',
  face_warp_list: 'faceWarpList',
  face_warp_set_intensity: 'faceWarpSetIntensity',
  dev_eval: 'devEval',
};

module.exports = { Library, slim, M, MENU, MENU_DENY, REQUIRED, MAX_PREVIEW, METHODS };
