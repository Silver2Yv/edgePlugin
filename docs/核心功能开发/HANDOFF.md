# HANDOFF.md — 核心功能开发阶段交接

> 写于 2026-11-21，对应 `main` 上原型验证阶段收尾后的代码。**开发中随时更新**：做完一项就改第 2 节对应行。
> 只写「代码现在长什么样」，不重复背景：命令、架构规则、目录依赖方向见根目录 `CLAUDE.md`；分期范围见
> `docs/架构设计/ARCHITECTURE.md` 第 10 节；原型验证接受的降级与带进本阶段的事项见 `docs/原型验证/PROTOTYPE_REPORT.md` 第 3、4 节。

## 1. 一页结论

端到端能用的主路径：**在正常站点上划词 → 工具栏点「问」→ 小窗打开 → 后台装配上下文，经 Chat Completions
接口发给模型 → 流式回答渲染回小窗**。在这条路径上已有：断线重连、重试、转到侧边栏、侧边栏最小版、开关快捷键、
右键「问」与「总结本页」（最小版）、最小设置页。

还没有接入真实逻辑的：工具栏另外两个默认按钮「解释」「存」（点了被后台拒绝）、设置向导、欢迎页、实体回指、
webRequest 诊断。历史、收藏、多模型下拉、截图属于再下一阶段（首期完整产品）。

## 2. 能力现状

对照 `ARCHITECTURE.md` 第 10 节「核心试用版」逐项拆开：

