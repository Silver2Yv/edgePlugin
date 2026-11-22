// 子框架合并与级别判定（D10）：纯逻辑
import { describe, expect, it } from 'vitest';
import { contentVersionOf } from '@/core/context/content-version';
import {
  type FrameProbe,
  MIN_FRAME_SIZE,
  mergeFrameDocs,
  selectReadableFrames,
} from '@/core/context/frame-merge';
import type { Block, PageDoc } from '@/core/context/page-doc';
import { citationNumberOf } from '@/core/prompt/ask';

const blk = (
  id: string,
  text: string,
  frameId = 0,
  headingPath: string[] = [],
  kind: Block['kind'] = 'paragraph',
): Block => ({
  id,
  kind,
  text,
  headingPath,
  frameId,
});

function topDoc(blocks: Block[], title = '顶层'): PageDoc {
  return {
    contentVersion: contentVersionOf(title, blocks),
    title,
    blocks,
    notes: [{ kind: 'frameSkipped', detail: '2 个' }, { kind: 'tooLittleText' }],
    textLength: blocks.reduce((n, b) => n + [...b.text].length, 0),
    extractedAt: 1,
    pageKey: 'https://top.test/a',
    documentId: 'doc-top',
    url: 'https://top.test/a',
  };
}

const probe = (frameId: number, url: string, tooSmall = false): FrameProbe => ({ frameId, url, tooSmall });

describe('selectReadableFrames：框架级别取顶层与来源更严的一级', () => {
  const rules = [
    { host: 'blocked.test', level: 'noRead' as const },
    { host: 'toolbar.test', level: 'noToolbar' as const },
    { host: 'topblocked.test', level: 'noRead' as const },
  ];

  it('正常与「不弹工具栏」的框架读，「不读取」的不读并计数说明', () => {
    const r = selectReadableFrames(
      'https://top.test/',
      [
        probe(1, 'https://ok.test/'),
        probe(2, 'https://a.blocked.test/x'),
        probe(3, 'https://toolbar.test/y'),
      ],
      rules,
    );
    expect(r.readable.map((f) => f.frameId)).toEqual([1, 3]);
    expect(r.notes).toEqual([{ kind: 'frameSkipped', detail: '1 个内嵌页面按站点规则不读取' }]);
  });

  it('顶层在「不读取」名单：所有框架都不读（取更严）', () => {
    const r = selectReadableFrames('https://topblocked.test/', [probe(1, 'https://ok.test/')], rules);
    expect(r.readable).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });

  it('太小的框架跳过并说明；顶层（frameId 0）不在结果里', () => {
    const r = selectReadableFrames(
      'https://top.test/',
      [probe(0, 'https://top.test/'), probe(1, 'https://ok.test/', true), probe(2, 'https://ok.test/2')],
      rules,
    );
    expect(r.readable.map((f) => f.frameId)).toEqual([2]);
    expect(r.notes).toEqual([{ kind: 'frameSkipped', detail: '1 个内嵌页面太小或不可见，未读取' }]);
    expect(MIN_FRAME_SIZE).toBeGreaterThan(0);
  });

  it('没有子框架：什么都不说', () => {
    expect(selectReadableFrames('https://top.test/', [], rules)).toEqual({ readable: [], notes: [] });
  });
});

describe('mergeFrameDocs：整页唯一编号、子框架排在顶层后、指纹含子框架', () => {
  const top = topDoc([blk('b1', '顶层标题', 0, [], 'heading'), blk('b2', '顶层正文')]);
  const frame = (title: string, ...texts: string[]) => ({
    title,
    blocks: texts.map((t, i) => blk(`b${i + 1}`, t, 3, i === 0 ? [] : ['内嵌小节'])),
  });

  it('没有子框架内容也没有额外说明：原样返回', () => {
    expect(mergeFrameDocs(top, [])).toBe(top);
  });

  it('重新编号为 b<数字> 且唯一，编号按顺序对应引用编号；顶层块编号与原来一致', () => {
    const m = mergeFrameDocs(top, [frame('内嵌甲', '甲一', '甲二'), frame('内嵌乙', '乙一')]);
    expect(m.blocks.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
    expect(m.blocks.map((b) => citationNumberOf(b.id))).toEqual(['1', '2', '3', '4', '5']);
    expect(m.blocks.map((b) => b.text)).toEqual(['顶层标题', '顶层正文', '甲一', '甲二', '乙一']);
    expect(m.blocks.map((b) => b.frameId)).toEqual([0, 0, 3, 3, 3]);
  });

  it('子框架块的标题链前加「内嵌页面：标题」；没标题时写（无标题）', () => {
    const m = mergeFrameDocs(top, [frame('内嵌甲', '甲一', '甲二'), frame('  ', '乙一')]);
    expect(m.blocks[2]?.headingPath).toEqual(['内嵌页面：内嵌甲']);
    expect(m.blocks[3]?.headingPath).toEqual(['内嵌页面：内嵌甲', '内嵌小节']);
    expect(m.blocks[4]?.headingPath).toEqual(['内嵌页面：（无标题）']);
  });

  it('指纹按合并后的块重算：子框架内容变了指纹变，没变则不变；与顶层单独的指纹不同', () => {
    const a = mergeFrameDocs(top, [frame('内嵌', '甲一')]);
    const same = mergeFrameDocs(top, [frame('内嵌', '甲一')]);
    const changed = mergeFrameDocs(top, [frame('内嵌', '甲一（改）')]);
    expect(same.contentVersion).toBe(a.contentVersion);
    expect(changed.contentVersion).not.toBe(a.contentVersion);
    expect(a.contentVersion).not.toBe(top.contentVersion);
    expect(a.contentVersion).toBe(contentVersionOf(a.title, a.blocks));
  });

  it('字数含子框架；顶层笼统的「子框架没读」提示换成带原因的说明，其余提示保留', () => {
    const m = mergeFrameDocs(
      top,
      [frame('内嵌', '甲一')],
      [{ kind: 'frameSkipped', detail: '1 个内嵌页面太小' }],
    );
    expect(m.textLength).toBe([...'顶层标题顶层正文甲一'].length);
    expect(m.notes).toEqual([
      { kind: 'tooLittleText' },
      { kind: 'frameSkipped', detail: '1 个内嵌页面太小' },
    ]);
  });

  it('顶层正文很少、子框架补足后总字数够了：「页面正文很少」的提示去掉；仍不够则保留', () => {
    const big = frame('内嵌', '内'.repeat(250));
    expect(mergeFrameDocs(top, [big]).notes).toEqual([]);
    expect(mergeFrameDocs(top, [frame('内嵌', '甲一')]).notes).toEqual([{ kind: 'tooLittleText' }]);
  });

  it('不改传入的顶层文档', () => {
    const before = JSON.stringify(top);
    mergeFrameDocs(top, [frame('内嵌', '甲一')]);
    expect(JSON.stringify(top)).toBe(before);
  });
});
