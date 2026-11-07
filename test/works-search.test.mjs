import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');

const work = (id, title) => ({ templateId: id, title, desc: '', businessExtra: { fileMap: {} } });
const many = (prefix, n, title) => Array.from({ length: n }, (_, i) => work(`${prefix}${i}`, `${title}${i}`));

// A fake homepage search that behaves like the real one: without the previous page's sortingPosition
// and version every page is the first page again, and a pass can end early.
function setup({ byCategory, cutFirstPass = {}, stuck = new Set() }) {
  const calls = [];
  const passes = {};
  const modules = {
    [M.worksPanel]: {
      apiTemplatesPanel: async () => ({ body: { statusCode: 0, data: { categories: [{ id: 1, name: '推荐' }, { id: 2, name: '美化' }, { id: 3, name: '官方工程' }] } } }),
    },
    [M.worksCategory]: {
      apiTemplatesCategory: async () => ({ body: { statusCode: 0, data: { dataInfos: { template: [] } } } }),
      apiSearchTemplatesCategory: async (p) => {
        calls.push(p);
        const key = `${p.searchWord}|${p.categoryId}`;
        const all = (byCategory[key] || []).slice();
        if (p.cursor === 0) passes[key] = (passes[key] || 0) + 1;
        const paged = p.cursor > 0 && p.sortingPosition === p.cursor && p.version === 'v1';
        const start = stuck.has(key) || !paged ? 0 : p.cursor;
        const end = passes[key] === 1 && cutFirstPass[key] !== undefined ? Math.min(cutFirstPass[key], start + p.count) : start + p.count;
        const template = all.slice(start, end);
        const hasNext = stuck.has(key) || (end < all.length && !(passes[key] === 1 && cutFirstPass[key] !== undefined && end >= cutFirstPass[key]));
        return { body: { statusCode: 0, data: { dataInfos: { template, cursor: end, sortingPosition: end, version: 'v1', hasNext } } } };
      },
    },
    [M.worksUtil]: { transformTemplate: (t) => ({ description: '', tags: [], coverPath: `https://c/${t.templateId}.png` }) },
    [M.worksDownload]: { DownloadTemplateModel: class { startDownload() {} getTemplateProjectPath() {} } },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  return { lib, calls };
}

const ids = (out) => out.items.map((i) => i.template_id);

test('works_search pages each category to the end with sortingPosition and version, and merges 推荐 first', async () => {
  const shared = work('r0', '头套0');
  const { lib, calls } = setup({
    byCategory: {
      '头套|1': many('r', 120, '头套'),
      '头套|2': [shared, work('b1', '美化头套'), work('b2', '头套美化')],
    },
  });
  const out = await lib.worksSearch({ query: '头套', count: 500 });
  assert.equal(out.total, 122);
  assert.deepEqual(ids(out).slice(0, 2), ['r0', 'r1']);
  assert.deepEqual(ids(out).slice(-2), ['b1', 'b2']);
  assert.deepEqual(out.items[0].found_in, ['推荐', '美化']);
  assert.deepEqual(out.items.at(-1).found_in, ['美化']);
  assert.deepEqual(out.by_category, [{ id: '1', name: '推荐', count: 120 }, { id: '2', name: '美化', count: 3 }]);
  assert.equal(out.category, undefined);
  assert.equal(out.incomplete, undefined);
  const later = calls.filter((p) => p.categoryId === '1' && p.cursor > 0);
  assert.ok(later.length >= 2 && later.every((p) => p.sortingPosition === p.cursor && p.version === 'v1'));
  assert.deepEqual(out.raw.map((r) => r.templateId), ids(out));
});

test('a pass the server ends early is run once more, a category at the cap is not, and the cap holds', async () => {
  const { lib, calls } = setup({
    byCategory: { '头套|1': many('r', 400, '头套'), '头套|2': many('b', 80, '美化头套') },
    cutFirstPass: { '头套|2': 30 },
  });
  const out = await lib.worksSearch({ query: '头套', count: 1000 });
  assert.equal(out.by_category.find((c) => c.name === '推荐').count, 300);
  assert.equal(out.by_category.find((c) => c.name === '美化').count, 80);
  assert.equal(calls.filter((p) => p.categoryId === '1' && p.cursor === 0).length, 1);
  assert.equal(calls.filter((p) => p.categoryId === '2' && p.cursor === 0).length, 2);
});

test('a category whose pages never move on is stopped and reported as incomplete', async () => {
  const { lib, calls } = setup({ byCategory: { '头套|1': many('r', 120, '头套') }, stuck: new Set(['头套|1']) });
  const out = await lib.worksSearch({ query: '头套', category_id: '1', count: 500 });
  assert.equal(out.total, 50);
  assert.deepEqual(out.incomplete, ['推荐']);
  assert.deepEqual(out.category, { id: '1', name: '推荐' });
  assert.ok(calls.length <= 4, `${calls.length} requests`);
});

test('queries merge several words, and pages come from the cache for ten minutes', async () => {
  const { lib, calls } = setup({ byCategory: { '头套|1': [work('a', '兔子头套'), work('c', '头套头饰')], '头饰|1': [work('c', '头套头饰'), work('d', '头饰')] } });
  const out = await lib.worksSearch({ queries: ['头套', '头饰', '头套'], count: 2 });
  assert.deepEqual(out.queries, ['头套', '头饰']);
  assert.deepEqual(ids(out), ['a', 'c']);
  assert.deepEqual(out.items[1].matched_queries, ['头套', '头饰']);
  assert.deepEqual({ total: out.total, next: out.next_offset, more: out.has_more }, { total: 3, next: 2, more: true });
  const asked = calls.length;
  const next = await lib.worksSearch({ queries: ['头套', '头饰'], offset: 2, count: 2 });
  assert.deepEqual(ids(next), ['d']);
  assert.equal(calls.length, asked);
  for (const v of lib.worksCache.values()) v.at -= 10 * 60 * 1000 + 1;
  await lib.worksSearch({ queries: ['头套', '头饰'], offset: 2, count: 2 });
  assert.ok(calls.length > asked);
  await assert.rejects(lib.worksSearch({}), /INVALID_QUERY: pass query, or 1-8 queries/);
  await assert.rejects(lib.worksSearch({ query: 'a', queries: ['b'] }), /not both/);
  await assert.rejects(lib.worksSearch({ queries: ['a', ' '] }), /every query must be a non-empty string/);
  await assert.rejects(lib.worksSearch({ query: 'a', category_id: '9' }), /INVALID_CATEGORY_ID/);
});

test('the server takes a string cursor for works_list and offset / queries for works_search', async () => {
  const seen = [];
  const callPlugin = async (method, params) => (seen.push([method, params]), { items: [], raw: [] });
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ official, callPlugin, listInstances: () => [{ pid: 1 }] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.callTool({ name: 'works_list', arguments: { cursor: 'eyJjdXJzb3IiOjJ9' } });
  assert.deepEqual(seen.at(-1), ['works_list', { cursor: 'eyJjdXJzb3IiOjJ9' }]);
  assert.equal((await client.callTool({ name: 'works_list', arguments: { cursor: 2 } })).isError, true);
  await client.callTool({ name: 'works_search', arguments: { queries: ['头套', '头饰'], offset: 30, count: 10 } });
  assert.deepEqual(seen.at(-1), ['works_search', { queries: ['头套', '头饰'], offset: 30, count: 10 }]);
  assert.equal((await client.callTool({ name: 'works_search', arguments: { query: 'x', cursor: 2 } })).isError, true);
});
