'use strict';
// 素材广场 (aigc_material: assets other creators shared, AI results included) and 收藏 (the user's
// collected assets). Square assets are applied through the asset library's own objects, the same calls
// its cards make, so nothing is generated again and no quota is spent; collected assets go back to the
// flow of the panel they came from.
const { M, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');

const SQUARE_PANEL = 'aigc_material';
const COLLECTION_PANEL = 'collection';
// The page the collection directories are configured under (CollectAssetsPagePanel).
const COLLECTION_PAGE = 'collection';
// AIAssetsList's own page size and default ranker (AIScreenType.PublishNumber).
const SQUARE_RANKER = 5;
// Square applies finish asynchronously (download, then an AssetLoaded callback creates the objects), and
// an AI makeup adds one object per face part. Both values are guesses: the slowest real apply seen so far
// took a few seconds.
const TIMING = { applyTimeoutMs: 60000, settleMs: 1500, pollMs: 200 };

function parseJson(s) {
  if (typeof s !== 'string' || !s) return {};
  try {
    return JSON.parse(s);
  } catch (_) {
    return {};
  }
}

// What a square card holds, read from the raw record the way AIAssetsList.getAssetItemByQuery reads it.
function squareParts(raw) {
  const extra = parseJson(raw.extra);
  return { ai: parseJson(extra.AI_param), info: parseJson(extra.asset_info), categoryId: raw.category ? raw.category.categoryId : undefined };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const methods = {
  // The apply route of AIAssetsCard.applyAsset, or null when the card has nothing to apply.
  squareKind(raw) {
    const { AIAssetCategory } = this.mod(M.aiConst);
    const { PublishType } = this.mod(M.publish);
    const { resourceType } = this.mod(M.resourceTypes);
    const { ImportAssetType } = this.mod(M.importTypes);
    const { ai, info, categoryId } = squareParts(raw);
    if (categoryId === AIAssetCategory.AIPicture || info.subType === PublishType.AiImage) return (ai.resPictureUri || []).length ? 'ai_image' : null;
    if (categoryId === AIAssetCategory.AIMakeup || info.subType === PublishType.AiMakeup) return (ai.resMakeup || []).length ? 'ai_makeup' : null;
    if (categoryId === AIAssetCategory.UGCGAN) return 'custom_gan';
    // Collected cards come without a category, and the card then goes by whichever square category the
    // user last opened; their AI results still say what they are.
    if (categoryId === undefined && info.subType === undefined) {
      if ((ai.resPictureUri || []).length) return 'ai_image';
      if ((ai.resMakeup || []).length) return 'ai_makeup';
    }
    if (info.subType !== PublishType.NormalAsset) return null;
    if (info.resourceExt === resourceType.Ehpackage) return 'package';
    const picture = info.resourceExt === resourceType.Picture;
    if (!picture && info.resourceExt !== resourceType.Gif) return null;
    if (info.assetType === ImportAssetType.Foreground) return 'foreground_sticker';
    if (info.assetType === ImportAssetType.FaceMask) return 'face_sticker';
    if (picture && info.assetType === ImportAssetType.Filter) return 'filter';
    return null;
  },

  // The asset kind library tools report: square cards by their apply route, everything else is a package.
  assetKind(raw) {
    return raw.panelKey === SQUARE_PANEL ? this.squareKind(raw) : 'package';
  },

  async squareList({ category_id, cursor = 0, count = 30 }) {
    this.ensureCompatible('square');
    const catBody = await this.mod(M.aiCategory).getAIAssetCategory({ cursor: 0, count: 50, panelKey: SQUARE_PANEL });
    if (!catBody || catBody.statusCode !== 0) throw Error(`GET_CATEGORY_FAILED: statusCode=${catBody && catBody.statusCode} message=${(catBody && catBody.message) || ''}`);
    const categories = ((catBody.data && catBody.data.categories) || []).map((c) => ({ id: String(c.id), name: c.name }));
    if (!categories.length) throw Error(`NO_CATEGORIES: panel ${SQUARE_PANEL} returned no categories`);
    const catId = category_id === undefined ? categories[0].id : String(category_id);
    if (!categories.some((c) => c.id === catId)) throw Error(`INVALID_CATEGORY_ID: ${category_id}; valid: ${categories.map((c) => `${c.id}(${c.name})`).join(', ')}`);
    const res = await this.mod(M.aiList).getAIAssetList({ panelKey: SQUARE_PANEL, count, cursor, categoryIds: JSON.stringify([catId]), ranker: SQUARE_RANKER });
    if (!res || res.statusCode !== 0) throw Error(`GET_ASSET_LIST_FAILED: statusCode=${res && res.statusCode} message=${(res && res.message) || ''}`);
    const info = ((res.data || [])[0] || {}).dataInfos || {};
    // List records carry no category; the card's apply route depends on it, so it is filled in here.
    const raw = (info.template || []).map((t) => ({ ...t, panelKey: t.panelKey || SQUARE_PANEL, category: t.category || { categoryId: Number(catId) } }));
    return { panel_key: SQUARE_PANEL, categories, category_id: catId, ...this.page(raw), next_cursor: info.cursor ?? null, has_more: !!info.hasNext };
  },

  async collectionList({ category_id, cursor }) {
    this.ensureCompatible('square');
    const dirs = await this.mod(M.secondPanel).getAssetsSecondPanel({ page: COLLECTION_PAGE });
    if (!dirs || dirs.code !== 0) throw Error(`GET_COLLECTION_DIRECTORIES_FAILED: code=${dirs && dirs.code} message=${(dirs && dirs.message) || ''}`);
    // Douyin / karaoke music collections come from the music APIs (the music_* tools), not this list.
    const { NavItemKey } = this.mod(M.navConst);
    const music = new Set([NavItemKey.DouyinMusicAssets, NavItemKey.karaokeMusicAssets]);
    const directories = ((dirs.data && dirs.data.directories) || []).filter((d) => !music.has((d.panelList || [])[0]));
    if (!directories.length) throw Error('NO_CATEGORIES: the collection page returned no directories');
    const categories = directories.map((d) => ({ id: d.name, name: d.name }));
    const dir = category_id === undefined ? directories[0] : directories.find((d) => d.name === String(category_id));
    if (!dir) throw Error(`INVALID_CATEGORY_ID: ${category_id}; valid: ${categories.map((c) => c.id).join(', ')}`);
    const res = await this.mod(M.collect).getCollections({ cursor: cursor === undefined ? '' : String(cursor), panelList: dir.panelList, channel: 1 });
    const b = res && res.body;
    if (!b || b.code !== 0) throw Error(`GET_COLLECTIONS_FAILED: code=${b && b.code} message=${(b && b.message) || ''}`);
    const data = b.data || {};
    const raw = (data.categorizedCollections || []).map((c) => ({ ...(c.templateData || {}), panelKey: c.panelKey }));
    return { panel_key: COLLECTION_PANEL, categories, category_id: dir.name, ...this.page(raw), next_cursor: data.cursor || null, has_more: !!data.hasMore };
  },

  // Result images of an AI image card, as viewable URLs (the card's group picture preview).
  async libraryImages({ item }) {
    this.ensureCompatible('square');
    if (!item || this.squareKind(item) !== 'ai_image') throw Error('NOT_AN_AI_IMAGE: only AI image cards from 素材广场 have result images');
    const uris = squareParts(item).ai.resPictureUri;
    const res = await this.mod(M.aiEffectApi).getDYEHFileUrls({ uriList: uris });
    if (!res || res.code !== 0) throw Error(`GET_IMAGE_URLS_FAILED: code=${res && res.code} message=${(res && res.message) || ''}`);
    return uris.map((uri, i) => ({ image_index: i, url: (res.data && res.data[uri] && res.data[uri].url) || null }));
  },

  // Applies a square card through the asset library instance, then waits for the objects its callbacks add.
  async squareApply({ item: raw, auto_instantiate = true, image_index }) {
    this.ensureCompatible('square');
    const kind = this.squareKind(raw);
    if (!kind) throw Error(`UNSUPPORTED_SQUARE_ASSET: template ${raw.templateId} has nothing the asset library can apply`);
    if (!auto_instantiate && kind !== 'package') throw Error(`AUTO_INSTANTIATE_UNSUPPORTED: ${kind} assets are always placed in the scene`);
    const { sceneEditor, project } = editingScene(this);
    const lib = this.mod(M.assetsLibrary).AssetsLibrary.getInstance();
    const square = lib.AIAssets.applySquareAsset;
    if (square.assetIsApplying.getValue()) throw Error('APPLY_IN_PROGRESS');
    const asset = await lib.AIAssets.assetsList.getAssetItemByQuery(raw);
    const card = { name: asset.title, templateId: asset.templateId };
    const uris = (asset.aiParam && asset.aiParam.resPictureUri) || [];
    if (image_index !== undefined && kind !== 'ai_image') throw Error(`INVALID_IMAGE_INDEX: image_index only applies to ai_image cards, not ${kind}`);
    const index = image_index === undefined ? 0 : image_index;
    if (kind === 'ai_image' && !(Number.isInteger(index) && index >= 0 && index < uris.length)) {
      throw Error(`INVALID_IMAGE_INDEX: ${index}; this card has ${uris.length} images (0-${uris.length - 1})`);
    }
    const ext = (asset.customized && asset.customized.realExt) || '.jpg';
    const gif = asset.customized && asset.customized.resourceExt === this.mod(M.resourceTypes).resourceType.Gif;
    const before = sceneObjectSet(sceneEditor);
    const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
    if (kind === 'package') await square.applyNormalAsset(asset, !!auto_instantiate);
    else if (kind === 'foreground_sticker') await square.applyForegroundAsset(asset, gif ? '.gif' : ext);
    else if (kind === 'face_sticker') await square.applyFaceFollowAsset(asset, gif ? '.gif' : ext);
    else if (kind === 'filter') await square.applyFilterAsset(asset, ext);
    else if (kind === 'ai_image') await lib.AIAssets.AIAssetPictureCtx.onApplyAIAsset({ ...card, uriInfos: [{ uri: uris[index] }] }, asset);
    else if (kind === 'ai_makeup') await lib.AIAssets.AIAssetMakeupCtx.onApplyAIAsset({ ...card, uriInfos: asset.aiParam.resMakeup }, asset);
    else await lib.UGanManager.onApplyAIAsset({ ...card, uriInfos: [{ uri: '' }] }, asset);
    const added = kind === 'package' && !auto_instantiate ? [] : await this.waitForAdded(before, sceneEditor, raw.templateId);
    const packageFolders = packageRootsAdded(project, beforePaths);
    if (kind === 'package' && !auto_instantiate && !packageFolders.length) throw Error(`SQUARE_APPLY_NO_RESOURCE: template ${raw.templateId} imported nothing`);
    recordImport(project, added, packageFolders);
    return {
      template_id: String(raw.templateId),
      title: raw.title,
      kind,
      ...(kind === 'ai_image' ? { image_index: index } : {}),
      auto_instantiated: !!auto_instantiate,
      added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })),
      package_folders: packageFolders,
    };
  },

  async waitForAdded(before, sceneEditor, templateId) {
    const { applyTimeoutMs, settleMs, pollMs } = { ...TIMING, ...this.squareTiming };
    const start = Date.now();
    let last = [];
    let changedAt = start;
    for (;;) {
      const now = addedObjectEditors(before, sceneEditor);
      if (now.length !== last.length) {
        last = now;
        changedAt = Date.now();
      }
      if (last.length && Date.now() - changedAt >= settleMs) return last;
      if (Date.now() - start >= applyTimeoutMs) {
        if (last.length) return last;
        throw Error(`SQUARE_APPLY_NO_OBJECT: template ${templateId} added nothing to the scene within ${applyTimeoutMs / 1000}s (download or import failed)`);
      }
      await sleep(pollMs);
    }
  },
};

const METHODS = { library_images: 'libraryImages' };

module.exports = { methods, METHODS, SQUARE_PANEL, COLLECTION_PANEL };
