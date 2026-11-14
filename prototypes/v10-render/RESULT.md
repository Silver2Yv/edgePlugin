# V-10：安全渲染与流式语法 — 原型验证结果

## 0. 按 VALIDATION_MATRIX.md 第 5 节模板记录

```text
用例编号：V-10
对应发现：AR-11、AR-12（ARCHITECTURE.md 5.10）
执行日期：2026-11-14
构建版本 / commit 或构建哈希：不适用（独立原型，未接入主仓库构建，无 git 仓库）
浏览器名称及完整版本：
  - 单测环境：happy-dom 21.0.4（模拟 DOM，非真实浏览器）
  - 真机复现（选区/滚动/焦点验证）：Chrome for Testing，路径 D:\tmp\cft\chrome.exe
    （版本见该目录 159.0.8154.6.manifest，即 159.0.8154.6）
操作系统 / 企业策略（如有关）：Windows 11 Home，本机开发环境，无企业策略
扩展安装方式：不适用（本原型不打包扩展，不加载 manifest）
是否打开 DevTools：否（脚本化 headless 运行）
网络环境：不适用（渲染模块纯本地计算，未发出任何网络请求；未调用模型/未读取任何密钥）
输入样本及去敏方式：全部为本原型在 test/fixtures.ts 中手写的合成文本，不含真实用户数据
具体步骤：见下文"方法"与"测试矩阵"
期望结果：见下文"逐条对照 5.10 规则"表的"测试"列
实际结果：见下文"逐条对照 5.10 规则"表的"结果"列；vitest 83/83 通过
服务端接单次数与请求范围：不适用（本原型不含后台/网络请求代码路径）
UI / 请求头 / 首内容 / 完成时间：不适用（见"性能"一节的渲染耗时数据，非网络指标）
任务与页面身份：不适用
脱敏证据位置：不适用（无真实数据参与）
结论（未执行 / 通过 / 失败 / 环境阻塞 / 接受降级）：通过（选区/滚动/焦点保护一项为"接受降级"，见下文说明）
失败退路及其产品代价：无失败项。降级项见下文"6. 风险与降级说明"
是否需要修订架构 / 需求 / 最低版本：建议补充两条架构细化说明，见"7. 对 5.10 的修订建议"（不影响现有决策方向，属于补充细节）
```

## 1. 方法

独立原型目录：`prototypes/v10-render/`（自有 `package.json`，精确锁定版本，未改动主仓库任何文件）。

**依赖与许可证**（均已逐一核实 `npm view` 的 `license` 字段）：

| 包 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| markdown-it | 15.0.3 | MIT | Markdown 解析与渲染，`html:false` |
| katex | 0.19.1 | MIT | 公式渲染 |
| highlight.js | 11.12.0 | BSD-3-Clause | 代码高亮（`lib/core` + 精选语言子集） |
| typescript | 5.9.3 (dev) | Apache-2.0 | 类型检查 |
| vitest | 5.1.0 (dev) | MIT | 单测 + 覆盖 happy-dom 环境 |
| happy-dom | 21.0.4 (dev) | MIT | 测试用 DOM 环境，也用于 `src/bench.ts` 基准脚本 |
| tsx | 4.23.15 (dev) | MIT | 运行 TS 脚本（基准脚本） |
| playwright-core | 1.65.1 (dev) | Apache-2.0 | 真机选区/滚动/焦点验证 |

传递依赖逐一核查（60 个包），全部为 MIT / BSD-2-Clause / BSD-3-Clause / Apache-2.0 / ISC / PSF-2.0 / 0BSD，**仅一个例外**：`lightningcss` 与 `lightningcss-win32-x64-msvc`（MPL-2.0），它们是 `vite`/`vitest` 工具链内部的开发期传递依赖，不被 `dependencies` 引用、不参与渲染模块本身、不会被打进扩展产物，仅存在于本原型的开发 `node_modules` 里。真实扩展实现时主仓库的生产依赖不经过 vite/vitest 这条链，不会引入该许可证。

**渲染管线分层**（`src/render/`）：

