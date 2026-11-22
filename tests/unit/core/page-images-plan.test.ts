// 页面图片进装配与发送说明（E2、规则 8）：图片作为本轮用户消息的图片部分、imageCount 含截图与页面图片、
// 地址只进计划（不进发给模型的正文）；发送说明展开后列出地址（过长截断）；设置默认关、旧设置自动补默认。
import { describe, expect, it } from 'vitest';
import { defaultBudget } from '@/core/context/plan';
import { DEFAULT_SETTINGS, migrateSettings } from '@/core/domain/settings';
import { type AskInput, assembleAsk, pageImageLead } from '@/core/prompt/ask';
import { sendSummary, shortUrl } from '@/ui/float/send-summary';

const base: AskInput = {
  question: '这张图说明什么？',
  selection: { text: '图 1 所示', truncated: false, originalLength: 5 },
  history: [],
  lengthTier: 'normal',
  language: 'zh',
  thinking: 'off',
  requestedContextTier: 'selection',
  model: { connectionId: 'conn-test-0001', model: 'mock-flash' },
  contextSnapshotId: 'snap-00000001',
  budget: defaultBudget(),
  actionId: 'ask',
};
const P1 = { url: 'https://img.test/a.png', dataUrl: 'data:image/png;base64,AAAA' };
const P2 = { url: 'https://img.test/b.png', dataUrl: 'data:image/png;base64,BBBB' };

describe('装配', () => {
  it('页面图片排在文字前；截图在页面图片前；imageCount 为总数；地址只在计划里', () => {
    const a = assembleAsk({
      ...base,
      image: { dataUrl: 'data:image/png;base64,SHOT' },
      pageImages: [P1, P2],
    });
    const content = a.messages.at(-1)?.content ?? [];
    expect(content.slice(0, 3)).toEqual([
      { kind: 'image', dataUrl: 'data:image/png;base64,SHOT' },
      { kind: 'image', dataUrl: P1.dataUrl },
      { kind: 'image', dataUrl: P2.dataUrl },
    ]);
    expect(a.plan.imageCount).toBe(3);
    expect(a.plan.pageImageUrls).toEqual([P1.url, P2.url]);
    expect(a.userText).toContain(pageImageLead(2));
    expect(a.userText).not.toContain('img.test');
  });

  it('没有页面图片：与以前完全一致（纯文字消息，没有 pageImageUrls）', () => {
    const a = assembleAsk(base);
    expect(a.messages.at(-1)?.content).toEqual([{ kind: 'text', text: a.userText }]);
    expect(a.plan.imageCount).toBe(0);
    expect(a.plan.pageImageUrls).toBeUndefined();
    expect(a.userText).not.toContain('配图');
  });
});

describe('发送说明', () => {
  it('一行里写附图张数，展开明细里列出每个地址；过长的地址截断', () => {
    const long = `https://img.test/${'x'.repeat(300)}.png`;
    const a = assembleAsk({ ...base, pageImages: [P1, { url: long, dataUrl: P2.dataUrl }] });
    const s = sendSummary(a.plan, 5);
    expect(s.parts).toContain('附图 2 张');
    expect(s.details).toContain(P1.url);
    const shown = s.details.find((d) => d.startsWith('https://img.test/xxx'));
    expect(shown?.endsWith('…')).toBe(true);
    expect([...(shown ?? '')].length).toBeLessThan(long.length);
    expect(shortUrl(P1.url)).toBe(P1.url);
  });

  it('没有页面图片：明细里没有地址说明', () => {
    const s = sendSummary(assembleAsk(base).plan, 5);
    expect(s.details.join()).not.toContain('网页图片');
  });
});

describe('设置', () => {
  it('默认关；旧设置里没有这一项时补默认值（不需要升版本）；类型不对按损坏处理', () => {
    expect(DEFAULT_SETTINGS.context.includePageImages).toBe(false);
    const { includePageImages: _x, ...oldContext } = DEFAULT_SETTINGS.context;
    const r = migrateSettings({ ...structuredClone(DEFAULT_SETTINGS), context: oldContext });
    expect(r.ok && r.settings.context.includePageImages).toBe(false);
    const on = migrateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      context: { ...DEFAULT_SETTINGS.context, includePageImages: true },
    });
    expect(on.ok && on.settings.context.includePageImages).toBe(true);
    const bad = migrateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      context: { ...DEFAULT_SETTINGS.context, includePageImages: 'yes' },
    });
    expect(bad.ok).toBe(false);
  });
});
