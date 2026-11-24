// @vitest-environment happy-dom
// 多编号引用循环跳转（决策 097）与回到某一页的界面状态（决策 098，useCite 的 jump / jump/result）。
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundToClient, ClientToBackground } from '@/core/domain/messages';
import { cycleStep } from '@/ui/cite/cycle';
import { type CiteDeps, citeNoteText, useCite } from '@/ui/cite/useCite';

describe('cycleStep：同一处点一次跳下一个编号', () => {
  const mark = (ids: string[], slot = 0, messageId = 'm1') => ({ messageId, slot, ids });

  it('第一次跳第一个，再点同一处跳下一个，最后一个之后回到第一个', () => {
    let prev: ReturnType<typeof cycleStep>;
    const seen: [string, number, number][] = [];
    for (let i = 0; i < 4; i++) {
      prev = cycleStep(prev?.next ?? null, mark(['12', '5', '7']));
      seen.push([prev?.citation ?? '', prev?.index ?? 0, prev?.total ?? 0]);
    }
    expect(seen).toEqual([
      ['12', 1, 3],
      ['5', 2, 3],
      ['7', 3, 3],
      ['12', 1, 3],
    ]);
  });

  it('点了别处（另一个标记、另一条消息）从头开始；单编号不记状态也不标「第几处」', () => {
    const a = cycleStep(null, mark(['1', '2'], 0));
    const b = cycleStep(a?.next ?? null, mark(['1', '2'], 1));
    expect(b).toMatchObject({ citation: '1', index: 1 });
    const c = cycleStep(b?.next ?? null, mark(['1', '2'], 1, 'm2'));
    expect(c).toMatchObject({ citation: '1', index: 1 });
    const single = cycleStep(null, mark(['9']));
    expect(single).toEqual({ citation: '9', index: 1, total: 1, next: null });
    expect(cycleStep(null, mark([]))).toBeUndefined();
  });
});

type Api = ReturnType<typeof useCite>;

/** 把 useCite 挂进一个空组件，返回最新的接口（每次渲染换新的 cite 状态） */
async function mount(deps: CiteDeps, resetKey: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const out = { api: undefined as unknown as Api };
  const Probe = ({ k }: { k: string }) => {
    out.api = useCite(deps, k);
    return null;
  };
  await act(() => render(h(Probe, { k: resetKey }), root));
  const rerender = (k: string) => act(() => render(h(Probe, { k }), root));
  return { out, rerender, unmount: () => render(null, root) };
}

const posted = (post: ReturnType<typeof vi.fn>) => post.mock.calls.map((c) => c[0] as ClientToBackground);
const located = (requestId: string): BackgroundToClient => ({
  type: 'citation/located',
  requestId,
  level: 'exact',
});

describe('useCite：多编号循环', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('连点同一处依次发 12、5、7、12，提示写明第几处；换一处或换标签页后重新开始', async () => {
    const post = vi.fn();
    const { out, rerender } = await mount({ post, canSendNow: () => true, wake: () => undefined }, 'tab1:');
    const click = { citation: '12', ids: ['12', '5', '7'], slot: 0 };
    const cited: string[] = [];
    for (let i = 0; i < 4; i++) {
      await act(() => out.api.locate('m1', click));
      const msg = posted(post).at(-1) as Extract<ClientToBackground, { type: 'citation/locate' }>;
      cited.push(msg.citation);
      expect(out.api.cite).toMatchObject({ pending: true, position: { index: (i % 3) + 1, total: 3 } });
      await act(() => out.api.onMessage(located(msg.requestId)));
      expect(citeNoteText(out.api.cite as NonNullable<typeof out.api.cite>)).toBe(
        `第 ${(i % 3) + 1} / 3 处：已跳到原文，网页上高亮的就是这段`,
      );
    }
    expect(cited).toEqual(['12', '5', '7', '12']);

    // 点另一处（slot 不同）：从第一个开始
    await act(() => out.api.locate('m1', { citation: '5', ids: ['5', '6'], slot: 1 }));
    expect((posted(post).at(-1) as { citation: string }).citation).toBe('5');
    expect(out.api.cite?.position).toEqual({ index: 1, total: 2 });
    // 再点第一处也从头
    await act(() => out.api.locate('m1', click));
    expect((posted(post).at(-1) as { citation: string }).citation).toBe('12');
    // 换了标签页：重新开始
    await act(() => out.api.locate('m1', click));
    expect((posted(post).at(-1) as { citation: string }).citation).toBe('5');
    await rerender('tab2:');
    await act(() => out.api.locate('m1', click));
    expect((posted(post).at(-1) as { citation: string }).citation).toBe('12');
  });

  it('单编号引用：不带「第几处」', async () => {
    const post = vi.fn();
    const { out } = await mount({ post, canSendNow: () => true, wake: () => undefined }, 'tab1:');
    await act(() => out.api.locate('m1', { citation: '3', quote: '红光' }));
    expect(out.api.cite?.position).toBeUndefined();
    expect(posted(post).at(-1)).toMatchObject({ type: 'citation/locate', citation: '3', quote: '红光' });
  });
});

