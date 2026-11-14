import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// 固定扩展 ID 用的公钥（ARCHITECTURE 7 节）。ID：pkahgpgifechjgdpecaebajnocgcnnnd
// 固定 ID 不等于重装后保留数据；卸载仍清空。
const MANIFEST_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApJjzfFoI90rrYTgB8PUZL+4DoEfLblaMcR/euBZ8NrngC9GK8vz+IWO7O2H7F+9xC+HCGP4B49ZV7JlGACsZRv0q+s2ichM597Ufot81Dfl+8OQylY4EA2Ya9phEy1MD1BsGIaQLf9VnOLAIvJeLXdyF6o/3YcSaKUsaIiYLbIGPR55anatAqQF30H2oKHnv7lIiL2dz/dnWmA4IRHtlkzOxyRHqMmQbT/ktnH7F6YBsblrm05IprviZ1bl461EYUqGLRCka8IAxnVqtOmILc8+5gkpjw1MORX3kTsr2UAuNIf75/ShuIqm9EAX46Ci+O9bJV68ut7BUzHkzF8HCZQIDAQAB';

export default defineConfig({
  srcDir: 'src',
  // 关闭自动导入：依赖方向检查要能从 import 语句看出谁用了扩展 API（规则 4.3.11）
  imports: false,
  targetBrowsers: ['chrome', 'edge'],
  vite: () => ({
    plugins: [preact()],
    build: { target: 'chrome141' },
  }),
  manifest: {
    name: '阅读助手（开发版）',
    description: 'AI 阅读助手：划词提问、一键总结（开发中）',
    minimum_chrome_version: '141',
    key: MANIFEST_KEY,
    permissions: ['storage', 'unlimitedStorage', 'sidePanel', 'contextMenus', 'scripting', 'webRequest'],
    host_permissions: ['<all_urls>'],
    action: { default_title: '打开阅读助手侧边栏' },
    commands: {
      'open-float': { suggested_key: { default: 'Alt+Shift+S' }, description: '打开小窗' },
      'toggle-sidepanel': { suggested_key: { default: 'Alt+Shift+D' }, description: '打开侧边栏' },
      'capture-region': { suggested_key: { default: 'Alt+Shift+X' }, description: '框选截图' },
      'summarize-page': { description: '总结当前页面' },
    },
    web_accessible_resources: [{ resources: ['float.html'], matches: ['<all_urls>'], use_dynamic_url: true }],
  },
});