- `protocol.ts` — 链接协议白名单判定（抗大小写混淆、空白插入、数字字符引用编码绕过）。
- `katex-render.ts` — KaTeX 安全封装：`trust:false`、`strict:'ignore'`、`maxSize`/`maxExpand`、每次调用传全新 `macros` 对象、解析失败兜底转义源码。
- `highlight.ts` — highlight.js 安全封装：20k 字符上限、语言白名单（`lib/core` + 17 种常用语言，非全量包）、异常兜底转义。
- `math-plugin.ts` — 极简 `$$...$$` / `$...$` 语法规则（原型取舍，见文件内注释：架构未规定具体定界符，本原型选用业界常见写法）。
- `citation.ts` — 复用 V-09 的解析正则，真实 DOM 文本节点级替换（`createElement`/`setAttribute`/`textContent`，不做字符串拼接 HTML），只认允许集合内的编号。
- `markdown-it-setup.ts` — 组装以上模块到 markdown-it 的 renderer 规则覆盖（`link_open/close`、`image`、`fence`/`code_block`/`code_inline`、`math_block`/`math_inline`）。
- `block-splitter.ts` — 对整份当前文本做一次 `md.parse()`，按顶层 token 分组，组的稳定 key = 该组在文本中的起始字符偏移。
- `streaming-renderer.ts` — 增量渲染调度：除最后一组外的块一旦被缓存就在后续 `update()` 中直接复用（不重跑渲染）；最后一组永远视为 open，每次重渲染；`finalize()` 对全部块重新渲染并与缓存逐块比较 HTML，只替换真正变化的块。

**关键机制**：markdown-it 的解析是"先对全文做块级扫描（此时引用链接定义已经全部收集进 `state.env.references`），再对每个块做行内解析"的两阶段过程。`finalize()` 利用这一点对全文重新 `parse()` 一次，天然能正确解析此前因引用定义尚未到达而被渲染成纯文本的前向引用链接，不需要为"后置引用定义"单独写检测逻辑——用一次"全量重渲染 + 按块 diff"就能覆盖。

## 2. 测试矩阵与结果

`npm run typecheck`：通过，0 错误。
`npm run test`（vitest + happy-dom）：**83/83 通过**，0 失败，5 个测试文件全部通过。

| 测试文件 | 覆盖内容 |
| --- | --- |
| `test/security.test.ts` | 原始 HTML 注入、危险协议链接（含大小写混淆/空白插入/实体编码绕过）、图片不产生 `<img>`、引用标记里的属性字符 |
| `test/katex.test.ts` | 解析失败兜底、宏不跨调用泄漏、`maxExpand` 阻止宏递归、`maxSize` 限制巨大公式、`trust:false` 阻止 `\href`/`\url` 产生真实链接 |
| `test/highlight.test.ts` | 语言白名单（含别名）、超长代码跳过高亮、异常兜底 |
| `test/citation.test.ts` | V-09 正则解析、允许/不允许编号、多编号部分越权整体降级、DOM 节点构造方式（不走字符串拼接） |
| `test/streaming-consistency.test.ts` | 14 个 V-10 输入样本 × 4 种 chunk 边界策略（逐字符、两组不同种子的伪随机切分、刻意切在 `【` 标记内部）= 56 组一致性断言 + 稳定 key 测试 + 后置引用定义校正的专项测试 |

**4 种 chunk 边界策略**（`test/chunk-utils.ts`）：逐字符；固定种子伪随机（种子 1，1~7 字符/段）；固定种子伪随机（种子 2，1~13 字符/段）；刻意切在每个 `【` 字符处（覆盖"引用标记被截断"场景）。

**14 个样本**：原始 HTML 注入、危险协议链接、引用标记属性字符、后置引用定义、嵌套列表、表格、未闭合代码围栏、未闭合公式块、巨大公式、超长代码块（25000 字符）、KaTeX 语法错误、KaTeX 宏递归、KaTeX `\href`/`\url`、综合多段文档。每组都断言：流式增量的最终 `finalize()` 结果与一次性 `finalize()` 直接渲染的结果逐块 `outerHTML` 完全一致；渲染出的每个块都通过 `assertSafeDom` 检查（无 `<script>`/`<iframe>`/`<img>` 等禁止标签、无 `on*` 事件属性、URL 属性只允许白名单协议）。

