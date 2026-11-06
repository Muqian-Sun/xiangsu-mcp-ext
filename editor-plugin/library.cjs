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
    return { panels: this.navEntries().filter((e) => e.applicable) };
  }

  async list({ panel_key, category_id, cursor = 0, count = 30 }) {
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
    if (typeof query !== 'string' || !query.trim()) throw Error('INVALID_QUERY: query must be a non-empty string');
    const groups = this.mod(M.navConst).SearchNavItemKeys;
    const applicable = new Set(this.nav().panels.map((p) => p.panel_key));
    const results = await Promise.all(
      groups.map(async (keys) => {
        const data = body(await this.mod(M.search).searchAsset({ searchWord: query.trim(), panelList: keys.join(','), getCategoryInfo: true, getAuthorInfo: true }), 'SEARCH');
        return (data.dataInfos && data.dataInfos.template) || [];
      }),
    );
    const seen = new Map();
    for (const it of results.flat()) {
      if (!it || !it.templateId || !applicable.has(it.panelKey)) continue;
      if (!seen.has(String(it.templateId))) seen.set(String(it.templateId), it);
    }
    return { query: query.trim(), items: this.remember([...seen.values()]) };
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

module.exports = { Library, slim, M };
