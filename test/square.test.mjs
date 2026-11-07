import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');
const { readImports } = require('../editor-plugin/features/common.cjs');

// Square cards as the editor's request APIs return them: extra is a JSON string holding AI_param and
// asset_info as JSON strings of their own (shapes taken from real 素材广场 records).
function card(id, title, { category, ai, info, cover = true } = {}) {
  const extra = {};
  if (ai) extra.AI_param = JSON.stringify(ai);
  if (info) extra.asset_info = JSON.stringify(info);
  if (!ai && !info) Object.assign(extra, { license: 'x', original_material_type: '2D image' });
  return {
    templateId: id,
    title,
    panelKey: 'aigc_material',
    ...(category ? { category: { categoryId: category } } : {}),
    extra: JSON.stringify(extra),
    businessExtra: {
      coverMap: cover ? { g: { url: `https://c/${id}.gif`, iconType: 'image/gif' }, p: { url: `https://c/${id}.png`, iconType: 'image/png' } } : {},
      fileMap: { f: { url: `https://cdn/${id}.zip`, md5: 'm' } },
    },
  };
}
const normal = (resourceExt, assetType, realExt) => ({ subType: 6, resourceExt, assetType, realExt });
const CARDS = {
  aiImage: card('901', '萌猫造型帽子', { category: 45004, ai: { resPictureUri: ['u0', 'u1', 'u2'], generateParams: { scene: 'MaterialLabWeb' } } }),
  aiMakeup: card('902', '白皙淡妆', { category: 45003, ai: { resMakeup: [{ type: 'rest', uri: 'm0', params: '{}' }, { type: 'lip', uri: 'm1', params: '{}' }] } }),
  gan: card('903', '粉色公主纱裙', { category: 45014 }),
  pkg: card('904', '可爱软质猫脸', { info: normal('Ehpackage', 'Asset3DDecorations', '.ehpackage') }),
  fg: card('905', '童子贴纸', { info: normal('Picture', 'Foreground', '.png') }),
  faceGif: card('906', '童趣猫耳', { info: normal('Gif', 'FaceMask') }),
  gifFilter: card('910', '动图滤镜', { info: normal('Gif', 'Filter', '.gif') }),
  filter: card('907', '复古胶片', { info: normal('Picture', 'Filter', '.jpg') }),
  noResult: card('908', '空图片', { category: 45004, ai: { resPictureUri: [] } }),
  legacy: card('909', '梦幻美妆面容'),
  collectedImage: card('911', '海边猫', { ai: { resPictureUri: ['c0'] } }),
  collectedMakeup: card('912', '白皙淡妆', { ai: { resMakeup: [{ type: 'rest', uri: 'm0' }] } }),
  collectedGan: card('913', '粉色公主纱裙'),
};

