import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { checkTarget, copyProject, outlineProject } from '../src/works.mjs';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-state-'));
const { Library, M, WORK_SORTS } = require('../editor-plugin/library.cjs');

function work(id, title, { effectId = 90686370, file = true } = {}) {
  return {
    templateId: id,
    title,
    desc: '',
    effectId,
    businessExtra: file ? { fileMap: { f: { url: `https://cdn/${id}.zip`, md5: 'x', fileSize: 10 } } } : { fileMap: {} },
  };
}

// A fake editor with the homepage template modules; transformTemplate mimics the editor's field names.
function setup({ download = { status: 'success', localPath: '/cache/1.zip', unzipPath: '/tmp/CreatedFromTemplate/g/未命名' } } = {}) {
  const calls = { list: [], search: [], download: [], destroyed: 0 };
  const modules = {
    [M.worksPanel]: {
      apiTemplatesPanel: async () => ({ body: { statusCode: 0, data: { categories: [{ id: 44668, name: '推荐' }, { id: 40669, name: '官方工程' }] } } }),
    },
    [M.worksCategory]: {
      apiTemplatesCategory: async (p) => {
        calls.list.push(p);
        return { body: { statusCode: 0, data: { dataInfos: { template: [work('1', 'AI 修仙合掌转场'), work('2', '人鱼公主', { effectId: '' })], cursor: 2, hasNext: true } } } };
      },
      apiSearchTemplatesCategory: async (p) => {
        calls.search.push(p);
        return { body: { statusCode: 0, data: { dataInfos: { template: [work('3', '合掌祈福时刻', { file: false })], cursor: 1, hasNext: false } } } };
      },
    },
    [M.worksUtil]: {
      transformTemplate: (t) => ({
        description: '',
        tags: ['头饰'],
        creatorName: '',
        effectId: t.effectId,
        ugcExtraInfoObj: t.effectId ? { effect_id: t.effectId, publish_count: 2806 } : {},
        bindMaterialUseCnt: 2806,
        fileSize: 10,
        coverPath: `https://cdn/${t.templateId}.png`,
        gifPath: `https://cdn/${t.templateId}.gif`,
        tutorial: '',
      }),
    },
    [M.worksDownload]: {
      DownloadTemplateModel: class {
        async startDownload(item) {
          calls.download.push(item);
          return download;
        }
        destroy() {
          calls.destroyed += 1;
        }
      },
    },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  return { lib: new Library(mod), calls, modules };
}

test('works_nav lists homepage categories and sorts', async () => {
  const { lib } = setup();
  assert.deepEqual(await lib.worksNav(), {
    categories: [
      { id: '44668', name: '推荐' },
      { id: '40669', name: '官方工程' },
    ],
    sorts: ['suggest', 'latest', 'effect_usage', 'project_usage'],
  });
});

test('works_list defaults to the first category, maps sort to the ranker and slims items', async () => {
  const { lib, calls } = setup();
  const out = await lib.worksList({});
  assert.equal(calls.list[0].categoryId, '44668');
  assert.equal(calls.list[0].panelKey, 'tool_template');
  assert.equal(calls.list[0].ranker, 1);
  assert.deepEqual(out.items[0], {
    template_id: '1',
    title: 'AI 修仙合掌转场',
    description: '',
    tags: ['头饰'],
    creator: null,
    effect_id: '90686370',
    publish_count: 2806,
    use_count: 2806,
    file_size: 10,
    cover_url: 'https://cdn/1.png',
    gif_url: 'https://cdn/1.gif',
    tutorial: null,
  });
  assert.equal(out.items[1].effect_id, null);
  assert.equal(out.items[1].publish_count, null);
  assert.equal(out.next_cursor, 2);
  assert.equal(out.has_more, true);
  await lib.worksList({ category_id: '40669', sort: 'latest', cursor: 2, count: 5 });
  assert.deepEqual(
    { c: calls.list[1].categoryId, r: calls.list[1].ranker, cur: calls.list[1].cursor, n: calls.list[1].count },
    { c: '40669', r: 2, cur: 2, n: 5 },
  );
  await assert.rejects(lib.worksList({ category_id: '9' }), /INVALID_CATEGORY_ID: 9; valid: 44668\(推荐\), 40669\(官方工程\)/);
  await assert.rejects(lib.worksList({ sort: 'hot' }), /INVALID_SORT: hot/);
});

test('works_search sends the homepage search word within a category', async () => {
  const { lib, calls } = setup();
  const out = await lib.worksSearch({ query: ' 合掌 ' });
  assert.equal(out.query, '合掌');
  assert.equal(calls.search[0].searchWord, '合掌');
  assert.equal(calls.search[0].categoryId, '44668');
  assert.deepEqual(out.items.map((i) => i.template_id), ['3']);
  await assert.rejects(lib.worksSearch({ query: '  ' }), /INVALID_QUERY/);
});

test('works_download needs a listed work and passes the editor the fields its unzip step writes', async () => {
  const { lib, calls } = setup();
  await assert.rejects(lib.worksDownload({ template_id: '1' }), /UNKNOWN_WORK: 1/);
  await lib.worksList({});
  const out = await lib.worksDownload({ template_id: '1' });
  assert.deepEqual(out, { template_id: '1', title: 'AI 修仙合掌转场', project_path: '/tmp/CreatedFromTemplate/g/未命名', package_path: '/cache/1.zip' });
  const sent = calls.download[0];
  assert.equal(sent.templateId, '1');
  assert.equal(sent.templateID, '1');
  assert.equal(sent.name, 'AI 修仙合掌转场');
  assert.ok(sent.businessExtra.fileMap.f.url);
  assert.equal(calls.destroyed, 1);
  await lib.worksSearch({ query: '合掌' });
  await assert.rejects(lib.worksDownload({ template_id: '3' }), /NO_PACKAGE_FILE: work 3/);
  assert.equal(calls.download.length, 1);
});

test('works_download surfaces the editor download failure stage', async () => {
  const { lib, calls } = setup({ download: { status: 'fail', localPath: '', unzipPath: '', errorInfo: 'unzip' } });
  await lib.worksList({});
  await assert.rejects(lib.worksDownload({ template_id: '1' }), /WORK_DOWNLOAD_FAILED: work 1 status=fail stage=unzip/);
  assert.equal(calls.destroyed, 1);
});

test('works calls refuse when the homepage modules are missing', async () => {
  const { lib, modules } = setup();
  delete modules[M.worksCategory].apiSearchTemplatesCategory;
  const check = lib.selfCheck('works');
  assert.deepEqual(check.missing, [`${M.worksCategory} :: apiSearchTemplatesCategory`]);
  await assert.rejects(lib.worksNav(), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.worksList({}), /INCOMPATIBLE_EDITOR/);
});

test('works_covers returns cover and gif urls for listed works', async () => {
  const { lib } = setup();
  assert.throws(() => lib.worksCovers({ template_ids: ['1'] }), /UNKNOWN_WORK/);
  await lib.worksList({});
  assert.deepEqual(lib.worksCovers({ template_ids: ['1'] }), [{ template_id: '1', title: 'AI 修仙合掌转场', cover_url: 'https://cdn/1.png', gif_url: 'https://cdn/1.gif' }]);
  assert.throws(() => lib.worksCovers({ template_ids: Array(9).fill('1') }), /INVALID_TEMPLATE_IDS/);
});

function fakeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-work-'));
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put('effect.dyehpj', '{"name":"未命名"}');
  put('Assets/main.scene', 'scene');
  put('Graph/ScriptTemplate/OnStart/CGOnStart.js', 'js');
  put('Library/CacheData', 'cache');
  put('Assets/Library/keep.txt', 'not the cache');
  return root;
}

