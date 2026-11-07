# xiangsu-mcp-ext

[![test](https://github.com/Muqian-Sun/xiangsu-mcp-ext/actions/workflows/test.yml/badge.svg)](https://github.com/Muqian-Sun/xiangsu-mcp-ext/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey) ![node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

像塑（Douyin AR，macOS）的 MCP 扩展：**一个 MCP 服务**同时提供像塑官方 MCP 的全部工具，以及官方 MCP 够不到的编辑器能力。

- 官方工具原样转发（`get_scene`、`edit_by_dsl`、`capture_preview`、`save_project` 等），像塑重启后自动重连，官方工具列表变化时通知客户端刷新。唯一的例外是 `capture_preview`：9.8.1 起官方截图是给窗口里的预览区域拍照，窗口最小化或不可见时是黑的，这时改为重置预览、等到重载后的画面，从预览的渲染结果截取并缩小到官方的 320×569（不含界面元素）；窗口可见时照旧转发。
- 官方素材库：浏览、搜索、看封面、应用（脸部变形、美型、AI 实时变脸、美妆、滤镜、贴纸、画面特效等），流程与素材库面板相同；包括「素材广场」（其他创作者分享的现成 AI 图片、AI 妆容、自定义实时变脸、贴纸和素材包，应用时不重新生成、不扣额度）和自己的「收藏」。
- 「添加对象」菜单：工具栏美妆 / 美型 / AI 实时变脸里的全部官方功能项（美容、面部生成、表情生成、性别年龄、五官处理、身体换装等），可看示意图后按菜单项 ID 添加。
- AI 组合效果（用户拍照后在云端按工作流出图或出视频）：像 AI 效果窗口的「新建工作流」一样建工作流，交给官方工作流工具编辑，再像「应用」一样放进场景。
- 首页作品：浏览、搜索、看封面，下载完整工程到本地或直接在编辑器里打开（官方工程和已发布的作品），供 agent 读取场景、脚本和资源，学习别人的做法；下载的东西都有登记，用完即删，最长保留 24 小时。
- 交付：设置并上传图标、特效检测（和编辑器里点「特效检测」一样，云端检测）、填好提交窗口（名称、触发提示、摄像头方向、灵感、任务，一直走到「提交审核」页并等检测跑完；最后的「提交审核」由你来点）、手机预览二维码、把已领取的任务或创作灵感绑定到工程。
- 抖音音乐：按分类或关键词找歌，设为特效音乐。
- 灵感、任务、排行榜：首页「灵感」页签和活动中心的任务（征集任务、成长任务），以及像塑移动版才有的排行榜（年轻 / 男生 / 女生喜爱榜、每日投稿榜、热玩互动榜、跟拍榜，各榜按两级分类细分；热点榜；专题合集里两百多期主题特效榜和模板榜；创新计划月榜和官方精选），用编辑器里登录的账号读取；可收藏灵感、领取任务。
- 我的特效审核：自己提交过的特效和审核状态，审核不通过的具体原因和完整审核记录（编辑器里只显示「审核未通过」，原因原本只能在像塑移动版的审核记录页看到）。
- 塑型画笔（FaceWarpX）强度：官方能读不能写，这里按检查器滑块的方式改。
- 工程窗口：新建空白工程（首次保存到指定目录）、打开、关闭。
- 干净删除：删除对象时找出只被它使用的资源和它导入时带进来的素材包文件夹，确认后删除。

> 非官方项目，与字节跳动 / 抖音无关。依赖像塑编辑器的内部模块（9.7.2 实测），像塑升级后可能失效；`ext_status` 会逐项自检并列出缺失的接口。仓库不包含任何像塑的程序、代码或素材。

## 工作方式

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 编辑器插件 `XiangsuMcpExt` | `editor-plugin/` | 像塑用户插件。每个工程窗口里开一个只监听 `127.0.0.1`、带随机令牌的 RPC 服务，调用编辑器自身的模块 |
| MCP 服务 | `src/server.mjs` | stdio MCP。转发官方 MCP（`http://127.0.0.1:17320/mcp`），并把插件能力包装成工具 |

插件把 `{pid, port, token, startedAt}` 写到 `~/.xiangsu-mcp-ext/instances/<pid>.json`（权限 600）。窗口崩溃或被强退时这份记录会留下来，所以只有该 pid 的进程还在、并且启动时间不晚于 `startedAt` 时才算开着的窗口；pid 被后来的进程复用时不算。日志在 `~/.xiangsu-mcp-ext/logs/plugin.log`，导入记录在 `~/.xiangsu-mcp-ext/imports/`。

## 工具

官方 MCP 的工具按原名提供。扩展工具都接受 `project_path` 或官方的 `instance_id` 指定工程（只开一个工程窗口时可省略）：

| 工具 | 作用 |
| --- | --- |
| `ext_status` | 官方 MCP 连接状态；每个工程窗口的 pid、工程路径、instance_id、编辑器接口自检 |
| `project_open` / `project_new` / `project_close` | 打开已有工程、新建空白工程并保存到指定目录、关闭工程窗口（有未保存改动时默认拒绝） |
| `image_view` | 看图：其它工具只返回图片地址（`cover_url`、`gif_url`、灵感 `images`、任务内容块的 `source`、菜单示意图等），要看画面时把地址或本机图片路径交给它；一次最多 8 张，动图等大图一次给不完时把没给的列在 `not_returned` 里（单次响应不超过 MCP stdio 的 10 MiB 上限） |
| `library_nav` / `library_list` / `library_search` | 官方素材库面板（含素材广场、收藏）、分页列表、关键词搜索：逐个面板查标题以拿全结果；词正好是面板名或子分类名时也带出那里的素材（「滤镜」「腮红」「复古滤镜」），按标题匹配程度排序，`queries` 一次搜多个词，返回各面板条数和展开了哪些分类，结果缓存 10 分钟供翻页；每条素材带 `kind`、封面 `cover_url` 和命中方式 `matched` |
| `library_images` | 一张 AI 图片卡片的整组结果图地址（按 `image_index` 编号） |
| `library_apply` | 下载素材包、校验 MD5、导入并放进场景（可撤销）；素材广场卡片按 `kind` 走编辑器自己的应用流程（AI 图片可用 `image_index` 选第几张）；返回新增对象和素材包文件夹 |
| `works_nav` / `works_list` / `works_search` | 首页作品分类（推荐、官方工程、新手必做、游戏、妆容、AI玩法…）、分页列表（可按推荐 / 最新 / 使用量排序，`next_cursor` 原样传回翻页）、按作品名搜索（默认搜全部分类并合并去重，每条带 `found_in`；`queries` 一次搜多个词；按 `offset` 分页，结果缓存 10 分钟） |
| `works_by_effect` | 按特效 ID 查排行榜等处的特效在首页有没有工程（一次最多 20 个），逐个返回 `found` / `same_name` / `not_on_homepage` |
| `works_download` | 下载并解压完整工程（与首页点开作品同一流程，但不开窗口），返回工程目录和文件清单；`dest` 给定时把工程放到该目录 |
| `works_open` | 下载并在新窗口里按首页的方式打开（不弹版本升级提示，工程处于未保存状态），返回 pid 和 instance_id |
| `works_cleanup` | 删除下载过的作品（含 `dest`）；编辑器窗口开着的保留，其它路径一律拒绝 |
| `icon_set` / `icon_open` | 把一张图片裁成 360×360 PNG 设为工程图标（默认女性、男性两版，提交窗口要这两个），并像「图标制作」窗口的「完成」一样上传到特效平台（提交窗口只认上传过的图标）；或打开「图标制作」窗口 |
| `effect_check` | 和工具栏「特效检测」按钮一样：打开特效检测窗口做云端检测（会上传特效包做测试，不是发布），等待结果，并读出检测页的详情一起返回（页面结论、每项结论、包体积和安卓 / iOS 帧率对上限、没通过的项的改进建议），然后关掉窗口；详情读不出时窗口留着并返回 `details_error`；超时时窗口留着，下次调用先关掉它 |
| `submit_prepare` | 本地检查包体上限、是否原样套用模板、登录、图标，通过后先关掉还开着的提交窗口（之前调用留下的），再走「提交特效」按钮的入口打开一个新的，逐页填写：名称（必填）、触发提示、默认摄像头方向、灵感、任务和赛道（可用 `icon_image` 先设图标），翻到「提交审核」页并等页面检测跑完，返回摘要、检测结果、协议是否已同意和 `next`（你还要做什么）。每一项都从页面读回核对，页面截断、报错、没选上或翻页被拦时报 `SUBMIT_*` 错误，窗口保持打开。不勾协议，也不点「提交审核」 |
| `mobile_preview` | 按手机预览方式打包上传到抖音预览服务，返回和编辑器一样的二维码（7 天有效），抖音 App 扫码真机看；二维码同时存成文件（`~/.xiangsu-mcp-ext/mobile-qr/`），到期自动删除 |
| `inspiration_nav` / `inspiration_list` / `inspiration_detail` | 灵感分类、分页列表、详情（说明、图片、奖励、关联热点、同灵感特效、是否已收藏） |
| `inspiration_collect` | 收藏或取消收藏灵感（写账号），之后重新查询确认生效 |
| `inspiration_bind` | 把灵感绑定到当前工程，提交时带上 |
| `tasks_list` / `task_detail` | 活动与特效征集任务（`kind=effect`）、成长任务（`kind=growth`）的列表与详情（状态、奖励、完整任务说明） |
| `task_receive` | 领取一个待领取（`WAIT_RECEIVE`）的征集任务（写账号，不能撤销），其它状态直接拒绝 |
| `task_bind` | 已领取的任务按任务详情页「去创作」的方式重开工程绑定 |
| `rank_nav` / `rank_list` | 移动版排行榜的榜单、筛选项和两级分类（大类如人像美化、细类如美妆）；分页读榜（可按日期、每级一个分类、特效等级、面板、偏好、来自工具、年轻喜爱度过滤） |
| `rank_hotspots` | 热点榜；带 `topic_id` 时返回该热点下的灵感 |
| `rank_subjects` | 专题合集里按主题的特效榜（`kind=effect`，如「热爆美妆特效榜」「熊出没IP特效榜」）和模板榜（`kind=template`，如「歌词玩法模板榜」），分页或按 `keyword` 搜榜名；带 `subject_id` 时返回该榜全部特效 |
| `rank_creators_month` / `rank_innovation_picks` | 创新计划创作者月榜、官方精选（模板 / 特效） |
| `effects_mine` | 自己提交过的特效，最新的在前：审核状态、绑定的任务和灵感、能否编辑 / 申诉；审核未通过、测试未通过、申诉审核未通过的带上最近一条审核记录（去掉标记的原因正文、分条原因、链接） |
| `effect_reviews` | 一个自己的特效的完整审核记录：「上线审核」和「精选审核」两条时间线 |
| `music_categories` / `music_list` / `music_apply` | 抖音音乐分类、搜索（带版权标记），按音乐库「使用」套用，可截取片段 |
| `scene_tree` | 场景结构的缩进文本：渲染组、对象 guid、名称、是否隐藏、组件类型；可只看子树、控制层数。传 `project_dir` 时不开窗口，直接读工程的 `Assets/main.scene`（如 `works_download` 下载的作品），对象写成 `#序号` |
| `inspect_many` | 一次查看多个对象的组件参数，可按组件类型、属性名片段过滤，`{type, data}` 包装直接展开，绑定的资源和对象换成名称；`preset="key"` 只留关键参数（变换、显隐、强度/不透明度/颜色类、文字内容、绑定、脚本参数）。同样支持 `project_dir` |
| `makeup_layers` | 读工程目录里的全部美妆层（妆容层和美瞳），逐层给出区域、部位、平均色、男女强度、是否生效；部位先看层名，看不出时按贴图像素判断。`groups` 按眉、眼妆、美瞳、颊、轮廓、唇汇总，`absent` 列出整套妆没有的部位 |
| `preview_frames` | 按间隔连续截取预览，720×1280 原始分辨率（官方截图是 320×569），取自渲染结果，窗口在后台或最小化时也能截；默认先重置预览并等到重载后的画面再计时，截图期间临时恢复正常帧率（后台窗口平时 6 fps）；可依次换几个预览视频各截一组、截完切回，可按比例裁出局部；每帧存成文件并返回，默认 24 小时后删除。这四个工具都可传 `save_to` 把结果另存到目录长期保留 |
| `menu_list` / `menu_preview` / `menu_add` | 「添加对象」菜单项列表、说明和示意图、按菜单项添加（可撤销）；云端 AI 生成项不暴露（AI 组合效果用下面两个工具） |
| `ai_combine_new` | 新建一张「AI 组合效果」工作流，等同 AI 效果窗口的「新建工作流」：本地建 AI Graph，只有「输入图」「效果组合」两个节点且未连线，不联网、不扣额度、不建云端草稿；返回 `ai_graph_id` 和各节点的 `node_id`（与官方 `get_workflow_context` 的节点 ID 相同） |
| `ai_combine_apply` | 把一张 AI 工作流放进场景，等同「应用」（可撤销）：编辑器编译工作流、上传工作流文件，再添加「AI 组合效果」对象（没有 2D 前景时一并建「2D 前景」「2D 摄像机」）；不扣额度、不建草稿，生成过预览视频时一并上传供审核；编辑器拒绝时返回它的提示原文（如「请先连接效果组合器」）；返回新增对象和 `draft_id` |
| `face_warp_list` / `face_warp_set_intensity` | 列出塑型画笔、改强度（保留笔刷数据，可撤销） |
| `object_remove` | 删除对象（可撤销），报告只被它使用的资源和它导入时带来的素材包文件夹；`delete_unused_resources=true` 时一并删除 |
| `resource_delete_unused` | 删除 `object_remove` 报告的路径；场景仍在引用的一律拒绝 |

使用顺序示例：

- 套用官方素材：`library_search` → `image_view` 看 `cover_url` → `library_apply` → `capture_preview` → `save_project`。
- 读别人的工程：`works_search`（或 `works_list`）→ `image_view` 看 `cover_url` / `gif_url` → `works_download` → 按返回的 `outline.files` 读 `effect.dyehpj`、`Assets/` 下的场景和 `Graph/` 下的脚本 → `works_cleanup`。
- 在编辑器里看别人的效果：`works_open` → `get_scene` / `capture_preview` → `project_close`（`discard_changes=true`）→ `works_cleanup`。
- 交付：`icon_set` → `effect_check` → `mobile_preview` 真机看 → `save_project` → `submit_prepare`（`name`、`trigger_hint` 等），检查返回的摘要和 `next`，在窗口里点「提交审核」。要参加任务的，`tasks_list` → `task_receive` → 再 `tasks_list` → `task_bind`，或者直接在 `submit_prepare` 里传 `task`。
- 找选题：`rank_nav` → `rank_list`（如 `rank_type=1` 年轻喜爱榜、`categories=["人像美化","美妆"]`、`levels=["S","A+"]`）看什么在火；`rank_subjects`（`keyword="测一测"` 或 `kind="template"`）看各期主题榜；`rank_hotspots` → 带 `topic_id` 看热点灵感 → `inspiration_detail` → `image_view` 看图；`tasks_list` → `task_detail` 看征集要求和奖项 → `image_view` 看内容块里的参考图。
- 看榜上特效的工程：`rank_list` → 把这页的 `effect_id` 和 `name` 交给 `works_by_effect` → `status=found` 的用返回的 `template_id` 走 `works_download` / `works_open`。
- 查审核结果：`effects_mine` 看哪些没过、`review.text` 是原因 → 要看整条时间线用 `effect_reviews`；`can_edit=true` 的在编辑器「拍摄特效管理」里点「编辑」改完重新提交。
- 拆别人的妆：`works_download` → `makeup_layers` 看用了哪些部位、什么颜色、多浓；自己的工程 `save_project` 后同样用 `makeup_layers` 查缺了哪些部位。
- 做 AI 组合效果：`ai_combine_new` → 官方 `get_workflow_capabilities`（选生图基模）→ `apply_workflow_patch`（加生图节点、写 prompt、连「输入图 → 生图 → 效果组合」）→ 要看效果时官方 `generate_workflow`（扣额度）→ `ai_combine_apply` → `save_project`。别人的作品怎么搭的，用 `works_download` 下载「AI玩法」分类里的工程，看 `Assets/AI 组合效果/*.oAICombineTextureJSA` 里的 `workflow` 和 `Graph/graph.json` 里的 AI Graph。

几点约定：

- `library_apply` / `library_images` 只接受本会话里 `library_list` / `library_search` 返回过的 `template_id`；`works_download` / `works_open` 只接受本会话里 `works_list` / `works_search` / `works_by_effect` 返回过的作品（记录在 MCP 服务里，不受工程窗口开关影响，重启服务后需重新搜索）。
- 像塑最多同时开 2 个工程窗口（编辑器的 `CHILD_PROCESS_LIMIT`）。都占满时 `project_open` / `project_new` / `works_open` 返回 `WINDOW_LIMIT`（首页进程答复 `reuseCurrent`，工具不会把工程换进当前窗口），先 `project_close` 一个。
- 素材的 `kind`：`package` 素材包、`ai_image` AI 图片、`ai_makeup` AI 妆容（按部位建多个对象）、`custom_gan` 自定义实时变脸、`foreground_sticker` / `face_sticker` 图片贴纸、`filter` 滤镜。素材广场里没有可应用内容的卡片（编辑器点应用也没反应）不列出，只在 `unsupported` 里计数。素材广场单个关键词最多返回 1000 条。广场卡片是异步应用的，工具等对象出现在场景里（最长 60 秒）才返回；新建的渲染组（如「2D 前景」「AI 实时变脸 (1)」）会作为新增对象报告，删除它们用官方的 `delete_render_group`。
- 素材库的搜索接口只匹配标题，很多素材的名字里没有人们会搜的词（美妆 › 腮红里是「雾堇胭」「红玫瑰」，没有素材叫「滤镜」），所以 `library_search` 还会展开名字与搜索词相同的面板或子分类，以及「子分类 + 面板」组合（「复古滤镜」）；「面板 + 其它词」（「韩系滤镜」）只在该面板里按标题搜「韩系」。名字只是包含搜索词的子分类不展开，列在 `related_categories`。每个面板或子分类最多取 300 条（实测子分类 17–125 条）。什么都没匹配到时返回 `hint`。
- `works_*`、`inspiration_*`、`task_*`、`rank_*`、`effects_mine`、`effect_reviews` 与当前工程无关，任意一个工程窗口开着即可；不指定工程时由 pid 最小的窗口处理。
- 灵感、任务、排行榜按编辑器首页活动中心的方式请求（编辑器的登录 Cookie 和签名请求头），读写的都是编辑器里登录的账号。排行榜用的是像塑移动版的接口，榜单名和筛选项取值与移动版一致，后端改版时可能失效。
- 几处上限是在服务端实测的：`rank_list` 和 `rank_subjects` 每页最多 20、`inspiration_list` 每页最多 50（100 会报错）、专题榜详情一次最多 20。移动版的「特效优秀视频榜」接口对所有榜单都返回空，没有提供。
- 审核记录：编辑器的「拍摄特效管理」（`/creator/v1/effect_list`）只有状态码，原因在像塑移动版的审核记录页（站内信「点击查看未过审原因」打开的 `effect.douyin.com/m/detail?showReviewList=1`）。工具按那个页面的方式取：「上线审核」先读 `review_nodes`（`review_type=1`），没有记录再读 `effect_reviews`；「精选审核」读 `review_nodes`（`review_type=2`）。2026-11-07 实测，被驳回的特效 `review_nodes` 不返回记录，原因来自 `effect_reviews`，如「特效不符合规范：特效中可能含有涉及展示或宣扬不同群体攻击对立类内容」。正文里的 `|<b>…<b>|`、`|<a><href>链接<href>文字<a>|` 等标记按页面的规则去掉，链接放进 `links`。分条原因 `refuse_reasons` 的结构取自页面代码，实测的特效还没带过。别人的特效和不存在的 ID，服务端一律报 `code=1301`（「参数不正确，请正确访问」）。
- `effects_mine` 翻页要把上一页返回的 `sort` 原样传回，`next_cursor` 就是它（传 `cursor` 或 `offset` 都只会拿到第一页，2026-11-07 实测）。服务端不给「还有没有」，工具按「这页满了就还有」判断，所以最后一页正好满页时 `has_more` 仍是 `true`，再翻一页得到空列表。每页上限 50 是拍的：每个未通过的特效要多一到两次请求。
- 只有作者分享到首页的特效才有工程可下载。排行榜的 `effect_id` 和首页作品的 `effect_id` 是同一套编号，`works_by_effect` 按 ID 精确匹配（与首页搜索框的「特效ID」搜索同一个接口，默认在「推荐」里查，首页在「官方工程」里不提供按 ID 搜）。按 ID 搜时「推荐」也能查到只出现在其它分类的作品（2026-11-07 实测 8 个全中，在它们自己的分类里按 ID 搜反而一个都查不到），所以不用跨分类查。
- 首页翻页除了 cursor 还要带上一页返回的 `sortingPosition` 和 `version`（编辑器首页就是这样翻的），只带 cursor 每一页都是第一页；`works_list` 的 `next_cursor` 把三者编在一起。按作品名搜索时，「推荐」翻到底只有约 300 条，「美化」「友友天地」等分类里还有它没有的（「头套」多 46 条、「美妆」多 87 条），所以 `works_search` 默认搜全部分类。服务端偶尔会提前结束一轮翻页（6 轮里有 1 轮停在 249 条），没到 300 条上限的分类会再翻一轮合并；服务端一直给同一页时停下，并把分类列在 `incomplete`。每个特效要一到两次请求（查不到 ID 且给了名字时再按名字搜一次），实测查一页 20 个用了约 10 秒。结果分三种：`found` 首页有这个特效的工程；`same_name` 首页没有它，只有同名作品，`effect_id` 不同，可能是别人的作品，不能当成同一个特效；`not_on_homepage` 作者没公开工程，没有正规途径能拿到（编辑器「我的特效」里的工程下载只对自己的特效开放）。2026-11-07 实测年轻喜爱榜第一页 20 个特效：10 个 `found`，1 个 `same_name`，9 个 `not_on_homepage`。
- 提交窗口是抖音特效平台的网页（`effect.douyin.com/ac/submit-orion`，每次在线加载，安装包里的离线版本较旧，字段也不同）。`submit_prepare` 按页面上的类名和文案找元素，页面改版后找不到时报 `SUBMIT_PAGE_CHANGED`，不会跳过。名称框会在页面的 `aiName` 配置请求回来时重新挂载，先填的内容会被清空（2026-11-07 实测，配置在表单出现约 1 秒后才回来），所以工具等这个请求完成再填，最后再用「提交审核」页的摘要核对一遍。灵感下拉只列当前账号收藏的灵感和热点，每次加载 10 条，不在列表里的用页面的搜索框找；选了和灵感所带任务不一致的任务时，页面会清掉灵感，工具会报 `SUBMIT_BINDING_NOT_APPLIED`。「特效发布设置」页上按账号出现的其它设置（活动、创新声明、作品授权）不填，列在 `other_sections`。
- `works_download` / `works_open` 走编辑器自己的下载流程，每次解压一份新的到像塑实例目录的 `ProjectCreatedTmp/CreatedFromTemplate/<guid>/` 下。`dest` 副本不含 `Library/` 缓存（编辑器打开时会重建）。
- 下载物不留痕：
  - 编辑器缓存在 `~/Library/Application Support/DouyinAR/Shared/Resources/LokiDownload/TemplateResources/` 的工程包，解压后立即删除（下载前已存在的视为你自己在首页用过的缓存，不动）。
  - 给了 `dest` 时，临时目录里那份随即删除。
  - 每份下载（临时目录或 `dest`）登记在 `~/.xiangsu-mcp-ext/works-downloads.json`。`works_cleanup` 随时删除；没删的在 24 小时后由下一次下载自动清掉（这个时长是拍的：够一个工作日内学完，又不至于堆积，可按需调 `src/works.mjs` 的 `DOWNLOAD_TTL_MS`）。
  - 编辑器窗口正开着的下载不会被删；像塑关窗时不会自己删除这些目录，关窗后再调 `works_cleanup`。
- AI 组合效果在工程里由三部分组成：场景里的「AI 组合效果」图片对象、它绑定的组合效果纹理（`Assets/AI 组合效果/*.oAICombineTextureJSA`，存编译好的 `workflow`、上传后的 `graphTosUri` 和云端草稿 `draftId`），以及 `Graph/graph.json` 里的 AI Graph。「添加对象」菜单里的 AI 组合效果只建对象和一张 `workflow` 为 `{}` 的空纹理，编辑器自己也是先建空壳、再由「应用」填参数，所以 `menu_add` 仍然拒绝它，改用 `ai_combine_new` / `ai_combine_apply`。哪些步骤会连到云端（2026-11-08 读编辑器代码；`ai_combine_new` 和 `ai_combine_apply` 不建草稿是实测，官方 Patch 建草稿、预览视频上传只读了代码，没有实测）：`ai_combine_new` 和本地连线都不联网；官方 `apply_workflow_patch` 每次改完都会把工作流存成账号下的云端 AI 效果草稿（`releaseAIEffect`），此后 `ai_combine_apply` 返回的 `draft_id` 就是这个草稿；官方 `generate_workflow` 扣生图额度；`ai_combine_apply` 上传工作流文件，生成过预览视频时把视频一并上传供审核，自己不建草稿。场景里有变声组件时编辑器拒绝「应用」，工具报 `AI_COMBINE_APPLY_NO_EFFECT`。
- 预览重载有延迟，应用后用 `interact_by_dsl` 先 `wait` 2–3 秒再截图更稳。
- 资源删除不可撤销；对象删除可以在编辑器里撤销，但已删除的资源不会回来。
- 「孤儿资源」只按场景直接引用判断（资源的编辑器 guid 是否出现在场景序列化数据里）。只通过材质等间接引用的资源不会被判为孤儿。
- 素材放进场景时，编辑器会按对象名再建几个文件夹（如 `复古清冷_滤镜`、`复古清冷_美妆`），保存时对象还在才会写到磁盘。`object_remove` 把这类只在编辑器里的路径单独列在 `editor_only_paths`，对象删除后下次保存就会消失，不用删；`unused_paths` 只含磁盘上真实存在的路径，可以照着删（用 `resource_delete_unused`）。

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

- `npm test`：用模拟的编辑器模块测插件逻辑；用 jsdom 按线上结构搭的提交页测填写流程；用内存传输测 MCP 工具、官方转发、工程窗口编排。
- `node scripts/mcp-call.mjs <tool> '<json>' [...]`：新起一个服务按顺序调工具，图片写到 `<临时目录>/xs-mcp-call/` 下每次运行一个子目录（一小时后清理）。`scripts/official-call.mjs` 直调官方 MCP，图片同样放在 `xs-official-call/` 下。
- `node scripts/call.mjs <method> '<json>' [--pid N]`：直调插件。
- `node scripts/e2e.mjs <工程路径> <关键词> [标题]`：搜索 + 应用 + 未知 ID 报错的端到端检查（会真的导入素材，只对测试工程用）。
- `config.local.json` 里 `devEval: true` 时可用插件方法 `dev_eval` 在编辑器进程里执行探测代码（`scripts/call.mjs dev_eval '{}' --code-file x.js`，`scripts/dump-source.js` 可导出模块源码）。同一个开关也管 `scripts/call.mjs` 的 `eval` / `describe`；三者都在每次调用时读取开关，改回 `false` 在开着的窗口里立即失效。**日常使用保持 `false`**：它能在编辑器进程里执行任意代码。
- 环境变量 `XIANGSU_MCP_EXT_STATE` 可改状态目录（测试用），`XIANGSU_MCP_URL` 可改官方 MCP 地址。

### 依赖的编辑器内部接口

完整清单在 `editor-plugin/features/assets.cjs` 的 `REQUIRED`（按功能分组），`ext_status` 会逐项核对。主要有：

- 素材库：`@orion/Business/AssetsLibrary/Core/Api/{getAssetCategory,getAssetList,search}`、`.../Control/AssetsLibraryNav/{util,const}`、`.../Control/util.downloadLokiFile`
- 素材广场与收藏：`.../Core/Api/{getAIAssetCategory,getAIAssetList,collect,getAssetSecondPanel,publishAsset}`、`.../Core/Control/AssetsLibrary` 的 `AssetsLibrary.getInstance()`（其中的 `AIAssets.applySquareAsset`、`AIAssetPictureCtx`、`AIAssetMakeupCtx`、`UGanManager` 与 `getAssetItemByQuery`）、`@orion/Business/API/ai_effect_api.getDYEHFileUrls`
- 导入：`@orion/orion-sdk/EditorFramework` 的 `Resource.AssetPackageManager.instance.import`、`UndoSystem`、`PreviewSyncer`
- 菜单：`@orion/orion-sdk/orionui` 的 `ExtensionManager` / `I18n`，`DynamicMenuConfigInfo`，`SceneOpsService.createEntity`，`HoverTipsMap`
- AI 组合效果：`AIEffectWindow/AICombinationToolPanel/Core/AIGraphProjectUtils.createAIGraph`（「新建工作流」按钮用的同一个），`.../Core/Manager/AIGraphManager` 的 `getInstance`、`addGraph`、`getGraphById`、`switchGraphbyGuid`、`editorPanelApply`（「应用」；失败时不抛异常，而是在 `BusinessEventManager` 上发 `AIEffectShowToast`，工具监听它并以场景里出现新对象为准）
- 工程窗口：`OpenProjectFromEditCommand` + `EditSender`（与编辑器自己的 `launchProject` 同一请求，9.8.1 起首页进程只认它），`closeProjectAndBackToHome`
- 首页作品：`@orion/Business/HomeWindow/TemplatesPanel/Request/{templatesPanel,templatesCategory}`、`.../Model/util.transformTemplate`、`.../Model/DownloadTemplateModel`；打开作品用 `OpenProjectFromEditCommand` 的 `openTemplate`
- 交付：`IconCreationNew/controller/IconPreviewManager`、`IconCreationNew/UI/BottomPanel/DYEHIconUploadHelper.uploadIcon`（上传图标，写回 `iconUri`）、`Submission/SubmissionExtension/EffectSubmissionExtension`（提交接口 `submit()` 只做前置检查并打开提交窗口）、全局 `App._windows`（编辑器每次都新开提交窗口和特效检测窗口、不保存引用，按类名 `DYEHEffectSubmissionWindow` / `DYEHPerfTestWebWindow` 在这里找到它们；提交窗口和特效检测窗口都是网页窗口，网页里的脚本经 `webview.evaluateJavascript` 注入，结果经窗口的 JS bridge 以 `orionJSB://` 查询传回）、`PerfTest/PerfTestExtension`、`EditWindow/ToolBar/MobilePreview/backendHelper`、`effectExporter.exportEffectPackage`
- 灵感、任务、排行榜：`BusinessCommon/UrlConst` 的 `Domain.kBackendApiURL` 与 `DomainPath.{kActivityAPI,kTaskListAPI,kGrowthTaskList}`、`orion-sdk/orionui` 的 `CookieManager`、`BusinessCommon/Utils` 的 `PlatformUtils.genSignData` / `UserAgentUtils.userAgentGenerator`、`HomeWindow/ActivitiesCenter/Common/types`（任务状态、`getTypeName`）、`InspirationDetail/View/const` 的收藏类型、`Agent/AgentInspirationBridge`
- 音乐：`EditWindow/Inspector/MusicLibrary/{Model/MusicCategoryModel,Model/MusicListModel,Component/MusicListComponent/MusicSquareManager}`
- 预览帧：`Business/Preview/PreviewManager` 的 `cacheCurrentFrame` / `captureScreenshotToMemory`（渲染结果；9.8.1 前官方截图也走这组调用）；重置用 `PreviewSyncer.requestReloadSticker` 加 `PreviewReloaded` 与 `PreviewTextureUpdated` 事件；后台帧率用 `EditWindow/BackgroundModeManager.setRecordingMode`；窗口是否可见看 `EditWindow/EditWindowController` 的窗口和 `orionui.WindowState`

## 协议与声明

代码以 [MIT 协议](LICENSE) 开源。另外请注意：

- 本项目是个人开发的非官方工具，与字节跳动、抖音、像塑没有任何关联，也未获其认可或支持。「像塑」「抖音」「Douyin AR」等名称和商标归各自权利人所有。
- 仓库只包含本项目自己的代码，不包含像塑的程序、源码或任何素材。通过本工具访问的官方素材、首页作品，其版权归像塑或原作者所有，使用须遵守像塑 / 抖音的用户协议和平台规则。
- 首页作品只建议用于学习参考：不要把下载的工程、素材原样或稍作修改后重新发布，也不要把它们放进公开仓库。学完用 `works_cleanup` 删除。
- 本工具调用的是编辑器内部接口，可能随像塑升级失效，也可能被平台限制。使用风险自负，作者不对因使用本工具造成的账号、数据或作品损失负责（详见 MIT 协议的免责条款）。

## English

Unofficial MCP extension for Douyin AR (像塑) on macOS. One stdio MCP server proxies every tool of the editor's official MCP (with automatic reconnects) and adds what the official server cannot do: browse/search/preview/apply official library assets, browse/search/download or open the homepage works (official projects and published effects) as full projects an agent can read and learn from (rank-board effects are looked up there by effect id, though effects whose authors did not share them on the homepage have no downloadable project; every download is registered and deleted by works_cleanup or after 24 hours), add any item of the editor's "add object" menu (toolbar makeup / reshape / AI face effects), create AI combine workflows (the photo is sent to the cloud and generated from the workflow) and apply them to the scene the way the AI effect window does, leaving node editing and preview generation to the official workflow tools, list a project's makeup layers with the face part, colour and strength of each (from the layer's region and its texture's pixels when the name says nothing), set FaceWarpX brush intensity, prepare delivery (setting and uploading the icon, local and cloud effect checks, filling in the submit window — name, trigger hint, camera, inspiration, task — up to its final step, where pressing 提交审核 stays a user click, phone preview QR codes, binding received creator tasks or inspirations), read the signed-in account's inspirations and tasks (collect inspirations, receive tasks) and the mobile app's rank boards, list the account's submitted effects with their review status and, for rejected ones, the reviewer's reason and full review timeline, use Douyin music, open/create/close project windows, and remove objects together with resources only they used. It works through a small editor plugin that exposes a token-protected RPC on 127.0.0.1 inside each project window. Relies on editor internals (verified on 9.7.2); `ext_status` reports any missing internals. Install with `npm ci && node scripts/install.mjs`, then register `node src/server.mjs` as a stdio MCP server.

Licensed under [MIT](LICENSE). Not affiliated with or endorsed by ByteDance / Douyin; all product names and trademarks belong to their owners. The repository contains no editor code or assets. Official assets and homepage works accessed through this tool belong to 像塑 or their creators and are subject to the platform's terms; use downloaded works for learning only, delete them with works_cleanup when done, and do not redistribute them.
