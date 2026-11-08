import { useEffect } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search';
import { getFindState, registerFinder, reportFindResult, type PaneFinder } from '../../state/findRegistry';

/** Decorations of the terminal's matches: the colours must be `#RRGGBB`. */
const TERMINAL_FIND_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBorder: '#facc15',
  matchOverviewRuler: '#facc15',
  activeMatchBackground: '#f97316',
  activeMatchBorder: '#f97316',
  activeMatchColorOverviewRuler: '#f97316',
};

/** The addon's default `highlightLimit`: past it, no position (TERM-FIND-01). */
const TERMINAL_FIND_LIMIT = 1000;

/**
 * The terminal's finder (TERM-FIND-01): `@xterm/addon-search` over what xterm
 * holds (screen + scrollback). Total and position come from the addon's
 * `onDidChangeResults`; past its limit of 1000 the index is -1 and the counter
 * says «over 1000», while Enter keeps moving. Nothing is written to the
 * program: the bar is a DOM field outside xterm. Closing gives the keyboard
 * back to the terminal.
 */
export function useTerminalFinder(
  paneId: string,
  termRef: { current: { term: Terminal } | null },
  searchRef: { current: SearchAddon | null },
): void {
  useEffect(() => {
    let query = '';
    let opts: ISearchOptions = {};
    let last = { index: -1, count: 0 };
    let waiters: Array<() => void> = [];
    let sub: { dispose(): void } | null = null;
    let subscribedTo: SearchAddon | null = null;
    const listen = () => {
      const engine = searchRef.current;
      if (!engine || engine === subscribedTo) return;
      sub?.dispose();
      subscribedTo = engine;
      sub = engine.onDidChangeResults(({ resultIndex, resultCount }) => {
        last = { index: resultIndex, count: resultCount };
        const over = resultCount >= TERMINAL_FIND_LIMIT ? TERMINAL_FIND_LIMIT : null;
        if (getFindState(paneId).open && query) reportFindResult(paneId, { total: resultCount, index: resultIndex >= 0 ? resultIndex + 1 : 0, overLimit: over });
        const w = waiters;
        waiters = [];
        for (const fn of w) fn();
      });
    };
    /** The addon answers through its event: wait for it, briefly. */
    const settle = () => new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 200);
    });
    const finder: PaneFinder = {
      placeholderKey: 'find.terminal.placeholder',
      debounceMs: 60,
      async search(q, o) {
        listen();
        query = q;
        opts = { caseSensitive: o.matchCase, decorations: TERMINAL_FIND_DECORATIONS };
        const engine = searchRef.current;
        if (!engine) return 0;
        const wait = settle();
        // Incremental, as in every terminal's find: the first match is selected.
        engine.findNext(q, { ...opts, incremental: true });
        await wait;
        const found = last;
        // The registry stores {total, index: 0} after this resolves; the
        // addon's own position follows right after.
        setTimeout(() => reportFindResult(paneId, {
          index: found.index >= 0 ? found.index + 1 : 0,
          overLimit: found.count >= TERMINAL_FIND_LIMIT ? TERMINAL_FIND_LIMIT : null,
        }), 0);
        return found.count;
      },
      async step(forward) {
        listen();
        const engine = searchRef.current;
        if (!engine || !query) return { index: 0, total: 0 };
        const wait = settle();
        if (forward) engine.findNext(query, opts);
        else engine.findPrevious(query, opts);
        await wait;
        return { index: last.index >= 0 ? last.index + 1 : 0, total: last.count };
      },
      clear() {
        query = '';
        searchRef.current?.clearDecorations();
        termRef.current?.term.clearSelection();
      },
      restoreFocus() { termRef.current?.term.focus(); },
    };
    const off = registerFinder(paneId, finder);
    return () => { off(); sub?.dispose(); };
  }, [paneId, termRef, searchRef]);
}
