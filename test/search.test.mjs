import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');

const rec = (id, title, panelKey) => ({ templateId: id, title, panelKey, businessExtra: { coverMap: { c: { url: `https://c/${id}.png` } } } });

// A fake asset library: 美妆, 滤镜 and 跟脸贴纸 with sub-categories, 素材广场 and 收藏.
function setup() {
  const calls = { search: [], list: [], category: [] };
  const categories = {
    '3d_makeup': [{ id: 1, name: '腮红' }, { id: 2, name: '风格妆' }],
    '3d_filter': [{ id: 11, name: '复古' }, { id: 12, name: '热门' }],
    sticker: [{ id: 21, name: '腮红' }, { id: 22, name: '甜妹腮红' }, { id: 23, name: '大图' }],
  };
  const big = Array.from({ length: 350 }, (_, i) => rec(`b${i}`, `大图${i}`, 'sticker'));
  const byCategory = {
    1: [rec('m1', '雾堇胭', '3d_makeup'), rec('m2', '红玫瑰', '3d_makeup')],
    2: [rec('m3', '欧美妆', '3d_makeup'), rec('m4', '猫眼妆', '3d_makeup')],
    11: [rec('f1', 'City Walk', '3d_filter'), rec('f2', '富士', '3d_filter')],
    12: [rec('f2', '富士', '3d_filter'), rec('f3', '柔焦可可', '3d_filter')],
    21: [rec('s1', '腮红008', 'sticker'), rec('s2', '白兔', 'sticker')],
    22: [rec('s3', '甜妹', 'sticker')],
    23: big,
  };
  const titles = {
    '腮红|sticker': [rec('t1', '腮红', 'sticker'), rec('s1', '腮红008', 'sticker'), rec('t2', '鼻底腮红', 'sticker'), rec('t3', '腮红贴', 'sticker')],
    '腮红|aigc_material': [rec('t4', '腮红青蛙贴纸', 'aigc_material'), rec('t5', '可爱', 'aigc_material')],
    '欧美|3d_makeup': [rec('m5', '欧美风', '3d_makeup'), rec('m3', '欧美妆', '3d_makeup')],
    '猫眼|3d_makeup': [rec('m4', '猫眼妆', '3d_makeup')],
    '韩系|3d_filter': [rec('f4', '韩系清透', '3d_filter')],
    '韩系|sticker': [rec('k1', '韩系发夹', 'sticker')],
  };
  const modules = {
    [M.nav]: {
      getDefaultNavList: () => [
        [
          { id: 'collection', name: '收藏', componentType: 'CollectionAssetsList' },
          { id: 'aigc_material', name: '素材广场', componentType: 'AssetsSquareList' },
        ],
        [{ id: '3d_makeup', name: '美妆', componentType: 'GeneralAssetsList' }],
        [{ id: '3d_filter', name: '滤镜', componentType: 'GeneralAssetsList' }],
        [{ id: 'sticker', name: '跟脸贴纸', componentType: 'GeneralAssetsList' }],
      ],
    },
    [M.navConst]: { SearchNavItemKeys: [['3d_makeup', '3d_filter', 'sticker'], ['aigc_material']] },
    [M.search]: {
      searchAsset: async (p) => {
        calls.search.push(`${p.searchWord}|${p.panelList}`);
        return { body: { statusCode: 0, data: { dataInfos: { template: titles[`${p.searchWord}|${p.panelList}`] || [] } } } };
      },
    },
    [M.category]: {
      getAssetCategory: async (p) => {
        calls.category.push(p.panelKey);
        return { body: { statusCode: 0, data: { categories: categories[p.panelKey] || [] } } };
      },
    },
    [M.list]: {
      getAssetList: async (p) => {
        const id = JSON.parse(p.categoryIds)[0];
        calls.list.push(`${id}@${p.cursor}`);
        const all = byCategory[id] || [];
        const page = all.slice(p.cursor, p.cursor + p.count);
        return { body: { statusCode: 0, data: { dataInfos: { template: page, cursor: p.cursor + page.length, hasNext: p.cursor + page.length < all.length } } } };
      },
    },
    [M.aiCategory]: { getAIAssetCategory: async () => ({ statusCode: 0, data: { categories: [{ id: 45003, name: '妆容' }] } }) },
    [M.aiList]: { getAIAssetList: async () => ({ statusCode: 0, data: [{ dataInfos: { template: [], hasNext: false } }] }) },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  lib.ensureCompatible = () => {};
  lib.squareKind = () => 'ai_image';
  return { lib, calls };
}

const ids = (out) => out.items.map((i) => i.template_id);

test('a term naming a sub-category brings in its assets after the title matches, and reports what it expanded', async () => {
  const { lib, calls } = setup();
  const out = await lib.search({ query: '腮红', count: 100 });
  // exact, then title starts with it (素材广场 is asked first), contains, category, and what the server matched loosely
  assert.deepEqual(ids(out), ['t1', 't4', 's1', 't3', 't2', 'm1', 'm2', 's2', 't5']);
  assert.deepEqual(out.items.find((i) => i.template_id === 's1').matched, [{ query: '腮红', by: 'title' }, { query: '腮红', by: 'category:跟脸贴纸/腮红' }]);
  assert.deepEqual(out.items.find((i) => i.template_id === 'm1').matched, [{ query: '腮红', by: 'category:美妆/腮红' }]);
  assert.deepEqual(out.matched_categories.map((m) => [m.panel_key, m.category]), [['3d_makeup', '腮红'], ['sticker', '腮红']]);
  assert.deepEqual(out.related_categories, [{ panel_key: 'sticker', panel: '跟脸贴纸', category_id: '22', category: '甜妹腮红' }]);
  assert.deepEqual(out.by_panel, [{ panel_key: 'sticker', name: '跟脸贴纸', count: 5 }, { panel_key: 'aigc_material', name: '素材广场', count: 2 }, { panel_key: '3d_makeup', name: '美妆', count: 2 }]);
  assert.ok(!calls.list.some((c) => c.startsWith('22@')), 'related categories are not expanded');
  assert.ok(!calls.category.includes('collection'));
});

test('a panel name brings in the whole panel once each, and a category is cut at 300', async () => {
  const { lib } = setup();
  const filters = await lib.search({ query: '滤镜' });
  assert.deepEqual(ids(filters), ['f1', 'f2', 'f3']);
  assert.ok(filters.items.every((i) => i.matched[0].by === 'panel:滤镜'));
  assert.deepEqual(filters.matched_categories, [{ query: '滤镜', panel_key: '3d_filter', panel: '滤镜', category_id: null, category: null }]);
  const { lib: lib2, calls } = setup();
  const big = await lib2.search({ query: '大图', count: 1000 });
  assert.equal(big.total, 300);
  assert.deepEqual(calls.list.filter((c) => c.startsWith('23@')), ['23@0', '23@100', '23@200']);
});

test('panel and category names combine, and a panel name narrows a title word to that panel', async () => {
  const { lib, calls } = setup();
  const retro = await lib.search({ query: '复古滤镜' });
  assert.deepEqual(ids(retro), ['f1', 'f2']);
  assert.equal(retro.items[0].matched[0].by, 'category:滤镜/复古');
  const reverse = await lib.search({ query: '滤镜复古' });
  assert.deepEqual(ids(reverse), ['f1', 'f2']);
  const korean = await lib.search({ query: '韩系滤镜' });
  assert.deepEqual(ids(korean), ['f4']);
  assert.deepEqual(korean.items[0].matched, [{ query: '韩系滤镜', by: 'title:韩系@滤镜' }]);
  assert.ok(calls.search.includes('韩系|3d_filter') && !calls.search.includes('韩系|sticker'));
});

test('queries merge several terms, ranking assets more terms hit first within a tier', async () => {
  const { lib } = setup();
  const out = await lib.search({ queries: ['欧美', '猫眼', '风格妆', '欧美'] });
  assert.deepEqual(out.queries, ['欧美', '猫眼', '风格妆']);
  // 欧美风 comes back first but only 欧美 hits it; 欧美妆 and 猫眼妆 are hit by two terms each
  assert.deepEqual(ids(out), ['m3', 'm4', 'm5']);
  assert.deepEqual(out.items[0].matched, [{ query: '欧美', by: 'title' }, { query: '风格妆', by: 'category:美妆/风格妆' }]);
  assert.equal(out.query, undefined);
});

test('paging reuses the ranked result for ten minutes, then asks again', async () => {
  const { lib, calls } = setup();
  const first = await lib.search({ query: '腮红', count: 3 });
  assert.deepEqual({ next: first.next_offset, more: first.has_more, total: first.total }, { next: 3, more: true, total: 9 });
  const asked = calls.search.length;
  const second = await lib.search({ query: '腮红', offset: 3, count: 3 });
  assert.deepEqual(ids(second), ['t3', 't2', 'm1']);
  assert.deepEqual(second.raw.map((r) => r.templateId), ['t3', 't2', 'm1']);
  assert.equal(calls.search.length, asked);
  for (const v of lib.searchCache.values()) v.at -= 10 * 60 * 1000 + 1;
  await lib.search({ query: '腮红', offset: 3, count: 3 });
  assert.ok(calls.search.length > asked);
});

test('search validates its terms and panel, stays on a panel, and hints when nothing matches', async () => {
  const { lib, calls } = setup();
  await assert.rejects(lib.search({}), /INVALID_QUERY: pass query, or 1-8 queries/);
  await assert.rejects(lib.search({ query: 'a', queries: ['b'] }), /pass query or queries, not both/);
  await assert.rejects(lib.search({ queries: Array(9).fill('a') }), /INVALID_QUERY/);
  await assert.rejects(lib.search({ queries: ['a', ' '] }), /every query must be a non-empty string/);
  await assert.rejects(lib.search({ query: 'a', panel_key: 'collection' }), /NOT_SEARCHABLE: collection; searchable panels: aigc_material, 3d_makeup, 3d_filter, sticker/);
  const one = await lib.search({ query: '腮红', panel_key: '3d_makeup' });
  assert.deepEqual(ids(one), ['m1', 'm2']);
  assert.ok(calls.search.filter((s) => s.startsWith('腮红|')).every((s) => s === '腮红|3d_makeup'));
  const none = await lib.search({ query: '尖嘴大脸' });
  assert.equal(none.total, 0);
  assert.match(none.hint, /queries/);
  assert.equal((await lib.search({ query: '腮红' })).hint, undefined);
});

test('library_search forwards queries and keeps the results for preview and apply', async () => {
  const seen = [];
  const callPlugin = async (method, params) => {
    seen.push([method, params]);
    if (method === 'library_search') return { queries: params.queries, items: [{ template_id: 'm3', title: '欧美妆', cover_url: null }], raw: [{ templateId: 'm3', title: '欧美妆' }], total: 1 };
    if (method === 'library_apply') return { applied: params.item.templateId };
    throw Error(`unexpected ${method}`);
  };
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ official, callPlugin, listInstances: () => [{ pid: 1 }] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = await client.callTool({ name: 'library_search', arguments: { project_path: '/p', queries: ['欧美', '猫眼'] } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(seen[0], ['library_search', { queries: ['欧美', '猫眼'] }]);
  const applied = await client.callTool({ name: 'library_apply', arguments: { project_path: '/p', template_id: 'm3' } });
  assert.deepEqual(JSON.parse(applied.content[0].text), { applied: 'm3' });
  const tooMany = await client.callTool({ name: 'library_search', arguments: { queries: Array(9).fill('a') } });
  assert.equal(tooMany.isError, true);
});
