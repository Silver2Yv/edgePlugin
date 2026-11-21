# V-13 性能与资源：测量脚本

对应 `docs/架构设计/VALIDATION_MATRIX.md` V-13、`docs/架构设计/ARCHITECTURE.md` 5.15（性能预算初值表）。
结果记录见 `docs/原型验证/记录/V-13.md`。

## 一条命令跑完

```bash
# 仓库根目录，先装依赖、build 一次（产物 .output/chrome-mv3/，和 e2e 用的是同一份）
pnpm install --frozen-lockfile
pnpm build

# 正式跑一遍（repeat 次数见 run.mjs 顶部 REPEATS；本机 CfT，约 10–20 分钟，视机器负载而定）
E2E_CHROMIUM_PATH=/d/tmp/cft/chrome.exe node prototypes/v13-perf/run.mjs

# 冒烟测试：每项只跑 1–2 次，几十秒内跑完，用来确认脚本本身没坏（不是正式数字）
E2E_CHROMIUM_PATH=/d/tmp/cft/chrome.exe node prototypes/v13-perf/run.mjs --quick

# 换成本机真实 Edge（有界面，不能无头）
E2E_BROWSER=msedge node prototypes/v13-perf/run.mjs
```

`E2E_CHROMIUM_PATH` 是约定：本机 Playwright 自带 Chromium 跑不起来时指向一份可用的 `chrome.exe`
（和 `tests/e2e/fixtures.ts` 用的环境变量一样）。不设置就用 Playwright 自带的 Chromium 渠道。

正式数字要在机器空闲时跑。机器上同时有别的 e2e 或构建在跑时，用 `V13_NOTE='……'` 写明测量条件，
结果文件的「环境」里会带上这句；不设置时记为「机器空闲时运行」。

输出：`prototypes/v13-perf/results/v13-<时间戳>.json`（原始样本 + 汇总）与同名 `.md`（表格），
以及总是指向最后一次结果的 `results/latest.json` / `results/latest.md`。

## 这条命令做了什么

1. 启动一个模拟中转站（`tests/mock-relay/server.ts`，`ok` 模式）用于大多数场景；长回答场景额外起
   一个 `scale: 0.03` 的实例（把 `long` 模式默认 330 秒的持续输出压缩到约 10 秒，可控时长）。
2. 启动两个 Playwright 持久化上下文：一个加载解压缩扩展（`.output/chrome-mv3`），一个不加载
   （基线对照：扩展禁用）。两个上下文复用整个脚本运行期间，每个场景内按需开关标签页。
3. 用 `context.route` 提供本地合成页面（`https://v13.test/*`、两个跨源子框架 host），不碰真实网站。
4. 依次跑完 `run.mjs` 里列的每个场景（见下），每个场景按 `REPEATS`／`TAB_COUNT`（`--quick` 时会整体
   调小）重复，收集样本后算 p50/p95/mean/min/max。
5. 写结果文件，关掉两个上下文和中转站，退出。

## 场景与对应的 V-13 要求

| 脚本里的场景 | 对应 V-13 |
| --- | --- |
| `bundleSize`（不开浏览器，直接读 `.output` 算 gzip） | 包体积 |
| `sentinelLoad`（CDP Tracing） | 加载主线程时间（哨兵） |
| `baseline`（扩展禁用/启用，空闲 2 秒窗口） | 基线对照；无交互页面；空闲页不抽取 |
| `selectNoAsk` | 划词未点击；mouseup→工具栏延迟；只选词不调模型 |
| `askFlowArticle` / `askFlowLargePage` / `askFlowMultiFrame`（各含 cold/warm 两组） | 冷/暖启动；大页面；多框架；点「问」→小窗可见；点击→请求发出；首个有用回答时间 |
| `multiFrameSubToolbar` | 多框架（子框架内独立选中也能弹工具栏，功能性抽查，不是延迟采样） |
| `scrollEnabled` / `scrollDisabled` | 连续滚动；长任务 |
| `longAnswer` | 长回答；首个有用回答时间；跨消息传输字节；内存峰值与回落 |
| `thirtyTabs` | 30 个标签页分别使用后隐藏；隐藏资源预算（每标签页小窗 iframe 数） |
| `backgroundWake` | 后台唤醒次数（见下「测不出来的」） |

## 调整重复次数 / 标签页数

`run.mjs` 顶部的 `REPEATS` 与 `TAB_COUNT` 常量就是全部可调参数，没有做成命令行参数——按需直接改
这两处数字再跑。`--quick` 是单独一套很小的数字，只用来验证脚本没坏，不要拿 `--quick` 的结果当正式基线。

## 合成页面

`lib/pages.mjs`：普通文章（几段）、大页面（默认约 2000 段合成正文）、多框架页面（4 个同源 + 2 个
跨源子框架）。都是本地生成的占位中文句子，不含任何真实网站内容。