function setup({ busy = false, addsNothing = false } = {}) {
  const projectDir = tmpdir('xs-sq-');
  const calls = { applied: [], list: [], category: 0, collections: [], urls: [], search: [] };
  const group = { name: '素材', parent: null };
  const sceneObjects = [group];
  const resources = [];
  const sceneEditor = { getAllSceneObjectEditors: () => [...sceneObjects] };
  // What the asset library's callbacks do some time after the apply call returns.
  const later = (ms, names, folder) =>
    setTimeout(() => {
      if (addsNothing) return;
      for (const n of names) sceneObjects.push({ name: n, parent: group });
      if (folder) resources.push({ assetPath: path.join(projectDir, 'Assets', folder), builtin: false });
    }, ms);
  const square = {
    assetIsApplying: { getValue: () => busy },
    applyNormalAsset: async (asset, auto) => {
      calls.applied.push(['applyNormalAsset', asset.templateId, auto]);
      if (addsNothing) return;
      // Like FileNameUtils.getUniqueFileName, a second import of the same package gets a new folder.
      let folder = path.join(projectDir, 'Assets', asset.title);
      for (let i = 1; resources.some((r) => r.assetPath === folder); i++) folder = path.join(projectDir, 'Assets', `${asset.title} (${i})`);
      resources.push({ assetPath: folder, builtin: false });
      if (auto) sceneObjects.push({ name: asset.title, parent: group });
    },
    applyForegroundAsset: async (asset, ext) => (calls.applied.push(['applyForegroundAsset', asset.templateId, ext]), later(20, ['前景贴纸'])),
    applyFaceFollowAsset: async (asset, ext) => (calls.applied.push(['applyFaceFollowAsset', asset.templateId, ext]), later(20, ['跟脸贴纸'])),
    applyFilterAsset: async (asset, ext) => (calls.applied.push(['applyFilterAsset', asset.templateId, ext]), later(20, ['滤镜'])),
  };
  const assetsLibrary = {
    AIAssets: {
      applySquareAsset: square,
      // The fields of AIAssetsList.getAssetItemByQuery the apply routes read.
      assetsList: {
        getAssetItemByQuery: async (raw) => {
          const extra = JSON.parse(raw.extra);
          return {
            templateId: raw.templateId,
            title: raw.title,
            aiParam: extra.AI_param ? JSON.parse(extra.AI_param) : undefined,
            customized: extra.asset_info ? JSON.parse(extra.asset_info) : undefined,
          };
        },
      },
      AIAssetPictureCtx: { onApplyAIAsset: async (cardInfo, asset) => (calls.applied.push(['picture', cardInfo, asset.templateId]), later(20, ['AI 图片'])) },
      // One object per face part, arriving one after another.
      AIAssetMakeupCtx: {
        onApplyAIAsset: async (cardInfo, asset) => {
          calls.applied.push(['makeup', cardInfo, asset.templateId]);
          cardInfo.uriInfos.forEach((u, i) => later(20 + i * 25, [`AI 美妆_${u.type}`]));
        },
      },
    },
    UGanManager: { onApplyAIAsset: async (cardInfo, asset) => (calls.applied.push(['gan', cardInfo, asset.templateId]), later(20, [asset.title], asset.title)) },
  };
  const project = { path: projectDir, resourceManager: { getAllResources: () => [...resources] } };
  const searchByPanel = {
    aigc_material: [CARDS.aiImage, CARDS.legacy, CARDS.pkg, CARDS.aiMakeup],
    sticker: [{ templateId: '11', title: '猫耳贴纸', panelKey: 'sticker', businessExtra: { coverMap: { c: { url: 'https://c/11.png' } } } }],
  };
  const modules = {
    [M.nav]: {
      getDefaultNavList: () => [
        [
          { id: 'dyeh_latest', name: '最新', componentType: 'GeneralAssetsList' },
          { id: 'collection', name: '收藏', componentType: 'CollectionAssetsList' },
          { id: 'aigc_material', name: '素材广场', componentType: 'AssetsSquareList' },
        ],
        [{ id: 'ai_picture', name: '图片', componentType: 'AIPicture' }],
        [{ id: 'sticker', name: '跟脸贴纸', componentType: 'GeneralAssetsList' }],
      ],
    },
    [M.navConst]: { SearchNavItemKeys: [['aigc_material'], ['sticker']], NavItemKey: { DouyinMusicAssets: 'dy_music', karaokeMusicAssets: 'k_music' } },
    [M.search]: {
      searchAsset: async (p) => (calls.search.push(p), { body: { statusCode: 0, data: { dataInfos: { template: searchByPanel[p.panelList] || [] } } } }),
    },
    [M.aiCategory]: {
      getAIAssetCategory: async (p) => (calls.category++, calls.categoryParams = p, { statusCode: 0, data: { categories: [{ id: 45004, name: '图片' }, { id: 45003, name: '妆容' }] } }),
    },
    [M.aiList]: {
      getAIAssetList: async (p) => {
        calls.list.push(p);
        const byCat = { '["45004"]': [{ ...CARDS.aiImage, category: null }, { ...CARDS.noResult, category: null }], '["45003"]': [{ ...CARDS.aiMakeup, category: null }] };
        return { statusCode: 0, data: [{ dataInfos: { template: byCat[p.categoryIds] || [], cursor: p.cursor + 2, hasNext: true } }] };
      },
    },
    [M.aiConst]: { AIAssetCategory: { AIMakeup: 45003, AIPicture: 45004, UGCGAN: 45014 } },
    [M.publish]: { PublishType: { AiMakeup: 1, AiImage: 2, NormalAsset: 6 } },
    [M.resourceTypes]: { resourceType: { Picture: 'Picture', Gif: 'Gif', Ehpackage: 'Ehpackage' } },
    [M.importTypes]: { ImportAssetType: { Filter: 'Filter', Foreground: 'Foreground', FaceMask: 'FaceMask' } },
    [M.assetsLibrary]: { AssetsLibrary: { getInstance: () => assetsLibrary } },
    [M.secondPanel]: {
      getAssetsSecondPanel: async (p) => (calls.secondPanel = p, { code: 0, data: { directories: [{ name: '全部', panelList: ['sticker', 'aigc_material'] }, { name: '2D贴纸', panelList: ['sticker'] }, { name: '抖音音乐', panelList: ['dy_music'] }, { name: 'K歌', panelList: ['k_music'] }] } }),
    },
    [M.collect]: {
      getCollections: async (p) => {
        calls.collections.push(p);
        const all = [
          { panelKey: 'sticker', templateData: { templateId: '11', title: '猫耳贴纸', businessExtra: {} } },
          { panelKey: 'aigc_material', templateData: { ...CARDS.fg, panelKey: undefined } },
        ];
        return { body: { code: 0, data: { categorizedCollections: p.panelList.includes('aigc_material') ? all : all.slice(0, 1), cursor: 'tok2', hasMore: true } } };
      },
    },
    [M.aiEffectApi]: {
      getDYEHFileUrls: async (p) => (calls.urls.push(p), { code: 0, data: Object.fromEntries(p.uriList.map((u) => [u, { url: `https://img/${u}.png` }])) }),
    },
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) } },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor }) } },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  const lib = new Library(mod);
  lib.ensureCompatible = (feature) => {
    if (feature === 'square' || feature === undefined || feature === 'assets') {
      const { ok, missing } = lib.selfCheck('square');
      if (!ok) throw Error(`INCOMPATIBLE_EDITOR: missing ${missing.join('; ')}`);
    }
  };
  lib.squareTiming = { applyTimeoutMs: 400, settleMs: 60, pollMs: 5 };
  return { lib, calls, modules, sceneObjects, projectDir };
}