**后置引用定义专项测试**发现并验证了一个重要机制细节：`update()` 的"已完成块直接复用缓存"逻辑是**无条件**复用（按 key 命中就返回缓存，不比较新旧内容），所以即使后续整段文本已经包含了引用定义，只要该块在更早的某次 `update()` 里已经被标记为"已完成"并缓存，它会一直停留在缓存里的（可能是错误解析的）版本，直到 `finalize()` 强制重新渲染并 diff 才会被纠正为 `status: 'corrected'`。测试里显式验证了这个顺序：中间状态下引用确实渲染成纯文本（无 `<a>`）→ 喂入完整文本后 `update()` 仍然返回缓存的纯文本版本（证明了"复用是无条件的"）→ `finalize()` 后才变成指向 `https://example.com/resolved-later` 的安全链接，`status` 为 `corrected`。

**稳定 key 测试**：综合文档逐字符流式输入全过程中，每个已完成块（非最后一块）的 `outerHTML` 在它第一次出现之后的所有后续 `update()` 调用里保持完全不变。

## 3. 逐条对照 ARCHITECTURE.md 5.10 规则

| 规则 | 实现方式 | 测试 | 结果 |
| --- | --- | --- | --- |
| markdown-it `html:false` | `markdown-it-setup.ts` 创建实例时设置 | `security.test.ts`"原始 HTML 注入" | 通过：`<script>`/`<img onerror>`/`<a onclick>` 均未变成真实元素 |
| 链接协议白名单 http/https/mailto | `protocol.ts` 的 `isAllowedLinkProtocol`，覆盖大小写、TAB/LF/CR 插入、数字字符引用编码 | `security.test.ts` 直接单测 12 种变体 + 渲染后 DOM 检查 | 通过（另发现：markdown-it 自身的默认 `validateLink` 已先行拦截 `javascript:`/`vbscript:`/`file:`/`data:` 等协议，使这些写法根本不会生成链接 token，本模块的白名单是第二道、独立于 markdown-it 内置规则的防线） |
| 非白名单协议降级为纯文本 | `link_open`/`link_close` 规则在不允许时返回空字符串（不渲染 `<a>` 标签，但链接文字内容仍保留） | 同上 | 通过 |
| 链接加 `target=_blank rel="noopener noreferrer"` | `link_open` 规则里 `attrSet` | `security.test.ts` 检查每个保留下来的 `<a>` | 通过 |
| 图片不自动加载外链 | `image` 渲染规则永不输出 `<img>`，安全协议降级为文字链接，其余降级为纯文本占位 | `security.test.ts` | 通过；未发现一例 `<img>` |
| 引用标记里的属性字符不产生注入 | 正则只接受纯数字编号；DOM 操作全部走 `createElement`/`setAttribute`/`textContent`，不拼接字符串 HTML | `security.test.ts`、`citation.test.ts` | 通过：`【12" onclick=x】` 这种写法本身不匹配编号正则，原样当文本显示，且逐字引用内容里出现的 `"`、`<`、`>` 字符也只是 `textContent`，不会被当成标签解析 |
| 引用只对当前请求允许的块号生效 | `applyCitations` 以 `allowedIds` 过滤；多编号里只要有一个不在集合内，整条标记整体保持纯文本 | `citation.test.ts` | 通过 |
| KaTeX `trust:false` | `katex-render.ts` 渲染选项 | `katex.test.ts`"trust:false 阻止 \href/\url" | 通过：输出不含指向目标地址的 `<a href="...">` |
| KaTeX `strict:'ignore'` | 同上 | 间接：各 KaTeX 样本均未因警告级语法被中断 | 通过 |
| KaTeX `maxSize`/`maxExpand` | 同上，各设 500 / 1000 | `katex.test.ts`"巨大公式"、"宏递归" | 通过：两者均未抛出未捕获异常，均安全落到 `ok:false` 兜底或受限渲染 |
| KaTeX 宏不跨消息 | 每次 `renderMath()` 调用传入全新 `{}` 对象 | `katex.test.ts`"宏不跨调用泄漏" | 通过：第一次调用里 `\def` 的宏，独立的第二次调用无法识别 |
| KaTeX 解析失败显示转义源码 | `catch` 块里返回 `escapeHtml(source)` 包裹在 `.ra-math-error` 里 | `katex.test.ts` | 通过 |
| 代码超 20k 字符跳过高亮 | `highlight.ts` 的 `CODE_HIGHLIGHT_MAX_CHARS` | `highlight.test.ts`、`streaming-consistency.test.ts`"超长代码块" | 通过：仍转义输出全部内容，只是不跑 highlight.js |
| 代码语言白名单 | `isLanguageAllowed` + 17 种常用语言的别名映射表 | `highlight.test.ts` | 通过 |
| 引用节点由 token 生成，不做字符串拼接 HTML | `citation.ts` 的 DOM 文本节点分割与替换 | `citation.test.ts`"createElement/setAttribute/textContent 生成" | 通过 |
| 增量渲染：新文本只替换受影响的块 | `streaming-renderer.ts` 的 `update()`：非最后块命中缓存直接复用，不重渲染 | `streaming-consistency.test.ts` 稳定 key 测试 | 通过 |
| 已完成块 key 不变 | key = 块在文本中的起始字符偏移，纯追加式输入下不变 | 同上 | 通过 |
| 流结束做一次完整校正，只替换受影响的块 | `finalize()` 全量重渲染 + 按块 HTML diff | `streaming-consistency.test.ts`"流结束校正：后置引用链接定义修复早期块" | 通过，且证实了"中间状态下已缓存的块不会在 update() 时自动纠正，只有 finalize() 才会"这一具体行为 |
| 用户选区和阅读位置得到保护 | 不删除/替换未变化节点（见"增量渲染"各条）；复现页从不调用 `scrollIntoView`/`focus`/`scrollTo` | 见下文第 5 节 | 接受降级（真机验证用简化复现页，非完整渲染管线，见第 6 节） |

