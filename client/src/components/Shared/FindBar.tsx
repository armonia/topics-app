import { useEffect, useRef } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { releaseNativeFocus } from '../../lib/shell/tauri';
import { formatFindCounter } from '../Browser/findInPageModel';
import {
  closeFind, finderOf, replaceAll, replaceOne, setFindMatchCase, setFindQuery, setFindReplaceText,
  stepFind, useFindState,
} from '../../state/findRegistry';

/**
 * The find bar of one pane (FIND-01): field, counter, match case, previous,
 * next, close, and a Replace row when the pane's engine can replace.
 *
 * Sta SOPRA il contenuto della pane, nel flusso della sua colonna: non copre
 * una webview nativa, quindi non entra nell'occlusione e non porta né
 * `.native-occlude` né `role="dialog"` (che per `hasOpenModalSurface` la
 * farebbe passare per un modale, ed Esc smetterebbe di fermare il turno anche
 * col cursore fuori dalla barra).
 *
 * Esc is NOT handled here: the window-level capture handler
 * (`useKeyboardShortcuts`) runs before this field ever sees the key, and that
 * is where "Esc in the bar closes the bar and never stops the turn" lives
 * (FIND-03). The `onKeyDown` branch below only covers a mount where that
 * handler is absent.
 */
export function FindBar({ paneId, floating = false }: {
  paneId: string | null;
  /** Over the top-right of the content instead of a row in flow: only where
   *  a row in flow would resize something that must not move (the terminal's
   *  grid, whose program redraws on every resize). */
  floating?: boolean;
}) {
  const tr = useT();
  const st = useFindState(paneId);
  const inputRef = useRef<HTMLInputElement>(null);
  const finder = finderOf(paneId);

  // Every ⌘F: the keyboard comes to this field and the word is selected. The
  // system keyboard first (a native browser pane keeps it otherwise, and the
  // letters would go to the page: `useBrowserChromeBridge.ts`), then the DOM
  // focus.
  useEffect(() => {
    if (!st.open || st.focusTick === 0) return;
    releaseNativeFocus();
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [st.open, st.focusTick]);

  if (!paneId || !st.open) return null;

  const unavailableKey = finder?.unavailableKey;
  const canReplace = !!finder?.replace && !unavailableKey;
  const btn = 'w-6 h-6 flex items-center justify-center rounded text-app-text-muted hover:text-app-text hover:bg-app-hover transition-colors flex-shrink-0 disabled:opacity-40 disabled:pointer-events-none';
  const field = 'flex-1 min-w-0 h-6 px-2 text-compact rounded bg-surface border border-app-border text-app-text placeholder:text-app-text-faint focus:outline-none focus:border-primary disabled:opacity-60';
  const textBtn = 'h-6 px-2 rounded text-mini text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors flex-shrink-0 disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div
      data-find-bar={paneId}
      data-testid="find-bar"
      role="search"
      aria-label={tr('find.bar')}
      className={floating
        ? 'absolute top-1.5 right-2 z-20 w-[min(calc(100%-1rem),26rem)] flex flex-col rounded-md border border-app-border bg-app-bg shadow-lg'
        : 'flex flex-col border-b border-app-border bg-app-bg flex-shrink-0'}
    >
      <div className="flex items-center gap-1.5 px-3 h-9">
        <input
          ref={inputRef}
          value={st.query}
          disabled={!!unavailableKey}
          onChange={(e) => setFindQuery(paneId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void stepFind(paneId, !e.shiftKey);
            } else if (e.key === 'Escape' && !e.defaultPrevented) {
              e.preventDefault();
              closeFind(paneId, { restoreFocus: true });
            }
          }}
          placeholder={tr(finder?.placeholderKey ?? 'find.placeholder')}
          aria-label={tr(finder?.placeholderKey ?? 'find.placeholder')}
          data-testid="find-input"
          spellCheck={false}
          autoComplete="off"
          className={field}
        />
        {unavailableKey ? (
          <span className="text-mini text-app-text-muted truncate min-w-0" data-testid="find-unavailable">
            {tr(unavailableKey)}
          </span>
        ) : st.total !== null && (
          <span
            className="text-mini text-app-text-muted tabular-nums flex-shrink-0 min-w-[6ch] text-right"
            data-testid="find-count"
            aria-live="polite"
          >
            {formatFindCounter(st.index, st.total, tr, st.overLimit)}
          </span>
        )}
        <button
          type="button"
          className={`${btn} ${st.matchCase ? 'text-app-text bg-app-hover' : ''}`}
          title={st.matchCase ? tr('browser.find.caseOn') : tr('browser.find.case')}
          aria-label={tr('browser.find.case')}
          aria-pressed={st.matchCase}
          disabled={!!unavailableKey}
          data-testid="find-matchcase"
          onClick={() => setFindMatchCase(paneId, !st.matchCase)}
        >
          <CaseSensitive size={14} aria-hidden />
        </button>
        <button type="button" className={btn} title={tr('browser.find.prev')} aria-label={tr('browser.find.prev')} disabled={!!unavailableKey} data-testid="find-prev" onClick={() => void stepFind(paneId, false)}>
          <ChevronUp size={14} aria-hidden />
        </button>
        <button type="button" className={btn} title={tr('browser.find.next')} aria-label={tr('browser.find.next')} disabled={!!unavailableKey} data-testid="find-next" onClick={() => void stepFind(paneId, true)}>
          <ChevronDown size={14} aria-hidden />
        </button>
        <button type="button" className={btn} title={tr('browser.find.close')} aria-label={tr('browser.find.close')} data-testid="find-close" onClick={() => closeFind(paneId, { restoreFocus: true })}>
          <X size={14} aria-hidden />
        </button>
      </div>
      {canReplace && (
        <div className="flex items-center gap-1.5 px-3 h-9 border-t border-app-border" data-testid="find-replace-row">
          <input
            value={st.replaceText}
            onChange={(e) => setFindReplaceText(paneId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void replaceOne(paneId); }
            }}
            placeholder={tr('find.replace.placeholder')}
            aria-label={tr('find.replace.placeholder')}
            data-testid="find-replace-input"
            spellCheck={false}
            autoComplete="off"
            className={field}
          />
          <button type="button" className={textBtn} disabled={!st.query} data-testid="find-replace-one" onClick={() => void replaceOne(paneId)}>
            {tr('find.replace.one')}
          </button>
          <button type="button" className={textBtn} disabled={!st.query} data-testid="find-replace-all" onClick={() => replaceAll(paneId)}>
            {tr('find.replace.all')}
          </button>
        </div>
      )}
    </div>
  );
}
