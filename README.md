# xiangsu-mcp-ext

[![test](https://github.com/Muqian-Sun/xiangsu-mcp-ext/actions/workflows/test.yml/badge.svg)](https://github.com/Muqian-Sun/xiangsu-mcp-ext/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey) ![node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

像塑（Douyin AR，macOS）的 MCP 扩展：**一个 MCP 服务**同时提供像塑官方 MCP 的全部工具，以及官方 MCP 够不到的编辑器能力。

- 官方工具原样转发（`get_scene`、`edit_by_dsl`、`capture_preview`、`save_project` 等），像塑重启后自动重连，官方工具列表变化时通知客户端刷新。
- 官方素材库：浏览、搜索、看封面、应用（脸部变形、美型、AI 实时变脸、美妆、滤镜、贴纸、画面特效等），流程与素材库面板相同。
- 「添加对象」菜单：工具栏美妆 / 美型 / AI 实时变脸里的全部官方功能项（美容、面部生成、表情生成、性别年龄、五官处理、身体换装等），可看示意图后按菜单项 ID 添加。
- 首页作品：浏览、搜索、看封面，下载完整工程到本地或直接在编辑器里打开（官方工程和已发布的作品），供 agent 读取场景、脚本和资源，学习别人的做法；下载的东西都有登记，用完即删，最长保留 24 小时。
- 交付：设置图标、特效检测（本地 + 云端）、打开提交窗口（发布由你在窗口里确认）、手机预览二维码、浏览任务并绑定已领取的任务或创作灵感。
- 抖音音乐：按分类或关键词找歌，设为特效音乐。
- 塑型画笔（FaceWarpX）强度：官方能读不能写，这里按检查器滑块的方式改。
- 工程窗口：新建空白工程（首次保存到指定目录）、打开、关闭。
- 干净删除：删除对象时找出只被它使用的资源和它导入时带进来的素材包文件夹，确认后删除。

> 非官方项目，与字节跳动 / 抖音无关。依赖像塑编辑器的内部模块（9.7.2 实测），像塑升级后可能失效；`ext_status` 会逐项自检并列出缺失的接口。仓库不包含任何像塑的程序、代码或素材。

## 工作方式

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 编辑器插件 `XiangsuMcpExt` | `editor-plugin/` | 像塑用户插件。每个工程窗口里开一个只监听 `127.0.0.1`、带随机令牌的 RPC 服务，调用编辑器自身的模块 |
| MCP 服务 | `src/server.mjs` | stdio MCP。转发官方 MCP（`http://127.0.0.1:17320/mcp`），并把插件能力包装成工具 |

插件把 `{pid, port, token}` 写到 `~/.xiangsu-mcp-ext/instances/<pid>.json`（权限 600），日志在 `~/.xiangsu-mcp-ext/logs/plugin.log`，导入记录在 `~/.xiangsu-mcp-ext/imports/`。

## 工具

官方 MCP 的工具按原名提供。扩展工具都接受 `project_path` 或官方的 `instance_id` 指定工程（只开一个工程窗口时可省略）：

| 工具 | 作用 |
| --- | --- |
| `ext_status` | 官方 MCP 连接状态；每个工程窗口的 pid、工程路径、instance_id、编辑器接口自检 |
| `project_open` / `project_new` / `project_close` | 打开已有工程、新建空白工程并保存到指定目录、关闭工程窗口（有未保存改动时默认拒绝） |
| `library_nav` / `library_list` / `library_search` | 官方素材库面板、分页列表、关键词搜索（逐个面板查询以拿全结果） |
| `library_preview` | 一次最多 8 个素材的封面图 |
| `library_apply` | 下载素材包、校验 MD5、导入并放进场景（可撤销）；返回新增对象和素材包文件夹 |
| `works_nav` / `works_list` / `works_search` | 首页作品分类（推荐、官方工程、新手必做、游戏、妆容、AI玩法…）、分页列表（可按推荐 / 最新 / 使用量排序）、按作品名搜索 |
| `works_preview` | 一次最多 8 个作品的封面，`animated=true` 看动图 |
| `works_download` | 下载并解压完整工程（与首页点开作品同一流程，但不开窗口），返回工程目录和文件清单；`dest` 给定时把工程放到该目录 |
| `works_open` | 下载并在新窗口里按首页的方式打开（不弹版本升级提示，工程处于未保存状态），返回 pid 和 instance_id |
| `works_cleanup` | 删除下载过的作品（含 `dest`）；编辑器窗口开着的保留，其它路径一律拒绝 |
| `icon_set` / `icon_open` | 把一张图片裁成 360×360 PNG 设为工程图标（默认女性、男性两版，提交窗口要这两个）；或打开「图标制作」窗口 |
| `effect_check` | 本地检查包体上限、是否原样套用模板、登录、图标；`cloud=true` 再跑「特效检测」云端性能检测（会上传特效包做测试） |
| `submit_prepare` | 本地检查通过后走「提交特效」按钮的入口，只打开提交窗口；上传发布只在你点确认时发生 |
| `mobile_preview` | 按手机预览方式打包上传到抖音预览服务，返回和编辑器一样的二维码（7 天有效），抖音 App 扫码真机看 |
| `tasks_list` / `task_bind` | 活动和特效任务列表；已领取的任务按任务详情页「去创作」的方式重开工程绑定（领取要在 App 里做） |
| `inspiration_detail` / `inspiration_bind` | 按 ID 看创作灵感，绑定到当前工程 |
| `music_categories` / `music_list` / `music_apply` | 抖音音乐分类、搜索（带版权标记），按音乐库「使用」套用，可截取片段 |
| `menu_list` / `menu_preview` / `menu_add` | 「添加对象」菜单项列表、说明和示意图、按菜单项添加（可撤销）；云端 AI 生成项不暴露 |
| `face_warp_list` / `face_warp_set_intensity` | 列出塑型画笔、改强度（保留笔刷数据，可撤销） |
| `object_remove` | 删除对象（可撤销），报告只被它使用的资源和它导入时带来的素材包文件夹；`delete_unused_resources=true` 时一并删除 |
| `resource_delete_unused` | 删除 `object_remove` 报告的路径；场景仍在引用的一律拒绝 |

使用顺序示例：

- 套用官方素材：`library_search` → `library_preview` → `library_apply` → `capture_preview` → `save_project`。
- 读别人的工程：`works_search`（或 `works_list`）→ `works_preview` → `works_download` → 按返回的 `outline.files` 读 `effect.dyehpj`、`Assets/` 下的场景和 `Graph/` 下的脚本 → `works_cleanup`。
- 在编辑器里看别人的效果：`works_open` → `get_scene` / `capture_preview` → `project_close`（`discard_changes=true`）→ `works_cleanup`。
- 交付：`icon_set` → `effect_check`（可加 `cloud=true`）→ `mobile_preview` 真机看 → `save_project` → `submit_prepare`，在提交窗口里填名称并确认发布。要参加任务的，先 `tasks_list` → `task_bind`。

几点约定：

- `library_apply` 只接受同一工程窗口里 `library_list` / `library_search` 返回过的 `template_id`（窗口重开或扩展代码更新后需重新搜索）；`works_preview` / `works_download` / `works_open` 只接受本会话里 `works_list` / `works_search` 返回过的作品（记录在 MCP 服务里，不受工程窗口开关影响，重启服务后需重新搜索）。
- 像塑最多同时开 2 个工程窗口（编辑器的 `CHILD_PROCESS_LIMIT`）。都占满时 `project_open` / `project_new` / `works_open` 直接返回 `WINDOW_LIMIT`，先 `project_close` 一个；不检查的话首页只会弹警告，窗口永远不来。
- `works_*` 与当前工程无关，任意一个工程窗口开着即可；不指定工程时由 pid 最小的窗口处理。
- `works_download` / `works_open` 走编辑器自己的下载流程，每次解压一份新的到像塑实例目录的 `ProjectCreatedTmp/CreatedFromTemplate/<guid>/` 下。`dest` 副本不含 `Library/` 缓存（编辑器打开时会重建）。
- 下载物不留痕：
  - 编辑器缓存在 `~/Library/Application Support/DouyinAR/Shared/Resources/LokiDownload/TemplateResources/` 的工程包，解压后立即删除（下载前已存在的视为你自己在首页用过的缓存，不动）。
  - 给了 `dest` 时，临时目录里那份随即删除。
  - 每份下载（临时目录或 `dest`）登记在 `~/.xiangsu-mcp-ext/works-downloads.json`。`works_cleanup` 随时删除；没删的在 24 小时后由下一次下载自动清掉（这个时长是拍的：够一个工作日内学完，又不至于堆积，可按需调 `src/works.mjs` 的 `DOWNLOAD_TTL_MS`）。
  - 编辑器窗口正开着的下载不会被删；像塑关窗时不会自己删除这些目录，关窗后再调 `works_cleanup`。
- 预览重载有延迟，应用后用 `interact_by_dsl` 先 `wait` 2–3 秒再截图更稳。
- 资源删除不可撤销；对象删除可以在编辑器里撤销，但已删除的资源不会回来。
- 「孤儿资源」只按场景直接引用判断（资源的编辑器 guid 是否出现在场景序列化数据里）。只通过材质等间接引用的资源不会被判为孤儿。

## 安装（macOS）

需要 Node.js 24+ 和已安装的像塑。

```bash
git clone https://github.com/Muqian-Sun/xiangsu-mcp-ext.git
cd xiangsu-mcp-ext
npm ci
node scripts/install.mjs   # 装到 ~/Library/Application Support/DouyinAR/Plugins/v<版本>/Local
```

在 MCP 客户端配置里加一个 stdio 服务（`command` 用 `which node` 的绝对路径）：

```json
{
  "mcpServers": {
    "xiangsu": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/xiangsu-mcp-ext/src/server.mjs"]
    }
  }
}
```

它已经包含官方工具，不必再单独配置官方的 `xiangsu-mcp-manager`。如果你还在用像塑自带的 `xiangsu-effect-editor` skill，它要求客户端里存在名为 `xiangsu-mcp-manager` 的服务；这种情况下保留官方配置即可，两者可以并存。

插件只在安装后**新打开的工程窗口**里加载；已开着的窗口要保存后重开。插件直接 `require` 本仓库的代码，安装后不要挪动仓库目录。

### 更新后怎么生效

- 改 `editor-plugin/library.cjs` 或 `editor-plugin/features/*.cjs`：插件在下次调用时按修改时间自动重载，不用重开窗口；改坏了返回 `LIBRARY_RELOAD_FAILED`，旧版本继续运行。新增插件方法写进对应 feature 的 `METHODS`。
- 改 `editor-plugin/runtime.cjs`：重开工程窗口。
- 改 `src/`：在 MCP 客户端里重启这个服务。

## 开发

- `npm test`：用模拟的编辑器模块测插件逻辑；用内存传输测 MCP 工具、官方转发、工程窗口编排。
- `node scripts/mcp-call.mjs <tool> '<json>' [...]`：新起一个服务按顺序调工具，图片落盘到临时目录。
- `node scripts/call.mjs <method> '<json>' [--pid N]`：直调插件。
- `node scripts/e2e.mjs <工程路径> <关键词> [标题]`：搜索 + 应用 + 未知 ID 报错的端到端检查（会真的导入素材，只对测试工程用）。
- `config.local.json` 里 `devEval: true` 时可用插件方法 `dev_eval` 在编辑器进程里执行探测代码（`scripts/call.mjs dev_eval '{}' --code-file x.js`，`scripts/dump-source.js` 可导出模块源码）。开关每次调用时读取，改回 `false` 立即失效。**日常使用保持 `false`**：它能在编辑器进程里执行任意代码。
- 环境变量 `XIANGSU_MCP_EXT_STATE` 可改状态目录（测试用），`XIANGSU_MCP_URL` 可改官方 MCP 地址。

### 依赖的编辑器内部接口

完整清单在 `editor-plugin/features/assets.cjs` 的 `REQUIRED`（按功能分组），`ext_status` 会逐项核对。主要有：

- 素材库：`@orion/Business/AssetsLibrary/Core/Api/{getAssetCategory,getAssetList,search}`、`.../Control/AssetsLibraryNav/{util,const}`、`.../Control/util.downloadLokiFile`
- 导入：`@orion/orion-sdk/EditorFramework` 的 `Resource.AssetPackageManager.instance.import`、`UndoSystem`、`PreviewSyncer`
- 菜单：`@orion/orion-sdk/orionui` 的 `ExtensionManager` / `I18n`，`DynamicMenuConfigInfo`，`SceneOpsService.createEntity`，`HoverTipsMap`
- 工程窗口：`OpenProjectFromHomeCommand` + `EditSender`，`closeProjectAndBackToHome`
- 首页作品：`@orion/Business/HomeWindow/TemplatesPanel/Request/{templatesPanel,templatesCategory}`、`.../Model/util.transformTemplate`、`.../Model/DownloadTemplateModel`；打开作品用 `OpenProjectFromHomeCommand` 的 `openTemplate`
- 交付：`IconCreationNew/controller/IconPreviewManager`、`Submission/SubmissionExtension/EffectSubmissionExtension`（提交接口 `submit()` 只做前置检查并打开提交窗口）、`PerfTest/PerfTestExtension`、`EditWindow/ToolBar/MobilePreview/backendHelper`、`effectExporter.exportEffectPackage`
- 任务与灵感：`BusinessCommon/UrlConst` 的 `kActivityAPI` / `kTaskListAPI`、`HomeWindow/ActivityCenter/Common/types`、`InspirationDetail/Core/Api/InspirationDetail`、`Agent/AgentInspirationBridge`
- 音乐：`EditWindow/Inspector/MusicLibrary/{Model/MusicCategoryModel,Model/MusicListModel,Component/MusicListComponent/MusicSquareManager}`

## 协议与声明

代码以 [MIT 协议](LICENSE) 开源。另外请注意：

- 本项目是个人开发的非官方工具，与字节跳动、抖音、像塑没有任何关联，也未获其认可或支持。「像塑」「抖音」「Douyin AR」等名称和商标归各自权利人所有。
- 仓库只包含本项目自己的代码，不包含像塑的程序、源码或任何素材。通过本工具访问的官方素材、首页作品，其版权归像塑或原作者所有，使用须遵守像塑 / 抖音的用户协议和平台规则。
- 首页作品只建议用于学习参考：不要把下载的工程、素材原样或稍作修改后重新发布，也不要把它们放进公开仓库。学完用 `works_cleanup` 删除。
- 本工具调用的是编辑器内部接口，可能随像塑升级失效，也可能被平台限制。使用风险自负，作者不对因使用本工具造成的账号、数据或作品损失负责（详见 MIT 协议的免责条款）。

## English

Unofficial MCP extension for Douyin AR (像塑) on macOS. One stdio MCP server proxies every tool of the editor's official MCP (with automatic reconnects) and adds what the official server cannot do: browse/search/preview/apply official library assets, browse/search/download or open the homepage works (official projects and published effects) as full projects an agent can read and learn from (every download is registered and deleted by works_cleanup or after 24 hours), add any item of the editor's "add object" menu (toolbar makeup / reshape / AI face effects), set FaceWarpX brush intensity, prepare delivery (icon, local and cloud effect checks, opening the submit window — publishing stays a user click — phone preview QR codes, binding received creator tasks or inspirations), use Douyin music, open/create/close project windows, and remove objects together with resources only they used. It works through a small editor plugin that exposes a token-protected RPC on 127.0.0.1 inside each project window. Relies on editor internals (verified on 9.7.2); `ext_status` reports any missing internals. Install with `npm ci && node scripts/install.mjs`, then register `node src/server.mjs` as a stdio MCP server.

Licensed under [MIT](LICENSE). Not affiliated with or endorsed by ByteDance / Douyin; all product names and trademarks belong to their owners. The repository contains no editor code or assets. Official assets and homepage works accessed through this tool belong to 像塑 or their creators and are subject to the platform's terms; use downloaded works for learning only, delete them with works_cleanup when done, and do not redistribute them.