## 4. 性能（`npm run bench`，happy-dom 模拟 DOM，Node 环境，每 chunk 20 字符）

| 响应长度 | chunk 数 | 单次增量渲染 p50 | 单次增量渲染 p95 | 流式全过程累计耗时 | 一次性完整渲染（update+finalize） |
| --- | --- | --- | --- | --- | --- |
| 10,000 字 | 500 | 1.135 ms | 2.881 ms | 732.8 ms | 103.2 ms |
| 50,000 字 | 2,500 | 4.289 ms | 8.656 ms | 11,258.6 ms | 521.1 ms |

（原始数据见本次运行的终端输出；运行环境：本机开发机，happy-dom 21.0.4 模拟 DOM，非真实浏览器渲染管线，数字仅用于判断量级与增长趋势，不是真实浏览器基线。）

**重要发现**：p50/p95 是按"全程所有 chunk"统计的分布，掩盖了一个关键趋势——因为每次 `update()` 都要对"已接收的全部文本"重新跑一次 `md.parse()`，单次调用成本随已累积文本长度线性增长，所以**整条流的总耗时随总长度近似二次增长**（50k 字是 10k 字的 5 倍长度，但累计耗时是 15 倍）。对 10k 字回答这个成本可以忽略（全程 <1 秒 CPU，且多数发生在后台，不阻塞交互）；50k 字这种很长的回答，在本机环境下模拟测得全程增量渲染占用约 11 秒 CPU（不是用户能感知的"卡住 11 秒"，因为这是摊在整条流的持续时间上的，但仍值得在真实实现里关注，见下节风险）。

## 5. 用户选区与阅读位置保护（真机验证）

`playwright/selection-protection.mjs`，使用 `playwright-core` 驱动本机 `D:\tmp\cft\chrome.exe`（Chrome for Testing）headless 运行：

```
node playwright/selection-protection.mjs
```

验证步骤：聚焦一个输入框模拟"用户在别处操作"→ 在一个"已完成块"里选中一段文字 → 连续模拟 20 次流式增量追加（只修改最后一个 open 块的内容，已完成块节点不被触碰，复现页脚本里也完全不调用任何 `scrollIntoView`/`focus`/`scrollTo` 之类的 API）→ 断言：选区文本不变、选区所在的文本节点对象引用不变（证明该块没有被整体替换掉）、`window.scrollY` 不变（无自动滚动）、`document.activeElement` 不变（未被抢焦点）。

