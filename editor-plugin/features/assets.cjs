'use strict';
// Official asset library operations, implemented on the editor's own modules so requests carry
// the editor's login state and imports follow the same path as the asset library panel.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { M, body, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');

// Editor internals each feature relies on; checked up front so an editor upgrade fails with a precise list.
const REQUIRED = {
  assets: [
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
  ],
  menu: [
    [M.orionui, 'I18n.t'],
    [M.orionui, 'ExtensionManager.host.getAPI'],
    [M.ef, 'Extension.MenuConfig.MenuConfigAPIKey'],
    [M.dynamic, 'DynamicMenuConfigInfo.instance'],
    [M.sceneOps, 'createEntity'],
    [M.hover, 'HoverTipsMap.getObjectTipsBy'],
  ],
  project: [
    [M.toolbar, 'closeProjectAndBackToHome'],
    [M.ipc, 'OpenProjectFromHomeCommand'],
    [M.sender, 'EditSender.getInstance'],
    [M.ipc, 'GetProjectProcessStatusCommand'],
    [M.multiProcess, 'CHILD_PROCESS_LIMIT'],
    [M.multiProcess, 'ChildProcessStatus.Used'],
  ],
  works: [
    [M.worksPanel, 'apiTemplatesPanel'],
    [M.worksCategory, 'apiTemplatesCategory'],
    [M.worksCategory, 'apiSearchTemplatesCategory'],
    [M.worksUtil, 'transformTemplate'],
    [M.worksDownload, 'DownloadTemplateModel.prototype.startDownload'],
    [M.worksDownload, 'DownloadTemplateModel.prototype.getTemplateProjectPath'],
  ],
};
const MAX_PREVIEW = 8;

// Only plain asset lists can be applied; AI generation panels (妆容/图片/视频/实时变脸 UGC) cost quota
// and use a different flow, so they are not exposed.
const APPLICABLE_TYPE = 'GeneralAssetsList';

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

  // Called directly with a feature name, or over RPC with a params object ({} / { feature }).
  selfCheck(arg) {
    const feature = typeof arg === 'string' ? arg : arg && arg.feature;
    if (feature !== undefined && !Object.prototype.hasOwnProperty.call(REQUIRED, feature)) throw Error(`UNKNOWN_FEATURE: ${feature}`);
    const features = {};
    const missing = [];
    for (const [name, list] of Object.entries(REQUIRED)) {
      if (feature && name !== feature) continue;
      const own = [];
      for (const [mod, prop] of list) {
        try {
          let v = this.mod(mod);
          for (const k of prop.split('.')) v = v == null ? undefined : v[k];
          if (v == null) own.push(`${mod} :: ${prop}`);
        } catch (e) {
          own.push(`${mod} :: ${prop} (${e.message})`);
        }
      }
      features[name] = own.length === 0;
      missing.push(...own);
    }
    return { ok: missing.length === 0, missing, features };
  }

  ensureCompatible(feature = 'assets') {
    const { ok, missing } = this.selfCheck(feature);
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

  // The search API returns only ~5 items per request when several panels are combined, and ignores
  // paging parameters; asking each panel separately returns the full match list.
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
    const { EF, sceneEditor, project } = editingScene(this);
    if (this.applying) throw Error('APPLY_IN_PROGRESS');
    this.applying = true;
    try {
      const { pkg, cached } = await this.download(item);
      const before = sceneObjectSet(sceneEditor);
      const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
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
      const resources = (res.result.resourceItems || []).map((r) => ({ name: r.name, path: r.path || r.filePath || null }));
      const added = addedObjectEditors(before, sceneEditor);
      const packageFolders = packageRootsAdded(project, beforePaths);
      recordImport(project, added, packageFolders);
      return {
        template_id: String(item.templateId),
        title: item.title,
        package_path: pkg,
        package_cached: cached,
        auto_instantiated: !!auto_instantiate,
        added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })),
        package_folders: packageFolders,
        resources,
      };
    } finally {
      this.applying = false;
    }
  }
}

const METHODS = {
  self_check: 'selfCheck',
  library_nav: 'nav',
  library_list: 'list',
  library_search: 'search',
  library_covers: 'covers',
  library_apply: 'apply',
};

module.exports = { Library, slim, REQUIRED, MAX_PREVIEW, METHODS };
