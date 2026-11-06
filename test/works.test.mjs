import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { DOWNLOAD_TTL_MS, Downloads, checkTarget, copyProject, editorRoot, outlineProject } from '../src/works.mjs';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
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

// A fake editor with the homepage template modules; transformTemplate mimics the editor's field names,
// and the download model writes its zip (and partial .tmp) into a cache folder like the real one.
function setup({ download = { status: 'success', unzipPath: '/tmp/CreatedFromTemplate/g/未命名' }, cached = false } = {}) {
  const calls = { list: [], search: [], download: [], destroyed: 0 };
  const cache = tmpdir('xs-cache-');
  const zipOf = (id) => path.join(cache, `${id}.zip`);
  if (cached) fs.writeFileSync(zipOf('1'), 'users own cached zip');
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
        getTemplateProjectPath(id) {
          return zipOf(id);
        }
        async startDownload(item) {
          calls.download.push(item);
          fs.writeFileSync(zipOf(item.templateId), 'zip');
          fs.writeFileSync(path.join(cache, `${item.templateId}.tmp`), 'partial');
          return { ...download, localPath: zipOf(item.templateId) };
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
  return { lib: new Library(mod), calls, modules, cache };
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
  const { lib, calls, cache } = setup();
  await assert.rejects(lib.worksDownload({ template_id: '1' }), /UNKNOWN_WORK: 1/);
  await lib.worksList({});
  const out = await lib.worksDownload({ template_id: '1' });
  assert.deepEqual(out, { template_id: '1', title: 'AI 修仙合掌转场', project_path: '/tmp/CreatedFromTemplate/g/未命名', package_cached: false });
  assert.deepEqual(fs.readdirSync(cache), []);
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

test('works_download surfaces the editor download failure stage and leaves no zip behind', async () => {
  const { lib, calls, cache } = setup({ download: { status: 'fail', unzipPath: '', errorInfo: 'unzip' } });
  await lib.worksList({});
  await assert.rejects(lib.worksDownload({ template_id: '1' }), /WORK_DOWNLOAD_FAILED: work 1 status=fail stage=unzip/);
  assert.equal(calls.destroyed, 1);
  assert.deepEqual(fs.readdirSync(cache), []);
});

test('works_download keeps a zip the user already had cached', async () => {
  const { lib, cache } = setup({ cached: true });
  await lib.worksList({});
  assert.equal((await lib.worksDownload({ template_id: '1' })).package_cached, true);
  assert.ok(fs.existsSync(path.join(cache, '1.zip')));
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
  const root = tmpdir('xs-work-');
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
  const dest = path.join(tmpdir('xs-dest-'), '参考');
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

// An editor unzip in the real layout: <tmp>/CreatedFromTemplate/<guid>/<name>.
function editorDownload() {
  const guid = path.join(tmpdir('xs-inst-'), 'CreatedFromTemplate', 'g1');
  fs.mkdirSync(guid, { recursive: true });
  const project = path.join(guid, '未命名');
  fs.cpSync(fakeProject(), project, { recursive: true });
  return { guid, project };
}

// A plugin window (pid 7) that serves works_download and can be told which project it shows.
function worksWorld({ open = null } = {}) {
  const dl = editorDownload();
  const seen = [];
  const state = { open };
  const deps = {
    downloads: new Downloads({ stateDir: tmpdir('xs-reg-') }),
    sleep: async () => {},
    openTimeoutMs: 50,
    instanceTimeoutMs: 0,
    listInstances: () => [{ pid: 7 }, ...(state.open ? [{ pid: 8 }] : [])],
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (method === 'status') return { projectPath: opts.pid === 8 ? state.open : null };
      if (method === 'project_state') return { scene_ready: true };
      if (method === 'project_launch') {
        if (state.launch) state.open = state.launch(params);
        return {};
      }
      if (method === 'works_download') return { template_id: '1', title: 'AI 修仙合掌转场', project_path: dl.project, package_cached: false };
      throw Error(`unexpected ${method}`);
    },
  };
  return { dl, seen, state, deps };
}

test('editorRoot claims the guid folder only in the editor layout', () => {
  assert.equal(editorRoot('/x/CreatedFromTemplate/g1/未命名'), '/x/CreatedFromTemplate/g1');
  assert.equal(editorRoot('/x/elsewhere/g1/未命名'), '/x/elsewhere/g1/未命名');
});

test('the download registry deletes recorded downloads only, keeping open ones and honouring age', () => {
  let now = 1000;
  const reg = new Downloads({ stateDir: tmpdir('xs-reg-'), now: () => now });
  const a = tmpdir('xs-a-');
  const b = tmpdir('xs-b-');
  const c = tmpdir('xs-c-');
  reg.record({ path: a, template_id: '1' });
  now = 5000;
  reg.record({ path: b, template_id: '2' });
  reg.record({ path: c, template_id: '3' });
  assert.throws(() => reg.cleanup({ paths: [tmpdir('xs-other-')] }), /NOT_A_DOWNLOAD/);
  assert.deepEqual(reg.cleanup({ olderThanMs: 3000 }), { deleted: [a], kept_open: [], already_gone: [] });
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), true);
  fs.mkdirSync(path.join(b, 'proj'));
  assert.deepEqual(reg.cleanup({ paths: [path.join(b, 'proj')] }), { deleted: [b], kept_open: [], already_gone: [] });
  fs.rmSync(c, { recursive: true });
  const d = tmpdir('xs-d-');
  reg.record({ path: d, template_id: '4' });
  assert.deepEqual(reg.cleanup({ openPaths: [path.join(d, 'x')] }), { deleted: [], kept_open: [d], already_gone: [c] });
  assert.deepEqual(reg.list().map((e) => e.path), [d]);
  assert.deepEqual(reg.cleanup({}), { deleted: [d], kept_open: [], already_gone: [] });
  assert.deepEqual(reg.list(), []);
});

test('works_download with dest moves the work there and deletes the editor copy at once', async () => {
  const { dl, seen, deps } = worksWorld();
  const dest = path.join(tmpdir('xs-dest-'), 'ref');
  const client = await connect(deps);
  const res = JSON.parse((await client.callTool({ name: 'works_download', arguments: { template_id: '1', dest } })).content[0].text);
  assert.deepEqual(seen.find((s) => s.method === 'works_download'), { method: 'works_download', params: { template_id: '1' }, opts: { pid: 7, timeoutMs: 600000 } });
  assert.equal(res.project_path, dest);
  assert.equal(res.outline.file_count, 4);
  assert.ok(res.expires_at);
  assert.equal(fs.existsSync(dl.guid), false);
  assert.deepEqual(deps.downloads.list().map((e) => e.path), [dest]);
  const again = await client.callTool({ name: 'works_download', arguments: { template_id: '1', dest } });
  assert.match(again.content[0].text, /TARGET_NOT_EMPTY/);
  assert.equal(seen.filter((s) => s.method === 'works_download').length, 1);
});

test('works_download without dest records the editor guid folder and works_cleanup removes it', async () => {
  const { dl, deps } = worksWorld();
  const client = await connect(deps);
  const res = JSON.parse((await client.callTool({ name: 'works_download', arguments: { template_id: '1' } })).content[0].text);
  assert.equal(res.project_path, dl.project);
  assert.deepEqual(deps.downloads.list().map((e) => e.path), [dl.guid]);
  const bad = await client.callTool({ name: 'works_cleanup', arguments: { paths: [tmpdir('xs-other-')] } });
  assert.match(bad.content[0].text, /NOT_A_DOWNLOAD/);
  const out = JSON.parse((await client.callTool({ name: 'works_cleanup', arguments: { paths: [res.project_path] } })).content[0].text);
  assert.deepEqual(out, { deleted: [dl.guid], kept_open: [], already_gone: [], remaining: [] });
  assert.equal(fs.existsSync(dl.guid), false);
});

test('works downloads past their lifetime are swept by the next download', async () => {
  const { deps } = worksWorld();
  const old = tmpdir('xs-old-');
  const reg = new Downloads({ stateDir: path.dirname(deps.downloads.file), now: () => Date.now() - DOWNLOAD_TTL_MS - 1 });
  reg.record({ path: old, template_id: '0' });
  const client = await connect(deps);
  await client.callTool({ name: 'works_download', arguments: { template_id: '1' } });
  assert.equal(fs.existsSync(old), false);
  assert.equal(deps.downloads.list().length, 1);
});

test('works_open opens the download as a template and keeps it while the window is open', async () => {
  const { dl, seen, state, deps } = worksWorld();
  state.launch = (p) => p.path;
  const client = await connect(deps);
  const res = JSON.parse((await client.callTool({ name: 'works_open', arguments: { template_id: '1' } })).content[0].text);
  assert.deepEqual(seen.find((s) => s.method === 'project_launch').params, { operation: 'openTemplate', path: dl.project, template_id: '1' });
  assert.equal(res.pid, 8);
  assert.equal(res.project_path, dl.project);
  const kept = JSON.parse((await client.callTool({ name: 'works_cleanup', arguments: {} })).content[0].text);
  assert.deepEqual(kept.kept_open, [dl.guid]);
  assert.ok(fs.existsSync(dl.project));
  state.open = null;
  const gone = JSON.parse((await client.callTool({ name: 'works_cleanup', arguments: {} })).content[0].text);
  assert.deepEqual(gone.deleted, [dl.guid]);
});

test('works_open deletes the download when the window never opens', async () => {
  const { dl, deps } = worksWorld();
  const client = await connect(deps);
  const res = await client.callTool({ name: 'works_open', arguments: { template_id: '1' } });
  assert.match(res.content[0].text, /OPEN_TIMEOUT/);
  assert.equal(fs.existsSync(dl.guid), false);
  assert.deepEqual(deps.downloads.list(), []);
});

// A connected official MCP keeps an HTTP request open; this stand-in never answers, which holds the
// server's event loop the same way.
test('the stdio server exits when its client closes stdin, even with an official request open', async (t) => {
  const pending = [];
  const official = http.createServer((req, res) => pending.push(res));
  await new Promise((r) => official.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const res of pending) res.destroy();
    official.close();
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, XIANGSU_MCP_URL: `http://127.0.0.1:${official.address().port}/mcp` },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  while (!pending.length) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 5000))]);
  if (code === 'still running') child.kill();
  assert.equal(code, 0);
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