test('nav exposes 素材广场 and 收藏 next to plain panels, and still hides AI generation panels', () => {
  const { lib } = setup();
  assert.deepEqual(
    lib.nav().panels.map((p) => [p.panel_key, p.kind]),
    [['dyeh_latest', 'general'], ['collection', 'collection'], ['aigc_material', 'square'], ['sticker', 'general']],
  );
});

test('square cards get the apply route the asset library card would take', () => {
  const { lib } = setup();
  const kinds = Object.fromEntries(Object.entries(CARDS).map(([k, c]) => [k, lib.squareKind(c)]));
  assert.deepEqual(kinds, {
    aiImage: 'ai_image',
    aiMakeup: 'ai_makeup',
    gan: 'custom_gan',
    pkg: 'package',
    fg: 'foreground_sticker',
    faceGif: 'face_sticker',
    filter: 'filter',
    gifFilter: null,
    noResult: null,
    legacy: null,
    collectedImage: 'ai_image',
    collectedMakeup: 'ai_makeup',
    collectedGan: null,
  });
});

test('square list asks its category with the card ranker, fills in the category and counts unsupported cards', async () => {
  const { lib, calls } = setup();
  const out = await lib.list({ panel_key: 'aigc_material' });
  assert.deepEqual(calls.categoryParams, { cursor: 0, count: 50, panelKey: 'aigc_material' });
  assert.deepEqual(calls.list[0], { panelKey: 'aigc_material', count: 30, cursor: 0, categoryIds: '["45004"]', ranker: 5 });
  assert.deepEqual(out.categories, [{ id: '45004', name: '图片' }, { id: '45003', name: '妆容' }]);
  assert.deepEqual(out.items.map((i) => [i.template_id, i.kind, i.cover_url]), [['901', 'ai_image', 'https://c/901.png']]);
  assert.equal(out.unsupported, 1);
  assert.deepEqual(out.raw[0].category, { categoryId: 45004 });
  assert.deepEqual({ next: out.next_cursor, more: out.has_more }, { next: 2, more: true });
  const makeup = await lib.list({ panel_key: 'aigc_material', category_id: '45003', cursor: 2, count: 10 });
  assert.deepEqual(calls.list[1], { panelKey: 'aigc_material', count: 10, cursor: 2, categoryIds: '["45003"]', ranker: 5 });
  assert.deepEqual(makeup.items.map((i) => i.kind), ['ai_makeup']);
  await assert.rejects(lib.list({ panel_key: 'aigc_material', category_id: '1' }), /INVALID_CATEGORY_ID: 1; valid: 45004\(图片\), 45003\(妆容\)/);
  await assert.rejects(lib.list({ panel_key: 'aigc_material', cursor: 'tok' }), /INVALID_CURSOR/);
});