| 项目 | 状态 | 代码位置 | 说明 |
| --- | --- | --- | --- |
| 哨兵与工具栏 | 部分 | `src/page/sentinel.ts`、`src/page/toolbar.ts`、`src/background/scripts.ts` | 哨兵常驻、工具栏弹出/收起完整；但工具栏默认三个按钮（问/解释/存）里**只有「问」被后台接受**，点「解释」「存」会被拒绝（`src/background/intents.ts` 的 `action/click`：「本版本只接『问』；其他动作回拒绝」） |
| 阅读器：抽取 | 已有（接受降级） | `src/page/extract.ts` | V-08 方案 A 移植；已知缺陷：GitHub 代码页、个别公式页、列表页（见 PROTOTYPE_REPORT 第 3 节） |
| 阅读器：三档 | 已有 | `src/core/context/select.ts`、`plan.ts` | selection / nearby / fullPage，预算与截断口径见 `plan.ts` |
| 阅读器：回指（D5） | 没有 | — | ARCHITECTURE 5.6 的实体回指（识别年份、数字、书名号术语、专名，`Intl.Segmenter` 切分）没有实现；目前远处内容只能靠 fullPage / nearby 装配与块的标题链（`src/core/prompt/ask.ts`）带上。V-08 的「远距离指代召回 84.2%」是抽取保留率，不是这项功能 |
| 阅读器：换页 | 部分 | `src/background/pages.ts` | 每次发问前重新核对 `contentVersion` 才用缓存；ARCHITECTURE 5.6 设想的「小窗/侧边栏开着时挂观察器主动提示页面已变化」未实现 |
| 阅读器：子框架 | 部分 | `src/page/sentinel.ts`、`src/core/domain/site-policy.ts`（`stricter`）、`src/background/pages.ts` | 哨兵在所有框架运行，子框架里能弹工具栏、选中文字能问，站点级别取顶层与框架更严的一级；页面读取只读顶层文档（阅读器只注入 frameId 0），子框架正文不进上下文 |
| 小窗 | 已有（接受降级） | `src/page/float-host.ts`、`float-port.ts`、`src/ui/FloatApp.tsx`、`src/background/float-host.ts` | 拖动/缩放、断线重连、转接都实现；Edge 冷态快点偶尔拿不到输入框焦点（V-02 记录第 7 节）；隐藏小窗不按 `FLOAT_LIMITS.idleDestroyMs` 定时销毁（常量已定义但未接定时器，决策 078 推迟，`src/core/domain/float.ts`） |
| 最小侧边栏 | 已有（最小版） | `src/ui/SidePanelApp.tsx`、`src/background/conv.ts` | 跟随标签页、开关快捷键、转接、两界面同时发问互斥（`busy`）都实现；无历史/收藏/完整样式（按分期本就不在这版） |
| 后台任务与流式 | 部分 | `src/background/jobs.ts`、`src/core/domain/job.ts` | 流式增量、检查点保活、重试（新 `attemptId`）已有；跨后台重启不能恢复或重试，只提示重新提问（决策 070，对话只在内存不进库） |
| 模型网关 | 部分 | `src/core/llm/chat-completions.ts`、`adapter.ts`、`src/background/options.ts` | 只有 `chatCompletions` 一种接口实现；`InterfaceType` 已占位 responses / anthropic / gemini 但没有适配器（首期次要及以后）；测试连接、列出模型已有。只读诊断（`webRequest` 权限已在清单里申请）没有接；连接怪癖学习（`quirks` 字段已定义）没有实现（V-07 未执行项） |
| 提示词 | 部分 | `src/core/prompt/ask.ts` | 只有「问」这一份装配逻辑；`explain`/`explainCode`/`keyPoints`/`pageAbout`/`translate` 等内置动作定义在 `src/core/domain/actions.ts`，但没有各自的提示词或装配路径——点了会被拒绝（同第一行）；只有「总结本页」走右键/快捷键时用固定问题文案（`SUMMARIZE_PAGE_QUESTION = '总结本页'`，`src/background/commands.ts`） |
| 渲染管线 | 已有（验证范围缩小） | `src/ui/render/*` | V-10 原型移植：Markdown/KaTeX/代码高亮/引用/流式分块/选区保护；真机验证在简化复现页上做的，接入真实界面后完整渲染管线待补测 |
| 设置向导 | 没有 | `src/ui/OptionsApp.tsx` | 只是平铺设置页（连接管理、测试连接、站点规则），没有首次使用的分步引导；没有连接时小窗/侧边栏提示「请先在设置里添加连接」+ 一个跳转按钮（`src/ui/ask-defaults.ts` 的 `NO_CONNECTION`），仅此而已 |
| 欢迎页 | 没有 | `src/ui/WelcomeApp.tsx` | 只有一行占位文字「欢迎页（骨架）」；安装时也不会自动打开（`src/background/main.ts` 的 `onInstalled` 只建右键菜单和注册哨兵） |
| 站点权限层 | 已有（已知限制） | `src/core/domain/site-policy.ts`、`src/background/scripts.ts` | 三级矩阵、归一化、动态排除都实现；IPv6 字面量地址写不进排除名单的匹配模式（`site-policy.ts`），这类站点哨兵仍会常驻，但读取/发送照常被拦截 |
| 页面身份 | 已有 | `src/core/context/page-key.ts`、`content-version.ts` | pageKey/documentId/contentVersion 都由后台按 `sender` 盖章，不信页面自报 |
| 块锚点 | 已有 | `src/core/anchor/anchor.ts` | 精确 → 块内近似（有界编辑距离）→ 滚动比例三级降级；引用编号渲染见 `src/ui/render/citation.ts` |
| 任务恢复 | 部分 | `src/background/jobs.ts`、`store.ts` | 同进程内恢复（小窗断线重连 `conv/resumeFloat`、检查点续播）已有；跨后台重启的任务只会被标 `interrupted`，不能跨进程续传（决策 070） |

## 3. 模块地图

entrypoints 下每个入口只做渲染装配，同目录的 `index.html` 是对应模板，未在表中单列。

