import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STATE = tmpdir('xs-state-');
process.env.XIANGSU_MCP_EXT_STATE = STATE;
const { Library, M, CONFIG_PATH } = require('../editor-plugin/library.cjs');

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

function makeWarp(Ctor, parent, items) {
  const so = obj('塑型画笔', parent);
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

let guidSeq = 0;
function obj(name, parent) {
  guidSeq += 1;
  return { name, parent, guid: `so-${guidSeq}` };
}

// A fake editor: scene objects, component editors, menu registry, project resources and serialized scene.
function setup({ active = true, packageAdds = 1, changed = false } = {}) {
  const projectDir = tmpdir('xs-proj-');
  const hoverDir = tmpdir('xs-hover-');
  fs.mkdirSync(path.join(hoverDir, 'object', 'FaceWarpX'), { recursive: true });
  fs.writeFileSync(path.join(hoverDir, 'object', 'FaceWarpX', 'FaceWarpX.gif'), 'GIF89a');
  const calls = { undo: [], created: [], downloaded: [], launched: [], closed: [], removed: [], deleted: [] };
  const group = obj('面部拉伸', null);
  const jianlian = obj('尖脸大眼', group);
  const xpt = obj('小屁桃_美型', group);
  const pet = obj('宠物', null);
  const sceneObjects = [group, jianlian, xpt, pet];
  class FaceWarpXComponentEditor {}
  class DogFaceWarpXComponentEditor {}
  class OtherEditor {}
  const warps = [
    makeWarp(FaceWarpXComponentEditor, jianlian, [new FaceWarpXItem('a', 100, 'brushA')]),
    makeWarp(FaceWarpXComponentEditor, xpt, [new FaceWarpXItem('b', 66, 'brushB'), new FaceWarpXItem('c', 40, 'brushC')]),
    makeWarp(DogFaceWarpXComponentEditor, pet, [new FaceWarpXItem('d', 50, 'brushD')]),
  ];
  sceneObjects.push(...warps.map((w) => w.sceneObject));

  // Resources: the scene references a resource when its guid appears in the serialized scene text.
  class ResItemFolder {}
  class ResItemAlgorithmAsset {}
  class ResItemPrefab {}
  // Resources are on disk like an import leaves them, unless editorOnly: the folders the editor gives an
  // instantiated package's objects (<name>_滤镜 …) exist only in the editor until a save writes them.
  const res = (Ctor, guid, rel, { editorOnly = false } = {}) => {
    const assetPath = path.join(projectDir, rel);
    if (editorOnly) {
      // nothing on disk
    } else if (Ctor === ResItemFolder) {
      fs.mkdirSync(assetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      fs.writeFileSync(assetPath, guid);
    }
    return Object.assign(new Ctor(), { guid, assetPath });
  };
  const resources = [
    res(ResItemFolder, 'f-xpt', 'Assets/小屁桃_美型'),
    res(ResItemAlgorithmAsset, 'g-xpt-algo', 'Assets/小屁桃_美型/韩系甜妹.algo'),
    res(ResItemFolder, 'f-xpt-filter', 'Assets/小屁桃_滤镜', { editorOnly: true }),
    res(ResItemAlgorithmAsset, 'g-xpt-filter', 'Assets/小屁桃_滤镜/小屁桃_滤镜/纹理/filter.png', { editorOnly: true }),
    res(ResItemPrefab, 'g-xpt-prefab', 'Assets/小屁桃_美型/预制件/小屁桃_美型.prefab'),
    res(ResItemFolder, 'f-dyn', 'Assets/_DynamicAsset/1'),
    res(ResItemAlgorithmAsset, 'g-shared', 'Assets/_DynamicAsset/1/共享.algo'),
    res(ResItemAlgorithmAsset, 'g-jl', 'Assets/尖脸大眼/尖脸.algo'),
  ];
  const refs = new Map([
    [xpt, ['g-xpt-algo', 'g-xpt-filter', 'g-shared']],
    [jianlian, ['g-jl', 'g-shared']],
  ]);
  const sceneEditor = {
    getAllComponentEditors: () => [new OtherEditor(), ...warps.filter((w) => sceneObjects.includes(w.sceneObject))],
    getAllSceneObjectEditors: () => [...sceneObjects],
    _getCurrentMainSceneFileData: () => {
      const live = sceneObjects.flatMap((o) => refs.get(o) || []);
      return new Map([['main.scene', Buffer.from(`scene ${live.join(' ')}`)], ['main.scene.extra', Buffer.from('extra')]]);
    },
  };
  const descendants = (o) => sceneObjects.filter((x) => { for (let p = x; p; p = p.parent) if (p === o) return true; return false; });
  const service = {
    sceneEditor,
    removeSceneObjects: ({ sceneObjects: list, supportUndo }) => {
      calls.removed.push([list.map((o) => o.name), supportUndo]);
      for (const o of list) for (const x of descendants(o)) sceneObjects.splice(sceneObjects.indexOf(x), 1);
    },
  };
  const resourceManager = {
    getAllResources: () => [...resources],
    getResourceItemByAssetPath: (p) => resources.find((r) => r.assetPath === p) || null,
    deleteResourceItemByPath: (p) => {
      calls.deleted.push(path.relative(projectDir, p));
      fs.rmSync(p, { recursive: true, force: true });
      for (let i = resources.length - 1; i >= 0; i--) if (resources[i].assetPath === p || resources[i].assetPath.startsWith(p + path.sep)) resources.splice(i, 1);
    },
  };
  const project = { path: projectDir, resourceManager, isProjectChanged: () => changed };

  const configs = {
    smokey: { id: 'smokey', displayKey: '烟熏妆', components: [{ extraType: 'GanComponent' }] },
    FaceWarpX: { id: 'FaceWarpX', displayKey: 'obj_faceReshape', components: [{ rttiType: 'FaceWarpXComponent' }] },
    SausageLips: { id: 'SausageLips', displayKey: '香肠嘴', hasPrefab: true },
    AIDraw: { id: 'AIDraw', displayKey: 'AI 绘画' },
    Broken: { id: 'Broken', displayKey: '坏项' },
  };
  const i18n = { asset_aieffect: 'AI 玩法', obj_gan_category_facegen: '面部生成', asset_faceeffect: '人脸效果', obj_faceReshape: '塑型画笔', obj_faceReshape_desc: '用画笔塑型' };
  const tree = [
    { id: 'Face', displayKey: 'asset_faceeffect', children: [{ id: 'FaceWarpX' }] },
    { id: 'AIEffectMenu', displayKey: 'asset_aieffect', children: [{ id: 'AIDraw' }, { id: 'Broken' }, { id: 'facegen', displayKey: 'obj_gan_category_facegen', children: [{ id: 'smokey' }, { id: 'SausageLips' }] }] },
  ];
  const tips = {
    smokey: { Enable: true, Description: '一键烟熏妆', Images: ['https://cdn/smokey.png'] },
    FaceWarpX: { Enable: true, Description: 'obj_faceReshape_desc', Images: ['FaceWarpX.gif'] },
    SausageLips: { Enable: true, DescriptionTranslation: '香肠嘴说明', Images: ['missing.gif'] },
  };
  const dyn = {
    updateOrderEntityMenuConfigs: () => tree,
    downloadTaskMap: new Map([['SausageLips', {}]]),
    handleDownloadPromise: async (id) => {
      calls.downloaded.push(id);
      for (let i = 0; i < packageAdds; i++) {
        const root = obj(`香肠嘴${i}`, group);
        sceneObjects.push(root, obj('子对象', root));
        resources.push(res(ResItemFolder, `f-sl${i}`, `Assets/香肠嘴${i}`), res(ResItemPrefab, `g-sl${i}`, `Assets/香肠嘴${i}/预制件/香肠嘴.prefab`));
      }
    },
  };
  class OpenProjectFromEditCommand {
    constructor(op, p, extra) {
      Object.assign(this, { op, p, extra });
    }
  }
  // What the home process answers the next launch request with.
  const launch = { response: { status: 'succeeded' } };
  const modules = {
    [M.ef]: {
      Extension: { MenuConfig: { MenuConfigAPIKey: 'menuKey' } },
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => active, getCurrentActiveProject: () => project }) },
      UndoSystem: { instance: { start: (n) => calls.undo.push(`start:${n}`), end: () => calls.undo.push('end') } },
    },
    [M.scene]: { SceneModule: { getEditingSceneService: () => service } },
    [M.orionui]: {
      I18n: { t: (k) => i18n[k] || '' },
      ExtensionManager: { host: { getAPI: (key) => (key === 'menuKey' ? { getEntityMenuConfig: () => ({ getConfig: (id) => configs[id] }) } : null) } },
    },
    [M.dynamic]: { DynamicMenuConfigInfo: { instance: dyn } },
    [M.sceneOps]: {
      createEntity: async (se, config, name) => {
        assert.equal(se, sceneEditor);
        calls.created.push([config.id, name]);
        if (config.id !== 'Broken') sceneObjects.push(obj(name, group));
        return { name };
      },
    },
    [M.hover]: { HoverTipsMap: { _basePath: hoverDir, getObjectTipsBy: (id) => tips[id] || { Enable: false, Images: [''] } } },
    [M.toolbar]: { closeProjectAndBackToHome: async (...a) => calls.closed.push(a) },
    [M.ipc]: { OpenProjectFromEditCommand },
    [M.sender]: {
      EditSender: {
        getInstance: () => ({
          sendCmdWithResponse: async (cmd) => {
            assert.ok(cmd instanceof OpenProjectFromEditCommand);
            calls.launched.push(cmd);
            return launch.response;
          },
        }),
      },
    },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  return { lib: new Library(mod), calls, warps, dyn, modules, projectDir, hoverDir, resources, sceneObjects, launch, res };
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

test('menu calls refuse to run when menu internals are missing', () => {
  const { lib, modules } = setup();
  delete modules[M.hover];
  assert.throws(() => lib.menuList(), /INCOMPATIBLE_EDITOR: missing .*HoverTipsMap/);
});

test('menu_add reports the new top-level objects for builtin and package entries', async () => {
  const { lib, calls } = setup({ packageAdds: 1 });
  const a = await lib.menuAdd({ menu_id: 'smokey' });
  assert.deepEqual(calls.created, [['smokey', '烟熏妆']]);
  assert.deepEqual(a, { menu_id: 'smokey', name: '烟熏妆', path: 'AI 玩法/面部生成', kind: 'builtin', added_objects: [{ name: '烟熏妆', object_path: '面部拉伸/烟熏妆' }], package_folders: [] });
  const b = await lib.menuAdd({ menu_id: 'SausageLips' });
  assert.deepEqual(calls.downloaded, ['SausageLips']);
  assert.deepEqual(b.added_objects, [{ name: '香肠嘴0', object_path: '面部拉伸/香肠嘴0' }]);
  assert.deepEqual(b.package_folders, ['Assets/香肠嘴0']);
});

test('menu_add refuses denied, unknown and no-op entries', async () => {
  const { lib, calls, dyn } = setup();
  await assert.rejects(lib.menuAdd({ menu_id: 'AIDraw' }), /MENU_ITEM_NOT_ALLOWED: AIDraw is a cloud AI generation entry$/);
  await assert.rejects(lib.menuAdd({ menu_id: 'AICombine' }), /MENU_ITEM_NOT_ALLOWED: AICombine .*; use ai_combine_new and ai_combine_apply/);
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

test('menu_preview returns description plus a CDN url or an existing bundled file', () => {
  const { lib, hoverDir } = setup();
  assert.deepEqual(lib.menuPreview({ menu_ids: ['smokey', 'FaceWarpX', 'SausageLips', 'Broken'] }), [
    { menu_id: 'smokey', name: '烟熏妆', description: '一键烟熏妆', image_url: 'https://cdn/smokey.png', image_file: null },
    { menu_id: 'FaceWarpX', name: '塑型画笔', description: '用画笔塑型', image_url: null, image_file: path.join(hoverDir, 'object', 'FaceWarpX', 'FaceWarpX.gif') },
    { menu_id: 'SausageLips', name: '香肠嘴', description: '香肠嘴说明', image_url: null, image_file: null },
    { menu_id: 'Broken', name: '坏项', description: '', image_url: null, image_file: null },
  ]);
  assert.throws(() => lib.menuPreview({ menu_ids: [] }), /INVALID_MENU_IDS/);
  assert.throws(() => lib.menuPreview({ menu_ids: ['AIDraw'] }), /MENU_ITEM_NOT_ALLOWED/);
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

test('project_launch asks the home process to open or create, validating the target', async () => {
  const { lib, calls, projectDir } = setup();
  await assert.rejects(lib.projectLaunch({ operation: 'delete' }), /INVALID_OPERATION/);
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: 'relative' }), /INVALID_PATH/);
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: projectDir }), /NOT_A_PROJECT/);
  assert.equal(calls.launched.length, 0);
  fs.writeFileSync(path.join(projectDir, 'effect.dyehpj'), '{}');
  const out = await lib.projectLaunch({ operation: 'openLocal', path: projectDir });
  assert.deepEqual(out, { requested: 'openLocal', path: projectDir });
  await lib.projectLaunch({ operation: 'createNew' });
  assert.deepEqual(calls.launched.map((c) => [c.op, c.p]), [['openLocal', projectDir], ['createNew', undefined]]);
  await assert.rejects(lib.projectLaunch({ operation: 'openTemplate', path: 'relative' }), /INVALID_PATH/);
  await lib.projectLaunch({ operation: 'openTemplate', path: projectDir, template_id: 77 });
  assert.deepEqual({ ...calls.launched.at(-1) }, { op: 'openTemplate', p: projectDir, extra: { enter_method: 'xiangsu_mcp_ext', template_id: '77' } });
});