describe('useCite：回到某一页（决策 098）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  const result = (requestId: string, extra: Record<string, unknown> = {}): BackgroundToClient =>
    ({ type: 'jump/result', requestId, ok: true, tabId: 9, opened: 'new', ...extra }) as BackgroundToClient;

  it('页面的对话：发 jump/open（只带 pageKey），到了就清掉提示并交出标签页与对话；换订阅引起的重置不清掉进行中的提示', async () => {
    const post = vi.fn();
    const onJumped = vi.fn();
    const { out, rerender } = await mount(
      { post, canSendNow: () => true, wake: () => undefined, onJumped },
      '5:',
    );
    await act(() => out.api.jump({ pageKey: 'https://a.test/p' }, { conversationId: 'conv-1' }));
    const msg = posted(post).at(-1) as Extract<ClientToBackground, { type: 'jump/open' }>;
    expect(msg).toMatchObject({ type: 'jump/open', pageKey: 'https://a.test/p' });
    expect(msg).not.toHaveProperty('favoriteId');
    expect(citeNoteText(out.api.cite as NonNullable<typeof out.api.cite>)).toBe('正在打开页面…');
    // 标签页切过去引起面板换订阅：进行中的提示还在
    await rerender('9:');
    expect(out.api.cite?.pending).toBe(true);
    await act(() => out.api.onMessage(result(msg.requestId)));
    expect(onJumped).toHaveBeenCalledWith(9, { conversationId: 'conv-1' });
    expect(out.api.cite).toBeNull();
  });

  it('收藏回原文：带定位结果说明；降级、失败原因照常显示；到达后短时间内到达的标签页的重置不清掉说明，之后正常清', async () => {
    const post = vi.fn();
    const onJumped = vi.fn();
    const { out, rerender } = await mount(
      { post, canSendNow: () => true, wake: () => undefined, onJumped },
      '5:',
    );
    await act(() => out.api.jump({ favoriteId: 'fav-1' }));
    const id = (posted(post).at(-1) as { requestId: string }).requestId;
    await act(() => out.api.onMessage(result(id, { level: 'fuzzy', back: true })));
    expect(onJumped).toHaveBeenCalledWith(9, {});
    expect(out.api.cite).toMatchObject({ level: 'fuzzy', back: true });
    await rerender('9:');
    expect(out.api.cite).not.toBeNull();
    await rerender('9:job-1');
    expect(out.api.cite).not.toBeNull();
    // 别的标签页：清掉
    await rerender('3:');
    expect(out.api.cite).toBeNull();
  });

  it('没到：显示原因且不交出标签页；站点不读取、没有锚点各有说法；只有来源对话（quiet）时不报没有锚点', async () => {
    const post = vi.fn();
    const onJumped = vi.fn();
    const { out } = await mount({ post, canSendNow: () => true, wake: () => undefined, onJumped }, '5:');
    await act(() => out.api.jump({ favoriteId: 'fav-1' }));
    let id = (posted(post).at(-1) as { requestId: string }).requestId;
    await act(() =>
      out.api.onMessage({ type: 'jump/result', requestId: id, ok: false, reason: 'loadTimeout' }),
    );
    expect(onJumped).not.toHaveBeenCalled();
    expect(citeNoteText(out.api.cite as NonNullable<typeof out.api.cite>)).toBe(
      '页面加载超时，没有定位；页面打开后可以再点一次',
    );

    await act(() => out.api.jump({ favoriteId: 'fav-2' }));
    id = (posted(post).at(-1) as { requestId: string }).requestId;
    await act(() => out.api.onMessage(result(id, { reason: 'noAnchor' })));
    expect(out.api.cite).toMatchObject({ level: 'none', reason: 'noAnchor' });

    await act(() => out.api.jump({ favoriteId: 'fav-3' }, { conversationId: 'conv-2', quiet: true }));
    id = (posted(post).at(-1) as { requestId: string }).requestId;
    await act(() => out.api.onMessage(result(id, { reason: 'noAnchor' })));
    expect(onJumped).toHaveBeenLastCalledWith(9, { conversationId: 'conv-2', quiet: true });
    expect(out.api.cite).toBeNull();
  });

  it('连接没就绪先存着，订阅完成后 flush 才发；被后台拒绝显示无法打开', async () => {
    const post = vi.fn();
    const wake = vi.fn();
    let ready = false;
    const { out } = await mount({ post, canSendNow: () => ready, wake }, '5:');
    await act(() => out.api.jump({ favoriteId: 'fav-1' }));
    expect(post).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalled();
    ready = true;
    out.api.flush();
    const msg = posted(post).at(-1) as Extract<ClientToBackground, { type: 'jump/open' }>;
    expect(msg).toMatchObject({ type: 'jump/open', favoriteId: 'fav-1' });
    await act(() =>
      out.api.onMessage({
        type: 'conv/rejected',
        reason: 'notAllowed',
        refType: 'jump/open',
        refId: msg.requestId,
      }),
    );
    expect(out.api.cite).toMatchObject({ level: 'none', reason: 'unavailable' });
  });
});
