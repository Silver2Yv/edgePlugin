# COMPETITIVE_RESEARCH.md — 同类项目调研与改进建议

> **状态：历史文档，调研结论已处置。** 采纳项写入了 `FINAL_PLAN.md`（见本文第七节与 Decision 052），不需要先读。
> 调研目的：在 `FINAL_PLAN.md`（v1.1，已定稿）基础上，综合分析社区、开源仓库、技术博客等渠道中的同类项目，寻找目前方案没有覆盖到的、有价值的需求/设计改进点。
> 调研范围：3 条并行渠道——①商业/社区类划词问答浏览器插件横评；②开源仓库技术方案；③学术阅读/知识管理场景 + 命令面板交互范式。
> 去重说明：已与内部评审 `REVIEW.md` 的结论去重，不重复其已覆盖的问题（速度/打扰程度验收指标、回答风格、默认思考强度、"整页"内容识别、隐私与数据流向、保护阅读位置、数据导出导入、模型能力库、数学公式渲染、截图退路、首期范围收窄、许可证边界等）。
> 调研方法：3 个并行调研子代理，各自用 WebSearch/WebFetch 多方交叉验证，尽量不采信单一来源的孤证。
> 本文只提调研发现与建议，不改动 `FINAL_PLAN.md` 原文；条目编号（A1、D4 等）沿用 `FINAL_PLAN.md` 的章节字母，供下一轮需求决策时对照。
> 日期：2026-11-10。

## 一、建议纳入「首期重要」

直接影响核心体验或信任底线的发现，建议在下一轮需求决策中优先处理。

### 1. 长文处理从"截断"升级为"分块摘要+可溯源"（增强 D4）
LangChain 官方文档总结的三种摘要范式——`stuff`（直塞全文）、`map_reduce`（分块并行摘要后合并，官方标注"合并会丢部分信息"）、`refine`（滚动式，逐块摘要并用后续块修正，保留连贯性）。文章类长文应优先用 `refine`，且每个摘要块要记住"对应原文哪一段"，这样总结出的每条要点才能点回原文（见第 3 条）。
Page Assist 的用户在 Discussions 里也明确要求"截断要提示具体位置"，佐证"截断必须明确提示"不是过度设计。
来源：LangChain 官方文档；github.com/n4ze3m/page-assist/discussions

### 2. 正文提取：代码块/表格/公式当"整体容器"保留，用 `getComputedStyle` 判断可见性（增强 D2/D4）
`mozilla/readability` 的清洗递归一旦进入 `<code>`/`<table>`/公式标签内部会破坏结构，正确做法是整体保留、不拆解清洗（issue #532、deepwiki 特殊内容处理说明）。折叠内容是否可读要看计算样式（`getComputedStyle`）而非内联 `style`（Omnivore PR #597 的教训：原想靠内联属性省流量，发现必须用计算样式才能判断真实可见性）。
提取失败时的兜底顺序：先退化到"直接用浏览器已渲染好的 DOM"（Wallabag/wallabagger 插件的 "Retrieve content from the browser" 开关），比直接跳截图更轻，再不行才退到截图提问。
验收用例补一条：含导航栏/Cookie 条噪音的页面，提取结果不应包含这些噪音（HARPA AI 的真实槓点：toolivity.com 评测提到它会把导航栏/弹窗一起送入 AI）。
来源：github.com/mozilla/readability/issues/532；deepwiki.com/mozilla/readability/6.4-special-content-handling；github.com/omnivore-app/omnivore/pull/597；doc.wallabag.org/user/errors_during_fetching/；tooltivity.com/extensions/harpa-ai

### 3. 原文引用跳转：三元组定位 + 三级降级容错（增强 F1）
Hypothesis（开源网页批注工具）的锚点数据结构是 `exact`（精确引用文本）+ `prefix`/`suffix`（前后约 32 字符）三元组，用近似字符串匹配（Myers 编辑距离）打分定位，而不是 DOM 路径或像素坐标——页面重排后坐标必崩。匹配失败先进入约 500ms 等待态，超时标记为"orphan"（仍可搜索找回，不报错也不静默跳空）。
建议采用同样的三级降级：精确句子高亮失败 → 退化为所在段落 → 再失败退化为所在页面/位置，并显式提示"原文可能已变化，这是最接近的位置"。
同时把跳转能力从"回答里的引用"扩展到"总结/提取要点"类输出的每一条——有同名但不同开发商的 "TLDR" 扩展的用户反复要求"摘要要点要有 section links，点击即跳转+高亮对应原文段落"。
来源：github.com/hypothesis/client（PR #3706、#3953）；npmjs.com/package/dom-anchor-text-quote；chrome-stats.com/d/olbalnggpjclejiepiiidbckdbhmdhnf

