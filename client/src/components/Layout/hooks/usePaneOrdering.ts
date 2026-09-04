/**
 * usePaneOrdering — Hook 1 of the StandaloneChatGroup refactor (PLAN v2).
 *
 * Owns ALL state and protocols centred on `orderedIds` + `pinnedIds`. This
 * is the only place `setOrderedIds` and `setPinnedIds` exist. Consumers
 * mutate state exclusively through `ops.*`; setters are never leaked
 * across hook seams (CRITIQUE B2).
 *
 * Path 4 (PLAN v2 / VERIFY D6): `activePaneId` is derived inside this hook
 * from `validatedOrderedIds + focusedPanelId`, eliminating the cyclic-dep
 * with `useActivePaneState` and the first-mount race risk.
 *
 * Effect declaration order is significant — see PLAN §"Effect ordering".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isBrowserPaneId,
  isProjectPaneId,
  isTerminalPaneId,
  isDraftPaneId,
  createPaneId,
  loadPanelOrder,
  getBrowserContextFromPaneId,
} from '../../../state/pane/adapters';
import { isUtilityPanelId } from '../UtilityPanel';
import { replaceInList, consumeTabRestored } from '../../../lib/previewTabs';
import { resolveBrowserNavigateUrl } from '../../../lib/browserNavUrl';
import type { WSMessage } from '../../../types';
import type { UsePaneOrderingArgs, UsePaneOrderingReturn } from './standaloneTypes';
import { reconcilePaneOrder } from './paneOrderReconcile';
import { usePaneStore } from '../../../state/pane/store';
import { openPane } from '../../../state/pane/actions';
import { setBrowserSpawner } from '../../../state/browserSpawner';
import { persistBrowserPaneUrl } from '../../../state/pane/browserPaneUrl';
import { OPEN_TAB_EVENT, type OpenTabDetail } from '../../../lib/openLink';
import { insertPaneAfter } from '../../../lib/openTabTarget';

/**
 * Phase 30.1 polish — persist a browser pane in the global pane store so
 * it survives renderer reload (Cmd+R, Vite HMR, dev restart). Without this
 * the browser pane only lived in `usePaneOrdering`'s local `orderedIds`
 * useState, and `loadPanelOrder()` (which seeds initial state from the
 * store on mount) returned an array missing the browser pane → tab lost
 * on every reload.
 */
// Active tab of the standalone (persistOrder) group, persisted so a full
// reload restores it as the focused-elsewhere fallback. Device-local; only the
// main standalone group writes it.
const STANDALONE_ACTIVE_KEY = 'topics-standalone-active-pane';
function readStandaloneActivePane(): string | null {
  try { return localStorage.getItem(STANDALONE_ACTIVE_KEY) || null; } catch { return null; }
}
function writeStandaloneActivePane(id: string): void {
  try { localStorage.setItem(STANDALONE_ACTIVE_KEY, id); } catch { /* quota / private mode */ }
}

function persistBrowserPane(paneId: string): void {
  if (!isBrowserPaneId(paneId)) return;
  try {
    const state = usePaneStore.getState();
    const group = state.groups['group:default'];
    if (group?.paneIds.includes(paneId)) return; // Already persisted
    state.dispatch(openPane({
      id: paneId,
      type: 'browser',
      groupId: 'group:default',
    }));
  } catch (err) {
    console.warn('[usePaneOrdering] persistBrowserPane failed:', err);
  }
}

/** Same persistence, but the tab lands right AFTER `afterPaneId` instead of at
 *  the end of the strip: a tab opened from the tab you are on shows up next to
 *  it. Falls back to appending when the anchor is unknown. */
function persistBrowserPaneAfter(paneId: string, afterPaneId?: string): void {
  if (!isBrowserPaneId(paneId)) return;
  try {
    const state = usePaneStore.getState();
    const group = state.groups['group:default'];
    if (group?.paneIds.includes(paneId)) return; // already persisted
    const at = afterPaneId ? group?.paneIds.indexOf(afterPaneId) ?? -1 : -1;
    state.dispatch(openPane({
      id: paneId,
      type: 'browser',
      groupId: 'group:default',
      ...(at >= 0 ? { insertIndex: at + 1 } : {}),
    }));
  } catch (err) {
    console.warn('[usePaneOrdering] persistBrowserPaneAfter failed:', err);
  }
}

/**
 * Ask the standalone grid to split a freshly opened browser pane out of the
 * tab bar into its own cell, so a session-opened browser lands BESIDE the chat
 * (not stacked as a tab the user has to find). The orientation (side-by-side vs
 * stacked) is decided by available space in PanelGrid's auto-solo effect; here
 * we only signal which pane to solo. usePanelLifecycle listens and feeds it
 * into the existing `pendingSoloPanelId` plumbing (which is idempotent — a pane
 * already in its own cell is left alone, so re-opening just navigates in place).
 */
