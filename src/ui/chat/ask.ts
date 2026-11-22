// 小窗与侧边栏共用的发问动作（副作用在这里，纯逻辑在 float/state.ts）：
// 读默认参数、套上输入区临时切换的档位、思考强度与模型（H4），接着正在显示的对话发 conv/ask；连接没就绪时先存成待发。
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { ContextTier, LengthTier, ThinkingLevel } from '@/core/context/plan';
import type { ClientToBackground } from '@/core/domain/messages';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import type { Connection, ModelRef } from '@/core/llm/adapter';
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import { loadAskDefaults } from '../ask-defaults';
import type { AskRequest } from '../float/messages';
import { buildAskMessage, type FloatAction, type FloatState, isGenerating } from '../float/state';
import { capabilitiesFor, clampThinking, thinkingControlMode } from '../model/options';
import { T } from '../strings';

export interface AskDeps {
  /** 最新的状态（异步读完设置之后要看最新的，不能用闭包里那份） */
  getState: () => FloatState;
  post: (msg: ClientToBackground) => void;
  dispatch: (action: FloatAction) => void;
  /** 现在能不能直接发：连接已就绪（侧边栏还要求订阅已确认） */
  canSendNow: (state: FloatState) => boolean;
  /** 连接闲着时叫醒重连 */
  wake: () => void;
}

/**
 * 发问。lengthTier 不给用设置里的默认档（「展开讲讲」给 detailed）；model 不给用临时切换的或设置里的默认模型
 * （「换个模型再试」H12 直接指定，不看 modelOverride——调用方那边 dispatch 的 setModel 还没来得及生效）。
 * 返回是否已发出或已存成待发（调用方据此清空输入框）；回答进行中、没有连接时提示一行并返回 false
 */
export async function submitAsk(
  deps: AskDeps,
  rawText: string,
  /** request：换个模型重问一个动作（H12）时原样带上它的动作与档位；rawText 那时只用于本地显示 */
  opts: { lengthTier?: LengthTier; model?: ModelRef; request?: AskRequest } = {},
): Promise<boolean> {
  const text = rawText.trim();
  const action = opts.request && opts.request.actionId !== 'ask' ? opts.request : undefined;
  if (!text && !action) return false;
  if (isGenerating(deps.getState().job)) {
    deps.dispatch({ kind: 'localError', message: T.error.generating });
    return false;
  }
  const defaults = await loadAskDefaults();
  if (!defaults.ok) {
    deps.dispatch({ kind: 'localError', message: defaults.message });
    return false;
  }
  const s = deps.getState();
  const model = opts.model ?? s.modelOverride ?? defaults.model;
  // 思考强度随模型能力变（H6）：开关类模型各档都按「开」，不支持思考的模型强制关闭，
  // 和 Composer 里显示的控件形态保持一致，不会出现界面显示「关」实际却发了思考参数
  const mode = thinkingControlMode(capabilitiesFor(defaults.connections, model));
  const params = {
    lengthTier: opts.lengthTier ?? defaults.lengthTier,
    thinking: clampThinking(mode, s.thinkingOverride ?? defaults.thinking),
    contextTier: action?.contextTier ?? s.tierOverride ?? defaults.contextTier,
    model,
  };
  const clientRequestId = crypto.randomUUID();
  if (deps.canSendNow(s)) {
    deps.post(
      buildAskMessage({
        clientRequestId,
        text,
        quote: s.quote,
        conversationId: s.conversationId,
        fresh: s.freshConversation,
        ...params,
        ...(action ? { actionId: action.actionId } : {}),
      }),
    );
    deps.dispatch({
      kind: 'askSent',
      clientRequestId,
      text,
      quote: s.quote,
      ...(action ? { request: action } : {}),
    });
  } else {
    // 没就绪：先存成待发，等重连、订阅、收到这次 conv/snapshot 后再用当时最新的引用发出
    deps.dispatch({
      kind: 'queueAsk',
      ask: { clientRequestId, text, ...params, ...(action ? { request: action } : {}) },
    });
    deps.wake();
  }
  return true;
}

/** 这次订阅的初始推送已收完：把连接没就绪时存下的待发问发出去，引用与对话用这时最新的 */
export function flushQueuedAsk(state: FloatState, deps: Pick<AskDeps, 'post' | 'dispatch'>): void {
  const ask = state.queuedAsk;
  if (!ask) return;
  deps.post(
    buildAskMessage({
      clientRequestId: ask.clientRequestId,
      text: ask.text,
      quote: state.quote,
      conversationId: state.conversationId,
      fresh: state.freshConversation,
      lengthTier: ask.lengthTier,
      thinking: ask.thinking,
      model: ask.model,
      ...(ask.contextTier ? { contextTier: ask.contextTier } : {}),
      ...(ask.request ? { actionId: ask.request.actionId } : {}),
    }),
  );
  deps.dispatch({
    kind: 'askSent',
    clientRequestId: ask.clientRequestId,
    text: ask.text,
    quote: state.quote,
    ...(ask.request ? { request: ask.request } : {}),
  });
}

/** 输入区要显示的默认值：档位、思考强度、模型（界面显示的就是实际发送的，J10）、所有连接（模型下拉用） */
export interface ComposerDefaults {
  contextTier: ContextTier;
  thinking: ThinkingLevel;
  model: ModelRef | null;
  connections: readonly Connection[];
}

const FALLBACK: ComposerDefaults = {
  contextTier: DEFAULT_SETTINGS.context.defaultTier,
  thinking: DEFAULT_SETTINGS.reply.thinking,
  model: null,
  connections: [],
};

/** 读设置里的默认值，设置变了跟着更新（设置页改了默认档位，开着的小窗与侧边栏立即反映） */
export function useComposerDefaults(): ComposerDefaults {
  const [defaults, setDefaults] = useState(FALLBACK);
  useEffect(() => {
    let disposed = false;
    const load = () =>
      void loadSettings().then((r) => {
        if (disposed) return;
        setDefaults(
          r.ok
            ? {
                contextTier: r.settings.context.defaultTier,
                thinking: r.settings.reply.thinking,
                model: r.settings.defaultModel ?? null,
                connections: r.settings.connections,
              }
            : FALLBACK,
        );
      });
    load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && SETTINGS_KEY in changes) load();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      disposed = true;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return defaults;
}
