import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.mjs';
import { fetchImage, readImageFile } from '../src/images.mjs';

const OWN = [
  'ai_combine_apply',
  'ai_combine_new',
  'effect_check',
  'effect_reviews',
  'effects_mine',
  'ext_status',
  'face_warp_list',
  'face_warp_set_intensity',
  'icon_open',
  'icon_set',
  'image_view',
  'inspect_many',
  'inspiration_bind',
  'inspiration_collect',
  'inspiration_detail',
  'inspiration_list',
  'inspiration_nav',
  'library_apply',
  'library_images',
  'library_list',
  'library_nav',
  'library_search',
  'makeup_layers',
  'menu_add',
  'menu_list',
  'menu_preview',
  'mobile_preview',
  'music_apply',
  'music_categories',
  'music_list',
  'object_remove',
  'preview_frames',
  'project_close',
  'project_new',
  'project_open',
  'rank_creators_month',
  'rank_hotspots',
  'rank_innovation_picks',
  'rank_list',
  'rank_nav',
  'rank_subjects',
  'resource_delete_unused',
  'scene_tree',
  'submit_prepare',
  'task_bind',
  'task_detail',
  'task_receive',
  'tasks_list',
  'works_by_effect',
  'works_cleanup',
  'works_download',
  'works_list',
  'works_nav',
  'works_open',
  'works_search',
];

function fakeOfficial({ tools = [{ name: 'get_scene', description: 'official', inputSchema: { type: 'object' } }], call } = {}) {
  const seen = [];
  return {
    seen,
    url: 'http://official',
    listTools: async () => tools,
    status: () => ({ connected: true, tools: tools.length }),
    callTool: async (name, args) => {
      seen.push([name, args]);
      if (call) return call(name, args);
      return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] };
    },
    callJson: async (name) => {
      seen.push([name]);
      if (name === 'list_instances') return { instances: [{ instance_id: '1', generation: '100-1', project_path: '/proj/A' }] };
      throw Error(`unexpected ${name}`);
    },
  };
}

async function connect(deps) {
  const server = createServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

test('lists own tools plus the official tools, own names first', async () => {
  const { client } = await connect({ official: fakeOfficial(), callPlugin: async () => ({}) });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).slice(0, OWN.length).sort(), OWN);
  assert.equal(tools.at(-1).name, 'get_scene');
  assert.equal(tools.find((t) => t.name === 'library_apply').inputSchema.type, 'object');
});