test('outline lists project files without the Library cache', () => {
  const root = fakeProject();
  const o = outlineProject(root);
  assert.deepEqual(
    o.files.map((f) => f.path),
    ['Assets/Library/keep.txt', 'Assets/main.scene', 'effect.dyehpj', 'Graph/ScriptTemplate/OnStart/CGOnStart.js'].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(o.file_count, 4);
  assert.deepEqual(o.by_extension, { '.txt': 1, '.scene': 1, '.dyehpj': 1, '.js': 1 });
  assert.equal(o.files_truncated, false);
});

test('copyProject copies into an empty target only, skipping the Library cache', () => {
  const root = fakeProject();
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xs-dest-')), '参考');
  assert.equal(copyProject(root, dest), dest);
  assert.ok(fs.existsSync(path.join(dest, 'Graph/ScriptTemplate/OnStart/CGOnStart.js')));
  assert.ok(fs.existsSync(path.join(dest, 'Assets/Library/keep.txt')));
  assert.equal(fs.existsSync(path.join(dest, 'Library')), false);
  assert.throws(() => copyProject(root, dest), /TARGET_NOT_EMPTY/);
  assert.throws(() => checkTarget('relative/dir'), /INVALID_PATH/);
});

async function connect(deps) {
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ official, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('works tools use the lowest-pid window when no target is given', async () => {
  const seen = [];
  const client = await connect({
    listInstances: () => [{ pid: 300 }, { pid: 200 }],
    callPlugin: async (method, params, opts) => (seen.push({ method, params, opts }), { ok: true }),
  });
  await client.callTool({ name: 'works_list', arguments: { sort: 'latest' } });
  assert.deepEqual(seen[0], { method: 'works_list', params: { sort: 'latest' }, opts: { pid: 200 } });
  await client.callTool({ name: 'works_nav', arguments: { project_path: '/proj/X' } });
  assert.deepEqual(seen[1].opts, { projectPath: '/proj/X' });
  const bad = await client.callTool({ name: 'works_list', arguments: { sort: 'hot' } });
  assert.equal(bad.isError, true);
  const none = await (await connect({ listInstances: () => [], callPlugin: async () => ({}) })).callTool({ name: 'works_nav', arguments: {} });
  assert.match(none.content[0].text, /NO_EDITOR_WINDOW/);
});

test('server sort enum matches the plugin ranker table', async () => {
  const client = await connect({ listInstances: () => [], callPlugin: async () => ({}) });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.find((t) => t.name === 'works_list').inputSchema.properties.sort.enum, Object.keys(WORK_SORTS));
});

test('works_download copies to dest and returns an outline of the copy', async () => {
  const root = fakeProject();
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xs-dest-')), 'ref');
  const seen = [];
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      return { template_id: '1', title: 'AI 修仙合掌转场', project_path: root, package_path: '/cache/1.zip' };
    },
  });
  const res = JSON.parse((await client.callTool({ name: 'works_download', arguments: { template_id: '1', dest } })).content[0].text);
  assert.deepEqual(seen[0], { method: 'works_download', params: { template_id: '1' }, opts: { pid: 7, timeoutMs: 600000 } });
  assert.equal(res.project_path, dest);
  assert.equal(res.editor_copy, root);
  assert.equal(res.outline.file_count, 4);
  const again = await client.callTool({ name: 'works_download', arguments: { template_id: '1', dest } });
  assert.match(again.content[0].text, /TARGET_NOT_EMPTY/);
  assert.equal(seen.length, 1);
});

test('works_preview shows the gif only when asked', async () => {
  const fetched = [];
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    callPlugin: async () => [{ template_id: '1', title: 'A', cover_url: 'https://c/1.png', gif_url: 'https://c/1.gif' }],
    fetchImage: async (url) => (fetched.push(url), { data: 'AAAA', mimeType: 'image/png' }),
  });
  await client.callTool({ name: 'works_preview', arguments: { template_ids: ['1'] } });
  await client.callTool({ name: 'works_preview', arguments: { template_ids: ['1'], animated: true } });
  assert.deepEqual(fetched, ['https://c/1.png', 'https://c/1.gif']);
});
