// Preact 11 不再给数字样式值自动补 px（只有 preact/compat 还补）：style={{ marginLeft: 8 }} 会被浏览器忽略。
// 设置页曾因此整页间距失效（用户在 Edge 里看到名称和地址挤在一起）。这里扫一遍界面代码，长度类属性必须写成带单位的字符串。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_DIR = resolve(import.meta.dirname, '../../../src/ui');
const LENGTH_PROPS =
  'margin|marginTop|marginBottom|marginLeft|marginRight|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|width|height|minWidth|maxWidth|minHeight|maxHeight|fontSize|gap|top|left|right|bottom|borderRadius';
const NUMERIC_LENGTH = new RegExp(`(?<![\\w.])(${LENGTH_PROPS}): -?\\d+(?:\\.\\d+)?(?=[,\\s}])`, 'g');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

describe('界面样式单位', () => {
  it('src/ui 的 .tsx 里长度类样式不写裸数字（Preact 11 不补 px）', () => {
    const hits: string[] = [];
    for (const file of tsxFiles(UI_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(NUMERIC_LENGTH)) {
          if (m[0].endsWith(': 0')) continue;
          hits.push(`${file.slice(UI_DIR.length + 1)}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
