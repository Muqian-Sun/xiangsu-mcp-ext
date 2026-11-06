import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M, REQUIRED } = require('../editor-plugin/library.cjs');

const PKG_BYTES = Buffer.from('fake ehpackage bytes');
const PKG_MD5 = crypto.createHash('md5').update(PKG_BYTES).digest('hex');

function item(id, title, panelKey, md5 = PKG_MD5) {
  return {
    templateId: id,
    title,
    panelKey,
    businessExtra: { fileMap: { f: { url: `https://cdn/${id}`, md5, fileSize: PKG_BYTES.length } }, coverMap: { c: { url: `https://cdn/${id}.png` } }, originalMaterialType: '3DModel' },
  };
}

function setup({ listItems = [item('111', '芒果脸', undefined)], listStatus = 0, active = true, importResult, downloadBytes = PKG_BYTES } = {}) {
  const shared = tmpdir('xs-lib-');
  const calls = { download: 0, import: [], undo: [], lock: [], reload: 0, search: [] };
  const sceneObjects = [{ name: '面部拉伸', parent: null }];
  const sceneEditor = { id: 'scene', getAllSceneObjectEditors: () => [...sceneObjects] };
  const modules = {
    [M.nav]: {
      getDefaultNavList: () => [
        [{ id: 'dyeh_latest', name: '最新', componentType: 'GeneralAssetsList' }],
        [{ id: 'ai_makeup', name: '妆容', componentType: 'AIMakeup' }],
        [
          {
            id: 'audio',
            name: '音频',
            componentType: 'MusicAssetsList',
            children: [
              { id: 'dy_music', name: '抖音音乐', componentType: 'DouYinMusic' },
              { id: 'music_effect', name: '音效', componentType: 'GeneralAssetsList' },
            ],
          },
        ],
        [
          {
            id: 'face_deformation',
            name: '脸部变形',
            componentType: 'GeneralAssetsList',
            children: [
              { id: '3d_distortion', name: '3D 变形', componentType: 'GeneralAssetsList' },
              { id: 'distortion', name: '美型', componentType: 'GeneralAssetsList' },
            ],
          },
        ],
      ],
    },
    [M.navConst]: { SearchNavItemKeys: [['3d_distortion', 'distortion'], ['aigc_material']] },
    [M.category]: { getAssetCategory: async () => ({ body: { statusCode: 0, data: { categories: [{ id: 45001, name: '全部' }, { id: 45002, name: '热门' }] } } }) },
    [M.list]: {
      getAssetList: async (p) => {
        calls.listParams = p;
        return { body: { statusCode: listStatus, data: { dataInfos: { template: listItems, cursor: 30, hasNext: true } } } };
      },
    },
    [M.search]: {
      searchAsset: async (p) => {
        calls.search.push(p);
        const byPanel = {
          '3d_distortion': [item('111', '芒果脸', '3d_distortion'), item('111', '芒果脸', '3d_distortion'), item('999', 'AI 素材', 'aigc_material')],
          distortion: [item('222', '大叔脸', undefined)],
        };
        return { body: { statusCode: 0, data: { dataInfos: { template: byPanel[p.panelList] || [] } } } };
      },
    },
    [M.util]: {
      downloadLokiFile: async (_url, dest) => {
        calls.download += 1;
        fs.writeFileSync(dest, downloadBytes);
        return 1;
      },
    },
    [M.ef]: {
      Resource: {
        EditorFoundation: { env: { getSharedResourcesPath: () => shared } },
        AssetPackageManager: {
          instance: {
            import: async (args) => {
              calls.import.push(args);
              if (args.autoInstantiate && !importResult) {
                const root = { name: '芒果脸', parent: sceneObjects[0] };
                sceneObjects.push(root, { name: '芒果脸', parent: root });
              }
              return importResult ?? { result: { resourceItems: [{ name: '芒果脸' }] } };
            },
          },
        },
        ResourceUndoManager: { createImportUndoID: (id) => `undo-${id}` },
      },
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => active, getCurrentActiveProject: () => ({ path: shared, resourceManager: { getAllResources: () => [] } }) }) },
      PreviewSyncer: {
        getInstance: () => ({
          lockReloadSticker: (k) => calls.lock.push(`lock:${k}`),
          unlockReloadSticker: (k) => calls.lock.push(`unlock:${k}`),
          requestReloadSticker: () => (calls.reload += 1),
        }),
      },
      UndoSystem: { instance: { start: (n) => calls.undo.push(`start:${n}`), end: () => calls.undo.push('end') } },
    },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor }) } },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  return { lib: new Library(mod), calls, shared, modules };
}

