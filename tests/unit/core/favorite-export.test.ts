// 收藏导出的纯函数（G2、G6）：原文、笔记、来源链接、时间、回答各自分开，可独立断言。
import { describe, expect, it } from 'vitest';
import { favoriteMarkdown, favoritesMarkdown, favoriteTitle } from '@/core/domain/favorite-export';
import type { FavoriteRecord } from '@/core/domain/records';

const BASE: FavoriteRecord = {
  id: 'fav-00000001',
  pageKey: 'https://example.test/article',
  url: 'https://example.test/article',
  selection: '光合作用把光能转成化学能。',
  sourceText: '前文光合作用把光能转成化学能。后文',
  blobIds: [],
  createdAt: Date.UTC(2026, 10, 22, 9, 30),
};

describe('favoriteTitle', () => {
  it('用户编辑过标题优先；没有就用选中文字开头，超长截断', () => {
    expect(favoriteTitle({ ...BASE, title: '我的标题' })).toBe('我的标题');
    expect(favoriteTitle(BASE)).toBe('光合作用把光能转成化学能。');
    const long = { ...BASE, selection: 'x'.repeat(50) };
    expect(favoriteTitle(long)).toHaveLength(40);
    expect(favoriteTitle(long).endsWith('…')).toBe(true);
  });

  it('选中文字为空时给出占位', () => {
    expect(favoriteTitle({ ...BASE, selection: '   ' })).toBe('（无标题）');
  });
});

describe('favoriteMarkdown', () => {
  it('工具栏存（无回答、无笔记）：标题、来源、时间、原文，不含回答/笔记小节', () => {
    const md = favoriteMarkdown(BASE);
    expect(md).toContain('## 光合作用把光能转成化学能。');
    expect(md).toContain('- 来源：https://example.test/article');
    expect(md).toContain('### 原文');
    expect(md).toContain('前文光合作用把光能转成化学能。后文');
    expect(md).not.toContain('### 回答');
    expect(md).not.toContain('### 笔记');
  });

  it('回答上的存：原文、回答、笔记分段独立', () => {
    const fav: FavoriteRecord = {
      ...BASE,
      answer: '这是模型的回答正文。',
      note: '我自己的笔记',
      source: { conversationId: 'conv-1', messageId: 'msg-1' },
    };
    const md = favoriteMarkdown(fav);
    const sections = md.split(/\n### /);
    expect(sections.some((s) => s.startsWith('原文\n\n前文光合作用把光能转成化学能。后文'))).toBe(true);
    expect(sections.some((s) => s.startsWith('回答\n\n这是模型的回答正文。'))).toBe(true);
    expect(sections.some((s) => s.startsWith('笔记\n\n我自己的笔记'))).toBe(true);
  });

  it('没有原文快照时退回选中文字', () => {
    const md = favoriteMarkdown({ ...BASE, sourceText: '' });
    expect(md).toContain('光合作用把光能转成化学能。');
  });
});

describe('favoritesMarkdown', () => {
  it('多条收藏用分隔线隔开', () => {
    const a = { ...BASE, id: 'fav-a', selection: '第一条' };
    const b = { ...BASE, id: 'fav-b', selection: '第二条' };
    const md = favoritesMarkdown([a, b]);
    expect(md.split('\n\n---\n\n')).toHaveLength(2);
    expect(md).toContain('第一条');
    expect(md).toContain('第二条');
  });

  it('空数组给空字符串', () => {
    expect(favoritesMarkdown([])).toBe('');
  });
});