### 4. 收藏/高亮必须本地保存原文文本快照，不能只存锚点（新增 G）
Hypothesis、Weava Highlighter 的用户反复投诉"原网页改了/链接失效后批注就消失了"——因为它们把锚点/云端活页面当唯一真相源。应在收藏时额外存一份"被引用那段文字+必要上下文"的本地快照，这样即使锚定失败或原页面消失，笔记里依然能看到当时的原文。数据应以本地存储为主、云同步为辅，这是数据丢失风险点，不是锦上添花。
来源：chrome-stats.com/d/cbnaodkpfinfiipjblikofhlhlcickei/reviews（Weava）；社区已自建 ≥4 种第三方备份工具佐证 Hypothesis 的同类问题

### 5. 划词工具栏的克制原则：固定显示 5-7 个+按内容类型自动过滤（增强 A1/A3）
PopClip（macOS 划词工具栏的经典先驱）没有搜索框，纯图标横排，超宽才出现"•••"子菜单；管理大量动作靠：用户在设置里手动勾选哪些动作显示在工具栏（白名单制）、每个动作可按正则/App/内容类型（如是否为 URL）自动条件过滤、可拖进文件夹做二级分组。
Cherry Studio（一个和我们场景高度重合的真实竞品）官方 Issue #6505 明确说"工具栏最多 6 个功能……暂不会支持靠隐藏菜单塞更多功能"，超出的自定义功能需去主窗口完成；另有技术限制"工具栏是非焦点窗口，无法响应快捷键"——这是需要提前规划焦点管理的技术坑。
来源：popclip.app/guide/extensions、popclip.app/guide/settings；github.com/CherryHQ/cherry-studio/issues/6505

### 6. 代码容器内的选区应显示专属预置动作（增强 A1/A3）
GitHub 官方文档证实：在 github.com 代码文件视图中选中代码行，选区旁会出现专属 Copilot 图标；普通文字（如 Issue/PR 描述）拖选不会触发任何图标，走通用入口。VS Code 的 "Explain selected code"/"Fix"/"Generate tests" 等命令只在代码上下文出现。
建议划词工具栏检测选区是否落在 `<pre>`/`<code>` 内，命中时切换成专属预置动作集合："解释代码"（复用现有"解释"但换用更懂代码语境的提示词，首期重要）、"识别语言/框架"（首期次要，也可做成代码块 hover 常驻小图标而非挤进选区工具栏，参考 Sourcegraph 浏览器扩展的做法）。"生成测试"/"优化代码"偏编码场景，不符合"不做 Agent 改代码"的定位，不建议照搬。
来源：docs.github.com/en/get-started/exploring-projects-on-github/using-github-copilot-to-explore-projects；sourcegraph.com/docs/integration/github（注：Sourcegraph Cody 已于 2025 年 7 月停用个人版，官方宣布 2027-01-31 全线 EOL，仅作交互范式参考）

