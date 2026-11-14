// 清单权限差异检查（ARCHITECTURE 7 节）：产物清单的权限与基线不一致即失败。
// 有意变更权限时，同步修改 manifest-baseline.json，并在 PR 描述里显式标出。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FIELDS = [
  'permissions',
  'optional_permissions',
  'host_permissions',
  'optional_host_permissions',
] as const;

type PermissionSet = Partial<Record<(typeof FIELDS)[number], string[]>>;

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson(join(ROOT, '.output', 'chrome-mv3', 'manifest.json')) as PermissionSet;
const baseline = readJson(join(ROOT, 'scripts', 'manifest-baseline.json')) as PermissionSet;

let changed = false;
for (const field of FIELDS) {
  const actual = new Set(manifest[field] ?? []);
  const expected = new Set(baseline[field] ?? []);
  const added = [...actual].filter((p) => !expected.has(p));
  const removed = [...expected].filter((p) => !actual.has(p));
  if (added.length > 0) console.error(`${field} 新增：${added.join(', ')}`);
  if (removed.length > 0) console.error(`${field} 移除：${removed.join(', ')}`);
  if (added.length > 0 || removed.length > 0) changed = true;
}
if (changed) {
  console.error('清单权限与基线不一致。确属有意变更，请更新 scripts/manifest-baseline.json 并在 PR 中标出。');
  process.exit(1);
}
console.log('清单权限与基线一致');
