import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Library, M, MENU } = require('../editor-plugin/library.cjs');
const CONFIG = path.join(path.dirname(require.resolve('../editor-plugin/library.cjs')), '..', 'config.local.json');

class FaceWarpXItem {
  constructor(id, intensity, brush) {
    this.id = id;
    this.intensity = intensity;
    this.brush = brush;
    this.labelName = null;
  }
  withIntensity(v) {
    return new FaceWarpXItem(this.id, v, this.brush);
  }
}

function makeWarp(Ctor, parentPath, items) {
  let parent = null;
  for (const name of parentPath.split('/')) parent = { name, parent };
  const so = { name: '塑型画笔', parent };
  const comp = new Ctor();
  comp.sceneObject = so;
  comp.enabled = true;
  comp.items = items;
  comp.writes = [];
  comp.setProperty = function (key, value) {
    this.writes.push([key, value]);
    if (this.failWith) return Error(this.failWith);
    if (!this.ignoreWrites) this.items = value;
  };
  return comp;
}

function setup({ active = true, packageAdds = 2, entityAdds = 1 } = {}) {
  const calls = { undo: [], created: [], downloaded: [] };
  const sceneObjects = [{}, {}];
  class FaceWarpXComponentEditor {}
  class DogFaceWarpXComponentEditor {}
  class OtherEditor {}
  const warps = [
    makeWarp(FaceWarpXComponentEditor, '面部拉伸/尖脸大眼', [new FaceWarpXItem('a', 100, 'brushA')]),
    makeWarp(FaceWarpXComponentEditor, '面部拉伸/小屁桃_美型', [new FaceWarpXItem('b', 66, 'brushB'), new FaceWarpXItem('c', 40, 'brushC')]),
    makeWarp(DogFaceWarpXComponentEditor, '宠物', [new FaceWarpXItem('d', 50, 'brushD')]),
  ];
  const sceneEditor = {
    getAllComponentEditors: () => [new OtherEditor(), ...warps],
    getAllSceneObjectEditors: () => sceneObjects,
  };
  const configs = {
    smokey: { id: 'smokey', displayKey: '烟熏妆', components: [{ extraType: 'GanComponent' }] },
    FaceWarpX: { id: 'FaceWarpX', displayKey: 'obj_faceReshape', components: [{ rttiType: 'FaceWarpXComponent' }] },
    SausageLips: { id: 'SausageLips', displayKey: '香肠嘴', hasPrefab: true },
    AIDraw: { id: 'AIDraw', displayKey: 'AI 绘画' },
    Broken: { id: 'Broken', displayKey: '坏项' },
  };
  const i18n = { asset_aieffect: 'AI 玩法', obj_gan_category_facegen: '面部生成', asset_faceeffect: '人脸效果', obj_faceReshape: '塑型画笔' };
  const tree = [
    { id: 'Face', displayKey: 'asset_faceeffect', children: [{ id: 'FaceWarpX' }] },
    { id: 'AIEffectMenu', displayKey: 'asset_aieffect', children: [{ id: 'AIDraw' }, { id: 'Broken' }, { id: 'facegen', displayKey: 'obj_gan_category_facegen', children: [{ id: 'smokey' }, { id: 'SausageLips' }] }] },
  ];
  const dyn = {
    updateOrderEntityMenuConfigs: () => tree,
    downloadTaskMap: new Map([['SausageLips', {}]]),
    handleDownloadPromise: async (id) => {
      calls.downloaded.push(id);
      for (let i = 0; i < packageAdds; i++) sceneObjects.push({});
    },
  };
  const modules = {
    [M.ef]: {
      Extension: { MenuConfig: { MenuConfigAPIKey: 'menuKey' } },
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => active }) },
      UndoSystem: { instance: { start: (n) => calls.undo.push(`start:${n}`), end: () => calls.undo.push('end') } },
    },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor }) } },
    [MENU.orionui]: {
      I18n: { t: (k) => i18n[k] || '' },
      ExtensionManager: { host: { getAPI: (key) => (key === 'menuKey' ? { getEntityMenuConfig: () => ({ getConfig: (id) => configs[id] }) } : null) } },
    },
    [MENU.dynamic]: { DynamicMenuConfigInfo: { instance: dyn } },
    [MENU.sceneOps]: {
      createEntity: async (se, config, name) => {
        assert.equal(se, sceneEditor);
        calls.created.push([config.id, name]);
        for (let i = 0; i < (config.id === 'Broken' ? 0 : entityAdds); i++) sceneObjects.push({});
        return { name };
      },
    },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  return { lib: new Library(mod), calls, warps, dyn };
}