function requestBrowserSolo(paneId: string): void {
  if (!isBrowserPaneId(paneId)) return;
  try {
    window.dispatchEvent(new CustomEvent('browser:request-solo', { detail: { paneId } }));
  } catch { /* SSR / no window — no-op */ }
}

/** Any browser pane already open at the app level (group:default), regardless of
 *  which solo cell renders it. Browser panes always persist here via
 *  persistBrowserPane, so this is the single source of truth for "is there
 *  already a browser pane anywhere?" — see browserSingletonReducer case 2b. */
function findGlobalBrowserPaneId(): string | null {
  try {
    const ids = usePaneStore.getState().groups['group:default']?.paneIds ?? [];
    return ids.find(isBrowserPaneId) ?? null;
  } catch {
    return null;
  }
}

/**
 * CHI RIVENDICA UN «apri il browser su questa URL». Decisione pura, condivisa
 * dalle due porte che la fanno (WS `browser:navigate` ed evento DOM
 * `browser:open-and-navigate`): erano copie, e sono divergite — la DOM è stata
 * corretta il 10/07/2026 (CHAT-REL-03), la WS è rimasta com'era fino all'
 * 11/08/2026, quando `open_browser_pane` è stato visto aprire un contesto vivo
 * senza montare nessun pannello.
 *
 * La regola, in una riga: con un topicId decide la MEMBERSHIP, non la presenza
 * di un progetto.
 *  · topicId presente ⇒ questo gruppo rivendica solo se quella topic è una sua
 *    tab. Una topic di progetto non viene quindi dirottata qui
 *    (`useProjectBrowserPanes` la prende), e una topic SENZA progetto non resta
 *    orfana solo perché nel gruppo c'è anche una tab di progetto aperta — che
 *    era il guasto: il gruppo standalone scaricava il frame sulla finestra di
 *    progetto, e quella lo rifiutava perché la topic non era sua.
 *  · topicId assente ⇒ non si sa attribuire il produttore, e il vecchio
 *    «c'è un pannello progetto qui dentro? lascia fare a lui» resta l'unica
 *    euristica disponibile.
 */
export function groupClaimsBrowserNavigate(args: {
  topicId?: string;
  hasProjectPane: boolean;
  orderedIds: string[];
}): boolean {
  if (!args.topicId) return !args.hasProjectPane;
  return args.orderedIds.includes(args.topicId);
}

/**
 * Singleton reducer shared by `ensureBrowserPane` op and the WS
 * browser:navigate listener. Keeps the swap/reuse/create logic DRY.
 */
// Exported for the co-located bun:test unit (pure function).
export function browserSingletonReducer(
  prev: string[],
  contextId?: string,
): { next: string[]; resolvedId: string } {
  const targetId = contextId ? createPaneId('browser', contextId) : null;
  // 1. Exact-match pane already exists.
  if (targetId && prev.includes(targetId)) {
    return { next: prev, resolvedId: targetId };
  }
  // 1b. contextId given but no exact match → CREATE `browser:<ctx>` (case 3).
  // This used to rebind whatever browser pane the group already had onto the
  // new contextId — the second chat tab silently STOLE the first chat's
  // browser (pane, URL, CDP target). One browser per CONTEXT, mirroring the
  // project path's ensureBrowserPaneAndNavigate fix; the group can now host
  // multiple browser tabs, one per spawning context.
  // 2. Any browser pane exists in THIS instance's ordered ids — reuse it, but
  // ONLY for context-less (legacy) opens.
  if (!targetId) {
    const existing = prev.find(id => isBrowserPaneId(id));
    if (existing) {
      return { next: prev, resolvedId: existing };
    }
  }
  // 2b. A browser pane already exists ELSEWHERE in the app — e.g. one was solo'd
  // into another cell, or this is a solo'd chat cell whose `prev` only holds its
  // own topic. Each StandaloneChatGroup runs this reducer over its OWN `prev`,
  // so without a global check two instances could each "create" and we'd get a
  // duplicate browser pane (each createPaneId('browser') mints a fresh UUID).
  // Reuse the existing one instead — mirrors the project path's
  // `find(p => p.type === 'browser')`. Only for the non-contextId path; a
  // contextId open is deterministic and already deduped by case 1.
  if (!targetId) {
    const globalBrowser = findGlobalBrowserPaneId();
    if (globalBrowser) return { next: prev, resolvedId: globalBrowser };
  }
  // 3. No browser pane anywhere → create one.
  const newId = targetId ?? createPaneId('browser');
  return { next: [...prev, newId], resolvedId: newId };
}

