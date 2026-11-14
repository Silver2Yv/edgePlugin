# CLAUDE.md — 阅读助手扩展

AI 阅读助手浏览器扩展（Chrome / Edge，Manifest V3，最低 141）。架构与决策以 `docs/` 为准：
`docs/架构设计/ARCHITECTURE.md`（架构）、`docs/需求分析梳理/DECISIONS.md`（决策）、`docs/架构设计/VALIDATION_MATRIX.md`（验证用例）。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发模式（自动打开带扩展的浏览器） |
| `pnpm build` | 生产构建，产物在 `.output/chrome-mv3/`，Chrome 与 Edge 同一份 |
| `pnpm verify` | 本地跑一遍 CI：lint、类型、依赖方向、单测、构建、体积、清单权限 |
| `pnpm test` / `pnpm test:e2e` | 单元测试（Vitest）/ 端到端（Playwright，需先 build） |
| `pnpm mock-relay` | 启动模拟中转站（`tests/mock-relay/`） |

本机 Playwright 自带 Chromium 若无法启动，设 `E2E_CHROMIUM_PATH` 指向一份可用的 chrome.exe 副本。

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

`pnpm check:deps` 守住：`core` 纯净、`page` 不引 `ui`、哨兵依赖链无第三方包。哨兵 gzip ≤ 10 KB 由 `pnpm check:size` 守住。

## 约定

- WXT 自动导入已关闭（`imports: false`）：扩展 API 从 `wxt/browser` 显式导入，`define*` 从 `wxt/utils/*` 导入。
- 消息协议只在 `src/core/domain/messages.ts` 定义；后台入口做运行时校验，未知类型与超限消息拒绝且无副作用。
- 改清单权限要同步 `scripts/manifest-baseline.json`，并在 PR 描述里标出。
- 文档用中文、表格风格。新决策追加到 `DECISIONS.md`，编号顺延。

## 安全

- Key 不写进任何文件、日志、测试结果或提交。原型的本地秘密放 `prototypes/**/.secrets/`（已忽略）。
- 公司中转站的真实地址不写进会提交的文件，统一称「公司中转站」。
- `sidebar-copilot-main/` 无许可证，只能借鉴思路，不能拷贝代码或素材；`selectlingo-v1.1.0/` 为 MIT 构建产物，复用样式须保留许可声明。两者都不进仓库。
