# xiangsu-mcp-ext

给像塑（Douyin AR，macOS）的官方 MCP 补上「官方素材库」能力：让 AI 能浏览、搜索官方素材（脸部变形、美型、AI 实时变脸、美妆、滤镜、贴纸、画面特效等），并把素材按素材库面板相同的流程应用到工程里。场景编辑、预览、保存仍用像塑自带的 `xiangsu-mcp-manager`。

## 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 编辑器插件 `CursorXiangsuExt` | `editor-plugin/` | 像塑用户插件，在每个工程窗口里开一个只监听 `127.0.0.1`、带随机令牌的 RPC 服务，调用编辑器自身的素材库模块 |
| MCP 服务 | `src/server.mjs` | stdio MCP，把 RPC 包装成工具；按工程路径找到对应窗口 |
| 开发脚本 | `scripts/` | 安装插件、直调插件、直调官方 MCP、端到端检查 |

插件运行时把 `{pid, port, token}` 写到 `~/.xiangsu-mcp-ext/instances/<pid>.json`（权限 600），日志在 `~/.xiangsu-mcp-ext/logs/plugin.log`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `ext_status` | 列出已加载插件的工程窗口 |
| `library_nav` | 可应用的素材面板（`panel_key`）；AI 生成类（扣额度）面板不暴露 |
| `library_list` | 分页列出某面板的素材 |
| `library_search` | 关键词搜索，范围与素材库面板搜索一致 |
| `library_apply` | 下载素材包 → 校验 MD5 → `AssetPackageManager.import` 导入并放进场景（在撤销组内） |

`library_apply` 只接受本会话里 `library_list` / `library_search` 返回过的 `template_id`。应用后用官方 MCP 的 `get_scene` / `inspect` 读回对象，用 `capture_preview` 或 `interact_by_dsl`（先 `wait` 2–3 秒再截图，预览重载有延迟）验收。

## 安装

```bash
npm ci
node scripts/install.mjs          # 装到 ~/Library/Application Support/DouyinAR/Plugins/v<版本>/Local
```

然后在 `~/.cursor/mcp.json` 里加：

```json
"xiangsu-mcp-ext": {
  "command": "/Users/muqian/.nvm/versions/node/v24.21.0/bin/node",
  "args": ["/Users/muqian/Downloads/xiangsu-mcp-ext/src/server.mjs"]
}
```

插件只在安装后**新打开的工程窗口**里加载；已开着的窗口要保存后关掉重开。插件直接 `require` 本仓库的 `editor-plugin/runtime.cjs`，所以安装后不要挪动仓库目录。

## 开发

- `npm test`：用模拟的编辑器模块测素材库逻辑和 MCP 工具转发。
- `config.local.json` 里 `devEval: true` 时，插件额外提供 `describe` / `eval` / `reload`，用于在运行时读编辑器模块源码（`scripts/dump-source.js`）和热加载 `library.cjs`。**日常使用保持 `false`**：`eval` 能在编辑器进程里执行任意代码。
- `node scripts/call.mjs <method> '<json>' [--pid N]`：直调插件。
- `node scripts/official-call.mjs <tool> '<json>'`：直调像塑官方 MCP（截图落盘到临时目录）。
- `node scripts/e2e.mjs <工程路径> <关键词> [标题]`：经 stdio MCP 跑一遍搜索 + 应用 + 未知 ID 报错。会真的往该工程里导入素材，只对测试工程用。

## 依赖的编辑器内部接口（像塑 9.7.2 实测）

不是公开 API，像塑升级后可能变化；失效时用 `devEval` 重新导出源码核对。

- 素材库：`@orion/Business/AssetsLibrary/Core/Api/{getAssetCategory,getAssetList,search}`，导航 `.../Control/AssetsLibraryNav/{util,const}`
- 下载：`.../Control/util.downloadLokiFile`，包缓存在 `Shared/Resources/LokiDownload/assets/<templateId>.ehpackage`
- 导入：`@orion/orion-sdk/EditorFramework` 的 `Resource.AssetPackageManager.instance.import`、`UndoSystem`、`PreviewSyncer`；场景取自 `@orion/Business/Common/Scene` 的 `SceneModule.getEditingSceneService()`
