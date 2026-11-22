// 快速上手（L3、决策 038）：三步图示（选中 → 问 → 存），加一篇示例文章让用户亲手试一遍。不做逐步强制引导、
// 不弹模态，随时可以跳过（M4）。示例文章上的工具栏由入口装配后经 DemoHost 传进来（见 welcome/demo.ts）；
// 没有 DemoHost（单独渲染、测试）时只是一篇普通文章。
import { useEffect, useRef, useState } from 'preact/hooks';
import { S } from '../options/strings';
import type { DemoEvent, DemoHost } from './demo';

const EVENT_TEXT: Readonly<Record<DemoEvent, { text: string; error: boolean }>> = {
  asked: { text: S.quick.opened, error: false },
  explained: { text: S.quick.explained, error: false },
  noModel: { text: S.quick.needModel, error: true },
  panelFailed: { text: S.quick.panelFailed, error: true },
  failed: { text: S.quick.panelFailed, error: true },
};

export function QuickStart(props: { demo?: DemoHost; hasModel: boolean }) {
  const articleRef = useRef<HTMLElement>(null);
  const [event, setEvent] = useState<DemoEvent | null>(null);
  const { demo } = props;

  useEffect(() => {
    const article = articleRef.current;
    if (!demo || !article) return;
    return demo.mount(article, { saveTip: S.quick.saveTip, onEvent: setEvent });
  }, [demo]);

  const status = event ? EVENT_TEXT[event] : null;
  return (
    <div class="opt-quick">
      <div class="opt-help">{S.quick.lead}</div>
      <ol class="opt-cards">
        {S.quick.cards.map((c, i) => (
          <li key={c.title} class="opt-cardlet">
            <Illustration step={i} />
            <div class="opt-cardlet__title">
              <span class="opt-stepno">{i + 1}</span>
              {c.title}
            </div>
            <div class="opt-help">{c.text}</div>
          </li>
        ))}
      </ol>

      <h3 class="opt-subtitle">{S.quick.tryTitle}</h3>
      <div class="opt-help">{S.quick.tryLead}</div>
      {!props.hasModel && <div class="opt-warn">{S.quick.needModel}</div>}
      <article class="opt-article" ref={articleRef} data-testid="demo-article">
        <h4>{S.quick.article.title}</h4>
        {S.quick.article.paragraphs.map((p, i) => (
          <p key={i} data-paragraph={i}>
            {p}
          </p>
        ))}
      </article>
      <div class="opt-muted">{S.quick.article.suggestion}</div>
      {status && (
        <div
          class={status.error ? 'opt-result opt-result--error' : 'opt-result opt-result--ok'}
          role="status"
          data-testid="demo-status"
        >
          {status.text}
        </div>
      )}
      <div class="opt-help">{S.quick.tryNote}</div>

      <h3 class="opt-subtitle">{S.quick.nextTitle}</h3>
      <ul class="opt-bullets">
        {S.quick.next.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/** 三步图示：纯 CSS 画的示意（扩展页面的 CSP 不允许 data: 图片），只表达位置关系，不是截图 */
function Illustration({ step }: { step: number }) {
  if (step === 0) {
    return (
      <div class="opt-ill" aria-hidden="true">
        <div class="opt-ill__line" />
        <div class="opt-ill__line opt-ill__line--selected" />
        <div class="opt-ill__toolbar">
          <span>问</span>
          <span>解释</span>
          <span>存</span>
        </div>
      </div>
    );
  }
  if (step === 1) {
    return (
      <div class="opt-ill" aria-hidden="true">
        <div class="opt-ill__float">
          <div class="opt-ill__quote" />
          <div class="opt-ill__line opt-ill__line--short" />
          <div class="opt-ill__line" />
          <div class="opt-ill__input" />
        </div>
      </div>
    );
  }
  return (
    <div class="opt-ill opt-ill--split" aria-hidden="true">
      <div class="opt-ill__page">
        <div class="opt-ill__line" />
        <div class="opt-ill__line opt-ill__line--short" />
        <div class="opt-ill__line" />
      </div>
      <div class="opt-ill__panel">
        <div class="opt-ill__saved" />
        <div class="opt-ill__saved" />
      </div>
    </div>
  );
}
