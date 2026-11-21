# V-08：PageDoc 与正文质量 —— 原型验证结果

对应 `docs/架构设计/VALIDATION_MATRIX.md` 第 120-130 行 V-08 用例，第 5 节结果记录模板。本文件只记录本原型（`prototypes/v08-extraction/`）范围内的发现，不代表最终产品决策。

## 1. 方法论

- **三方案**，相同输入（同一次 Playwright 渲染后的 DOM）、相同指标：
  - **方案 A**：自研根节点识别（语义标签优先 → 文本密度兜底，按 `ARCHITECTURE.md` 5.6 节规则）+ 自研块切分。
  - **方案 B**：Mozilla Readability（`@mozilla/readability`，Apache-2.0）定位正文根节点，用自研的"返回 DOM 而非字符串"定制序列化器切块。
  - **方案 C**：在克隆 DOM 上跑 Defuddle（`defuddle`，MIT）做标签/清洗，再把结果块映射回真实 DOM 节点。
  - 三方案全部在 Playwright 真实 Chromium（非 jsdom）里通过 `page.evaluate` 运行，详见 `src/fetch-and-extract.mjs`。
- **指标口径**（`src/compute-metrics.mjs`）：
  - 关键证据召回 = 人工标注的 3 条 `keyEvidence` 原文引用里，能在该方案自身输出的拼接文本中找到（空白归一化、大小写不敏感的子串匹配）的条数。
  - 远距离指代召回 = 人工标注的 `distantReference`（定义句+引用句）两段文本是否都能在该方案输出中找到；只有存在这种天然"先定义后引用"结构的样本才设置，详见每个 `samples/<id>.labels.json` 的 `notes`。
  - 噪声比例 = 匹配到一组明确的"页面 chrome/导航/广告/页脚/UI 元信息"正则的块字符数 / 该方案输出总字符数，由 `src/gen-noise-review.mjs` 按块逐一比对计算、写入 `results/<id>.noise-review.json`（正则规则本身和命中明细可用 `node src/gen-noise-review.mjs --audit` 复核）；少数"方案整体输出都是无关 chrome"的样本（GitHub 代码页 A/B、跨源 iframe 页 A）直接按人工核对结论记 100%，不依赖正则覆盖率。噪声比例 ≥5% 才标记 `boilerplate-noise` 错误分类，低于 5% 的零星噪声视为可忽略、标 `none`（判断过程见本文件第 5 节）。
  - 映射率 = 方案输出的块里，能成功映射回真实 DOM 节点的比例；方案 A/B 直接操作真实 DOM，映射率恒为 100%；方案 C 因为在克隆 DOM 上跑第三方库再映射回去，存在映射失败。
  - 耗时 = `page.evaluate` 内实测的抽取耗时（不含页面加载/渲染时间）。
  - 表单值泄漏 = 方案是否把 `<textarea readonly>` 等表单控件的 value 当正文读出（必须为否，对应架构 M6 约束）。
  - 错误分类词表：`none`（无明显问题）/`root-mis-selection`（根节点选错，漏掉真正正文）/`under-extraction`（漏掉大量真实正文但根节点本身没选错）/`total-extraction-failure`（几乎零输出）/`atomicity-violation`（代码块等本应是原子单元的内容被打散）/`boilerplate-noise`（噪声占比≥5%）/`granularity-collapse`（大量内容被合并进 1-2 个超大块，破坏上下文单元边界）/`visibility-violation`（读取了不应读取的隐藏内容）。
- 样本页面是**公开网页**，仅用于本地原型测试，不随仓库分发、不提交到 git；样本 DOM/截图留在 `prototypes/v08-extraction/samples/`、`results/`，均在 `.gitignore` 范围外的独立目录里，且本原型从未执行 `git commit`。
- **重要限制**：以下所有耗时、渲染结果均来自 Playwright 自带的 Chromium，**不代表真实 Chrome/Edge 的渲染结果或性能**——字体、扩展、企业策略、真实网络延迟等因素在这里都不存在，正式验证仍需要在目标浏览器上复测。

## 2. 样本集

共 28 个真实公开页面（不是去敏/合成数据，部分因沙箱网络访问限制换成了同类替代站点，替换原因见各样本 `label` 字段或 `samples/<id>.labels.json` 的 `notes`），覆盖 21 个分类，含 4 个反例样本（SPA 首页、论坛帖、登录墙、只读 textarea 代码页）。完整清单：