| 目录 | 文件 | 职责 |
| --- | --- | --- |
| entrypoints | `background.ts` | 后台 Service Worker 入口，调用 `background/main.ts` |
| entrypoints | `sentinel.content.ts` | 哨兵内容脚本入口（运行时动态注册，不进清单） |
| entrypoints | `reader.content.ts` | 阅读器内容脚本入口（运行时由后台注入） |
| entrypoints | `float/main.tsx` | 小窗页面（渲染 `ui/FloatApp`） |
| entrypoints | `sidepanel/main.tsx` | 侧边栏页面（渲染 `ui/SidePanelApp`） |
| entrypoints | `options/main.tsx` | 设置页（渲染 `ui/OptionsApp`） |
| entrypoints | `welcome/main.tsx` | 欢迎页（渲染 `ui/WelcomeApp`，骨架） |
| core/domain | `actions.ts` | 内置动作定义（问/解释/存/总结等）与默认工具栏顺序 |
| core/domain | `bytes.ts` | JSON 字节口径计算与按字节切片 |
| core/domain | `float.ts` | 小窗就绪状态机、握手令牌、断线绑定、转接（Handoff）类型 |
| core/domain | `ids.ts` | 各类编号的类型别名（PageKey、JobId 等）与编号格式 |
| core/domain | `job.ts` | 任务状态机、终态判断、可重试判断、`JobRecord` 结构 |
| core/domain | `messages.ts` | 消息协议：所有跨上下文消息的标签联合与运行时校验入口 |
| core/domain | `records.ts` | IndexedDB 表结构（PageRecord/ConversationRecord/MessageRecord 等） |
| core/domain | `schema.ts` | 自带的极简运行时校验器（str/int/arr/obj/oneOf/tagged 等） |
| core/domain | `session-keys.ts` | `storage.session` 键名拼接函数登记表 |
| core/domain | `settings.ts` | 设置结构、默认值、版本迁移与导出脱敏 |
| core/domain | `site-policy.ts` | 站点三级权限矩阵、站点规则归一化、哨兵排除规则生成 |
| core/context | `content-version.ts` | 内容指纹算法（cyrb53 哈希）与块摘要 |
| core/context | `page-doc.ts` | 页面模型类型：块、块类型、PageNote |
| core/context | `page-key.ts` | pageKey 归一化（去跟踪参数、保留路由锚点） |
| core/context | `plan.ts` | 请求装配计划类型、预算计算（硬上限/软预算/总结读取占比） |
| core/context | `select.ts` | 按三档从块列表里选块（nearby/fullPage 的截断与居中逻辑） |
| core/llm | `adapter.ts` | 模型网关契约：Connection、能力表、受保护参数、适配器接口 |
| core/llm | `chat-completions.ts` | OpenAI 兼容 Chat Completions 适配器（唯一已实现的接口） |
| core/llm | `sse.ts` | SSE 行解析（容忍换行风格混用、跨块事件、多事件合并） |
| core/prompt | `ask.ts` | 划词提问的请求装配（系统/全文/历史/本轮消息顺序与预算分配） |
| core/anchor | `anchor.ts` | 引用锚点生成与三级降级匹配 |
| background | `app.ts` | 装配各后台子模块，暴露 `onMessage`/`onConnect` |
| background | `browser-deps.ts` | `BackgroundDeps` 的真实实现（扩展 API、网络、注入阅读器） |
| background | `commands.ts` | 快捷键与右键菜单处理（开关侧边栏、打开小窗、总结本页、右键问） |
| background | `conv.ts` | 对话流端口（CONV_PORT）握手、订阅、授权、转接处理 |
| background | `deps.ts` | 后台各模块依赖的接口定义（单测用假实现替换） |
| background | `float-host.ts` | 小窗宿主调度：确保阅读器已注入、按需发预热/显示指令 |
| background | `hub.ts` | 对话端口按标签页分组登记、侧边栏按窗口登记、推送 |
| background | `intents.ts` | 意图通道（`runtime.onMessage`）处理：划词、点击、配置读取 |
| background | `jobs.ts` | 任务执行：接单、发请求、增量合并推送、检查点、重试 |
| background | `main.ts` | 后台启动入口：挂监听器、建菜单、哨兵对账、启动扫描 |
| background | `options.ts` | 设置页通道：`settings/ensureLocked`、测试连接、列出模型 |
| background | `pages.ts` | 页面读取与缓存：按站点策略决定读不读，核对内容指纹 |
| background | `quote.ts` | 引用条预览（选中文字截前 2000 字） |
| background | `roles.ts` | 从 `sender` 推角色（content/float/sidepanel/options） |
| background | `route.ts` | 小窗/侧边栏去向决策（本窗口侧边栏开着与否、同步 `open`） |
| background | `scripts.ts` | 哨兵动态注册对账（按黑名单生成 excludeMatches，排队执行） |
| background | `store.ts` | 后台运行时状态的内存缓存（真相在 `storage.session`） |
| page | `extract.ts` | 正文抽取（V-08 方案 A 移植，分时间片执行） |
| page | `float-host.ts` | 小窗宿主 iframe；拖动/缩放不可见把手在宿主侧捕获 |
| page | `float-port.ts` | 小窗私有端口（`tabs.connect`），只认本扩展 float.html 来源 |
| page | `notice.ts` | 网页上的一行提示（小窗用不了时引导去侧边栏） |
| page | `page-read.ts` | 响应后台 `page/read`：抽取、算指纹、回传、选区锚点 |
| page | `reader.ts` | 阅读器总入口：挂载小窗宿主、私有端口、网页提示、页面读取 |
| page | `selection-bus.ts` | 哨兵与阅读器之间共享选区矩形/修订号的小总线（全局符号） |
| page | `selection-policy.ts` | 选区判断：是否弹工具栏、是否代码、表单输入例外规则 |
| page | `sentinel.ts` | 哨兵：监听选区、驱动工具栏、子框架问级别 |
| page | `toolbar.ts` | 工具栏 UI（封闭 Shadow DOM + popover）与定位算法 |
| ui | `AnswerView.tsx` | 回答区组件（小窗与侧边栏共用）：状态、思考、重试、等待提示 |
| ui | `FloatApp.tsx` | 小窗整体组件：握手、订阅、发问、断线重连、转接 |
| ui | `OptionsApp.tsx` | 设置页组件：连接管理、测试连接、站点规则 |
| ui | `SidePanelApp.tsx` | 侧边栏整体组件：跟随标签页、开关快捷键、授权 |
| ui | `WelcomeApp.tsx` | 欢迎页组件（骨架，一行占位文字） |
| ui | `ask-defaults.ts` | 发问默认参数（模型/长度档/思考强度/上下文档位）读取 |
| ui | `error-labels.ts` | 模型错误分类对应的界面文案 |
| ui | `float/state.ts` | 小窗/侧边栏共用的纯归约逻辑（增量合并、状态机、消息构造） |
| ui/render | `block-splitter.ts` | 把解析后的 token 流切成顶层块分组，块起始偏移做稳定 key |
| ui/render | `citation.ts` | 引用标记（全角【N】）解析与安全挂载 |
| ui/render | `code-copy.ts` | 代码块复制按钮（Clipboard API，失败退回 execCommand） |
| ui/render | `highlight.ts` | 代码高亮（highlight.js 子集语言，超长跳过，异常兜底纯文本） |
| ui/render | `index.ts` | 渲染模块对外唯一入口，外部代码不直接碰内部文件 |
| ui/render | `katex-render.ts` | KaTeX 安全封装（trust:false、maxSize/maxExpand、宏不跨消息） |
| ui/render | `markdown-it-setup.ts` | markdown-it 实例配置：html:false、链接/图片协议白名单 |
| ui/render | `math-plugin.ts` | 极简公式语法插件（`$$...$$` 块级、`$...$` 行内） |
| ui/render | `mount.ts` | 把渲染结果按稳定 key 增量挂载进真实 DOM，接选区保护与节流 |
| ui/render | `protocol.ts` | 链接协议白名单判定（http/https/mailto，防编码绕过） |
| ui/render | `scheduler.ts` | 流式更新节流（同帧合并、长文本限最小间隔） |
| ui/render | `selection-guard.ts` | 用户选区保护：延后替换正在被选中的块 |
| ui/render | `streaming-renderer.ts` | 按块增量渲染：未完成块每次重渲，已完成块缓存复用 |
| platform | `settings-store.ts` | 设置读取（`storage.local`），统一走迁移与校验 |