test('collection lists the account collections by the configured directories with a string cursor', async () => {
  const { lib, calls } = setup();
  const out = await lib.list({ panel_key: 'collection' });
  assert.deepEqual(calls.secondPanel, { page: 'collection' });
  assert.deepEqual(calls.collections[0], { cursor: '', panelList: ['sticker', 'aigc_material'], channel: 1 });
  assert.deepEqual(out.categories, [{ id: '全部', name: '全部' }, { id: '2D贴纸', name: '2D贴纸' }]);
  assert.deepEqual(out.items.map((i) => [i.template_id, i.panel_key, i.kind]), [['11', 'sticker', 'package'], ['905', 'aigc_material', 'foreground_sticker']]);
  assert.deepEqual({ next: out.next_cursor, more: out.has_more }, { next: 'tok2', more: true });
  const page = await lib.list({ panel_key: 'collection', category_id: '2D贴纸', cursor: 'tok2' });
  assert.deepEqual(calls.collections[1], { cursor: 'tok2', panelList: ['sticker'], channel: 1 });
  assert.equal(page.category_id, '2D贴纸');
  await assert.rejects(lib.list({ panel_key: 'collection', category_id: '抖音音乐' }), /INVALID_CATEGORY_ID: 抖音音乐; valid: 全部, 2D贴纸$/);
});

test('search includes 素材广场, can stay on one panel and pages the merged result', async () => {
  const { lib, calls } = setup();
  const all = await lib.search({ query: '猫' });
  assert.deepEqual(calls.search.map((p) => p.panelList).sort(), ['aigc_material', 'sticker']);
  assert.deepEqual(all.items.map((i) => [i.template_id, i.kind]), [['901', 'ai_image'], ['904', 'package'], ['902', 'ai_makeup'], ['11', 'package']]);
  assert.deepEqual({ total: all.total, unsupported: all.unsupported, next: all.next_offset }, { total: 4, unsupported: 1, next: null });
  const page = await lib.search({ query: '猫', panel_key: 'aigc_material', offset: 1, count: 1 });
  assert.deepEqual(calls.search.at(-1).panelList, 'aigc_material');
  assert.deepEqual(page.items.map((i) => i.template_id), ['904']);
  assert.deepEqual(page.raw.map((r) => r.templateId), ['904']);
  assert.deepEqual({ total: page.total, next: page.next_offset, more: page.has_more }, { total: 3, next: 2, more: true });
  await assert.rejects(lib.search({ query: '猫', panel_key: 'collection' }), /NOT_SEARCHABLE: collection; searchable panels: aigc_material, sticker/);
});

