import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { makeupLayers, textureStats } from '../src/makeup.mjs';

// A w×h PNG painted with [r, g, b, a] where `inside(x, y)` holds, transparent elsewhere.
function png(w, h, inside, rgba) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(inside(x, y) ? rgba : [0, 0, 0, 0], (y * w + x) * 4);
  return PNG.sync.write(img);
}

const TEXTURES = {
  // Full-face layout: a thin band at y 0.38–0.42, where brows sit.
  brow: ['11111111-0000-0000-0000-000000000001', png(100, 100, (x, y) => y >= 38 && y <= 42 && x >= 30 && x < 70, [120, 90, 60, 255])],
  // A neutral-grey light/shadow map over the whole face.
  grey: ['11111111-0000-0000-0000-000000000002', png(20, 20, () => true, [128, 128, 128, 255])],
  // Eye layout: a dark band 0.12 tall (a liner) and a broad soft colour (a shadow).
  liner: ['11111111-0000-0000-0000-000000000003', png(100, 50, (x, y) => y >= 25 && y < 31 && x >= 10 && x < 90, [40, 40, 40, 255])],
  shadow: ['11111111-0000-0000-0000-000000000004', png(100, 50, (x, y) => y >= 15 && y < 40, [200, 150, 140, 128])],
  // Lips layout: a near-white gloss.
  gloss: ['11111111-0000-0000-0000-000000000005', png(40, 20, () => true, [250, 250, 250, 255])],
  red: ['11111111-0000-0000-0000-000000000006', png(40, 20, () => true, [200, 40, 60, 255])],
  iris: ['11111111-0000-0000-0000-000000000007', png(10, 10, () => true, [90, 70, 50, 255])],
  // Eye layout: a lower-lid band at y 0.76, and a near-white glint.
  lowerLid: ['11111111-0000-0000-0000-000000000008', png(100, 50, (x, y) => y >= 36 && y < 40 && x >= 20 && x < 80, [220, 180, 160, 255])],
  glint: ['11111111-0000-0000-0000-000000000009', png(100, 50, (x, y) => y >= 20 && y < 35 && x >= 20 && x < 80, [255, 255, 255, 255])],
  // Full-face layout: a narrow strip down the middle (nose), one dot off-centre, a broad patch at the top.
  nose: ['11111111-0000-0000-0000-00000000000a', png(100, 100, (x, y) => x >= 46 && x < 54 && y >= 40 && y < 60, [255, 255, 255, 255])],
  dot: ['11111111-0000-0000-0000-00000000000b', png(100, 100, (x, y) => x === 20 && y === 55, [80, 50, 40, 255])],
  top: ['11111111-0000-0000-0000-00000000000c', png(100, 100, (x, y) => x >= 20 && x < 80 && y >= 5 && y < 20, [230, 200, 190, 255])],
  // Full-face layout: two soft patches on the cheeks.
  cheeks: ['11111111-0000-0000-0000-00000000000d', png(100, 100, (x, y) => (x < 40 || x >= 60) && x >= 25 && x < 75 && y >= 50 && y < 65, [240, 150, 160, 160])],
};