### 7. 命令面板：预留键改为呼出"动作命令面板"（新增 J4）
直接回应"浏览器一个扩展最多预设 4 个快捷键"这条已知约束。**调研范围内没有找到任何划词工具栏类产品做过"热键呼出后模糊搜索选动作"**——这是真正的差异化点（已用"PopClip for Chrome alternative"、"selection popup fuzzy search actions"、"划词工具栏自定义动作模糊搜索"等多组关键词搜索确认空白；Pickit 等真实划词扩展用的是树状子菜单而非模糊搜索）。方案：
- Alfred 的核心经验：热键只占 1 个系统位，面板内部用文字关键词路由，不占用系统热键位，多个命令甚至可共用关键词；
- Raycast 的排序逻辑：别名精确匹配 > 别名前缀 > 标题模糊分 > frecency（频率+新近度），同时支持手动 "Add to Favorites" 置顶（自动学习和手动置顶必须共存，缺一不可），可 "Reset Ranking" 清权重；
- 候选列表按选中内容类型（文本/代码/链接/图片）过滤，呼应第 6 条；
- Chrome/Edge 扩展生态里"热键呼出+模糊匹配+键盘导航"的命令面板技术实现已经成熟（非划词场景），证明 MV3 扩展实现轻量命令面板没有技术障碍。
来源：alfredapp.com/blog/tips-and-tricks/tutorial-using-the-same-keyword-for-multiple-actions；manual.raycast.com/search-bar；chromewebstore.google.com/detail/pickit/lbgneockapidlejbhlnaofjmdikfjmlf；github.com/theluckystrike/webext-command-palette

### 8. "回答纪律"独立于上下文三档（增强 D）
Humata AI 提供 Grounded（严格基于所选内容作答，文档里找不到答案就明确说"无法根据所提供文档回答"）/ Balanced（以文档为主但可能补充文档外信息）/ Creative（宽松发挥）三档，独立于"喂多少原文"之外的第二层控制。这正好回应"1927/1934 两次失败"场景的反面情况：如果原文确实没交代，模型该怎么说，而不是悄悄用自身知识编一个。建议补上这个维度，并在回答里标注内容来自原文还是模型自身知识。
来源：docs.humata.ai/guides/readme/chat-settings

### 9. 公式/图表需要独立于划词的点击/框选触发入口（增强 E）
Explainpaper（官方定价页宣传语："Click graphs, figures, and equations to explain them"）、SciSpace（框选公式/表格区域弹出逐符号讲解）都证实：论文里的公式/图表常是图片渲染或特殊字符，划词机制天然选不中。多篇独立评测（含同行评审论文 *Journal of Medical Artificial Intelligence* 2025 系统测试 48 篇临床文章）一致证实"先把图表/公式解析成文本再喂给文本模型理解"这条路线效果普遍差，应优先走"截图+视觉模型"路线，并在回答中提示"图表解析可能不完全准确，建议核对原图"。
来源：explainpaper.com/pricing；scispace.com/help/en/articles/10719149；jmai.amegroups.org/article/view/9451/html

### 10. 信任/隐私红线（增强 D7/I1，新增产品原则）
- 自带 Key/中转站连接时，**平台侧绝不能设用量上限**——HARPA AI 因对自带 Key 用户照样限流被普遍质疑"割韭菜"（tooltivity.com/extensions/harpa-ai/advisor），这条要写成不可妥协的产品原则。
- 联网搜索/带全文抓取场景，不能让网页内容诱导模型自由决定抓取其他地址——Page Assist Issue #954 实际暴出过 SSRF 级问题（抓取/联网工具可被页面内容通过提示注入诱导去请求任意内网地址，默认无主机校验、无用户确认），抓取目标域名要可审查/可见。
- 任何情况下不得未经用户明确同意修改浏览器全局设置（主页/新标签页/默认搜索）——Perplexity 插件因"擅自劫持新标签页且无法关闭"被普遍投诉到弃用（extwise.com/extension/perplexity-ai-search-2）。
- 配额/升级提示绝不能用模态弹窗打断正在进行的划词手势，只能用非打断式的角标提示——Monica AI（"用十分钟就被升级弹窗轮番轰炸"）、HARPA AI 都因此被骂；用户关闭/禁止某站点读取后，该站点不应有任何后台脚本或内存占用——Opera Aria 长期被投诉"关闭后仍占用近 2GB 内存、循环加载刷爆日志"（forums.opera.com/topic/84366、85427）。建议直接写进验收标准。
- 需要一个比"默认收起"更显眼、更容易找到的全局/按站点"完全关闭 UI"开关——Glarity 的教训：市面已经出现专门用来屏蔽别家插件按钮的第三方扩展（chromewebstore.google.com/detail/ai-blocker-element-blocke），说明"默认收起"级别的克制对部分用户仍不够。
来源：github.com/n4ze3m/page-assist/issues/954；chrome-stats.com/d/cmnlolelipjlhfkhpohphpedmkfbobjc/reviews（Glarity）

