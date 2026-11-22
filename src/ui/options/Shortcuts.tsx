// 快捷键（L4、J4；PROTOTYPE_REPORT 第 4 节「检查没绑上的快捷键」）：列出浏览器里当前实际生效的按键（commands.getAll），
// 有建议键位却没绑上的明确提示，并给出修改入口。浏览器只在首次安装时分配建议键位，与别的扩展或浏览器自己的
// 快捷键冲突时不分配，扩展自己改不了，只能带用户去浏览器的快捷键设置页（用 tabs.create 能打开，普通链接打不开）。
// 设置页与欢迎页共用。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { type ShortcutRow, shortcutRows, shortcutsPageUrl } from './model';
import { S } from './strings';

export function Shortcuts() {
  const [rows, setRows] = useState<ShortcutRow[] | null>(null);
  const [openError, setOpenError] = useState(false);
  const url = shortcutsPageUrl(navigator.userAgent);

  const refresh = useCallback(() => {
    void browser.commands.getAll().then(
      (all) => setRows(shortcutRows(all)),
      () => setRows(shortcutRows([])),
    );
  }, []);

  // 用户去快捷键设置页改完回来，页面重新可见时再查一次
  useEffect(() => {
    refresh();
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  if (rows === null) return <div class="opt-muted">{S.page.loading}</div>;
  const anyUnbound = rows.some((r) => r.unbound);

  return (
    <div class="opt-shortcuts" data-testid="shortcuts">
      <div class="opt-help">{S.shortcuts.help}</div>
      <table class="opt-table">
        <thead>
          <tr>
            <th>{S.shortcuts.command}</th>
            <th>{S.shortcuts.key}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} data-command={r.name} data-unbound={r.unbound ? 'true' : undefined}>
              <td>{r.label}</td>
              <td>
                {r.shortcut !== '' ? (
                  <kbd class="opt-kbd">{r.shortcut}</kbd>
                ) : (
                  <span class="opt-muted">{S.shortcuts.none}</span>
                )}
                {r.unbound && r.suggested !== undefined && (
                  <div class="opt-warn">{S.shortcuts.unbound(r.suggested)}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class={anyUnbound ? 'opt-warn' : 'opt-muted'} role="status" data-testid="shortcut-status">
        {anyUnbound ? S.shortcuts.anyUnbound : S.shortcuts.allBound}
      </div>
      <div class="opt-inline">
        <button
          type="button"
          class={anyUnbound ? 'ra-btn ra-btn--primary' : 'ra-btn'}
          onClick={() => {
            setOpenError(false);
            void browser.tabs.create({ url }).catch(() => setOpenError(true));
          }}
        >
          {S.shortcuts.open}
        </button>
        <button type="button" class="ra-btn" onClick={refresh}>
          {S.shortcuts.refresh}
        </button>
      </div>
      <div class={openError ? 'opt-error' : 'opt-help'}>
        {openError ? S.shortcuts.openFailed(url) : S.shortcuts.manual(url)}
      </div>
    </div>
  );
}

/** 设置页顶部的一行提示：有预设快捷键没绑上时才出现（快捷键小节平时折叠着，没绑上不能等用户自己翻到） */
export function ShortcutNotice() {
  const [unbound, setUnbound] = useState<ShortcutRow[]>([]);
  useEffect(() => {
    void browser.commands.getAll().then(
      (all) => setUnbound(shortcutRows(all).filter((r) => r.unbound)),
      () => undefined,
    );
  }, []);
  if (unbound.length === 0) return null;
  return (
    <div class="opt-banner" role="status" data-testid="shortcut-notice">
      <span>{S.shortcuts.notice(unbound.map((r) => r.suggested ?? r.name))}</span>
      <button
        type="button"
        class="ra-btn ra-btn--small"
        onClick={() =>
          void browser.tabs.create({ url: shortcutsPageUrl(navigator.userAgent) }).catch(() => undefined)
        }
      >
        {S.shortcuts.open}
      </button>
    </div>
  );
}
