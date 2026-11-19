// V-10 输入样本清单（对应 VALIDATION_MATRIX.md V-10“输入”一行）。
// 移植自 prototypes/v10-render/test/fixtures.ts，内容未改动。

export const RAW_HTML_INJECTION = `正文开头。

<script>window.__pwned = 1;</script>

<img src="x" onerror="window.__pwned = 2">

<a href="#" onclick="window.__pwned = 3">点我</a>

正文结尾。`;

export const DANGEROUS_PROTOCOL_LINKS = `
[危险1](javascript:alert(1))
[危险2](JaVaScRiPt:alert(1))
[危险3](java\tscript:alert(1))
[危险4](java&#x0a;script:alert(1))
[危险5](&#106;avascript:alert(1))
[危险6](data:text/html,<script>alert(1)</script>)
[危险7](vbscript:msgbox(1))
[危险8](file:///etc/passwd)
[危险9](  javascript:alert(1))
[安全1](https://example.com/a?b=1)
[安全2](http://example.com)
[安全3](mailto:a@example.com)
`;

export const CITATION_ATTRIBUTE_CHARS = `要点一【12】
这不是引用标记：【12" onclick=alert(1)】
这也不是：【abc】
这是允许的逐字引用：【12】原文片段【/12】
这是不被允许块号的逐字引用：【99】原文片段【/99】
多编号：【12,5】
部分越权的多编号（99 不在允许集合内，整体按纯文本）：【12,99】`;

export const CITATION_ALLOWED_IDS = new Set(['12', '5']);

export const TRAILING_REFERENCE_DEFINITION = `先看[这个链接][ref1]，再看文档。

这段之后还有更多正文，确保参考定义块不是最后一块。

[ref1]: https://example.com/resolved-later "后置标题"
`;

export const NESTED_LIST = `- 第一层 A
  - 第二层 A1
    - 第三层 A1a
  - 第二层 A2
- 第一层 B
  1. 有序 B1
  2. 有序 B2
     - 混合 B2a
`;

export const TABLE_SAMPLE = `| 列1 | 列2 | 列3 |
| --- | :-: | --: |
| a | b | c |
| 中文 | *斜体* | \`code\` |
`;

export const UNCLOSED_CODE_FENCE = `正文。

\`\`\`js
function foo() {
  return 1;
// 没有闭合围栏
`;

export const UNCLOSED_MATH_BLOCK = `正文。

$$
\\frac{1}{2
`;

export const HUGE_FORMULA = `公式见下：

$$\\rule{900000em}{900000em}$$

结束。`;

export const LONG_CODE_BLOCK = '```text\n' + 'x'.repeat(25_000) + '\n```\n';

export const KATEX_SYNTAX_ERROR = `公式：$\\frac{1}{$ 结束。`;

export const KATEX_MACRO_RECURSION = `公式：$\\def\\x{\\x\\x}\\x$ 结束。`;

export const KATEX_HREF_URL = `公式：$\\href{https://evil.example/a}{点我}$ 和 $\\url{https://evil.example/b}$ 结束。`;

export const MULTI_PARAGRAPH_WITH_CODE_AND_TABLE = `# 标题

第一段，*斜体*与**粗体**，还有行内公式 $E=mc^2$。

${NESTED_LIST}

${TABLE_SAMPLE}

\`\`\`python
def add(a, b):
    return a + b
\`\`\`

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

> 引用块一行
> 引用块第二行

结尾段落，带一个安全链接 [示例](https://example.com)。
`;