## 二、建议纳入「首期次要」

| 建议 | 对应章节 | 来源依据 |
| --- | --- | --- |
| 导出格式结构化（原文片段/笔记/来源链接拆成独立字段，而非一段纯文本） | 增强 G2 | Readwise→Anki 社区工作流（Reddit r/readwise《Flashcards》、r/Anki《Automated Highlight-to-Anki Cards》、xxhk.org 教程、github.com/smoothbrain-ai/smoothbrain-anki）普遍要求结构化字段才能被外部工具正确映射，原始高亮直接当卡片质量不够 |
| 笔记条目与高亮双向跳转（内部稳定ID+内部链接，导出时转为可读锚点文本） | 增强 G4 | Zotero Better Notes（github.com/windingwind/zotero-better-notes）的双向链接设计，支持按高亮颜色自动归类插入笔记对应章节 |
| 点击参考文献弹出被引摘要（可走 Semantic Scholar/CrossRef 公开 API） | 新增 G | Scholarcy「Show Findings」（help.scholarcy.com）、Humata 复用原文已有编号直接跳转（humata.ai），都证实这是轻量可行的做法；真正的引用图谱可视化（如 Connected Papers/scite.ai 的做法）留给后期 |
| 回答末尾自动给 2-3 个追问建议 + "换个模型重新回答"按钮（沿用原上下文） | 新增 | Perplexity 插件官方帮助中心；"换模型重答"是"多模型对比"的轻量变体（顺序换模型而非并列展示） |
| 新建对话可选"本次不归档"开关 | 新增 C/G | Brave Leo 的临时对话模式（brave.com/zh-tw/leo）；和已规划的"敏感输入不读取"是不同维度——这是输出侧是否持久化 |
| 自定义动作可选"仅在指定网站生效"+"覆盖全局上下文档位" | 增强 A3 | Monica AI PowerUP 自定义工具可指定"应用网站范围"和"内容提取模式"（monica.im/help 官方文档） |
| 已知不支持边界补充 Shadow DOM（不只是 iframe） | 增强 D8 | immersive-translate CHANGELOG 显示 iframe 支持是逐版本修的（inline iframe、dynamic iframe css inject、多 iframe 限流），Shadow DOM（评论区等 Web Component）是更隐蔽的坑，单独有修复记录 |
| 模型连接诊断：CORS/403 单独列为一类原因 | 增强 H9 | Page Assist 文档（docs/connection-issue.md）：直连本地模型常见 403/CORS，和"地址缺 /v1"是完全不同的故障分支 |
| 思考内容混入结构化输出会导致解析失败 | 增强 H6（补充技术依据） | Read Frog 文档明确警告"reasoning 输出会干扰某些模型的结构化响应，应禁用"（readfrog.app/en/docs） |
| 逐字输出开关细化为"短回答/快捷动作可选整段展示" | 增强 H7 | immersive-translate Issue #2817：用户反馈逐字流式不如一次性显示快，对"问/解释"这类预期简短回答的场景尤其明显 |
| 连接诊断范围扩展到"生成过程中断" | 增强 H9 | Brave Leo 用户反复反馈"回答卡在思考中无输出或被莫名截断，需反复重试"（community.brave.app） |

## 三、建议纳入「后期」，但建议**现在**就为其预留数据结构

这几条功能本身应留在后期，但如果收藏/历史模块的数据结构现在设计得太窄，后期加这些会推翻重做：

