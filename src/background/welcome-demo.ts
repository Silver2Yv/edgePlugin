// 欢迎页「快速上手」的示例提问（L3、决策 038，contract-v1.5）。内容脚本进不了扩展自己的页面，欢迎页自己装配
// 工具栏（entrypoints/welcome/demo.ts），点「问」「解释」时把选中的示例文字经设置页通道交给这里。
// 做的事与右键「问」（commands.ts 的 menuAsk）相同：选区按 sender.tab 存下、推给该标签页的订阅者（侧边栏），
// 「解释」再按默认模型起一个任务（任务归后台，规则 2）。侧边栏由欢迎页在点击的同步段里自己打开（规则 10）。
//
// 为什么安全：身份只取自 sender（规则 7）——必须是本扩展 welcome.html、在标签页顶层框架里；选区只记在发送者
// 自己的标签页名下，消息里没有地址、Key、标签页编号（规则 6）。内容脚本的角色发不了设置页通道的消息。
import type { DemoAskResult, OptionsToBackground } from '@/core/domain/messages';
import type { BackgroundDeps, SenderLike } from './deps';
import type { Hub } from './hub';
import type { Jobs } from './jobs';
import { quoteOf } from './quote';
import type { Store, StoredSelection } from './store';

type DemoAsk = Extract<OptionsToBackground, { type: 'demo/ask' }>;

const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown');

function isWelcomeTab(sender: SenderLike): sender is SenderLike & { tab: { id: number } } {
  if (typeof sender.tab?.id !== 'number' || sender.frameId !== 0 || !sender.url) return false;
  try {
    return new URL(sender.url).pathname === '/welcome.html';
  } catch {
    return false;
  }
}

export type WelcomeDemo = ReturnType<typeof createWelcomeDemo>;

export function createWelcomeDemo(deps: BackgroundDeps, store: Store, hub: Hub, jobs: Jobs) {
  return async function onDemoAsk(msg: DemoAsk, sender: SenderLike): Promise<DemoAskResult> {
    if (!isWelcomeTab(sender)) {
      deps.log('demo/rejected', { reason: 'notAllowed' });
      return { ok: false, reason: 'notAllowed' };
    }
    const tabId = sender.tab.id;
    const sel: StoredSelection = {
      frameId: 0,
      ...(sender.documentId === undefined ? {} : { documentId: sender.documentId }),
      selectionRevision: msg.selectionRevision,
      text: msg.text,
      truncated: msg.truncated,
      originalLength: msg.originalLength,
      inCode: false,
      at: deps.now(),
    };
    const saved = store.putSelection(tabId, sel);
    // 侧边栏已订阅就直接换引用；刚打开、还没订阅的，订阅时取存下的这一份
    hub.toTab(tabId, quoteOf(sel));
    const windowId = sender.tab.windowId;
    if (windowId !== undefined) void deps.notifyPages({ type: 'sidepanel/wake', windowId });
    await saved;
    if (msg.actionId !== 'explain') return { ok: true, started: false };

    const loaded = await deps.loadSettings();
    const s = loaded.ok ? loaded.settings : undefined;
    if (!s?.defaultModel) return { ok: false, reason: 'noModel' };
    void jobs
      .ask(
        tabId,
        {
          type: 'conv/ask',
          clientRequestId: deps.newId(),
          actionId: 'explain',
          text: '',
          selectionRevision: sel.selectionRevision,
          // 扩展自己的页面读不了正文（没有阅读器），只带选中的文字
          contextTier: 'selection',
          lengthTier: s.reply.lengthTier,
          thinking: s.reply.thinking,
          model: s.defaultModel,
        },
        (m) => {
          if (m.type === 'conv/rejected') deps.log('demo/askRejected', { reason: m.reason });
        },
      )
      .catch((e: unknown) => deps.log('demo/askFailed', { error: errName(e) }));
    return { ok: true, started: true };
  };
}
