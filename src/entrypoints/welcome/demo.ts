// 欢迎页「亲手试一遍」的装配（L3、决策 038）。内容脚本（哨兵、阅读器）进不了扩展自己的页面，
// 所以在入口这里直接复用页面侧的工具栏与选区判断（page/toolbar.ts、page/selection-policy.ts，不改它们的行为），
// 让示例文章上的划词和普通网页上一样弹出工具栏。
//
// 没照搬的部分：小窗与页面正文读取（阅读器）。
// | 小窗 | 阅读器在 runtime.onConnect 上接小窗的私有端口。扩展页面一旦挂了 onConnect 监听，别的扩展页面（所有小窗、 |
// |      | 侧边栏）连后台的对话端口也会在这里多出一端（runtime.connect 会在扩展进程的每个有监听的框架里触发 onConnect）； |
// |      | 端口要所有接收端都没了才算断开，后台被回收时它们就收不到断线，重连会坏（Chrome 文档 Message passing · Port lifetime） |
// | 读取 | 页面身份 pageKey 只对 http(s) 有意义，扩展页面不归档、不读取 |
// 所以示例里点「问」「解释」后在侧边栏回答，只带选中的文字——这正是「侧边栏开着时划词提问」的真实行为（B7）。
//
// 点击的同步段里先 sidePanel.open（规则 10），再把选中的文字经设置页通道交给后台（demo/ask，contract-v1.5）；
// 后台只认 welcome.html 所在标签页发来的这条消息，选区记在本标签页名下（welcome-demo.ts）。
import { browser } from 'wxt/browser';
import { type ActionSummary, BUILTIN_ACTIONS, DEFAULT_TOOLBAR } from '@/core/domain/actions';
import { truncateByJsonBytes } from '@/core/domain/bytes';
import { JOB_LIMITS } from '@/core/domain/job';
import type { DemoAskResult, OptionsToBackground } from '@/core/domain/messages';
import { evaluateSelection, lastLineRect } from '@/page/selection-policy';
import { createToolbar, type ToolbarHost } from '@/page/toolbar';
import type { DemoEvent, DemoHost } from '@/ui/welcome/demo';

/** 示例工具栏用出厂默认的三个按钮（问 / 解释 / 存），不跟用户的自定义走：示例只接「问」「解释」 */
const DEMO_ACTIONS: readonly ActionSummary[] = DEFAULT_TOOLBAR.flatMap((id) => {
  const d = BUILTIN_ACTIONS.find((a) => a.id === id);
  return d ? [{ id: d.id, label: d.label, kind: d.kind, needsInput: d.needsInput, scope: d.scope }] : [];
});

function isDemoAskResult(r: unknown): r is DemoAskResult {
  return typeof r === 'object' && r !== null && typeof (r as { ok?: unknown }).ok === 'boolean';
}

export function createDemoHost(): DemoHost {
  return {
    mount(article, { saveTip, onEvent }) {
      let windowId: number | undefined;
      let text = '';
      let toolbar: ToolbarHost | undefined;
      void browser.windows.getCurrent().then((w) => {
        windowId = w.id;
      });

      async function ask(actionId: 'ask' | 'explain', opened: Promise<void>): Promise<DemoEvent> {
        const cut = truncateByJsonBytes(text, JOB_LIMITS.maxFieldBytes);
        const msg: OptionsToBackground = {
          type: 'demo/ask',
          actionId,
          // 修订号用时间：与右键「问」同例，不会和别处的修订号撞上
          selectionRevision: Date.now(),
          text: cut.text,
          truncated: cut.truncated,
          originalLength: [...text].length,
        };
        const [panel, res] = await Promise.all([
          opened.then(
            () => true,
            () => false,
          ),
          browser.runtime.sendMessage<OptionsToBackground, unknown>(msg).catch(() => undefined),
        ]);
        if (!panel) return 'panelFailed';
        if (!isDemoAskResult(res)) return 'failed';
        if (!res.ok) return res.reason === 'noModel' ? 'noModel' : 'failed';
        return res.started ? 'explained' : 'asked';
      }

      function getToolbar(): ToolbarHost {
        toolbar ??= createToolbar((action) => {
          if (action.id !== 'ask' && action.id !== 'explain') {
            toolbar?.tip(saveTip);
            return;
          }
          // 规则 10：打开侧边栏必须在点击的同步段里发出，之前不得 await
          const opened =
            windowId === undefined
              ? Promise.reject(new Error('没有窗口'))
              : browser.sidePanel.open({ windowId });
          void ask(action.id, opened).then(onEvent, () => onEvent('failed'));
          toolbar?.hide();
        });
        return toolbar;
      }

      function onSelectionChange(): void {
        const sel = window.getSelection();
        const decision = evaluateSelection(sel);
        // 只认从文章里开始的选区。不要求整个选区都在文章里：三击选中最后一段时，选区的末端落在文章后面那个块的开头
        const inArticle =
          sel !== null && sel.rangeCount > 0 && article.contains(sel.getRangeAt(0).startContainer);
        const rect = decision.show && sel !== null && inArticle ? lastLineRect(sel) : null;
        if (rect === null) {
          toolbar?.hide();
          return;
        }
        text = decision.text;
        getToolbar().show(rect, DEMO_ACTIONS, false);
      }

      // 与哨兵同样的收起时机（A5）：点别处、滚动、Esc
      const onMouseUp = (e: MouseEvent) => e.isTrusted && onSelectionChange();
      const onKeyUp = (e: KeyboardEvent) => {
        if (!e.isTrusted) return;
        if (e.key === 'Escape') toolbar?.hide();
        else onSelectionChange();
      };
      const onMouseDown = (e: MouseEvent) => {
        if (e.isTrusted && toolbar !== undefined && !toolbar.el.contains(e.target as Node)) toolbar.hide();
      };
      const onScroll = (e: Event) => e.isTrusted && toolbar?.hide();
      const opts = { capture: true, passive: true } as const;
      window.addEventListener('mouseup', onMouseUp, opts);
      window.addEventListener('keyup', onKeyUp, opts);
      window.addEventListener('mousedown', onMouseDown, opts);
      window.addEventListener('scroll', onScroll, { passive: true });

      return () => {
        window.removeEventListener('mouseup', onMouseUp, opts);
        window.removeEventListener('keyup', onKeyUp, opts);
        window.removeEventListener('mousedown', onMouseDown, opts);
        window.removeEventListener('scroll', onScroll);
        toolbar?.el.remove();
        toolbar = undefined;
      };
    },
  };
}