- **跨文献/跨页面联合问答**：SciSpace（learn.scispace.com，Literature Review 功能）、Scholarcy（Literature Synthesis Matrix）、Humata（Ask All 机制）三个独立产品都收敛到同一形态——**结构化对比表**（可自定义列、导出 Excel/Word），而不是聊天式口头综合多篇内容；文档范围选择器（选哪几篇）要和内容范围选择器（选中/上下文/全文）分开，靠勾选而不是让 AI 猜。Zotero 官方论坛也有大量"RAG 索引全库+每条结论可点击溯源到来源论文具体页码、不编造引用"的功能请求帖。→ 建议收藏记录现在就预留「可检索文本片段 + 来源定位元数据」字段。
- **多模型并列对比回答**：Sider AI 的 Group Chat 模式（同一问题 @多个模型，实时并排展示各家回答），是调研范围内唯一有明确先例的实现（chromewebstore.google.com/detail/sider-chat-with-all-ai-gp）。
- **事实核查/交叉核实**：Wiseone（已于 2025 年停运，因免费额度太少——每天 10 次查询——加定价问题流失用户，提醒这类高成本动作要控制用量上限）用多信源对比列表呈现而非单一断言；Full Picture（chromewebstore.google.com/detail/full-picture-research-ana）给用户几个搜索关键词让用户自己查证而非直接下结论，更契合"不替用户下结论"的理念；VeroRead 用滑杆把全文重写到目标阅读难度，比只显示一个可读性分数更直接可用；IQPage 支持最多 3 篇文章并排对比。可以作为"联网搜索"开启后的一种专门呈现模式起步，阅读难度分级/偏见检测可再往后排。
- **跨标签页/浏览历史联合问答**：OpenAI 官方 2026 年 10 月的 ChatGPT Chrome 插件更新（tech.yahoo.com 报道）和第三方扩展 ZIZIYI Space 都采用"@精确提及特定标签页"语法，比 Monica AI "笼统打包全部打开的标签页"更可控、更省 token。完全意义上的"浏览历史检索式联合问答"在调研范围内暂无成熟先例，若后期做，建议优先采用 `@Tab` 精确提及语法。
- **页面变化监测**（当前文档完全没涉及，属于全新方向）：Visualping、Noticer（强调"设备端 AI 处理，监控内容不离开设备"）、Pulse 等产品的共同做法是"用户框选具体关心的元素 + 设置检查频率 + AI 过滤时间戳/计数器等噪音，只在有意义变化时用一句话提醒"，而不是整页 diff（噪音太大）。这是被动监看通知，不涉及代替用户操作网页，和"不做 Agent 行为"的边界不冲突，可挂在"按页面归档"体系下作为对已收藏页面的可选附加能力。

## 四、跨产品反复验证的工程纪律（非新增需求，供参考）

- 大版本重构若破坏用户已养成的核心操作习惯，差评会异常猛烈：Sider 2.0 更新后"常用 bot 被移除、随机冻结"引发大量差评；Merlin AI 大改版后"无法再附加文件、长 prompt 处理变差"，官方承认缺陷（merlin-ai.canny.io）。→ 任何后续大版本迭代都要对"划词弹工具栏""回答能正常结束""附件/长文处理"等核心路径做回归测试。
- 免费额度/订阅权益不可悄悄收缩：Merlin AI 终身授权用户反馈额度被单方面收紧，被称为 "scam"（feedback.getmerlin.in）；Liner 因自动续费扣款、拒绝退款等问题 Trustpilot 评分仅 2.6/5。→ 未来如涉及任何限额/付费变更，必须提前公告、绝不悄悄缩水。
- 扩展注入脚本不能拖慢宿主页面本身的加载：Merlin 用户反复反馈"页面加载变慢"是常见组合抱怨之一（与弹窗打扰、隐私担忧并列）。→ 建议补一条非功能性验收标准：扩展注入不可显著拖慢宿主页面首屏加载时间。
- 内容/正文提取失败要给明确错误提示，不能静默返回空结果：Glarity 的 YouTube 字幕提取经常失败导致核心功能不可用，促使用户流失；TLDR This 长期报 "connection refused" 却无可操作的下一步。→ 这条和已规划的"测试连接给出具体报错"是同一原则在"正文提取"场景的延伸。
- 模型名需与实际调用模型严格一致可核验：Glarity 被用户发现 UI 标注"GPT-4o mini"但实测疑似为 GPT-3 级模型。→ 建议 UI 上显示的"当前使用模型"名称必须与实际请求参数一致，避免因模型别名/路由造成诚信质疑。
- `chrome.sidePanel.setOptions({tabId, path, enabled})` 可按标签页下发不同侧边栏内容，而不是全局唯一 `default_path`（dev.to/alanwest 的 Chromex 项目报道）——若后期想让侧边栏按标签页区分状态，这是现成可用的 API 路径，优先级低，仅作技术参考。