// [name, layer, { parent, hidden }]; a layer is a FaceMask ({ type, region, tex, female, male, enabled })
// or an EyeColor ({ eye: true, tex, intensity }).
const OBJECTS = [
  ['面部面具', null],
  ['面具1', { type: 'FACEU_MASK', region: 0, tex: 'brow', female: 0.8, male: 0.3 }, { parent: '面部面具' }],
  ['面具2', { type: 'FACEU_MASK', region: 0, tex: 'grey', female: 0.6, male: 0.3 }, { parent: '面部面具' }],
  ['腮红', { type: 'FACEU_MASK', region: 0, tex: 'red', female: 0.5, male: 0 }, { parent: '面部面具' }],
  ['眼部妆容', { type: 'FACEU_EYEPART', region: 1, tex: 'liner', female: 0.9, male: 0 }, { parent: '面部面具' }],
  ['眼部妆容 (2)', { type: 'FACEU_EYEPART', region: 1, tex: 'shadow', female: 0.4, male: 0.1 }, { parent: '面部面具' }],
  // The name says lipstick but the region is the eye layout: the name does not decide.
  ['口红色眼影', { type: 'FACEU_EYEPART', region: 1, tex: 'shadow', female: 0.3, male: 0.1 }, { parent: '面部面具' }],
  ['鸢尾狐', { type: 'FACEU_JIEMAO', region: 2, tex: 'liner', female: 1, male: 0 }, { parent: '面部面具' }],
  ['唇部妆容', { type: 'FACEU_LIPS_KEYPOINT', region: 3, tex: 'red', female: 0.7, male: 0.1 }, { parent: '面部面具' }],
  ['唇面高光', { type: 'FACEU_LIPS_KEYPOINT', region: 3, tex: 'red', female: 0.3, male: 0 }, { parent: '面部面具' }],
  ['面具3', { type: 'FACEU_LIPS_KEYPOINT', region: 3, tex: 'gloss', female: 0.3, male: 0 }, { parent: '面部面具' }],
  ['牙齿美白', { type: 'FACEU_LIPS_KEYPOINT', region: 4, builtin: true, female: 0.3, male: 0.3 }, { parent: '面部面具' }],
  ['新区域', { type: 'FACEU_NEW', region: 9, tex: 'red', female: 0.5, male: 0.5 }, { parent: '面部面具' }],
  ['修容', { type: 'FACEU_MASK', region: 0, dangling: true, female: 0.5, male: 0.2, enabled: false }, { parent: '面部面具' }],
  ['零强度', { type: 'FACEU_MASK', region: 0, tex: 'red', female: 0, male: 0 }, { parent: '面部面具' }],
  ['备用', null, { hidden: true }],
  ['眉毛', { type: 'FACEU_MASK', region: 0, tex: 'brow', female: 0.8, male: 0.3 }, { parent: '备用' }],
  ['美瞳', { eye: true, tex: 'iris', intensity: 0.5 }],
  ['眼部妆容 (3)', { type: 'FACEU_EYEPART', region: 1, tex: 'lowerLid', female: 0.4, male: 0 }, { parent: '面部面具' }],
  ['眼部妆容 (4)', { type: 'FACEU_EYEPART', region: 1, tex: 'glint', female: 0.4, male: 0 }, { parent: '面部面具' }],
  ['面具4', { type: 'FACEU_MASK', region: 0, tex: 'nose', female: 0.4, male: 0 }, { parent: '面部面具' }],
  ['面具5', { type: 'FACEU_MASK', region: 0, tex: 'dot', female: 0.4, male: 0 }, { parent: '面部面具' }],
  ['面具6', { type: 'FACEU_MASK', region: 0, tex: 'top', female: 0.4, male: 0 }, { parent: '面部面具' }],
  ['面具7', { type: 'FACEU_MASK', region: 0, tex: 'cheeks', female: 0.4, male: 0 }, { parent: '面部面具' }],
];

function makeupProject(objects = OBJECTS) {
  const dir = tmpdir('xs-makeup-');
  const assets = path.join(dir, 'Assets');
  fs.mkdirSync(path.join(assets, 'tex'), { recursive: true });
  for (const [name, [uuid, buf]] of Object.entries(TEXTURES)) {
    fs.writeFileSync(path.join(assets, 'tex', `${name}.png`), buf);
    fs.writeFileSync(path.join(assets, 'tex', `${name}.png.extra`), JSON.stringify([{ guid: { a: uuid, b: '' }, name, rttiType: 'Texture' }]));
  }
  const index = new Map(objects.map(([name], i) => [name, i]));
  const tid = (i) => 100 + i;
  const texRef = (l) => (l.builtin ? '00000000-0000-0000-0000-00000000001e' : l.dangling ? '99999999-0000-0000-0000-000000000000' : TEXTURES[l.tex][0]);
  const entities = [];
  const docs = [];
  const editor = [];
  for (const [i, [name, layer, opts = {}]] of objects.entries()) {
    const comps = [`      - {localId: ${tid(i)}}`];
    if (layer?.eye) {
      comps.push(
        '      - __class: DynamicComponent',
        '        name: !<str> EyeColor',
        `        guid: {a: ${i}, b: 2}`,
        '        serializedProperty:',
        '          __class: ScriptSerializedProperty',
        '          name: !<str> ""',
        `          guid: {a: ${i}, b: 3}`,
        '          properties:',
        '            __class: Map',
        `            intensity: ${layer.intensity}`,
        '            color: {r: 1, g: 0.5, b: 0, a: 1}',
        `            makeupTexture: {localId: 1, path: ${texRef(layer)}}`,
        '        enabled: true',
        '        className: !<str> EyeColor',
      );
      editor.push({ guid: { a: `e${i}` }, objGuid: `Guid(${i}, 2)`, extraType: 'EyeColorV2', rttiType: 'EyeColor' });
    } else if (layer) {
      comps.push(
        '      - __class: EffectFaceMakeupFaceU',
        '        name: !<str> ""',
        `        guid: {a: ${i}, b: 2}`,
        `        enabled: ${layer.enabled ?? true}`,
        '        type:',
        '          __class: EffectFaceMakeupType',
        `          value: ${layer.type}`,
      );
      editor.push({ guid: { a: `e${i}` }, objGuid: `Guid(${i}, 2)`, extraType: 'FaceMask', rttiType: 'FaceMakeup', regionType: layer.region, makeupTexture: texRef(layer), femaleIntensity: layer.female, maleIntensity: layer.male });
    }
    entities.push(['  - __class: Entity', `    name: !<str> ${name}`, `    guid: {a: ${i}, b: 1}`, '    scene: {localId: 1}', `    selfvisible: ${!opts.hidden}`, '    components:', ...comps].join('\n'));
    const children = objects.map(([, , o], j) => (o?.parent === name ? `  - {localId: ${tid(j)}}` : null)).filter(Boolean);
    const parent = opts.parent ? [`parent: {localId: ${tid(index.get(opts.parent))}}`] : [];
    docs.push([`--- !Transform &${tid(i)}`, 'name: !<str> ""', `guid: {a: ${i}, b: 9}`, ...parent, ...(children.length ? ['children:', ...children] : [])].join('\n'));
  }
  const scene = ['%YAML 1.1', '--- !Scene &1', 'name: !<str> ""', 'guid: {a: 1000, b: 1000}', 'entities:', ...entities, 'visible: true', ...docs, ''].join('\n');
  fs.writeFileSync(path.join(assets, 'main.scene'), scene);
  fs.writeFileSync(path.join(assets, 'main.scene.extra'), JSON.stringify(editor));
  return dir;
}

