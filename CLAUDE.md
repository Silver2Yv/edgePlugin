# CLAUDE.md — 阅读助手扩展

AI 阅读助手浏览器扩展（Chrome / Edge，Manifest V3，最低 141）。原型验证已完成，当前阶段是核心功能开发。以 `docs/` 为准：

| 要查什么 | 看哪里 |
| --- | --- |
| 代码现状、模块地图、测试资产、下一步 | `docs/核心功能开发/HANDOFF.md`；待用户答复的事项见同目录 `REVIEW_CHECKLIST.md` |
| 架构（v1.4） | `docs/架构设计/ARCHITECTURE.md` |
| 为什么这么定 | `docs/需求分析梳理/DECISIONS.md`（冲突时编号大的为准） |
| 需求与验收 | `docs/需求分析梳理/FINAL_PLAN.md` |
| 已接受的降级、带进本阶段的事项 | `docs/原型验证/PROTOTYPE_REPORT.md` 第 3、4 节 |
| 验证用例与结果模板 | `docs/架构设计/VALIDATION_MATRIX.md` |

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发模式（自动打开带扩展的浏览器） |
| `pnpm build` | 生产构建，产物在 `.output/chrome-mv3/`，Chrome 与 Edge 同一份 |
| `pnpm verify` | 本地跑一遍 CI：lint、类型、依赖方向、单测、构建、体积、清单权限 |
| `pnpm test` / `pnpm test:e2e` | 单元测试（Vitest）/ 端到端（Playwright，需先 build） |
| `pnpm mock-relay` | 启动模拟中转站（`tests/mock-relay/`） |

本机 Playwright 自带 Chromium 若无法启动，设 `E2E_CHROMIUM_PATH` 指向一份可用的 chrome.exe 副本。`E2E_BROWSER=msedge` 改用本机安装的 Edge（有界面）。

## 测试踩坑

- Playwright 的调试协议连着时后台不会空闲回收。模拟回收用 CDP `ServiceWorker.stopAllWorkers`，之后用 `context.serviceWorkers()[0]` 取新的后台；真实回收要按 `prototypes/v01-lifecycle/` 的分离进程测法。
- 侧边栏页面不在 `context.pages()` 里，经 `tests/e2e/sidepanel-helpers.ts` 用调试协议附加。Playwright 按不出扩展快捷键、点不了原生右键菜单，用 `dispatchCommand` / `dispatchMenu` 在后台直接触发（没有用户手势），真实按键要用户手动确认。
- 有界面的 Edge 上焦点、拖动类用例偶发失败（窗口被遮挡时不出新帧），以无界面 CfT 结果为准，Edge 上复跑确认。
- Preact 的数字样式值要写成带 `px` 的字符串（`tests/unit/ui/style-units.test.ts` 守住）。
- 首次安装会自动打开欢迎页并抢走活动标签页：e2e 夹具默认关掉它（`tests/e2e/fixtures.ts` 的 `dismissWelcome`），测欢迎页用 `keepWelcome`；自己起浏览器的用例要自己调 `dismissWelcome`。
- 划词用 `page-helpers.ts` 的 `tripleClick`（先滚到位、等两帧再三击）：直接 `locator.click({ clickCount: 3 })` 自带的滚动若在 mouseup 之后才派发 scroll 事件，哨兵会把刚弹出的工具栏按「滚动后消失」收起，用例偶发等不到工具栏。`page-identity` 前进后退用例在全量跑时偶发超时，单独重跑能过。
- 侧边栏页面刚打开时先按 0 宽排版（`innerWidth` 为 0），这时量的尺寸、位置都不可信：`sidepanel-helpers.ts` 的点击等宽度不为 0 再量。
- 有界面 Edge 上 Playwright 模拟的 `devicePixelRatio` 是 1，`captureVisibleTab` 却按真实窗口与系统缩放出图：截图尺寸断言用实测比例（`capture.spec.ts` 的 `captureScale`）。
- `context.route` 拦不到扩展自己用 `tabs.create` 新开标签页的第一次导航：这类用例的网页用本地 http 服务（`jump-back.spec.ts`）。
- 小窗是网页里的 iframe，里面调不了 `navigator.clipboard`：粘贴用例在另一个标签页写剪贴板再回来按 Ctrl+V；侧边栏用调试协议派发带 DataTransfer 的 paste 事件（`paste-image.spec.ts`）。
- 要缩短页面侧的长计时（小窗 10 分钟销毁），用调试协议在内容脚本的隔离环境里替换 `setTimeout`，不给生产代码加开关（`float-idle.spec.ts`）。

