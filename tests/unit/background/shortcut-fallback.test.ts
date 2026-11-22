// 「打开小窗」快捷键在注入不了阅读器的网页上（安装前就开着、补注入没成功，或扩展商店这类页面，L5）：
// 网页上没法提示，记成这次失败；再按一次快捷键就同步改开侧边栏，侧边栏顶部说明原因（5.2 偶发失败的口径）。
import { describe, expect, it, vi } from 'vitest';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import { makeHarness, TAB, until, WIN } from './harness';

const tab = { id: TAB, windowId: WIN, url: 'https://example.test/article' };

describe('快捷键打开小窗失败后的退路（L5）', () => {
  it('注入失败：第一次不开侧边栏，记成偶发失败；第二次同步打开侧边栏并带上原因，之后恢复先试小窗', async () => {
    const h = makeHarness();
    vi.mocked(h.deps.injectReader).mockRejectedValue(new Error('Cannot access contents of the page'));

    h.app.onCommand('open-float', tab);
    expect(h.panel.opens).toEqual([]);
    await until(() => h.session.data.get(SESSION_KEYS.float(TAB)) === 'failedTransient', '记下失败');
    expect(h.logs.some((l) => l.event === 'float/showFailed')).toBe(true);
    expect(h.sent).toEqual([]);

    h.app.onCommand('open-float', tab);
    // open 在命令处理的同步段里发出（规则 10）
    expect(h.panel.opens).toEqual([WIN]);
    await until(() => h.session.data.get(SESSION_KEYS.float(TAB)) === 'unknown', '偶发失败只算一次');

    // 侧边栏订阅这个标签页时拿到原因
    const c = h.connect(h.panelSender());
    c.send({ type: 'conv/helloSidepanel', windowId: WIN });
    await until(() => c.ofType('conv/ready').length > 0, '握手');
    c.send({ type: 'conv/subscribe', tabId: TAB });
    await until(() => c.ofType('conv/snapshot').length > 0, '订阅');
    expect(c.ofType('conv/notice')).toEqual([{ type: 'conv/notice', kind: 'floatTransient' }]);
  });

  it('注入成功：照常显示小窗，不动就绪状态', async () => {
    const h = makeHarness();
    h.app.onCommand('open-float', tab);
    await until(() => h.sent.some((s) => s.msg.type === 'float/show'), '显示小窗');
    expect(h.panel.opens).toEqual([]);
    expect(h.session.data.has(SESSION_KEYS.float(TAB))).toBe(false);
  });
});
