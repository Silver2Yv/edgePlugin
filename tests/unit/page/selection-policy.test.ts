// @vitest-environment happy-dom
// SelectionPolicy（5.2、M6）：工具栏、右键、快捷键、降级抽取、诊断统一走这里判断是否弹出、是否代码。
import { describe, expect, it } from 'vitest';
import { evaluateSelection, lastLineRect } from '@/page/selection-policy';

function selectNodeContents(html: string, elementId: string): Selection {
  document.body.innerHTML = html;
  const el = document.getElementById(elementId) as Element;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe('evaluateSelection', () => {
  it('普通段落选区：弹出，不是代码', () => {
    const sel = selectNodeContents('<p id="t">hello world</p>', 't');
    expect(evaluateSelection(sel)).toEqual({ show: true, text: 'hello world', inCode: false });
  });

  it('选区折叠（没有选中内容）：不弹', () => {
    document.body.innerHTML = '<p id="t">hello</p>';
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    expect(evaluateSelection(sel)).toEqual({ show: false, text: '', inCode: false });
  });

  it('选区全是空白：不弹', () => {
    const sel = selectNodeContents('<p id="t">   </p>', 't');
    expect(evaluateSelection(sel)).toEqual({ show: false, text: '', inCode: false });
  });

  it('null 选区：不弹', () => {
    expect(evaluateSelection(null)).toEqual({ show: false, text: '', inCode: false });
  });

  it('选区在 textarea 里：不弹（M6 不读表单输入）', () => {
    const sel = selectNodeContents('<textarea id="t">hello</textarea>', 't');
    expect(evaluateSelection(sel)).toEqual({ show: false, text: '', inCode: false });
  });

  it('选区在 contenteditable 里：不弹', () => {
    const sel = selectNodeContents('<div id="t" contenteditable="true">hello</div>', 't');
    expect(evaluateSelection(sel)).toEqual({ show: false, text: '', inCode: false });
  });

  it('选区整个在 pre/code 里：弹出且 inCode 为真（A6）', () => {
    const sel = selectNodeContents('<pre id="t"><code>const x = 1;</code></pre>', 't');
    expect(evaluateSelection(sel)).toEqual({ show: true, text: 'const x = 1;', inCode: true });
  });

  it('选区横跨代码块与普通文字：弹出但 inCode 为假', () => {
    document.body.innerHTML = '<pre><code id="code">abc</code></pre><p id="p2">xyz</p>';
    const codeText = (document.getElementById('code') as Element).firstChild as Text;
    const pText = (document.getElementById('p2') as Element).firstChild as Text;
    const sel = window.getSelection() as Selection;
    sel.setBaseAndExtent(codeText, 0, pText, 3);
    const decision = evaluateSelection(sel);
    expect(decision.show).toBe(true);
    expect(decision.inCode).toBe(false);
  });
});

describe('lastLineRect', () => {
  it('选区没有 range 时返回 null', () => {
    expect(lastLineRect({ rangeCount: 0 } as Selection)).toBeNull();
  });
});