test('project_launch passes task activity fields as launch extras and validates them', async () => {
  const { lib, calls, projectDir } = setup();
  fs.writeFileSync(path.join(projectDir, 'effect.dyehpj'), '{}');
  const activity = { activity_id: 'D2', activity_name: '任务', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Normal' };
  await lib.projectLaunch({ operation: 'openLocal', path: projectDir, activity });
  assert.deepEqual(calls.launched.at(-1).extra, { ...activity, enter_method: 'activity' });
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: projectDir, activity: { activity_name: 'x' } }), /INVALID_ACTIVITY/);
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: projectDir, activity: { ...activity, evil: 1 } }), /INVALID_ACTIVITY/);
  assert.equal(calls.launched.length, 1);
});

test('project_launch turns every refusal of the home process into an error, never reusing this window', async () => {
  const { lib, projectDir, launch } = setup();
  fs.writeFileSync(path.join(projectDir, 'effect.dyehpj'), '{}');
  launch.response = { status: 'reuseCurrent', processCount: 2 };
  await assert.rejects(lib.projectLaunch({ operation: 'openTemplate', path: projectDir }), /WINDOW_LIMIT: all 2 project windows/);
  await assert.rejects(lib.projectLaunch({ operation: 'createNew' }), /WINDOW_LIMIT/);
  launch.response = { status: 'cancelled', reason: 'duplicateProject' };
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: projectDir }), /PROJECT_ALREADY_OPEN/);
  launch.response = { status: 'cancelled', reason: 'versionUpgrade' };
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: projectDir }), /LAUNCH_CANCELLED: .*versionUpgrade/);
  launch.response = { status: 'failed', loadResult: 'projectBroken' };
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: projectDir }), /LAUNCH_FAILED: .*projectBroken/);
  launch.response = undefined;
  await assert.rejects(lib.projectLaunch({ operation: 'openLocal', path: projectDir }), /UNEXPECTED_LAUNCH_RESPONSE/);
});

