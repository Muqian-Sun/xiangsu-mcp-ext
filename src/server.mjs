#!/usr/bin/env node
// stdio MCP server: everything 像塑's official MCP offers (proxied unchanged), plus editor features the
// official server cannot reach, served by the XiangsuMcpExt editor plugin.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import QRCode from 'qrcode';
import { z } from 'zod';
import { callPlugin, listInstances } from './bridge.mjs';
import { OfficialMcp } from './official.mjs';
import { fetchImage, readImageFile } from './images.mjs';
import { Projects, openWithApp } from './projects.mjs';
import { prepareIcon } from './icons.mjs';
import { formatObjects, formatTree, pickInspect, resolveRefs } from './inspect.mjs';
import { loadScene } from './scenefile.mjs';
import { cropImage, framesDir } from './frames.mjs';
import { DOWNLOAD_TTL_MS, Downloads, checkTarget, copyProject, editorRoot, outlineProject } from './works.mjs';

const VERSION = '0.5.0';

const target = {
  project_path: z.string().optional().describe('目标工程的绝对路径。与 instance_id 二选一；只开了一个工程窗口时都可省略。'),
  instance_id: z.string().optional().describe('官方 list_instances 返回的 instance_id，与 project_path 二选一。'),
};

const saveTo = z.string().min(1).optional().describe('另存到这个目录（绝对路径，不存在会创建），长期保留。');
// Picked, not measured: four videos covers 正脸、摇头、点头、双人; 24 full-size frames (about 75 KB
// each, measured) keep one answer at about 1.8 MB of images.
const MAX_FRAME_VIDEOS = 4;
const MAX_FRAMES = 24;