const byName = (out) => Object.fromEntries(out.layers.map((l) => [l.name, l]));

test('textureStats gives the alpha-weighted colour and where the painted pixels sit', () => {
  const dir = tmpdir('xs-tex-');
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, TEXTURES.brow[1]);
  assert.deepEqual(textureStats(file), { color: '#785A3C', hsl: [30, 33, 35], coverage: 0.02, cx: 0.495, cy: 0.4, width: 0.4, height: 0.05 });
  fs.writeFileSync(file, png(4, 4, () => false, [0, 0, 0, 0]));
  assert.throws(() => textureStats(file), /贴图全透明/);
  fs.writeFileSync(file, Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'));
  assert.throws(() => textureStats(file), /不是 PNG/);
});

test('makeupLayers tells the region, part and colour of each layer, by name where it fits and by pixels otherwise', () => {
  const out = makeupLayers(makeupProject());
  const l = byName(out);
  assert.deepEqual(l['面具1'], {
    object: '#2', name: '面具1', path: '面部面具/面具1', active: true, region: '全脸', part: '眉毛', part_from: '贴图', female: 0.8, male: 0.3, texture: path.join('tex', 'brow.png'), color: '#785A3C', hsl: [30, 33, 35],
  });
  const parts = (names) => names.map((n) => [n, l[n].region, l[n].part, l[n].part_from]);
  const names = ['面具2', '面具4', '面具5', '面具6', '面具7', '腮红', '眼部妆容', '眼部妆容 (2)', '眼部妆容 (3)', '眼部妆容 (4)', '口红色眼影', '鸢尾狐', '唇部妆容', '唇面高光', '面具3', '牙齿美白', '美瞳'];
  assert.deepEqual(parts(names), [
    ['面具2', '全脸', '明暗', '贴图'],
    ['面具4', '全脸', '鼻部', '贴图'],
    ['面具5', '全脸', '点缀', '贴图'],
    ['面具6', '全脸', '全脸其他', '贴图'],
    ['面具7', '全脸', '腮红/修容', '贴图'],
    ['腮红', '全脸', '腮红', '层名'],
    ['眼部妆容', '眼部', '眼线', '贴图'],
    ['眼部妆容 (2)', '眼部', '眼影', '贴图'],
    ['眼部妆容 (3)', '眼部', '卧蚕', '贴图'],
    ['眼部妆容 (4)', '眼部', '高光', '贴图'],
    ['口红色眼影', '眼部', '眼影', '贴图'],
    ['鸢尾狐', '睫毛', '睫毛', '区域'],
    ['唇部妆容', '唇部', '口红', '层名'],
    ['唇面高光', '唇部', '唇部高光', '层名'],
    ['面具3', '唇部', '唇部高光', '贴图'],
    ['牙齿美白', '牙齿', '牙齿美白', '区域'],
    ['美瞳', '美瞳', '美瞳', '组件'],
  ]);
  assert.equal(l['牙齿美白'].texture_note, '内置贴图，没有分析像素');
  assert.deepEqual([l['美瞳'].female, l['美瞳'].male, l['美瞳'].color, l['美瞳'].tint], [0.5, 0.5, '#5A4632', '#FF8000']);
  assert.deepEqual([l['新区域'].region, l['新区域'].part], ['FACEU_NEW/9', null]);
  assert.deepEqual(out.notes, ['#13 新区域：没见过的妆容区域 FACEU_NEW/9，没有判断部位']);
});