**实际结果：通过**（终端输出：`[V-10 Playwright 验证] 通过：选区文本/节点、滚动位置、焦点在流式增量过程中均未被打断。`）。

## 6. 风险与降级说明

1. **【接受降级】选区/滚动/焦点验证用的是简化复现页，不是完整渲染管线**。真机测试需要一个真实浏览器环境，而本原型没有搭建打包/加载浏览器扩展所需的构建链（也不在本次任务授权范围内去改动主仓库构建配置）。所以 `playwright/harness.html` 手写了一个最小 DOM 结构，直接复刻 `streaming-renderer.ts` 的核心契约（"未变化的块节点引用不变，只追加最后一块"），而不是真正加载 markdown-it/KaTeX/highlight.js 跑一遍完整渲染。**产品行为影响**：真机验证只证明了"浏览器层面的选区/滚动/焦点行为会如预期保留"这个假设是对的，但没有验证"把完整渲染管线接到真实 DOM 更新里之后，这个保护依然成立"——这需要在真正接入扩展 UI（侧边栏/浮窗）阶段补一次端到端验证，而不是本原型职责范围。
2. **【风险，非降级】`update()` 的增量渲染是对"已接收全部文本"的重新全量解析**，随文本长度增长，单次调用成本线性增长，整条流的总 CPU 成本随文本长度近似二次增长（见第 4 节）。对典型长度（几千字）影响很小；罕见的超长回答（数万字）在低端设备上可能造成流式阶段可感知的 CPU 占用升高。
3. **【风险，非功能性缺陷】markdown-it 自身内置的 `validateLink` 在本模块的协议白名单之前就已经拦掉了 `javascript:`/`vbscript:`/`file:`/多数 `data:` 协议**，使得"危险协议链接"在很多情况下根本不会被解析成 `<a>` token（直接保留为纯文本）。本模块实现的协议白名单是独立的第二道防线（对图片 `src`、以及理论上更严格实现若替换掉 markdown-it 默认校验时仍然生效），这是防御纵深，不是重复劳动，但如果有人未来"简化"掉这层白名单、以为 markdown-it 默认校验已经够用，就会失去对图片 `src` 等场景的保护（markdown-it 的 `validateLink` 同时管 `link` 和 `image` 的目的地校验，但其规则集合与本模块的白名单不完全一致，例如 `data:image/...` 这种 markdown-it 默认允许但本模块的 http/https/mailto 白名单会拒绝的协议）。
4. **极简公式语法（`$$...$$` / `$...$`）是原型取舍**，不是 texmath/MathJax 配置的完整复刻；真实实现若要支持 `\[ \]`、`\( \)` 等更多定界符写法，需要按同一模式扩充 `math-plugin.ts`，不影响本次验证得出的安全性与流式结论。
5. 依赖许可证里 `lightningcss`（MPL-2.0）仅存在于开发工具链（vite/vitest 的传递依赖），不进入生产产物，但如果未来给这个原型加真实打包流程，需要再次确认它没有被打进最终 bundle。

## 7. 对 ARCHITECTURE.md 5.10 的修订建议

两条补充细节建议（均为对现有决策方向的细化，不改变方向）：

1. 建议在 5.10 明确写出"流式阶段的增量渲染允许暂时展示未经前向引用解析校正的内容，直到流结束的完整校正阶段"这一行为，并说明这是已知的、有意为之的权衡（性能优先于"提前展示 100% 正确结果"），避免未来实现者把"中间状态下引用链接没解析对"误判为 bug。
2. 建议补一条关于超长回答（如 >2 万字）的流式渲染节流策略：例如把"每次新增文本都触发 `update()`"改成按时间或字符数做防抖/节流（如每 N 毫秒或每 M 个新字符才触发一次重解析），把原本随长度二次增长的总成本收敛回线性量级。本次验证的性能数据（第 4 节）可以作为设定具体阈值的参考起点。
