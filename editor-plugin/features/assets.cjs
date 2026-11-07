'use strict';
// Official asset library operations, implemented on the editor's own modules so requests carry
// the editor's login state and imports follow the same path as the asset library panel.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { M, body, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');
const { SQUARE_PANEL } = require('./square.cjs');

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
  square: [
    [M.aiCategory, 'getAIAssetCategory'],
    [M.aiList, 'getAIAssetList'],
    [M.aiConst, 'AIAssetCategory.AIPicture'],
    [M.aiConst, 'AIAssetCategory.AIMakeup'],
    [M.aiConst, 'AIAssetCategory.UGCGAN'],
    [M.publish, 'PublishType.AiImage'],
    [M.publish, 'PublishType.AiMakeup'],
    [M.publish, 'PublishType.NormalAsset'],
    [M.resourceTypes, 'resourceType.Ehpackage'],
    [M.importTypes, 'ImportAssetType.Foreground'],
    [M.assetsLibrary, 'AssetsLibrary.getInstance'],
    [M.collect, 'getCollections'],
    [M.navConst, 'NavItemKey.DouyinMusicAssets'],
    [M.navConst, 'NavItemKey.karaokeMusicAssets'],
    [M.secondPanel, 'getAssetsSecondPanel'],
    [M.aiEffectApi, 'getDYEHFileUrls'],
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
    [M.ipc, 'OpenProjectFromEditCommand'],
    [M.sender, 'EditSender.getInstance'],
  ],
  works: [
    [M.worksPanel, 'apiTemplatesPanel'],
    [M.worksCategory, 'apiTemplatesCategory'],
    [M.worksCategory, 'apiSearchTemplatesCategory'],
    [M.worksUtil, 'transformTemplate'],
    [M.worksDownload, 'DownloadTemplateModel.prototype.startDownload'],
    [M.worksDownload, 'DownloadTemplateModel.prototype.getTemplateProjectPath'],
  ],
  icon: [
    [M.iconPreview, 'iconTypeToProjectIconPathMap'],
    [M.iconPreview, 'IconPreviewManager.getInstance'],
    [M.iconPreview, 'IconPreviewManager.prototype.importAndCreateIcon'],
    [M.iconPreview, 'IconPreviewManager.prototype.setIconExistState'],
    [M.iconPreview, 'IconPreviewManager.prototype.saveIconJson'],
    [M.iconPreview, 'IconPreviewManager.prototype.isIconCreated'],
    [M.iconPreview, 'IconPreviewManager.prototype.deleteIcon'],
    [M.iconPreview, 'IconPreviewManager.prototype.uploadDeleteIcon'],
    [M.iconWindow, 'showIconCreationWindow'],
  ],
  check: [
    [M.orionui, 'ExtensionManager.host.getAPI'],
    [M.submission, 'EffectSubmissionAPIKey'],
    [M.perfTest, 'PerfTestAPIKey'],
    [M.events, 'BusinessEventManager.TypeGuard'],
    [M.login, 'loginContribution.getLoginStatus'],
    [M.remoteAssets, 'RemoteAssetManager.getInstance'],
    [M.ef, 'Resource.EditorFoundation.env.getInstancePath'],
  ],
  submit: [
    [M.events, 'BusinessEventManager.TypeGuard'],
    [M.ef, 'EventManager_deprecated.TypeGuard'],
  ],
  mobile: [
    [M.mobilePreview, 'getCookie'],
    [M.mobilePreview, 'requestMobilePreviewURL'],
    [M.bizUtils, 'ExportEffectPackageUtils.registerSDKVersionMapping'],
    [M.remoteAssets, 'RemoteAssetManager.getInstance'],
  ],
  community: [
    [M.urls, 'Domain.kBackendApiURL'],
    [M.urls, 'DomainPath.kActivityAPI'],
    [M.urls, 'DomainPath.kTaskListAPI'],
    [M.urls, 'DomainPath.kGrowthTaskList'],
    [M.bizUtils, 'PlatformUtils.genSignData'],
    [M.bizUtils, 'UserAgentUtils.userAgentGenerator'],
    [M.orionui, 'CookieManager'],
    [M.activityTypes, 'getTypeName'],
    [M.activityTypes, 'TaskStatus.WAIT_RECEIVE'],
    [M.activityTypes, 'TaskStatus.WAIT_SUBMIT'],
    [M.activityTypes, 'growthTaskType.Newbie'],
    [M.inspirationConst, 'IS_COLLECT_PARAMS_TYPE.Default'],
    [M.inspirationBridge, 'markAgentInspirationUsed'],
  ],
  music: [
    [M.musicCategory, 'MusicCategoryModel.prototype.updateCategoryList'],
    [M.musicCategory, 'MusicCategoryModel.prototype.setSelectedCategory'],
    [M.musicList, 'MusicListModel.prototype.getNextMusicListForDouyin'],
    [M.musicList, 'MusicListModel.prototype.getNextSearchMusicListForDouyin'],
    [M.musicSquare, 'MusicSquareManager.instance.setDouyinMusicInfo'],
  ],
  preview: [
    [M.preview, 'PreviewManager.getInstance'],
    [M.preview, 'PreviewManager.prototype.cacheCurrentFrame'],
    [M.preview, 'PreviewManager.prototype.captureScreenshotToMemory'],
  ],
};

// Plain asset lists, 素材广场 and 收藏 can be applied; AI generation panels (妆容/图片/视频/实时变脸 UGC)
// cost quota and use a different flow, so they are not exposed.
const PANEL_KINDS = { GeneralAssetsList: 'general', AssetsSquareList: 'square', CollectionAssetsList: 'collection' };