test('makeupLayers marks hidden, disabled and zero-strength layers inactive and leaves them out of the groups', () => {
  const out = makeupLayers(makeupProject());
  const l = byName(out);
  assert.deepEqual([l['眉毛'].active, l['眉毛'].off, l['眉毛'].path], [false, '隐藏', '备用/眉毛']);
  assert.deepEqual([l['修容'].active, l['修容'].off], [false, '组件停用']);
  assert.match(l['修容'].texture_note, /^贴图不在工程里（99999999-/);
  assert.deepEqual([l['零强度'].active, l['零强度'].off], [false, '强度为 0']);
  assert.equal(l['面具1'].off, undefined);
  assert.deepEqual(out.groups, {
    眉: ['#2 面具1（眉毛，女 0.8 / 男 0.3）'],
    眼妆: [
      '#5 眼部妆容（眼线，女 0.9 / 男 0）',
      '#6 眼部妆容 (2)（眼影，女 0.4 / 男 0.1）',
      '#7 口红色眼影（眼影，女 0.3 / 男 0.1）',
      '#8 鸢尾狐（睫毛，女 1 / 男 0）',
      '#19 眼部妆容 (3)（卧蚕，女 0.4 / 男 0）',
      '#20 眼部妆容 (4)（高光，女 0.4 / 男 0）',
    ],
    美瞳: ['#18 美瞳（美瞳，女 0.5 / 男 0.5）'],
    颊: ['#4 腮红（腮红，女 0.5 / 男 0）', '#24 面具7（腮红/修容，女 0.4 / 男 0）'],
    轮廓: ['#3 面具2（明暗，女 0.6 / 男 0.3）', '#21 面具4（鼻部，女 0.4 / 男 0）'],
    唇: ['#9 唇部妆容（口红，女 0.7 / 男 0.1）', '#10 唇面高光（唇部高光，女 0.3 / 男 0）', '#11 面具3（唇部高光，女 0.3 / 男 0）'],
    点缀: ['#22 面具5（点缀，女 0.4 / 男 0）'],
    其他: ['#13 新区域（FACEU_NEW/9，女 0.5 / 男 0.5）', '#23 面具6（全脸其他，女 0.4 / 男 0）'],
  });
  assert.deepEqual(out.absent, []);
});

test('makeupLayers lists the parts a look leaves out, and a project without makeup lacks them all', () => {
  const dir = makeupProject();
  const extra = path.join(dir, 'Assets', 'main.scene.extra');
  const editor = JSON.parse(fs.readFileSync(extra, 'utf8'));
  const named = (n) => `Guid(${OBJECTS.findIndex(([name]) => name === n)}, 2)`;
  const drop = new Set(['眼部妆容', '眼部妆容 (2)', '眼部妆容 (3)', '眼部妆容 (4)', '口红色眼影', '鸢尾狐'].map(named));
  fs.writeFileSync(extra, JSON.stringify(editor.map((e) => (drop.has(e.objGuid) ? { ...e, femaleIntensity: 0, maleIntensity: 0 } : e))));
  assert.deepEqual(makeupLayers(dir).absent, ['眼妆']);
  const bare = makeupLayers(makeupProject([['皇冠', null]]));
  assert.deepEqual([bare.layers, bare.absent], [[], ['眉', '眼妆', '美瞳', '颊', '轮廓', '唇']]);
});

test('makeupLayers fails rather than reporting a look as bare when the editor data of its layers is missing', () => {
  const dir = makeupProject();
  fs.writeFileSync(path.join(dir, 'Assets', 'main.scene.extra'), '[]');
  assert.throws(() => makeupLayers(dir), /MAKEUP_EDITOR_DATA_MISSING: 22 个妆容组件.*#2 面具1/);
});

test('makeup_layers tool reads a project folder, saves on request and fails on a folder without a scene', async () => {
  const server = createServer({ listInstances: () => [], callPlugin: async () => ({}), official: { listTools: async () => [], status: () => ({}) } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const keep = tmpdir('xs-keep-');
  const res = await client.callTool({ name: 'makeup_layers', arguments: { project_dir: makeupProject(), save_to: keep } });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.layers.length, 22);
  assert.match(res.content[1].text, /已保存：.*makeup_layers\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(keep, 'makeup_layers.json'), 'utf8')), out);
  const missing = await client.callTool({ name: 'makeup_layers', arguments: { project_dir: tmpdir('xs-empty-') } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /NO_MAIN_SCENE/);
});