## 4. 消息协议与契约

协议定义在 `src/core/domain/messages.ts`，配合 `bytes.ts`（字节口径）、`schema.ts`（运行时校验）、
`job.ts`/`float.ts`（状态机与限额）。改协议的流程以 `CLAUDE.md` 为准：只在这个文件定义，后台入口做运行时
校验，未知类型与超限消息一律拒绝且无副作用。

契约标签（`git tag -n3`）：

| tag | 日期 | 内容 |
| --- | --- | --- |
| `contract-v1` | 2026-11-14 | 冻结：领域类型、消息协议、页面模型、数据库表结构、设置与迁移、模型适配器接口 |
| `contract-v1.1` | 2026-11-18 | 小窗断线重连：新增 `conv/resumeFloat`、`FloatBinding`、`bindingMatches` |
| `contract-v1.2` | 2026-11-19 | 测试连接带上所选模型；补设置页三类应答的类型 |
| `contract-v1.3` | 2026-11-21 补打，指向 `51a77a8` | 原型验证期间的增量：页面缓存未变应答 `page/docUnchanged`；小窗拖动缩放改宿主侧（去掉 `float/move`，加 `float/reposition`、`float/rect`）；侧边栏订阅与转接（`conv/subscribed`、`conv/current`、`conv/notice`、`handoff/pending`、`sidepanel/toggle`、`sidepanel/wake`）；网页提示 `page/notice`；拒绝原因 `busy`（决策 067、069、072–076） |