test('project_close refuses unsaved changes unless discarding, then closes asynchronously', async () => {
  const dirty = setup({ changed: true });
  assert.throws(() => dirty.lib.projectClose({}), /PROJECT_HAS_UNSAVED_CHANGES/);
  const out = dirty.lib.projectClose({ discard_changes: true });
  assert.equal(out.discarded_changes, true);
  assert.deepEqual(dirty.calls.closed, []);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(dirty.calls.closed, [[false, false]]);
  const clean = setup();
  assert.deepEqual(clean.lib.projectState(), { project_path: clean.projectDir, changed: false, scene_ready: true });
  clean.modules[M.scene].SceneModule.getEditingSceneService = () => null;
  assert.equal(clean.lib.projectState().scene_ready, false);
  assert.equal(clean.lib.projectClose().closing, true);
});

test('object_remove deletes the object with undo and reports only resources it alone used', async () => {
  const { lib, calls } = setup();
  const out = await lib.objectRemove({ object_path: '小屁桃_美型' });
  assert.deepEqual(calls.removed, [[['小屁桃_美型'], true]]);
  assert.equal(out.removed_object, '面部拉伸/小屁桃_美型');
  assert.deepEqual(out.orphaned_resources, ['Assets/小屁桃_美型/韩系甜妹.algo', 'Assets/小屁桃_滤镜/小屁桃_滤镜/纹理/filter.png']);
  assert.deepEqual(out.unused_paths, ['Assets/小屁桃_美型']);
  assert.deepEqual(out.editor_only_paths, ['Assets/小屁桃_滤镜']);
  assert.deepEqual(out.resources_deleted, []);
  assert.deepEqual(calls.deleted, []);
});

