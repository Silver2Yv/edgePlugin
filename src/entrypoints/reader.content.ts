import { defineContentScript } from 'wxt/utils/define-content-script';
import { startReader } from '@/page/reader';

// 阅读器：用户首次交互时由后台 executeScript 注入
export default defineContentScript({
  registration: 'runtime',
  noScriptStartedPostMessage: true,
  main: startReader,
});
