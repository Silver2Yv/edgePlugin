# V-08 原型：PageDoc 与正文质量

对应 `docs/架构设计/VALIDATION_MATRIX.md` 的 V-08、`docs/架构设计/ARCHITECTURE.md` 5.6/5.7。
本目录是独立的 Node 项目，只在这里 `npm install`，不影响仓库根目录。

## 运行方式

```bash
npm install
npx playwright install chromium   # 只需一次
node src/build-bundle.mjs         # 打包三套抽取方案为可注入脚本
node src/fetch-and-extract.mjs    # 抓取全部样本 + 在真实 Chromium 里跑三套方案
node src/compute-metrics.mjs      # 汇总指标（依赖 samples/*.labels.json 人工标注）
```

单独重跑某个样本：`V08_ONLY=sample-id-1,sample-id-2 node src/fetch-and-extract.mjs`。

## 网络环境说明（重要，影响样本选取）

抓取当时实测，本机网络环境无法连接以下域名（TCP/TLS 连接超时，不是网站拒绝），
Playwright 的真实 Chromium 与 `curl` 结果一致：

- `wikipedia.org`（中英文均不可达）、`bbc.com`、`mathworld.wolfram.com`、
  `worldometers.info`、`tensorflow.org`、`en.wikibooks.org`

因此样本集**没有使用维基百科**（原计划里的远处指代、表格密集、公式密集样本改用其他来源，
见 `src/sample-config.mjs` 里的注释）。另有一批域名对 `curl` 默认 UA 返回 403，
但真实 Chromium 能正常访问（如 `ruanyifeng.com`、`baike.baidu.com` 的具体词条页），
这些仍按原计划使用。

这一条网络限制只影响**抓取环境**，不代表目标用户的真实网络；若该限制是本沙箱特有，
不构成对抽取方案本身结论的影响——三种方案在能抓到的页面上接受完全相同的输入。

## 目录结构

- `src/sample-config.mjs` —— 样本清单（URL、类别、候选备用地址）。
- `src/extractor-src/` —— 三套抽取方案的源码：`shared.js`（可见性规则 + 分块器，A/B/C 共用）、
  `scheme-a.js`（自研根节点识别）、`scheme-b.js`（Readability 识别根节点）、
  `scheme-c.js`（Defuddle 克隆 + 标记映射）。
- `src/extractor-bundle.js` —— esbuild 打包产物，由 `fetch-and-extract.mjs` 注入页面。
- `src/fixtures/readonly-textarea.html` —— 反例样本 4 的本地构造页面（见该文件内说明）。
- `samples/` —— 每个样本的 `*.html`（DOM 快照）、`*.png`（截图）、`*.labels.json`（人工标注）、
  `index.json`（样本清单与抓取结果）。
- `results/` —— 每个样本的 `*.extraction.json`（三方案原始输出）、`*.digest.txt`（人工复核用的
  精简文本）、`*.noise-review.json`（噪声/错误分类人工标注）、`metrics-summary.json`（汇总）。

## 方法论要点（避免重复查阅代码）

- **三方案只在「找正文根节点」这一步不同，分块器完全共用**（同一套可见性规则、同一套块
  类型判定）。这样噪声比例、结构保留情况的差异才能归因到根节点识别质量本身，而不是
  恰好用了不同的分块写法。
- 方案 A 直接在活文档上操作，不克隆，映射回 DOM 恒成立（按设计，不是优点的证明，只是
  没有克隆这一步因而没有映射问题）。
- 方案 B：给活文档所有元素打 `data-pd-id`，克隆后交给 Readability（`serializer: el => el`
  拿到 DOM 而不是字符串），从返回内容里收集 `data-pd-id`，映射回活文档，取这些节点在活
  文档里的最近公共祖先作为根节点，再用共用分块器切块。
- 方案 C：同样打标记后克隆，交给 Defuddle。**必须传 `{ debug: true }`**——不加这个选项
  Defuddle 会清掉所有 `data-*` 属性，映射会全军覆没（已实测确认，见 `src/extractor-src/scheme-c.js`
  注释）。拿到的 HTML 字符串重新解析后，用共用分块器切块，再按每块里剩余的 `data-pd-id`
  查回活文档节点，查不到的块标记 `mappedLive:false`，不假装映射成功。
- 证据召回判定：把标注里的原文短句和抽取出的全部块文本分别做「去空白、转小写」归一化后做
  子串匹配。标注短句不要跨越列表/表格序列化产生的分隔符（避免假阴性）。
- 噪声比例、错误分类属于人工判读，记在 `results/<id>.noise-review.json`，规则见该文件内
  注释与 `RESULT.md` 方法论一节。

## 许可声明

- `@mozilla/readability`：Apache-2.0。
- `defuddle`：MIT。
- 自研分块与可见性规则参考了 ARCHITECTURE.md 5.6 描述的规则，并借鉴 Readability 的
  标签/角色/类名去噪思路（Apache-2.0，已在代码注释与本文件声明）。
