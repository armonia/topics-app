/**
 * A browser tab's kind in words, for the tab bar's accessible names.
 *
 * Out of `BrowserTabChrome.tsx` because that file exports components only:
 * Fast Refresh cannot hot-swap a module that also exports a function and a hook.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { browserTabKind, type BrowserTabKind } from './browserTabKind';
import {
  getBrowserPaneChrome, subscribeBrowserPaneChrome, type BrowserPaneChrome,
} from '../../state/browserPaneChrome';
import { useT } from '../../hooks/useT';

/**
 * THE KIND IN WORDS, for the tab's accessible name and tooltip: the corner can
 * be taken by the console errors, and a glyph does not speak anyway.
 *
 * The short form on purpose: no agent action, no CPU share. Those change every
 * few seconds, and this text is read by the whole tab bar, which must render
 * again only when a tab's kind changes. The corner mark's own tooltip keeps
 * the long form.
 */
export function browserKindName(
  kind: BrowserTabKind,
  chrome: Pick<BrowserPaneChrome, 'engineExtensions'>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (kind) {
    case 'agent': return t('browser.tab.kind.agent');
    case 'disconnected': return t('browser.tab.kind.disconnected');
    case 'connecting': return t('browser.tab.kind.connecting');
    case 'degraded': return t('browser.tab.kind.degraded');
    case 'heavy-paused': return t('browser.tab.kind.heavyPaused');
    case 'heavy': return t('browser.tab.kind.heavyShort');
    case 'chromium': return t('browser.tab.kind.chromium', { n: String(chrome.engineExtensions ?? 0) });
    case 'shared': return t('browser.tab.kind.shared');
  }
}

/** Row and field separators of the snapshot below: never in a pane id. */
const ROW_SEP = '\u0001';
const FIELD_SEP = '\u0000';

/**
 * The kind of every browser tab in a bar, in words (`browserKindName`), keyed
 * by pane id. Tabs without a kind are absent.
 *
 * ONE SUBSCRIPTION FOR THE BAR, whose tabs are drawn inside a `map` where a
 * per-tab hook cannot live. The snapshot is a string, so a favicon or a zoom
 * change in some pane re-renders nothing: only a changed name does.
 */
export function useBrowserKindNames(paneIds: readonly string[]): ReadonlyMap<string, string> {
  const t = useT();
  const key = paneIds.join(ROW_SEP);
  const subscribeAll = useCallback((fn: () => void) => {
    const offs = key ? key.split(ROW_SEP).map((id) => subscribeBrowserPaneChrome(id, fn)) : [];
    return () => { for (const off of offs) off(); };
  }, [key]);
  const snapshot = useSyncExternalStore(
    subscribeAll,
    () => {
      let out = '';
      for (const id of key ? key.split(ROW_SEP) : []) {
        const chrome = getBrowserPaneChrome(id);
        const kind = chrome ? browserTabKind(chrome) : undefined;
        if (chrome && kind) out += `${id}${FIELD_SEP}${browserKindName(kind, chrome, t)}${ROW_SEP}`;
      }
      return out;
    },
    () => '',
  );
  return useMemo(() => new Map(
    snapshot.split(ROW_SEP).filter(Boolean).map((row) => row.split(FIELD_SEP) as [string, string]),
  ), [snapshot]);
}
