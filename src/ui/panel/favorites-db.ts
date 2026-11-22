// 收藏与历史的只读查询（5.4）：侧边栏直接打开同一份 IndexedDB 读，不经后台。写入仍一律经后台（conv-ops.ts）。
// 单例：同一个扩展页面只开一次连接；favorite/changed 广播到达时调用方重新查询即可，不需要重开连接。
import { createIdbConvDb } from '@/platform/conv-db';

let instance: ReturnType<typeof createIdbConvDb> | undefined;

export function readOnlyDb() {
  instance ??= createIdbConvDb();
  return instance;
}