test('official tools are proxied unchanged, images included', async () => {
  const official = fakeOfficial();
  const { client } = await connect({ official, callPlugin: async () => ({}) });
  const res = await client.callTool({ name: 'get_scene', arguments: { instance_id: '1' } });
  assert.deepEqual(official.seen, [['get_scene', { instance_id: '1' }]]);
  assert.deepEqual(res.content, [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
});

test('official failures are reported as tool errors with their cause', async () => {
  const down = fakeOfficial({ call: () => Promise.reject(Error('ECONNREFUSED')) });
  const { client } = await connect({ official: down, callPlugin: async () => ({}) });
  const res = await client.callTool({ name: 'get_scene', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /OFFICIAL_MCP_UNAVAILABLE\(get_scene\): ECONNREFUSED/);
  const bad = fakeOfficial({ call: () => Promise.reject(new McpError(-32602, 'Invalid arguments')) });
  const c2 = (await connect({ official: bad, callPlugin: async () => ({}) })).client;
  const res2 = await c2.callTool({ name: 'get_scene', arguments: {} });
  assert.match(res2.content[0].text, /OFFICIAL_TOOL_ERROR\(get_scene\)/);
});

test('own tools route to the plugin window by project_path or official instance_id', async () => {
  const seen = [];
  const { client } = await connect({
    official: fakeOfficial(),
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (method === 'library_search') return { query: 'x', items: [{ template_id: '111', title: '芒果脸' }], raw: [{ templateId: '111', title: '芒果脸' }] };
      return { ok: method };
    },
  });
  const unseen = await client.callTool({ name: 'library_apply', arguments: { project_path: '/proj/B', template_id: '111' } });
  assert.match(unseen.content[0].text, /UNKNOWN_TEMPLATE: 111/);
  const found = JSON.parse((await client.callTool({ name: 'library_search', arguments: { project_path: '/proj/C', query: 'x' } })).content[0].text);
  assert.equal(found.raw, undefined);
  const a = await client.callTool({ name: 'library_apply', arguments: { project_path: '/proj/B', template_id: '111' } });
  assert.deepEqual(JSON.parse(a.content[0].text), { ok: 'library_apply' });
  assert.deepEqual(seen[1], { method: 'library_apply', params: { item: { templateId: '111', title: '芒果脸' } }, opts: { projectPath: '/proj/B', timeoutMs: 180000 } });
  await client.callTool({ name: 'face_warp_set_intensity', arguments: { instance_id: '1', object_path: 'a/塑型画笔', intensity: 55 } });
  assert.deepEqual(seen[2], { method: 'face_warp_set_intensity', params: { object_path: 'a/塑型画笔', intensity: 55 }, opts: { projectPath: '/proj/A', timeoutMs: undefined } });
  await client.callTool({ name: 'ai_combine_apply', arguments: { instance_id: '1', graph_id: 'g-1' } });
  assert.deepEqual(seen[3], { method: 'ai_combine_apply', params: { graph_id: 'g-1' }, opts: { projectPath: '/proj/A', timeoutMs: 180000 } });
  const unknown = await client.callTool({ name: 'menu_list', arguments: { instance_id: '7' } });
  assert.match(unknown.content[0].text, /UNKNOWN_INSTANCE: 7/);
  assert.equal(seen.length, 4);
});

test('invalid arguments are rejected before reaching the plugin', async () => {
  const seen = [];
  const { client } = await connect({ official: fakeOfficial(), callPlugin: async (m) => (seen.push(m), {}) });
  const res = await client.callTool({ name: 'face_warp_set_intensity', arguments: { object_path: 'a', intensity: 101 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /INVALID_ARGUMENTS\(face_warp_set_intensity\): intensity/);
  const extra = await client.callTool({ name: 'library_search', arguments: { query: 'x', bogus: 1 } });
  assert.equal(extra.isError, true);
  assert.deepEqual(seen, []);
});

test('image_view shows URLs and local files with a caption each, isolating failures', async () => {
  const fetched = [];
  const { client } = await connect({
    official: fakeOfficial(),
    callPlugin: async () => ({}),
    fetchImage: async (url) => {
      fetched.push(url);
      if (url === 'https://bad') throw Error('HTTP 404');
      return { data: 'AAAA', mimeType: 'image/png' };
    },
    readImageFile: async (file) => ({ data: Buffer.from(file).toString('base64'), mimeType: 'image/gif' }),
  });
  const res = await client.callTool({ name: 'image_view', arguments: { images: ['https://ok', 'https://bad', '/hover/smokey.png', 'blob:https://admin/x'] } });
  assert.deepEqual(res.content, [
    { type: 'text', text: '第 1 张：https://ok' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: '第 2 张：https://bad' },
    { type: 'text', text: '图片读取失败：HTTP 404' },
    { type: 'text', text: '第 3 张：/hover/smokey.png' },
    { type: 'image', data: Buffer.from('/hover/smokey.png').toString('base64'), mimeType: 'image/gif' },
    { type: 'text', text: '第 4 张：blob:https://admin/x' },
    { type: 'text', text: '图片读取失败：不是 http(s) 地址或绝对路径' },
  ]);
  assert.deepEqual(fetched, ['https://ok', 'https://bad']);
  const tooMany = await client.callTool({ name: 'image_view', arguments: { images: Array(9).fill('https://ok') } });
  assert.equal(tooMany.isError, true);
});

test('image_view stops before the stdio message limit and lists what it left out', async () => {
  let size = 3 * 1024 * 1024;
  const { client } = await connect({ official: fakeOfficial(), callPlugin: async () => ({}), fetchImage: async () => ({ data: 'A'.repeat(size), mimeType: 'image/gif' }) });
  const urls = ['https://g/1.gif', 'https://g/2.gif', 'https://g/3.gif', 'https://g/4.gif'];
  const res = await client.callTool({ name: 'image_view', arguments: { images: urls } });
  assert.equal(res.content.filter((c) => c.type === 'image').length, 2);
  assert.deepEqual(JSON.parse(res.content.at(-1).text).not_returned, ['https://g/3.gif', 'https://g/4.gif']);
  size = 9 * 1024 * 1024;
  const one = await client.callTool({ name: 'image_view', arguments: { images: urls.slice(2) } });
  assert.equal(one.content.filter((c) => c.type === 'image').length, 1);
  assert.deepEqual(JSON.parse(one.content.at(-1).text).not_returned, ['https://g/4.gif']);
});

test('menu_preview and library_images return image addresses without fetching them', async () => {
  const rows = [
    { menu_id: 'smokey', name: '烟熏妆', description: '一键烟熏妆', image_url: null, image_file: '/hover/smokey.png' },
    { menu_id: 'x', name: '无图项', description: '', image_url: null, image_file: null },
  ];
  const fetchImage = async () => assert.fail('no image may be fetched');
  const { client } = await connect({
    official: fakeOfficial(),
    callPlugin: async (method) => {
      if (method === 'menu_preview') return rows;
      if (method === 'library_search') return { items: [{ template_id: '901', title: '萌猫造型帽子', kind: 'ai_image' }], raw: [{ templateId: '901' }] };
      if (method === 'library_images') return [{ image_index: 0, url: 'https://img/0.png' }];
      throw Error(`unexpected ${method}`);
    },
    listInstances: () => [{ pid: 1 }],
    fetchImage,
    readImageFile: fetchImage,
  });
  const menu = await client.callTool({ name: 'menu_preview', arguments: { menu_ids: ['smokey', 'x'] } });
  assert.deepEqual(JSON.parse(menu.content[0].text), rows);
  assert.equal(menu.content.length, 1);
  await client.callTool({ name: 'library_search', arguments: { query: '猫' } });
  const lib = await client.callTool({ name: 'library_images', arguments: { template_id: '901' } });
  assert.deepEqual(JSON.parse(lib.content[0].text), { template_id: '901', title: '萌猫造型帽子', images: [{ image_index: 0, url: 'https://img/0.png' }] });
});

test('ext_status reports the official connection and each window with instance id and self check', async () => {
  const { client } = await connect({
    official: fakeOfficial(),
    listInstances: () => [{ pid: 100 }, { pid: 101 }],
    callPlugin: async (method, _p, opts) => {
      if (method === 'status') return { projectPath: `/proj/${opts.pid}` };
      if (opts.pid === 101) throw Error('PLUGIN_ERROR(self_check): unknown method: self_check');
      return { ok: true, missing: [] };
    },
  });
  const res = JSON.parse((await client.callTool({ name: 'ext_status', arguments: {} })).content[0].text);
  assert.deepEqual(res.official, { connected: true, tools: 1 });
  assert.deepEqual(res.windows[0], { pid: 100, project_path: '/proj/100', instance_id: '1', self_check: { ok: true, missing: [] } });
  assert.equal(res.windows[1].instance_id, null);
  assert.match(res.windows[1].self_check.error, /unknown method: self_check.*重开工程窗口/);
});

test('a change in the official tool list is pushed to clients', async () => {
  const official = fakeOfficial();
  const { client } = await connect({ official, callPlugin: async () => ({}) });
  let notified = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notified += 1;
  });
  official.onToolsChanged();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notified, 1);
});

test('image helpers sniff real bytes from URLs and files and reject non-images', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const srv = http.createServer((req, res) => {
    if (req.url === '/png') res.end(png);
    else if (req.url === '/webp') res.end(webp);
    else if (req.url === '/html') res.writeHead(200, { 'content-type': 'image/png' }).end('<html>');
    else res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.deepEqual(await fetchImage(`${base}/png`), { data: png.toString('base64'), mimeType: 'image/png' });
  assert.equal((await fetchImage(`${base}/webp`)).mimeType, 'image/webp');
  await assert.rejects(fetchImage(`${base}/html`), /not a png\/jpeg\/gif\/webp image/);
  await assert.rejects(fetchImage(`${base}/missing`), /HTTP 404/);
  const dir = tmpdir('xs-img-');
  fs.writeFileSync(path.join(dir, 'a.gif'), 'GIF89a....');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'hello');
  assert.equal((await readImageFile(path.join(dir, 'a.gif'))).mimeType, 'image/gif');
  await assert.rejects(readImageFile(path.join(dir, 'b.txt')), /not a png/);
});
