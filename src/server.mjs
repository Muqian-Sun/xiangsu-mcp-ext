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
import { z } from 'zod';
import { callPlugin, listInstances } from './bridge.mjs';
import { OfficialMcp } from './official.mjs';
import { fetchImage, readImageFile } from './images.mjs';
import { Projects, openWithApp } from './projects.mjs';
import { DOWNLOAD_TTL_MS, Downloads, checkTarget, copyProject, editorRoot, outlineProject } from './works.mjs';

const VERSION = '0.3.0';

const target = {
  project_path: z.string().optional().describe('目标工程的绝对路径。与 instance_id 二选一；只开了一个工程窗口时都可省略。'),
  instance_id: z.string().optional().describe('官方 list_instances 返回的 instance_id，与 project_path 二选一。'),
};

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

  // Forwards to the plugin window showing the target project.
  const plugin = (method, timeoutMs) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
    return text(await d.callPlugin(method, params, { projectPath, timeoutMs }));
  };

  // Homepage works do not depend on the project, so any window serves them; without a target the
  // lowest pid is used so works_list and a later works_download hit the same window.
  const homeWindow = async ({ project_path, instance_id }) => {
    if (project_path !== undefined || instance_id !== undefined) return { projectPath: await projects.resolveProjectPath({ project_path, instance_id }) };
    const pids = d.listInstances().map((s) => s.pid).sort((a, b) => a - b);
    if (!pids.length) throw Error('NO_EDITOR_WINDOW: open any project window first (works are served by the XiangsuMcpExt plugin inside it)');
    return { pid: pids[0] };
  };
  const works = (method) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    return text(await d.callPlugin(method, params, await homeWindow({ project_path, instance_id })));
  };
  const openPaths = async () => (await projects.windows()).map((w) => w.project_path).filter(Boolean);
  // Every works download first sweeps out earlier ones past their lifetime.
  const pruneDownloads = async () => d.downloads.cleanup({ olderThanMs: DOWNLOAD_TTL_MS, openPaths: await openPaths() });
  const downloadWork = async (args) => {
    const { project_path, instance_id, template_id } = args;
    await pruneDownloads();
    const got = await d.callPlugin('works_download', { template_id }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 600000 });
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
      run: plugin('library_list'),
    },
    {
      name: 'library_search',
      description: '按关键词搜索官方素材库，逐个面板查询以拿全结果（美妆、滤镜、脸部变形、AI 实时变脸、贴纸、画面特效、音效等），返回 template_id、title、panel_key。',
      shape: { ...target, query: z.string().min(1).describe('搜索关键词，如「芒果脸」「小屁桃」「腮红」。') },
      run: plugin('library_search'),
    },
    {
      name: 'library_preview',
      description: '查看官方素材的封面图，用于按画面挑选。一次最多 8 个，template_id 须来自本会话的 library_list / library_search。单个封面失败只在该项写明原因。',
      shape: { ...target, template_ids: z.array(z.string()).min(1).max(8).describe('要看封面的 template_id。') },
      run: async (a) => {
        const { project_path, instance_id, template_ids } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const covers = await d.callPlugin('library_covers', { template_ids }, { projectPath });
        const content = [];
        for (const c of covers) {
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
      run: plugin('library_apply', 180000),
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
        ...target,
        template_ids: z.array(z.string()).min(1).max(8).describe('要看的作品 template_id。'),
        animated: z.boolean().optional().describe('看动图（gif）而不是静态封面，默认 false；动图较大。'),
      },
      run: async (a) => {
        const { project_path, instance_id, template_ids, animated = false } = a;
        const rows = await d.callPlugin('works_covers', { template_ids }, await homeWindow({ project_path, instance_id }));
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
          } finally {
            d.downloads.cleanup({ paths: [got.root] });
            if (fs.existsSync(dest)) d.downloads.record({ path: path.resolve(dest), template_id, title: got.title });
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
