// @vitest-environment happy-dom
// 用户选区保护单测（5.10：“用户正在选中的块延迟替换，直到选区离开…”）。
//
// happy-dom 21.0.4 未实现真实的 Selection / Range API（没有 intersectsNode、也不会派发
// selectionchange），所以这里不依赖浏览器原生选区：
// - selection-guard.ts 的协调逻辑通过注入的 intersects/subscribe 来控制；
// - mount.ts 的 DOM 增量挂载通过注入一个可控的 SelectionGuard 来验证“替换被延后、
//   选区离开后才补上”，不触碰真实 Selection。
// 真机下的选区/滚动/焦点行为由 tests/e2e/markdown.spec.ts 用真实鼠标验证。
import { describe, expect, it, vi } from 'vitest';
import { createAnswerRenderer, createSelectionGuard, type SelectionGuard } from '@/ui/render';

describe('createSelectionGuard：协调逻辑（注入 intersects/subscribe，不依赖真实 Selection）', () => {
  it('旧节点被选中时：protect 返回 true，不立即执行 apply', () => {
    const node = document.createElement('div');
    const guard = createSelectionGuard(document, { intersects: () => true, subscribe: () => () => {} });
    const apply = vi.fn();
    const protected_ = guard.protect(1, node, apply);
    expect(protected_).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it('旧节点未被选中时：protect 返回 false，不代为执行 apply（由调用方自己立即替换）', () => {
    const node = document.createElement('div');
    const guard = createSelectionGuard(document, { intersects: () => false, subscribe: () => () => {} });
    const apply = vi.fn();
    const protected_ = guard.protect(1, node, apply);
    expect(protected_).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('选区离开后（intersects 变为 false）：下次选区变化通知时补上 apply', () => {
    let selected = true;
    let onChange: (() => void) | undefined;
    const guard = createSelectionGuard(document, {
      intersects: () => selected,
      subscribe: (cb) => {
        onChange = cb;
        return () => {
          onChange = undefined;
        };
      },
    });
    const node = document.createElement('div');
    const apply = vi.fn();
    expect(guard.protect(1, node, apply)).toBe(true);

    onChange?.(); // 选区仍覆盖该节点：不触发
    expect(apply).not.toHaveBeenCalled();

    selected = false;
    onChange?.(); // 选区离开：这次通知里补上
    expect(apply).toHaveBeenCalledTimes(1);

    onChange?.(); // 已经执行过，不会重复触发
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('forget：丢弃某个 key 的待替换记录，不执行 apply', () => {
    let onChange: (() => void) | undefined;
    const guard = createSelectionGuard(document, {
      intersects: () => true,
      subscribe: (cb) => {
        onChange = cb;
        return () => {};
      },
    });
    const node = document.createElement('div');
    const apply = vi.fn();
    guard.protect(1, node, apply);
    guard.forget(1);
    onChange?.();
    expect(apply).not.toHaveBeenCalled();
  });

  it('clear：丢弃全部待替换记录，不执行它们（整体重置场景）', () => {
    let onChange: (() => void) | undefined;
    const guard = createSelectionGuard(document, {
      intersects: () => true,
      subscribe: (cb) => {
        onChange = cb;
        return () => {};
      },
    });
    const apply1 = vi.fn();
    const apply2 = vi.fn();
    guard.protect(1, document.createElement('div'), apply1);
    guard.protect(2, document.createElement('div'), apply2);
    guard.clear();
    onChange?.();
    expect(apply1).not.toHaveBeenCalled();
    expect(apply2).not.toHaveBeenCalled();
  });

  it('destroy：取消订阅，之后触发的 onChange 不会再影响 guard', () => {
    let onChange: (() => void) | undefined;
    let unsubscribed = false;
    const guard = createSelectionGuard(document, {
      intersects: () => false,
      subscribe: (cb) => {
        onChange = cb;
        return () => {
          unsubscribed = true;
        };
      },
    });
    guard.destroy();
    expect(unsubscribed).toBe(true);
    expect(() => onChange?.()).not.toThrow();
  });
});

/** 构造一个可由测试完全手动控制的 SelectionGuard：protectAlways 为真时模拟“旧节点被选中”。 */
function createManualGuard(): {
  guard: SelectionGuard;
  setProtected: (v: boolean) => void;
  replay: () => void;
} {
  let shouldProtect = false;
  const pending = new Map<number, () => void>();
  const guard: SelectionGuard = {
    protect: (key, _node, apply) => {
      if (shouldProtect) {
        pending.set(key, apply);
        return true;
      }
      pending.delete(key);
      return false;
    },
    forget: (key) => pending.delete(key),
    clear: () => pending.clear(),
    destroy: () => pending.clear(),
  };
  return {
    guard,
    setProtected: (v) => {
      shouldProtect = v;
    },
    replay: () => {
      for (const [key, apply] of [...pending]) {
        pending.delete(key);
        apply();
      }
    },
  };
}

describe('createAnswerRenderer + 注入的 SelectionGuard：DOM 增量挂载的选区保护', () => {
  it('finalize 校正一个块时，若该块被选中：旧节点留在容器里，不被替换；选区离开后补上新节点', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { guard, setProtected, replay } = createManualGuard();
    const renderer = createAnswerRenderer(container, { guard });

    // 第一轮：两段文本，先各自渲染一次（无需保护）
    renderer.finalize('第一段。\n\n第二段。', new Set());
    const firstBlockBefore = container.children[0];
    expect(firstBlockBefore?.textContent?.trim()).toBe('第一段。');
    expect(container.children.length).toBe(2);

    // 第二轮：第一段内容变化（模拟后置引用定义之类的校正），但此刻“选区覆盖着第一块”
    setProtected(true);
    renderer.finalize('第一段改过。\n\n第二段。', new Set());
    // 被保护：容器里第一块的节点引用不变，内容仍是旧文本
    expect(container.children[0]).toBe(firstBlockBefore);
    expect(container.children[0]?.textContent?.trim()).toBe('第一段。');

    // 选区离开，guard 补上被延后的替换
    setProtected(false);
    replay();
    expect(container.children[0]).not.toBe(firstBlockBefore);
    expect(container.children[0]?.textContent?.trim()).toBe('第一段改过。');
    expect(container.children.length).toBe(2);

    renderer.destroy();
    container.remove();
  });

  it('未被选中的块正常替换，不经过保护', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { guard } = createManualGuard(); // 默认不保护
    const renderer = createAnswerRenderer(container, { guard });

    renderer.finalize('第一段。', new Set());
    const before = container.children[0];
    renderer.finalize('第一段改过。', new Set());
    expect(container.children[0]).not.toBe(before);
    expect(container.children[0]?.textContent?.trim()).toBe('第一段改过。');

    renderer.destroy();
    container.remove();
  });

  it('reset：不经过选区保护，直接清空容器（新问题/新尝试整体重置）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { guard, setProtected } = createManualGuard();
    const renderer = createAnswerRenderer(container, { guard });

    renderer.finalize('旧的回答。', new Set());
    expect(container.children.length).toBe(1);

    setProtected(true); // 即便“选中”着，reset 也应整体清空
    renderer.reset();
    expect(container.children.length).toBe(0);

    renderer.destroy();
    container.remove();
  });
});
