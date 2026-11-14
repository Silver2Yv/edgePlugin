# RESULT：I9「提问前的模型问题建议」原型验证

状态：原型验证阶段，对应 `FINAL_PLAN.md` I9、`DECISIONS.md` Decision 053、`ARCHITECTURE.md` 5.2/5.5/5.9。核心问题两个——**能否赶在用户打字之前出现**、**命中率如何**。本报告回答第一个问题（有实测数据），第二个问题只给出**代理命中率**，并明确标注它不能代替用户标注。

## 1. 方法

- **材料**：20 段真实公开材料，中英文各 10 段，覆盖技术文档（5）、教程（4）、学术论文/摘要（5）、新闻评论（3）、历史人文（3）五类。详见第 2 节与 `materials.json`、`materials.schema.md`。
- **接口**：接口 1 为公司中转站（经 VPN，`deepseek-flash`，地址见本地 `.secrets/config.json`，不提交仓库）；接口 2 为 DeepSeek 官方 `api.deepseek.com`，用 `GET /models` 选出的非推理最快模型同为 `deepseek-flash`（另有 `deepseek-v4-pro`，未用于本次测试）。两接口均需显式传 `thinking: {type: "disabled"}` 才能关闭默认开启的思考模式（这是本次验证中发现的一个实操细节，默认不关会在 `reasoning_content` 上多花约 300–600ms）。
- **提示词变体**：
  - `selection_only`：只给页面标题 + 划选内容。
  - `selection_context`：页面标题 + 划选内容前后各至多 3 段上下文 + 划选内容。
  - 两个变体共用同一套系统提示词约束（点名引用具体内容、不与"解释"重复、恰好 3 行、语言跟随原文），输出格式为逐行 `"1. "/"2. "/"3. "`，便于流式时判定"第一条建议完整可显示"的时刻（出现换行即视为该条完整）。
- **延迟测量**：2 接口 × 2 变体 × 20 段 × 3 次重复 = 240 次流式请求，并发上限 3，记录到响应头、到首个 token、到第一条完整建议可显示、到全部完成四个时间点。另跑一组"预热"场景：2 接口 × 20 段 × 2 次重复 = 80 次，模拟"工具栏出现即发请求，用户在 1 秒后点击问"，统计此时第一条建议是否已经可显示。
- **代理命中评估**：用 DeepSeek 官方接口，对每段材料先让模型扮演该领域普通读者、在看不到任何建议的情况下写出 2 个最想问的问题（20 次调用）；再对两个变体各重新生成一组建议（40 次调用，与延迟测量时的建议文本不是同一批，但同一套提示词、同一模型）；最后用模型逐条判别读者的问题是否被某条建议语义命中（40 次调用）。我（Claude）抽样人工复核了 8 组判别结果，未发现明显误判，但也看到至少 1 处可争议的"命中"判定，详见第 5 节。
- **总请求量**：延迟测量 240 + 预热 80 + 代理评估 100（建议 40 + 读者 20 + 判别 40）+ 若干连通性/联调测试 ≈ 430 次，低于约 600 次的上限；并发全程 ≤ 3。

## 2. 材料清单

| 编号 | id | 语言 | 类别 | 标题 |
| --- | --- | --- | --- | --- |
| 1 | en-async-function | en | tech_doc | async function - JavaScript \| MDN |
| 2 | en-git-rebase-onto | en | tech_doc | git-rebase Documentation |
| 3 | en-react-useeffect | en | tutorial | useEffect – React |
| 4 | en-docker-container | en | tutorial | What is a container? \| Docker Docs |
| 5 | en-transformer-abstract | en | academic | Attention Is All You Need |
| 6 | en-adam-abstract | en | academic | Adam: A Method for Stochastic Optimization |
| 7 | en-crispr-cas9-abstract | en | academic | A programmable dual RNA-guided DNA endonuclease ... |
| 8 | en-rosetta-stone | en | history | Rosetta Stone - Wikipedia |
| 9 | en-lehman-bankruptcy | en | news | Lehman Bros files for bankruptcy - BBC NEWS |
| 10 | en-functools-wraps | en | tech_doc | functools — Higher-order functions ... |
| 11 | zh-promise-mdn | zh | tech_doc | Promise - JavaScript \| MDN |
| 12 | zh-vue-reactivity | zh | tutorial | 响应式基础 \| Vue.js |
| 13 | zh-git-rebase | zh | tech_doc | Git - 变基 |
| 14 | zh-crispr-wiki | zh | academic | CRISPR - 维基百科 |
| 15 | zh-quantum-entanglement | zh | academic | 量子纠缠 - 维基百科 |
| 16 | zh-lunyu-xueer | zh | history | 《论语·学而》 |
| 17 | zh-zhangqian | zh | history | 张骞 - 维基百科 |
| 18 | zh-bbc-2008-crisis | zh | news | 新一场的金融危机或正在酝酿 - BBC News 中文 |
| 19 | zh-xinhua-ai-governance | zh | news | 新华社评论员：共同推动人工智能服务全球发展 |
| 20 | zh-es6-promise-ruanyifeng | zh | tutorial | ES6 教程 - Promise 对象 |