test('square apply goes through the asset library call of each kind and waits for the objects it adds', async () => {
  const { lib, calls } = setup();
  const image = await lib.apply({ item: CARDS.aiImage, image_index: 2 });
  assert.deepEqual(calls.applied[0], ['picture', { name: '萌猫造型帽子', templateId: '901', uriInfos: [{ uri: 'u2' }] }, '901']);
  assert.deepEqual({ kind: image.kind, index: image.image_index, added: image.added_objects }, { kind: 'ai_image', index: 2, added: [{ name: 'AI 图片', object_path: '素材/AI 图片' }] });
  const makeup = await lib.apply({ item: CARDS.aiMakeup });
  assert.deepEqual(calls.applied[1][1].uriInfos.map((u) => u.uri), ['m0', 'm1']);
  assert.deepEqual(makeup.added_objects.map((o) => o.name), ['AI 美妆_rest', 'AI 美妆_lip']);
  const gan = await lib.apply({ item: CARDS.gan });
  assert.deepEqual(calls.applied[2][1].uriInfos, [{ uri: '' }]);
  assert.deepEqual({ added: gan.added_objects.map((o) => o.name), folders: gan.package_folders }, { added: ['粉色公主纱裙'], folders: ['Assets/粉色公主纱裙'] });
  await lib.apply({ item: CARDS.fg });
  await lib.apply({ item: CARDS.faceGif });
  await lib.apply({ item: CARDS.filter });
  assert.deepEqual(calls.applied.slice(3), [
    ['applyForegroundAsset', '905', '.png'],
    ['applyFaceFollowAsset', '906', '.gif'],
    ['applyFilterAsset', '907', '.jpg'],
  ]);
  const pkg = await lib.apply({ item: CARDS.pkg });
  assert.deepEqual(calls.applied.at(-1), ['applyNormalAsset', '904', true]);
  assert.deepEqual({ kind: pkg.kind, added: pkg.added_objects.map((o) => o.name), folders: pkg.package_folders }, { kind: 'package', added: ['可爱软质猫脸'], folders: ['Assets/可爱软质猫脸'] });
  const pkgOnly = await lib.apply({ item: CARDS.pkg, auto_instantiate: false });
  assert.deepEqual(calls.applied.at(-1), ['applyNormalAsset', '904', false]);
  assert.deepEqual({ added: pkgOnly.added_objects, auto: pkgOnly.auto_instantiated, folders: pkgOnly.package_folders }, { added: [], auto: false, folders: ['Assets/可爱软质猫脸 (1)'] });
});

test('square apply records what it added so object_remove can clean up after it', async () => {
  const { lib, projectDir } = setup();
  await lib.apply({ item: CARDS.gan });
  const rec = Object.values(readImports(projectDir));
  assert.deepEqual(rec, [{ name: '粉色公主纱裙', package_folders: ['Assets/粉色公主纱裙'] }]);
});

test('square apply refuses what the card cannot do and fails when nothing arrives', async () => {
  const { lib, calls } = setup();
  await assert.rejects(lib.apply({ item: CARDS.legacy }), /UNSUPPORTED_SQUARE_ASSET: template 909/);
  await assert.rejects(lib.apply({ item: CARDS.aiImage, image_index: 3 }), /INVALID_IMAGE_INDEX: 3; this card has 3 images \(0-2\)/);
  await assert.rejects(lib.apply({ item: CARDS.fg, image_index: 0 }), /INVALID_IMAGE_INDEX: image_index only applies to ai_image cards, not foreground_sticker/);
  await assert.rejects(lib.apply({ item: CARDS.aiMakeup, auto_instantiate: false }), /AUTO_INSTANTIATE_UNSUPPORTED: ai_makeup/);
  await assert.rejects(lib.apply({ item: { templateId: '11', title: '猫耳贴纸', panelKey: 'sticker' }, image_index: 1 }), /INVALID_IMAGE_INDEX: image_index only applies to AI image cards/);
  assert.deepEqual(calls.applied, []);
  await assert.rejects(setup({ busy: true }).lib.apply({ item: CARDS.fg }), /APPLY_IN_PROGRESS/);
  await assert.rejects(setup({ addsNothing: true }).lib.apply({ item: CARDS.fg }), /SQUARE_APPLY_NO_OBJECT: template 905 added nothing to the scene within 0.4s/);
  await assert.rejects(setup({ addsNothing: true }).lib.apply({ item: CARDS.pkg, auto_instantiate: false }), /SQUARE_APPLY_NO_RESOURCE: template 904 imported nothing/);
});

