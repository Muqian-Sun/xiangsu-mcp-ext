#!/usr/bin/env node
// stdio MCP server exposing 像塑's official asset library through the CursorXiangsuExt editor plugin.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callPlugin, listInstances } from './bridge.mjs';

const projectPath = z
  .string()
  .optional()
  .describe('目标工程的绝对路径（与官方 MCP get_project_context 返回的 project_path 相同）。只开了一个像塑工程窗口时可省略。');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function sniffImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw Error(`image too large: ${buf.length} bytes`);
  const mimeType = sniffImage(buf);
  if (!mimeType) throw Error(`not a png/jpeg/gif/webp image (content-type ${res.headers.get('content-type')})`);
  return { data: buf.toString('base64'), mimeType };
}

function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error) {
  return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
}

export function createServer(call = callPlugin, instances = listInstances, getImage = fetchImage) {
  const server = new McpServer({ name: 'xiangsu-mcp-ext', version: '0.1.0' });
  const tool = (name, description, shape, method, timeoutMs) =>
    server.registerTool(name, { description, inputSchema: shape }, async ({ project_path, ...params }) => {
      try {
        return text(await call(method, params, { projectPath: project_path, timeoutMs }));
      } catch (e) {
        return failure(e);
      }
    });

  server.registerTool(
    'ext_status',
    {
      description:
        '列出已加载 CursorXiangsuExt 插件的像塑工程窗口（pid、当前工程路径）及每个窗口的编辑器接口自检结果。工具报找不到实例或 INCOMPATIBLE_EDITOR 时先调用它排查；插件只在装好后新打开的工程窗口里生效，self_check.ok=false 说明像塑升级改了内部接口，missing 列出缺失项。',
      inputSchema: {},
    },
    async () => {
      try {
        const live = instances();
        const rows = await Promise.all(
          live.map(async (s) => {
            const st = await call('status', {}, { pid: s.pid, timeoutMs: 5000 });
            const check = await call('self_check', {}, { pid: s.pid, timeoutMs: 5000 }).catch((e) => ({
              ok: false,
              error: `${e.message}（该窗口里的插件是旧版本，保存后重开工程窗口即可）`,
            }));
            return { pid: s.pid, project_path: st.projectPath, self_check: check };
          }),
        );
        return text(rows);
      } catch (e) {
        return failure(e);
      }
    },
  );

  tool(
    'library_nav',
    '列出像塑官方素材库里可直接应用的分类面板（panel_key），例如 3d_distortion=脸部变形/3D 变形、distortion=美型、gaoguai_gan/makeup_gan=AI 实时变脸、3d_makeup=美妆、3d_filter=滤镜、sticker=跟脸贴纸。需要扣额度的 AI 生成类面板不在其中。',
    { project_path: projectPath },
    'library_nav',
  );

  tool(
    'library_list',
    '分页列出某个官方素材面板里的素材。返回该面板的子分类、素材列表（template_id、title、cover_url 等）和翻页游标。拿到 template_id 后用 library_apply 应用。',
    {
      project_path: projectPath,
      panel_key: z.string().describe('library_nav 返回的 panel_key。'),
      category_id: z.string().optional().describe('子分类 ID；省略时使用第一个子分类（通常是「全部」）。'),
      cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页返回的 next_cursor。'),
      count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30。'),
    },
    'library_list',
  );

  tool(
    'library_search',
    '按关键词搜索官方素材库（与素材库面板的搜索一致，覆盖美妆、滤镜、脸部变形、贴纸、画面特效等），返回 template_id、title、panel_key。',
    { project_path: projectPath, query: z.string().min(1).describe('搜索关键词，如「芒果脸」「小屁桃」「腮红」。') },
    'library_search',
  );

  server.registerTool(
    'library_preview',
    {
      description: '查看官方素材的封面图，用于按画面挑选素材。一次最多 8 个，template_id 必须来自本会话里 library_list 或 library_search 的结果。返回每个素材的名称和封面图片；单个封面下载失败时只在该项写明原因。',
      inputSchema: {
        project_path: projectPath,
        template_ids: z.array(z.string()).min(1).max(8).describe('要看封面的 template_id 列表。'),
      },
    },
    async ({ project_path, template_ids }) => {
      try {
        const covers = await call('library_covers', { template_ids }, { projectPath: project_path });
        const content = [];
        for (const c of covers) {
          content.push({ type: 'text', text: `${c.title}（template_id ${c.template_id}）` });
          if (!c.cover_url) {
            content.push({ type: 'text', text: '无封面图' });
            continue;
          }
          try {
            content.push({ type: 'image', ...(await getImage(c.cover_url)) });
          } catch (e) {
            content.push({ type: 'text', text: `封面下载失败：${e.message}` });
          }
        }
        return { content };
      } catch (e) {
        return failure(e);
      }
    },
  );

  tool(
    'library_apply',
    '把一个官方素材应用到目标工程：下载素材包、校验 MD5、按素材库面板相同的流程导入，并默认放进当前场景（可在编辑器里撤销）。template_id 必须来自本会话里 library_list 或 library_search 的结果。应用后用官方 MCP 的 get_scene / inspect 读回新增对象，用 capture_preview 验收。',
    {
      project_path: projectPath,
      template_id: z.string().describe('library_list / library_search 返回的 template_id。'),
      auto_instantiate: z.boolean().optional().describe('是否自动放进场景，默认 true；false 时只导入到资源面板。'),
    },
    'library_apply',
    180000,
  );

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  await createServer().connect(new StdioServerTransport());
}