类别分布：`tech_doc` 5、`tutorial` 4、`academic` 5、`news` 3、`history` 3；语言：中文 10、英文 10。

## 3. 延迟结果

### 3.1 "第一条建议可显示"时间（tFirstSuggestion，单位 ms，n=60/组）

| 接口 | 变体 | p50 | p95 | min | max |
| --- | --- | --- | --- | --- | --- |
| 公司中转站 | selection_only | 811 | 1139 | 464 | 1221 |
| 公司中转站 | selection_context | 801 | 1039 | 542 | 1607 |
| DeepSeek 官方 | selection_only | 798 | 1070 | 405 | 1188 |
| DeepSeek 官方 | selection_context | 782 | 1171 | 426 | 1266 |

四组几乎没有系统性差异（p50 都在 780–810ms，p95 在 1.0–1.2 秒），说明"首条建议可显示"的耗时主要由模型生成第一行文字所需的 token 数决定，变体（是否带上下文）和走哪个接口对这一项影响很小。

### 3.2 到响应头、到首 token、到全部完成（p50/p95，ms）

| 接口 | 变体 | tHeader p50/p95 | tFirstToken p50/p95 | tDone p50/p95 |
| --- | --- | --- | --- | --- |
| 公司中转站 | selection_only | 573 / 835 | 675 / 1020 | 1099 / 1503 |
| 公司中转站 | selection_context | 555 / 774 | 658 / 880 | 1108 / 1416 |
| DeepSeek 官方 | selection_only | 115 / 206 | 548 / 864 | 1045 / 1386 |
| DeepSeek 官方 | selection_context | 116 / 187 | 534 / 870 | 1096 / 1515 |

公司中转站的 `tHeader` 比官方接口慢约 440–460ms（经 VPN 的固定开销），但首 token 之后的生成速度两边接近，所以 `tFirstSuggestion` 和 `tDone` 两接口差距很小——**VPN 开销被"慢下来的前半段"吸收了，没有线性放大到最终体验上**，但首条建议仍然会因为这约 450ms 的固定开销而整体晚出现。中英文材料之间没有看到明显差异（按 `lang` 细分的 `tFirstSuggestion` p50 都在 780–825ms 区间，见 `results/summary.json`）。

### 3.3 预热场景

假设工具栏出现即发请求、用户在请求发出后约 1 秒点击"问"（落在需求给的 0.5–1.5 秒区间中段）：

| 接口 | 建议已可显示的比例 | tFirstSuggestion p50/p95 |
| --- | --- | --- |
| 公司中转站 | 34/40 = 85.0% | 850 / 1129 |
| DeepSeek 官方 | 33/40 = 82.5% | 777 / 1109 |

也就是说，**如果能在工具栏出现的同时就发出这次请求，约 8 成多的情况下用户点"问"时建议已经显示完第一条**；但仍有 15–18% 的情况赶不上，且这是在"用户 1 秒后才点"的假设下——如果用户看到工具栏后反应更快（比如 0.5 秒就点了问），达标比例会明显更低。**这个 1 秒假设本身没有可靠的公开数据支撑**，见第 4 节。

## 4. 用户开始打字的参考时间

没有找到专门针对"点击 AI 问答面板的问按钮后、用户开始打字前"这一精确间隔的公开研究。能找到的两个相关但不完全对应的参考：

- Nielsen Norman Group《Response Time Limits: The 3 Important Limits》：1 秒是"用户思路不被打断"的经验阈值（源自 Miller 1968、Card et al. 1991 的人因工程研究），超过这个时间用户会感知到延迟。这是关于**系统响应时间**的阈值，不是"用户自己开始打字"的时间，但常被引用为"交互要在 1 秒内给反馈"的参考线。（https://www.nngroup.com/articles/response-times-3-important-limits/）
- VentureBeat 对 Google 2010 年发布 Google Instant 的报道，引用 Google 方面的说法："Humans take 9 seconds to enter a search query"——这是**输入完整个搜索词所需的总时长**，不是"开始打字前"的停顿时长，且是十几年前、针对搜索框的笼统说法。（https://venturebeat.com/media/google-instant-launch）

两者都不能直接回答"划词后点问、到开始打字"这个具体问题。**本节的结论是：无可靠公开参考，需要用户实测**。本次预热测量里用的"1 秒"只是为了给出一个具体数字做演示，不代表真实用户行为，第 6 节会标注这一点。

## 5. 代理命中率（仅供参考，不能代替用户标注）

