// 依赖方向检查（ARCHITECTURE 4.3 规则 3、11；7 节）。零依赖，Node 直接运行 .ts。
// 规则：
//   core-pure       src/core 只能引用 src/core，且不得使用扩展 API（chrome.* / browser.*）
//   page-no-ui      src/page 不得引用 src/ui
//   sentinel-no-deps 哨兵及其传递依赖不得引入第三方包（WXT 入口包装除外）
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';

export interface Violation {
  file: string;
  rule: 'core-pure' | 'page-no-ui' | 'sentinel-no-deps';
  detail: string;
}

const SENTINEL_ENTRY = 'src/entrypoints/sentinel.content.ts';
const SENTINEL_ALLOWED_PACKAGES = new Set(['wxt/utils/define-content-script', 'wxt/browser']);
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

// 去掉注释；keepStrings 为 false 时把字符串内容也清空（用于查全局 API 用法）
export function stripComments(code: string, keepStrings = true): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
      i++;
      out += keepStrings ? code.slice(start, i) : `${c}${c}`;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function importSpecifiers(code: string): string[] {
  const clean = stripComments(code);
  const specs: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[\w*{}\s,$]*?\s*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of clean.matchAll(re)) if (m[1]) specs.push(m[1]);
  return specs;
}

type Resolved = { kind: 'file'; path: string } | { kind: 'package'; name: string } | { kind: 'missing' };

function resolveSpecifier(from: string, spec: string, files: ReadonlyMap<string, string>): Resolved {
  let base: string | undefined;
  if (spec.startsWith('.')) base = posix.join(posix.dirname(from), spec);
  else if (spec.startsWith('@/') || spec.startsWith('~/')) base = posix.join('src', spec.slice(2));
  if (base === undefined) return { kind: 'package', name: spec };
  for (const ext of EXTENSIONS) if (files.has(base + ext)) return { kind: 'file', path: base + ext };
  return { kind: 'missing' };
}

const EXTENSION_API = /\b(?:chrome|browser)\s*\??\.\s*[A-Za-z_]/;

export function checkModules(files: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = [];
  for (const [file, code] of files) {
    const inCore = file.startsWith('src/core/');
    const inPage = file.startsWith('src/page/');
    if (!inCore && !inPage) continue;
    for (const spec of importSpecifiers(code)) {
      const r = resolveSpecifier(file, spec, files);
      if (inCore && (r.kind === 'package' || (r.kind === 'file' && !r.path.startsWith('src/core/')))) {
        violations.push({ file, rule: 'core-pure', detail: `引用了 core 之外的模块：${spec}` });
      }
      if (inPage && r.kind === 'file' && r.path.startsWith('src/ui/')) {
        violations.push({ file, rule: 'page-no-ui', detail: `引用了界面代码：${spec}` });
      }
    }
    if (inCore && EXTENSION_API.test(stripComments(code, false))) {
      violations.push({ file, rule: 'core-pure', detail: '使用了扩展 API（chrome.* / browser.*）' });
    }
  }

  // 哨兵：沿传递依赖检查第三方包
  const seen = new Set<string>();
  const queue = files.has(SENTINEL_ENTRY) ? [SENTINEL_ENTRY] : [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importSpecifiers(files.get(file) ?? '')) {
      const r = resolveSpecifier(file, spec, files);
      if (r.kind === 'file') queue.push(r.path);
      else if (r.kind === 'package' && !SENTINEL_ALLOWED_PACKAGES.has(r.name)) {
        violations.push({ file, rule: 'sentinel-no-deps', detail: `哨兵依赖链引入了第三方包：${spec}` });
      }
    }
  }
  return violations;
}

function collectSources(root: string, dir: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSources(root, full, out);
    else if (/\.tsx?$/.test(entry.name)) {
      out.set(relative(root, full).split('\\').join('/'), readFileSync(full, 'utf8'));
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const files = new Map<string, string>();
  collectSources(root, join(root, 'src'), files);
  const violations = checkModules(files);
  if (violations.length === 0) {
    console.log(`依赖方向检查通过（${files.size} 个文件）`);
  } else {
    for (const v of violations) console.error(`[${v.rule}] ${v.file}：${v.detail}`);
    console.error(`依赖方向检查失败：${violations.length} 处`);
    process.exit(1);
  }
}