export function usePaneOrdering(args: UsePaneOrderingArgs): UsePaneOrderingReturn {
  const {
    topicIds,
    persistOrder,
    onClosePanel,
    onFocusPanel,
    onWSMessage,
    pendingBrowserPane,
    onPendingBrowserPaneConsumed,
    onUtilityPaneChange,
    onOpenBrowserContextIds,
    panelInitialTab,
    onPanelInitialTabConsumed,
    focusedPanelId,
    onBrowserNavigateUrl,
  } = args;

  // 1. Track order locally for tab reordering
  const [orderedIds, setOrderedIds] = useState<string[]>(() => {
    if (!persistOrder) return topicIds;
    const saved = loadPanelOrder();
    if (saved.order.length > 0) {
      const savedSet = new Set(saved.order);
      const existing = saved.order.filter(id => topicIds.includes(id) || isBrowserPaneId(id));
      const added = topicIds.filter(id => !savedSet.has(id));
      return [...existing, ...added];
    }
    return topicIds;
  });

  // 2. Track which panes have been pinned (not preview)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    if (!persistOrder) return new Set();
    const saved = loadPanelOrder();
    return new Set(saved.pinned);
  });

  // 3. Validated ordered IDs (ISSUE 2 guard) — orderedIds must NEVER contain
  // an ID not in openPanels (topicIds), NOR the same id twice. Returns ref
  // unchanged when no prune and no dedupe.
  //
  // Strict filter: an entry survives ONLY if its id is in `topicIds`. The
  // earlier code added `|| isBrowserPaneId(id) || isSessionViewerPaneId(id)`
  // to bridge a hypothetical race where `ensureBrowserPane` mutated local
  // `orderedIds` *before* the parent's `topicIds` prop caught up via the
  // store sync. In practice the dispatch+setState pair is batched by React,
  // so the parent re-renders in the same commit with `topicIds` already
  // including the new browser/session id. The allowance was actively harmful
  // when a browser pane was solo'd by `PanelGrid.handleSplitPane`: the
  // standalone group's `topicIds` (which is `regularPanels` filtered
  // against `soloTopicIds`) drops the solo'd browser, but the allowance
  // kept the same id alive in `orderedIds` here, leaving the pane
  // duplicated across the standalone tab bar AND the new solo cell.
  //
  // De-dup by identity (reconcilePaneOrder): `orderedIds` is a persisted second
  // source over the store's open set — a save/merge/external write that carried
  // the same id twice used to render one pane as two or three identical tabs
  // ("3 tab su un solo pane"). The strip must be a pure function of its store:
  // one id ⇒ one tab. The echo effect below writes the reconciled list back,
  // healing the persisted order.
  const validatedOrderedIds = useMemo(
    () => reconcilePaneOrder(orderedIds, topicIds),
    [orderedIds, topicIds],
  );

  // 4. Validation echo — must stay co-located with the memo + state (B3).
  useEffect(() => {
    if (validatedOrderedIds !== orderedIds) {
      setOrderedIds(validatedOrderedIds);
    }
  }, [validatedOrderedIds, orderedIds]);


  // 5. effectivePinnedIds with contents-equality cache (ISSUE 23 / B7).
  const prevEffectivePinnedRef = useRef<Set<string>>(new Set());
  const effectivePinnedIds = useMemo(() => {
    const s = new Set(pinnedIds);
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id) || isUtilityPanelId(id) || isBrowserPaneId(id) || isTerminalPaneId(id) || isDraftPaneId(id)) s.add(id);
    }
    const prev = prevEffectivePinnedRef.current;
    // eslint-disable-next-line react-hooks/refs -- intentional contents-equality cache: read the previous Set to return a stable reference when contents are unchanged (avoids downstream memo churn); the read happens only inside this memo's compute
    if (s.size === prev.size && [...s].every(id => prev.has(id))) {
      return prev;
    }
    // eslint-disable-next-line react-hooks/refs -- intentional contents-equality cache: store the freshly-computed Set so the next compute can compare against it; mutation is idempotent w.r.t. render output
    prevEffectivePinnedRef.current = s;
    return s;
  }, [pinnedIds, validatedOrderedIds]);
  /** La tab che QUESTA sessione ha aperto come anteprima — l'unica che una
   *  apertura singola può sostituire. Vive solo in memoria di proposito:
   *  «essere l'anteprima» è un fatto di questa finestra e di questo momento, non
   *  qualcosa che si eredita da uno snapshot del server. */
  const previewPaneIdRef = useRef<string | null>(null);
  // eslint-disable-next-line react-hooks/refs -- useRef only reads this initial value on the first render to seed the mirror ref; subsequent syncs happen in the effect below (the value is ref-derived via the contents-equality cache, hence the transitive flag)
  const pinnedIdsRef = useRef(effectivePinnedIds);
  useEffect(() => { pinnedIdsRef.current = effectivePinnedIds; });

  // Live mirror of orderedIds for callbacks that must RESOLVE synchronously
  // (ensureBrowserPane) — a setState updater is not a synchronous read: React
  // only evaluates it eagerly when the fiber has no pending work.
  const orderedIdsRef = useRef(orderedIds);
  useEffect(() => { orderedIdsRef.current = orderedIds; });

  // 6. Preview-replacement protocol — 3 refs + 2 effects, all co-located (B4).
  const prevTopicIdsRef = useRef(topicIds);
  const pendingCloseRef = useRef<string | null>(null);
  useEffect(() => {
    const prevTopicIds = prevTopicIdsRef.current;
    prevTopicIdsRef.current = topicIds;

    const wasAdded = topicIds.length > prevTopicIds.length;

    // A REOPENED (restored) tab is additive — it must never be treated as a
    // preview-navigation that replaces (and closes) the current preview tab.
    // Consume the one-shot restore marker set by the reopen path (see
    // lib/previewTabs markTabRestored). Computed OUTSIDE the setOrderedIds
    // updater so the consume runs exactly once (the updater may re-run under
    // StrictMode / batching). `addedDelta` is derived from the topicIds delta,
    // matching what the reopen actually appended.
    const addedDelta = topicIds.filter(id => !prevTopicIds.includes(id));
    // Consume the restore marker for EVERY added id so a marker can never linger
    // (e.g. a reopen that arrived inside a 2-tab batch) and suppress a genuine
    // preview-navigation later. Only a single-tab restore skips the replace.
    let restoredAdds = 0;
    for (const id of addedDelta) {
      if (consumeTabRestored(id)) restoredAdds++;
    }
    const isRestore = wasAdded && addedDelta.length === 1 && restoredAdds === 1;

    setOrderedIds(prev => {
      const existing = prev.filter(id => {
        if (isBrowserPaneId(id)) return true;
        return topicIds.includes(id);
      });
      const added = topicIds.filter(id => !prev.includes(id));

      if (wasAdded && added.length === 1 && !isRestore) {
        // QUALE tab viene sostituita: quella che QUESTA sessione ha aperto come
        // anteprima, non «la prima non fissata».
        //
        // `findPreviewInList` prendeva la prima non fissata, e l'insieme delle
        // fissate arriva da `loadPanelOrder()`, che restituisce `pinned: []`
        // SEMPRE — su ogni dispositivo, a ogni mount. Con l'insieme vuoto ogni
        // tab è un'anteprima, quindi la candidata era semplicemente la PRIMA
        // della lista: una chat ripristinata dal server, che nessuno aveva
        // aperto come anteprima.
        //
        // E sostituire non è nascondere: chiude la pane, e nel modello a due
        // stati chiudere una chat la ARCHIVIA — per tutti i dispositivi. Aprire
        // una chat ne archiviava un'altra.
        //
        // Ricordare l'id invece di dedurlo toglie il problema alla radice, e non
        // passa dal flag `preview` della pane — che per le chat standalone è
        // DERIVATO dall'insieme delle fissate, quindi leggerlo per decidere
        // sarebbe circolare (provato: rompe le tab in corsivo).
        //
        // Al mount non c'è nessuna anteprima ricordata: la prima apertura
        // singola si limita ad aggiungere e DIVENTA l'anteprima. È la differenza
        // fra «non so quale sia» e «è la prima che capita».
        const remembered = previewPaneIdRef.current;
        const previewId = remembered && existing.includes(remembered) && remembered !== added[0]
          && !pinnedIdsRef.current.has(remembered)
          ? remembered
          : null;
        if (previewId && !isBrowserPaneId(previewId) && !isTerminalPaneId(previewId) && !isDraftPaneId(previewId)) {
          pendingCloseRef.current = previewId;
          previewPaneIdRef.current = added[0];
          return replaceInList(existing, previewId, added[0]);
        }
        // Nessuna anteprima da sostituire: la nuova tab lo diventa.
        previewPaneIdRef.current = added[0];
      }

      // A single-tab RESTORE (undo of a close) must return to its ORIGINAL slot,
      // not the end. `topicIds` mirrors the store group order (openPanels ←
      // group.paneIds), where UNDO_CLOSE re-inserted the pane at its recorded
      // groupIndex — so splicing the restored id into `existing` at its
      // topicIds position reconstructs [t1, t2, t3] instead of [t1, t3, t2].
      // Without this the ghost-pane fix in pane/reducers/undo.ts repairs the
      // store but this local order would still leave the tab appended (PANE-03).
      // The Cmd+Shift+T reopen path lands here too. It used to append to the
      // group, so topicIds placed the id last and this splice degenerated to a
      // push: the reopened tab came back at the END of the bar, and the order
      // was persisted from there (a reload did not repair it). Now that reopen
      // re-slots the pane at its recorded index in BOTH the store and
      // openPanels (usePanelLifecycle, lib/previewTabs restoreSlot), topicIds
      // carries the original position and the splice reproduces it.
      if (isRestore && added.length === 1) {
        const at = topicIds.indexOf(added[0]);
        const result = [...existing];
        result.splice(at < 0 ? result.length : Math.min(at, result.length), 0, added[0]);
        return result;
      }

      return [...existing, ...added];
    });
    setPinnedIds(prev => {
      const next = new Set([...prev].filter(id => topicIds.includes(id) || isBrowserPaneId(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [topicIds]);

  useEffect(() => {
    if (pendingCloseRef.current) {
      const id = pendingCloseRef.current;
      pendingCloseRef.current = null;
      onClosePanel(id);
    }
  }, [topicIds, onClosePanel]);

  // 7. hasProjectPaneRef — synced every render; read by WS listener.
  const hasProjectPaneRef = useRef(false);
  useEffect(() => { hasProjectPaneRef.current = validatedOrderedIds.some(id => isProjectPaneId(id)); });

  // Path 4: activePaneId derivation (memo + ref) — declared BEFORE the effects
  // that consume it (initialTab='browser') so first-mount declaration order
  // resolves the ref-sync race inside this hook.
  //
  // Split tabbar fix: when this group is NOT the App-focused one (focus is
  // in a sibling split group), keep showing the last tab the user activated
  // HERE — falling back to `validatedOrderedIds[0]` would snap the inactive
  // group back to its first tab every time the user clicked anywhere else.
  // We remember the last `focusedPanelId` that was in this group's list and
  // reuse it while focus lives elsewhere.
  // Seed from localStorage (persistOrder group only) so a full reload restores
  // the last tab active HERE even when focus has since moved to a sibling split
  // cell — otherwise the standalone group would snap back to its first tab. The
  // value must exist on the first render (the activePaneId memo below reads it),
  // so it's an init arg rather than a mount effect.
  const lastLocalActiveRef = useRef<string | null>(
    persistOrder ? readStandaloneActivePane() : null,
  );
  // Render-phase reconciliation of the "last locally-active" memory. This is a
  // deliberate render-time ref write (not state) because the value must be
  // available synchronously to the `activePaneId` memo below on the SAME render
  // — an effect would land one frame late and the group would flash its first
  // tab. The writes are idempotent (they only ever set focusedPanelId or null),
  // so they don't affect this render's output beyond the memo that reads them.
  if (focusedPanelId && validatedOrderedIds.includes(focusedPanelId)) {
    // eslint-disable-next-line react-hooks/refs -- intentional render-phase write: remember the focused tab so an inactive split group keeps showing it; idempotent, see block comment above
    lastLocalActiveRef.current = focusedPanelId;
  } else {
    // eslint-disable-next-line react-hooks/refs -- intentional render-phase read: detect a remembered tab that left this group; idempotent guard, see block comment above
    const remembered = lastLocalActiveRef.current;
    if (remembered && !validatedOrderedIds.includes(remembered)) {
      // The remembered tab was closed/moved out of this group — drop it so we
      // don't keep pointing at a stale id.
      // eslint-disable-next-line react-hooks/refs -- intentional render-phase write: clear the stale remembered tab, see block comment above
      lastLocalActiveRef.current = null;
    }
  }
  const activePaneId = useMemo<string | null>(
    () => {
      if (focusedPanelId && validatedOrderedIds.includes(focusedPanelId)) return focusedPanelId;
      // eslint-disable-next-line react-hooks/refs -- intentional read of the render-phase memory computed just above; the memo recomputes whenever its deps change so the value is current
      const remembered = lastLocalActiveRef.current;
      if (remembered && validatedOrderedIds.includes(remembered)) {
        return remembered;
      }
      return validatedOrderedIds[0] || null;
    },
    [validatedOrderedIds, focusedPanelId],
  );
  const activePaneIdRef = useRef(activePaneId);
  const persistedActiveRef = useRef<string | null>(null);
  useEffect(() => {
    activePaneIdRef.current = activePaneId;
    // Persist the active tab for the standalone group so a reload restores it
    // (the focused-elsewhere fallback above reads it back on next mount). Folded
    // into this existing render-effect on purpose: a separate effect would add a
    // second render-phase consumer of activePaneId — which is derived from
    // lastLocalActiveRef — and the React Compiler would double its ref-flow
    // diagnostics on the memo above. The guard ref keeps writes to real changes.
    if (persistOrder && activePaneId && activePaneId !== persistedActiveRef.current) {
      persistedActiveRef.current = activePaneId;
      writeStandaloneActivePane(activePaneId);
    }
  });

  // ops.ensureBrowserPane — single owner of the browser singleton (B2).
  const ensureBrowserPane = useCallback((contextId?: string): string => {
    // Resolve the pane id SYNCHRONOUSLY from the orderedIds mirror, never from
    // inside the setState updater. The old pattern (`let resolvedId = '';
    // setOrderedIds(prev => { …resolvedId = rid… })`) only worked when React
    // evaluated the updater eagerly — true for a click into an idle group,
    // FALSE in the mount-and-consume flow of a pending pane on an EMPTY client
    // (effect 10 fires among the group's first-mount effects, the fiber has
    // pending work, the updater is deferred): resolvedId stayed '', so no
    // persist / no focus ran, the strict orderedIds validation dropped the new
    // pane and the just-mounted group evaporated back to the Welcome screen —
    // the "Add pane → Browser does nothing with zero tabs" bug.
    const { resolvedId } = browserSingletonReducer(orderedIdsRef.current, contextId);
    // Re-apply through the updater with the RESOLVED context so the state
    // transition stays functional (safe against concurrent updates) AND
    // deterministic — the no-context create path mints a fresh UUID per call,
    // so re-running the reducer with the original `contextId` could mint a
    // SECOND id different from the one we just persisted/focused.
    const resolvedCtx = getBrowserContextFromPaneId(resolvedId) ?? contextId;
    setOrderedIds(prev => browserSingletonReducer(prev, resolvedCtx).next);
    queueMicrotask(() => { if (resolvedId) onFocusPanel(resolvedId); });
    if (resolvedId) persistBrowserPane(resolvedId);
    return resolvedId;
  }, [onFocusPanel]);

  // 8. WS browser:navigate listener. Lives in this hook (B5 option (a)).
  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
      if (msg.type === 'browser:navigate' && msg.url) {
        const navTopicId = msg.topicId;
        // Ownership: with a topicId, MEMBERSHIP decides (the reducer below bails
        // unless the topic is a tab of THIS group), so a project-owned topic is
        // never hijacked here — useProjectBrowserPanes claims those. The old
        // blanket "any project pane open in this group → bail, ProjectWindowPane
        // handles it" was a LIE for a topic that belongs to NO project: the
        // project window's own guard (topicBelongsToThisProject) rejects it too,
        // so the frame fell between the two and open_browser_pane mounted
        // nothing while the server context stayed live and drivable. Same rule
        // (now the SAME function) as the DOM variant in 8b — CHAT-REL-03.
        //
        // The server-resolved browser contextId (== topic.id). Binding the pane to
        // it makes useNativeBrowser register the native CDP target under the SAME
        // id the agent's browser_* tools resolve to — without this the pane took a
        // random id and every tool fell back to an invisible Playwright phantom.
        const navContextId = msg.contextId;
        // Resolve localhost ONLY for remote web clients; never in Electron native
        // (same-machine WebContentsView reaches localhost directly, and forcing
        // https there breaks http dev servers → white page). See resolveBrowserNavigateUrl.
        const navigateUrl: string = resolveBrowserNavigateUrl(msg.url);
        setOrderedIds(prev => {
          if (!groupClaimsBrowserNavigate({ topicId: navTopicId, hasProjectPane: hasProjectPaneRef.current, orderedIds: prev })) return prev;
          const { next, resolvedId } = browserSingletonReducer(prev, navContextId);
          if (resolvedId) {
            // Il seme dell'URL sta QUI, dopo la rivendicazione: prima stava
            // sopra il claim, e un gruppo che poi si tirava indietro aveva già
            // spinto l'URL nel suo browser (stessa trappola già chiusa in 8b).
            queueMicrotask(() => { onBrowserNavigateUrl(navigateUrl); onFocusPanel(resolvedId); requestBrowserSolo(resolvedId); });
            persistBrowserPane(resolvedId);
            // Persist the URL onto the pane NOW (deterministic) so the tab
            // restores to its page after reload — the onUrlChange render path is
            // timing-fragile on a fresh open. The pane exists post-persist.
            persistBrowserPaneUrl(resolvedId, navigateUrl);
            // Record spawner relationship: chat → browser. Lets the chat
            // header surface a jump-to-browser button and the browser
            // toolbar surface a jump-back-to-chat button.
            const ctx = getBrowserContextFromPaneId(resolvedId);
            if (ctx && navTopicId) setBrowserSpawner(ctx, navTopicId);
          }
          return next;
        });
      }
      // Terminal-originated open: a Claude Code terminal asked to surface a URL
      // next to itself. Only the standalone group that actually renders that
      // terminal pane reacts (membership check on `prev`); every other group
      // and the project windows ignore it. We reuse the same browser singleton
      // as chat-driven navigation — the terminal's browser shares the group's
      // one browser pane rather than spawning a second.
      if (msg.type === 'browser:open-near-pane' && msg.url && msg.paneId) {
        const navigateUrl: string = resolveBrowserNavigateUrl(msg.url);
        setOrderedIds(prev => {
          if (!prev.includes(msg.paneId)) return prev; // terminal not in this group
          // Pass the server-supplied deterministic contextId (`term-<id>`) so the
          // pane registers its CDP target under the id the observe/act routes
          // resolve to — that's what makes the terminal able to DRIVE the pane.
          const { next, resolvedId } = browserSingletonReducer(prev, msg.contextId);
          if (resolvedId) {
            persistBrowserPane(resolvedId);
            persistBrowserPaneUrl(resolvedId, navigateUrl);
            queueMicrotask(() => { onBrowserNavigateUrl(navigateUrl); onFocusPanel(resolvedId); requestBrowserSolo(resolvedId); });
            // Spawner key = the terminal pane id, so its tab gets the
            // "opened a browser" cue (same registry as chat-driven opens).
            const ctx = getBrowserContextFromPaneId(resolvedId);
            if (ctx) setBrowserSpawner(ctx, msg.paneId);
          }
          return next;
        });
      }
    });
    return unsub;
  }, [onWSMessage, onFocusPanel, onBrowserNavigateUrl]);

  // 8b. Phase 30 BROWSER-CHAT-04 — DOM-event variant for /browser slash command
  // (and any other client-side producer). Mirrors the WS browser:navigate flow
  // but skips the WS hop. Sourced from ChatPane.handleSlashCommand.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ topicId?: string; url?: string }>;
      if (!ce.detail?.url) return;
      // Ownership: la stessa regola del ramo WS, e ora la stessa funzione
      // (groupClaimsBrowserNavigate) — questa era la copia CORRETTA, l'altra
      // era rimasta indietro di un mese.
      const navigateUrl: string = resolveBrowserNavigateUrl(ce.detail.url);
      setOrderedIds(prev => {
        if (!groupClaimsBrowserNavigate({ topicId: ce.detail?.topicId, hasProjectPane: hasProjectPaneRef.current, orderedIds: prev })) return prev;
        // For a chat topic the browser contextId IS the topicId
        // (resolveContextIdForTopic === topic.id), so bind the pane to it — same
        // reason as the WS browser:navigate path: keep the native CDP target on
        // the id the agent's tools resolve to.
        const { next, resolvedId } = browserSingletonReducer(prev, ce.detail?.topicId);
        if (resolvedId) {
          // URL seed happens here, AFTER this group claimed the event via the
          // membership check above — seeding before the claim leaked the URL
          // into groups that then bailed.
          queueMicrotask(() => { onBrowserNavigateUrl(navigateUrl); onFocusPanel(resolvedId); requestBrowserSolo(resolvedId); });
          persistBrowserPane(resolvedId);
          persistBrowserPaneUrl(resolvedId, navigateUrl);
          const ctx = getBrowserContextFromPaneId(resolvedId);
          if (ctx && ce.detail?.topicId) setBrowserSpawner(ctx, ce.detail.topicId);
        }
        return next;
      });
    };
    window.addEventListener('browser:open-and-navigate', handler as EventListener);
    return () => window.removeEventListener('browser:open-and-navigate', handler as EventListener);
  }, [onFocusPanel, onBrowserNavigateUrl]);

  // 8c. A LINK was clicked (chat, terminal, tool card, or a page inside a
  // browser pane asking for `target=_blank`). Unlike 8/8b this is never a
  // "navigate the session's browser": it is a NEW tab, so it always creates its
  // own pane from the fresh contextId the router minted, and the page that was
  // on screen stays where it was.
  //
  // The claim is SYNCHRONOUS (preventDefault before any setState): `openLink`
  // reads it to decide whether anybody can host the tab, and falls back to the
  // system browser when nobody does. A claim decided inside a state updater
  // would come back after that decision was already taken.
  useEffect(() => {
    const handler = (e: Event) => {
      if (e.defaultPrevented) return;
      const d = (e as CustomEvent<OpenTabDetail>).detail;
      if (!d?.url || !d.contextId) return;
      const fromHere = !!d.nearPaneId && orderedIdsRef.current.includes(d.nearPaneId);
      // A link clicked INSIDE a project window carries its path and belongs to
      // that window; anything else is standalone work and lands here. The
      // `defaultPrevented` guard above is what makes this safe to state so
      // loosely: several standalone groups may match, the first one takes it.
      const claims =
        fromHere ||
        (!d.nearPaneId &&
          !d.projectPath &&
          (!d.topicId || orderedIdsRef.current.includes(d.topicId) || !hasProjectPaneRef.current));
      if (!claims) return;
      e.preventDefault();

      const navigateUrl = resolveBrowserNavigateUrl(d.url);
      const newId = createPaneId('browser', d.contextId);
      // A strip that already shows a browser gains a tab; the first browser of
      // the group still gets a cell of its own beside the chat, which is what
      // every other open path does here.
      const hadBrowser = orderedIdsRef.current.some(isBrowserPaneId);
      const anchor = activePaneIdRef.current ?? undefined;
      setOrderedIds(prev => insertPaneAfter([...prev, newId], newId, anchor));
      persistBrowserPaneAfter(newId, anchor);
      persistBrowserPaneUrl(newId, navigateUrl);
      if (d.topicId) setBrowserSpawner(d.contextId, d.topicId);
      // No onBrowserNavigateUrl here on purpose: that prop drives whichever
      // browser panel is mounted, and pushing the URL through it would navigate
      // the tab the user was reading. The new pane picks the URL up from its own
      // persisted `url` when it mounts.
      queueMicrotask(() => {
        onFocusPanel(newId);
        if (!hadBrowser) requestBrowserSolo(newId);
      });
    };
    window.addEventListener(OPEN_TAB_EVENT, handler as EventListener);
    return () => window.removeEventListener(OPEN_TAB_EVENT, handler as EventListener);
  }, [onFocusPanel]);

  // 9. initialTab === 'browser' — reads activePaneIdRef (Path 4).
  useEffect(() => {
    const ap = activePaneIdRef.current;
    if (ap && panelInitialTab?.[ap] === 'browser') {
      onPanelInitialTabConsumed?.(ap);
      ensureBrowserPane();
    }
  }, [panelInitialTab, onPanelInitialTabConsumed, ensureBrowserPane]);

  // 10. Pending browser pane request (from sidebar — contextId string).
  useEffect(() => {
    if (pendingBrowserPane) {
      // Notify parent that we have utility panes BEFORE consuming the
      // pending request, so PanelGrid keeps the standalone group alive
      // across the re-render.
      onUtilityPaneChange?.(true);
      onPendingBrowserPaneConsumed?.();
      ensureBrowserPane(pendingBrowserPane);
    }
  }, [pendingBrowserPane, onPendingBrowserPaneConsumed, onUtilityPaneChange, ensureBrowserPane]);

  // 11. Report utility-pane status to parent.
  const hasUtilityPanes = useMemo(
    () => validatedOrderedIds.some(id => isBrowserPaneId(id)),
    [validatedOrderedIds],
  );
  useEffect(() => {
    onUtilityPaneChange?.(hasUtilityPanes);
  }, [hasUtilityPanes, onUtilityPaneChange]);

  // 12. Report open browser context IDs to parent.
  const openBrowserContextIds = useMemo(
    () => validatedOrderedIds
      .filter(isBrowserPaneId)
      .map(id => getBrowserContextFromPaneId(id))
      .filter((id): id is string => id !== null),
    [validatedOrderedIds],
  );
  useEffect(() => {
    onOpenBrowserContextIds?.(openBrowserContextIds);
  }, [openBrowserContextIds, onOpenBrowserContextIds]);

  // ops — exposed mutation API. NO setters leaked.
  const reorder = useCallback((newPaneIds: string[]) => {
    setOrderedIds(newPaneIds);
  }, []);

  const pin = useCallback((paneId: string) => {
    setPinnedIds(prev => new Set([...prev, paneId]));
  }, []);

  const removeLocalPane = useCallback((paneId: string) => {
    setOrderedIds(prev => prev.filter(id => id !== paneId));
  }, []);

  const removeLocalPanes = useCallback((paneIds: string[]) => {
    if (paneIds.length === 0) return;
    const drop = new Set(paneIds);
    setOrderedIds(prev => prev.filter(id => !drop.has(id)));
  }, []);

  // eslint-disable-next-line react-hooks/refs -- this hook intentionally returns pinnedIdsRef (read by consumers in effects/handlers, never in their render) as part of its stable public API
  return {
    state: { orderedIds, pinnedIds },
    // eslint-disable-next-line react-hooks/refs -- effectivePinnedIds is the contents-equality-cached value (transitively ref-derived); returning it as derived state is the point — its stable reference keeps the parent's downstream memos from churning
    derived: { validatedOrderedIds, effectivePinnedIds, activePaneId },
    refs: { pinnedIdsRef },
    ops: { reorder, pin, ensureBrowserPane, removeLocalPane, removeLocalPanes },
  };
}

