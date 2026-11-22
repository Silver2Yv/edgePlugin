// 子框架正文读取（D10，5.6）的纯逻辑：哪些框架读、读到的各框架块怎么并成一份页面模型。
// 后台负责注入与收消息（background/pages.ts），这里只做决定与合并，便于单测。
import { frameSiteLevel, SITE_MATRIX, type SiteRule } from '../domain/site-policy';
import { contentVersionOf } from './content-version';
import type { Block, PageDoc, PageNote } from './page-doc';

/** 子框架面积小于它（宽或高，CSS 像素）就不读：广告位、统计像素、被折叠成一条线的框架 */
export const MIN_FRAME_SIZE = 50;
/** 与抽取（page/extract.ts）判「正文很少」的字数一致 */
const TOO_LITTLE_TEXT = 200;

/** 后台对一个框架的探测结果：地址与尺寸取自框架自己的环境，框架编号与文档编号取自注入结果 */
export interface FrameProbe {
  frameId: number;
  url: string;
  tooSmall: boolean;
}

export interface FrameSelection {
  /** 要读的框架（不含顶层） */
  readable: FrameProbe[];
  /** 没读的框架及原因（D15/D16：给原因，不静默） */
  notes: PageNote[];
}

/**
 * 按站点矩阵（4.1）判断各子框架读不读：框架的级别取「顶层站点与框架来源」更严的一级，
 * 该级别不允许读页面内容（「不读取」）的跳过；太小的跳过。「不弹工具栏」一级照矩阵仍可读
 */
export function selectReadableFrames(
  topUrl: string | undefined,
  probes: readonly FrameProbe[],
  rules: readonly SiteRule[],
): FrameSelection {
  let blocked = 0;
  let small = 0;
  const readable: FrameProbe[] = [];
  for (const p of probes) {
    if (p.frameId === 0) continue;
    if (!SITE_MATRIX[frameSiteLevel(topUrl, p.url, rules)].readPageContent) blocked++;
    else if (p.tooSmall) small++;
    else readable.push(p);
  }
  const notes: PageNote[] = [];
  if (blocked > 0) notes.push({ kind: 'frameSkipped', detail: `${blocked} 个内嵌页面按站点规则不读取` });
  if (small > 0) notes.push({ kind: 'frameSkipped', detail: `${small} 个内嵌页面太小或不可见，未读取` });
  return { readable, notes };
}

/** 一个子框架读到的内容（块已按 sender 盖了 frameId） */
export interface FrameContent {
  title: string;
  blocks: readonly Block[];
}

/**
 * 合并顶层与子框架：子框架的块按给定顺序排在顶层块之后，整页重新编号为 b1…bN（引用编号只在一次发送的块集合里有效，
 * 编号取数字部分，所以必须整页唯一）；子框架块的标题链前加「内嵌页面：标题」。
 * 内容指纹按合并后的全部块重算，子框架内容变了页面指纹也变。各框架自带的「子框架没读」笼统提示去掉，
 * 换成 extraNotes 里带原因的提示；字数按码点算（与抽取一致）
 */
export function mergeFrameDocs(
  top: PageDoc,
  frames: readonly FrameContent[],
  extraNotes: readonly PageNote[] = [],
): PageDoc {
  if (frames.length === 0 && extraNotes.length === 0) return top;
  const blocks: Block[] = [];
  for (const b of top.blocks) blocks.push({ ...b, id: `b${blocks.length + 1}` });
  for (const f of frames) {
    const lead = `内嵌页面：${f.title.trim().slice(0, 200) || '（无标题）'}`;
    for (const b of f.blocks)
      blocks.push({ ...b, id: `b${blocks.length + 1}`, headingPath: [lead, ...b.headingPath].slice(0, 12) });
  }
  const textLength = blocks.reduce((n, b) => n + [...b.text].length, 0);
  // 顶层自己正文很少、但子框架里有内容时，「页面正文很少」的提示不再成立（页面本身就是个壳，D10）
  const notes = [
    ...top.notes.filter(
      (n) => n.kind !== 'frameSkipped' && !(n.kind === 'tooLittleText' && textLength >= TOO_LITTLE_TEXT),
    ),
    ...extraNotes,
  ];
  return { ...top, blocks, notes, textLength, contentVersion: contentVersionOf(top.title, blocks) };
}