## 不可违反的架构规则（ARCHITECTURE 4.3）

1. 只有后台发模型请求。页面脚本和界面页面都不访问模型服务。
2. 生成任务归后台所有。界面只订阅；界面消失不影响任务。
3. 网页里常驻的只有哨兵，且只在正常站点。哨兵无第三方依赖，加载时不读写 DOM、不建观察器。
4. 对话内容只出现在扩展页面里。不进入网页 DOM，不经过 `window.postMessage`。
5. 页面内容和模型输出都是不可信数据。模型输出不产生原始 HTML；回答里的外链图片不抓取、不显示。
6. 后台的请求目标必须可见、可审查。只发 5.14 请求分类表里的类别；内容脚本的消息不能携带请求地址或密钥。
7. 身份取自发送者（`sender`），不取自消息内容。
8. 每次请求有一份发送计划，界面显示的和发出去的必须能对上。
9. 引用与快照绑定，编号只在那一次请求发送的块集合里有效。
10. 打开侧边栏的调用必须在用户操作事件的同步路径上发出，之前不得 `await`。
11. `core/` 是纯逻辑，不依赖扩展 API；`page/` 不引用 `ui/`。
12. 只响应 `isTrusted` 的用户事件；`isTrusted` 不等于授权，授权按 5.12 判定。

## 目录与依赖方向（ARCHITECTURE 7 节）

| 目录 | 内容 | 可以依赖 |
| --- | --- | --- |
| `src/core/` | 纯逻辑：领域类型、上下文装配、模型适配、提示词、锚点、建议 | 只依赖 `core/` 自身，不用扩展 API，不引第三方包 |
| `src/background/` | 后台：任务、路由、菜单快捷键、脚本注册 | `core/`、`platform/` |
| `src/page/` | 页面侧：哨兵、阅读器、工具栏、抽取、小窗宿主 | `core/`、`platform/`；**不得**依赖 `ui/` |
| `src/ui/` | Preact 界面 | `core/`、`platform/`；不做数据库写入 |
| `src/platform/` | 存储、消息、数据库、访问级别 | `core/` |
| `src/entrypoints/` | WXT 入口，只做装配 | 以上全部 |

`pnpm check:deps` 守住：`core` 纯净、`page` 不引 `ui`、哨兵依赖链无第三方包。哨兵 gzip ≤ 10 KB 由 `pnpm check:size` 守住；ARCHITECTURE 5.15 其余性能与体积数字是参考值，不是硬门槛（决策 081）。

## 约定

- WXT 自动导入已关闭（`imports: false`）：扩展 API 从 `wxt/browser` 显式导入，`define*` 从 `wxt/utils/*` 导入。
- 消息协议只在 `src/core/domain/messages.ts` 定义；后台入口做运行时校验，未知类型与超限消息拒绝且无副作用。改了协议就打下一个 `contract-v1.x` 注解 tag（现为 v1.6）。
- 改清单权限要同步 `scripts/manifest-baseline.json`，并在 PR 描述里标出。
- 文档用中文、表格风格。新决策追加到 `DECISIONS.md`，编号顺延。

## 安全

- Key 不写进任何文件、日志、测试结果或提交。原型的本地秘密放 `prototypes/**/.secrets/`（已忽略）。
- 公司中转站的真实地址不写进会提交的文件，统一称「公司中转站」。
- `sidebar-copilot-main/` 无许可证，只能借鉴思路，不能拷贝代码或素材；`selectlingo-v1.1.0/` 为 MIT 构建产物，复用样式须保留许可声明。两者都不进仓库。
