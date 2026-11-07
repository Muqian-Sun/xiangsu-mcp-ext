import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRequire } from 'node:module';
import { createServer } from '../src/server.mjs';
import { formatObjects, formatTree, pickInspect, resolveRefs, unwrap } from '../src/inspect.mjs';
import { loadScene } from '../src/scenefile.mjs';
import { cropImage, framesDir, FRAMES_TTL_MS } from '../src/frames.mjs';

// Shape of the official get_scene (summary=false) result, trimmed.
const SCENE = {
  kind: 'scene',
  renderGroups: [
    {
      name: 'AI 实时变脸',
      guid: 's19',
      type: 'GAN',
      enabled: true,
      sceneObjects: [
        { guid: 's17', name: 'GAN摄像机', visible: true, componentTypes: ['Transform', 'Camera'], childCount: 0, children: [] },
        {
          guid: 's20',
          name: '香肠嘴',
          visible: false,
          componentTypes: ['Transform'],
          childCount: 3,
          children: [{ guid: 's21', name: '生成效果', visible: true, componentTypes: ['Transform', 'GanComponent'], childCount: 0 }],
        },
      ],
    },
    { name: '2D', guid: 's30', type: 'Default', enabled: false, sceneObjects: [] },
  ],
};

// Shape of the official inspect result.
const INSPECT = {
  guid: 's21',
  name: '生成效果',
  componentTypes: ['Transform', 'GanComponent'],
  components: [
    { type: 'Transform', guid: 'c1', properties: { localPosition: { x: 0, y: 4, z: 0 }, localScale: { type: 'Vector3f', data: { x: 1, y: 1, z: 1 } } } },
    { type: 'GanComponent', guid: 'c2', properties: { intensity: { type: 'Float', data: 0.8 }, maleIntensity: 0.1, brush: Array.from({ length: 50 }, (_, i) => i), name: 'x' } },
  ],
};

test('formatTree prints groups and objects with guid, hidden flag, components and collapsed children', () => {
  assert.equal(
    formatTree(SCENE),
    [
      '[AI 实时变脸] s19 GAN',
      '  s17 GAN摄像机  [Transform, Camera]',
      '  s20 香肠嘴 (隐藏)  [Transform]',
      '    s21 生成效果  [Transform, GanComponent]',
      '    … 还有 2 个子对象未展开（加大 depth 或用 subtree 查看）',
      '[2D] s30 Default (停用)',
    ].join('\n'),
  );
});

test('unwrap removes {type, data} wrappers and summarises long arrays', () => {
  assert.equal(unwrap({ type: 'Float', data: 0.5 }), 0.5);
  assert.deepEqual(unwrap({ a: { type: 'Vector2', data: { x: 1, y: 2 } }, b: [{ type: 'Int', data: 3 }] }), { a: { x: 1, y: 2 }, b: [3] });
  assert.deepEqual(unwrap(Array.from({ length: 30 }, (_, i) => i)), { length: 30, first: [0, 1, 2, 3, 4] });
  assert.deepEqual(unwrap({ type: 'Thing', data: 1, extra: 2 }), { type: 'Thing', data: 1, extra: 2 });
});

test('pickInspect filters components by type and properties by name fragment', () => {
  const all = pickInspect(INSPECT);
  assert.deepEqual(all.components[0].properties.localScale, { x: 1, y: 1, z: 1 });
  assert.deepEqual(all.components[1].properties.brush, { length: 50, first: [0, 1, 2, 3, 4] });
  assert.deepEqual(pickInspect(INSPECT, { component_types: ['Transform'] }).components.map((c) => c.type), ['Transform']);
  const ints = pickInspect(INSPECT, { fields: ['INTENSITY'] });
  assert.deepEqual(ints.components, [{ type: 'GanComponent', guid: 'c2', properties: { intensity: 0.8, maleIntensity: 0.1 } }]);
  assert.deepEqual(ints.component_types, ['Transform', 'GanComponent']);
});

