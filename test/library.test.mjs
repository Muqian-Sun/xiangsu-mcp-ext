import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-lib-'));
  const calls = { download: 0, import: [], undo: [], lock: [], reload: 0 };
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
      searchAsset: async ({ panelList }) => ({
        body: {
          statusCode: 0,
          data: { dataInfos: { template: panelList === 'aigc_material' ? [item('999', 'AI 素材', 'aigc_material')] : [item('111', '芒果脸', '3d_distortion'), item('111', '芒果脸', '3d_distortion'), item('222', '大叔脸', 'distortion')] } },
        },
      }),
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
              return importResult ?? { result: { resourceItems: [{ name: '芒果脸' }] } };
            },
          },
        },
        ResourceUndoManager: { createImportUndoID: (id) => `undo-${id}` },
      },
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => active }) },
      PreviewSyncer: {
        getInstance: () => ({
          lockReloadSticker: (k) => calls.lock.push(`lock:${k}`),
          unlockReloadSticker: (k) => calls.lock.push(`unlock:${k}`),
          requestReloadSticker: () => (calls.reload += 1),
        }),
      },
      UndoSystem: { instance: { start: (n) => calls.undo.push(`start:${n}`), end: () => calls.undo.push('end') } },
    },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { id: 'scene' } }) } },
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

test('search dedupes and drops non-applicable panels', async () => {
  const { lib } = setup();
  const out = await lib.search({ query: ' 脸 ' });
  assert.equal(out.query, '脸');
  assert.deepEqual(out.items.map((i) => i.template_id), ['111', '222']);
  await assert.rejects(lib.search({ query: '  ' }), /INVALID_QUERY/);
});

test('apply requires a template seen in list/search', async () => {
  const { lib, calls } = setup();
  await assert.rejects(lib.apply({ template_id: '111' }), /UNKNOWN_TEMPLATE/);
  assert.equal(calls.download, 0);
});

test('apply downloads, verifies and imports through AssetPackageManager', async () => {
  const { lib, calls, shared } = setup();
  await lib.list({ panel_key: '3d_distortion' });
  const out = await lib.apply({ template_id: '111' });
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
  assert.deepEqual(args.sceneEditor, { id: 'scene' });
  assert.deepEqual(calls.undo, ['start:import asset library: 芒果脸', 'end']);
  assert.deepEqual(calls.lock, ['lock:ImportAssetFromAssetLibrary', 'unlock:ImportAssetFromAssetLibrary']);
  assert.equal(calls.reload, 1);
  assert.deepEqual(out.resources, [{ name: '芒果脸', path: null }]);

  const again = await lib.apply({ template_id: '111', auto_instantiate: false });
  assert.equal(again.package_cached, true);
  assert.equal(calls.download, 1);
  assert.equal(calls.import[1].autoInstantiate, false);
  assert.equal(calls.reload, 1);
});

test('apply rejects a package whose md5 does not match and never imports it', async () => {
  const { lib, calls, shared } = setup({ downloadBytes: Buffer.from('tampered') });
  await lib.list({ panel_key: '3d_distortion' });
  await assert.rejects(lib.apply({ template_id: '111' }), /MD5_MISMATCH/);
  assert.equal(calls.import.length, 0);
  const dir = path.join(shared, 'LokiDownload', 'assets');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('apply reports import errors and still closes undo and preview locks', async () => {
  const { lib, calls } = setup({ importResult: { result: null, errorCode: 7 } });
  await lib.list({ panel_key: '3d_distortion' });
  await assert.rejects(lib.apply({ template_id: '111' }), /IMPORT_FAILED: template 111 errorCode=7/);
  assert.deepEqual(calls.undo.at(-1), 'end');
  assert.deepEqual(calls.lock.at(-1), 'unlock:ImportAssetFromAssetLibrary');
  assert.equal(calls.reload, 0);
  // the busy flag must be released after a failure
  await assert.rejects(lib.apply({ template_id: '111' }), /IMPORT_FAILED/);
});

test('apply refuses without an active project', async () => {
  const { lib, calls } = setup({ active: false });
  await lib.list({ panel_key: '3d_distortion' });
  await assert.rejects(lib.apply({ template_id: '111' }), /NO_ACTIVE_PROJECT/);
  assert.equal(calls.download, 0);
});

test('self check passes when every required editor internal exists', () => {
  const { lib } = setup();
  assert.deepEqual(lib.selfCheck(), { ok: true, missing: [] });
  assert.ok(REQUIRED.length >= 10);
});

test('self check names the missing internal and library calls refuse to run', async () => {
  const { lib, modules } = setup();
  delete modules[M.util].downloadLokiFile;
  delete modules[M.ef].Resource.AssetPackageManager.instance.import;
  const check = lib.selfCheck();
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [`${M.util} :: downloadLokiFile`, `${M.ef} :: Resource.AssetPackageManager.instance.import`]);
  assert.throws(() => lib.nav(), /INCOMPATIBLE_EDITOR: missing .*downloadLokiFile/);
  await assert.rejects(lib.list({ panel_key: '3d_distortion' }), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.search({ query: 'x' }), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.apply({ template_id: '111' }), /INCOMPATIBLE_EDITOR/);
});

test('self check reports a module that is gone entirely', () => {
  const { lib, modules } = setup();
  delete modules[M.scene];
  const check = lib.selfCheck();
  assert.equal(check.ok, false);
  assert.match(check.missing.join('\n'), /Common\/Scene :: SceneModule.getEditingSceneService \(MODULE_NOT_FOUND/);
});

test('covers returns cover urls for known templates and validates input', async () => {
  const { lib } = setup();
  assert.throws(() => lib.covers({ template_ids: ['111'] }), /UNKNOWN_TEMPLATE: 111/);
  await lib.list({ panel_key: '3d_distortion' });
  assert.deepEqual(lib.covers({ template_ids: ['111'] }), [{ template_id: '111', title: '芒果脸', cover_url: 'https://cdn/111.png' }]);
  assert.throws(() => lib.covers({ template_ids: [] }), /INVALID_TEMPLATE_IDS/);
  assert.throws(() => lib.covers({ template_ids: Array(9).fill('111') }), /INVALID_TEMPLATE_IDS/);
});
