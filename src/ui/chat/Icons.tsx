// 界面用到的几个图标：内联 SVG（扩展页面的 CSP 不允许 data: 图片），跟随文字颜色。自己画的，不来自任何图标库。
import type { ComponentChildren } from 'preact';

function Svg({ children }: { children: ComponentChildren }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconClose = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const IconPlus = () => (
  <Svg>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);

/** 图钉：钉住时填实 */
export const IconPin = ({ filled }: { filled: boolean }) => (
  <Svg>
    <path d="M6 2.5h4l-.5 4 2 2.5h-7l2-2.5z" fill={filled ? 'currentColor' : 'none'} />
    <path d="M8 9v4.5" />
  </Svg>
);

/** 转到侧边栏：一个窗口，右侧一栏 */
export const IconPanel = () => (
  <Svg>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
    <path d="M10 3.5v9" />
  </Svg>
);