`contract-v1.3` 是 2026-11-21 收尾时补打的：v1.2 之后改过 `messages.ts` 的提交有 `6fc136f`、`21e69b6`、`24cdc19`、`dd5e661`、`51a77a8`，tag 指向其中最后一个。之后再改协议，改完打下一个 `contract-v1.x` tag。

## 5. 测试资产

**单测**（`pnpm test`，Vitest）：

| 目录 | 覆盖范围 |
| --- | --- |
| `tests/unit/background/` | 任务/订阅/鉴权/页面读取/设置通道逻辑；用 `harness.ts` 提供的假 `storage.session`、假端口、假适配器 |
| `tests/unit/core/` | `contracts.test.ts` 覆盖 messages/job/float/site-policy/settings/bytes 的运行时校验与边界；另有锚点算法、chat-completions 适配器、页面指纹/pageKey |
| `tests/unit/page/` | 抽取、选区策略、小窗私有端口、小窗与工具栏的定位算法 |
| `tests/unit/ui/` | 小窗/面板共用归约器的状态机、界面样式单位检查（见第 6 节） |
| `tests/unit/ui/render/` | V-10 渲染管线：安全（HTML 注入/危险协议）、流式一致性、引用、代码复制、高亮、KaTeX、选区保护；辅助文件 `chunk-utils.ts`、`dom-assert.ts`、`fixtures.ts` |
| `tests/unit/check-deps.test.ts` | 依赖方向规则本身的单测（core 纯净、page 不引 ui、哨兵无第三方依赖） |
| `tests/unit/mock-relay.test.ts` | 模拟中转站自身的单测 |

**e2e**（`pnpm test:e2e`，Playwright，需先 `pnpm build`）：

