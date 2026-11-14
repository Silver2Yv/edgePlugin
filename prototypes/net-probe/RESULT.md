# 网络诊断包 · 开发机自测结果

对应 V-01（公司中转站在扩展里的连通、流式、长等待与错误分类）、V-03（后台无界面时长任务能否撑完）的第一份证据。真机结论以公司网络回填表为准。

## 环境

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-11-14 |
| 浏览器 | Chromium 159.0.8154.6（Chrome for Testing，Playwright 加载解压扩展） |
| 网络 | UniVPN |
| 模型 | deepseek-flash（经公司中转站） |
| 运行方式 | `node prototypes/net-probe/self-test.mjs --long --no-keepalive` |
| 局限 | Playwright 通过调试协议连着后台，可能让后台不被回收，长任务结论偏乐观 |

## 结果

| 测试 | 结果 | 结论 |
| --- | --- | --- |
| T1 模型列表 | 200，0.10 s，列表含 deepseek-flash | 连通 |
| T2 漏写 /v1 | **200 + 网页**，0.03 s | 与决策记录观察一致：不能用状态码判断地址填对，设置页「测试连接」要检查内容类型是否 JSON |
| T3 非流式 | 200，0.5–0.8 s | 连通。初版 max_tokens=16 时正文为空：开思考时思考内容计入 max_tokens，小额度会被吃光 |
| T4 流式 | 200；响应头 0.35–0.82 s，首个正文 1.7–2.3 s，完成 2.0–2.7 s | 思考内容（`reasoning_content`）先于正文到达；有 `[DONE]`；无注释行、无 CRLF；一个网络块常含多个事件 |
| T5 长任务（保活关、诊断页已关） | 200，首个正文 5.5 s，**78.5 s 完成**，正文 14060 字，事件 9146 个，2 次事件跨网络块 | 后台在无界面订阅、无保活时撑完了 78 秒的流（有上面的局限） |
| T6a 错误 Key | 401，`new_api_error` | 可归为「Key 无效」 |
| T6b 错误路径 | 404，`invalid_request_error` | 可归为「地址错误」 |
| T6c 连不上的主机 | fetch 只给「Failed to fetch」；webRequest 的 onErrorOccurred 给出 `net::ERR_NAME_NOT_RESOLVED` | 浏览器错误码只能从 webRequest 拿，fetch 本身不区分原因（支持架构里用 webRequest 补充诊断的设计） |
| 问题建议页 | 2 篇冒烟，首条建议就绪 0.9–1.5 s | 页面可用；建议请求必须关思考，否则 220 的 max_tokens 不够，建议被截断 |

## 文件

| 文件 | 用途 |
| --- | --- |
| `extension/` | 诊断包本体（加载解压缩扩展） |
| `安装步骤.md`、`回填表.md` | 发给公司测试人 |
| `pack.py` | 打出 `网络诊断包.zip`（含材料原文，压缩包不提交） |
| `self-test.mjs` | 开发机自测；Key 从 Windows 用户环境变量读，只在内存中 |