function slim(item, kind) {
  const extra = item.businessExtra || {};
  const file = Object.values(extra.fileMap || {})[0] || {};
  const covers = Object.values(extra.coverMap || {});
  // Square cards keep a still and an animated cover; the still one is the preview image.
  const cover = covers.find((c) => c && c.iconType === 'image/png') || covers[0] || {};
  return {
    template_id: String(item.templateId),
    title: item.title,
    panel_key: item.panelKey || null,
    kind,
    desc: item.desc || '',
    material_type: extra.originalMaterialType || null,
    file_size: file.fileSize ?? null,
    cover_url: cover.url || null,
  };
}

class Library {
  constructor(mod, fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.mod = mod;
    this.fetch = fetchImpl;
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

  // Windows open and close while an agent works, so the plugin keeps no library state: the raw
  // records go back with the slim items and the MCP server hands one back to library_apply.
  // Square cards with nothing to apply are left out and counted.
  page(items) {
    const rows = items.filter((it) => it && it.templateId).map((it) => [it, this.assetKind(it)]);
    const raw = rows.filter(([, kind]) => kind).map(([it]) => it);
    const out = { items: rows.filter(([, kind]) => kind).map(([it, kind]) => slim(it, kind)), raw };
    const unsupported = rows.length - raw.length;
    return unsupported ? { ...out, unsupported } : out;
  }

  navEntries() {
    const groups = this.mod(M.nav).getDefaultNavList();
    const out = [];
    for (const group of groups) {
      for (const item of group) {
        const children = item.children || [];
        for (const c of children.length ? children : [item]) {
          const kind = PANEL_KINDS[c.componentType] || null;
          out.push({ panel_key: c.id, name: c.name, group: children.length ? item.name : null, kind, applicable: !!kind });
        }
      }
    }
    return out;
  }

  nav() {
    this.ensureCompatible();
    return { panels: this.navEntries().filter((e) => e.applicable).map(({ applicable, ...e }) => e) };
  }

  async list({ panel_key, category_id, cursor, count = 30 }) {
    this.ensureCompatible();
    const panels = this.nav().panels;
    const panel = panels.find((p) => p.panel_key === panel_key);
    if (!panel) throw Error(`INVALID_PANEL_KEY: ${panel_key}; valid: ${panels.map((p) => p.panel_key).join(', ')}`);
    if (panel.kind === 'collection') return this.collectionList({ category_id, cursor });
    if (cursor !== undefined && !(Number.isInteger(cursor) && cursor >= 0)) throw Error(`INVALID_CURSOR: ${cursor}; panel ${panel_key} pages by a numeric cursor`);
    if (panel.kind === 'square') return this.squareList({ category_id, cursor: cursor || 0, count });
    const catData = body(await this.mod(M.category).getAssetCategory({ cursor: 0, count: 50, panelKey: panel_key }), 'GET_CATEGORY');
    const categories = (catData.categories || []).map((c) => ({ id: String(c.id), name: c.name }));
    if (!categories.length) throw Error(`NO_CATEGORIES: panel ${panel_key} returned no categories`);
    const catId = category_id === undefined ? categories[0].id : String(category_id);
    if (!categories.some((c) => c.id === catId)) throw Error(`INVALID_CATEGORY_ID: ${category_id}; valid: ${categories.map((c) => `${c.id}(${c.name})`).join(', ')}`);
    const data = body(await this.mod(M.list).getAssetList({ cursor: cursor || 0, count, categoryIds: JSON.stringify([catId]) }), 'GET_ASSET_LIST');
    const info = data.dataInfos || {};
    const raw = (info.template || []).map((t) => ({ ...t, panelKey: t.panelKey || panel_key }));
    return { panel_key, categories, category_id: catId, ...this.page(raw), next_cursor: info.cursor ?? null, has_more: !!info.hasNext };
  }

  // The search API returns only ~5 items per request when several panels are combined, and ignores
  // paging parameters; asking each panel separately returns the full match list (素材广场 caps it at 1000),
  // which is then paged here.
  async search({ query, panel_key, offset = 0, count = 50 }) {
    this.ensureCompatible();
    if (typeof query !== 'string' || !query.trim()) throw Error('INVALID_QUERY: query must be a non-empty string');
    const q = query.trim();
    const applicable = this.nav().panels.map((p) => p.panel_key);
    const searchable = new Set(this.mod(M.navConst).SearchNavItemKeys.flat());
    const targets = applicable.filter((k) => searchable.has(k) && (panel_key === undefined || k === panel_key));
    if (panel_key !== undefined && !targets.length) {
      throw Error(`NOT_SEARCHABLE: ${panel_key}; searchable panels: ${applicable.filter((k) => searchable.has(k)).join(', ')}`);
    }
    const server = await Promise.all(
      targets
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
    const { items, raw, unsupported } = this.page([...seen.values()]);
    const end = offset + count;
    return {
      query: q,
      total: items.length,
      items: items.slice(offset, end),
      raw: raw.slice(offset, end),
      next_offset: end < items.length ? end : null,
      has_more: end < items.length,
      ...(unsupported ? { unsupported } : {}),
    };
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

  // `item` is a raw record from library_list / library_search.
  async apply({ item, auto_instantiate = true, image_index }) {
    this.ensureCompatible();
    if (!item || !item.templateId) throw Error('INVALID_TEMPLATE: pass the raw record returned by library_list / library_search');
    if (item.panelKey === SQUARE_PANEL) return this.squareApply({ item, auto_instantiate, image_index });
    if (image_index !== undefined) throw Error('INVALID_IMAGE_INDEX: image_index only applies to AI image cards from 素材广场');
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
        kind: 'package',
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
  library_apply: 'apply',
};

module.exports = { Library, slim, REQUIRED, METHODS };
