// 发问用的默认参数（小窗与侧边栏共用）：模型、长度档、思考强度、页面内容档位都取设置里的默认值。
// 界面显示的模型就是实际发送的（J10）；没有连接时给出界面提示文案。
import type { ContextTier, LengthTier, ThinkingLevel } from '@/core/context/plan';
import type { ModelRef } from '@/core/llm/adapter';
import { loadSettings } from '@/platform/settings-store';

export type AskDefaults =
  | { ok: true; lengthTier: LengthTier; thinking: ThinkingLevel; contextTier: ContextTier; model: ModelRef }
  | { ok: false; message: string };

export const NO_CONNECTION = '请先在设置里添加连接';

/** 「展开讲讲」（I3）发出的追问文字：装配按这句话识别「展开」，所以与提示词模块共用同一个常量 */
export { EXPAND_QUESTION } from '@/core/prompt/ask';

export async function loadAskDefaults(): Promise<AskDefaults> {
  const result = await loadSettings();
  const model = result.ok ? result.settings.defaultModel : undefined;
  if (!result.ok || model === undefined) return { ok: false, message: NO_CONNECTION };
  const { settings } = result;
  return {
    ok: true,
    lengthTier: settings.reply.lengthTier,
    thinking: settings.reply.thinking,
    contextTier: settings.context.defaultTier,
    model,
  };
}