| 变体 | 读者问题总数 | 被命中数 | 代理命中率 |
| --- | --- | --- | --- |
| selection_only | 40 | 23 | 57.5% |
| selection_context | 40 | 31 | 77.5% |
| 合计 | 80 | 54 | 67.5% |

`selection_context`（带前后各 3 段上下文）比 `selection_only` 高出 20 个百分点，在抽样复核的 8 组里也能看到原因：带上下文的建议更容易精确点出原文里的具体用词（比如引用 `"Replay the commits, one by one, in order"` 原句），而只给划选内容时建议容易停留在划选句子本身，覆盖不到读者真正好奇的"前后因果"。

**人工复核**：抽样复核 8 组（约 20%）判别结果，7 组认为判定合理，1 组（`en-lehman-bankruptcy` / `selection_context`）的"命中"判定偏宽松——读者问的是"另外两家具体是谁"，AI 建议问的是"还有哪三家"，语义相关但不完全是同一个问题，判别模型给了"命中"，人工复核认为这个算部分命中更准确。整体来看代理判别**没有系统性地偏松或偏紧**，可以作为参考，但抽样量小（仅 8/40），不足以替代真实用户标注。

另外一个现象值得记录：在 `zh-quantum-entanglement` 这类需要较深背景知识的材料上，代理读者提出的问题比 AI 建议更深入（比如追问"纠缠关联到底是分离时锁定还是测量时建立"），而三条建议都停留在"为什么叫鬼魅般的超距作用"这类表层问题，判别结果是两条读者问题都未命中。这提示：**建议质量在"需要专业背景去追问"的材料上可能系统性偏浅**，但样本量（本类别仅 2 段材料）不足以下结论，需要在用户标注阶段专门关注学术类材料的命中率是否偏低。

## 6. 结论与建议

1. **提问前的模型建议能否赶在用户打字之前出现**：如果能在工具栏出现时就预热发出请求（符合 ARCHITECTURE.md 5.2 的设计），在"用户 1 秒后点问"的假设下，约 82.5–85% 的情况下第一条建议已经可以显示；不预热、点了问才发请求的话，p50 约 0.8 秒、p95 约 1.0–1.2 秒，接近但不总能赶上 Decision 053 里"点问的人通常马上开始打字"的预期。**建议：保留预热机制作为这一功能能否成立的前提**，不预热就不要上线这一层建议。
2. **两个变体怎么选**：`selection_context` 在延迟上不比 `selection_only` 慢（两者 p50 都在 780–810ms），但代理命中率高出 20 个百分点。**建议：默认用 `selection_context`（前后各 3 段）**，这与架构文档里"带上下文"档位的思路一致，没有额外代价。
3. **两个接口怎么选**：公司中转站的固定 VPN 开销（约 450ms）主要体现在到响应头的时间上，没有线性放大到首条建议可显示的时间；如果后续要用这层建议，两个接口在延迟上都可接受，**选哪个可以按模型配置里用户正在用的默认连接来定，不需要专门为这层建议切换接口**。
4. **命中率是否够高、是否保留这一层建议**：代理命中率 67.5%（`selection_context` 下 77.5%）看起来不低，但这是"AI 判断 AI"的结果，Decision 053 已经预判"点问的人多半有自己的问题，命中率预计最低"——如果真实用户标注的命中率明显低于代理命中率（比如腰斩到 30–40%），这层建议的价值就存疑。**这一条必须等用户用 `用户标注表.md` 实测后才能下结论，本报告不代为做出"保留/去掉"的最终判断**。
5. **延迟上的结论可以直接用**：预热让建议能在用户点问前大概率就绪，这一点有实测数据支持，可以认为第 7 节验收标准里"能否赶在用户打字之前出现"这半个问题已经有答案（能，但要预热；不预热就不稳）。

## 7. 必须等用户标注才能确定的结论

- **真实命中率**：代理命中率只是参考上限的粗略估计，真实用户是否觉得 3 条建议里有一条"正是我想问的"，必须看 `用户标注表.md` 填完后的统计，不能用本报告第 5 节的数字代替。
- **"建议出现时是否已经开始打字"**：本报告用"预热后 1 秒点问"这个假设模拟，真实用户从看到工具栏到点问、到开始打字的间隔完全未知（见第 4 节），用户标注表里专门留了这一列，必须靠真实使用数据，不能靠本报告的模拟值。
- **学术类材料命中率是否偏低**：第 5 节观察到的"代理读者问题比建议更深"的现象只有 2 个样本支持，需要用户标注里的学术类材料（编号 5、6、7、14、15）结果来确认或推翻。
- **最终决策**（保留模型建议 / 只留规则建议与追问建议 / 需要更多数据）：按 Decision 053，这一决策要等用户标注命中率出来后再定，本报告不预先替用户做选择。