test('nav exposes only applicable leaf panels', () => {
  const { lib } = setup();
  assert.deepEqual(
    lib.nav().panels.map((p) => p.panel_key),
    ['dyeh_latest', 'music_effect', '3d_distortion', 'distortion'],
  );
});

test('list validates panel and category, slims and paginates', async () => {
  const { lib, calls } = setup();
  await assert.rejects(lib.list({ panel_key: 'ai_makeup' }), /INVALID_PANEL_KEY/);
  await assert.rejects(lib.list({ panel_key: '3d_distortion', category_id: '1' }), /INVALID_CATEGORY_ID/);
  const out = await lib.list({ panel_key: '3d_distortion' });
  assert.equal(calls.listParams.categoryIds, JSON.stringify(['45001']));
  assert.equal(out.category_id, '45001');
  assert.deepEqual(out.items[0], { template_id: '111', title: '芒果脸', panel_key: '3d_distortion', desc: '', material_type: '3DModel', file_size: PKG_BYTES.length, cover_url: 'https://cdn/111.png' });
  assert.equal(out.next_cursor, 30);
  assert.equal(out.has_more, true);
});

test('list surfaces non-zero status codes', async () => {
  const { lib } = setup({ listStatus: 11 });
  await assert.rejects(lib.list({ panel_key: '3d_distortion' }), /GET_ASSET_LIST_FAILED: statusCode=11/);
});

test('search queries each searchable applicable panel on its own, dedupes and drops other panels', async () => {
  const { lib, calls } = setup();
  const out = await lib.search({ query: ' 脸 ' });
  assert.equal(out.query, '脸');
  assert.deepEqual(calls.search.map((p) => p.panelList).sort(), ['3d_distortion', 'distortion']);
  assert.ok(calls.search.every((p) => p.searchWord === '脸'));
  assert.deepEqual(out.items.map((i) => [i.template_id, i.panel_key]), [['111', '3d_distortion'], ['222', 'distortion']]);
  await assert.rejects(lib.search({ query: '  ' }), /INVALID_QUERY/);
});

test('apply takes the raw record from list/search', async () => {
  const { lib, calls } = setup();
  await assert.rejects(lib.apply({}), /INVALID_TEMPLATE/);
  await assert.rejects(lib.apply({ item: { title: 'x' } }), /INVALID_TEMPLATE/);
  assert.equal(calls.download, 0);
  const out = await lib.list({ panel_key: '3d_distortion' });
  assert.deepEqual(out.raw.map((r) => r.templateId), ['111']);
  assert.ok(out.raw[0].businessExtra.fileMap.f.url);
});

test('apply downloads, verifies and imports through AssetPackageManager', async () => {
  const { lib, calls, shared } = setup();
  const { raw } = await lib.list({ panel_key: '3d_distortion' });
  const out = await lib.apply({ item: raw[0] });
  const pkg = path.join(shared, 'LokiDownload', 'assets', '111.ehpackage');
  assert.equal(out.package_path, pkg);
  assert.equal(out.package_cached, false);
  assert.deepEqual(fs.readFileSync(pkg), PKG_BYTES);
  assert.equal(calls.import.length, 1);
  const args = calls.import[0];
  assert.equal(args.path, pkg);
  assert.equal(args.assetPackageID, '111');
  assert.equal(args.assetPackageName, '芒果脸');
  assert.equal(args.autoInstantiate, true);
  assert.equal(args.undoID, 'undo-111');
  assert.equal(args.sceneEditor.id, 'scene');
  assert.deepEqual(calls.undo, ['start:import asset library: 芒果脸', 'end']);
  assert.deepEqual(calls.lock, ['lock:ImportAssetFromAssetLibrary', 'unlock:ImportAssetFromAssetLibrary']);
  assert.equal(calls.reload, 1);
  assert.deepEqual(out.resources, [{ name: '芒果脸', path: null }]);
  assert.deepEqual(out.added_objects, [{ name: '芒果脸', object_path: '面部拉伸/芒果脸' }]);
  assert.deepEqual(out.package_folders, []);

  const again = await lib.apply({ item: raw[0], auto_instantiate: false });
  assert.equal(again.package_cached, true);
  assert.equal(calls.download, 1);
  assert.equal(calls.import[1].autoInstantiate, false);
  assert.deepEqual(again.added_objects, []);
  assert.equal(calls.reload, 1);
});

