// 多编号引用的循环跳转（决策 097）：一处标了【12,5】，第一次点跳第一个编号，再点同一处跳下一个，
// 到最后一个之后回到第一个。纯逻辑，useCite 用它决定这一次点哪个编号。

/** 上一次点的是哪一处、跳到了第几个（从 0 数） */
export interface CycleState {
  key: string;
  index: number;
}

/** 回答里被点的那一处引用：消息、它在回答里是第几个引用标记（slot）、标记里的全部编号 */
export interface ClickedMark {
  messageId: string;
  slot: number | undefined;
  ids: readonly string[];
}

export interface CycleStep {
  /** 这一次要跳的编号 */
  citation: string;
  /** 第几个（从 1 数）/ 共几个；只有一个编号时 total 为 1，界面不显示「第 x / y 处」 */
  index: number;
  total: number;
  /** 记下来供下一次点同一处时用；单编号的引用不需要记 */
  next: CycleState | null;
}

/** 同一处 = 同一条消息里的同一个引用标记（位置与编号都一致） */
const keyOf = (m: ClickedMark): string => `${m.messageId}|${m.slot ?? ''}|${m.ids.join(',')}`;

/** 点了一处引用：给出这一次跳哪个编号。prev 是上一次的记录（点了别处会被换掉） */
export function cycleStep(prev: CycleState | null, m: ClickedMark): CycleStep | undefined {
  const total = m.ids.length;
  const first = m.ids[0];
  if (first === undefined) return undefined;
  if (total === 1) return { citation: first, index: 1, total: 1, next: null };
  const key = keyOf(m);
  const at = prev?.key === key ? (prev.index + 1) % total : 0;
  return { citation: m.ids[at] as string, index: at + 1, total, next: { key, index: at } };
}
