// 动作定义（A2、A3、A6、A8）：工具栏、右键、快捷键、命令面板四个入口共用。
// 预置动作可以改提示词、排序、隐藏（A3），所以设置里存的是顺序与隐藏表，不是动作本身。
export const BUILTIN_ACTION_IDS = [
  'ask',
  'explain',
  'explainCode',
  'save',
  'summarizePage',
  'keyPoints',
  'pageAbout',
  'translate',
] as const;
export type BuiltinActionId = (typeof BUILTIN_ACTION_IDS)[number];
/** 自定义动作：custom: 加 crypto.randomUUID() */
export type ActionId = BuiltinActionId | `custom:${string}`;

export interface ActionDef {
  id: ActionId;
  label: string;
  /** model：发给模型；save：存进收藏，不发请求 */
  kind: 'model' | 'save';
  /** ask 需要用户输入；其他直接发送（A2） */
  needsInput: boolean;
  /** 作用在选区还是整页 */
  scope: 'selection' | 'page';
  /** 提示词覆盖；不填用代码里的默认值（I1） */
  promptOverride?: string;
}

export const BUILTIN_ACTIONS: readonly ActionDef[] = [
  { id: 'ask', label: '问', kind: 'model', needsInput: true, scope: 'selection' },
  { id: 'explain', label: '解释', kind: 'model', needsInput: false, scope: 'selection' },
  // 选区在代码里时替换工具栏第一个按钮（A6）
  { id: 'explainCode', label: '解释代码', kind: 'model', needsInput: false, scope: 'selection' },
  { id: 'save', label: '存', kind: 'save', needsInput: false, scope: 'selection' },
  // 固定总结入口（D-06：核心版必须有，不能后补）
  { id: 'summarizePage', label: '总结本页', kind: 'model', needsInput: false, scope: 'page' },
  { id: 'keyPoints', label: '提取要点', kind: 'model', needsInput: false, scope: 'page' },
  { id: 'pageAbout', label: '这页在讲什么', kind: 'model', needsInput: false, scope: 'page' },
  // 翻译降为普通动作，不做专门优化（Decision 005），默认不上工具栏
  { id: 'translate', label: '翻译', kind: 'model', needsInput: false, scope: 'selection' },
];

/** 工具栏默认按钮（A2）；最多显示 5 个，其余进「更多」 */
export const DEFAULT_TOOLBAR: readonly ActionId[] = ['ask', 'explain', 'save'];
export const TOOLBAR_MAX = 5;
/** 右键菜单入口（A8） */
export const CONTEXT_MENU_ACTIONS: readonly ActionId[] = ['ask', 'explain', 'summarizePage'];

/**
 * 动作摘要（contract-v1.4 增量）：后台下发给页面侧的动作信息，不含 promptOverride。
 * 工具栏按 kind/needsInput/scope 决定点击后是等输入、直接发送、还是不发请求（A2、A3）。
 */
export interface ActionSummary {
  id: ActionId;
  label: string;
  kind: ActionDef['kind'];
  needsInput: boolean;
  scope: ActionDef['scope'];
}

/** 选中内容超过这个字数（码点）时，工具栏先确认一次再发送（A7） */
export const LONG_SELECTION_CHARS = 5000;
