/**
 * 代码块复制按钮（5.3「代码复制」、V-12）。
 *
 * 只在块最初渲染时调用一次（streaming-renderer.ts 的 renderGroup）：被缓存复用的「未变化」块
 * 不会重新跑这里，按钮也就不会重复附加。
 *
 * 复制优先用 Clipboard API（iframe 声明了 `allow="clipboard-write"`）；宿主页面的权限策略可能
 * 禁止，失败时退回 `execCommand('copy')`（5.3 已知约束）。
 */

const FEEDBACK_MS = 1_200;

async function copyText(doc: Document, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 兜底：临时 textarea + execCommand，不依赖 Clipboard API 权限
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.append(ta);
    ta.select();
    try {
      return doc.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/** 给容器内所有代码块（`pre.ra-code`）包一层并加「复制」按钮；就地修改 DOM，不产生新的 innerHTML 字符串 */
export function addCopyButtons(container: Element, doc: Document): void {
  for (const pre of [...container.querySelectorAll('pre.ra-code')]) {
    if (pre.parentElement?.classList.contains('ra-code-wrap')) continue; // 已处理过
    const wrap = doc.createElement('div');
    wrap.className = 'ra-code-wrap';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ra-code-copy';
    btn.textContent = '复制';
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    btn.addEventListener('click', () => {
      void copyText(doc, pre.textContent ?? '').then((ok) => {
        btn.textContent = ok ? '已复制' : '复制失败';
        if (resetTimer !== undefined) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.textContent = '复制';
        }, FEEDBACK_MS);
      });
    });
    wrap.append(btn);
  }
}