test('object_remove can delete the orphaned package folder right away', async () => {
  const { lib, calls, resources } = setup();
  const out = await lib.objectRemove({ object_path: '面部拉伸/小屁桃_美型', delete_unused_resources: true });
  assert.deepEqual(out.resources_deleted, ['Assets/小屁桃_美型']);
  assert.deepEqual(calls.deleted, ['Assets/小屁桃_美型']);
  assert.ok(resources.every((r) => !r.assetPath.includes('小屁桃_美型')));
  assert.ok(resources.some((r) => r.guid === 'f-xpt-filter'), 'the editor-only folder is left for the next save to drop');
  assert.ok(resources.some((r) => r.guid === 'g-shared'));
});

test('object_remove keeps a package folder that still holds a resource another object uses', async () => {
  const { lib, calls, resources, sceneObjects, res } = setup();
  const shared = res(resources[1].constructor, 'g-xpt-shared-tex', 'Assets/小屁桃_美型/共用.png');
  resources.push(shared);
  const keeper = { name: '保留者', parent: sceneObjects[0] };
  sceneObjects.push(keeper);
  lib.mod('@orion/Business/Common/Scene').SceneModule.getEditingSceneService().sceneEditor._getCurrentMainSceneFileData = ((orig) => () => {
    const m = orig();
    const text = Buffer.concat([...m.values()]).toString() + (sceneObjects.includes(keeper) ? ' g-xpt-shared-tex' : '');
    return new Map([['main.scene', Buffer.from(text)]]);
  })(lib.mod('@orion/Business/Common/Scene').SceneModule.getEditingSceneService().sceneEditor._getCurrentMainSceneFileData);
  const out = await lib.objectRemove({ object_path: '小屁桃_美型', delete_unused_resources: true });
  assert.deepEqual(out.unused_paths, ['Assets/小屁桃_美型/韩系甜妹.algo']);
  assert.deepEqual(calls.deleted, ['Assets/小屁桃_美型/韩系甜妹.algo']);
  assert.ok(resources.includes(shared));
});