test('cropImage converts the fraction box to pixels in the height-width / y-x order sips expects', async () => {
  const runs = [];
  const exec = async (cmd, args) => (runs.push(args), args[0] === '-g' ? { stdout: 'pixelWidth: 400\npixelHeight: 800' } : { stdout: '' });
  assert.deepEqual(await cropImage('/f.jpg', { x: 0.25, y: 0.1, width: 0.5, height: 0.25 }, { exec }), { width: 200, height: 200 });
  assert.deepEqual(runs[1], ['-c', '200', '200', '--cropOffset', '80', '100', '/f.jpg', '--out', '/f.jpg']);
  await cropImage('/f.jpg', { x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, { exec });
  assert.deepEqual(runs[3].slice(0, 6), ['-c', '80', '40', '--cropOffset', '720', '360']);
  await assert.rejects(cropImage('/f.jpg', { x: 0, y: 0, width: 1, height: 1 }, { exec: async () => ({ stdout: '' }) }), /NOT_AN_IMAGE/);
});

test('framesDir makes a fresh folder per call and removes ones past their lifetime', () => {
  const root = tmpdir('xs-frames-');
  const old = path.join(root, 'old');
  fs.mkdirSync(old);
  const past = new Date(Date.now() - FRAMES_TTL_MS - 1000);
  fs.utimesSync(old, past, past);
  const a = framesDir({ root });
  const b = framesDir({ root });
  assert.notEqual(a, b);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test('pickInspect preset "key" keeps transform, visibility, strength-like values, bindings and script parameters', () => {
  const res = {
    guid: 's5',
    name: 'x',
    components: [
      { type: 'Transform', guid: 'c1', properties: { localPosition: { x: 0 }, localScale: { x: 1 }, mobility: 'Dynamic' } },
      { type: 'MeshRenderer', guid: 'c2', properties: { enabled: true, sharedMaterials: [{ guid: 'r1' }], mesh: { guid: 'null' }, sortingOrder: 2 } },
      { type: 'EffectFaceMakeup', guid: 'c3', properties: { maleOpacity: 0.3, faceIds: [0, 1] } },
      { type: 'Camera', guid: 'c4', properties: { fovy: 60 } },
      { type: 'Text', guid: 'c6', properties: { str: '爸爸名', richStr: '', bloomRtSize: 1 } },
      { type: 'JSScriptComponent(a.js)', guid: 'c5', script: true, properties: { teamNames: ['a'], speed: 2 } },
    ],
  };
  const key = pickInspect(res, { preset: 'key' });
  assert.deepEqual(
    key.components.map((c) => [c.type, Object.keys(c.properties)]),
    [
      ['Transform', ['localPosition', 'localScale']],
      ['MeshRenderer', ['enabled', 'sharedMaterials']],
      ['EffectFaceMakeup', ['maleOpacity']],
      ['Text', ['str']],
      ['JSScriptComponent(a.js)', ['teamNames', 'speed']],
    ],
  );
  const plus = pickInspect(res, { preset: 'key', fields: ['fovy'] });
  assert.deepEqual(plus.components.find((c) => c.type === 'Camera').properties, { fovy: 60 });
});

test('resolveRefs replaces handles with the resource or object they name, once per handle', async () => {
  const looked = [];
  const lookup = async (guid) => {
    looked.push(guid);
    if (guid === 'r1') return { kind: 'resource', name: '韩系甜妹', type: 'AlgorithmAsset', filePath: '/p/A/Assets/_DynamicAsset/韩系甜妹.algo' };
    if (guid === 's9') return { kind: 'sceneObject', name: '头' };
    throw Error('gone');
  };
  const out = await resolveRefs({ a: { guid: 'r1' }, b: [{ guid: 'r1' }, { guid: 's9' }], c: { guid: 'null' }, d: { guid: 'r7' }, e: { guid: 'r1', x: 1 } }, lookup, { root: '/p/A' });
  assert.deepEqual(out, {
    a: { resource: '韩系甜妹', type: 'AlgorithmAsset', file: '_DynamicAsset/韩系甜妹.algo' },
    b: [{ resource: '韩系甜妹', type: 'AlgorithmAsset', file: '_DynamicAsset/韩系甜妹.algo' }, { object: 's9', name: '头' }],
    c: null,
    d: { guid: 'r7', error: 'gone' },
    e: { guid: 'r1', x: 1 },
  });
  assert.deepEqual(looked.sort(), ['r1', 'r7', 's9']);
});

const SCENE_FILE = `%YAML 1.1
--- !Scene &1
name: !<str> ""
guid: {a: 7875085725817850609, b: 329766013828765107}
entities:
  - __class: Entity
    name: !<str> 组
    guid: {a: 16159691616910330046, b: 1}
    scene: {localId: 1}
    selfvisible: true
    components:
      - {localId: 2}
      - __class: Camera
        name: !<str> ""
        guid: {a: 1, b: 2}
        enabled: true
        type:
          __class: CameraType
          value: PERSPECTIVE
        renderTexture: {localId: 1, path: 00000000-0000-0000-0000-0000000000l3}
        inputTexture: {localId: 1, path: share://input.texture}
  - __class: Entity
    name: !<str> 头
    guid: {a: 3, b: 4}
    scene: {localId: 1}
    selfvisible: false
    components:
      - {localId: 3}
      - __class: MeshRenderer
        name: !<str> ""
        guid: {a: 5, b: 6}
        enabled: true
        sharedMaterials:
          - {localId: 1, path: f6cfe326-8fb2-fda2-db1b-b375897821cb--f6cfe326-8fb2-fda2-db1b-b375897821cb.material}
        mesh: {localId: 1, path: custom://12135db8-0120-bdea-e094-955d52822c02}
        maskMaterial: {localId: 1, path: a82b9486-0bfd-3638-532d-fc233b7c55ac--a82b9486-0bfd-3638-532d-fc233b7c55ac.material}
      - __class: JSScriptComponent
        name: !<str> ""
        guid: {a: 7, b: 8}
        enabled: true
        path: !<str> sadface/sadface.js
        properties:
          __class: Map
          maleIntensity: 0.300000011920929
          target: {localId: 2}
  - __class: Entity
    name: !<str> 字
    guid: {a: 9, b: 10}
    scene: {localId: 1}
    selfvisible: true
    components:
      - {localId: 4}
      - __class: DynamicComponent
        name: !<str> FaceBinding
        guid: {a: 11, b: 12}
        serializedProperty:
          __class: ScriptSerializedProperty
          name: !<str> ""
          guid: {a: 13, b: 14}
          properties:
            __class: Map
            faceIndex: 1
        enabled: true
        className: !<str> FaceBinding
      - __class: Text
        name: !<str> ""
        guid: {a: 15, b: 16}
        canvas: {localId: 5}
      - __class: DynamicComponent
        name: !<str> ""
        guid: {a: 25, b: 26}
        serializedProperty:
          __class: ScriptSerializedProperty
          name: !<str> ""
          guid: {a: 27, b: 28}
          properties:
            __class: Map
            tauntTemplate: !<str> 同学：{name}是谁呀？
        enabled: true
        className: !<str> f0498c0f-0b89-5b9c-7c7a-e998afe0e17f
visible: true
--- !Transform &2
name: !<str> ""
guid: {a: 17, b: 18}
enabled: true
localPosition: {x: 0, y: 2, z: 40}
children:
  - {localId: 3}
  - {localId: 4}
--- !Transform &3
name: !<str> ""
guid: {a: 19, b: 20}
localPosition: {x: 1, y: 0.5, z: 0}
parent: {localId: 2}
--- !ScreenTransform &4
name: !<str> ""
guid: {a: 21, b: 22}
parent: {localId: 2}
--- !TextCanvas &5
name: !<str> ""
guid: {a: 23, b: 24}
canvasEnabled: false
`;

// main.scene.extra: the editor's side of components, keyed by the runtime guid.
const EDITOR_EXTRA = [
  { guid: { a: 'a82b9486-0bfd-3638-532d-fc233b7c55ac', b: '' }, objGuid: 'Guid(7875085725817850609, 329766013828765107)', extraType: 'SceneEditor', rttiType: 'Scene' },
  { guid: { a: 'c1' }, objGuid: 'Guid(1, 2)', extraType: 'Camera', name: '摄像机', version: '0.4.0', editable: true, extendedInfo: {}, fov: 45, maskTexture: '00000000-0000-0000-0000-000000000802', follow: 'Guid(3, 4)', note: 'Guid(99, 99)' },
  { guid: { a: 'c2' }, objGuid: 'Guid(15, 16)', extraType: 'Text2D', name: '文字', font: 'f6cfe326-8fb2-fda2-db1b-b375897821cb', label: 'f6cfe326-8fb2-fda2-db1b-b375897821cb 不是资源' },
  { guid: { a: 'c3' }, objGuid: 'Guid(25, 26)', extraType: 'UserComponentEditor', rttiType: 'DadNameReveal', name: 'DadNameReveal' },
  { guid: { a: 'c4' }, objGuid: 'Guid(17, 18)', extraType: 'Transform', eulerAngle: [0, 90, 0] },
];

function sceneProject({ badExtra = false, badEditor = false } = {}) {
  const dir = tmpdir('xs-scene-');
  fs.mkdirSync(path.join(dir, 'Assets', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Assets', 'main.scene'), SCENE_FILE);
  fs.writeFileSync(path.join(dir, 'Assets', 'main.scene.extra'), badEditor ? '[' : JSON.stringify(EDITOR_EXTRA));
  fs.writeFileSync(path.join(dir, 'Assets', '遮罩.omtl.extra'), JSON.stringify([{ guid: { a: 'f6cfe326-8fb2-fda2-db1b-b375897821cb', b: '' }, name: '遮罩', rttiType: 'Material' }]));
  fs.writeFileSync(path.join(dir, 'Assets', 'sub', 'DadNameReveal.ts.extra'), JSON.stringify([{ guid: { a: 'f0498c0f-0b89-5b9c-7c7a-e998afe0e17f', b: '' }, name: 'DadNameReveal', extraType: 'ResItemJSScript' }]));
  fs.writeFileSync(path.join(dir, 'Assets', 'sub', '头模.headJSA.extra'), JSON.stringify([{ guid: { a: 'd6d54979-e383-0055-6556-aef771b95493' }, uuid: '12135DB8-0120-bdea-e094-955d52822c02', name: '头模', rttiType: 'Mesh' }]));
  if (badExtra) fs.writeFileSync(path.join(dir, 'Assets', 'broken.png.extra'), '{');
  return dir;
}

test('loadScene reads main.scene into the get_scene tree shape, with the transform hierarchy', () => {
  const scene = loadScene(sceneProject());
  assert.equal(
    formatObjects(scene.tree({ depth: 6 })),
    ['#1 组  [Transform, Camera]', '  #2 头 (隐藏)  [Transform, MeshRenderer, JSScriptComponent(sadface/sadface.js)]', '  #3 字  [ScreenTransform, FaceBinding, Text2D, DadNameReveal]'].join('\n'),
  );
  assert.equal(formatObjects(scene.tree({ depth: 1 })), '#1 组  [Transform, Camera]\n  … 还有 2 个子对象未展开（加大 depth 或用 subtree 查看）');
  assert.equal(formatObjects(scene.tree({ subtree: '字', depth: 6 })), '#3 字  [ScreenTransform, FaceBinding, Text2D, DadNameReveal]');
  assert.throws(() => scene.tree({ subtree: '#9', depth: 6 }), /SUBTREE_NOT_FOUND: #9 matches 0/);
  assert.deepEqual(scene.unreadable, []);
});

test('loadScene inspect gives values, resources, references and script parameters', () => {
  const scene = loadScene(sceneProject());
  const head = scene.inspect('#2');
  assert.deepEqual(head.components[0].properties, { localPosition: { x: 1, y: 0.5, z: 0 } });
  assert.deepEqual(head.components[1].properties, {
    enabled: true,
    sharedMaterials: [{ resource: '遮罩', type: 'Material', file: '遮罩.omtl' }],
    mesh: { resource: '头模', type: 'Mesh', file: path.join('sub', '头模.headJSA') },
    maskMaterial: { path: 'a82b9486-0bfd-3638-532d-fc233b7c55ac--a82b9486-0bfd-3638-532d-fc233b7c55ac.material' },
  });
  assert.equal(head.components[2].script, true);
  assert.deepEqual(head.components[2].properties, { enabled: true, path: 'sadface/sadface.js', maleIntensity: 0.3, target: { object: '#1', name: '组' } });
  const group = scene.inspect('#1');
  assert.deepEqual(group.components[1].properties, {
    enabled: true,
    type: 'PERSPECTIVE',
    renderTexture: { builtin: '00000000-0000-0000-0000-0000000000l3' },
    inputTexture: { builtin: 'share://input.texture' },
    fov: 45,
    maskTexture: { builtin: '00000000-0000-0000-0000-000000000802' },
    follow: { object: '#2', name: '头' },
    note: 'Guid(99, 99)',
  });
  assert.deepEqual(group.components[0].properties, { enabled: true, localPosition: { x: 0, y: 2, z: 40 }, eulerAngle: [0, 90, 0] });
  const text = scene.inspect('#3');
  assert.deepEqual(text.components[1], { type: 'FaceBinding', guid: '#3.2', properties: { enabled: true, faceIndex: 1 } });
  assert.deepEqual(text.components[2], {
    type: 'Text2D',
    guid: '#3.3',
    properties: { canvas: { TextCanvas: { canvasEnabled: false } }, font: { resource: '遮罩', type: 'Material', file: '遮罩.omtl' }, label: 'f6cfe326-8fb2-fda2-db1b-b375897821cb 不是资源' },
  });
  assert.equal(text.components[1].script, undefined);
  assert.deepEqual(text.components[3], { type: 'DadNameReveal', guid: '#3.4', script: true, properties: { enabled: true, tauntTemplate: '同学：{name}是谁呀？' } });
  assert.throws(() => scene.inspect('s1'), /OBJECT_NOT_FOUND: s1/);
});

test('loadScene fails closed on a missing or malformed scene and reports unreadable .extra files', () => {
  assert.throws(() => loadScene(tmpdir('xs-empty-')), /NO_MAIN_SCENE/);
  const dir = sceneProject({ badExtra: true });
  assert.match(loadScene(dir).unreadable.join(), /broken\.png\.extra/);
  const noEditor = loadScene(sceneProject({ badEditor: true }));
  assert.match(noEditor.unreadable.join(), /^main\.scene\.extra: /);
  assert.equal(noEditor.inspect('#3').components[2].type, 'Text');
  fs.writeFileSync(path.join(dir, 'Assets', 'main.scene'), SCENE_FILE + '--- !Transform\nname: x\n');
  assert.throws(() => loadScene(dir), /SCENE_PARSE_FAILED: .*without a unique anchor/);
  fs.writeFileSync(path.join(dir, 'Assets', 'main.scene'), SCENE_FILE + '--- !Transform &9\nname: [\n');
  assert.throws(() => loadScene(dir), /SCENE_PARSE_FAILED/);
});

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');

function previewLib(frames) {
  const calls = [];
  class PreviewManager {
    static getInstance() {
      return pm;
    }
    cacheCurrentFrame() {
      calls.push('cache');
    }
    captureScreenshotToMemory(q) {
      calls.push(`capture:${q}`);
      return frames.shift();
    }
  }
  const pm = new PreviewManager();
  return { lib: new Library((id) => (id === M.preview ? { PreviewManager } : undefined)), calls };
}

test('previewFrame returns the cached full-size preview frame, retrying while the preview has none yet', async () => {
  const { lib, calls } = previewLib([Buffer.alloc(0), null, Buffer.from('jpeg')]);
  assert.deepEqual(await lib.previewFrame(), { mimeType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') });
  assert.deepEqual(calls, ['cache', 'capture:92', 'cache', 'capture:92', 'cache', 'capture:92']);
  await assert.rejects(previewLib([]).lib.previewFrame(), /NO_PREVIEW_FRAME: .*after 20 tries/);
  await assert.rejects(new Library(() => undefined).previewFrame(), /INCOMPATIBLE_EDITOR: missing .*PreviewManager/);
});

const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');

function fakeOfficial({ resetOk = true, failSet, instances = [{ instance_id: '2', project_path: '/proj/A', generation: '100-1' }] } = {}) {
  const calls = [];
  return {
    calls,
    url: 'x',
    listTools: async () => [],
    status: () => ({}),
    callJson: async (name, args) => {
      calls.push([name, args]);
      if (name === 'list_instances') return { instances };
      if (name === 'get_scene') return SCENE;
      if (name === 'inspect') {
        if (args.guid === 'bad') throw Error('OFFICIAL_TOOL_ERROR(inspect): not found');
        if (args.guid === 'r1') return { kind: 'resource', name: '材质', type: 'Material', filePath: '/proj/A/Assets/m.omtl' };
        return { ...INSPECT, components: [...INSPECT.components, { type: 'MeshRenderer', guid: 'c3', properties: { sharedMaterials: [{ guid: 'r1' }] } }] };
      }
      if (name === 'interact_by_dsl') return { success: resetOk, results: [{ command_type: 'reset_preview', status: resetOk ? 'success' : 'failed' }] };
      if (name === 'get_current_preview_video') return { tracking_type: 'face', video_name: 'preview_single_blink||女', resource_url: '/v/blink.mp4' };
      if (name === 'set_preview_video') {
        if (failSet && args.video_name === failSet) throw Error('OFFICIAL_TOOL_ERROR(set_preview_video): no such video');
        return { ok: true };
      }
      throw Error(`unexpected ${name}`);
    },
  };
}

async function connect(deps) {
  const server = createServer({ listInstances: () => [], callPlugin: async () => ({}), ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('scene_tree asks get_scene for the full tree of one instance and returns the text view', async () => {
  const official = fakeOfficial();
  const client = await connect({ official });
  const res = await client.callTool({ name: 'scene_tree', arguments: { project_path: '/proj/A', subtree: 's20', depth: 3 } });
  assert.match(res.content[0].text, /^\[AI 实时变脸\] s19 GAN/);
  const call = official.calls.find((c) => c[0] === 'get_scene');
  assert.deepEqual({ ...call[1], intention: undefined }, { instance_id: '2', summary: false, depth: 3, subtree: 's20', intention: undefined });
  const unknown = await client.callTool({ name: 'scene_tree', arguments: { project_path: '/proj/B' } });
  assert.match(unknown.content[0].text, /NO_UNIQUE_INSTANCE for \/proj\/B/);
  const two = await connect({ official: fakeOfficial({ instances: [{ instance_id: '1', project_path: '/a' }, { instance_id: '2', project_path: '/b' }] }) });
  assert.match((await two.callTool({ name: 'scene_tree', arguments: {} })).content[0].text, /AMBIGUOUS_INSTANCE: 2/);
});

test('scene_tree and inspect_many read a project folder without a window, and save_to keeps the result', async () => {
  const official = fakeOfficial({ instances: [] });
  const client = await connect({ official });
  const dir = sceneProject({ badExtra: true });
  const keep = path.join(tmpdir('xs-keep-'), 'a', 'b');
  const tree = await client.callTool({ name: 'scene_tree', arguments: { project_dir: dir, save_to: keep } });
  assert.match(tree.content[0].text, /^#1 组  \[Transform, Camera\]\n  #2 头 \(隐藏\)/);
  assert.match(tree.content[0].text, /1 个资源描述文件（\.extra）读不了[\s\S]*broken\.png\.extra/);
  assert.match(tree.content[0].text, /已保存：.*scene_tree\.txt$/);
  assert.match(fs.readFileSync(path.join(keep, 'scene_tree.txt'), 'utf8'), /^#1 组/);
  const many = await client.callTool({ name: 'inspect_many', arguments: { project_dir: dir, guids: ['#2', 's1'], preset: 'key', save_to: keep } });
  const out = JSON.parse(many.content[0].text);
  assert.deepEqual(out[0].components.find((c) => c.script).properties.maleIntensity, 0.3);
  assert.match(out[1].error, /OBJECT_NOT_FOUND/);
  assert.match(many.content[1].text, /读不了/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(keep, 'inspect_many.json'), 'utf8')), out);
  assert.equal(official.calls.length, 0);
  const rel = await client.callTool({ name: 'scene_tree', arguments: { project_dir: dir, save_to: 'rel/dir' } });
  assert.match(rel.content[0].text, /SAVE_TO_NOT_ABSOLUTE/);
});

test('inspect_many inspects each guid, filters, resolves bound resources and isolates failures', async () => {
  const official = fakeOfficial();
  const client = await connect({ official });
  const res = JSON.parse((await client.callTool({ name: 'inspect_many', arguments: { instance_id: '2', guids: ['s21', 'bad', 's22'], fields: ['intensity', 'material'] } })).content[0].text);
  assert.deepEqual(res[0].components[0].properties, { intensity: 0.8, maleIntensity: 0.1 });
  assert.deepEqual(res[0].components[1].properties, { sharedMaterials: [{ resource: '材质', type: 'Material', file: 'm.omtl' }] });
  assert.match(res[1].error, /not found/);
  assert.deepEqual(official.calls.filter((c) => c[0] === 'inspect').map((c) => c[1].guid), ['s21', 'r1', 'bad', 's22']);
});

function framePlugin() {
  const calls = [];
  return { calls, callPlugin: async (method, params, opts) => (calls.push([method, opts.projectPath]), { mimeType: 'image/jpeg', data: JPG }) };
}

test('preview_frames resets, takes full-size frames from the plugin, saves and crops each one', async () => {
  const official = fakeOfficial();
  const plugin = framePlugin();
  const crops = [];
  const sleeps = [];
  const root = tmpdir('xs-frames-');
  const client = await connect({ official, ...plugin, sleep: async (ms) => sleeps.push(ms), framesDir: () => fs.mkdtempSync(path.join(root, 'f-')), cropImage: async (f, box) => crops.push([f, box]) });
  const res = await client.callTool({ name: 'preview_frames', arguments: { instance_id: '2', count: 3, interval_ms: 500, crop: { x: 0.2, y: 0.1, width: 0.6, height: 0.4 } } });
  assert.deepEqual(official.calls.find((c) => c[0] === 'interact_by_dsl')[1].commands, [{ command_type: 'reset_preview', params: {} }]);
  assert.deepEqual(plugin.calls, [['preview_frame', '/proj/A'], ['preview_frame', '/proj/A'], ['preview_frame', '/proj/A']]);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms > 400 && ms <= 1000), `${sleeps}`);
  const summary = JSON.parse(res.content[0].text);
  assert.equal(summary.frames, 3);
  assert.deepEqual(summary.files.map((f) => path.basename(f)), ['frame-1.jpg', 'frame-2.jpg', 'frame-3.jpg']);
  for (const f of summary.files) assert.equal(fs.readFileSync(f).toString('base64'), JPG);
  assert.deepEqual(crops.map((c) => c[0]), summary.files);
  assert.deepEqual(res.content.slice(1).map((c) => c.type), ['text', 'image', 'text', 'image', 'text', 'image']);
  assert.match(res.content[3].text, /^第 2 帧（\d+ ms）$/);
  assert.match(summary.note_files, /24 小时/);
  assert.equal(summary.note, undefined);
  assert.ok(!official.calls.some((c) => c[0] === 'set_preview_video'));
});

test('preview_frames shoots each video in turn, switches back once even on failure, and notes the save', async () => {
  const official = fakeOfficial();
  const keep = path.join(tmpdir('xs-keep-'), 'frames');
  const client = await connect({ official, ...framePlugin(), sleep: async () => {} });
  const res = await client.callTool({ name: 'preview_frames', arguments: { instance_id: '2', count: 2, videos: ['preview_single_shake_head||女', 'preview_double||双人'], reset: false, save_to: keep } });
  const sets = official.calls.filter((c) => c[0] === 'set_preview_video').map((c) => c[1].video_name);
  assert.deepEqual(sets, ['preview_single_shake_head||女', 'preview_double||双人', 'preview_single_blink||女']);
  assert.ok(!official.calls.some((c) => c[0] === 'interact_by_dsl'));
  const summary = JSON.parse(res.content[0].text);
  assert.deepEqual(summary.files, ['v1-frame-1.jpg', 'v1-frame-2.jpg', 'v2-frame-1.jpg', 'v2-frame-2.jpg'].map((f) => path.join(keep, f)));
  for (const f of summary.files) assert.ok(fs.existsSync(f));
  assert.equal(summary.note_files, undefined);
  assert.match(summary.note, /save_project/);
  assert.match(res.content[1].text, /^preview_single_shake_head\|\|女 第 1 帧/);

  const failing = fakeOfficial({ failSet: 'preview_double||双人' });
  const c2 = await connect({ official: failing, ...framePlugin(), sleep: async () => {}, framesDir: () => tmpdir('xs-f-') });
  const bad = await c2.callTool({ name: 'preview_frames', arguments: { instance_id: '2', videos: ['preview_single_shake_head||女', 'preview_double||双人'] } });
  assert.equal(bad.isError, true);
  assert.deepEqual(failing.calls.filter((c) => c[0] === 'set_preview_video').map((c) => c[1].video_name), ['preview_single_shake_head||女', 'preview_double||双人', 'preview_single_blink||女']);

  const tooMany = await c2.callTool({ name: 'preview_frames', arguments: { instance_id: '2', count: 7, videos: ['a', 'b', 'c', 'd'] } });
  assert.match(tooMany.content[0].text, /TOO_MANY_FRAMES: 28/);
  const c3 = await connect({ official: fakeOfficial({ resetOk: false }), ...framePlugin(), sleep: async () => {}, framesDir: () => tmpdir('xs-f-') });
  assert.match((await c3.callTool({ name: 'preview_frames', arguments: { instance_id: '2' } })).content[0].text, /RESET_PREVIEW_FAILED/);
});
