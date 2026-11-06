# xiangsu-mcp-ext

给像塑（Douyin AR，macOS）的官方 MCP 补上官方 MCP 够不到的编辑器能力：

- 官方素材库：浏览、搜索、看封面、应用（脸部变形、美型、AI 实时变脸、美妆、滤镜、贴纸、画面特效等），流程与素材库面板相同。
- 「添加对象」菜单：工具栏美妆 / 美型 / AI 实时变脸里的全部官方功能项（美容、面部生成、表情生成、性别年龄、五官处理、身体换装等），按菜单项 ID 添加。
- 塑型画笔（FaceWarpX）强度：官方 MCP 能读不能写，这里按检查器滑块的方式改。

场景编辑、预览、保存仍用像塑自带的 `xiangsu-mcp-manager`。

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
| `ext_status` | 列出已加载插件的工程窗口，附每个窗口的编辑器接口自检结果（`self_check.ok` / `missing`） |
| `library_nav` | 可应用的素材面板（`panel_key`）；AI 生成类（扣额度）面板不暴露 |
| `library_list` | 分页列出某面板的素材 |
| `library_search` | 关键词搜索，范围与素材库面板搜索一致 |
| `library_preview` | 一次最多 8 个素材的封面图，直接以图片返回，供按画面挑选 |
| `library_apply` | 下载素材包 → 校验 MD5 → `AssetPackageManager.import` 导入并放进场景（在撤销组内） |
| `menu_list` | 列出「添加对象」菜单的全部功能项（menu_id、中文名、路径、类型），可按关键词过滤；云端 AI 生成项不暴露 |
| `menu_add` | 按 menu_id 添加，与菜单点选等效：普通项走编辑器的 `createEntity`，带素材包的动态项（表情生成等）走编辑器的下载导入；核对场景对象确实增加 |
| `face_warp_list` | 列出场景里的塑型画笔组件及每项画笔强度 |
| `face_warp_set_intensity` | 改塑型画笔强度（0–100），只换强度、保留笔刷数据，在撤销组内；路径有歧义或写入未生效时报错 |

`library_search` 按面板逐个搜索：素材库搜索接口按「组」请求时每组只回 5 条且不支持翻页，逐个面板请求才能拿全（实测「3D 变形」搜「大」7 条、「跟脸贴纸」搜「耳」148 条，与全量列表比对一致）。

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

更新代码后：

- 只改 `editor-plugin/library.cjs`（素材库逻辑、新增 RPC 方法写进它的 `METHODS`）：插件在下次调用时按修改时间自动重载，不用重开窗口；改坏了会返回 `LIBRARY_RELOAD_FAILED`，旧版本继续运行。
- 改 `editor-plugin/runtime.cjs`：要重开工程窗口。
- 改 `src/`：要在 Cursor 设置里把 `xiangsu-mcp-ext` 关掉再打开。

## 开发

- `npm test`：用模拟的编辑器模块测素材库逻辑和 MCP 工具转发。
- `config.local.json` 里 `devEval: true` 时可用 `dev_eval`（在编辑器进程里执行一段探测代码，`scripts/call.mjs dev_eval '{}' --code-file x.js`）；该开关每次调用时读取，改成 `false` 立即失效，不用重开窗口。窗口启动时 `devEval` 为 `true` 的话还会多出 `describe` / `eval`。**日常使用保持 `false`**：它能在编辑器进程里执行任意代码。
- `node scripts/call.mjs <method> '<json>' [--pid N]`：直调插件。
- `node scripts/mcp-call.mjs <tool> '<json>' [...]`：新起一个 stdio 服务按顺序调工具，图片落盘到临时目录；验证 `src/` 改动不必重启 Cursor 里的服务。
- `node scripts/official-call.mjs <tool> '<json>'`：直调像塑官方 MCP（截图落盘到临时目录）。
- `node scripts/e2e.mjs <工程路径> <关键词> [标题]`：经 stdio MCP 跑一遍搜索 + 应用 + 未知 ID 报错。会真的往该工程里导入素材，只对测试工程用。

## 依赖的编辑器内部接口（像塑 9.7.2 实测）

不是公开 API，像塑升级后可能变化。完整清单是 `editor-plugin/library.cjs` 的 `REQUIRED`，`ext_status` 会逐项核对；缺项时用 `devEval` 重新导出源码找替代。

- 素材库：`@orion/Business/AssetsLibrary/Core/Api/{getAssetCategory,getAssetList,search}`，导航 `.../Control/AssetsLibraryNav/{util,const}`
- 下载：`.../Control/util.downloadLokiFile`，包缓存在 `Shared/Resources/LokiDownload/assets/<templateId>.ehpackage`
- 导入：`@orion/orion-sdk/EditorFramework` 的 `Resource.AssetPackageManager.instance.import`、`UndoSystem`、`PreviewSyncer`；场景取自 `@orion/Business/Common/Scene` 的 `SceneModule.getEditingSceneService()`
