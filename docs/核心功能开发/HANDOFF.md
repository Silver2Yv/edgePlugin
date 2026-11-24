# HANDOFF.md — 核心功能开发阶段交接

> 写于 2026-11-22，2026-11-24 按第二批第一波更新，对应分支 `integrate/batch2` 的代码。**开发中随时更新**：做完一项就改第 2 节对应行。
> 只写「代码现在长什么样」，不重复背景：命令、架构规则、目录依赖方向见根目录 `CLAUDE.md`；分期范围见
> `docs/架构设计/ARCHITECTURE.md` 第 10 节；原型验证接受的降级见 `docs/原型验证/PROTOTYPE_REPORT.md` 第 3、4 节；
> 各开发块的决策见 `docs/需求分析梳理/DECISIONS.md` 决策 082–107（097–101 是用户对清单的答复）；等用户答复的事项集中在同目录 `REVIEW_CHECKLIST.md`。

## 1. 一页结论

端到端主路径全部打通：**划词 → 工具栏点「问」/「解释」/「解释代码」/自定义动作 → 小窗或侧边栏 → 后台装配上下文
（含实体回指、页面级预算）→ 经模型网关发请求（怪癖学习、参数自动重试、按模型识别厂商发思考参数）→ 流式回答 →
引用可点击跳回原文并高亮 → 可「存」成收藏 → 对话落库，后台重启后历史可续接。**

新增的整条能力线：收藏与历史（侧边栏完整版）、框选截图提问、页面图片开关（E2，默认关）、子页面（iframe）正文读取（D10）、
多连接模型下拉与「换个模型再试」、设置向导与欢迎页、实时引用与页面变化提示、提示词登记表与各动作系统提示。

**`FINAL_PLAN.md` 5.1「首期重要」已全部实现**；第 9 节验收除公司网络（第 9 条）、Edge 手动走查（第 14 条）要用户在真实环境确认外，
都有自动化用例或原型实测结论。还没做的都在首期次要及以后（第 2 节末两张表）：联网搜索、分块总结、网页高亮批注、命令面板、
按功能配模型、悬停图片引用等；跨后台重启续播同一条流（决策 070）不做。

**第二批第一波（2026-11-24）**：用户答复清单后的四处修改（多编号循环跳转、回到那一页与收藏回原文、外部截图粘贴、按模型的思考档位），
加上收起的小窗满 10 分钟销毁、设置导出导入、删除改行内确认条，都已合并。用户对界面视觉仍不满意，**之后另开对话专门重做**。

## 2. 能力现状

对照 `ARCHITECTURE.md` 第 10 节三档逐项拆开。

### 核心试用版

