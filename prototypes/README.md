# prototypes/ — 原型与测量脚本

> 原型验证阶段（2026-11-14 至 2026-11-21）留下的验证资产。结论已汇总进 [`docs/原型验证/PROTOTYPE_REPORT.md`](../docs/原型验证/PROTOTYPE_REPORT.md)；这里保留脚本、样本索引和结果，供以后复测。
> 产品代码（`src/`）不依赖这里的任何东西，CI 也不跑这里。不要在这里开发产品功能。
> 复测结果按 `docs/架构设计/VALIDATION_MATRIX.md` 第 5 节模板记到 `docs/原型验证/记录/`。

| 目录 | 对应 | 是什么 | 结论 | 怎么跑 | 只在本机、不进仓库 |
| --- | --- | --- | --- | --- | --- |
| `net-probe/` | V-01 | 独立的诊断小扩展：在公司网络下测连通、流式、长等待、错误分类、问题建议页 | 已完成，见 `RESULT.md` | `安装步骤.md`；`python pack.py` 打包成 `网络诊断包.zip` 发给测试的人，`回填表.md` 收结果 | `extension/materials.json`；打包出的 zip |
| `v01-lifecycle/` | V-01 | 分离子进程探针：调试协议不连着时，后台是否空闲回收、长任务能否撑住 | 通过，见 `docs/原型验证/记录/V-01.md` | `probe.mjs` 文件头（仓库根目录运行，用根目录依赖） | — |
| `v08-extraction/` | V-08 | 三种正文抽取方案在 28 个真实页面上的对比 | 接受降级；选方案 A，已移植到 `src/page/extract.ts`；见 `RESULT.md` | `README.md`（独立 Node 项目，在目录里 `npm install`） | `samples/`（整页样本）、`results/*.digest.txt`、`results/*.extraction.json`、`src/extractor-bundle.js` |
| `v09-citation/` | V-09 | 引用写法对比（真实调用两个模型连接）与锚点匹配算法 | 通过，见 `RESULT.md` | 独立 Node 项目：`npm run anchor:test`、`anchor:bench`、`format:run`（要 `.secrets/`） | `.secrets/`、`results-raw/` |
| `v10-render/` | V-10 | 安全渲染与流式 Markdown | 通过；代码已移植到 `src/ui/render/`，以那边为准；见 `RESULT.md` | 独立 Node 项目：`npm test`、`npm run bench` | — |
| `v13-perf/` | V-13 | 性能与资源测量脚本 | 接受降级，见 `docs/原型验证/记录/V-13.md` | `README.md`（仓库根目录运行，先 `pnpm build`） | — |
| `suggest-hit/` | I9（决策 053） | 问题建议的出现速度与代理命中率 | 速度达标；命中率样本太少，试用阶段凭感受判断；见 `RESULT.md` | 独立 Node 项目：`npm run measure:latency` 等（要 `.secrets/`） | `.secrets/`、`materials.json`、`results/raw/` |

- **秘密**：要连真实模型的原型（`v09-citation`、`suggest-hit`）从各自的 `.secrets/` 读地址和 Key，`.secrets/` 被 `.gitignore` 排除。不要把 Key 或公司中转站地址写进这里任何会提交的文件。
- **版权材料**：整页样本与抽取出的原文只留在本机；仓库里只有索引、指标和噪声复核。
- **浏览器**：`v10-render`、`v13-perf` 的命令示例用的是本机一份 Chrome for Testing 159（`E2E_CHROMIUM_PATH`），换机器时改成自己的路径。
