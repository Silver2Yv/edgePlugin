# materials.json 字段说明

`materials.json` 是一个 JSON 数组，每个元素是一段阅读材料，共 20 段。字段含义如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一标识，格式为 `{lang}-{主题}`，例如 `zh-promise-mdn`。 |
| `title` | string | 该材料所在页面/文章的标题，用于提示词里的"页面标题"。 |
| `sourceUrl` | string | 原始出处链接，公开可访问。 |
| `license` | string | 版权/许可说明：维基百科类标注 CC BY-SA 4.0，MDN 标注 CC BY-SA 2.5，官方文档标注各自许可证，新闻/通稿类标注"合理引用片段"。 |
| `lang` | string | `"zh"` 或 `"en"`，决定提示词里要求模型用哪种语言输出问题。 |
| `context` | string | 800–2500 字的上下文正文，模拟页面正文的一段，供"带上下文"变体使用，也是读者标注时的阅读材料。 |
| `selection` | string | 用户可能划中的一句话或术语，**必须是 `context` 的原文子串**（已用脚本校验，见仓库历史中的 `_build_materials.mjs`）。 |
| `category` | string | 五选一：`tech_doc`（技术文档）、`academic`（学术论文/摘要）、`news`（新闻/评论）、`tutorial`（教程）、`history`（历史/人文）。 |

## 使用约定

- **selection 必须是 context 的精确子串**：下游脚本用 `context.indexOf(selection)` 定位划选位置，据此切出"前后各至多 3 段"的上下文（`selection_context` 变体）。若未来增补材料，务必保证这一约定，否则会退化为"取全文前后段落"的兜底逻辑。
- **段落以空行（`\n\n`）分隔**：`context` 内部用空行分段，前后文提取逻辑按空行切分段落。
- **字段集合保持稳定**：后续若要扩展（例如加入来源的发布日期、作者），请新增字段而不是修改已有字段的含义，以便已经集成到测试包页面里的代码不受影响。
- **lang 目前只有二值**：如果以后要支持更多语言，需要同步检查 `scripts/lib/prompt.mjs` 和 `scripts/lib/eval-prompt.mjs` 里按 `lang === 'en'` 判断的分支。
