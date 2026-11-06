import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, fetchImage } from '../src/server.mjs';

async function connect(call, instances = () => [], getImage) {
  const server = createServer(call, instances, getImage);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('tools forward to plugin methods with project selection split out', async () => {
  const seen = [];
  const client = await connect(async (method, params, opts) => {
    seen.push({ method, params, opts });
    return { ok: method };
  });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['ext_status', 'library_apply', 'library_list', 'library_nav', 'library_preview', 'library_search']);

  const res = await client.callTool({ name: 'library_apply', arguments: { project_path: '/p', template_id: '111' } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(res.content[0].text), { ok: 'library_apply' });
  assert.equal(seen[0].method, 'library_apply');
  assert.deepEqual(seen[0].params, { template_id: '111' });
  assert.equal(seen[0].opts.projectPath, '/p');
  assert.equal(seen[0].opts.timeoutMs, 180000);
});

test('plugin errors become MCP tool errors', async () => {
  const client = await connect(async () => {
    throw Error('PLUGIN_ERROR(library_apply): UNKNOWN_TEMPLATE: 1');
  });
  const res = await client.callTool({ name: 'library_apply', arguments: { template_id: '1' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /UNKNOWN_TEMPLATE/);
});

test('ext_status reports each live plugin window with its self check', async () => {
  const client = await connect(
    async (method, _p, opts) => {
      if (method === 'status') return { projectPath: `/proj/${opts.pid}` };
      assert.equal(method, 'self_check');
      if (opts.pid === 3) throw Error('PLUGIN_ERROR(self_check): unknown method: self_check');
      return opts.pid === 1 ? { ok: true, missing: [] } : { ok: false, missing: ['m :: f'] };
    },
    () => [{ pid: 1 }, { pid: 2 }, { pid: 3 }],
  );
  const res = await client.callTool({ name: 'ext_status', arguments: {} });
  assert.equal(res.isError, undefined);
  const rows = JSON.parse(res.content[0].text);
  assert.deepEqual(rows.slice(0, 2), [
    { pid: 1, project_path: '/proj/1', self_check: { ok: true, missing: [] } },
    { pid: 2, project_path: '/proj/2', self_check: { ok: false, missing: ['m :: f'] } },
  ]);
  assert.equal(rows[2].self_check.ok, false);
  assert.match(rows[2].self_check.error, /unknown method: self_check.*重开工程窗口/);
});

test('library_preview returns a title and image per cover, isolating per-item failures', async () => {
  const seen = [];
  const client = await connect(
    async (method, params, opts) => {
      seen.push({ method, params, opts });
      return [
        { template_id: '1', title: '芒果脸', cover_url: 'https://ok' },
        { template_id: '2', title: '无图', cover_url: null },
        { template_id: '3', title: '坏图', cover_url: 'https://bad' },
      ];
    },
    () => [],
    async (url) => {
      if (url === 'https://bad') throw Error('HTTP 404');
      return { data: 'AAAA', mimeType: 'image/png' };
    },
  );
  const res = await client.callTool({ name: 'library_preview', arguments: { project_path: '/p', template_ids: ['1', '2', '3'] } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(seen[0], { method: 'library_covers', params: { template_ids: ['1', '2', '3'] }, opts: { projectPath: '/p' } });
  assert.deepEqual(res.content, [
    { type: 'text', text: '芒果脸（template_id 1）' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: '无图（template_id 2）' },
    { type: 'text', text: '无封面图' },
    { type: 'text', text: '坏图（template_id 3）' },
    { type: 'text', text: '封面下载失败：HTTP 404' },
  ]);
});

test('library_preview surfaces plugin errors and enforces the 8-item limit', async () => {
  const client = await connect(async () => {
    throw Error('PLUGIN_ERROR(library_covers): UNKNOWN_TEMPLATE: 9');
  });
  const res = await client.callTool({ name: 'library_preview', arguments: { template_ids: ['9'] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /UNKNOWN_TEMPLATE/);
  const tooMany = await client.callTool({ name: 'library_preview', arguments: { template_ids: Array(9).fill('1') } });
  assert.equal(tooMany.isError, true);
});

test('fetchImage sniffs real image bytes and rejects non-images', async (t) => {
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
});