| spec | 覆盖什么 |
| --- | --- |
| `smoke.spec.ts` | 扩展能加载、固定 ID、哨兵已动态注册 |
| `toolbar.spec.ts` | 划词弹工具栏（含网页拦截冒泡、安装后已开网页补注入） |
| `ask-flow.spec.ts` | 划词→问→小窗→模拟中转站流式回答；断线后 `conv/resumeFloat` 重连接着问 |
| `retry.spec.ts` | 中途断线后「重试」按钮；停止之后也能重试 |
| `routing.spec.ts` | 冷启动/休眠后点「问」、小窗加载/握手失败、快捷键无选区唤起、右键问与总结本页 |
| `handoff.spec.ts` | 小窗转侧边栏：无缝续上、提前/转接后到、迟迟没接上不收起 |
| `sidepanel.spec.ts` | 侧边栏最小版：跟随标签页、本窗口授权、开关快捷键（关）、两界面同时发问、开合与阅读位置 |
| `site-policy.spec.ts` | 权限矩阵、黑名单、敏感输入隔离（表单值不读、只读代码例外） |
| `page-identity.spec.ts` | 页面身份与缓存失效：hash 路由、查询参数、前进后退、双标签页 |
| `request-plan.spec.ts` | 请求装配与预算：发送计划与实际请求体逐项对账 |
| `ipc-boundary.spec.ts` | IPC 授权与 iframe 边界：封闭 shadow root、跨标签页令牌隔离、导航后令牌作废 |
| `lifecycle.spec.ts` | 等响应头的 28 秒连接超时（真实未缩放时间，单独跑） |
| `float-interaction.spec.ts` | 小窗交互：拖动/缩放、Tab 焦点、输入法组合、复制代码、200% 缩放、生成中继续阅读 |
| `markdown.spec.ts` | 回答安全渲染接入小窗：标题/列表/代码/表格/公式/链接/原始 HTML；流式中途选中不被打断 |
| `wait-hint.spec.ts` | 等待时按时间分级提示文案（7 秒/15 秒档） |
| `options.spec.ts` | 设置页：测试连接报错改地址重测、落盘设置、Key 不出现在页面上 |

共用 helper：

- `tests/e2e/page-helpers.ts` — 约 20 个导出：起模拟中转站（`startRelay`）、造 `Connection`/`Settings`、读写设置、点「问」、取小窗 frame、断言无工具栏、直接发 `conv/ask`、解析请求体、取 `selectionRevision` 等
- `tests/e2e/sidepanel-helpers.ts` — 侧边栏页面 Playwright 拿不到（不是标签页，见第 6 节），改用浏览器级 CDP（`Target.attachToTarget`）附加；提供 `attachPanel`、`openPanelByTrustedClick`、`askInPanel` 等
- `tests/e2e/fixtures.ts` — 扩展 Playwright 的 `test`：加载解压缩扩展的持久化上下文，等哨兵注册完成才把 `serviceWorker` 交给用例

**模拟中转站**（`tests/mock-relay/server.ts`，`pnpm mock-relay`）：OpenAI 兼容的 `/v1/chat/completions`、
`/v1/models`；模式放在路径里（`ok`/头部延迟/中途静默/长任务/非流式/换行风格变体/心跳/各类拆包/多种错误码/
`failOnce` 等 20 种，见文件头表格）；`MOCK_RELAY_SCALE` 可压缩等待时间；`GET /__log` 读取收到的请求（不记录
Key，只记是否带鉴权）。

