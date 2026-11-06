import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { prepareIcon, ICON_SIZE } from '../src/icons.mjs';
import { sniffImage } from '../src/images.mjs';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M } = require('../editor-plugin/library.cjs');

class Bus {
  constructor() {
    this.handlers = new Map();
    this.emitted = [];
  }
  on(e, f) {
    this.handlers.set(e, [...(this.handlers.get(e) || []), f]);
  }
  off(e, f) {
    this.handlers.set(e, (this.handlers.get(e) || []).filter((x) => x !== f));
  }
  emit(e, ...args) {
    this.emitted.push(e);
    for (const f of this.handlers.get(e) || []) f(...args);
  }
}

// A fake editor with one open project and the delivery, community and music modules.
function setup({ size = 1000, maxSize = 5000, sameAsTemplate = false, effectIdOk = true, loggedIn = true, remote = 0, perfStatus, openWindow = true, mobileResponse } = {}) {
  const projectDir = tmpdir('xs-proj-');
  const instance = tmpdir('xs-inst-');
  const calls = { exportDirs: [], imported: [], exist: [], savedJson: 0, iconWindow: [], showPerf: 0, cookie: 0, uploaded: [], marked: [], applied: [], sdkMapping: 0, exportOpts: [], iconDeleted: [] };
  const business = new Bus();
  const legacy = new Bus();
  business.on('SubmitEffect', () => openWindow && legacy.emit('OnSubmitWindowOpened', 1, size));
  const project = {
    path: projectDir,
    sceneManager: { mainScene: { id: 'main' } },
    isSaved: () => true,
    isProjectChanged: () => false,
    effectExporter: {
      exportEffectPackage: async (scene, dir, opts) => {
        assert.equal(scene.id, 'main');
        assert.equal(opts.zip, true);
        calls.exportDirs.push(dir);
        calls.exportOpts.push(opts);
        const packagePath = path.join(dir, 'effect.zip');
        fs.writeFileSync(packagePath, Buffer.alloc(size));
        return { packagePath };
      },
    },
  };
  const iconMap = { 0: 'Icon/femaleIcon.png', 1: 'Icon/maleIcon.png', 2: 'Icon/commonIcon.png' };
  class IconPreviewManager {
    static getInstance() {
      return icons;
    }
    importAndCreateIcon(t, p) {
      calls.imported.push([t, p]);
      this.created.add(t);
    }
    setIconExistState(t, v) {
      calls.exist.push([t, v]);
    }
    saveIconJson() {
      calls.savedJson += 1;
    }
    isIconCreated(t) {
      return this.created.has(t);
    }
    deleteIcon(t) {
      calls.iconDeleted.push(['dirty', t]);
    }
    uploadDeleteIcon(t) {
      calls.iconDeleted.push(['delete', t]);
      fs.rmSync(path.join(projectDir, iconMap[t]), { force: true });
      this.created.delete(t);
    }
  }
  const icons = new IconPreviewManager();
  icons.created = new Set();
  const submissionApi = {
    maxEffectPackageSize: maxSize,
    checkEffectIdConsistency: () => effectIdOk,
    checkResourceConsistency: () => sameAsTemplate,
    uploadEffect: () => {
      throw Error('must never publish');
    },
  };
  const perfApi = { showWindow: () => ((calls.showPerf += 1), perfStatus !== undefined && business.emit('getPerfTestStatus', perfStatus)) };
  const marked = { done: false };
  const modules = {
    [M.ef]: {
      ProjectManager: { getInstance: () => ({ getActiveProject: () => project, hasActiveProject: () => true }) },
      Resource: { EditorFoundation: { env: { getInstancePath: () => instance } } },
      EffectExport: { ExportType: { MOBILE_PREVIEW: 'MOBILE_PREVIEW' } },
      EventManager_deprecated: { TypeGuard: () => legacy },
    },
    [M.orionui]: {
      ExtensionManager: { host: { getAPI: (key) => (key === 'submitKey' ? submissionApi : key === 'perfKey' ? perfApi : null) } },
      CookieManager: class {
        async getCookie(url) {
          return `cookie-for-${url}`;
        }
      },
    },
    [M.iconPreview]: { iconTypeToProjectIconPathMap: iconMap, IconPreviewManager },
    [M.iconWindow]: { showIconCreationWindow: (from) => calls.iconWindow.push(from) },
    [M.submission]: { EffectSubmissionAPIKey: 'submitKey' },
    [M.perfTest]: { PerfTestAPIKey: 'perfKey' },
    [M.events]: { BusinessEventManager: { TypeGuard: () => business } },
    [M.login]: { loginContribution: { getLoginStatus: async () => ({ isLoggedIn: loggedIn }) } },
    [M.remoteAssets]: {
      RemoteAssetManager: { getInstance: () => ({ getUsedRemoteAssets: () => Array(remote), getRemoveRemoteAssetsSize: () => 42 }) },
    },
    [M.mobilePreview]: {
      getCookie: async () => (calls.cookie += 1),
      requestMobilePreviewURL: async (file) => {
        assert.equal(calls.cookie, 1, 'cookie is fetched before the upload');
        calls.uploaded.push([file, fs.existsSync(file)]);
        return mobileResponse ?? { statusCode: 200, body: JSON.stringify({ code: 0, message: 'success', data: { id: 'ENC', type: 'studio', ttl: 604800 } }) };
      },
    },
    [M.urls]: { Domain: { kBackendApiURL: 'https://backend' }, DomainPath: { kActivityAPI: '/acts', kTaskListAPI: '/tasks' } },
    [M.bizUtils]: {
      PlatformUtils: { genSignData: () => 'sig' },
      UserAgentUtils: { userAgentGenerator: () => () => 'ua' },
      ExportEffectPackageUtils: { registerSDKVersionMapping: () => (calls.sdkMapping += 1) },
    },
    [M.activityTypes]: { getTypeName: (m) => (m.display_type ? 'x' : 'normal') },
    [M.inspiration]: {
      getInspirationDetail: async ({ id }) =>
        id === 'missing'
          ? { body: { code: 0, data: { base: { imgs: [] }, videos: [] } } }
          : {
              body: {
                code: 0,
                data: {
                  base: { id, title: `灵感${id}`, detailDesc: '描述', effectTypes: [{ id: 1, name: '互动' }], bonusText: '有激励', imgs: [{ urlList: ['https://img/1'] }] },
                  designer: [{ name: '作者', avatar: 'a' }],
                  award: { amount: 0 },
                  effects: [{ name: '拆快递', totalPubNum: 169 }],
                  videos: [1, 2],
                },
              },
            },
    },
    [M.inspirationBridge]: { markAgentInspirationUsed: ({ inspirationId }) => calls.marked.push(inspirationId) },
    [M.musicCategory]: {
      MusicCategoryModel: class {
        constructor() {
          this.selected = null;
        }
        async updateCategoryList() {
          return [{ codeCategory: 'ugc_recommend', name: '推荐' }];
        }
        setSelectedCategory(c) {
          this.selected = c;
        }
      },
    },
    [M.musicList]: {
      MusicListModel: class {
        constructor(cat) {
          this.cat = cat;
        }
        async getNextMusicListForDouyin() {
          return [{ id: 7, title: `${this.cat.selected.codeCategory}曲`, author: 'A', duration: 30, cover: ['https://c'], fileUrl: ['https://f'], hasCopyright: true }];
        }
        async getNextSearchMusicListForDouyin(q) {
          return [{ id: 8, title: `${q}歌`, duration: 12 }, null];
        }
      },
    },
    [M.musicSquare]: {
      MusicSquareManager: { instance: { setDouyinMusicInfo: async (item, code) => (calls.applied.push([item, code]), item.id !== 99) } },
    },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  return { lib: new Library(mod), calls, projectDir, instance, business, modules, marked };
}

const leftovers = (instance) => fs.readdirSync(instance);

test('icon_set writes the female and male slots by default and reloads the editor icon state', () => {
  const { lib, calls, projectDir } = setup();
  const png = path.join(tmpdir('xs-png-'), 'i.png');
  fs.writeFileSync(png, 'PNGDATA');
  const out = lib.iconSet({ png_path: png });
  assert.deepEqual(out.icon_paths, [path.join(projectDir, 'Icon/femaleIcon.png'), path.join(projectDir, 'Icon/maleIcon.png')]);
  for (const f of out.icon_paths) assert.equal(fs.readFileSync(f, 'utf8'), 'PNGDATA');
  assert.deepEqual(calls.imported, [[0, projectDir], [1, projectDir]]);
  assert.deepEqual(calls.exist, [[0, true], [1, true]]);
  assert.equal(calls.savedJson, 1);
  assert.deepEqual(out.project_icons, ['female', 'male']);
  assert.deepEqual(out.removed, []);
  const common = lib.iconSet({ png_path: png, types: ['common'] });
  assert.ok(fs.existsSync(path.join(projectDir, 'Icon/commonIcon.png')));
  assert.deepEqual(common.removed, ['female', 'male']);
  assert.deepEqual(common.project_icons, ['common']);
  assert.deepEqual(calls.iconDeleted, [['dirty', 0], ['delete', 0], ['dirty', 1], ['delete', 1]]);
  const back = lib.iconSet({ png_path: png });
  assert.deepEqual(back.removed, ['common']);
  assert.deepEqual(back.project_icons, ['female', 'male']);
  assert.throws(() => lib.iconSet({ png_path: png, types: ['kid'] }), /INVALID_ICON_TYPE: kid/);
  assert.throws(() => lib.iconSet({ png_path: png, types: [] }), /INVALID_ICON_TYPE/);
  assert.throws(() => lib.iconSet({ png_path: '/nope.png' }), /ICON_FILE_NOT_FOUND/);
});

test('icon_open opens the icon creation window', () => {
  const { lib, calls } = setup();
  assert.deepEqual(lib.iconOpen(), { opened: true });
  assert.deepEqual(calls.iconWindow, ['tool_bar']);
});

test('effect_check passes a clean project and removes its scratch export', async () => {
  const { lib, calls, instance, projectDir } = setup();
  fs.mkdirSync(path.join(projectDir, 'Icon'));
  fs.writeFileSync(path.join(projectDir, 'Icon/commonIcon.png'), 'x');
  const out = await lib.effectCheck();
  assert.equal(out.ok, true, JSON.stringify(out.issues));
  assert.deepEqual(out.issues, []);
  assert.equal(out.package_bytes, 1000);
  assert.equal(out.package_limit_bytes, 5000);
  assert.deepEqual(out.icons, ['common']);
  assert.ok(calls.exportDirs[0].startsWith(instance));
  assert.deepEqual(leftovers(instance), []);
});

test('effect_check reports every reason the submit flow would refuse', async () => {
  const { lib, instance } = setup({ size: 6000, maxSize: 5000, sameAsTemplate: true, effectIdOk: false, loggedIn: false });
  const out = await lib.effectCheck();
  assert.equal(out.ok, false);
  assert.deepEqual(
    out.issues.map((i) => i.split(':')[0]),
    ['PACKAGE_TOO_LARGE', 'TEMPLATE_TAMPERED', 'SAME_AS_TEMPLATE', 'NOT_LOGGED_IN', 'NO_ICON'],
  );
  assert.deepEqual(leftovers(instance), []);
});

test('effect_check measures packages with remote assets the way the submit flow does', async () => {
  const { lib } = setup({ size: 9000, maxSize: 5000, remote: 2 });
  const out = await lib.effectCheck();
  assert.equal(out.package_bytes, 42);
  assert.ok(!out.issues.some((i) => i.startsWith('PACKAGE_TOO_LARGE')));
});

test('effect_check removes the scratch folder when the export fails', async () => {
  const { lib, modules, instance } = setup();
  modules[M.ef].ProjectManager.getInstance().getActiveProject().effectExporter.exportEffectPackage = async () => ({ error: 'x' });
  await assert.rejects(lib.effectCheck(), /EXPORT_FAILED/);
  assert.deepEqual(leftovers(instance), []);
});

test('effect_check_cloud listens before opening the window and maps the status code', async () => {
  const done = setup({ perfStatus: 3 });
  assert.deepEqual(await done.lib.effectCheckCloud({ timeout_ms: 1000 }), { finished: true, status_code: 3, result: 'needs_optimization' });
  assert.equal(done.calls.showPerf, 1);
  const slow = setup();
  const out = await slow.lib.effectCheckCloud({ timeout_ms: 20 });
  assert.equal(out.finished, false);
  assert.equal(out.result, 'timeout');
});

test('submit_prepare opens the submit window through the toolbar entry only after the local checks pass', async () => {
  const bad = setup({ loggedIn: false });
  const refused = await bad.lib.submitPrepare();
  assert.equal(refused.opened, false);
  assert.ok(!bad.business.emitted.includes('SubmitEffect'));
  const good = setup();
  fs.mkdirSync(path.join(good.projectDir, 'Icon'));
  fs.writeFileSync(path.join(good.projectDir, 'Icon/commonIcon.png'), 'x');
  const out = await good.lib.submitPrepare();
  assert.equal(out.opened, true);
  assert.deepEqual(good.business.emitted, ['SubmitEffect']);
});

test('mobile_preview exports like the toolbar popup and returns the QR text it would show', async () => {
  const { lib, calls, instance } = setup();
  const out = await lib.mobilePreview();
  assert.deepEqual(out, { qr_text: JSON.stringify({ id: 'ENC', type: 'studio', ttl: 604800 }), expires_in_sec: 604800, package_bytes: 1000 });
  assert.equal(calls.sdkMapping, 1);
  assert.deepEqual(calls.exportOpts[0], { exportName: 'effect', zip: true });
  assert.equal(calls.uploaded.length, 1);
  assert.equal(calls.uploaded[0][1], true, 'package exists while uploading');
  assert.deepEqual(leftovers(instance), []);
  const moderated = setup({ mobileResponse: { statusCode: 200, body: '{"code":2706,"message":"审核未通过"}' } });
  await assert.rejects(moderated.lib.mobilePreview(), /MOBILE_PREVIEW_MODERATION_FAILED: 审核未通过/);
  assert.deepEqual(leftovers(moderated.instance), []);
  const http = setup({ mobileResponse: { statusCode: 500, body: '' } });
  await assert.rejects(http.lib.mobilePreview(), /MOBILE_PREVIEW_HTTP_500/);
});

test('effect_check exports with the submit flow options', async () => {
  const { lib, calls } = setup();
  await lib.effectCheck();
  assert.deepEqual(calls.exportOpts[0], { exportName: 'effect', zip: true, extra: { treeShakeIEJs: true, exportRemoteAssetJson: true } });
});

test('tasks_list slims tasks and prepares the launch extras only for received ones', async (t) => {
  const { lib } = setup();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push([url, opts.headers]);
    const data = url.endsWith('/acts')
      ? { activities: [] }
      : {
          effect_tasks: [
            { title: '冷空气美妆', process_status_text: '领取', designer_task_id: '', item_id: 1, task_id: 11, tags: [{ name: '特效' }], ttl: 3 * 86400000 + 5, revenue: '0' },
            { title: '已领任务', process_status_text: '去提交', designer_task_id: 'D2', item_id: 2, task_id: 22, tags: 'a,b', ttl: -1 },
          ],
        };
    return { ok: true, json: async () => ({ code: 0, data }) };
  };
  t.after(() => (globalThis.fetch = realFetch));
  const out = await lib.tasksList();
  assert.deepEqual(seen[0][1], { cookie: 'cookie-for-https://backend', 'x-api-sign-data': 'sig', 'user-agent': 'ua' });
  assert.deepEqual(out.items[0], { task_id: '11', kind: 'task', title: '冷空气美妆', status: '领取', received: false, bindable: false, tags: ['特效'], days_left: 3, revenue: '0', icon_url: null });
  assert.equal(out.items[1].received, true);
  assert.deepEqual(out.items[1].tags, ['a', 'b']);
  assert.equal(out.raw[0].extra, null);
  assert.deepEqual(out.raw[1].extra, { activity_id: 'D2', activity_name: '已领任务', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Normal' });
});

test('inspiration detail and binding go through the editor modules', async () => {
  const { lib, calls } = setup();
  const d = await lib.inspirationDetail({ id: ' 77 ' });
  assert.deepEqual(d, {
    id: '77',
    title: '灵感77',
    description: '描述',
    effect_types: ['互动'],
    bonus_text: '有激励',
    images: ['https://img/1'],
    designer: '作者',
    award: null,
    effects: [{ name: '拆快递', published: 169 }],
    videos: 2,
  });
  await assert.rejects(lib.inspirationDetail({ id: 'missing' }), /INSPIRATION_NOT_FOUND: missing/);
  lib.inspirationBind({ id: '77' });
  assert.deepEqual(calls.marked, ['77']);
  assert.throws(() => lib.inspirationBind({ id: ' ' }), /INVALID_ID/);
});

test('music lists a category or a search and applies a track with a clip range', async () => {
  const { lib, calls } = setup();
  assert.deepEqual(await lib.musicCategories(), { categories: [{ code: 'ugc_recommend', name: '推荐' }] });
  const cat = await lib.musicList({ category_code: 'ugc_recommend' });
  assert.deepEqual(cat.items[0], { music_id: '7', title: 'ugc_recommend曲', author: 'A', duration_sec: 30, cover_url: 'https://c', preview_url: 'https://f', has_copyright: true });
  const found = await lib.musicList({ query: ' 晴天 ' });
  assert.equal(found.query, '晴天');
  assert.deepEqual(found.items.map((m) => m.music_id), ['8']);
  await assert.rejects(lib.musicList({}), /INVALID_CATEGORY/);
  const out = await lib.musicApply({ item: cat.raw[0], category_code: 'ugc_recommend' });
  assert.deepEqual(out, { music_id: '7', title: 'ugc_recommend曲', start_sec: 0, end_sec: 30 });
  assert.deepEqual([calls.applied[0][0].startTime, calls.applied[0][0].endTime, calls.applied[0][1]], [0, 30, 'ugc_recommend']);
  await lib.musicApply({ item: cat.raw[0], start_sec: 5, end_sec: 15 });
  assert.deepEqual([calls.applied[1][0].startTime, calls.applied[1][0].endTime], [5, 15]);
  await assert.rejects(lib.musicApply({ item: cat.raw[0], start_sec: 20, end_sec: 10 }), /INVALID_RANGE/);
  await assert.rejects(lib.musicApply({ item: { id: 99, duration: 3 } }), /MUSIC_APPLY_FAILED/);
});

test('prepareIcon centre-crops to a square, scales to the icon size and cleans up on failure', async (t) => {
  const src = path.join(tmpdir('xs-src-'), 'a.jpg');
  fs.writeFileSync(src, 'x');
  const runs = [];
  const exec = async (cmd, args) => {
    runs.push(args);
    if (args[0] === '-g') return { stdout: 'pixelWidth: 444\n  pixelHeight: 354\n' };
    fs.writeFileSync(args.at(-1), Buffer.from('89504e470d0a1a0a00', 'hex'));
    return { stdout: '' };
  };
  const { png, dir } = await prepareIcon(src, { exec });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(runs[1].slice(0, 6), ['-s', 'format', 'png', '--cropToHeightWidth', '354', '354']);
  assert.deepEqual(runs[2].slice(0, 3), ['-z', String(ICON_SIZE), String(ICON_SIZE)]);
  assert.equal(sniffImage(fs.readFileSync(png)), 'image/png');
  await assert.rejects(prepareIcon('relative.png', { exec }), /IMAGE_NOT_FOUND/);
  await assert.rejects(prepareIcon(src, { exec: async () => ({ stdout: '' }) }), /NOT_AN_IMAGE/);
  let failedDir;
  const bad = async (cmd, args) => {
    if (args[0] === '-g') return { stdout: 'pixelWidth: 10 pixelHeight: 10' };
    failedDir = path.dirname(args.at(-1));
    fs.writeFileSync(args.at(-1), 'not png');
    return { stdout: '' };
  };
  await assert.rejects(prepareIcon(src, { exec: bad }), /ICON_CONVERT_FAILED/);
  assert.equal(fs.existsSync(failedDir), false);
});

async function connect(deps) {
  const official = {
    url: 'x',
    listTools: async () => [],
    status: () => ({}),
    callJson: async (name) => (name === 'list_instances' ? { instances: [] } : {}),
  };
  const server = createServer({ official, sleep: async () => {}, openTimeoutMs: 50, closeTimeoutMs: 50, instanceTimeoutMs: 0, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const json = (res) => JSON.parse(res.content[0].text);

test('icon_set prepares the image, hands the PNG to the plugin and always removes it', async () => {
  const seen = [];
  let dir;
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    prepareIcon: async () => {
      dir = tmpdir('xs-prep-');
      fs.writeFileSync(path.join(dir, 'icon.png'), 'p');
      return { png: path.join(dir, 'icon.png'), dir };
    },
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (params.types[0] === 'male') throw Error('boom');
      return { ok: true };
    },
  });
  await client.callTool({ name: 'icon_set', arguments: { project_path: '/p', image_path: '/img.jpg' } });
  assert.deepEqual(seen[0], { method: 'icon_set', params: { png_path: path.join(dir, 'icon.png'), types: ['female', 'male'] }, opts: { projectPath: '/p' } });
  assert.equal(fs.existsSync(dir), false);
  const failed = await client.callTool({ name: 'icon_set', arguments: { project_path: '/p', image_path: '/img.jpg', type: 'male' } });
  assert.equal(failed.isError, true);
  assert.equal(fs.existsSync(dir), false);
});

test('effect_check runs the cloud check only when asked, with a longer RPC timeout', async () => {
  const seen = [];
  const client = await connect({ callPlugin: async (method, params, opts) => (seen.push([method, params, opts.timeoutMs]), { ok: true, method }) });
  assert.deepEqual(json(await client.callTool({ name: 'effect_check', arguments: {} })), { ok: true, method: 'effect_check' });
  assert.equal(seen.length, 1);
  const both = json(await client.callTool({ name: 'effect_check', arguments: { cloud: true, timeout_ms: 60000 } }));
  assert.equal(both.cloud.method, 'effect_check_cloud');
  assert.deepEqual(seen[2], ['effect_check_cloud', { timeout_ms: 60000 }, 90000]);
});

test('mobile_preview returns the QR image of the text the editor would encode', async () => {
  const qr = [];
  const client = await connect({
    callPlugin: async () => ({ qr_text: '{"id":"ENC"}', expires_in_sec: 604800, package_bytes: 5 }),
    qrPng: async (t) => (qr.push(t), Buffer.from('89504e470d0a1a0a00', 'hex')),
  });
  const res = await client.callTool({ name: 'mobile_preview', arguments: {} });
  assert.equal(json(res).expires_in_sec, 604800);
  assert.equal(res.content[1].type, 'image');
  assert.equal(res.content[1].mimeType, 'image/png');
  assert.deepEqual(qr, ['{"id":"ENC"}']);
});

test('the real QR helper renders a PNG', async () => {
  const client = await connect({ callPlugin: async () => ({ qr_text: '{"id":"ENC","type":"studio","ttl":604800}', expires_in_sec: 604800, package_bytes: 5 }) });
  const res = await client.callTool({ name: 'mobile_preview', arguments: {} });
  assert.equal(sniffImage(Buffer.from(res.content[1].data, 'base64')), 'image/png');
});

test('task_bind needs a received task from tasks_list and reopens the project with its activity', async () => {
  const proj = tmpdir('xs-bind-');
  fs.writeFileSync(path.join(proj, 'effect.dyehpj'), '{}');
  const windows = new Map([[7, proj]]);
  const seen = [];
  const client = await connect({
    listInstances: () => [...windows.keys()].map((pid) => ({ pid })),
    callPlugin: async (method, params, opts) => {
      seen.push([method, params, opts]);
      if (method === 'status') return { projectPath: windows.get(opts.pid) };
      if (method === 'project_state') return { scene_ready: true };
      if (method === 'tasks_list') {
        return {
          items: [
            { task_id: '11', bindable: false },
            { task_id: '22', bindable: true, title: '已领任务' },
          ],
          raw: [{ extra: null }, { extra: { activity_id: 'D2', activity_name: '已领任务', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Normal' } }],
        };
      }
      if (method === 'project_close') {
        windows.delete(opts.pid);
        return { closing: true, project_path: proj, discarded_changes: false };
      }
      if (method === 'project_launch') {
        windows.set(8, params.path);
        return {};
      }
      throw Error(`unexpected ${method}`);
    },
  });
  const unknown = await client.callTool({ name: 'task_bind', arguments: { path: proj, task_id: '22' } });
  assert.match(unknown.content[0].text, /UNKNOWN_TASK: 22/);
  const list = json(await client.callTool({ name: 'tasks_list', arguments: {} }));
  assert.equal(list.raw, undefined);
  const notReceived = await client.callTool({ name: 'task_bind', arguments: { path: proj, task_id: '11' } });
  assert.match(notReceived.content[0].text, /TASK_NOT_RECEIVED: 11/);
  windows.set(9, '/other');
  const res = json(await client.callTool({ name: 'task_bind', arguments: { path: proj, task_id: '22' } }));
  assert.equal(res.pid, 8);
  const order = seen.map((s) => s[0]).filter((m) => m === 'project_close' || m === 'project_launch');
  assert.deepEqual(order, ['project_close', 'project_launch']);
  const launch = seen.find((s) => s[0] === 'project_launch');
  assert.deepEqual(launch[1], { operation: 'openLocal', path: proj, activity: { activity_id: 'D2', activity_name: '已领任务', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Normal' } });
});

test('music_list takes exactly one of query and category, and music_apply sends the raw track with its category', async () => {
  const seen = [];
  const client = await connect({
    callPlugin: async (method, params) => {
      seen.push([method, params]);
      if (method === 'music_list') return { category_code: params.category_code, items: [{ music_id: '7', title: 't' }], raw: [{ id: 7, duration: 30 }] };
      return { ok: true };
    },
  });
  const both = await client.callTool({ name: 'music_list', arguments: { query: 'a', category_code: 'b' } });
  assert.match(both.content[0].text, /exactly one of query or category_code/);
  const none = await client.callTool({ name: 'music_list', arguments: {} });
  assert.equal(none.isError, true);
  const unseen = await client.callTool({ name: 'music_apply', arguments: { music_id: '7' } });
  assert.match(unseen.content[0].text, /UNKNOWN_MUSIC: 7/);
  const list = json(await client.callTool({ name: 'music_list', arguments: { category_code: 'ugc_recommend' } }));
  assert.equal(list.raw, undefined);
  await client.callTool({ name: 'music_apply', arguments: { music_id: '7', start_sec: 2 } });
  assert.deepEqual(seen.at(-1), ['music_apply', { item: { id: 7, duration: 30 }, category_code: 'ugc_recommend', start_sec: 2 }]);
});