test('apply rejects a package whose md5 does not match and never imports it', async () => {
  const { lib, calls, shared } = setup({ downloadBytes: Buffer.from('tampered') });
  await assert.rejects(lib.apply({ item: item('111', '芒果脸', '3d_distortion') }), /MD5_MISMATCH/);
  assert.equal(calls.import.length, 0);
  const dir = path.join(shared, 'LokiDownload', 'assets');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('apply reports import errors and still closes undo and preview locks', async () => {
  const { lib, calls } = setup({ importResult: { result: null, errorCode: 7 } });
  const it = item('111', '芒果脸', '3d_distortion');
  await assert.rejects(lib.apply({ item: it }), /IMPORT_FAILED: template 111 errorCode=7/);
  assert.deepEqual(calls.undo.at(-1), 'end');
  assert.deepEqual(calls.lock.at(-1), 'unlock:ImportAssetFromAssetLibrary');
  assert.equal(calls.reload, 0);
  // the busy flag must be released after a failure
  await assert.rejects(lib.apply({ item: it }), /IMPORT_FAILED/);
});

test('apply refuses without an active project', async () => {
  const { lib, calls } = setup({ active: false });
  await assert.rejects(lib.apply({ item: item('111', '芒果脸', '3d_distortion') }), /NO_ACTIVE_PROJECT/);
  assert.equal(calls.download, 0);
});

test('self check passes for the asset feature when its editor internals exist', () => {
  const { lib } = setup();
  const check = lib.selfCheck('assets');
  assert.deepEqual(check, { ok: true, missing: [], features: { assets: true } });
  assert.ok(REQUIRED.assets.length >= 10);
  const all = lib.selfCheck();
  assert.equal(all.features.assets, true);
  assert.equal(all.features.menu, false);
  assert.equal(all.ok, false);
  // The RPC layer passes a params object; an empty one must still check every feature.
  assert.deepEqual(lib.selfCheck({}), all);
  assert.deepEqual(lib.selfCheck({ feature: 'assets' }), check);
  assert.throws(() => lib.selfCheck('nope'), /UNKNOWN_FEATURE: nope/);
});

test('self check names the missing internal and asset calls refuse to run', async () => {
  const { lib, modules } = setup();
  delete modules[M.util].downloadLokiFile;
  delete modules[M.ef].Resource.AssetPackageManager.instance.import;
  const check = lib.selfCheck('assets');
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [`${M.util} :: downloadLokiFile`, `${M.ef} :: Resource.AssetPackageManager.instance.import`]);
  assert.throws(() => lib.nav(), /INCOMPATIBLE_EDITOR: missing .*downloadLokiFile/);
  await assert.rejects(lib.list({ panel_key: '3d_distortion' }), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.search({ query: 'x' }), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.apply({ item: item('111', '芒果脸', '3d_distortion') }), /INCOMPATIBLE_EDITOR/);
});

test('self check reports a module that is gone entirely', () => {
  const { lib, modules } = setup();
  delete modules[M.scene];
  const check = lib.selfCheck('assets');
  assert.equal(check.ok, false);
  assert.match(check.missing.join('\n'), /Common\/Scene :: SceneModule.getEditingSceneService \(MODULE_NOT_FOUND/);
});