**scripts/**：

| 文件 | 作用 |
| --- | --- |
| `check-deps.ts` | 依赖方向检查（core 纯净 / page 不引 ui / 哨兵无第三方依赖） |
| `check-manifest.ts` | 产物清单权限与 `manifest-baseline.json` 的差异检查 |
| `check-size.ts` | 产物体积：哨兵 gzip ≤10KB 硬门槛，阅读器 50KB 为提示性初值 |
| `v08-port-eval.ts` | 在 V-08 原型的 28 个样本上比较原型方案 A 与 `src/page/extract.ts` 移植版，需要外部样本目录 |
| `manifest-baseline.json` | 权限基线数据（不是脚本），改权限要同步它并在 PR 里标出 |

**package.json scripts**：`dev`/`build`/`verify`/`test`/`test:e2e`/`mock-relay` 已在 `CLAUDE.md` 列出，其余：
`typecheck`（独立 `tsc --noEmit`）、`lint`/`format`（biome check）、`zip`（`wxt zip` 打包发布产物）、
`postinstall`（`wxt prepare`，安装依赖后自动跑）、`check:deps`/`check:size`/`check:manifest`（对应上面三个脚本）。
`verify` 串联：lint → typecheck → check:deps → test → build → check:size → check:manifest。

## 6. 已知坑

| 坑 | 出处 |
| --- | --- |
| 侧边栏页面不是标签页，Playwright 的 `context.pages()` 拿不到，要用浏览器级调试协议 `Target.attachToTarget` 附加 | `tests/e2e/sidepanel-helpers.ts` 文件头 |
| Playwright / 调试协议连着时后台不会因空闲被回收；测回收要用 `ServiceWorker.stopAllWorkers` 主动模拟，真实回收用分离进程测 | `docs/原型验证/记录/V-01.md`；`prototypes/v01-lifecycle/probe.mjs` |
| Preact 11 不再给数字样式值自动补 `px`（只有 preact/compat 补），`style={{ marginLeft: 8 }}` 会被浏览器忽略；长度类样式必须写带单位的字符串 | `tests/unit/ui/style-units.test.ts` 文件头 |
| 本版本后台只接受动作 `ask`，工具栏「解释」「存」等其余内置动作点击会被拒绝（`notAllowed`） | `src/background/intents.ts` 的 `action/click` |
| IPv6 字面量地址不是合法的扩展匹配模式主机，写不进哨兵排除名单；这类站点「不弹工具栏」不生效，但读取/发送仍按策略拦截 | `src/core/domain/site-policy.ts` |
| 隐藏小窗不会按 `FLOAT_LIMITS.idleDestroyMs` 定时销毁，常量已定义但未接入计时器（决策 078 推迟） | `src/core/domain/float.ts` |
| 后台约 30 秒空闲会被浏览器回收、内存清空；真相只在 `storage.session`，读取一律先看内存、没有才读 session | `src/background/store.ts` 文件头 |
| 哨兵动态注册的对账要排队执行：安装时的对账与设置变更的对账同时到达，各自先查到「未注册」再各注册一次会撞号失败（e2e 复现过） | `src/background/scripts.ts`；`docs/原型验证/PROTOTYPE_REPORT.md` 第 5 节 |
| 打开侧边栏的 `sidePanel.open` 必须在用户操作的同步段里第一时间调用，之前任何 `await` 都会被拒；「侧边栏开着」可以之后再判断（不用 `open`） | `src/background/route.ts` 文件头；ARCHITECTURE 5.2、5.4 |
| Edge 有界面跑 e2e 时冷态快点「问」约三成输入框拿不到焦点（改动前同样存在），CfT 无界面没有 | `docs/原型验证/记录/V-02.md` 第 7 节 |

## 7. 接手先做

| 步骤 | 做法 |
| --- | --- |
| 对齐基线 | `pnpm verify`，再 `pnpm build` 后 `pnpm test:e2e`。2026-11-21 基线：单测 404 个、e2e 69 个全部通过（Chrome for Testing 159，无界面） |
| 看缺口 | 第 2 节标「部分」「没有」的行，加上 `PROTOTYPE_REPORT.md` 第 4 节 |
| 改了什么就记什么 | 改协议打 `contract-v1.x` tag；新决策追加 `DECISIONS.md`（编号接 081）；改架构升版本并写变更记录；复测或新验证按 `VALIDATION_MATRIX.md` 第 5 节模板记到 `docs/原型验证/记录/`；本文件第 2 节同步更新 |
