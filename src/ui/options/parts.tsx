// 设置页与欢迎页共用的几个小组件：设置行（名字 + 说明在左，控件在右）、可折叠小节（展开时才渲染内容）、表单字段。
// 说明文字直接显示在选项旁边，不藏在问号图标里（K3）。
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { S } from './strings';

/** 一行设置：左边名字与一两句说明，右边控件 */
export function Row(props: { label: string; help?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="opt-row">
      <div class="opt-row__text">
        <div class="opt-row__label">{props.label}</div>
        {props.help !== undefined && <div class="opt-help">{props.help}</div>}
      </div>
      <div class="opt-row__control">{props.children}</div>
    </div>
  );
}

/** 表单字段：名字在上，控件在下，说明在最下 */
export function Field(props: {
  label: string;
  for?: string;
  help?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <div class="opt-field">
      <label class="opt-field__label" for={props.for}>
        {props.label}
      </label>
      {props.children}
      {props.help !== undefined && <div class="opt-help">{props.help}</div>}
    </div>
  );
}

/**
 * 可折叠小节（K2：折叠不减少能力，只减少视觉负担）。内容只在展开时渲染：折叠着的几百个输入框既拖慢页面，
 * 也会让「按名字找控件」的测试撞上看不见的同名控件
 */
export function Fold(props: {
  title: string;
  hint?: string;
  /** 加大的那一档：整块「高级选项」 */
  major?: boolean;
  defaultOpen?: boolean;
  testId?: string;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <details
      class={props.major ? 'opt-fold opt-fold--major' : 'opt-fold'}
      open={open}
      data-testid={props.testId}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="opt-fold__summary">
        <span class="opt-fold__title">{props.title}</span>
        {props.hint !== undefined && <span class="opt-fold__hint">{props.hint}</span>}
      </summary>
      {open && <div class="opt-fold__body">{props.children}</div>}
    </details>
  );
}

/** 下拉：值是字符串字面量联合，选项按给定顺序 */
export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      class="opt-select"
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange((e.target as HTMLSelectElement).value as T)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * 可能是秘密的输入框（Key、名字像凭据的请求头的值）：默认按密码框遮住，shown 为真时明文。
 * 写成两个分支只是因为 Preact 的类型按 type 区分输入框；运行时是同一个 input 换属性，焦点不丢
 */
export function SecretInput(props: {
  shown: boolean;
  value: string;
  onInput: (value: string) => void;
  id?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const common = {
    class: 'opt-input',
    autocomplete: 'off',
    value: props.value,
    onInput: (e: Event) => props.onInput((e.target as HTMLInputElement).value),
    ...(props.id !== undefined ? { id: props.id } : {}),
    ...(props.label !== undefined ? { 'aria-label': props.label } : {}),
    ...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {}),
    ...(props.disabled !== undefined ? { disabled: props.disabled } : {}),
  };
  return props.shown ? <input type="text" {...common} /> : <input type="password" {...common} />;
}

/**
 * 删除后的撤销窗口（M4：不用模态弹窗）：记下刚删的名字与恢复数据，到时间自己收起。
 * 再删一项会替换掉上一条（前一条随之失效）
 */
export function useUndo<T>(seconds = 10) {
  const [notice, setNotice] = useState<{ name: string; data: T } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    setNotice(null);
  }, []);
  const show = useCallback(
    (name: string, data: T) => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      setNotice({ name, data });
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        setNotice(null);
      }, seconds * 1000);
    },
    [seconds],
  );
  useEffect(() => clear, [clear]);
  return { notice, show, clear };
}

/** 「已删除「X」」与撤销按钮 */
export function UndoBar(props: { name: string; onUndo: () => void }) {
  return (
    <div class="opt-banner" role="status" data-testid="undo-bar">
      <span>{S.undo.deleted(props.name)}</span>
      <button
        type="button"
        class="ra-btn ra-btn--small"
        aria-label={S.undo.undoLabel(props.name)}
        onClick={props.onUndo}
      >
        {S.undo.undo}
      </button>
    </div>
  );
}