## 五、时效性说明

- Arc 浏览器已于近期公告 sunset date，用户需在约两个月内迁移（9to5mac.com/2026/10/22），本文引用其 "Ask on Page" 相关 UX 仅作交互范式参考。
- Sourcegraph Cody 浏览器扩展个人版已于 2025 年 7 月停用，官方宣布将于 2027-01-31 全线 EOL（sourcegraph.com/blog/sunsetting-cody-future-of-code-intelligence），本文引用其"代码块专属交互"仅作历史范式参考，不建议作为长期对标产品。
- Wiseone 已于 2025 年停运，本文引用其事实核查呈现方式仅作产品形态参考，其失败原因（免费额度太少+定价问题）本身也是一条教训，见第三节。

## 六、参考链接汇总

**商业/社区类产品**
- Sider AI：chromewebstore.google.com/detail/sider-chat-with-all-ai-gp/difoiogjjojoaoomphldepapgpbgkhkb ｜ microsoftedge.microsoft.com/addons/detail/ai-sider-chatgpt-deeps/hemigbocabiinpfpfnjicpndgggjcjad ｜ baike.baidu.com/item/Sider/65707744 ｜ rightaichoice.com/tools/sider/sentiment
- Monica AI：monica.im/help/zh-hk/Features/PowerUP/Customize_PowerUP ｜ monica.im/help/zh-cn/Features/Summarize/Summarize-Webpage ｜ toolscopia.com/review/monica-ai-monicaim ｜ aitalkboard.com/chatgpt-forum（相关帖）
- Merlin AI：feedback.getmerlin.in/mobile/p/merlin-has-become-a-scam ｜ appsumo.com/products/merlin/reviews ｜ merlin-ai.canny.io/merlin-extension ｜ chrome-stats.com/d/camppjleccjaphfdbohjdohecfnoikec/reviews
- HARPA AI：harpa.ai/guides/quick-access-bar ｜ chromewebstore.google.com/detail/harpa-ai-web-automation-w/eanggfilgoajaocelnaflolkadkeghjp ｜ tooltivity.com/extensions/harpa-ai ｜ tooltivity.com/extensions/harpa-ai/advisor ｜ skywork.ai（HARPA 分析）
- Wiseone：chromewebstore.google.com/detail/wiseone-your-ai-powered-r/paodpkkacimmkacaecjmhdncjgjepcai ｜ chrome-stats.com/d/paodpkkacimmkacaecjmhdncjgjepcai ｜ aiwizard.ai/wiseone
- Glarity：glarity.app/ja/blog/what-is-glarity ｜ chrome-stats.com/d/cmnlolelipjlhfkhpohphpedmkfbobjc/reviews ｜ addons.mozilla.org/ko/firefox/addon/glarity/reviews
- Liner：justuseapp.com/en/app/955395198/liner-ai-search-with-sources/reviews ｜ trustpilot.com/review/getliner.com
- TLDR 系：chrome-stats.com/d/olbalnggpjclejiepiiidbckdbhmdhnf ｜ addons.mozilla.org/ja/firefox/addon/tldr-this-auto-text-summary/reviews
- Perplexity 插件：addons.mozilla.org/zh-TW/firefox/addon/perplexity-sidebar/reviews ｜ extwise.com/extension/perplexity-ai-search-2 ｜ perplexity.ai/help-center（帮助中心）
- Arc 浏览器：zdnet.com（Arc AI 报道）｜ 9to5mac.com/2026/10/22（sunset 公告）
- Opera Aria：blogs.opera.com/tips-and-tricks/2024/10（使用指南）｜ forums.opera.com/topic/84366 ｜ forums.opera.com/topic/85427
- Edge Copilot：windowsforum.com（价格追踪报道）｜ makeuseof.com（购物比价功能）
- Brave Leo：brave.com/zh-tw/leo ｜ support.brave.app（使用文档）｜ community.brave.app/t/most-leo-models-still-not-working
- BoltAI：popclip.app/extensions/x/z8j3m3 ｜ docs.boltai.com/docs/start/ai-command ｜ saashub.com/boltai
- 事实核查/变化监测类：chromewebstore.google.com/detail/ai-blocker-element-blocke/ekmdmocoaiokgdgmemgjepdfdaglfaom ｜ chromewebstore.google.com/detail/full-picture-research-ana/dfnhlnnmcjnmlihpjbkdefpnfdpgedbn ｜ chromewebstore.google.com/detail/iqpage/igbighpdnelefhkbaknocckccpjconln ｜ chromewebstore.google.com/detail/visualping-website-change/pemhgklkefakciniebenbfclihhmmfcd ｜ addons.mozilla.org/en-US/firefox/addon/ai-change-monitor-noticer
- 跨标签页：tech.yahoo.com/ai/chatgpt/articles/chatgpt-now-look-chrome-tabs-100615531.html ｜ chromewebstore.google.com/detail/ziziyi-space-chat-with-we/lilckelmopbcffmglfmfhelaajhjpcff

