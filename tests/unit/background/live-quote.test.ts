// live（contract-v1.5，D11/B5）：后台只在这个标签页有小窗/侧边栏订阅者时才让哨兵实时上报选中的文字；
// 订阅者数量跨越 0 时广播 live/toggle；没有订阅者时 selection/live 不生效（不信任内容脚本自己判断）。
import { describe, expect, it } from 'vitest';
import { click, liveSelection, makeHarness, readyFloat, TAB, until, WIN } from './harness';

describe('live：config/get 的 liveQuote', () => {
  it('没有订阅者时为假，小窗订阅后变真，收起后变回假', async () => {
    const h = makeHarness();
    const before = await h.message({ type: 'config/get' });
    expect((before as { liveQuote?: boolean }).liveQuote).toBe(false);

    const c = await readyFloat(h);
    const after = await h.message({ type: 'config/get' });
    expect((after as { liveQuote?: boolean }).liveQuote).toBe(true);

    c.close();
    const closed = await h.message({ type: 'config/get' });
    expect((closed as { liveQuote?: boolean }).liveQuote).toBe(false);
  });
});

describe('live：订阅者跨越 0 时广播 live/toggle', () => {
  it('小窗订阅后广播 enabled:true，断开后广播 enabled:false', async () => {
    const h = makeHarness();
    expect(h.broadcasts).toEqual([]);
    const c = await readyFloat(h);
    expect(h.broadcasts.at(-1)).toEqual({ tabId: TAB, msg: { type: 'live/toggle', enabled: true } });
    c.close();
    expect(h.broadcasts.at(-1)).toEqual({ tabId: TAB, msg: { type: 'live/toggle', enabled: false } });
  });

  it('侧边栏订阅同一标签页，小窗已经开着时不重复广播（只在 0→正数那一次）', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const n = h.broadcasts.length;
    const panel = h.connect(h.panelSender());
    panel.send({ type: 'conv/helloSidepanel', windowId: WIN });
    await until(() => panel.ofType('conv/ready').length > 0, '侧边栏握手');
    panel.send({ type: 'conv/subscribe', tabId: TAB });
    await until(() => panel.ofType('conv/snapshot').length > 0, '侧边栏订阅');
    expect(h.broadcasts.length).toBe(n); // 没有新的广播：小窗还在，订阅者数量一直是正数
    float.close();
    expect(h.broadcasts.length).toBe(n); // 小窗走了，侧边栏还订阅着，仍是正数
    panel.close();
    expect(h.broadcasts.at(-1)).toEqual({ tabId: TAB, msg: { type: 'live/toggle', enabled: false } });
  });
});

describe('live：selection/live 只在有订阅者时生效', () => {
  it('没有订阅者时发 selection/live：不存、不推 conv/quote', async () => {
    const h = makeHarness();
    const res = await h.message(liveSelection(1, '没人看着'));
    expect(res).toEqual({ ok: true });
    const c = await readyFloat(h);
    expect(c.ofType('conv/quote')).toEqual([]);
  });

  it('有订阅者时发 selection/live：换引用条（不开工具栏、不起任务）', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const before = c.received.length;
    await h.message(liveSelection(2, '实时选中的新文字'));
    await until(() => c.ofType('conv/quote').length > 0, 'conv/quote');
    const quote = c.ofType('conv/quote').at(-1);
    expect(quote).toMatchObject({ selectionRevision: 2, text: '实时选中的新文字', truncated: false });
    // 没有多发别的东西（没有开小窗指令、没有任务相关消息）
    expect(c.received.slice(before).every((m) => (m as { type: string }).type === 'conv/quote')).toBe(true);
  });
});

describe('live：后台发起的任务补上提问', () => {
  it('工具栏「解释」（没有问题文字）：conv/current 里这一轮的提问显示动作名', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click(1, 'explain'));
    await until(() => c.ofType('conv/current').length > 0, 'conv/current');
    expect(c.ofType('conv/current')[0]).toMatchObject({
      userMessage: { text: '解释', request: { actionId: 'explain' } },
    });
  });
});
