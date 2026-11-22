// 工具栏按钮排布与长选区确认的纯逻辑（A2、A6、A7），不碰 DOM。
import { describe, expect, it } from 'vitest';
import { LONG_SELECTION_CHARS } from '@/core/domain/actions';
import { arrangeToolbar, needsLongConfirm } from '@/page/toolbar';

const action = (
  id: string,
  over: Partial<{ kind: 'model' | 'save'; needsInput: boolean; scope: 'selection' | 'page' }> = {},
) => ({
  id: id as never,
  label: id,
  kind: 'model' as const,
  needsInput: false,
  scope: 'selection' as const,
  ...over,
});

describe('arrangeToolbar', () => {
  it('不超过 TOOLBAR_MAX 个且不在代码里：原样显示，不进更多', () => {
    const actions = [
      action('ask', { needsInput: true }),
      action('explain'),
      action('save', { kind: 'save' }),
    ];
    expect(arrangeToolbar(actions, false)).toEqual({ shown: actions, overflow: [] });
  });

  it('选区在代码里：第一个按钮换成「解释代码」，不管原来是什么', () => {
    const actions = [action('ask', { needsInput: true }), action('explain')];
    const { shown } = arrangeToolbar(actions, true);
    expect(shown[0]).toMatchObject({ id: 'explainCode', label: '解释代码' });
    expect(shown[1]).toMatchObject({ id: 'explain' });
  });

  it('选区在代码里且列表本身已有「解释代码」：不重复出现', () => {
    const actions = [action('ask', { needsInput: true }), action('explainCode')];
    const { shown, overflow } = arrangeToolbar(actions, true);
    expect(shown.filter((a) => a.id === 'explainCode')).toHaveLength(1);
    expect(overflow).toEqual([]);
  });

  it('超过 TOOLBAR_MAX 个：多出的收进 overflow，留一个位置给「更多」', () => {
    const actions = Array.from({ length: 7 }, (_, i) => action(`custom:${i}aaaaaaa`));
    const { shown, overflow } = arrangeToolbar(actions, false);
    expect(shown).toHaveLength(4); // TOOLBAR_MAX(5) - 1 个「更多」占位
    expect(overflow).toHaveLength(3);
  });
});

describe('needsLongConfirm', () => {
  it('选区类、发给模型的动作，超过阈值才需要确认', () => {
    expect(needsLongConfirm(action('explain'), LONG_SELECTION_CHARS + 1)).toBe(true);
    expect(needsLongConfirm(action('explain'), LONG_SELECTION_CHARS)).toBe(false);
  });

  it('「存」（kind 为 save）不需要确认，不管多长', () => {
    expect(needsLongConfirm(action('save', { kind: 'save' }), LONG_SELECTION_CHARS + 1)).toBe(false);
  });

  it('整页类动作（scope 为 page）不需要确认', () => {
    expect(needsLongConfirm(action('summarizePage', { scope: 'page' }), LONG_SELECTION_CHARS + 1)).toBe(
      false,
    );
  });
});
