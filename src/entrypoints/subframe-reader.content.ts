import { defineContentScript } from 'wxt/utils/define-content-script';
import { startSubframeReader } from '@/page/subframe-reader';

// 子框架阅读器：读取页面时由后台按需 executeScript 注入到允许读取的子框架（D10），不写进清单、不常驻
export default defineContentScript({
  registration: 'runtime',
  noScriptStartedPostMessage: true,
  main: startSubframeReader,
});
