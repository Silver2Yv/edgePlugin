import { describe, expect, it } from 'vitest';
import { checkModules } from '../../scripts/check-deps';

const run = (files: Record<string, string>) => checkModules(new Map(Object.entries(files)));

describe('依赖方向检查', () => {
  it('core 引用 core 之外的模块、第三方包或扩展 API 都会被拦下', () => {
    const v = run({
      'src/core/a.ts': "import { x } from '../platform/storage';\nimport { openDB } from 'idb';",
      'src/core/b.ts': 'export const id = () => chrome.runtime.id;',
      'src/core/c.ts': "import { y } from '@/core/a';\n// chrome.tabs 只在注释里\nconst s = 'browser.tabs';",
      'src/platform/storage.ts': 'export const x = 1;',
    });
    expect(v.map((x) => `${x.file}:${x.rule}`)).toEqual([
      'src/core/a.ts:core-pure',
      'src/core/a.ts:core-pure',
      'src/core/b.ts:core-pure',
    ]);
  });

  it('page 引用 ui 会被拦下', () => {
    const v = run({
      'src/page/toolbar.ts': "import { Chat } from '@/ui/Chat';",
      'src/ui/Chat.tsx': 'export const Chat = 1;',
    });
    expect(v).toEqual([
      { file: 'src/page/toolbar.ts', rule: 'page-no-ui', detail: '引用了界面代码：@/ui/Chat' },
    ]);
  });

  it('哨兵依赖链里的第三方包会被拦下', () => {
    const v = run({
      'src/entrypoints/sentinel.content.ts':
        "import { defineContentScript } from 'wxt/utils/define-content-script';\nimport { s } from '@/page/sentinel';",
      'src/page/sentinel.ts': "import { h } from 'preact';\nexport const s = h;",
    });
    expect(v.map((x) => x.rule)).toEqual(['sentinel-no-deps']);
  });
});
