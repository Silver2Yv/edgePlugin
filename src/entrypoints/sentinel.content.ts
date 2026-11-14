import { defineContentScript } from 'wxt/utils/define-content-script';
import { startSentinel } from '@/page/sentinel';

// 哨兵：由后台动态注册（见 background/scripts.ts），不写进清单的 content_scripts
export default defineContentScript({
  registration: 'runtime',
  // 不向网页 postMessage「脚本已启动」标记（规则 4：不经过 window.postMessage）
  noScriptStartedPostMessage: true,
  main: startSentinel,
});
