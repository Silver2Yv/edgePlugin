// anchor/ 目录下独立的 vitest 配置。
//
// 背景：在 v09-citation 根目录下执行 `vitest run`（即 package.json 里的 anchor:test 脚本）时，
// vitest 会向上搜索配置文件，找到仓库根目录 D:/CC_workspace/edgePlugin/vitest.config.ts
// ——那是给整个浏览器扩展项目用的配置，include 指向 tests/unit/**，和本原型完全无关，
// 导致出现 "No test files found" 而不是真的运行 anchor/test 下的用例。
//
// 按任务说明，这个文件新增在 anchor/ 目录下，不修改 v09-citation 的 package.json / tsconfig.json。
// 运行方式（在 v09-citation 目录下执行）：
//   npx vitest run --config anchor/vitest.config.ts
// 不能直接用 `npm run anchor:test`，因为那个 script 固定是 `vitest run`、没有带 --config，
// 仍然会被上面提到的仓库根配置抢先命中。

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const anchorDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: anchorDir,
  test: {
    include: ['test/**/*.test.ts'],
  },
});
