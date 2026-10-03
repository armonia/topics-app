import { createContext, useContext, useSyncExternalStore } from 'react';
import { stepMatchIndex } from '../components/Browser/findInPageModel';

/**
 * ⌘F inside the pane you are on: one bar (`Shared/FindBar`), one finder per
 * pane, keyed by `paneId` (FIND-01, FIND-02).
 *
 * Il registro sta fuori da React per la stessa ragione di
 * `historyCompleteness`: chi chiede (il gestore globale dei tasti, il menu
 * della tab) conosce un `paneId` e niente del tipo di pane, e la barra di una
 * pane deve ritrovarsi com'era quando la pane torna a fuoco. Lo stato della
 * barra quindi vive qui, per pane, e il componente lo legge soltanto.
 *
 * A pane registers a {@link PaneFinder}: the engine (chat route, xterm addon,
 * CodeMirror search, `window.find`, the DOM walker). The registry owns the
 * state the bar draws and drives the engine; engines that learn something on
 * their own (a streaming message, a page mutation, xterm's result event) push
 * it back with {@link reportFindResult}.
 */

export interface FindStepResult {
  /** 1-based; 0 = no current match. */
  index: number;
  total: number;
}

export interface PaneFinder {
  /** Search `query` and return the total. The index restarts from 0. */
  search(query: string, opts: { matchCase: boolean }): Promise<number> | number;
  /** Move to the next or previous match. */
  step(forward: boolean): Promise<FindStepResult> | FindStepResult;
  /** Remove highlights and selection. */
  clear(): void;
  /** Only engines that can replace (the editor, FILE-FIND-01). */
  replace?: {
    one(text: string): Promise<FindStepResult | void> | FindStepResult | void;
    all(text: string): number;
  };
  /** An i18n key: the bar opens with the field disabled and says this. */
  unavailableKey?: string;
  /** Put the focus back where it was in the pane when the bar closes; into
   *  the page itself when the bar was opened from a native page (FIND-03). */
  restoreFocus?(ctx: { openedFromPage: boolean }): void;
  /** Wait this long after the last keystroke before searching. */
  debounceMs?: number;
  /** i18n key of the field's placeholder (defaults to `find.placeholder`). */
  placeholderKey?: string;
}

export interface FindState {
  open: boolean;
  query: string;
  matchCase: boolean;
  /** 1-based; 0 = from rest (a total, no position yet). */
  index: number;
  /** null = nothing searched yet. */
  total: number | null;
  /** Past this many the counter says «over N» without a position. */
  overLimit: number | null;
  replaceText: string;
  /** Bumped on every open: the bar focuses its field and selects the text. */
  focusTick: number;
  /** The bar was opened with the keyboard inside a native page. */
  openedFromPage: boolean;
}

const CLOSED: FindState = Object.freeze({
  open: false, query: '', matchCase: false, index: 0, total: null, overLimit: null,
  replaceText: '', focusTick: 0, openedFromPage: false,
}) as FindState;

interface Entry {
  finder: PaneFinder;
  token: number;
}

const finders = new Map<string, Entry>();
const fallbacks = new Map<string, () => void>();
const states = new Map<string, FindState>();
const listeners = new Map<string, Set<() => void>>();
const searchSeq = new Map<string, number>();
const debounce = new Map<string, ReturnType<typeof setTimeout>>();
/** Where the keyboard was before ⌘F, to give it back on Esc (FIND-03). */
const focusBefore = new Map<string, { focus(): void; isConnected?: boolean } | null>();
let nextToken = 1;

function notify(paneId: string): void {
  const subs = listeners.get(paneId);
  if (subs) for (const fn of [...subs]) fn();
}

function patch(paneId: string, next: Partial<FindState>): void {
  const prev = states.get(paneId) ?? CLOSED;
  states.set(paneId, { ...prev, ...next });
  notify(paneId);
}

export function getFindState(paneId: string): FindState {
  return states.get(paneId) ?? CLOSED;
}

