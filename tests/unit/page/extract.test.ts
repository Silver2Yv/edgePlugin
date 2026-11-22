// @vitest-environment happy-dom
// 抽取（5.6、M6）：不读任何表单输入的值（只读多行代码输入框是唯一例外）；隐藏内容不读，语义折叠容器里的照读；
// 代码、表格、公式整体序列化为 Markdown；内容指纹与后台按同一算法重算的结果一致。
// happy-dom 不做布局，innerText 等于 textContent：这里只验证规则，质量与耗时看 scripts/v08-port-eval.ts（真实 Chromium）。
import { describe, expect, it } from 'vitest';
import { contentVersionOf } from '@/core/context/content-version';
import { pageDocSchema } from '@/core/domain/messages';
import { extractPage } from '@/page/extract';

const PAGE = `
<nav><a href="/">首页导航</a></nav>
<article>
  <h1>标题甲</h1>
  <p>第一段正文，介绍背景，足够长的正文内容让语义根节点成立。</p>
  <h2>小节乙</h2>
  <p>第二段正文，在小节乙下面。</p>
  <form><input type="password" value="PWD-SECRET"><input value="INPUT-SECRET"></form>
  <div><textarea>TEXTAREA-SECRET</textarea></div>
  <div contenteditable="true">EDITABLE-SECRET 可编辑区域里的文字</div>
  <textarea readonly>const ro = 'RO-CODE';</textarea>
  <pre class="language-ts"><code>const a = 1;</code></pre>
  <table><tr><th>名</th><th>值</th></tr><tr><td>甲</td><td>1</td></tr></table>
  <ul><li>列表一</li><li>列表二</li></ul>
  <span class="katex-display"><annotation encoding="application/x-tex">E = mc^2</annotation>渲染后的公式</span>
  <div style="display:none">HIDDEN-TEXT 隐藏的文字</div>
  <details><summary>折叠标题</summary><p>折叠区里的正文</p></details>
  <footer>页脚文字</footer>
</article>`;

describe('extractPage', () => {
  it('输入值一个都不读；只读代码框整体读成代码块', async () => {
    document.title = '抽取测试';
    document.body.innerHTML = `${PAGE}<p>${'补充正文。'.repeat(60)}</p>`;
    const { report } = await extractPage(document, { sliceMs: 1 });
    const all = report.blocks.map((b) => b.text).join('\n');
    for (const s of ['PWD-SECRET', 'INPUT-SECRET', 'TEXTAREA-SECRET', 'EDITABLE-SECRET', 'HIDDEN-TEXT'])
      expect(all).not.toContain(s);
    expect(all).not.toContain('首页导航');
    expect(all).not.toContain('页脚文字');
    const code = report.blocks.filter((b) => b.kind === 'code').map((b) => b.text);
    expect(code).toContain("```\nconst ro = 'RO-CODE';\n```");
    expect(code).toContain('```ts\nconst a = 1;\n```');
  });

  it('结构：标题链、表格整体一块、列表逐项成块、公式取 LaTeX 源、折叠区照读', async () => {
    document.body.innerHTML = PAGE;
    const { report } = await extractPage(document);
    const by = (kind: string) => report.blocks.filter((b) => b.kind === kind);
    expect(by('heading').map((b) => b.text)).toEqual(['标题甲', '小节乙']);
    const second = report.blocks.find((b) => b.text.startsWith('第二段'));
    expect(second?.headingPath).toEqual(['标题甲', '小节乙']);
    expect(by('table')[0]?.text).toBe('| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |');
    expect(by('listItem').map((b) => b.text)).toEqual(['- 列表一', '- 列表二']);
    expect(by('math')[0]?.text).toBe('$$\nE = mc^2\n$$');
    expect(report.blocks.some((b) => b.text.includes('折叠区里的正文'))).toBe(true);
    expect(report.notes.some((n) => n.kind === 'visibilityUncertain')).toBe(true);
  });

  it('报告通过 pageDocSchema 校验，指纹与按同一算法重算的一致；块编号连续', async () => {
    document.body.innerHTML = PAGE;
    const { report, elements } = await extractPage(document);
    expect(pageDocSchema.parse(JSON.parse(JSON.stringify(report))).ok).toBe(true);
    expect(report.contentVersion).toBe(contentVersionOf(report.title, report.blocks));
    expect(report.blocks.map((b) => b.id)).toEqual(report.blocks.map((_, i) => `b${i + 1}`));
    expect(elements.size).toBe(report.blocks.length);
  });

  it('只换一个字（长度不变）指纹就变', async () => {
    document.body.innerHTML = PAGE;
    const a = (await extractPage(document)).report.contentVersion;
    document.body.innerHTML = PAGE.replace('第二段正文', '第二段正义');
    const b = (await extractPage(document)).report.contentVersion;
    expect(a).not.toBe(b);
  });

  it('列表拆成多块后每项都能单独定位（修复 3：避免整组列表变成一个不可拆分的大块）', async () => {
    document.body.innerHTML = `<main><h1>清单</h1><ul>${Array.from(
      { length: 5 },
      (_, i) => `<li>第 ${i + 1} 项，足够长的一项内容用来撑起正文占比。</li>`,
    ).join('')}</ul></main>`;
    const { report, elements } = await extractPage(document);
    const items = report.blocks.filter((b) => b.kind === 'listItem');
    expect(items.map((b) => b.text)).toEqual([
      '- 第 1 项，足够长的一项内容用来撑起正文占比。',
      '- 第 2 项，足够长的一项内容用来撑起正文占比。',
      '- 第 3 项，足够长的一项内容用来撑起正文占比。',
      '- 第 4 项，足够长的一项内容用来撑起正文占比。',
      '- 第 5 项，足够长的一项内容用来撑起正文占比。',
    ]);
    // 每项各自映射到自己的 <li>，不是全部映射到同一个 <ul>
    const mapped = new Set(items.map((b) => elements.get(b.id)));
    expect(mapped.size).toBe(items.length);
  });

  it('候选根节点密度打分选中一个紧凑的小容器，但正文占比太低：退回整页文本（修复 1），而不是只读到那一小块', async () => {
    const navLinks = Array.from(
      { length: 40 },
      (_, i) => `<a href="/x${i}">链接正文占位字符数文本第${i}条</a>`,
    ).join('');
    document.body.innerHTML = `
      <div>${'这是导航区里掺杂的说明文字。'.repeat(8)}${navLinks}</div>
      <div><p>${'紧凑小提示框里的文字。'.repeat(20)}</p><p>再补一段。</p><p>再补一段二。</p></div>
    `;
    const { report, rootMethod } = await extractPage(document);
    expect(rootMethod).toBe('fallback-body');
    expect(report.notes.some((n) => n.kind === 'fallbackBodyText')).toBe(true);
    // 退回整页文本：导航区与小提示框的文字都读到了，不是只读了密度打分选中的那一小块
    expect(report.blocks.some((b) => b.text.includes('导航区里掺杂的说明文字'))).toBe(true);
    expect(report.blocks.some((b) => b.text.includes('紧凑小提示框里的文字'))).toBe(true);
  });

  it('正文几乎为零时（D15 失败兜底）不静默返回空结果，给出可操作的建议', async () => {
    document.body.innerHTML = '<div id="canvas-app"></div>';
    const { report } = await extractPage(document);
    const note = report.notes.find((n) => n.kind === 'tooLittleText');
    expect(note?.detail).toContain('框选');
    expect(note?.detail).toContain('截图');
  });
});