test('object_remove also cleans the package folder recorded when the object was imported', async () => {
  const { lib, calls, resources } = setup();
  await lib.menuAdd({ menu_id: 'SausageLips' });
  const out = await lib.objectRemove({ object_path: '香肠嘴0', delete_unused_resources: true });
  assert.deepEqual(out.orphaned_resources, []);
  assert.deepEqual(out.unused_paths, ['Assets/香肠嘴0']);
  assert.deepEqual(calls.deleted, ['Assets/香肠嘴0']);
  assert.ok(!resources.some((r) => r.assetPath.includes('香肠嘴0')));
  // the record is consumed: it is gone from the store, and removing another object does not touch other folders
  const { readImports } = require('../editor-plugin/features/common.cjs');
  assert.deepEqual(Object.values(readImports(lib.mod(M.ef).ProjectManager.getInstance().getCurrentActiveProject().path)), []);
  const again = await lib.objectRemove({ object_path: '尖脸大眼' });
  assert.ok(!again.unused_paths.some((p) => p.includes('香肠嘴')));
});

test('object_remove keeps a recorded package folder whose contents the scene still uses', async () => {
  const { lib, resources, sceneObjects, projectDir } = setup();
  await lib.menuAdd({ menu_id: 'SausageLips' });
  const svc = lib.mod(M.scene).SceneModule.getEditingSceneService();
  const keeper = { name: '保留者', parent: sceneObjects[0], guid: 'keeper' };
  sceneObjects.push(keeper);
  const orig = svc.sceneEditor._getCurrentMainSceneFileData;
  svc.sceneEditor._getCurrentMainSceneFileData = () => new Map([['s', Buffer.from(Buffer.concat([...orig().values()]).toString() + (sceneObjects.includes(keeper) ? ' g-sl0' : ''))]]);
  const out = await lib.objectRemove({ object_path: '香肠嘴0', delete_unused_resources: true });
  assert.deepEqual(out.unused_paths, []);
  assert.ok(resources.some((r) => r.assetPath === path.join(projectDir, 'Assets/香肠嘴0')));
});