**开源仓库技术方案**
- Page Assist：github.com/n4ze3m/page-assist ｜ github.com/n4ze3m/page-assist/blob/main/docs/connection-issue.md ｜ github.com/n4ze3m/page-assist/discussions ｜ github.com/n4ze3m/page-assist/issues/954 ｜ github.com/n4ze3m/page-assist/issues/402
- Glarity（开源部分）：github.com/sparticleinc/chatgpt-google-summary-extension
- mozilla/readability：github.com/mozilla/readability/issues/532 ｜ deepwiki.com/mozilla/readability/6.4-special-content-handling
- Omnivore：github.com/omnivore-app/omnivore/pull/597
- Wallabag：doc.wallabag.org/user/errors_during_fetching
- LangChain 摘要范式：langchain-doc.readthedocs.io/en/latest/_sources/modules/indexes/combine_docs.md
- immersive-translate：github.com/immersive-translate/immersive-translate/issues/2817 ｜ immersive-translate.owenyoung.com/CHANGELOG
- Read Frog：github.com/mengxi-ream/read-frog ｜ readfrog.app/en/docs/providers/overview
- Chromex（sidePanel API 技术报道）：dev.to/alanwest/chromex-building-an-ai-side-panel-assistant-into-your-browser-2ch4

**学术阅读/知识管理**
- Hypothesis：github.com/hypothesis/client（PR #3706、#3953）｜ npmjs.com/package/dom-anchor-text-quote ｜ github.com/BigBlueHat/approx-string-match-js
- Weava Highlighter：chrome-stats.com/d/cbnaodkpfinfiipjblikofhlhlcickei/reviews
- Readwise → Anki：reddit.com/r/readwise（Flashcards 帖）｜ reddit.com/r/Anki（Automated Highlight-to-Anki Cards 帖）｜ xxhk.org/readwise2anki ｜ github.com/smoothbrain-ai/smoothbrain-anki
- Zotero：forums.zotero.org/discussion/132331（AI 跨库问答功能请求）｜ github.com/windingwind/zotero-better-notes
- Obsidian/Notion 网页剪藏：obsidian.md/help/web-clipper/interpreter ｜ notion.com/releases/2020-09-17
- Explainpaper：explainpaper.com/pricing
- SciSpace：scispace.com/help/en/articles/10719149 ｜ learn.scispace.com/tutorials（文献综述、文库使用）
- Humata AI：docs.humata.ai/guides/readme/chat-settings ｜ docs.humata.ai/guides/readme/how-to-ask-all
- ChatPDF：toolsdepth.com/reviews/chatpdf-review-2026
- Scholarcy：help.scholarcy.com/guide/supercharge-your-reading ｜ scholarcy.com（文献综合相关文章）
- 图表/公式解析评测：jmai.amegroups.org/article/view/9451/html
- 文献计量工具综述：dspacemainprd01.lib.uwaterloo.ca（相关学位论文）

