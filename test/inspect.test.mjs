import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { formatTree, pickInspect, unwrap } from '../src/inspect.mjs';
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

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');

function fakeOfficial({ shots = 4, failInteract = false, instances = [{ instance_id: '2', project_path: '/proj/A', generation: '100-1' }] } = {}) {
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
        return INSPECT;
      }
      if (name === 'get_current_preview_video') return { tracking_type: 'face', video_name: 'preview_single_blink||女', resource_url: '/v/blink.mp4' };
      if (name === 'set_preview_video') return { ok: true };
      throw Error(`unexpected ${name}`);
    },
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (failInteract) throw Error('editor went away');
      return { content: [{ type: 'text', text: '{"ok":true}' }, ...Array.from({ length: shots }, () => ({ type: 'image', data: PNG, mimeType: 'image/png' }))] };
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

test('inspect_many inspects each guid, filters, and isolates failures', async () => {
  const official = fakeOfficial();
  const client = await connect({ official });
  const res = JSON.parse((await client.callTool({ name: 'inspect_many', arguments: { instance_id: '2', guids: ['s21', 'bad'], fields: ['intensity'] } })).content[0].text);
  assert.deepEqual(res[0].components[0].properties, { intensity: 0.8, maleIntensity: 0.1 });
  assert.match(res[1].error, /not found/);
  assert.deepEqual(official.calls.filter((c) => c[0] === 'inspect').map((c) => c[1].guid), ['s21', 'bad']);
});

test('preview_frames resets, spaces the screenshots, saves and crops each frame', async () => {
  const official = fakeOfficial({ shots: 3 });
  const crops = [];
  const root = tmpdir('xs-frames-');
  const client = await connect({ official, framesDir: () => fs.mkdtempSync(path.join(root, 'f-')), cropImage: async (f, box) => crops.push([f, box]) });
  const res = await client.callTool({ name: 'preview_frames', arguments: { instance_id: '2', count: 3, interval_ms: 500, crop: { x: 0.2, y: 0.1, width: 0.6, height: 0.4 } } });
  const call = official.calls.find((c) => c[0] === 'interact_by_dsl');
  assert.deepEqual(
    call[1].commands.map((c) => c.command_type + (c.params.ms ? `:${c.params.ms}` : '')),
    ['reset_preview', 'screenshot', 'wait:500', 'screenshot', 'wait:500', 'screenshot'],
  );
  const summary = JSON.parse(res.content[0].text);
  assert.equal(summary.frames, 3);
  assert.equal(summary.files.length, 3);
  for (const f of summary.files) assert.ok(fs.existsSync(f));
  assert.deepEqual(crops.map((c) => c[0]), summary.files);
  assert.deepEqual(res.content.slice(1).map((c) => c.type), ['text', 'image', 'text', 'image', 'text', 'image']);
  assert.equal(res.content[3].text, '第 2 帧（+500 ms）');
  assert.equal(summary.note, undefined);
  assert.ok(!official.calls.some((c) => c[0] === 'set_preview_video'));
});

test('preview_frames switches the preview video and always switches back, noting the project needs saving', async () => {
  const official = fakeOfficial({ shots: 2 });
  const root = tmpdir('xs-frames-');
  const client = await connect({ official, framesDir: () => fs.mkdtempSync(path.join(root, 'f-')) });
  const res = await client.callTool({ name: 'preview_frames', arguments: { instance_id: '2', count: 3, video_name: 'preview_single_shake_head||女', reset: false } });
  const sets = official.calls.filter((c) => c[0] === 'set_preview_video').map((c) => c[1].video_name);
  assert.deepEqual(sets, ['preview_single_shake_head||女', 'preview_single_blink||女']);
  const summary = JSON.parse(res.content[0].text);
  assert.match(summary.warning, /asked for 3 frames, the editor returned 2/);
  assert.match(summary.note, /save_project/);
  assert.equal(official.calls.find((c) => c[0] === 'interact_by_dsl')[1].commands[0].command_type, 'screenshot');
  const failing = fakeOfficial({ failInteract: true });
  const c2 = await connect({ official: failing, framesDir: () => fs.mkdtempSync(path.join(root, 'f-')) });
  const bad = await c2.callTool({ name: 'preview_frames', arguments: { instance_id: '2', video_name: 'preview_single_shake_head||女' } });
  assert.equal(bad.isError, true);
  assert.deepEqual(failing.calls.filter((c) => c[0] === 'set_preview_video').map((c) => c[1].video_name), ['preview_single_shake_head||女', 'preview_single_blink||女']);
});
