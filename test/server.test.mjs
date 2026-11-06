import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

async function connect(call, instances = () => []) {
  const server = createServer(call, instances);
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ['ext_status', 'library_apply', 'library_list', 'library_nav', 'library_search']);

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

test('ext_status reports each live plugin window', async () => {
  const client = await connect(
    async (method, _p, opts) => {
      assert.equal(method, 'status');
      return { projectPath: `/proj/${opts.pid}` };
    },
    () => [{ pid: 1 }, { pid: 2 }],
  );
  const res = await client.callTool({ name: 'ext_status', arguments: {} });
  assert.deepEqual(JSON.parse(res.content[0].text), [
    { pid: 1, project_path: '/proj/1' },
    { pid: 2, project_path: '/proj/2' },
  ]);
});