| 项目 | 状态 | 代码位置 | 说明 |
| --- | --- | --- | --- |
| 哨兵与工具栏 | 已有 | `src/page/sentinel.ts`、`toolbar.ts`；`src/background/intents.ts` | 工具栏默认三键「问/解释/存」与「解释代码」「长选区确认」「更多」展开面板都已实现；`action/click` 按 `kind/needsInput/scope` 分流：直接发送动作由后台自起任务，页面级动作强制不带选区（决策 083） |
| 阅读器：抽取 | 已有（接受降级） | `src/page/extract.ts` | V-08 列表页粒度塌陷已修（列表项拆独立块）；GitHub 代码页、公式页此前已修复、本轮核实未回归；已知残留：`iframe-cross-origin` 证据召回 2/3、`formula-en` 远距离指代未命中（非本轮引入） |
| 阅读器：三档 | 已有 | `src/core/context/select.ts`、`plan.ts` | selection / nearby / fullPage 不变 |
| 阅读器：回指（D5） | 已有 | `src/core/context/entities.ts` | 年份、带单位数字、书名号/引号术语、英文专名、代码标识符；中文用 `Intl.Segmenter` 按页内低频筛候选，命中并入 nearby（决策 085，阈值为初值） |
| 阅读器：换页 | 已有 | `src/background/pages.ts`、`src/page/reader.ts`（页面变化观察器） | 发问前核对 `contentVersion`；新增：小窗/侧边栏开着时阅读器主动比较正文字数（≥40 字且 1.5 秒内不变）或 SPA 路由变化，提示「页面内容已变化」（决策 090） |
| 阅读器：子框架 | 已有 | `src/background/pages.ts`（`readSubframes`）、`src/core/context/frame-merge.ts`、`src/page/subframe-reader.ts` | 读取时一次性探测框架、按「顶层与框架来源取更严」和尺寸（<50 px 跳过）挑框架，按需注入子框架阅读器并行读；子框架块排在顶层之后整页编号、标题链前加「内嵌页面：」；子框架里的选区也能带前后文；引用落在子框架块上只说明原因、不定位（决策 095） |
| 小窗 | 已有（接受降级） | `src/page/float-host.ts`、`src/ui/FloatApp.tsx` | 重做视觉（`theme.css`）、图钉（`float/pin`）、引用条常驻、模型下拉、截图按钮、「存」、档位与思考强度临时切换；不可见（收起或预热后从未显示）满 10 分钟销毁 iframe，阅读器发 `float/destroyed`，后台作废绑定与令牌，再显示时新建并恢复对话（决策 106） |
| 最小侧边栏 → 完整侧边栏 | 已有 | `src/ui/SidePanelApp.tsx`、`src/ui/panel/*` | 已升级为「首期完整产品」档的完整侧边栏，见下表「完整侧边栏与历史」 |
| 后台任务与流式 | 已有 | `src/background/jobs.ts` | 增加 `usage`、`droppedParam` 终态字段；跨后台重启不能续播同一条流，但对话已落库，重启后可续接追问（见「任务恢复」行） |
| 模型网关 | 已有（次要适配器除外） | `src/core/llm/{capabilities,thinking,param-retry,quirks,presets,diagnostics}.ts`、`src/background/net-diagnostics.ts` | 能力表、按模型标识优先识别厂商发思考参数、参数被拒自动重试一次、怪癖学习（按连接+接口+模型+配置版本）、`webRequest` 网络诊断已接入（≤300ms 轮询取浏览器错误码）、服务商预设；只有 `chatCompletions` 一种接口实现，Responses/Anthropic/Gemini 仍无适配器（首期次要） |
| 提示词 | 已有 | `src/core/prompt/ask.ts` | `PROMPT_REGISTRY` 登记各动作默认文案与覆盖；explain/explainCode/translate/summarizePage/keyPoints/pageAbout/自定义动作均有装配路径；页面级动作强制不带选区（决策 083）；设置页 `PromptsSection.tsx` 可编辑恢复默认 |
| 渲染管线 | 已有 | `src/ui/render/*` | 未结构性改动；补了代码高亮配色变量 |
| 设置向导 | 已有 | `src/ui/options/Wizard.tsx` | 选服务商→填地址/Key→测试连接（含「缺 /v1 一键修正」）→拉模型列表选默认模型→发一条最小真实对话确认；没有连接时打开设置页自动出现（决策 094） |
| 欢迎页 | 已有 | `src/ui/WelcomeApp.tsx`、`src/ui/welcome/{QuickStart,demo}.ts`、`src/background/welcome-demo.ts` | 首次安装自动打开（更新不打开）；三步图示 + 可亲手试一遍的示例文章（`demo/ask`，仅限欢迎页顶层框架、只走选区+解释） |
| 站点权限层 | 已有（已知限制） | `src/core/domain/site-policy.ts` | 未变；IPv6 字面量地址仍写不进排除名单 |
| 页面身份 | 已有 | `src/core/context/page-key.ts`、`content-version.ts` | 未变 |
| 块锚点 | 已有（完整引用跳回） | `src/core/anchor/{anchor,citations}.ts` | 见下表「完整引用跳回」 |
| 任务恢复 | 部分（较大改进） | `src/background/jobs.ts`、`src/platform/conv-db.ts` | 跨后台重启：对话从库重建、启动扫描把在途助手消息标 `interrupted`（`workerRestarted`/`unknownOnStartup`），保留已生成部分，可在同对话继续追问；仍不能续播同一条网络流、不能自动重试（决策 070 维持） |

### 首期完整产品

| 项目 | 状态 | 代码位置 | 说明 |
| --- | --- | --- | --- |
| 完整侧边栏与历史 | 已有 | `src/ui/SidePanelApp.tsx`、`src/ui/panel/{Nav,ConversationSwitcher,HistoryView,FavoritesView,PageActions,conv-ops,history-group}.ts(x)`、`src/background/history.ts` | 顶部分段切换对话/历史/收藏（决策 093）；本页对话列表下拉；历史按页面/网站分组、搜索、分页、就地删除（级联）；整页快捷动作（总结/提取要点/这页在讲什么+自定义 page 动作） |
| 自定义动作与黑名单 UI | 已有 | `src/ui/options/ActionsSection.tsx`（自定义动作增删改、工具栏顺序/隐藏）、`sections.tsx`（网站黑名单两级规则） | — |
| 完整引用跳回 | 已有 | `src/background/citations.ts`、`src/core/anchor/citations.ts`、`src/page/locate.ts`、`src/ui/cite/useCite.tsx` | 回答里【N】与【N】原文【/N】均可点；页面变了按锚点三级降级并提示「原文可能已变化」；`CSS.highlights` 高亮，点网页/回原位/跳下一处清掉；「回到刚才阅读的位置」（F4）；上次总结卡片与版本标注（`SummaryCard.tsx`、`src/background/summary.ts`）；一处多个编号点一次跳下一个、循环（`src/ui/cite/cycle.ts`，决策 097、102）；别的页面的对话「回到那一页」与收藏「回到原文」共用 `src/background/jump.ts`（`jump/open`，地址只从库里取，决策 098、103） |
| 收藏与导出 | 已有 | `src/background/favorites.ts`、`src/core/domain/favorite-export.ts`、`src/ui/panel/{FavoritesView,favorites-db,favorites-search,export}.ts` | 工具栏「存」（锚点前后约 32 字快照）与回答上的「存」（快照 refCount+1）；编辑标题/笔记、删除（解引用）、导出结构化 Markdown（单条/全部/按页面）；列表与搜索由侧边栏直接只读查询 IndexedDB（决策 093）；工具栏「存」时页面没读过就先在本地读一次取锚点（决策 103） |
| 多连接与模型下拉 | 已有 | `src/ui/chat/ModelPicker.tsx`、`src/ui/model/options.ts`、`src/background/jobs.ts`（`resolveModel`） | 按连接分组列常用模型、可搜索；思考控件随模型能力变（开关类/`none`/`effort`）；连接被删时拒绝 `modelGone`（不再静默换默认模型，决策 091）；失败时「换个模型再试」（用原动作/档位重问）；思考强度加「最高」，下拉按模型列档位（DeepSeek 关/低/高/最高），界面与后台按 `src/core/llm/thinking-levels.ts` 同一规则就近取档，设置页可给模型自填档位（决策 100、105） |
| 框选截图与页面图片 | 已有 | `src/background/{capture,capture-image,page-images}.ts`、`src/core/capture/{geometry,data-url}.ts`、`src/page/capture.ts`、`src/ui/chat/{CaptureParts,image-thumbs}.ts` | E1–E4 完成：框选截图（身份与视口核对、裁剪、预览确认、看不了图拒绝 `noVision`、图表解析提示）；页面图片开关（默认关，只取选区所在顶层块里页面已加载的图，最多 3 张，不带凭据、重定向一律跳过，发送说明列地址，决策 096）；追问不重发图片；悬停图片引用（E6）属首期次要未做；详见 V-15 记录；输入框可粘贴外部图片（分片交后台，单张 ≤ 16 MB，预览旁提示无法定位原文、可「不再提醒」，`src/core/capture/paste.ts`、`src/ui/chat/paste.ts`，决策 099、104） |
| 设置分层 | 已有 | `src/ui/options/sections.tsx`、`parts.tsx` | 常用项露出（默认模型/上下文档位/回答长度/思考/网站黑名单），其余收进默认折叠的「高级选项」（决策 094）；「高级选项 › 导出与导入」（K6，默认脱敏、导入先预览、保留本机同 id 连接的 Key，`src/ui/options/{transfer.ts,TransferSection.tsx}`）；删除连接与自定义动作改行内确认、10 秒可撤销（决策 107） |