test('menu_list flattens the editor menu with translated names and hides cloud AI entries', () => {
  const { lib } = setup();
  const { total, items } = lib.menuList();
  assert.equal(total, 4);
  assert.deepEqual(items, [
    { menu_id: 'FaceWarpX', name: '塑型画笔', path: '人脸效果', kind: 'builtin', components: ['FaceWarpXComponent'] },
    { menu_id: 'Broken', name: '坏项', path: 'AI 玩法', kind: 'builtin', components: [] },
    { menu_id: 'smokey', name: '烟熏妆', path: 'AI 玩法/面部生成', kind: 'builtin', components: ['GanComponent'] },
    { menu_id: 'SausageLips', name: '香肠嘴', path: 'AI 玩法/面部生成', kind: 'package', components: [] },
  ]);
  assert.deepEqual(lib.menuList({ query: '面部生成' }).items.map((i) => i.menu_id), ['smokey', 'SausageLips']);
});

test('menu_add creates builtin entries through createEntity and packages through the dynamic menu', async () => {
  const { lib, calls } = setup();
  const a = await lib.menuAdd({ menu_id: 'smokey' });
  assert.deepEqual(calls.created, [['smokey', '烟熏妆']]);
  assert.deepEqual(a, { menu_id: 'smokey', name: '烟熏妆', path: 'AI 玩法/面部生成', kind: 'builtin', created_object: '烟熏妆', scene_objects_added: 1 });
  const b = await lib.menuAdd({ menu_id: 'SausageLips' });
  assert.deepEqual(calls.downloaded, ['SausageLips']);
  assert.equal(b.kind, 'package');
  assert.equal(b.scene_objects_added, 2);
});

test('menu_add refuses denied, unknown and no-op entries', async () => {
  const { lib, calls, dyn } = setup();
  await assert.rejects(lib.menuAdd({ menu_id: 'AIDraw' }), /MENU_ITEM_NOT_ALLOWED/);
  await assert.rejects(lib.menuAdd({ menu_id: 'nope' }), /UNKNOWN_MENU_ID: nope/);
  await assert.rejects(lib.menuAdd({ menu_id: 'Broken' }), /MENU_ADD_NO_EFFECT: Broken/);
  dyn.downloadTaskMap.clear();
  await assert.rejects(lib.menuAdd({ menu_id: 'SausageLips' }), /PACKAGE_NOT_REGISTERED/);
  assert.deepEqual(calls.downloaded, []);
  const noPkg = setup({ packageAdds: 0 });
  await assert.rejects(noPkg.lib.menuAdd({ menu_id: 'SausageLips' }), /MENU_ADD_NO_EFFECT: SausageLips/);
  const inactive = setup({ active: false });
  await assert.rejects(inactive.lib.menuAdd({ menu_id: 'smokey' }), /NO_ACTIVE_PROJECT/);
  assert.deepEqual(inactive.calls.created, []);
});

test('face_warp_list reports every warp editor with its path and item intensities', () => {
  const { lib } = setup();
  assert.deepEqual(lib.faceWarpList().face_warps, [
    { object_path: '面部拉伸/尖脸大眼/塑型画笔', face: 'Human', enabled: true, items: [{ index: 0, label: null, intensity: 100 }] },
    { object_path: '面部拉伸/小屁桃_美型/塑型画笔', face: 'Human', enabled: true, items: [{ index: 0, label: null, intensity: 66 }, { index: 1, label: null, intensity: 40 }] },
    { object_path: '宠物/塑型画笔', face: 'Dog', enabled: true, items: [{ index: 0, label: null, intensity: 50 }] },
  ]);
});