## 方法说明（供复现、也供怀疑结果时查）

- **延迟测量**：用 CDP（`DOM.getDocument pierce:true` + `DOM.getBoxModel`）穿透封闭 shadow root 找
  工具栏按钮位置，和 `tests/e2e/page-helpers.ts` 的做法一致（本脚本不依赖那个文件，独立抄了一份精简版
  在 `lib/dom.mjs`，避免这个原型脚本的改动牵连到 e2e 套件）。所有「耗时」都以**动作发起前**
  （点击/选区调用之前）的时间戳为起点，不是等调用 resolve 之后才起算，否则会把前面已经走掉的时间
  漏算、低估真实延迟。
- **longtask**：`context.addInitScript` 在每个新文档里挂一个标准 `PerformanceObserver({type:'longtask'})`，
  不改产品代码。阈值是浏览器定义的 50ms；按架构设计，正常的抽取分片应该做到单片 ≤ 50ms，所以「正常
  情况下几乎看不到 longtask」本身就是预期结果，不是测量失灵。
- **阅读器是否被注入过**：阅读器用 `Symbol.for('readingAssistant.readerInjected')` 在 `globalThis`
  上做幂等标记（`src/page/reader.ts`）。全局符号登记表跨隔离世界共享，`page.evaluate` 能读到这个布尔
  标记，不读取任何对话或页面正文内容，用来证明「阅读器/抽取代码到底有没有被执行过」而不必另外在产品
  代码里加埋点。
- **跨消息字节 / 首个有用回答时间（长回答场景）**：没有用真实小窗输入框那套 UI 流程来测字节数，而是
  额外开一条独立的 `'conv'` 端口（`chrome.runtime.connect({name:'conv'})`，`conv/resumeFloat` +
  `conv/ask`），这是产品本身支持的、已有的协议通道（和 `tests/e2e/page-helpers.ts` 的 `convAsk` 同一
  手法），不是绕过授权的后门。每条收到的消息按 `JSON.stringify(...).length` 估算字节数，是**近似值**
  （真实跨进程传输可能有协议开销，这里只能代表消息体本身的 JSON 大小）。
- **哨兵加载期主线程耗时**：用 CDP Tracing（`devtools.timeline` 分类）抓一次完整导航，把参数或名字里
  提到 `sentinel.js` 且有 `dur` 字段的完整事件（`ph:'X'`）耗时加总。这是一个近似口径（按脚本 URL 关联
  事件），不是 Chrome 内部对"哨兵专属主线程占用"的官方统计口径。

## 已知测不出来的（如实说明，没有硬凑数字）

- **后台唤醒次数**：Playwright/CDP 全程连着浏览器时，扩展后台不会被 30 秒空闲阈值回收——这是
  `docs/原型验证/记录/V-01.md` 已经用「分离子进程」方法实测证实的限制。本脚本全程用同一个 Playwright
  连接驱动所有场景（包括 30 个标签页要来回切换、读 CDP 指标），没办法在跑的同时又让调试协议断开。
  `thirtyTabs.workerEpochChanged` 预期全程是 `false`，这不代表后台真的一次都没被唤醒过，只代表这条
  测量路径测不出来。要测真实唤醒次数，需要参考 V-01 的「分离子进程 + 全新进程重连」方法单独测，但那样
  就没法同时用 Playwright 去驱动 30 个标签页的交互——这是两种测法目标冲突，不是没做够。

## 已知产品行为（测量过程中顺带确认，仅记录，未修改代码）

- **小窗「标签页隐藏 10 分钟销毁」没有实现**：读过 `src/page/float-host.ts` 源码确认，预热创建的隐藏
  iframe 目前只有「每个标签页最多一个」这条做到了（`ensureReader`/`hasFloat` 的幂等检查），没有任何
  定时器在标签页隐藏 N 分钟后销毁它。30 个标签页场景里看到的内存只会涨不会因为这个机制回落，如实记录，
  没有去实现这个定时器。
- **预热阶段不读取页面正文**：读 `src/background/float-host.ts`（`prewarm`）与 `src/background/pages.ts`
  （`prepare`/`readInto`）代码确认，划词触发的预热只做「注入阅读器 + 建隐藏小窗」，真正调用
  `extractPage()` 的 `page/read` 消息只在用户真正发问、后台组装 `RequestContextPlan` 时才发出。这与
  `ARCHITECTURE.md` 5.2 原文「工具栏出现即预热：……空闲时抽取页面」字面上不完全一致（现状更保守，没有
  在预热阶段抽取），细节见 `docs/原型验证/记录/V-13.md`。

## 安全

不涉及真实中转站、不写入任何 Key。`lib/env.mjs` 里的 `apiKey` 是写死的占位字符串
（`v13-perf-fake-key`），和 e2e 套件的 `e2e-fake-key` 一样性质。
