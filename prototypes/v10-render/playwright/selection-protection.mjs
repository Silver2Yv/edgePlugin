/**
 * V-10"用户选区与阅读位置保护"的真机验证（需要真实浏览器，vitest+happy-dom 无法
 * 提供真正的 Selection / scroll / focus 行为，所以单独用 Playwright 跑）。
 *
 * 用法：node playwright/selection-protection.mjs
 * 需要本机已有 Chrome for Testing，路径由环境变量 E2E_CHROMIUM_PATH 指定
 * （对齐主项目 CLAUDE.md 的约定），默认回退到 D:\tmp\cft\chrome.exe。
 *
 * 验证点（对应任务要求的"选中块延迟替换、不自动滚动、不抢焦点"）：
 * 1. 用户在"已完成块"里选中一段文字。
 * 2. 模拟连续多次流式增量（只追加最后一个 open 块的内容，已完成块节点不变）。
 * 3. 断言：选区文本不变、选区所在节点不变（没有被整体替换掉）、
 *    window.scrollY 不变（没有自动滚动）、document.activeElement 不变（没有被抢焦点）。
 */
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const chromePath = process.env.E2E_CHROMIUM_PATH || 'D:\\tmp\\cft\\chrome.exe';
const harnessPath = path.resolve(import.meta.dirname, 'harness.html');

function fail(message) {
  console.error('[V-10 Playwright 验证] 失败：' + message);
  process.exitCode = 1;
}

async function main() {
  if (!fs.existsSync(chromePath)) {
    console.log(`[V-10 Playwright 验证] 环境阻塞：未找到 Chrome for Testing（${chromePath}），已跳过，不伪造通过。`);
    process.exitCode = 3;
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
  } catch (err) {
    console.log(`[V-10 Playwright 验证] 环境阻塞：启动 Chrome for Testing 失败：${err?.message ?? err}`);
    process.exitCode = 3;
    return;
  }

  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(harnessPath).href);

    // 1) 先让用户聚焦到一个输入框，模拟"用户正在别处操作，不应被打断"。
    await page.focus('#focus-target');

    // 2) 在已完成块一里选中文字 "ALPHA" 前后的一段。
    await page.evaluate(() => {
      const el = document.getElementById('finalized-1');
      const textNode = el.firstChild;
      const range = document.createRange();
      // 选中 "一段文字 ALPHA" 这一子串
      const full = textNode.data;
      const start = full.indexOf('一段文字');
      const end = full.indexOf('ALPHA') + 'ALPHA'.length;
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      window.__v10SelectedText = sel.toString();
      window.__v10SelectedNode = textNode;
      window.__v10ScrollYBefore = window.scrollY;
      window.__v10ActiveBefore = document.activeElement.id;
    });

    const before = await page.evaluate(() => ({
      selectedText: window.__v10SelectedText,
      scrollY: window.__v10ScrollYBefore,
      activeId: window.__v10ActiveBefore
    }));

    // 3) 模拟连续 20 次流式增量追加（只影响 open 块）。
    await page.evaluate(() => window.__v10RunStream(20));
    await page.waitForTimeout(50);

    // 4) 再次读取选区、滚动位置、焦点，并确认选中的文本节点对象引用没变（已完成块未被整体替换）。
    const after = await page.evaluate(() => {
      const sel = window.getSelection();
      const el = document.getElementById('finalized-1');
      return {
        selectedText: sel.toString(),
        scrollY: window.scrollY,
        activeId: document.activeElement.id,
        sameTextNode: el.firstChild === window.__v10SelectedNode,
        openBlockText: document.getElementById('block-open').textContent
      };
    });

    let ok = true;
    if (after.selectedText !== before.selectedText || after.selectedText.length === 0) {
      fail(`选区文本在增量更新后发生变化：之前="${before.selectedText}"，之后="${after.selectedText}"`);
      ok = false;
    }
    if (!after.sameTextNode) {
      fail('已完成块的文本节点被整体替换，选区所在的节点引用已失效（即便浏览器可能保留文本不变，节点身份也不应该变）。');
      ok = false;
    }
    if (after.scrollY !== before.scrollY) {
      fail(`发生了自动滚动：之前 scrollY=${before.scrollY}，之后=${after.scrollY}`);
      ok = false;
    }
    if (after.activeId !== before.activeId) {
      fail(`焦点被抢占：之前 activeElement=#${before.activeId}，之后=#${after.activeId}`);
      ok = false;
    }
    if (!after.openBlockText.includes('第 20 次')) {
      fail('open 块没有正确累积流式增量内容，复现页本身可能有问题。');
      ok = false;
    }

    if (ok) {
      console.log('[V-10 Playwright 验证] 通过：选区文本/节点、滚动位置、焦点在流式增量过程中均未被打断。');
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[V-10 Playwright 验证] 脚本异常：', err);
  process.exitCode = 1;
});