test('library_images resolves the result images of an AI image card', async () => {
  const { lib, calls } = setup();
  assert.deepEqual(await lib.libraryImages({ item: CARDS.aiImage }), [
    { image_index: 0, url: 'https://img/u0.png' },
    { image_index: 1, url: 'https://img/u1.png' },
    { image_index: 2, url: 'https://img/u2.png' },
  ]);
  assert.deepEqual(calls.urls, [{ uriList: ['u0', 'u1', 'u2'] }]);
  await assert.rejects(lib.libraryImages({ item: CARDS.aiMakeup }), /NOT_AN_AI_IMAGE/);
});

test('a missing square internal stops only the square calls', async () => {
  const { lib, modules } = setup();
  delete modules[M.aiList].getAIAssetList;
  assert.deepEqual(lib.selfCheck('square').missing, [`${M.aiList} :: getAIAssetList`]);
  await assert.rejects(lib.squareList({}), /INCOMPATIBLE_EDITOR/);
});

async function connect(deps) {
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ official, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('library tools pass the new search, list, preview and apply options to the plugin', async () => {
  const seen = [];
  const fetched = [];
  const raw = { templateId: '901', title: '萌猫造型帽子', panelKey: 'aigc_material' };
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    fetchImage: async (url) => (fetched.push(url), { data: 'AAAA', mimeType: 'image/png' }),
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (method === 'status') return { projectPath: '/proj/X' };
      if (method === 'library_search') return { items: [{ template_id: '901', title: '萌猫造型帽子', kind: 'ai_image', cover_url: 'https://c/901.png' }], raw: [raw], total: 1 };
      if (method === 'library_images') return [{ image_index: 0, url: 'https://img/0.png' }, { image_index: 1, url: 'https://img/1.png' }];
      return { items: [], raw: [] };
    },
  });
  const call = async (name, args) => client.callTool({ name, arguments: args });
  await call('library_search', { query: '猫', panel_key: 'aigc_material', offset: 50, count: 20 });
  assert.deepEqual(seen.find((s) => s.method === 'library_search').params, { query: '猫', panel_key: 'aigc_material', offset: 50, count: 20 });
  await call('library_list', { panel_key: 'collection', cursor: 'tok2' });
  assert.deepEqual(seen.find((s) => s.method === 'library_list').params, { panel_key: 'collection', cursor: 'tok2' });
  const two = await call('library_preview', { template_ids: ['901', '901'], all_images: true });
  assert.match(two.content[0].text, /all_images takes exactly one template_id/);
  const prev = await call('library_preview', { template_ids: ['901'], all_images: true });
  assert.deepEqual(seen.find((s) => s.method === 'library_images'), { method: 'library_images', params: { item: raw }, opts: { pid: 7 } });
  assert.deepEqual(fetched, ['https://img/0.png', 'https://img/1.png']);
  assert.deepEqual(prev.content.filter((c) => c.type === 'text').map((c) => c.text), ['萌猫造型帽子（template_id 901，image_index 0）', '萌猫造型帽子（template_id 901，image_index 1）']);
  await call('library_apply', { template_id: '901', image_index: 1 });
  assert.deepEqual(seen.find((s) => s.method === 'library_apply').params, { item: raw, image_index: 1 });
  const big = await call('library_search', { query: '猫', count: 201 });
  assert.equal(big.isError, true);
});