| 编号 | 分类 | 说明 | 反例 |
|---|---|---|---|
| accordion-govuk | 折叠内容（手风琴） | [GOV.UK Design System Accordion 组件示例](https://design-system.service.gov.uk/components/accordion/) | 否 |
| adv-forum-thread | 反例：论坛串 | [Discourse 论坛讨论串（discuss.python.org，虚拟滚动/异步加载）](https://discuss.python.org/c/committers/5) | 是 |
| adv-login-wall | 反例：登录墙 | [LinkedIn 公开主页（未登录只显示截断内容并提示登录）——沙箱内多个候选均被反爬/地域拦截，记录为环境阻塞](https://www.huxiu.com/article/vip.html) | 是 |
| adv-readonly-textarea | 反例：只读 textarea 代码页 | [本地构造：正文整体位于 <textarea readonly> 内（真实公开网络上该边界场景不稳定，按架构 M6 自建最小复现页，见 index.json 说明）](src/fixtures/readonly-textarea.html) | 是 |
| adv-spa-empty | 反例：SPA 首页 | [Excalidraw（纯 canvas 应用，初始文本几乎为空）](https://excalidraw.com/) | 是 |
| arxiv-abs | 文献页 | [arXiv 摘要页（Attention Is All You Need）](https://arxiv.org/abs/1706.03762) | 否 |
| arxiv-html | 文献页 | [arXiv HTML 全文版（Attention Is All You Need）](https://arxiv.org/html/1706.03762) | 否 |
| doc-mdn-en | 技术文档 | [MDN Array.prototype.map（英文）](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map) | 否 |
| doc-mdn-zh | 技术文档（中文） | [MDN Array.prototype.map（中文）](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Array/map) | 否 |
| doc-python | 技术文档 | [Python 官方教程 控制流](https://docs.python.org/3/tutorial/controlflow.html) | 否 |
| doc-react | 技术文档 | [React 官方文档 Thinking in React](https://react.dev/learn/thinking-in-react) | 否 |
| doc-vue-tabs | 技术文档+标签页 | [Vue 官方指南 响应式基础（含 Options/Composition API 切换标签）](https://vuejs.org/guide/essentials/reactivity-fundamentals.html) | 否 |
| en-longform-pearlharbor | 英文长文 | [HISTORY.com 珍珠港事件文章（远处指代：1941 年与后续年份；维基百科在当前网络环境下不可达，见 README）](https://www.history.com/articles/pearl-harbor) | 否 |
| en-longform-pg | 英文长文 | [Paul Graham 随笔（纯手写 HTML，结构简单）](https://paulgraham.com/own.html) | 否 |
| formula-en | 带公式 | [nLab 数学百科「group」词条（MathJax/LaTeX 公式密集；维基百科在当前网络环境下不可达，见 README）](https://ncatlab.org/nlab/show/group) | 否 |
| formula-zh | 带公式（中文） | [百度百科「欧拉公式」词条](https://baike.baidu.com/item/%E6%AC%A7%E6%8B%89%E5%85%AC%E5%BC%8F) | 否 |
| github-code-argparse | GitHub 代码文件页+长代码 | [GitHub 代码文件页（CPython unittest/case.py，1652 行长代码——原计划的 argparse.py 因文件过大被 GitHub 拒绝渲染，换用这个仍然很长但能正常渲染的文件）](https://github.com/python/cpython/blob/main/Lib/unittest/case.py) | 否 |
| github-code-ref | GitHub 代码文件页 | [GitHub 代码文件页（Vue core ref.ts）](https://github.com/vuejs/core/blob/main/packages/reactivity/src/ref.ts) | 否 |
| github-readme | GitHub README | [GitHub 仓库首页（README 渲染）](https://github.com/vuejs/core) | 否 |
| iframe-cross-origin | 跨源 iframe 嵌入 | [MIT OpenCourseWare 课程页（嵌入 YouTube 跨源 iframe）](https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/resources/lecture-videos/index.html) | 否 |
| katex-docs | 带公式（KaTeX） | [KaTeX 官方文档 支持列表（大量 KaTeX 渲染公式）](https://katex.org/docs/supported.html) | 否 |
| listing-hn | 重复布局（列表页） | [Lobsters 首页（重复条目布局，替代 Hacker News——沙箱网络无法连接 news.ycombinator.com）](https://lobste.rs/) | 否 |
| listing-ruanyifeng-index | 重复布局（目录页） | [阮一峰博客首页（按月归档的重复条目）](https://www.ruanyifeng.com/blog/index.html) | 否 |
| table-heavy | 表格密集页 | [Java SE API 文档 Collections 类（方法汇总表密集；维基百科在当前网络环境下不可达，见 README）](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Collections.html) | 否 |
| tabs-bootstrap | 折叠内容（标签页） | [Bootstrap 文档 Tabs 组件示例](https://getbootstrap.com/docs/5.3/components/navs-tabs/) | 否 |
| zh-article-918 | 中文文章 | [百度百科「九一八事变」（远处指代：1931 年事变与后续年份）](https://baike.baidu.com/item/%E4%B9%9D%C2%B7%E4%B8%80%E5%85%AB%E4%BA%8B%E5%8F%98/2573930?fromtitle=%E4%B9%9D%E4%B8%80%E5%85%AB%E4%BA%8B%E5%8F%98&fromid=632843) | 否 |
| zh-article-ruanyifeng | 中文文章 | [阮一峰博客文章（从博客首页抓取当期链接）](https://www.ruanyifeng.com/blog/2026/11/weekly-issue-419.html) | 否 |
| zh-article-xian | 中文文章 | [百度百科「西安事变」（远处指代：1936 年事变与后续年份）](https://baike.baidu.com/item/%E8%A5%BF%E5%AE%89%E4%BA%8B%E5%8F%98/29897?bst=1794649643.0d18244ecf127e53) | 否 |

## 3. 三方案总体指标

| 方案 | 耗时 p50 | 耗时 p95 | 平均 DOM 映射率 | 平均关键证据召回 | 远距离指代召回（19 个有效样本） | 表单值泄漏 |
|---|---|---|---|---|---|---|
| A（自研） | 3.2ms | 23.4ms | 100% | 85.7% | 84.2% | 否 |
| B（Readability 辅助） | 29.5ms | 220.3ms | 100% | 72.6% | 68.4% | 否 |
| C（Defuddle 克隆映射） | 81.1ms | 528.8ms | 74.5% | 94.0% | 94.7% | 否（已逐样本核对，未观察到泄漏） |

（9 个样本——反例/无天然指代结构的列表页、短证据码等——没有设置 `distantReference`，如实计入分母外，见各 `labels.json` 的 `notes` 说明；不是标注遗漏。）

## 4. 逐样本指标

格式：`关键证据召回(found/total) [远引√/×] / 噪声比例 / DOM映射率 / 耗时`。噪声比例按块级正则规则精确计数，错误分类结合该规则与逐样本人工核对的结构性判断，依据见 `results/<id>.noise-review.json` 与本文件第 5 节。
| 编号 | A 召回/噪声/映射/耗时 | B 召回/噪声/映射/耗时 | C 召回/噪声/映射/耗时 |
|---|---|---|---|
| accordion-govuk | 3/3 远引√ / 噪0% / 映100% / 2ms | 3/3 远引√ / 噪0% / 映100% / 10ms | 3/3 远引√ / 噪0% / 映77.3% / 45ms |
| adv-forum-thread | 3/3 / 噪0% / 映100% / 3ms | 0/3 / 噪0% / 映100% / 26ms | 3/3 / 噪0% / 映50% / 95ms |
| adv-login-wall | 3/3 / 噪21.3% / 映100% / 1ms | 3/3 / 噪21.3% / 映100% / 5ms | 3/3 / 噪21.3% / 映75% / 33ms |
| adv-readonly-textarea | 3/3 / 噪0% / 映100% / 1ms | 3/3 / 噪0% / 映100% / 4ms | 3/3 / 噪0% / 映66.7% / 15ms |
| adv-spa-empty | 3/3 / 噪0% / 映100% / 1ms | 3/3 / 噪0% / 映100% / 11ms | 3/3 / 噪0% / 映83.3% / 39ms |
| arxiv-abs | 3/3 / 噪14.1% / 映100% / 2ms | 3/3 / 噪4.5% / 映100% / 9ms | 3/3 / 噪5.3% / 映50% / 29ms |
| arxiv-html | 3/3 远引√ / 噪0% / 映100% / 7ms | 3/3 远引√ / 噪0% / 映100% / 63ms | 3/3 远引√ / 噪0% / 映72.4% / 129ms |
| doc-mdn-en | 3/3 远引√ / 噪2.6% / 映100% / 3ms | 2/3 远引√ / 噪2.8% / 映100% / 16ms | 3/3 远引√ / 噪0% / 映69.4% / 34ms |
| doc-mdn-zh | 3/3 远引√ / 噪3.3% / 映100% / 5ms | 2/3 远引√ / 噪3.5% / 映100% / 16ms | 3/3 远引√ / 噪0% / 映66.7% / 37ms |
| doc-python | 3/3 远引√ / 噪0% / 映100% / 7ms | 3/3 远引√ / 噪0% / 映100% / 93ms | 3/3 远引√ / 噪0% / 映57.6% / 97ms |
| doc-react | 3/3 远引√ / 噪0% / 映100% / 12ms | 3/3 远引√ / 噪0% / 映100% / 61ms | 3/3 远引√ / 噪0% / 映74.3% / 86ms |
| doc-vue-tabs | 3/3 远引√ / 噪0% / 映100% / 3ms | 3/3 远引√ / 噪0% / 映100% / 43ms | 3/3 远引√ / 噪0% / 映58.9% / 58ms |
| en-longform-pearlharbor | 3/3 远引√ / 噪4.8% / 映100% / 3ms | 2/3 远引× / 噪0.4% / 映100% / 11ms | 3/3 远引√ / 噪4.6% / 映88.2% / 55ms |
| en-longform-pg | 3/3 远引√ / 噪0% / 映100% / 2ms | 3/3 远引√ / 噪0% / 映100% / 5ms | 0/3 远引× / 噪0% / 映0% / 19ms |
| formula-en | 0/3 远引× / 噪0% / 映100% / 10ms | 0/3 远引× / 噪0% / 映100% / 30ms | 3/3 远引√ / 噪0% / 映84.7% / 81ms |
| formula-zh | 3/3 远引√ / 噪2.7% / 映100% / 14ms | 3/3 远引√ / 噪0% / 映100% / 37ms | 3/3 远引√ / 噪0.8% / 映85.5% / 97ms |
| github-code-argparse | 0/3 远引× / 噪100% / 映100% / 4ms | 0/3 远引× / 噪100% / 映100% / 138ms | 3/3 远引√ / 噪0% / 映100% / 529ms |
| github-code-ref | 0/3 远引× / 噪100% / 映100% / 3ms | 0/3 远引× / 噪100% / 映100% / 66ms | 3/3 远引√ / 噪0% / 映100% / 191ms |
| github-readme | 3/3 / 噪67.3% / 映100% / 4ms | 2/3 / 噪0% / 映100% / 14ms | 2/3 / 噪0% / 映52.4% / 67ms |
| iframe-cross-origin | 0/3 / 噪100% / 映100% / 3ms | 2/3 / 噪0% / 映100% / 50ms | 3/3 / 噪0% / 映64.9% / 100ms |
| katex-docs | 3/3 远引√ / 噪0% / 映100% / 23ms | 3/3 远引√ / 噪0% / 映100% / 1020ms | 3/3 远引√ / 噪0% / 映81.8% / 973ms |
| listing-hn | 3/3 / 噪0% / 映100% / 2ms | 0/3 / 噪100% / 映100% / 26ms | 3/3 / 噪0% / 映100% / 31ms |
| listing-ruanyifeng-index | 3/3 / 噪5.6% / 映100% / 1ms | 3/3 / 噪5.6% / 映100% / 8ms | 2/3 / 噪0% / 映100% / 30ms |
| table-heavy | 3/3 远引√ / 噪0% / 映100% / 14ms | 3/3 远引√ / 噪0% / 映100% / 109ms | 3/3 远引√ / 噪0% / 映100% / 158ms |
| tabs-bootstrap | 3/3 远引√ / 噪0.3% / 映100% / 9ms | 3/3 远引√ / 噪0% / 映100% / 220ms | 3/3 远引√ / 噪0% / 映50.9% / 126ms |
| zh-article-918 | 3/3 远引√ / 噪0.5% / 映100% / 21ms | 2/3 远引× / 噪0% / 映100% / 76ms | 3/3 远引√ / 噪0.1% / 映95.6% / 242ms |
| zh-article-ruanyifeng | 3/3 远引√ / 噪0% / 映100% / 2ms | 3/3 远引√ / 噪0% / 映100% / 10ms | 3/3 远引√ / 噪0% / 映91.4% / 33ms |
| zh-article-xian | 3/3 远引√ / 噪0.3% / 映100% / 41ms | 1/3 远引× / 噪0% / 映100% / 69ms | 3/3 远引√ / 噪0% / 映89.4% / 196ms |

## 5. 按类别的典型发现

- **GitHub 代码文件页**（`github-code-ref`、`github-code-argparse`）：GitHub 新版代码查看器把每一行代码渲成独立的行容器，不是单个 `<pre><code>`。方案 A/B 的根节点识别完全找不到代码区域，只抽到提交记录等元信息（召回 0/3，噪声比例按"抽到的内容里有多少是真正代码正文"算是 100%）；方案 C 能抽到代码内容（召回 3/3）但把"代码块应是原子单元"的规则破坏了——每一行都变成独立块（argparse 样本 1248 块，ref 样本 366 块）。三方案在这一类别上没有一个完整正确。
- **公式页（text-density 根节点误选）**：`formula-en`（nLab 群论页）和 `iframe-cross-origin`（MIT OCW 课程页）上，方案 A 的文本密度打分选中了页面里一个结构紧凑但无关的小元素（分别是孤立公式片段、一个隐藏的"即将离开本站"提示框），导致真正正文 0 召回；方案 B 在 `formula-en` 上同样 0 召回（用的是同一批候选节点）。方案 C 在这两个样本上都完整召回。
- **列表/目录页（Readability 对非文章结构失效）**：`listing-hn`（Lobsters 首页）、`adv-forum-thread`（Python 论坛分类页）上，方案 B 分别只抽到 1 条花边文字和 0 块——Readability 的"这是不是一篇文章"判断在列表型页面上基本失效。方案 A/C 都正确抽到了列表内容，但都把整个列表合并成了 1-2 个超大块（`granularity-collapse`），没有保留逐条目的边界。
- **Defuddle 在"摘要+历史列表"首页的欠抽取**：`listing-ruanyifeng-index`（阮一峰周刊首页）上，方案 C 只抽到 2 个块（标题和摘要都漏了，只剩正文摘要那一句），方案 A/B 都完整抽到了标题+摘要+历史文章列表。
- **超大 API 文档页的粒度塌陷（三方案共性问题）**：`table-heavy`（Oracle `Collections` API 文档）上，三方案都把 Method Details 整节塞进了 1-2 个巨大块（A/B 单块 71037 字符，C 单块 67319 字符），使得"相隔几个块"这个远距离指代距离指标失真——名义上只隔 4 个块，实际隔着几万字符。
- **Baidu 百科站点导航噪声（A/C 共性问题，B 不受影响）**：`formula-zh`、`zh-article-918`、`zh-article-xian` 三个百度百科样本上，方案 A 和 C 都会把百度顶部的全站导航条（"网页新闻贴吧知道网盘图片视频地图文库资讯采购百科"等）、编辑/浏览次数、举报信息等页面 chrome 当正文的一部分抽出来；方案 B（Readability）完全剔除了这部分。按块级正则精确计数后（`src/gen-noise-review.mjs`），这部分噪声的绝对字符数稳定在 150-170 字符左右（和最初用肉眼估算整条导航条"约 2300-2900 字符"的判断不符，之前是高估），占总输出的比例在三个样本上都低于 5% 的标记阈值：`formula-zh`（全文最短，6349 字符）噪声占比 2.7%（A）/0.8%（C），两篇长文章（918/西安事变）降到 0.1%-0.5%。结论改为：这是一个真实但量级很小的噪声源，不构成需要优先修复的问题。
- **GitHub README 页的根节点过宽（A 独有问题）**：`github-readme`（vuejs/core 仓库首页）上，方案 A 的根节点把整个仓库页面都当成了正文，混入了文件目录树（2700 字符）、star/fork/watcher 数、贡献者头像、发布版本、语言占比条等仓库 UI 元信息，真正 README 内容只占总输出的 32.7%（噪声比例按块级正则精确计数为 67.3%）；方案 B/C 都精确只抽到了 README 本身，和 A 里能识别出的 README 部分字符数几乎一致（1193-1194 字符），互相印证。
- **文献页侧栏小部件噪声（arxiv-abs）**：`arxiv-abs`（arXiv 摘要页）上三方案都会不同程度地抽到侧栏的"Connected Papers / Litmaps / scite / Which authors are endorsers"等小部件文案和提交版本信息，方案 A 因为块切分更细、覆盖面更广，噪声占比达到 14.1%（越过 5% 阈值，标 `boilerplate-noise`）；方案 C 为 5.3%，刚过阈值；方案 B（Readability）最低，4.5%，仍低于阈值。
- **验证码/反爬页面的固定调试字符串（adv-login-wall，三方案一致）**：触发滑块验证码的虎嗅页面上，三方案都抽到了一段固定的 `TraceID: ...` 调试字符串，在该页面总共 4 个块、183 字符的输出里占 21.3%——因为整页本来就几乎没有真实正文，这是反例样本本身的特性，不是某个方案相对另一个方案的差距（三方案噪声比例完全相同）。
- **长文章的广告/图片版权噪声低于标记阈值（en-longform-pearlharbor）**：方案 A/C 都会抽到散落文中的"Advertisement"小块和"Getty Images/National Archive"等图片来源署名行，精确计数后占比分别为 4.8%（A）/4.6%（C），均未达到 5% 的 `boilerplate-noise` 阈值，归为可忽略的零星噪声；方案 B 最干净（0.4%），但代价是漏掉了文章前半部分内容（`under-extraction`，见第 7 节）。
- **方案 C 的隐藏内容泄漏（可见性规则违反）**：`doc-vue-tabs`（Vue 文档 API Preference 标签页）渲染时默认展示 Composition API 面板，Options API 面板被 CSS 隐藏。方案 A/B 都正确只抽到了可见的 Composition API 内容；方案 C 额外抽到了被隐藏的 Options API 代码示例文本——这是本次测试里唯一一次观察到的"读取了不应读取的隐藏内容"（`visibility-violation`），与架构 5.6 节的可见性规则直接冲突，比噪声或欠抽取更严重，因为它违反的是正确性规则而不只是质量指标。
- **方案 C 的 DOM 映射率系统性偏低**：即使在方案 C 召回率最高的样本上，它平均仍有 25.5% 的块无法映射回真实 DOM 节点（28 个样本里映射率范围 0%-100%，多数集中在 50%-90%），`en-longform-pg`（Paul Graham 老式 `<table>` 布局页面）上方案 C 直接 0 块、0 映射——完全抽取失败。因为映射失败意味着这些块无法做选区/高亮锚定（对应架构 5.7 节引用锚点的前提），这是方案 C 最大的结构性短板，和它的召回优势是同一机制（克隆 DOM 后二次映射）带来的两面。
- **反例样本的预期表现**：`adv-readonly-textarea`（表单值不泄漏）、`adv-login-wall`（环境阻塞下的验证码替代页）、`adv-spa-empty`（Excalidraw 画板首页）三个反例上，三方案表现一致且符合预期——不读取表单输入值、不编造正文、不把 UI 控件误判成大段正文。

## 6. 推荐方案与理由

**数据不支持任何一个方案"全面胜出"**——这不是预设结论，是三组指标摆在一起之后的直接结果：

- 方案 A（自研）最快（p50 3.2ms）、DOM 映射率恒 100%、综合召回 85.7%，但在"文本密度误选根节点"（公式页、跨源 iframe 页）、"GitHub 代码页完全找不到代码区域"、"GitHub README 页根节点过宽混入仓库 UI 噪声"三类场景上有系统性失败；百度百科类站点导航噪声经精确计数后量级很小（均低于 5%），不列入系统性失败。
- 方案 B（Readability）噪声最低、映射率也是 100%，但召回全场最低（72.6%），在列表型/非文章型页面（论坛分类页、新闻列表）上会直接判定"这不是文章"而整页失败。
- 方案 C（Defuddle 克隆映射）召回最高（94.0%），但 DOM 映射率只有 74.5%（意味着约四分之一的块无法做选区/高亮锚定），还在 `doc-vue-tabs` 上出现了本次测试里唯一一次可见性规则违反（读取了隐藏的标签面板内容），且耗时是 A 的约 25 倍。

**倾向性建议**：以方案 A 的"自研根节点识别 + 真实 DOM 直接操作"路线继续迭代，而不是直接把 B 或 C 整体并入生产实现，原因是：

1. 架构 5.7 节的引用锚点功能要求块能稳定映射回真实 DOM 节点——这是方案 C 的硬伤（映射率 74.5%，`en-longform-pg` 样本上直接 0%），在锚点可靠性修好之前不适合做主路径。
2. 方案 B 对"这是不是文章"的二元判断在列表型页面上会整页返回空，产品上更难接受（用户打开一个页面，摘要功能直接什么都抽不到），而方案 A 至少能抽到内容（即使粒度合并成了大块）。
3. 方案 A 已知的失败模式（文本密度误选根节点、GitHub 逐行代码、GitHub README 根节点过宽）都是**可定位、可针对性修复**的具体 bug，不是架构性缺陷；方案 C 的映射率问题和可见性违规则更接近机制性限制。

但在这些已知缺陷修复并重新跑这 28 个样本验证之前，不能说方案 A 已经"通过"V-08 的通过条件——详见第 10 节结论。

## 7. 漏读内容边界

当前三方案组合起来，仍然确定会漏读或无法处理的内容：

- **跨源 iframe 内部内容**：三方案一致跳过（`iframe-cross-origin` 样本验证），这是按 `SKIP_SELECTOR` 规则的预期行为，不是 bug，但意味着嵌入式视频页面、嵌入式 Codepen 等场景的"框内内容"永远不在 PageDoc 覆盖范围内。
- **GitHub 网页代码查看器的代码正文**：方案 A/B 完全找不到，方案 C 能找到但破坏了代码块的原子性；目前没有一个方案能"完整且正确"地处理这类页面。
- **文本密度打分选错根节点时的整页正文**：方案 A（以及共享候选节点逻辑的方案 B）在小而密集的 UI 元素紧邻真正正文的页面上，会完全漏掉正文，已知命中两个样本（`formula-en`、`iframe-cross-origin`），不排除同类结构在其他站点上复现。
- **表单控件里的内容**（`<textarea readonly>`、`<input>` 等）：按设计不读，这是正确行为，不计入"漏读"，但用户如果确实需要总结一个用 textarea 展示代码的老式页面，现状就是"抽不到"。
- **Canvas/SPA 应用的画面内容本身**：`adv-spa-empty`（Excalidraw）类页面，画布上的实际绘图内容没有对应的可抽取 DOM 文本，这是真实限制，不是某个方案的缺陷。

## 8. Fallback 触发情况

本原型目前**没有实现**生产意义上的运行时 fallback 链——A/B/C 是三条独立跑的对比支路，不是"A 失败就自动退到 B"的产线逻辑。要让方案 A 的已知失败模式（根节点误选、代码页、列表页粒度塌陷）在生产环境里不至于直接坏掉，正式实现阶段需要补上：当方案 A 判定的根节点文本量相对页面总文本量的比例低于某个阈值，或候选根节点数量/耗时出现异常时，触发向 Readability 结果回退或提示降级。**这个触发逻辑在当前原型里未实现、未测试**，是后续工作项，不能算作已验证通过的能力。

## 9. 第三方库许可证声明

- **Mozilla Readability**（`@mozilla/readability`）：Apache License 2.0。本原型方案 B 直接依赖该库定位正文根节点；若该方案进入生产实现，需要在产品的第三方许可证清单里包含 Apache-2.0 的许可证文本和版权声明。
- **Defuddle**（`defuddle`）：MIT License。本原型方案 C 依赖该库在克隆 DOM 上做清洗；若进入生产实现，同样需要在许可证清单里包含 MIT 许可证文本和版权声明。
- 两者都只在本地原型里被引用、运行，没有修改源码、没有随本仓库重新分发其代码。

## 10. V-08 结果记录

```text
用例编号：V-08
对应发现：AR-13、AR-14、AR-21；原型 3、5、7
执行日期：2026-11-14
构建版本 / commit 或构建哈希：独立原型，不在主仓库 git 历史中（prototypes/v08-extraction/ 未执行 git commit）
浏览器名称及完整版本：Playwright 1.65.1 自带 Chromium（非系统安装的真实 Chrome/Edge）
操作系统 / 企业策略（如有关）：Windows 11 Home 中国版 10.0.26100，本地沙箱环境，无企业策略
扩展安装方式：不适用（本原型是独立 Node 脚本，不是已打包的浏览器扩展）
是否打开 DevTools：否
网络环境（普通 / 公司 WiFi / UniVPN / 模拟）：沙箱网络环境；部分候选站点（news.ycombinator.com、多个登录墙候选站点）被拦截或反爬限制，已替换为同类站点并在样本记录里注明，不代表公司网络下的真实可达性
输入样本及去敏方式：28 个公开网页，直接抓取、未做内容去敏（均为可公开访问的内容），样本清单见本文件第 2 节与 samples/index.json
具体步骤：对每个样本用 Playwright 渲染后分别跑方案 A/B/C 的抽取（src/fetch-and-extract.mjs），人工标注关键证据与远距离指代（samples/*.labels.json），按块级正则规则计算噪声比例、结合人工核对补充结构性错误分类（src/gen-noise-review.mjs → results/*.noise-review.json），汇总指标（src/compute-metrics.mjs → results/metrics-summary.json）
期望结果：选区和答案证据被保留；前后段落语义正确；不读输入值；能描述漏读边界；对远处指代有可测的召回结果（VALIDATION_MATRIX 第 128 行）
实际结果：三方案在"不读输入值"一项全部通过（28 样本均未观察到表单值泄漏）；远距离指代召回方案 A 84.2%、B 68.4%、C 94.7%；但三方案各自在不同类别上有系统性失败（GitHub 代码页、文本密度误选根节点、列表型页面、方案 C 的 DOM 映射率与一次可见性违规），没有一个方案单独满足"全部通过"，详见本文件第 3-7 节
服务端接单次数与请求范围：不适用（本用例不涉及服务端）
UI / 请求头 / 首内容 / 完成时间：不适用（本用例测的是抽取算法本身，不是端到端 UI 流程）
任务与页面身份：不适用（本原型不实现 pageKey/documentId 等五重页面身份机制，只对比抽取算法）
脱敏证据位置：prototypes/v08-extraction/samples/*.labels.json（人工标注）、prototypes/v08-extraction/results/*.noise-review.json（噪声与错误分类）、prototypes/v08-extraction/results/metrics-summary.json（汇总指标）
结论（未执行 / 通过 / 失败 / 环境阻塞 / 接受降级）：接受降级
失败退路及其产品代价：短期可以方案 A 为主路径上线，但需要产品侧明确接受以下降级：GitHub 代码文件页摘要/问答能力暂不可靠（三方案均未能正确处理代码原子性，A/B 在这两个样本上噪声比例精确计数为 100%）；个别公式/数学定义类页面存在正文完全漏读的风险（已知命中 nLab、MIT OCW 两个样本，真实命中面未知）；GitHub 仓库首页（README）若采用方案 A，摘要里会混入 67.3% 的仓库 UI 噪声；百度百科、arXiv 摘要页等页面也存在零星噪声，但按块级规则精确计数后均在 5% 以内（仅 arxiv-abs 方案 A 为 14.1%，越过阈值），量级远小于最初人工估算。若产品不接受这些降级，则需要先修复方案 A 的根节点误选与代码原子性问题，或引入运行时 fallback（见第 8 节），再重新判定本用例
是否需要修订架构 / 需求 / 最低版本：不需要修订 ARCHITECTURE.md 的规则本身（5.6/5.7 节规则在本次测试中被用作判定标准，没有发现规则本身有问题）；但发现方案 C 存在一次违反可见性规则的真实 bug（doc-vue-tabs 样本），如果选择在生产中引入 Defuddle 辅助路径，需要先修这个 bug 并补一条针对标签页隐藏面板的回归测试
复测版本及结果：待后续——需要在方案 A 的已知缺陷修复后，用相同 28 个样本重新跑一遍 src/compute-metrics.mjs 并对比本次结果；也需要在真实 Chrome/Edge（而非 Playwright Chromium）上至少抽样复测一部分样本
```