### 首期次要及以后（未进入本轮）

| 项目 | 状态 |
| --- | --- |
| Responses / Anthropic / Gemini 适配器 | 没有，仍只有 Chat Completions |
| 联网搜索 | 没有（`adapter.ts` 里 `web_search` 只是接口类型占位字符串，未接任何逻辑） |
| 分块总结 | 没有 |
| 网页高亮（持久批注） | 没有——引用跳回时的 `CSS.highlights` 是一次性定位高亮，不是可保留的批注功能 |
| 命令面板 | 没有 |

### 其他未做事项（不在原三档表格内，但本轮素材要求写明）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 按功能配模型 | 没有 | 模型按连接/对话临时切换，没有「总结用模型 A、翻译用模型 B」这类按动作绑定模型的设置 |
| 设置导入导出 | 已有（第二批第一波） | 见上表「设置分层」行 |
| 完整数据备份/恢复 | 没有 | 见 V-14 记录 |
| Edge 复测 | 见第 5 节 | 自动化用例在本机 Edge（有界面）上复跑一遍，结果见第 5 节；手动走查交给用户（`REVIEW_CHECKLIST.md` F2） |

## 3. 模块地图

entrypoints 下每个入口只做渲染装配，同目录 `index.html` 不单列。

| 目录 | 文件 | 职责 |
| --- | --- | --- |
| entrypoints | `background.ts` | 后台 Service Worker 入口 |
| entrypoints | `sentinel.content.ts` | 哨兵内容脚本入口 |
| entrypoints | `reader.content.ts` | 阅读器内容脚本入口 |
| entrypoints | `subframe-reader.content.ts` | 子框架阅读器入口（读取时按需注入，不写进清单） |
| entrypoints | `float/main.tsx` | 小窗页面 |
| entrypoints | `sidepanel/main.tsx` | 侧边栏页面 |
| entrypoints | `options/main.tsx` | 设置页 |
| entrypoints | `welcome/main.tsx`、`welcome/demo.ts` | 欢迎页；示例文章与页面侧模块的接口装配 |
| core/domain | `actions.ts` | 内置+自定义动作定义、工具栏默认顺序、`ActionSummary` |
| core/domain | `bytes.ts` | JSON 字节口径计算 |
| core/domain | `conversation.ts` | 续接规则常量（30 分钟、20 轮，D12/D13） |
| core/domain | `favorite-export.ts` | 收藏导出格式化（纯函数） |
| core/domain | `float.ts` | 小窗状态机、握手令牌、`FLOAT_LIMITS`（`idleDestroyMs` 由 `page/float-host.ts` 计时） |
| core/domain | `ids.ts` | 各类编号类型别名 |
| core/domain | `job.ts` | 任务状态机、`JobRecord` |
| core/domain | `messages.ts` | 消息协议定义与运行时校验入口（现为 contract-v1.6，见第 4 节） |
| core/domain | `records.ts` | IndexedDB 表结构，新增 `FavoriteRecord` 扩展字段、`sentText`、`lastAskedAt` 等 |
| core/domain | `schema.ts` | 运行时校验器 |
| core/domain | `session-keys.ts` | `storage.session` 键名登记 |
| core/domain | `settings.ts` | 设置结构、默认值（版本升到 2：`reply` 默认 `brief`/`zh`、`float.closeMode`、连接 `capabilityOverrides`/`models`）与迁移 |
| core/domain | `site-policy.ts` | 站点三级权限矩阵 |
| core/context | `content-version.ts` | 内容指纹算法 |
| core/context | `entities.ts` | 实体回指候选识别（D5） |
| core/context | `frame-merge.ts` | 子框架挑选（站点级别、尺寸）与合并、整页重新编号、指纹重算（D10） |
| core/context | `page-doc.ts` | 页面模型类型 |
| core/context | `page-key.ts` | pageKey 归一化 |
| core/context | `plan.ts` | 请求装配计划类型与预算；新增 `entityBlockIds`、`entitySingleMentions`、页面级预算口径 |
| core/context | `select.ts` | 三档选块、列表项分组逻辑 |
| core/llm | `adapter.ts` | 网关契约：`Connection`（含 `capabilityOverrides`、`models`）、能力表接口、受保护/语义参数、适配器接口 |
| core/llm | `capabilities.ts` | 内置模型能力表与 `vendorOfModel` |
| core/llm | `chat-completions.ts` | Chat Completions 适配器（唯一已实现） |
| core/llm | `diagnostics.ts` | 诊断文本生成（脱敏），供设置页「一键复制」 |
| core/llm | `param-retry.ts` | 参数被拒自动重试判断 |
| core/llm | `presets.ts` | 服务商预设数据表 |
| core/llm | `quirks.ts` | 怪癖学习纯逻辑（增删查） |
| core/llm | `sse.ts` | SSE 行解析 |
| core/llm | `thinking-levels.ts` | 思考档位表、就近取档、思考控件选项（界面与后台共用，决策 105） |
| core/llm | `thinking.ts` | 思考字段按厂商映射（模型标识优先于连接预设） |
| core/prompt | `ask.ts` | 划词/动作提问装配：`PROMPT_REGISTRY`、长度档、语言、引用编号对齐、页面级预算 |
| core/anchor | `anchor.ts` | 锚点生成与三级降级匹配 |
| core/anchor | `citations.ts` | 引用标记解析与「引用→锚点」（纯逻辑，界面与后台共用） |
| core/capture | `paste.ts` | 粘贴图片的分片常量、拼装与文件头核对（决策 104） |
| core/capture | `data-url.ts` | data: URL ↔ 字节转换 |
| core/capture | `geometry.ts` | 框选截图坐标换算（按实际图片尺寸÷视口现算） |
| background | `app.ts` | 装配所有后台子模块 |
| background | `browser-deps.ts` | `BackgroundDeps` 真实实现 |
| background | `capture.ts` | 框选截图后台流程：身份核对、待确认截图保管 |
| background | `capture-image.ts` | 截图像素处理（裁剪/缩放/编码，OffscreenCanvas） |
| background | `citations.ts` | 引用跳回：核对、算锚点、驱动阅读器定位 |
| background | `commands.ts` | 快捷键与右键菜单 |
| background | `conv.ts` | 对话流端口：握手、订阅、授权、转接、收藏/截图/模型相关消息路由 |
| background | `deps.ts` | 依赖接口定义（单测可替换），新增 `db`、`insertCss`、`netDiagnostics`、`captureImages` 等 |
| background | `favorites.ts` | 收藏写入、编辑、删除（refCount 维护） |
| background | `float-host.ts` | 小窗宿主调度 |
| background | `history.ts` | 历史查询/删除、上次总结读取、站点改「不读取」后清旧正文 |
| background | `hub.ts` | 对话端口分组登记与推送 |
| background | `intents.ts` | 意图通道：划词、点击（按 `kind/needsInput/scope` 分流）、配置读取 |
| background | `jobs.ts` | 任务执行：接单落库、发请求、增量合并、检查点、重试、`usage`/`droppedParam` |
| background | `jump.ts` | 回到那一页 / 收藏回原文（`jump/open`）：库里取地址、找或开标签页、等加载、定位（决策 103） |
| background | `main.ts` | 启动入口：监听器、菜单、哨兵对账、启动扫描 |
| background | `net-diagnostics.ts` | `webRequest.onErrorOccurred` 归因，接入网络失败路径 |
| background | `options.ts` | 设置页通道：测试连接、列模型 |
| background | `page-images.ts` | 页面图片（E2）：向顶层阅读器要选区块里已加载的图片地址、核对应答、不带凭据取图并编码 |
| background | `pages.ts` | 页面读取与缓存、`currentVersion`；子框架探测、注入与合并（D10） |
| background | `quirk-store.ts` | 怪癖学习的 `storage.local` 读写 |
| background | `quote.ts` | 引用条预览 |
| background | `roles.ts` | 角色推断 |
| background | `route.ts` | 小窗/侧边栏去向决策 |
| background | `scripts.ts` | 哨兵动态注册对账 |
| background | `store.ts` | 运行时内存缓存 |
| background | `summary.ts` | 「总结本页」上次总结查询、版本比较、复用判断 |
| background | `welcome-demo.ts` | 欢迎页示例提问（`demo/ask`） |
| page | `capture.ts` | 框选截图遮罩（顶层框架） |
| page | `extract.ts` | 正文抽取 |
| page | `float-host.ts` | 小窗宿主 iframe |
| page | `float-port.ts` | 小窗私有端口 |
| page | `locate.ts` | 引用跳回定位与高亮、回到刚才位置 |
| page | `notice.ts` | 网页一行提示 |
| page | `page-read.ts` | 响应 `page/read`；`imagesInBlocks` 回报选区块里已加载的图（E2） |
| page | `subframe-reader.ts` | 子框架阅读器：只响应 `page/read`，复用 `page-read.ts`（D10） |
| page | `reader.ts` | 阅读器总入口：新增页面变化观察器 |
| page | `selection-bus.ts` | 选区矩形/修订号小总线 |
| page | `selection-policy.ts` | 选区判断规则 |
| page | `sentinel.ts` | 哨兵：新增实时选区上报（`selection/live`，受 `live/toggle` 控制） |
| page | `toolbar.ts` | 工具栏 UI：新增「更多」展开面板、长选区确认 |
| platform | `conv-db.ts` | IndexedDB 建表/索引/迁移（`ConvDb` 接口、`createIdbConvDb`），图片级联、收藏读写接口 |
| platform | `settings-store.ts` | 设置读取与迁移 |
| ui | `AnswerView.tsx` | 回答区：思考折叠、用量展示、「换个模型再试」、实际模型、「存」按钮、图表解析提示 |
| ui | `FloatApp.tsx` | 小窗整体：图钉、模型下拉接入、截图接入 |
| ui | `OptionsApp.tsx` | 设置页壳：分层（常用/高级）、向导入口 |
| ui | `SidePanelApp.tsx` | 侧边栏整体：三视图、本页对话列表、整页动作 |
| ui | `WelcomeApp.tsx` | 欢迎页：三步图示 + 示例文章 |
| ui | `ask-defaults.ts` | 发问默认参数读取，新增连接/模型相关默认值 |
| ui | `error-labels.ts` | 错误分类对应文案 |
| ui/chat | `ModelPicker.tsx` | 模型下拉面板（窗内，不出 iframe） |
| ui/chat | `Composer.tsx` | 输入区：模型/档位/思考切换、截图按钮、引用条 |
| ui/chat | `MessageList.tsx` | 消息列表：历史回答渲染、引用、「存」 |
| ui/chat | `CaptureParts.tsx` | 截图预览、消息里的截图、提示 |
| ui/chat | `image-thumbs.ts` | 缩略图按需拉取与页面内缓存 |
| ui/chat | `paste.ts`、`paste-hint.ts` | 输入框粘贴图片：认图、分片发送、本地拦截；「不再提醒」读写 |
| ui/chat | `Icons.tsx` | 内联 SVG 图标 |
| ui/chat | `ask.ts` | 发问动作（副作用层，配合 `float/state.ts`） |
| ui/cite | `useCite.tsx` | 引用跳回/回到刚才位置的界面逻辑 |
| ui/cite | `cycle.ts` | 多编号引用的循环位置（决策 102） |
| ui/cite | `SummaryCard.tsx` | 上次总结卡片 |
| ui/panel | `Nav.tsx` | 侧边栏三视图切换 |
| ui/panel | `ConversationSwitcher.tsx` | 本页对话列表下拉 |
| ui/panel | `HistoryView.tsx` | 历史列表、搜索、分页、删除 |
| ui/panel | `FavoritesView.tsx` | 收藏列表、搜索、编辑、删除、导出 |
| ui/panel | `PageActions.tsx` | 整页快捷动作入口 |
| ui/panel | `conv-ops.ts` | 侧边栏对话端口请求/应答辅助 |
| ui/panel | `export.ts` | 收藏导出下载 |
| ui/panel | `favorites-db.ts` | 收藏/历史只读查询（侧边栏直连 IndexedDB） |
| ui/panel | `favorites-search.ts` | 收藏搜索匹配规则 |
| ui/panel | `history-group.ts` | 历史分组纯逻辑 |
| ui/model | `options.ts` | 模型下拉/思考控件/换模型再试纯逻辑 |
| ui/options | `transfer.ts`、`TransferSection.tsx` | 设置导出导入（K6，决策 107） |
| ui/options | `Wizard.tsx` | 配置向导 |
| ui/options | `ConnectionsSection.tsx` | 连接管理：预设、Key、测试连接、常用模型勾选 |
| ui/options | `ActionsSection.tsx` | 工具栏顺序与自定义动作增删改 |
| ui/options | `PromptsSection.tsx` | 提示词编辑/恢复默认 |
| ui/options | `ModelList.tsx` | 可搜索模型列表（多选/单选复用） |
| ui/options | `Shortcuts.tsx` | 快捷键现状展示与修改入口 |
| ui/options | `TestResultView.tsx` | 测试连接结果展示 |
| ui/options | `api.ts` | 设置页与后台/存储交互的唯一入口 |
| ui/options | `diagnose.ts` | 测试连接失败「可能的原因」 |
| ui/options | `model.ts` | 设置表单纯逻辑 |
| ui/options | `parts.tsx` | 设置行/折叠小节/表单字段共用组件 |
| ui/options | `sections.tsx` | 常用项、网站黑名单、高级小节 |
| ui/options | `useSettings.ts` | 设置读取/订阅/写入 |
| ui/welcome | `QuickStart.tsx` | 三步图示 + 示例文章 |
| ui/welcome | `demo.ts` | 示例文章与 page 模块的接口（ui 不可直接依赖 page） |
| ui/float | `state.ts` | 小窗/侧边栏共用归约器：新增 `modelOverride`、`savedMessageIds`、`conversationPageKey`、`pageChanged` 等 |
| ui/float | `messages.ts` | 快照消息合并 |
| ui/float | `send-summary.ts` | 发送说明、侧边栏当前页信息 |
| ui/render/* | 同前，未结构性改动 | — |

## 4. 消息协议与契约

协议定义在 `src/core/domain/messages.ts`；改协议的流程见根目录 `CLAUDE.md`。

| tag | 日期 | 内容 |
| --- | --- | --- |
| `contract-v1` | 2026-11-14 | 冻结：领域类型、消息协议、页面模型、数据库表结构、设置与迁移、模型适配器接口 |
| `contract-v1.1` | 2026-11-18 | 小窗断线重连 |
| `contract-v1.2` | 2026-11-19 | 测试连接带模型；设置页应答类型 |
| `contract-v1.3` | 2026-11-21 补打 | 页面缓存未变应答、小窗拖动缩放改宿主侧、侧边栏订阅与转接、网页提示、拒绝原因 `busy` |
| `contract-v1.4` | 2026-11-22（核心功能第一批），已打 tag | `conv/ask.fresh`、`conv/accepted.newConversation`、`history/delete`/`history/deleted`、`history/page.nextBefore`、`conv/saveFailed`、拒绝原因 `storageFailed`、`conv/jobState.usage`/`droppedParam`、`float/pin`、`PageConfig.toolbarActions` 扩成 `ActionSummary`；计划追加 `entityBlockIds`/`entitySingleMentions`；设置升到版本 2 |
| `contract-v1.5` | 2026-11-22（核心功能第二批与补做的 E2、D10），已打 tag | 见下 |
| `contract-v1.6` | 2026-11-24（第二批第一波），已打 tag | 见下 |

`messages.ts` 里标「contract-v1.5 增量」的改动，按模块分组：

| 来源模块 | 增量内容 |
| --- | --- |
| cite | `citation/locate` 字段由 `segmentIndex` 改为 `citation`+`quote`（小窗也放行）；新增 `citation/back`、`summary/get`、`summary/last`、`page/back`；`page/locate`/`page/locateResult`/`citation/located` 加可选字段 |
| live | `selection/live`、`live/toggle`、`page/changed`、`conv/current.userMessage`（可选）、`conv/pageChanged`、`PageConfig.liveQuote` |
| model | 拒绝原因 `modelGone`；`conv/current` 的 `userMessage` 加 `request`（换模型重问用） |
| capture | `capture/rect` 加 `viewport`；新增 `capture/cancel`、`capture/begin`、`capture/discard`、`image/get`、`conv/capture`、`conv/captureCleared`、`conv/captureFailed`；`capture/hideOverlay`/`capture/end` 改为有应答；拒绝原因 `noVision`；提示种类 `captureChanged`/`captureFailed`/`captureUnsupported`；`conv/ask` 加 `captureId` |
| history/favorites | 新增 `favorite/update`、`favorite/remove`、应答与广播 `favorite/changed`；`favorite/add` 放进 `CONV_COMMON`（小窗也能发）；`favorite/saved` 加 `messageId` |
| onboard | `demo/ask`、`DemoAskResult` |
| E2 页面图片 | 后台到阅读器的指令 `page/images`（应答 `{ requestId, contentVersion, urls ≤ 3 }`，`parsePageImagesReply` 校验）；`RequestContextPlan.pageImageUrls`；设置 `context.includePageImages`（默认值合并补齐，设置版本不变） |
| D10 子框架 | 引用失败原因 `subframe`；`SnapshotRecord.blocks[].frameId`（可选）；没有新增消息 |

`messages.ts` 里标「contract-v1.6 增量」的改动（2026-11-24，第二批第一波，已打 tag）：

| 来源 | 增量内容 |
| --- | --- |
| 跳回原页面 | `jump/open`（仅侧边栏，只带 `pageKey` 或 `favoriteId`）、`jump/result`；`CitationFailReason` 加 `noRecord`、`badUrl`、`loadTimeout`、`redirected`、`openFailed`、`noAnchor` |
| 外部截图粘贴 | `paste/begin`、`paste/chunk`（小窗与侧边栏）；`conv/capture.external`；`CaptureFailReason` 加 `tooLarge`、`badImage` |
| 思考档位 | `conv/ask.thinking`、设置 `reply.thinking` 加 `max`；`Connection.capabilityOverrides[model].thinkingLevels`（可选）；设置版本不变 |
| 小窗空闲销毁 | `float/destroyed`（阅读器到后台，可选 `missed`） |

下一次改协议打 `contract-v1.7`。

## 5. 测试资产

**单测**（`pnpm verify` 实测，2026-11-22，E2、D10 合并后）：**63 个测试文件，798 个用例全部通过**；lint、类型、依赖方向、构建、体积（哨兵 gzip 4.87 KB / 10 KB）、清单权限同时通过。

| 目录 | 覆盖范围 |
| --- | --- |
| `tests/unit/background/` | 任务/订阅/鉴权/收藏/历史/截图流程/怪癖重试/实时引用/欢迎页示例等后台逻辑（`harness.ts` 假端口） |
| `tests/unit/core/` | messages/job/float/site-policy/settings/bytes 契约；锚点、引用解析、实体回指、能力表、思考映射、参数重试、怪癖、截图几何、chat-completions |
| `tests/unit/page/` | 抽取、选区策略、小窗私有端口定位、工具栏定位、哨兵实时选区上报 |
| `tests/unit/platform/` | `conv-db.test.ts`：IndexedDB 与内存两种实现跑同一组契约用例，含升级失败回滚、版本回退 |
| `tests/unit/ui/` | 归约器（小窗/面板共用状态机、收藏/历史分组、模型下拉选项、截图状态）、样式单位 |
| `tests/unit/ui/render/` | V-10 渲染管线（安全、流式一致性、引用、代码复制、高亮、KaTeX、选区保护） |
| `tests/unit/check-deps.test.ts`、`mock-relay.test.ts` | 同前 |

**e2e**（`pnpm test:e2e`，Playwright，需先 `pnpm build`；28 个 spec、137 个用例，下表为各文件用例数）：

| spec | 用例数 | 覆盖什么 |
| --- | --- | --- |
| `smoke.spec.ts` | 1 | 扩展加载、固定 ID、哨兵注册 |
| `toolbar.spec.ts` | 2 | 划词弹工具栏 |
| `toolbar-actions.spec.ts` | 6 | A2/A3/A6/A7：解释、解释代码、自定义动作直接发送、长选区确认、「更多」 |
| `ask-flow.spec.ts` | 2 | 划词→问→流式回答、断线重连 |
| `retry.spec.ts` | 3 | 中途断线重试 |
| `routing.spec.ts` | 7 | 冷启动/休眠路由、快捷键、右键问与总结本页 |
| `handoff.spec.ts` | 5 | 小窗转侧边栏 |
| `sidepanel.spec.ts` | 7 | 侧边栏基础行为 |
| `site-policy.spec.ts` | 4 | 权限矩阵、黑名单、敏感输入 |
| `page-identity.spec.ts` | 4 | 页面身份与缓存失效 |
| `request-plan.spec.ts` | 6 | 请求装配与预算、实体回指 nearby 验证 |
| `ipc-boundary.spec.ts` | 10 | IPC 授权与 iframe 边界 |
| `lifecycle.spec.ts` | 1 | 28 秒连接超时 |
| `float-interaction.spec.ts` | 14 | 小窗交互：拖动/缩放/IME/复制/缩放/继续阅读 |
| `markdown.spec.ts` | 2 | 回答安全渲染接入小窗 |
| `wait-hint.spec.ts` | 1 | 等待提示分级文案 |
| `options.spec.ts` | 2 | 设置页测试连接、落盘、Key 不出现在页面 |
| `options-advanced.spec.ts` | 9 | 设置分层、黑名单 UI、自定义动作、快捷键展示等 |
| `onboarding.spec.ts` | 9 | 欢迎页、向导、设置分层相关 K/L 验收 |
| `cite.spec.ts` | 4 | 引用跳回、降级提示、上次总结卡片、侧边栏引用 |
| `live.spec.ts` | 4 | 实时引用更新、页面变化提示、图钉用例改写 |
| `model.spec.ts` | 3 | 模型下拉切换、换模型再试、侧边栏截图 |
| `capture.spec.ts` | 8 | 框选截图全流程（含 125% 缩放、拖动中变化丢弃） |
| `history-favorites.spec.ts` | 4 | 工具栏「存」、回答「存」、历史搜索删除、本页对话列表 |
| `persist.spec.ts` | 2 | 后台重启后续接、生成中重启标中断 |
| `chat-ui.spec.ts` | 7 | 小窗/侧边栏视觉重做、深色、思考/用量展示 |
| `page-images.spec.ts` | 4 | E2：开关开着选中段落的图进请求、关着没有、跨主机重定向不取、看不了图不取 |
| `subframe-read.spec.ts` | 3 | D10：同源与跨源 iframe 正文进全文请求、不读取名单与密码框、iframe 里划词带前后文 |

**全量复跑结果（2026-11-24，第二批第一波合并后）**：`pnpm verify` 全过，单测 72 个文件 941 个用例；e2e 33 个 spec、154 个用例。

| 浏览器 | 结果 | 说明 |
| --- | --- | --- |
| CfT（无界面） | 153 通过、1 跳过（专截图用，默认不跑） | 一次全过 |
| Edge（有界面） | 148 通过、5 失败、1 跳过 → 处理后全过 | 粘贴图片 4 例：Playwright 启动的有界面 Edge 剪贴板不通（写入成功、读回空、普通 textarea 也粘不进，CfT 正常），改为 Edge 上跳过（见第 6 节）；欢迎页示例 1 例是有界面 Edge 的焦点类偶发，复跑通过 |

**全量复跑结果（2026-11-22，E2、D10 合并后）**：

| 浏览器 | 结果 | 说明 |
| --- | --- | --- |
| CfT（无界面，`E2E_CHROMIUM_PATH`） | 136 通过、1 跳过（专截图用，默认不跑） | 第一次跑 `history-favorites` 3 例失败，查明是侧边栏刚打开按 0 宽排版时测试量到的按钮位置不对（见第 6 节），修了测试辅助函数后连跑 3 次全过，再跑全量全过 |
| Edge（有界面，`E2E_BROWSER=msedge`） | 133 通过、3 失败、1 跳过 → 复跑全过 | 截图 2 例是断言假定了截图像素比等于 `devicePixelRatio`，有界面 Edge 上不成立（见第 6 节），改断言后通过；欢迎页示例 1 例是有界面 Edge 的焦点类偶发，复跑通过 |

**模拟中转站、scripts/**：同前（`tests/mock-relay/server.ts`，`check-deps.ts`/`check-size.ts`/`check-manifest.ts`/`v08-port-eval.ts`），未结构性变化。

## 6. 已知坑

延续原有坑（侧边栏非标签页、后台空闲回收模拟、Preact 数字样式单位、IPv6 排除名单、`store.ts` 内存真相、哨兵注册排队、侧边栏 `open` 同步段、Edge 冷态焦点）不再重复，见历史版本或代码文件头注释。本轮新增/确认：

| 坑 | 出处 |
| --- | --- |
| **e2e 夹具默认关掉安装时自动打开的欢迎页**：`fixtures.ts` 的 `dismissWelcome()` 在每个用例的 `context` fixture 里默认调用；需要测欢迎页本身时显式传 `{ keepWelcome: true }` | `tests/e2e/fixtures.ts` |
| 全量 e2e 偶发：`page-identity.spec.ts` 前进后退用例偶发超时，单独重跑能过。`request-plan`、`toolbar-actions` 长选区确认的偶发已查明：`locator.click({ clickCount: 3 })` 自带的滚动若在 mouseup 之后才派发 scroll 事件，哨兵按「滚动后消失」把刚弹出的工具栏收起；划词一律改用 `page-helpers.ts` 的 `tripleClick`（先滚到位、等两帧）后消除 | `tests/e2e/page-helpers.ts`；根目录 `CLAUDE.md` |
| 侧边栏页面刚打开时先按 0 宽排版（`innerWidth` 为 0）：按宽度量尺寸的逻辑要在 `resize` 时重算，否则输入框按 0 宽算出的高度一直撑着，对话列表只剩一条缝（已修，`Composer.tsx`）；测试里这时量按钮位置也会量错，`sidepanel-helpers.ts` 的点击等 `innerWidth` 不为 0 再量 | `src/ui/chat/Composer.tsx`、`tests/e2e/sidepanel-helpers.ts` |
| 有界面 Edge 由 Playwright 启动时剪贴板不通：`navigator.clipboard.writeText` 成功返回，`readText` 读回空串，页面里普通 textarea 按 Ctrl+V 也粘不进。走真实剪贴板的粘贴用例在 Edge 上跳过，以 CfT 为准；真实用户的粘贴不受影响（待用户在 Edge 上手动试一次） | `tests/e2e/paste-image.spec.ts` 的 `skipOnEdge` |
| 有界面 Edge 上 Playwright 模拟了视口和 `devicePixelRatio`（=1），`captureVisibleTab` 却按真实窗口与系统缩放出图（实测宽 1745 对视口 1281）。截图相关断言要用实测比例（截图宽 ÷ 视口宽），不能用 `devicePixelRatio`；裁剪代码本来就按实测比例算 | `tests/e2e/capture.spec.ts` 的 `captureScale` |
| 思考字段的厂商识别**按模型标识优先**，连接预设（含 `custom`）其次；两边都认不出时什么思考参数都不发，不再默认按预设猜 | `src/core/llm/thinking.ts`；决策 084 |
| `webRequest.onErrorOccurred` 送达和 `fetch()` reject 不保证先后顺序，取网络诊断要短暂轮询（≤300ms） | `src/background/net-diagnostics.ts` |
| 引用跳回用的 `CSS.highlights` 是网页与扩展共用的一份，网页脚本能查到/清掉；`insertCSS` 按文档注入的样式同理可见 | `src/background/citations.ts` 相关报告 |
| 框选截图的系统 DPI、真实切窗口、真实侧边栏开合三类，本机 CfT 无界面无法验证，详见 `docs/原型验证/记录/V-15.md` 第 3 节手动步骤 | V-15 |
| `jobs.ts` 接单时的空问题守卫按动作的 `needsInput` 放行：不需要输入的动作（解释、总结本页、自定义直接发送动作）问题可以为空，对话里显示动作名；需要输入的动作没有选区、截图和文字时拒绝 `invalid` | `src/background/jobs.ts` |

## 7. 接下来做什么

用户 2026-11-24 答复了 `REVIEW_CHECKLIST.md`（决策 087、097–101），`main` 已快进到本阶段成果并推送。下一批分两波，集成分支 `integrate/batch2`：

| 波次 | 内容 | 状态 |
| --- | --- | --- |
| 第一波 | 引用多编号循环跳转、跳回原页面（别的页面的对话、收藏回原文，决策 097、098）；外部截图粘贴（决策 099）；按模型的思考档位（决策 100）；收起的小窗满 10 分钟销毁（决策 078）；设置导入导出（K6）与删除确认条（M4） | 进行中 |
| 第二波 | 联网搜索（N1）、问题建议规则层（I9）、按功能配模型（H13） | 未开始，等第一波合并 |

| 记着的事 | 说明 |
| --- | --- |
| **界面视觉要重做** | 用户对现在的界面仍不满意（有不小的进步空间），会另开对话专门改；本批各块只按现有样式做，不做视觉重做 |
| 真实环境走查 | 清单第三节 F1–F7 用户只简单用过、没长测，之后遇到问题再修 |
