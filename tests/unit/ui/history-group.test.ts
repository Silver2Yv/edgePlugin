// 历史分组（C5）的纯逻辑。
import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '@/core/domain/records';
import { groupHistory } from '@/ui/panel/history-group';

const conv = (id: string, pageKey: string | undefined, updatedAt: number): ConversationRecord => ({
  id,
  ...(pageKey === undefined ? {} : { pageKey }),
  title: id,
  model: { connectionId: 'c', model: 'm' },
  turns: 1,
  revision: 1,
  createdAt: updatedAt,
  updatedAt,
});

describe('groupHistory', () => {
  it('按页面分组：同一个 pageKey 的对话归一组，标题是主机名加路径', () => {
    const items = [
      conv('a', 'https://a.test/x', 3),
      conv('b', 'https://a.test/x', 2),
      conv('c', 'https://a.test/y', 1),
    ];
    const groups = groupHistory(items, 'page');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      key: 'https://a.test/x',
      label: 'a.test/x',
      items: [items[0], items[1]],
    });
    expect(groups[1]).toMatchObject({ key: 'https://a.test/y', label: 'a.test/y' });
  });

  it('按网站分组：不同路径但同主机归一组', () => {
    const items = [conv('a', 'https://a.test/x', 2), conv('b', 'https://a.test/y', 1)];
    const groups = groupHistory(items, 'host');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'a.test', label: 'a.test', items });
  });

  it('没有 pageKey（非 http(s) 页面）的对话单独归一组', () => {
    const items = [conv('a', undefined, 1)];
    expect(groupHistory(items, 'page')[0]?.label).toBe('（无法识别的页面）');
  });
});