function saveDir(dir) {
  if (!path.isAbsolute(dir)) throw Error(`SAVE_TO_NOT_ABSOLUTE: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const unreadableNote = (scene) =>
  scene.unreadable.length ? `注意：${scene.unreadable.length} 个资源描述文件（.extra）读不了，其中的资源只给原始路径：\n${scene.unreadable.join('\n')}` : null;

function saveFile(dir, name, body) {
  const file = path.join(saveDir(dir), name);
  fs.writeFileSync(file, body);
  return file;
}

class Seen {
  constructor(code, source, key = 'template_id') {
    this.code = code;
    this.source = source;
    this.key = key;
    this.map = new Map();
  }

  keep({ raw, ...page }, extra = {}) {
    page.items.forEach((slim, i) => this.map.set(String(slim[this.key]), { slim, raw: raw[i], ...extra }));
    return page;
  }

  get(id) {
    const hit = this.map.get(String(id));
    if (!hit) throw Error(`${this.code}: ${id}; call ${this.source} first`);
    return hit;
  }
}

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (error) => ({ content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true });

async function imageContent(d, { url, file }) {
  try {
    return { type: 'image', ...(url ? await d.fetchImage(url) : await d.readImageFile(file)) };
  } catch (e) {
    return { type: 'text', text: `图片读取失败：${e.message}` };
  }
}

export function createServer(deps = {}) {
  const d = {
    callPlugin,
    listInstances,
    fetchImage,
    readImageFile,
    openWithApp,
    prepareIcon,
    cropImage,
    framesDir,
    qrPng: (text) => QRCode.toBuffer(text, { width: 360, margin: 2 }),
    sleep,
    openTimeoutMs: 90000,
    closeTimeoutMs: 30000,
    instanceTimeoutMs: 30000,
    saveTimeoutMs: 15000,
    ...deps,
  };
  const server = new Server({ name: 'xiangsu-mcp-ext', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
  d.official = d.official ?? new OfficialMcp();
  d.official.onToolsChanged = () => server.sendToolListChanged().catch(() => {});
  const projects = new Projects(d);
  d.downloads = d.downloads ?? new Downloads();
  // Library assets and homepage works seen in this session, kept here rather than in a window:
  // windows open and close while an agent works, and a later apply or download may be served by a
  // different one. The plugin returns raw records next to the slim items; clients only see the slim ones.
  const seenLib = new Seen('UNKNOWN_TEMPLATE', 'library_list or library_search');
  const seenWorks = new Seen('UNKNOWN_WORK', 'works_list, works_search or works_by_effect');
  const seenTasks = new Seen('UNKNOWN_TASK', 'tasks_list', 'task_id');
  const seenMusic = new Seen('UNKNOWN_MUSIC', 'music_list', 'music_id');

  // Forwards to the plugin window showing the target project.
  const plugin = (method, timeoutMs) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
    return text(await d.callPlugin(method, params, { projectPath, timeoutMs }));
  };

  // Official tools take the official instance_id; ours also accept the project path, and either can be
  // left out while only one editor window is open.
  const officialInstance = async ({ project_path, instance_id }) => {
    if (instance_id !== undefined) return String(instance_id);
    const list = await projects.officialInstances();
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch (_) {
        return path.resolve(p);
      }
    };
    const hits = project_path ? list.filter((i) => i.project_path && real(i.project_path) === real(project_path)) : list;
    if (hits.length === 1) return String(hits[0].instance_id);
    throw Error(project_path ? `NO_UNIQUE_INSTANCE for ${project_path}: ${hits.length} matches` : `AMBIGUOUS_INSTANCE: ${list.length} editor windows; pass project_path or instance_id`);
  };
  const library = (method) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
    return text(seenLib.keep(await d.callPlugin(method, params, { projectPath })));
  };

  // Homepage works do not depend on the project, so any window serves them (the lowest pid when no
  // target is given).
  const homeWindow = async ({ project_path, instance_id }) => {
    if (project_path !== undefined || instance_id !== undefined) return { projectPath: await projects.resolveProjectPath({ project_path, instance_id }) };
    const pids = d.listInstances().map((s) => s.pid).sort((a, b) => a - b);
    if (!pids.length) throw Error('NO_EDITOR_WINDOW: open any project window first (works are served by the XiangsuMcpExt plugin inside it)');
    return { pid: pids[0] };
  };
  const works = (method) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    return text(seenWorks.keep(await d.callPlugin(method, params, await homeWindow({ project_path, instance_id }))));
  };
  const openPaths = async () => (await projects.windows()).map((w) => w.project_path).filter(Boolean);
  // Every works download first sweeps out earlier ones past their lifetime.
  const pruneDownloads = async () => d.downloads.cleanup({ olderThanMs: DOWNLOAD_TTL_MS, openPaths: await openPaths() });
  const downloadWork = async (args) => {
    const { project_path, instance_id, template_id } = args;
    const { raw } = seenWorks.get(template_id);
    await pruneDownloads();
    const got = await d.callPlugin('works_download', { item: raw }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 600000 });
    const root = editorRoot(got.project_path);
    d.downloads.record({ path: root, template_id: got.template_id, title: got.title });
    return { ...got, root };
  };
  const expiresAt = () => new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString();
  // Inspirations, tasks and rank boards belong to the account rather than a project, so any window
  // serves them. Inspirations seen in this session are kept for inspiration_preview.
  const seenInspirations = new Map();
  const community = (method, inspirationsOf) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    const out = await d.callPlugin(method, params, await homeWindow({ project_path, instance_id }));
    if (inspirationsOf) for (const i of inspirationsOf(out)) seenInspirations.set(i.inspiration_id, { title: i.title, cover_url: i.cover_url });
    return text(out);
  };
  const workPage = {
    category_id: z.string().optional().describe('works_nav 返回的分类 ID；省略时用第一个分类（推荐）。'),
    cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
    count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30。'),
    sort: z.enum(['suggest', 'latest', 'effect_usage', 'project_usage']).optional().describe('排序：suggest 推荐（默认）、latest 最新、effect_usage 特效使用量、project_usage 工程使用量。'),
  };

  const tools = [
    {
      name: 'ext_status',
      description:
        '扩展自身状态：官方 MCP 连接情况，以及每个已加载 XiangsuMcpExt 插件的工程窗口（pid、工程路径、对应的官方 instance_id、编辑器接口自检）。工具报找不到窗口、INCOMPATIBLE_EDITOR 或官方工具不可用时先调它排查；插件只在装好后新打开的工程窗口里生效。',
      shape: {},
      run: async () => {
        const official = await d.official.listTools().then(() => d.official.status());
        const ids = new Map((await projects.officialInstances().catch(() => [])).map((i) => [i.pid, i.instance_id]));
        const windows = [];
        for (const w of await projects.windows()) {
          const self_check = await d
            .callPlugin('self_check', {}, { pid: w.pid, timeoutMs: 5000 })
            .catch((e) => ({ ok: false, error: `${e.message}（该窗口里的插件是旧版本，保存后重开工程窗口即可）` }));
          windows.push({ ...w, instance_id: ids.get(w.pid) ?? null, self_check });
        }
        return text({ official, windows });
      },
    },
    {
      name: 'project_open',
      description: '在新窗口打开一个已有的像塑工程（已经开着就直接返回）。返回窗口 pid 和官方 instance_id。旧版本工程可能弹出升级对话框，需要在编辑器里点确认。',
      shape: { path: z.string().min(1).describe('工程文件夹的绝对路径（含 effect.dyehpj）。') },
      run: async (a) => text(await projects.open(a)),
    },
    {
      name: 'project_new',
      description: '新建一个空白像塑工程并首次保存到 path（目录须不存在或为空）。需要已有任意一个工程窗口开着。返回新窗口的 pid 和官方 instance_id。',
      shape: { path: z.string().min(1).describe('新工程要保存到的文件夹绝对路径。') },
      run: async (a) => text(await projects.create(a)),
    },
    {
      name: 'project_close',
      description: '关闭一个工程窗口（等同工具栏「回到首页」）。有未保存改动时默认拒绝，先 save_project；确实要丢弃改动才传 discard_changes=true。',
      shape: { ...target, discard_changes: z.boolean().optional().describe('丢弃未保存改动直接关闭。') },
      run: async (a) => text(await projects.close(a)),
    },
    {
      name: 'library_nav',
      description:
        '列出像塑官方素材库里可直接应用的分类面板（panel_key）和类型 kind：general 为普通面板（如 3d_distortion=脸部变形/3D 变形、distortion=美型、gaoguai_gan/makeup_gan=AI 实时变脸、3d_makeup=美妆、3d_filter=滤镜、sticker=跟脸贴纸）；square 为 aigc_material=素材广场（其他创作者分享的素材，含现成的 AI 图片、AI 妆容、自定义实时变脸，应用时不重新生成、不扣额度）；collection 为 collection=收藏（当前账号收藏的素材）。需要扣额度现生成的 AI 面板不在其中。',
      shape: { ...target },
      run: plugin('library_nav'),
    },
    {
      name: 'library_list',
      description: '分页列出某个官方素材面板里的素材：子分类、素材（template_id、title、kind、cover_url 等）和翻页游标。素材广场的子分类是妆容、图片、实时变脸、跟脸贴纸、前景贴纸、画面特效、3D 模型、3D 饰品；收藏的子分类是全部、美妆、滤镜等目录。没有可应用内容的广场卡片不列出，只在 unsupported 里计数。拿到 template_id 后用 library_preview 看图、library_apply 应用。',
      shape: {
        ...target,
        panel_key: z.string().describe('library_nav 返回的 panel_key。'),
        category_id: z.string().optional().describe('子分类 ID（收藏为目录名）；省略时用第一个子分类（通常是「全部」）。'),
        cursor: z.union([z.number().int().min(0), z.string()]).optional().describe('翻页游标，原样取上一页的 next_cursor（收藏是字符串）。'),
        count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30。'),
      },
      run: library('library_list'),
    },
    {
      name: 'library_search',
      description: '按关键词搜索官方素材库，逐个面板查询以拿全结果（美妆、滤镜、脸部变形、AI 实时变脸、贴纸、画面特效、音效、素材广场等），按 offset / count 分页返回 template_id、title、panel_key、kind 和总数 total。素材广场单词最多返回 1000 条，可用 panel_key 只搜某个面板。kind：package 素材包、ai_image AI 图片、ai_makeup AI 妆容、custom_gan 自定义实时变脸、foreground_sticker 前景贴纸、face_sticker 跟脸贴纸、filter 滤镜。',
      shape: {
        ...target,
        query: z.string().min(1).describe('搜索关键词，如「芒果脸」「小屁桃」「腮红」。'),
        panel_key: z.string().optional().describe('只搜这个面板（library_nav 返回的 panel_key，如 aigc_material）。'),
        offset: z.number().int().min(0).optional().describe('分页起点，取上一页的 next_offset；默认 0。'),
        count: z.number().int().min(1).max(200).optional().describe('每页数量，默认 50。'),
      },
      run: library('library_search'),
    },
    {
      name: 'library_preview',
      description:
        '查看官方素材的封面图，用于按画面挑选。一次最多 8 个，template_id 须来自本会话的 library_list / library_search。单个封面失败只在该项写明原因。all_images=true 时改为查看一张 AI 图片卡片（kind=ai_image）的整组结果图，按 image_index 编号，应用时用 library_apply 的 image_index 选择。',
      shape: {
        ...target,
        template_ids: z.array(z.string()).min(1).max(8).describe('要看封面的 template_id。'),
        all_images: z.boolean().optional().describe('查看 AI 图片卡片的全部结果图；此时 template_ids 只能有一个。'),
      },
      run: async ({ project_path, instance_id, template_ids, all_images = false }) => {
        const content = [];
        if (all_images) {
          if (template_ids.length !== 1) throw Error('INVALID_ARGUMENTS(library_preview): all_images takes exactly one template_id');
          const { slim, raw } = seenLib.get(template_ids[0]);
          const images = await d.callPlugin('library_images', { item: raw }, await homeWindow({ project_path, instance_id }));
          for (const img of images) {
            content.push({ type: 'text', text: `${slim.title}（template_id ${slim.template_id}，image_index ${img.image_index}）` });
            content.push(img.url ? await imageContent(d, { url: img.url }) : { type: 'text', text: '图片地址获取失败' });
          }
          return { content };
        }
        for (const c of template_ids.map((id) => seenLib.get(id).slim)) {
          content.push({ type: 'text', text: `${c.title}（template_id ${c.template_id}）` });
          content.push(c.cover_url ? await imageContent(d, { url: c.cover_url }) : { type: 'text', text: '无封面图' });
        }
        return { content };
      },
    },
    {
      name: 'library_apply',
      description:
        '把一个官方素材应用到目标工程，与素材库面板里点应用相同（可撤销）：素材包下载、校验 MD5、导入并默认放进场景；素材广场的卡片按 kind 走编辑器自己的应用流程（AI 图片、AI 妆容等只下载现成结果，不重新生成、不扣额度），等对象出现在场景里才返回。返回 kind、added_objects（新放进场景的对象名和 object_path）和 package_folders。template_id 须来自本会话的 library_list / library_search。应用后用 capture_preview 验收。',
      shape: {
        ...target,
        template_id: z.string().describe('library_list / library_search 返回的 template_id。'),
        auto_instantiate: z.boolean().optional().describe('是否放进场景，默认 true；false 时只导入资源面板（只有 kind=package 支持）。'),
        image_index: z.number().int().min(0).optional().describe('kind=ai_image 时用第几张结果图，默认 0；整组图见 library_preview 的 all_images。'),
      },
      run: async (a) => {
        const { project_path, instance_id, template_id, auto_instantiate, image_index } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const params = { item: seenLib.get(template_id).raw, ...(auto_instantiate === undefined ? {} : { auto_instantiate }), ...(image_index === undefined ? {} : { image_index }) };
        return text(await d.callPlugin('library_apply', params, { projectPath, timeoutMs: 180000 }));
      },
    },
    {
      name: 'works_nav',
      description: '列出像塑首页「模板」里的作品分类（推荐、官方工程、新手必做、游戏、妆容、AI玩法等）和可用排序。首页作品是完整的像塑工程（官方工程和用户投稿），可下载到本地阅读、学习其场景和脚本做法。任意一个工程窗口开着即可。',
      shape: { ...target },
      run: async (a) => {
        const { project_path, instance_id } = a;
        return text(await d.callPlugin('works_nav', {}, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'works_list',
      description: '分页列出首页某个分类下的作品：template_id、标题、标签、已发布到抖音的特效 ID 和发布量（effect_id / publish_count，没有则为 null）、使用量、工程包大小、封面。拿到 template_id 后用 works_preview 看封面、works_download 下载工程。',
      shape: { ...target, ...workPage },
      run: works('works_list'),
    },
    {
      name: 'works_search',
      description: '按作品名搜索首页作品（与首页搜索框同一个接口，限定在一个分类内，默认推荐）。返回字段同 works_list。按特效 ID 查用 works_by_effect。',
      shape: { ...target, query: z.string().min(1).describe('作品名关键词，如「合掌」「转场」「换装」。'), ...workPage },
      run: works('works_search'),
    },
    {
      name: 'works_by_effect',
      description:
        '按特效 ID 查排行榜等处给出的特效（rank_list / rank_subjects / rank_innovation_picks 的 effect_id）在首页有没有工程，与首页搜索框「特效ID」搜索同一个接口。逐个返回 status：found 首页有这个特效的工程；same_name 首页没有它、只有同名作品（effect_id 不同，可能是别人的同名作品，不能当成同一个特效）；not_on_homepage 作者没把工程分享到首页，拿不到工程。found 和 same_name 的作品在 items 里（字段同 works_list），template_id 可直接用于 works_preview / works_download / works_open。每个特效一到两次请求，20 个约 10 秒。',
      shape: {
        ...target,
        effects: z
          .array(
            z.object({
              effect_id: z.string().regex(/^\d+$/).describe('特效 ID，如 rank_list 返回的 effect_id。'),
              name: z.string().min(1).optional().describe('特效名；给了才会在查不到 ID 时找同名作品。'),
            }),
          )
          .min(1)
          .max(20)
          .describe('要查的特效，最多 20 个（一页排行榜）。'),
        category_id: workPage.category_id,
      },
      run: works('works_by_effect'),
    },
    {
      name: 'works_preview',
      description: '查看首页作品的封面（animated=true 时看动图），一次最多 8 个，template_id 须来自本会话的 works_list / works_search / works_by_effect。',
      shape: {
        template_ids: z.array(z.string()).min(1).max(8).describe('要看的作品 template_id。'),
        animated: z.boolean().optional().describe('看动图（gif）而不是静态封面，默认 false；动图较大。'),
      },
      run: async ({ template_ids, animated = false }) => {
        const rows = template_ids.map((id) => seenWorks.get(id).slim);
        const content = [];
        for (const r of rows) {
          const url = (animated && r.gif_url) || r.cover_url || r.gif_url;
          content.push({ type: 'text', text: `${r.title}（template_id ${r.template_id}）` });
          content.push(url ? await imageContent(d, { url }) : { type: 'text', text: '无封面图' });
        }
        return { content };
      },
    },
    {
      name: 'works_download',
      description:
        '下载一个首页作品的完整工程并解压（与在首页点开作品同一流程，但不打开窗口），返回工程目录和文件清单（files 列出相对路径和大小，可直接读取 effect.dyehpj、Assets 下的场景、Graph 下的脚本等来学习做法）。dest 给定时把工程放到该目录（须不存在或为空，跳过 Library 缓存），像塑临时目录里的那份随即删除。下载的工程（含 dest）都会登记，expires_at（24 小时）后在下次下载时自动删除；学完请立即调用 works_cleanup。要在编辑器里看效果用 works_open。作品版权归原作者，只用于学习参考，不要复制进自己的工程或仓库。',
      shape: {
        ...target,
        template_id: z.string().describe('works_list / works_search / works_by_effect 返回的 template_id。'),
        dest: z.string().optional().describe('工程要放到的文件夹绝对路径（须不存在或为空）；省略时留在像塑的临时目录。'),
      },
      run: async (a) => {
        const { template_id, dest } = a;
        if (dest !== undefined) checkTarget(dest);
        const got = await downloadWork(a);
        let root = got.project_path;
        if (dest !== undefined) {
          try {
            root = copyProject(got.project_path, dest);
            d.downloads.record({ path: root, template_id, title: got.title });
          } finally {
            d.downloads.cleanup({ paths: [got.root] });
          }
        }
        return text({ template_id: got.template_id, title: got.title, project_path: root, expires_at: expiresAt(), outline: outlineProject(root) });
      },
    },
    {
      name: 'works_open',
      description:
        '下载一个首页作品并在新的编辑器窗口里打开，与在首页点开作品同一流程（不弹版本升级提示，工程处于未保存状态）。返回窗口 pid、官方 instance_id 和工程目录，之后可用 get_scene、capture_preview 等官方工具观察它的做法。看完用 project_close（discard_changes=true）关窗，再 works_cleanup 删除下载；窗口开着时工程不会被删除。',
      shape: { ...target, template_id: z.string().describe('works_list / works_search / works_by_effect 返回的 template_id。') },
      run: async (a) => {
        const got = await downloadWork(a);
        try {
          const opened = await projects.open({ path: got.project_path, template_id: got.template_id });
          return text({ template_id: got.template_id, title: got.title, ...opened, expires_at: expiresAt() });
        } catch (e) {
          d.downloads.cleanup({ paths: [got.root], openPaths: await openPaths() });
          throw e;
        }
      },
    },
    {
      name: 'works_cleanup',
      description: '删除 works_download / works_open 下载过的作品工程（像塑临时目录里的和 dest 副本）。省略 paths 时删除全部；编辑器窗口正开着的会保留并在 kept_open 里列出，关窗后再调用即可。只删登记过的下载，其它路径一律拒绝。',
      shape: { paths: z.array(z.string().min(1)).min(1).optional().describe('只删这些下载（works_download / works_open 返回的 project_path）；省略时删除全部。') },
      run: async ({ paths }) => {
        const out = d.downloads.cleanup({ paths, openPaths: await openPaths() });
        return text({ ...out, remaining: d.downloads.list().map((e) => e.path) });
      },
    },
    {
      name: 'icon_set',
      description:
        '设置特效图标（提交特效必需）：把一张图片居中裁成正方形、缩放到 360×360 PNG，写进工程的 Icon/ 目录（与「图标制作」窗口保存的同一批文件），并让编辑器重新读取。默认女性、男性两个图标位都用这张图（提交窗口要这两个）。图片可以来自 generate_image 生成的资源，或 capture_preview 截图另存的文件。之后 save_project 落盘。',
      shape: {
        ...target,
        image_path: z.string().min(1).describe('图片的绝对路径（png / jpg / webp 等 sips 能读的格式）。'),
        type: z.enum(['both', 'female', 'male', 'common']).optional().describe('写哪个图标位：both（默认，女性和男性两个位都用这张图，提交窗口要的就是这两个）、female、male，或 common 通用。'),
      },
      run: async (a) => {
        const { project_path, instance_id, image_path, type = 'both' } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const { png, dir } = await d.prepareIcon(image_path);
        try {
          return text(await d.callPlugin('icon_set', { png_path: png, types: type === 'both' ? ['female', 'male'] : [type] }, { projectPath }));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'icon_open',
      description: '打开编辑器的「图标制作」窗口（官方图标模板、文字模板、AI 图标），让用户在里面挑选或调整。',
      shape: { ...target },
      run: plugin('icon_open'),
    },
    {
      name: 'effect_check',
      description:
        '提交前的特效检测。默认只做本地检查、不上传：按提交流程打包并比对包体上限，检查是否原样套用模板（编辑器会拒收与模板资源相同的工程）、登录状态、是否已有图标，返回 ok 和 issues。cloud=true 时再打开编辑器的「特效检测」窗口做云端性能检测（会把特效包上传到抖音做测试，不是发布），等待结果 passed / not_passed / needs_optimization / failed，详情留在该窗口里。',
      shape: {
        ...target,
        cloud: z.boolean().optional().describe('同时做云端检测，默认 false。'),
        timeout_ms: z.number().int().min(10000).max(1800000).optional().describe('云端检测最长等待时间，默认 300000（5 分钟）。'),
      },
      run: async (a) => {
        const { project_path, instance_id, cloud = false, timeout_ms = 300000 } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const local = await d.callPlugin('effect_check', {}, { projectPath, timeoutMs: 300000 });
        if (!cloud) return text(local);
        const cloudResult = await d.callPlugin('effect_check_cloud', { timeout_ms }, { projectPath, timeoutMs: timeout_ms + 30000 });
        return text({ ...local, cloud: cloudResult });
      },
    },
    {
      name: 'submit_prepare',
      description:
        '准备提交特效：先跑 effect_check 的本地检查，全部通过后走和工具栏「提交特效」按钮相同的入口，由编辑器做自己的前置检查并打开提交窗口。只做到提交窗口打开为止：名称、提示语在窗口里填，真正的上传发布只有用户在窗口里确认才会发生，本工具不会发布。检查未通过时不打开窗口，返回 issues。',
      shape: { ...target },
      run: async (a) => {
        const projectPath = await projects.resolveProjectPath(a);
        return text(await d.callPlugin('submit_prepare', {}, { projectPath, timeoutMs: 360000 }));
      },
    },
    {
      name: 'mobile_preview',
      description:
        '手机预览：按工具栏「手机预览」的方式打包当前工程并上传到抖音的预览服务，返回和编辑器弹出的一样的二维码图片（及其文本、有效期），用抖音 App 扫码即可在真机上看效果。会把特效包上传到抖音服务器；内容审核不通过时报 MOBILE_PREVIEW_MODERATION_FAILED。',
      shape: { ...target },
      run: async (a) => {
        const projectPath = await projects.resolveProjectPath(a);
        const res = await d.callPlugin('mobile_preview', {}, { projectPath, timeoutMs: 300000 });
        const png = await d.qrPng(res.qr_text);
        return {
          content: [
            { type: 'text', text: JSON.stringify(res, null, 2) },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          ],
        };
      },
    },
    {
      name: 'inspiration_nav',
      description: '列出像塑「灵感」页的分类（全部、热门音源、头饰、变形等）。灵感是官方和创作者发布的特效创意（图、玩法说明、奖励），首页右侧「灵感」页签就是它。任意一个工程窗口开着即可，用当前登录的账号请求。',
      shape: { ...target },
      run: community('inspiration_nav'),
    },
    {
      name: 'inspiration_list',
      description: '分页列出某个分类下的灵感：inspiration_id、标题、标签（如「激励」）、作者、收藏数、是否已收藏、是否 AI 灵感、封面。拿到 inspiration_id 后用 inspiration_preview 看图、inspiration_detail 看详情。',
      shape: {
        ...target,
        tab: z.string().optional().describe('inspiration_nav 返回的分类名；省略时用第一个（全部）。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        // The server answers code 1 at 100 (measured); 50 works.
        count: z.number().int().min(1).max(50).optional().describe('每页数量，默认 20。'),
      },
      run: community('inspiration_list', (out) => out.items),
    },
    {
      name: 'inspiration_detail',
      description: '一个灵感的详情：玩法说明、特效类型、激励说明、全部图片、作者、奖励、关联热点、关联官方工程、已有的同灵感特效及发布量，以及当前账号是否已收藏和总收藏数。',
      shape: { ...target, inspiration_id: z.string().min(1).describe('inspiration_list / rank_hotspots / task_detail 返回的 inspiration_id，或像塑 / 抖音 App 灵感页里的灵感 ID。') },
      run: community('inspiration_detail', (out) => [{ inspiration_id: out.inspiration_id, title: out.title, cover_url: out.images[0] || null }]),
    },
    {
      name: 'inspiration_preview',
      description: '查看灵感的封面图，一次最多 8 个，inspiration_id 须来自本会话的 inspiration_list / inspiration_detail / rank_hotspots（带 topic_id）/ task_detail。',
      shape: { inspiration_ids: z.array(z.string()).min(1).max(8).describe('要看的 inspiration_id。') },
      run: async ({ inspiration_ids }) => {
        const content = [];
        for (const id of inspiration_ids) {
          const row = seenInspirations.get(id);
          if (!row) throw Error(`UNKNOWN_INSPIRATION: ${id}; call inspiration_list, inspiration_detail, rank_hotspots or task_detail first`);
          content.push({ type: 'text', text: `${row.title}（inspiration_id ${id}）` });
          content.push(row.cover_url ? await imageContent(d, { url: row.cover_url }) : { type: 'text', text: '无封面图' });
        }
        return { content };
      },
    },
    {
      name: 'inspiration_collect',
      description: '收藏或取消收藏一个灵感（写入当前登录账号，与灵感详情页的收藏按钮相同），之后重新查询收藏状态确认生效。',
      shape: {
        ...target,
        inspiration_id: z.string().min(1).describe('要收藏的 inspiration_id。'),
        collect: z.boolean().optional().describe('true 收藏（默认），false 取消收藏。'),
      },
      run: community('inspiration_collect'),
    },
    {
      name: 'inspiration_bind',
      description: '把一条创作灵感绑定到当前工程（编辑器给 agent 的同一接口），提交时会带上它。之后 save_project 落盘。',
      shape: { ...target, inspiration_id: z.string().min(1).describe('要绑定的 inspiration_id。') },
      run: plugin('inspiration_bind'),
    },
    {
      name: 'tasks_list',
      description:
        '列出首页活动中心的任务。kind=effect（默认）为活动和特效征集任务：标题、状态（如 WAIT_RECEIVE 待领取 / WAIT_SUBMIT 待提交）、是否已领取、剩余天数、收益、上下线时间、可完成次数；kind=growth 为成长任务：奖励金额、参考工程。拿到 task_id 后用 task_detail 看详情、task_receive 领取、task_bind 绑定到工程（bindable=true 的才能绑）。',
      shape: { ...target, kind: z.enum(['effect', 'growth']).optional().describe('effect 活动与征集任务（默认），growth 成长任务。') },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        return text(seenTasks.keep(await d.callPlugin('tasks_list', params, await homeWindow({ project_path, instance_id }))));
      },
    },
    {
      name: 'task_detail',
      description: '一个任务的详情。征集任务返回状态、奖励时间、下线时间、指定模板和完整的任务说明（参与要求、奖项详情、近期热门等内容块）；成长任务返回奖励、参考工程、相关灵感和教程。task_id 须来自本会话的 tasks_list；活动没有详情。',
      shape: { ...target, task_id: z.string().min(1).describe('tasks_list 返回的 task_id。') },
      run: async (a) => {
        const { project_path, instance_id, task_id } = a;
        const t = seenTasks.get(task_id);
        if (t.raw.kind === 'activity') throw Error(`NO_TASK_DETAIL: ${task_id} is an activity; only effect and growth tasks have details`);
        const id = t.raw.kind === 'task' ? t.raw.item_id : t.slim.task_id;
        const out = await d.callPlugin('task_detail', { kind: t.raw.kind, id }, await homeWindow({ project_path, instance_id }));
        for (const i of out.inspirations || []) seenInspirations.set(i.inspiration_id, { title: i.title, cover_url: i.cover_url });
        return text({ task_id, ...out });
      },
    },
    {
      name: 'task_receive',
      description: '领取一个征集任务（写入当前登录账号，与活动中心的「领取」按钮相同，领取后不能撤销）。只有状态为 WAIT_RECEIVE 的任务能领，其它状态直接拒绝。返回 designer_task_id 和新状态；领取后重新 tasks_list，该任务即可 task_bind。',
      shape: { ...target, task_id: z.string().min(1).describe('tasks_list（kind=effect）返回的任务 task_id。') },
      run: async (a) => {
        const { project_path, instance_id, task_id } = a;
        const t = seenTasks.get(task_id);
        if (t.raw.kind !== 'task') throw Error(`TASK_NOT_RECEIVABLE: ${task_id} is not an effect task (kind=${t.raw.kind})`);
        return text({ task_id, ...(await d.callPlugin('task_receive', { item_id: t.raw.item_id }, await homeWindow({ project_path, instance_id }))) });
      },
    },
    {
      name: 'task_bind',
      description:
        '把工程绑定到一个已领取的任务，和从任务详情页点「去创作」打开的工程一样，提交时会带上该任务。编辑器只在打开工程时写入任务信息，所以本工具会先关闭该工程的窗口（有未保存改动时拒绝，先 save_project），再带着任务信息重新打开，返回新的 pid 和 instance_id。task_id 须来自本会话的 tasks_list。',
      shape: {
        path: z.string().min(1).describe('工程文件夹的绝对路径。'),
        task_id: z.string().min(1).describe('tasks_list 返回的 task_id（须 bindable=true）。'),
      },
      run: async ({ path: projectDir, task_id }) => {
        const t = seenTasks.get(task_id);
        if (t.raw.kind === 'growth') throw Error(`TASK_NOT_BINDABLE: ${task_id} is a growth task`);
        if (!t.raw.extra) throw Error(`TASK_NOT_RECEIVED: ${task_id}; receive it with task_receive first`);
        const open = (await projects.windows()).some((w) => w.project_path && fs.existsSync(w.project_path) && fs.realpathSync(w.project_path) === fs.realpathSync(projectDir));
        if (open) await projects.close({ project_path: projectDir });
        return text({ task: t.slim, ...(await projects.open({ path: projectDir, activity: t.raw.extra })) });
      },
    },
    {
      name: 'rank_nav',
      description: '像塑移动版「排行榜」的榜单和筛选项：可用的 rank_type（年轻喜爱榜、特效每日投稿榜、男生/女生喜爱榜、热玩互动榜、模板每日投稿榜、特效跟拍榜）、rank_list 可用的等级 / 面板 / 偏好 / 来自工具 / 年轻喜爱度选项，以及该榜当天（或 date 那天）的分类和条数。分类有两级：level 1 是大类（人像美化、游戏玩法、人设扮演、AI 玩法…），level 2 是细类（基础头饰、测一测、不露脸壁纸…），每个榜的分类不同。按主题的专题榜（如「热爆美妆特效榜」「歌词玩法模板榜」）见 rank_subjects。',
      shape: {
        ...target,
        rank_type: z.number().int().optional().describe('要看分类的榜单，默认 1（年轻喜爱榜）。'),
        date: z.string().optional().describe('榜单日期 YYYY-MM-DD，默认最新一期。'),
      },
      run: community('rank_nav'),
    },
    {
      name: 'rank_list',
      description: '分页读取一个排行榜（与像塑移动版排行榜页同一个接口）：名次、特效名、effect_id、等级、投稿量（峰值 / 累计）、跟拍量、男女比例、年轻喜爱度、热玩分、总收益等。可按日期、分类（每级一个，如只看「人像美化 › 美妆」）和筛选项过滤，选项见 rank_nav。要看某个特效的工程，把 effect_id 和 name 交给 works_by_effect，查它在不在首页。',
      shape: {
        ...target,
        rank_type: z.number().int().optional().describe('rank_nav 返回的 rank_type，默认 1（年轻喜爱榜）。'),
        date: z.string().optional().describe('榜单日期 YYYY-MM-DD，默认最新一期。'),
        categories: z.array(z.string()).max(3).optional().describe('rank_nav 返回的分类名，每级最多一个，可叠加，如 ["人像美化","美妆"]（大类 + 细类）。'),
        levels: z.array(z.string()).optional().describe('特效等级，如 ["S","A+"]。'),
        panels: z.array(z.string()).optional().describe('面板，如 ["头饰","美妆"]。'),
        preferences: z.array(z.string()).optional().describe('偏好：友友、潮酷。'),
        tools: z.array(z.string()).optional().describe('来自工具：像塑桌面端、像塑移动版、轻颜 App。'),
        young_like_scores: z.array(z.number().int().min(1).max(10)).optional().describe('年轻喜爱度 1–10。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        // The server answers code 1 above 20 (measured).
        count: z.number().int().min(1).max(20).optional().describe('每页数量，默认 20（最大 20）。'),
      },
      run: community('rank_list'),
    },
    {
      name: 'rank_hotspots',
      description: '热点榜（按热度排序的抖音热点，每小时更新）：名次、topic_id、标题、说明、热度、相关灵感数。传 topic_id 时改为返回该热点下的灵感（inspiration_id、标题、标签、说明、封面）。',
      shape: {
        ...target,
        count: z.number().int().min(1).optional().describe('最多返回多少个热点，默认全部。'),
        topic_id: z.string().min(1).optional().describe('只看这个热点下的灵感（rank_hotspots 返回的 topic_id）。'),
      },
      run: community('rank_hotspots', (out) => (out.tabs || []).flatMap((t) => t.inspirations)),
    },
    {
      name: 'rank_subjects',
      description: '像塑移动版「专题合集」里按主题的榜单，最新的在前：kind=effect 为特效专题榜（近 200 期，如「测一测玩法特效榜 - 11月」「热爆美妆特效榜」「熊出没IP特效榜」「主题创新优胜特效榜」、各期征集活动优质特效），kind=template 为模板专题榜（如「歌词玩法模板榜」「AI配文创意模板榜」「氛围转场模板榜」）。每个榜带前几个特效、浏览量。keyword 按榜名搜索全部期；传 subject_id 时返回该榜的全部特效（最多 20 个）。',
      shape: {
        ...target,
        subject_id: z.string().min(1).optional().describe('只看这个榜（rank_subjects 返回的 subject_id）。'),
        kind: z.enum(['effect', 'template']).optional().describe('effect 特效专题榜（默认），template 模板专题榜。'),
        keyword: z.string().min(1).optional().describe('按榜名搜索，如「美妆」「测一测」「IP」；给定时返回全部匹配的期，不分页。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        // The server answers code 1 above 20 (measured).
        count: z.number().int().min(1).max(20).optional().describe('每页数量，默认 20（最大 20）。'),
      },
      run: community('rank_subjects'),
    },
    {
      name: 'rank_creators_month',
      description: '创新计划创作者月榜：名次、创作者 uid 和昵称、上榜素材数、跟拍量、预计奖金。',
      shape: { ...target },
      run: community('rank_creators_month'),
    },
    {
      name: 'rank_innovation_picks',
      description: '创新计划官方精选（像塑移动版发现页的精选列表）：特效名、effect_id、标签、投稿量、总收益、入选日期、封面。kind=template 为模板（移动版展示的就是这个），kind=effect 为特效。',
      shape: {
        ...target,
        kind: z.enum(['template', 'effect']).optional().describe('template 模板（默认），effect 特效。'),
        offset: z.number().int().min(0).optional().describe('翻页偏移，取上一页的 next_offset。'),
        count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 20；服务端会过滤，实际条数可能略少。'),
      },
      run: community('rank_innovation_picks'),
    },
    {
      name: 'music_categories',
      description: '列出抖音音乐库的分类（像塑原创、推荐、抖音收藏、潮流心选等），返回 code 和名称。',
      shape: { ...target },
      run: async (a) => {
        const { project_path, instance_id } = a;
        return text(await d.callPlugin('music_categories', {}, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'music_list',
      description: '列出抖音音乐：传 query 按关键词搜索，或传 category_code（music_categories 返回）看某个分类的第一页（35 首）。返回 music_id、标题、作者、时长（秒）、封面、试听链接和 has_copyright（音乐库给的版权标记，false 或 null 的不要用于要发布的特效）。',
      shape: {
        ...target,
        query: z.string().min(1).optional().describe('搜索关键词。'),
        category_code: z.string().min(1).optional().describe('分类 code；与 query 二选一。'),
      },
      run: async (a) => {
        const { project_path, instance_id, query, category_code } = a;
        if ((query === undefined) === (category_code === undefined)) throw Error('INVALID_ARGUMENTS(music_list): pass exactly one of query or category_code');
        const res = await d.callPlugin('music_list', query !== undefined ? { query } : { category_code }, await homeWindow({ project_path, instance_id }));
        return text(seenMusic.keep(res, { category_code: category_code ?? null }));
      },
    },
    {
      name: 'music_apply',
      description:
        '把一首抖音音乐设为特效的音乐，和音乐库里点「使用」相同：下载音频进工程、写入音乐信息，并在场景里加入抖音音乐对象（再次使用会替换上一首）。start_sec / end_sec 截取片段，默认整首。music_id 须来自本会话的 music_list。之后 capture_preview 验收、save_project 落盘。',
      shape: {
        ...target,
        music_id: z.string().min(1).describe('music_list 返回的 music_id。'),
        start_sec: z.number().min(0).optional().describe('片段开始（秒），默认 0。'),
        end_sec: z.number().positive().optional().describe('片段结束（秒），默认整首时长。'),
      },
      run: async (a) => {
        const { project_path, instance_id, music_id, start_sec, end_sec } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const m = seenMusic.get(music_id);
        const params = { item: m.raw, ...(m.category_code ? { category_code: m.category_code } : {}), ...(start_sec === undefined ? {} : { start_sec }), ...(end_sec === undefined ? {} : { end_sec }) };
        return text(await d.callPlugin('music_apply', params, { projectPath, timeoutMs: 180000 }));
      },
    },
    {
      name: 'scene_tree',
      description:
        '把场景结构输出成紧凑的缩进文本：渲染组，以及每个对象的 guid、名称、是否隐藏、组件类型。比 get_scene 的 JSON 好读，适合先摸清结构再用 inspect_many 查参数。subtree 只看某个对象（guid 或名称），depth 控制展开层数（默认 6）；没展开的子对象会注明数量。传 project_dir（工程目录，如 works_download 下载的作品）时不需要打开窗口，直接读 Assets/main.scene 和 main.scene.extra，对象写成 #序号，组件类型和窗口里显示的一致（编辑器数据缺失时退回场景文件里的名称）；没有渲染组这一层，渲染组本身作为根对象列出。save_to 是目录的绝对路径，结果另存为其中的 scene_tree.txt，长期保留。',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('不开窗口、直接读这个工程目录的场景文件；给了它就不看 project_path / instance_id。'),
        subtree: z.string().min(1).optional().describe('只输出这个对象及其子对象（guid 或名称；project_dir 时用 #序号 或名称）。'),
        depth: z.number().int().min(1).max(30).optional().describe('展开层数，默认 6。'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { project_dir, subtree, depth = 6, save_to } = a;
        let out;
        let warn = null;
        if (project_dir) {
          const scene = loadScene(project_dir);
          out = formatObjects(scene.tree({ subtree, depth }));
          warn = unreadableNote(scene);
        } else {
          const instance_id = await officialInstance(a);
          out = formatTree(await d.official.callJson('get_scene', { instance_id, summary: false, depth, ...(subtree ? { subtree } : {}), intention: '读取场景结构' }));
        }
        out = out || '（场景为空）';
        const saved = save_to ? saveFile(save_to, 'scene_tree.txt', out) : null;
        return { content: [{ type: 'text', text: [out, warn, saved && `已保存：${saved}`].filter(Boolean).join('\n\n') }] };
      },
    },
    {
      name: 'inspect_many',
      description:
        '一次查看多个对象的组件参数（逐个调用官方 inspect），值里的 {type, data} 包装直接展开成值，超长数组只给长度和前几项；绑定的资源写成 {resource, type, file}，引用的对象写成 {object, name}。component_types 只留某些组件（如 ["Transform"]），fields 只留属性名包含这些片段的属性（不分大小写，如 ["intensity", "position"]）。preset="key" 自动留下通常决定效果的参数：位置/缩放/旋转、显隐与启用、强度/不透明度/权重/颜色类属性、文字内容（str）与 2D 尺寸（sizeDelta）、绑定的资源，以及场景文件里脚本组件的全部参数（这份清单是按已做过的妆容、形变、贴纸、文字效果拍的，缺的用 fields 补，可与 fields 同时用）。传 project_dir 时不开窗口、直接读场景文件（含编辑器面板里的参数，如妆容的贴图和强度），guids 用 scene_tree 给出的 #序号；内置资源写成 {builtin: id}，组件运行时生成、工程里没有文件的资源写成 {path}。单个对象失败只在该项写明原因。save_to 是目录的绝对路径，结果另存为其中的 inspect_many.json，长期保留。',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('不开窗口、直接读这个工程目录的场景文件；给了它就不看 project_path / instance_id。'),
        guids: z.array(z.string().min(1)).min(1).max(40).describe('对象或组件的 guid（scene_tree / get_scene 返回的；project_dir 时是 #序号）。'),
        component_types: z.array(z.string().min(1)).min(1).optional().describe('只保留这些类型的组件。'),
        fields: z.array(z.string().min(1)).min(1).optional().describe('只保留属性名包含这些片段的属性。'),
        preset: z.enum(['key']).optional().describe('key：只留关键参数，见工具说明。'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { project_dir, guids, component_types, fields, preset, save_to } = a;
        const pick = { component_types, fields, preset };
        const out = [];
        let warn = null;
        if (project_dir) {
          const scene = loadScene(project_dir);
          warn = unreadableNote(scene);
          for (const guid of guids) {
            try {
              out.push(pickInspect(scene.inspect(guid), pick));
            } catch (e) {
              out.push({ guid, error: String(e.message ?? e) });
            }
          }
        } else {
          const instance_id = await officialInstance(a);
          const root = await projects.resolveProjectPath({ instance_id });
          const inspect = (guid) => d.official.callJson('inspect', { instance_id, guid, intention: '批量查看对象参数' });
          const cache = new Map();
          for (const guid of guids) {
            try {
              out.push(await resolveRefs(pickInspect(await inspect(guid), pick), inspect, { root, cache }));
            } catch (e) {
              out.push({ guid, error: String(e.message ?? e) });
            }
          }
        }
        const res = text(out);
        if (warn) res.content.push({ type: 'text', text: warn });
        if (save_to) res.content.push({ type: 'text', text: `已保存：${saveFile(save_to, 'inspect_many.json', res.content[0].text)}` });
        return res;
      },
    },
    {
      name: 'preview_frames',
      description:
        '按时间连续截取预览画面，分辨率是预览本身的（720×1280，官方截图是缩小后的 320×569）：默认先重置预览，再每隔 interval_ms 截一张，共 count 张（一次最多 24 张），用来看动态效果、摇头时的侧脸等。videos 可依次换几个预览视频各截一组（名称取自 list_preview_videos，如 preview_single_shake_head||女），全部截完切回原视频；切换会让工程变成「已修改」，之后需要 save_project。crop 按画面比例（0–1）裁出局部，如脸部。每帧都存成文件并随结果返回，files 里是路径，可直接贴给用户看；默认存在临时目录、24 小时后删除，save_to（目录的绝对路径）则存到那里长期保留。每帧注明实际截取时刻（相对重置后的毫秒数）。',
      shape: {
        ...target,
        count: z.number().int().min(1).max(12).optional().describe('每个视频截几张，默认 4。'),
        interval_ms: z.number().int().min(100).max(10000).optional().describe('相邻两张的间隔（毫秒），默认 700。'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('依次使用的预览视频名称（list_preview_videos 返回的 video_name）；不给就用当前视频。'),
        tracking_type: z.string().min(1).optional().describe('videos 所属的 tracking_type，如 face、body、hand，默认 face。'),
        reset: z.boolean().optional().describe('每组截图前先重置预览，默认 true。'),
        crop: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().gt(0).max(1),
            height: z.number().gt(0).max(1),
          })
          .optional()
          .describe('裁剪区域，按画面宽高的比例，左上角为 (0, 0)。'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { count = 4, interval_ms = 700, videos, tracking_type = 'face', reset = true, crop, save_to } = a;
        const total = count * (videos ? videos.length : 1);
        if (total > MAX_FRAMES) throw Error(`TOO_MANY_FRAMES: ${total} frames asked, at most ${MAX_FRAMES} per call`);
        const instance_id = await officialInstance(a);
        const projectPath = await projects.resolveProjectPath({ instance_id });
        const dir = save_to ? saveDir(save_to) : d.framesDir();
        const frame = (name) => d.callPlugin('preview_frame', {}, { projectPath, timeoutMs: 15000 }).then((img) => ({ name, img }));
        const shoot = async (prefix) => {
          if (reset) {
            const r = await d.official.callJson('interact_by_dsl', { instance_id, commands: [{ command_type: 'reset_preview', params: {} }], intention: '重置预览后连续截图' });
            if (!r.success) throw Error(`RESET_PREVIEW_FAILED: ${JSON.stringify(r.results)}`);
          }
          const t0 = Date.now();
          const shots = [];
          for (let i = 0; i < count; i++) {
            if (i) await d.sleep(Math.max(0, t0 + i * interval_ms - Date.now()));
            const at = Date.now() - t0;
            shots.push({ ...(await frame(`${prefix}frame-${i + 1}.jpg`)), at });
          }
          return shots;
        };
        const groups = [];
        let original = null;
        if (videos) {
          original = await d.official.callJson('get_current_preview_video', { instance_id, intention: '记下当前预览视频，截图后切回' });
          try {
            for (const [k, video_name] of videos.entries()) {
              await d.official.callJson('set_preview_video', { instance_id, tracking_type, video_name, intention: '临时切换预览视频截图' });
              groups.push({ video: video_name, shots: await shoot(`v${k + 1}-`) });
            }
          } finally {
            const back = original.video_name ? { video_name: original.video_name } : { resource_url: original.resource_url };
            await d.official.callJson('set_preview_video', { instance_id, tracking_type: original.tracking_type, ...back, intention: '截图后切回原预览视频' });
          }
        } else {
          groups.push({ video: null, shots: await shoot('') });
        }
        const files = [];
        const content = [];
        for (const g of groups) {
          for (const [i, s] of g.shots.entries()) {
            const file = path.join(dir, s.name);
            fs.writeFileSync(file, Buffer.from(s.img.data, 'base64'));
            if (crop) await d.cropImage(file, crop);
            files.push(file);
            content.push({ type: 'text', text: `${g.video ? `${g.video} ` : ''}第 ${i + 1} 帧（${s.at} ms）` });
            content.push({ type: 'image', ...(await d.readImageFile(file)) });
          }
        }
        const summary = {
          frames: files.length,
          files,
          ...(save_to ? {} : { note_files: '临时文件，24 小时后删除；要留存请传 save_to' }),
          ...(original ? { note: `预览视频已切回 ${original.video_name || original.resource_url}；切换过预览视频，工程变成了「已修改」，需要 save_project` } : {}),
        };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'menu_list',
      description:
        '列出像塑「添加对象」菜单里的全部官方功能项（工具栏美妆、美型、AI 实时变脸，及人脸/身体/2D/3D/AI 玩法/互动/宠物/音乐等），返回 menu_id、中文名、路径、类型。官方 add_builtin_object 只覆盖其中一部分；美容（面部提拉、祛皱纹）、面部生成（烟熏妆、卡通脸）、表情生成（香肠嘴、呲牙尬笑）、性别年龄、五官处理、身体换装等用 menu_add。query 按名称、路径或 menu_id 过滤。云端 AI 生成项不在列表中。',
      shape: { ...target, query: z.string().optional().describe('按中文名、路径或 menu_id 过滤，如「表情」「美容」「烟熏妆」。') },
      run: plugin('menu_list'),
    },
    {
      name: 'menu_preview',
      description: '查看菜单功能项的说明和示意图（编辑器悬停提示里的图），一次最多 8 个，用于按画面挑选 AI 变脸、美容等效果。',
      shape: { ...target, menu_ids: z.array(z.string()).min(1).max(8).describe('menu_list 返回的 menu_id。') },
      run: async (a) => {
        const { project_path, instance_id, menu_ids } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const rows = await d.callPlugin('menu_preview', { menu_ids }, { projectPath });
        const content = [];
        for (const r of rows) {
          content.push({ type: 'text', text: `${r.name}（menu_id ${r.menu_id}）${r.description ? `：${r.description}` : ''}` });
          content.push(r.image_url || r.image_file ? await imageContent(d, { url: r.image_url, file: r.image_file }) : { type: 'text', text: '无示意图' });
        }
        return { content };
      },
    },
    {
      name: 'menu_add',
      description: '按 menu_id 往场景添加一个官方功能对象，与在编辑器菜单里点选等效（可撤销）。kind=package 的项会先下载官方素材包再导入。返回 added_objects（新对象名和 object_path）。',
      shape: { ...target, menu_id: z.string().min(1).describe('menu_list 返回的 menu_id。') },
      run: plugin('menu_add', 180000),
    },
    {
      name: 'face_warp_list',
      description: '列出场景里所有「塑型画笔」组件（FaceWarpX，含猫脸/狗脸），返回 object_path、是否启用、每项画笔的序号与强度。官方 set_component 改不了画笔强度，用 face_warp_set_intensity。',
      shape: { ...target },
      run: plugin('face_warp_list'),
    },
    {
      name: 'face_warp_set_intensity',
      description:
        '修改「塑型画笔」强度（等同检查器强度滑块，0–100），只改强度、保留笔刷数据，可撤销。object_path 取 face_warp_list 的路径，或能唯一定位的末尾几段。省略 item_index 时改全部画笔项。',
      shape: {
        ...target,
        object_path: z.string().min(1).describe('face_warp_list 返回的 object_path，或能唯一定位的末尾几段。'),
        intensity: z.number().min(0).max(100).describe('强度，0–100。'),
        item_index: z.number().int().min(0).optional().describe('只改某一项画笔；省略时改全部。'),
      },
      run: plugin('face_warp_set_intensity'),
    },
    {
      name: 'object_remove',
      description:
        '删除一个场景对象（含子对象，可撤销），并找出只被它使用的工程资源：删除前后对比场景引用，删除前被引用、删除后不再被引用的即为孤儿（unused_paths 已合并到素材包文件夹，只含磁盘上存在的路径）。editor_only_paths 是素材放进场景时编辑器按对象名建的文件夹（如「复古清冷_滤镜」），只在编辑器里、尚未写到磁盘，对象删除后下次保存就会消失，不用删。delete_unused_resources=true 时一并删除 unused_paths（资源删除不可撤销）；默认只报告，可之后用 resource_delete_unused 删除。object_path 用完整层级路径或能唯一定位的末尾几段（渲染组本身请用官方 delete_render_group）。',
      shape: {
        ...target,
        object_path: z.string().min(1).describe('对象的层级路径，如「面部拉伸/小屁桃_美型」，或能唯一定位的末尾几段。'),
        delete_unused_resources: z.boolean().optional().describe('同时删除孤儿资源，默认 false（只报告）。'),
      },
      run: plugin('object_remove'),
    },
    {
      name: 'resource_delete_unused',
      description: '删除 object_remove 报告的 unused_paths（工程内相对路径的资源或素材包文件夹）。删除前再次核对：当前场景仍在引用的一律拒绝。资源删除不可撤销。',
      shape: { ...target, paths: z.array(z.string().min(1)).min(1).describe('object_remove 返回的 unused_paths。') },
      run: plugin('resource_delete_unused'),
    },
  ];
  const own = new Map(tools.map((t) => [t.name, { ...t, schema: z.strictObject(t.shape) }]));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const mine = [...own.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) }));
    const official = (await d.official.listTools()).filter((t) => !own.has(t.name));
    return { tools: [...mine, ...official] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const t = own.get(name);
    if (t) {
      const parsed = t.schema.safeParse(args);
      if (!parsed.success) return failure(`INVALID_ARGUMENTS(${name}): ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
      try {
        return await t.run(parsed.data);
      } catch (e) {
        return failure(e);
      }
    }
    try {
      return await d.official.callTool(name, args);
    } catch (e) {
      if (e instanceof McpError) return failure(`OFFICIAL_TOOL_ERROR(${name}): ${e.message}`);
      return failure(`OFFICIAL_MCP_UNAVAILABLE(${name}): ${e.message}；确认像塑已启动（${d.official.url}）`);
    }
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const official = new OfficialMcp();
  official.watch();
  // The official-MCP watcher keeps the event loop alive, so a closed client would leave this process
  // running forever.
  process.stdin.on('end', () => process.exit(0));
  await createServer({ official }).connect(new StdioServerTransport());
}
