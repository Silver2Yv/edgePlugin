// @vitest-environment happy-dom
// 代码块复制按钮（5.3「代码复制」、V-12）：包一层容器、附加按钮，复制走 Clipboard API，
// 失败时退回 execCommand；只在块最初渲染时处理一次，不重复包裹。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addCopyButtons } from '@/ui/render';

function codeContainer(code = 'const x = 1;'): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = `<pre class="ra-code"><code>${code}</code></pre>`;
  document.body.append(container);
  return container;
}

describe('addCopyButtons', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('给每个 pre.ra-code 包一层并加「复制」按钮', () => {
    const container = codeContainer();
    addCopyButtons(container, document);
    const wrap = container.querySelector('.ra-code-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector('pre.ra-code')).not.toBeNull();
    const btn = wrap?.querySelector('button.ra-code-copy');
    expect(btn?.textContent).toBe('复制');
  });

  it('已经包过的块再调用一次：不重复包裹', () => {
    const container = codeContainer();
    addCopyButtons(container, document);
    addCopyButtons(container, document);
    expect(container.querySelectorAll('.ra-code-wrap')).toHaveLength(1);
    expect(container.querySelectorAll('.ra-code-copy')).toHaveLength(1);
  });

  it('多个代码块：各自独立包裹与按钮', () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<pre class="ra-code"><code>a</code></pre><p>文字</p><pre class="ra-code"><code>b</code></pre>';
    document.body.append(container);
    addCopyButtons(container, document);
    expect(container.querySelectorAll('.ra-code-wrap')).toHaveLength(2);
  });

  describe('点击复制', () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    it('Clipboard API 可用：写入代码文本（去掉高亮产生的标签，只取纯文本），按钮短暂显示「已复制」', async () => {
      const container = codeContainer('const x = 1;');
      addCopyButtons(container, document);
      const btn = container.querySelector('button.ra-code-copy') as HTMLButtonElement;
      btn.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
      await vi.waitFor(() => expect(btn.textContent).toBe('已复制'));
    });

    it('Clipboard API 失败：退回 execCommand，仍提示已复制', async () => {
      writeText.mockRejectedValue(new Error('denied'));
      const execCommand = vi.fn().mockReturnValue(true);
      Object.assign(document, { execCommand });
      const container = codeContainer('fallback code');
      addCopyButtons(container, document);
      const btn = container.querySelector('button.ra-code-copy') as HTMLButtonElement;
      btn.click();
      await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
      await vi.waitFor(() => expect(btn.textContent).toBe('已复制'));
    });

    it('Clipboard API 与 execCommand 都失败：提示复制失败', async () => {
      writeText.mockRejectedValue(new Error('denied'));
      Object.assign(document, { execCommand: vi.fn().mockReturnValue(false) });
      const container = codeContainer('x');
      addCopyButtons(container, document);
      const btn = container.querySelector('button.ra-code-copy') as HTMLButtonElement;
      btn.click();
      await vi.waitFor(() => expect(btn.textContent).toBe('复制失败'));
    });
  });
});