**命令面板范式与代码阅读 AI 交互**
- Alfred：alfredapp.com/blog/tips-and-tricks/tutorial-using-the-same-keyword-for-multiple-actions ｜ alfredapp.com/help/workflows/inputs/keyword
- Raycast：manual.raycast.com/search-bar
- PopClip：popclip.app/guide/extensions ｜ popclip.app/guide/settings
- Cherry Studio：github.com/CherryHQ/cherry-studio/issues/6505
- Pickit：chromewebstore.google.com/detail/pickit/lbgneockapidlejbhlnaofjmdikfjmlf
- 浏览器扩展命令面板实现参考：github.com/theluckystrike/webext-command-palette ｜ mv3-extension.com（命令面板构建教程）
- GitHub Copilot：docs.github.com/en/get-started/exploring-projects-on-github/using-github-copilot-to-explore-projects ｜ docs.github.com/en/copilot/how-tos/chat-with-copilot/chat-in-github ｜ learn.microsoft.com（Copilot 文档生成/解释功能培训材料）
- Sourcegraph Cody：sourcegraph.com/docs/integration/github ｜ sourcegraph.com/blog/sunsetting-cody-future-of-code-intelligence

## 七、采纳结论（2026-11-12，对应 Decision 052）

### 已采纳，写入 FINAL_PLAN v1.2（编号按 v1.3 修正）

| 调研条目 | 写入位置 | 处理方式 |
| --- | --- | --- |
| 一.2 正文提取保留代码/表格/公式，按计算样式判断可见性 | D6、D7 | 直接采纳；兜底顺序改为「读已渲染 DOM → 截图提问」 |
| 一.3 三元组定位与三级降级 | F1、F2 | 采纳定位思路与降级顺序；未采用 500ms 等待与 orphan 归档，改为「完全找不到则不可点击」 |
| 一.3 总结要点可跳回原文 | F3 | 采纳，并入「总结本页」的输出规格（I6） |
| 一.4 收藏保存原文快照 | G1 | 采纳 |
| 一.5 工具栏 5–7 个、超出收进子菜单 | A2 | 采纳上限，取 5 个加「更多」 |
| 一.6 代码块专属动作 | A6 | 部分采纳：只做「解释代码」，不做「生成测试 / 优化代码」 |
| 一.7 命令面板 | J11（首期次要） | 采纳方向，但不放进核心闭环；第 4 个快捷键默认留空 |
| 二.逐字输出细化为「短回答整段显示」 | I8（首期次要） | 采纳 |
| 二.回答末尾给追问建议、换个模型重新回答 | I9、G7（首期次要） | 采纳；追问建议并入「问题建议」（Decision 053），G7 只保留换模型重答 |
| 二.CORS / 403 列为独立故障 | H9 | 采纳 |
| 二.生成过程中断纳入诊断 | H9 | 采纳 |
| 三.数据字段为跨文献、跨页问答预留 | 5.3 说明 | 采纳为数据结构约束，功能留在后期 |
| 四.不拖慢宿主页面加载 | 第 2 节、第 9 节第 16 条 | 采纳为硬约束，数值待原型测定 |
| 四.正文提取失败不能静默 | D15 | 采纳，与 D16 合并 |
| 四.模型名与实际请求一致 | J10 | 采纳 |
| 一.10 抓取地址可见可审查 | M8 | 采纳，防提示注入诱导的越权抓取 |

### 部分采纳或改写

- 一.1 分块摘要（refine）：作为首期次要 I7 保留；首期先用 20%–40% 截取，两者取舍留到原型实测（Decision 041）。
- 一.8 回答纪律三档（Grounded / Balanced / Creative）：不设三档开关，改为一条默认提示词规则（I4）加可编辑提示词。三档开关会增加一个用户每次都要做的判断，与「轻」冲突。
- 一.9 公式图表的专属入口：E5 列首期次要；E1 已覆盖「划不了词就截图」这条退路。
- 一.10 全局「完全关闭 UI」开关：A4 的两级黑名单覆盖（不弹工具栏 / 不读取页面），不另设独立开关。
- 二.自定义动作限定生效网站与覆盖档位：列入后期（5.3）。

### 不采纳

- 学术向条目：参考文献摘要弹窗、引用图谱、阅读难度分级、跨文献对比表。这些偏离「网页阅读」的主场景；对比表与联合问答只作为后期方向保留。
- 多模型并列对比（Sider 式）：成本高、界面重，列入后期观察。
- 页面变化监测（Visualping 式）：属于被动监看，与阅读助手不是同一件事，暂不做。
- 命令面板的「按内容类型过滤候选」：首期动作数量少，过滤没有收益，留到动作变多以后。