test('object_remove refuses render groups and ambiguous paths', async () => {
  const { lib, calls } = setup();
  await assert.rejects(lib.objectRemove({ object_path: '面部拉伸' }), /OBJECT_NOT_FOUND/);
  await assert.rejects(lib.objectRemove({ object_path: '塑型画笔' }), /AMBIGUOUS_OBJECT_PATH/);
  assert.deepEqual(calls.removed, []);
});

test('resource_delete_unused refuses resources the scene still uses and paths outside Assets', async () => {
  const { lib, calls } = setup();
  assert.throws(() => lib.resourceDeleteUnused({ paths: ['Assets/_DynamicAsset/1'] }), /RESOURCE_IN_USE: Assets\/_DynamicAsset\/1 \(Assets\/_DynamicAsset\/1\/共享.algo\)/);
  assert.throws(() => lib.resourceDeleteUnused({ paths: ['../elsewhere'] }), /OUTSIDE_ASSETS/);
  assert.throws(() => lib.resourceDeleteUnused({ paths: ['Assets/nope'] }), /RESOURCE_NOT_FOUND/);
  assert.deepEqual(calls.deleted, []);
  await lib.objectRemove({ object_path: '小屁桃_美型' });
  assert.deepEqual(lib.resourceDeleteUnused({ paths: ['Assets/小屁桃_美型'] }), { deleted: ['Assets/小屁桃_美型'] });
});

test('dev_eval only runs while config.local.json enables devEval', async (t) => {
  const original = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH) : null;
  t.after(() => (original === null ? fs.rmSync(CONFIG_PATH, { force: true }) : fs.writeFileSync(CONFIG_PATH, original)));
  const { lib } = setup();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ devEval: false }));
  await assert.rejects(lib.devEval({ code: 'return 1' }), /EVAL_DISABLED/);
  fs.rmSync(CONFIG_PATH);
  await assert.rejects(lib.devEval({ code: 'return 1' }), /EVAL_DISABLED/);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ devEval: true }));
  assert.equal(await lib.devEval({ code: 'return 1 + 1' }), 2);
});