test('face_warp_set_intensity rewrites items keeping brush data, inside one undo step', async () => {
  const { lib, calls, warps } = setup();
  const out = await lib.faceWarpSetIntensity({ object_path: '尖脸大眼/塑型画笔', intensity: 55 });
  assert.equal(out.object_path, '面部拉伸/尖脸大眼/塑型画笔');
  assert.deepEqual(out.before, [{ index: 0, label: null, intensity: 100 }]);
  assert.deepEqual(out.after, [{ index: 0, label: null, intensity: 55 }]);
  assert.equal(warps[0].writes.length, 1);
  assert.equal(warps[0].writes[0][0], 'items');
  assert.equal(warps[0].items[0].brush, 'brushA');
  assert.deepEqual(calls.undo, ['start:set face warp intensity: 面部拉伸/尖脸大眼/塑型画笔', 'end']);

  await lib.faceWarpSetIntensity({ object_path: '小屁桃_美型/塑型画笔', intensity: 10, item_index: 1 });
  assert.deepEqual(warps[1].items.map((i) => [i.intensity, i.brush]), [[66, 'brushB'], [10, 'brushC']]);
});

test('face_warp_set_intensity validates the target and the value', async () => {
  const { lib, warps } = setup();
  await assert.rejects(lib.faceWarpSetIntensity({ object_path: '塑型画笔', intensity: 50 }), /AMBIGUOUS_OBJECT_PATH: 塑型画笔 matches 面部拉伸\/尖脸大眼\/塑型画笔 \| 面部拉伸\/小屁桃_美型\/塑型画笔 \| 宠物\/塑型画笔/);
  await assert.rejects(lib.faceWarpSetIntensity({ object_path: '不存在/塑型画笔', intensity: 50 }), /FACE_WARP_NOT_FOUND/);
  await assert.rejects(lib.faceWarpSetIntensity({ object_path: '尖脸大眼/塑型画笔', intensity: 101 }), /INVALID_INTENSITY/);
  await assert.rejects(lib.faceWarpSetIntensity({ object_path: '尖脸大眼/塑型画笔', intensity: 50, item_index: 1 }), /INVALID_ITEM_INDEX/);
  assert.ok(warps.every((w) => w.writes.length === 0));
});

test('face_warp_set_intensity fails loudly when the editor rejects or ignores the write', async () => {
  const { lib, calls, warps } = setup();
  warps[0].failWith = 'readonly';
  await assert.rejects(lib.faceWarpSetIntensity({ object_path: '尖脸大眼/塑型画笔', intensity: 50 }), /SET_PROPERTY_FAILED: readonly/);
  assert.equal(calls.undo.at(-1), 'end');
  warps[0].failWith = null;
  warps[0].ignoreWrites = true;
  await assert.rejects(lib.faceWarpSetIntensity({ object_path: '尖脸大眼/塑型画笔', intensity: 50 }), /WRITE_NOT_APPLIED/);
});

test('dev_eval only runs while config.local.json enables devEval', async (t) => {
  const original = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG) : null;
  t.after(() => (original === null ? fs.rmSync(CONFIG, { force: true }) : fs.writeFileSync(CONFIG, original)));
  const { lib } = setup();
  fs.writeFileSync(CONFIG, JSON.stringify({ devEval: false }));
  await assert.rejects(lib.devEval({ code: 'return 1' }), /EVAL_DISABLED/);
  fs.rmSync(CONFIG);
  await assert.rejects(lib.devEval({ code: 'return 1' }), /EVAL_DISABLED/);
  fs.writeFileSync(CONFIG, JSON.stringify({ devEval: true }));
  assert.equal(await lib.devEval({ code: 'return 1 + 1' }), 2);
});
