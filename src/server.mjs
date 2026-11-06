#!/usr/bin/env node
// stdio MCP server: everything 像塑's official MCP offers (proxied unchanged), plus editor features the
// official server cannot reach, served by the XiangsuMcpExt editor plugin.
import fs from 'node:fs';
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
import { DOWNLOAD_TTL_MS, Downloads, checkTarget, copyProject, editorRoot, outlineProject } from './works.mjs';

const VERSION = '0.3.0';

const target = {
  project_path: z.string().optional().describe('目标工程的绝对路径。与 instance_id 二选一；只开了一个工程窗口时都可省略。'),
  instance_id: z.string().optional().describe('官方 list_instances 返回的 instance_id，与 project_path 二选一。'),
};

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
  const seenWorks = new Seen('UNKNOWN_WORK', 'works_list or works_search');
  const seenTasks = new Seen('UNKNOWN_TASK', 'tasks_list', 'task_id');
  const seenMusic = new Seen('UNKNOWN_MUSIC', 'music_list', 'music_id');

  // Forwards to the plugin window showing the target project.
  const plugin = (method, timeoutMs) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
    return text(await d.callPlugin(method, params, { projectPath, timeoutMs }));
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
        '列出像塑官方素材库里可直接应用的分类面板（panel_key），例如 3d_distortion=脸部变形/3D 变形、distortion=美型、gaoguai_gan/makeup_gan=AI 实时变脸、3d_makeup=美妆、3d_filter=滤镜、sticker=跟脸贴纸。需要扣额度的 AI 生成类面板不在其中。',
      shape: { ...target },
      run: plugin('library_nav'),
    },
    {
      name: 'library_list',
      description: '分页列出某个官方素材面板里的素材：子分类、素材（template_id、title、cover_url 等）和翻页游标。拿到 template_id 后用 library_preview 看图、library_apply 应用。',
      shape: {
        ...target,
        panel_key: z.string().describe('library_nav 返回的 panel_key。'),
        category_id: z.string().optional().describe('子分类 ID；省略时用第一个子分类（通常是「全部」）。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30。'),
      },
      run: library('library_list'),
    },
    {
      name: 'library_search',
      description: '按关键词搜索官方素材库，逐个面板查询以拿全结果（美妆、滤镜、脸部变形、AI 实时变脸、贴纸、画面特效、音效等），返回 template_id、title、panel_key。',
      shape: { ...target, query: z.string().min(1).describe('搜索关键词，如「芒果脸」「小屁桃」「腮红」。') },
      run: library('library_search'),
    },
    {
      name: 'library_preview',
      description: '查看官方素材的封面图，用于按画面挑选。一次最多 8 个，template_id 须来自本会话的 library_list / library_search。单个封面失败只在该项写明原因。',
      shape: { template_ids: z.array(z.string()).min(1).max(8).describe('要看封面的 template_id。') },
      run: async ({ template_ids }) => {
        const rows = template_ids.map((id) => seenLib.get(id).slim);
        const content = [];
        for (const c of rows) {
          content.push({ type: 'text', text: `${c.title}（template_id ${c.template_id}）` });
          content.push(c.cover_url ? await imageContent(d, { url: c.cover_url }) : { type: 'text', text: '无封面图' });
        }
        return { content };
      },
    },
    {
      name: 'library_apply',
      description:
        '把一个官方素材应用到目标工程：下载素材包、校验 MD5、按素材库面板相同的流程导入并默认放进场景（可撤销）。返回 added_objects（新放进场景的对象名和 object_path）。template_id 须来自本会话的 library_list / library_search。应用后用 capture_preview 验收。',
      shape: {
        ...target,
        template_id: z.string().describe('library_list / library_search 返回的 template_id。'),
        auto_instantiate: z.boolean().optional().describe('是否放进场景，默认 true；false 时只导入资源面板。'),
      },
      run: async (a) => {
        const { project_path, instance_id, template_id, auto_instantiate } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const params = { item: seenLib.get(template_id).raw, ...(auto_instantiate === undefined ? {} : { auto_instantiate }) };
        return text(await d.callPlugin('library_apply', params, { projectPath, timeoutMs: 180000 }));
      },
    },
    {
      name: 'works_nav',
      description: '列出像塑首页「模板」里的作品分类（推荐、官方工程、新手必做、游戏、妆容、AI玩法等）和可用排序。首页作品是完整的像塑工程（官方工程和用户投稿），可下载到本地阅读、学习其场景和脚本做法。任意一个工程窗口开着即可。',
      shape: { ...target },
      run: works('works_nav'),
    },
    {
      name: 'works_list',
      description: '分页列出首页某个分类下的作品：template_id、标题、标签、已发布到抖音的特效 ID 和发布量（effect_id / publish_count，没有则为 null）、使用量、工程包大小、封面。拿到 template_id 后用 works_preview 看封面、works_download 下载工程。',
      shape: { ...target, ...workPage },
      run: works('works_list'),
    },
    {
      name: 'works_search',
      description: '按作品名搜索首页作品（与首页搜索框同一个接口，限定在一个分类内，默认推荐）。返回字段同 works_list。',
      shape: { ...target, query: z.string().min(1).describe('作品名关键词，如「合掌」「转场」「换装」。'), ...workPage },
      run: works('works_search'),
    },
    {
      name: 'works_preview',
      description: '查看首页作品的封面（animated=true 时看动图），一次最多 8 个，template_id 须来自本会话的 works_list / works_search。',
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
        template_id: z.string().describe('works_list / works_search 返回的 template_id。'),
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
      shape: { ...target, template_id: z.string().describe('works_list / works_search 返回的 template_id。') },
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
      name: 'tasks_list',
      description:
        '列出创作者中心的活动和特效任务（与首页任务广场同源）：标题、状态（如「领取」）、是否已领取、剩余天数、收益、标签。bindable=true 的（已领取的任务）可以用 task_bind 绑定到工程；领取要用户在像塑首页或抖音 App 里操作，工具不提供领取。',
      shape: { ...target },
      run: async (a) => {
        const { project_path, instance_id } = a;
        return text(seenTasks.keep(await d.callPlugin('tasks_list', {}, await homeWindow({ project_path, instance_id }))));
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
        if (!t.raw.extra) throw Error(`TASK_NOT_RECEIVED: ${task_id}; receive it in 像塑's homepage or the Douyin app first`);
        const open = (await projects.windows()).some((w) => w.project_path && fs.existsSync(w.project_path) && fs.realpathSync(w.project_path) === fs.realpathSync(projectDir));
        if (open) await projects.close({ project_path: projectDir });
        return text({ task: t.slim, ...(await projects.open({ path: projectDir, activity: t.raw.extra })) });
      },
    },
    {
      name: 'inspiration_detail',
      description: '按 ID 查看一条创作灵感的详情（描述、图片、奖励、关联特效、音乐）。灵感 ID 来自像塑或抖音 App 里的灵感页；编辑器没有灵感列表接口。',
      shape: { ...target, id: z.string().min(1).describe('灵感 ID。') },
      run: async (a) => {
        const { project_path, instance_id, id } = a;
        return text(await d.callPlugin('inspiration_detail', { id }, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'inspiration_bind',
      description: '把一条创作灵感绑定到当前工程（编辑器给 agent 的同一接口），提交时会带上它。之后 save_project 落盘。',
      shape: { ...target, id: z.string().min(1).describe('灵感 ID。') },
      run: plugin('inspiration_bind'),
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
        '删除一个场景对象（含子对象，可撤销），并找出只被它使用的工程资源：删除前后对比场景引用，删除前被引用、删除后不再被引用的即为孤儿（unused_paths 已合并到素材包文件夹）。delete_unused_resources=true 时一并删除这些资源（资源删除不可撤销）；默认只报告，可之后用 resource_delete_unused 删除。object_path 用完整层级路径或能唯一定位的末尾几段（渲染组本身请用官方 delete_render_group）。',
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
