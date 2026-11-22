# edgePlugin — AI 阅读助手扩展

> **先读 [`docs/README.md`](docs/README.md)。** 它是全部文档的唯一入口，包含「按角色选路径」、文件清单、冲突时的裁决顺序和编号速查。
>
> 当前阶段：**核心功能开发**（骨架、契约与原型验证已在 2026-11-21 完成）。代码现状与下一步见 [`docs/核心功能开发/HANDOFF.md`](docs/核心功能开发/HANDOFF.md)；验证结论见 [`docs/原型验证/PROTOTYPE_REPORT.md`](docs/原型验证/PROTOTYPE_REPORT.md)；架构为 v1.2。
>
> 目录：
> - [`src/`](src/) — 扩展代码（WXT + Preact，Manifest V3，Chrome / Edge 141 起）；目录分工与依赖方向见 [`CLAUDE.md`](CLAUDE.md)
> - [`tests/`](tests/) — 单元测试（Vitest）、端到端（Playwright）、模拟中转站
> - [`prototypes/`](prototypes/) — 原型与测量脚本，索引见 [`prototypes/README.md`](prototypes/README.md)
> - [`docs/需求分析梳理/`](docs/需求分析梳理/) — 需求定稿（`FINAL_PLAN.md`）与 81 条决策（`DECISIONS.md`）
> - [`docs/架构设计/`](docs/架构设计/) — 架构文档、验证矩阵、评审与处置
> - [`docs/原型验证/`](docs/原型验证/) — 原型验证总报告与逐项记录
>
> 参考项目 `selectlingo-v1.1.0/`（MIT 构建产物）与 `sidebar-copilot-main/`（无许可证，只能借鉴思路）只放在本机，不进仓库。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发模式（自动打开带扩展的浏览器） |
| `pnpm build` | 生产构建，产物在 `.output/chrome-mv3/`，Chrome 与 Edge 同一份 |
| `pnpm verify` | 本地跑一遍 CI：lint、类型、依赖方向、单测、构建、体积、清单权限 |
| `pnpm test` / `pnpm test:e2e` | 单元测试 / 端到端（需先 build） |

在浏览器里试用：`pnpm build` 后打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」，「加载解压缩的扩展」选 `.output/chrome-mv3/`。首次安装会自动打开欢迎页（配置向导、示例文章、快捷键）；快捷键在 `edge://extensions/shortcuts` 查看与绑定，建议键位可能因冲突没有自动绑上，欢迎页与设置页会提示。

## 每个权限的用途

扩展没有后端，不收集、不上传任何数据；页面内容只发往你配置的模型服务。设置页「高级选项 → 权限说明」里是同一张表（文案在 `src/ui/options/strings.ts` 的 `permissions.items`，改清单权限时两处一起改，并同步 `scripts/manifest-baseline.json`）。

| 权限 | 用途 |
| --- | --- |
| `storage` | 把设置（含 API Key）保存在这台电脑的浏览器里，不同步。 |
| `unlimitedStorage` | 对话历史、收藏和页面快照保存在本机，不受默认的存储配额限制。 |
| `sidePanel` | 显示侧边栏。 |
| `contextMenus` | 在右键菜单里加上「问」和「总结本页」。 |
| `scripting` | 在网页里放划词工具栏，并在你提问时读取页面正文；黑名单里的网站不放。 |
| `webRequest` | 只读。只在连接出错时读取浏览器的网络错误码（如域名解析失败、证书错误），用来告诉你连不上的原因。只看发往你登记的模型地址的请求，不拦截、不修改任何请求。 |
| 主机权限 `<all_urls>` | 在任意网页上划词、读取你要问的页面内容、框选截图；向你填写的任意模型地址（包括内网中转站）发请求。 |