export function subscribeFind(paneId: string, fn: () => void): () => void {
  let set = listeners.get(paneId);
  if (!set) { set = new Set(); listeners.set(paneId, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(paneId);
  };
}

/** React binding: the bar state of one pane. */
export function useFindState(paneId: string | null): FindState {
  return useSyncExternalStore(
    (fn) => (paneId ? subscribeFind(paneId, fn) : () => {}),
    () => (paneId ? getFindState(paneId) : CLOSED),
    () => CLOSED,
  );
}

/**
 * A pane says it has text to search. Returns the unregister function. A later
 * registration for the same pane replaces the earlier one, and the earlier
 * one's unregister then does nothing (a remount must not lose the bar).
 */
export function registerFinder(paneId: string, finder: PaneFinder): () => void {
  const token = nextToken++;
  finders.set(paneId, { finder, token });
  notify(paneId);
  return () => {
    const cur = finders.get(paneId);
    if (!cur || cur.token !== token) return;
    finders.delete(paneId);
    const t = debounce.get(paneId);
    if (t) clearTimeout(t);
    debounce.delete(paneId);
    states.delete(paneId);
    notify(paneId);
  };
}

export function hasFinder(paneId: string | null | undefined): boolean {
  return !!paneId && finders.has(paneId);
}

/** The pane with no finder but somewhere to put the cursor (the board's filter). */
export function registerFindFallback(paneId: string, focus: () => void): () => void {
  fallbacks.set(paneId, focus);
  return () => { if (fallbacks.get(paneId) === focus) fallbacks.delete(paneId); };
}

export function runFindFallback(paneId: string | null | undefined): boolean {
  const fn = paneId ? fallbacks.get(paneId) : undefined;
  if (!fn) return false;
  fn();
  return true;
}

/**
 * Open the bar of `paneId`. `false` = the pane has no finder, the caller falls
 * back. Opening an open bar focuses its field again with the text selected.
 */
export function openFind(paneId: string | null | undefined, opts: { fromPage?: boolean } = {}): boolean {
  if (!paneId || !finders.has(paneId)) return false;
  const prev = getFindState(paneId);
  if (!prev.open) {
    const active = typeof document !== 'undefined' ? document.activeElement as (HTMLElement | null) : null;
    focusBefore.set(paneId, active && active !== document.body && !active.closest?.('[data-find-bar]') ? active : null);
  }
  patch(paneId, {
    open: true,
    focusTick: prev.focusTick + 1,
    openedFromPage: prev.open ? prev.openedFromPage || !!opts.fromPage : !!opts.fromPage,
  });
  // Reopened with the last word still there: search it again, the highlights
  // went away with the close.
  if (!prev.open && prev.query) runSearch(paneId, 0);
  return true;
}

export function isFindOpen(paneId: string | null | undefined): boolean {
  return !!paneId && getFindState(paneId).open;
}

/** Close the bar: highlights go, the word stays for the next open. */
export function closeFind(paneId: string, opts: { restoreFocus?: boolean } = {}): void {
  const entry = finders.get(paneId);
  const openedFromPage = getFindState(paneId).openedFromPage;
  const t = debounce.get(paneId);
  if (t) clearTimeout(t);
  debounce.delete(paneId);
  searchSeq.set(paneId, (searchSeq.get(paneId) ?? 0) + 1);
  patch(paneId, { open: false, index: 0, total: null, overLimit: null, openedFromPage: false });
  entry?.finder.clear();
  const before = focusBefore.get(paneId) ?? null;
  focusBefore.delete(paneId);
  if (!opts.restoreFocus) return;
  // The page first: a native page is not a DOM element we could hold on to.
  if (openedFromPage || !before || before.isConnected === false) entry?.finder.restoreFocus?.({ openedFromPage });
  else before.focus();
}

function runSearch(paneId: string, delayMs: number): void {
  const entry = finders.get(paneId);
  if (!entry) return;
  const prevT = debounce.get(paneId);
  if (prevT) clearTimeout(prevT);
  const seq = (searchSeq.get(paneId) ?? 0) + 1;
  searchSeq.set(paneId, seq);
  const go = () => {
    debounce.delete(paneId);
    const st = getFindState(paneId);
    if (!st.open) return;
    if (!st.query) {
      entry.finder.clear();
      patch(paneId, { index: 0, total: null, overLimit: null });
      return;
    }
    const apply = (total: number) => {
      if (searchSeq.get(paneId) !== seq) return;
      patch(paneId, { total, index: 0 });
    };
    try {
      const r = entry.finder.search(st.query, { matchCase: st.matchCase });
      if (typeof r === 'number') apply(r);
      else void r.then(apply, () => apply(0));
    } catch {
      apply(0);
    }
  };
  if (delayMs <= 0) go();
  else debounce.set(paneId, setTimeout(go, delayMs));
}

export function setFindQuery(paneId: string, query: string): void {
  patch(paneId, { query, index: 0, overLimit: null, ...(query ? {} : { total: null }) });
  runSearch(paneId, finders.get(paneId)?.finder.debounceMs ?? 60);
}

export function setFindMatchCase(paneId: string, matchCase: boolean): void {
  patch(paneId, { matchCase, index: 0 });
  runSearch(paneId, 0);
}

export function setFindReplaceText(paneId: string, replaceText: string): void {
  patch(paneId, { replaceText });
}

/** Enter / ⇧Enter / ⌘G / ⇧⌘G. */
export async function stepFind(paneId: string, forward: boolean): Promise<void> {
  const entry = finders.get(paneId);
  const st = getFindState(paneId);
  if (!entry || !st.open || !st.query) return;
  // A search still waiting for its debounce runs first: Enter right after the
  // last letter must step through the results of THAT word.
  if (debounce.has(paneId)) {
    clearTimeout(debounce.get(paneId)!);
    runSearch(paneId, 0);
  }
  const seq = searchSeq.get(paneId);
  const r = await entry.finder.step(forward);
  if (searchSeq.get(paneId) !== seq) return;
  patch(paneId, { index: r.index, total: r.total });
}

/** An engine learned a new total (or index) on its own. */
export function reportFindResult(paneId: string, r: { total?: number; index?: number; overLimit?: number | null }): void {
  if (!getFindState(paneId).open) return;
  const next: Partial<FindState> = {};
  if (r.total !== undefined) next.total = r.total;
  if (r.index !== undefined) next.index = r.index;
  if (r.overLimit !== undefined) next.overLimit = r.overLimit;
  patch(paneId, next);
}

export async function replaceOne(paneId: string): Promise<void> {
  const entry = finders.get(paneId);
  const st = getFindState(paneId);
  if (!entry?.finder.replace || !st.query) return;
  const r = await entry.finder.replace.one(st.replaceText);
  if (r) patch(paneId, { index: r.index, total: r.total });
  else runSearch(paneId, 0);
}

export function replaceAll(paneId: string): number {
  const entry = finders.get(paneId);
  const st = getFindState(paneId);
  if (!entry?.finder.replace || !st.query) return 0;
  const n = entry.finder.replace.all(st.replaceText);
  runSearch(paneId, 0);
  return n;
}

export function finderOf(paneId: string | null | undefined): PaneFinder | null {
  return (paneId && finders.get(paneId)?.finder) || null;
}

/**
 * The step most engines use: the index is kept by the client and the engine
 * only moves its own selection (`window.find`, the DOM walker, the chat).
 */
export function nextIndex(paneId: string, total: number, forward: boolean): number {
  return stepMatchIndex(getFindState(paneId).index, total, forward);
}

/** Minimal element shape `resolveFindPane` reads, so it is testable without a DOM. */
export interface FindTargetLike {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * Which pane ⌘F is about.
 * 1. The pane the keyboard is in (`[data-find-pane]` up from the target).
 * 2. With the focus on nothing (body) or in a native page (the shell's
 *    synthetic keydown targets `window`): the focused tab, `data-focused`,
 *    first one that has a finder or a fallback.
 * 3. The app-level focused panel.
 */
export function resolveFindPane(
  target: FindTargetLike | null,
  focusedTabIds: readonly string[],
  focusedPanelId: string | null,
): string | null {
  const known = (id: string | null | undefined): id is string => !!id && (finders.has(id) || fallbacks.has(id));
  const own = target?.closest('[data-find-pane]')?.getAttribute('data-find-pane') ?? null;
  if (known(own)) return own;
  if (own) return own;
  for (const id of focusedTabIds) if (known(id)) return id;
  return known(focusedPanelId) ? focusedPanelId : (focusedTabIds[0] ?? focusedPanelId ?? null);
}

/** Test hook. */
export function _resetFindRegistry(): void {
  for (const t of debounce.values()) clearTimeout(t);
  finders.clear(); fallbacks.clear(); states.clear(); listeners.clear(); searchSeq.clear(); debounce.clear(); focusBefore.clear();
}

/**
 * The id of the pane a subtree belongs to, published by the pane host
 * (`PaneKeepAlive`), so a pane body registers its finder without having its
 * id threaded through every layout component.
 */
export const FindPaneContext = createContext<string | null>(null);

export function useFindPaneId(): string | null {
  return useContext(FindPaneContext);
}
