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
  isSessionViewerPaneId,
  isDraftPaneId,
  createPaneId,
  loadPanelOrder,
  getBrowserContextFromPaneId,
} from '../../../state/pane/adapters';
import { isUtilityPanelId } from '../UtilityPanel';
import { findPreviewInList, replaceInList, consumeTabRestored } from '../../../lib/previewTabs';
import { resolveBrowserNavigateUrl } from '../../../lib/browserNavUrl';
import type { WSMessage } from '../../../types';
import type { UsePaneOrderingArgs, UsePaneOrderingReturn } from './standaloneTypes';
import { usePaneStore } from '../../../state/pane/store';
import { openPane } from '../../../state/pane/actions';
import { setBrowserSpawner } from '../../../state/browserSpawner';
import { persistBrowserPaneUrl } from '../../../state/pane/browserPaneUrl';

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
      const existing = saved.order.filter(id => topicIds.includes(id) || isBrowserPaneId(id) || isSessionViewerPaneId(id));
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
  // an ID not in openPanels (topicIds). Returns ref unchanged when no prune.
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
  const validatedOrderedIds = useMemo(() => {
    const openSet = new Set(topicIds);
    const filtered = orderedIds.filter(id => openSet.has(id));
    return filtered.length === orderedIds.length ? orderedIds : filtered;
  }, [orderedIds, topicIds]);

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
      if (isProjectPaneId(id) || isUtilityPanelId(id) || isBrowserPaneId(id) || isTerminalPaneId(id) || isSessionViewerPaneId(id) || isDraftPaneId(id)) s.add(id);
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
  // eslint-disable-next-line react-hooks/refs -- useRef only reads this initial value on the first render to seed the mirror ref; subsequent syncs happen in the effect below (the value is ref-derived via the contents-equality cache, hence the transitive flag)
  const pinnedIdsRef = useRef(effectivePinnedIds);
  useEffect(() => { pinnedIdsRef.current = effectivePinnedIds; });

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
        if (isSessionViewerPaneId(id)) return true;
        return topicIds.includes(id);
      });
      const added = topicIds.filter(id => !prev.includes(id));

      if (wasAdded && added.length === 1 && !isRestore) {
        const previewId = findPreviewInList(existing, pinnedIdsRef.current, added[0]);
        if (previewId && !isBrowserPaneId(previewId) && !isTerminalPaneId(previewId) && !isSessionViewerPaneId(previewId) && !isDraftPaneId(previewId)) {
          pendingCloseRef.current = previewId;
          return replaceInList(existing, previewId, added[0]);
        }
      }

      return [...existing, ...added];
    });
    setPinnedIds(prev => {
      const next = new Set([...prev].filter(id => topicIds.includes(id) || isBrowserPaneId(id) || isSessionViewerPaneId(id)));
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
    let resolvedId = '';
    setOrderedIds(prev => {
      const { next, resolvedId: rid } = browserSingletonReducer(prev, contextId);
      resolvedId = rid;
      return next;
    });
    queueMicrotask(() => { if (resolvedId) onFocusPanel(resolvedId); });
    if (resolvedId) persistBrowserPane(resolvedId);
    return resolvedId;
  }, [onFocusPanel]);

  // 8. WS browser:navigate listener. Lives in this hook (B5 option (a)).
  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
      if (msg.type === 'browser:navigate' && msg.url) {
        if (hasProjectPaneRef.current) return; // Let ProjectWindowPane handle it
        const navTopicId = msg.topicId;
        // The server-resolved browser contextId (== topic.id). Binding the pane to
        // it makes useNativeBrowser register the native CDP target under the SAME
        // id the agent's browser_* tools resolve to — without this the pane took a
        // random id and every tool fell back to an invisible Playwright phantom.
        const navContextId = msg.contextId;
        // Resolve localhost ONLY for remote web clients; never in Electron native
        // (same-machine WebContentsView reaches localhost directly, and forcing
        // https there breaks http dev servers → white page). See resolveBrowserNavigateUrl.
        const navigateUrl: string = resolveBrowserNavigateUrl(msg.url);
        onBrowserNavigateUrl(navigateUrl);
        setOrderedIds(prev => {
          // Today's extra guard: navTopicId must already be open in this group.
          if (navTopicId && !prev.includes(navTopicId)) return prev;
          const { next, resolvedId } = browserSingletonReducer(prev, navContextId);
          if (resolvedId) {
            queueMicrotask(() => { onFocusPanel(resolvedId); requestBrowserSolo(resolvedId); });
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
      // Ownership: with a topicId, MEMBERSHIP decides (the reducer below bails
      // unless the topic is a tab of THIS group), so a project-owned topic is
      // never hijacked here. The old blanket "any project pane open → bail"
      // orphaned the event for STANDALONE topics whenever a project tab was
      // also open: /browser became a silent no-op (audit 2026-07-10,
      // CHAT-REL-03). The blanket bail survives only for topic-less events,
      // whose producer we can't attribute.
      if (!ce.detail.topicId && hasProjectPaneRef.current) return;
      const navigateUrl: string = resolveBrowserNavigateUrl(ce.detail.url);
      setOrderedIds(prev => {
        if (ce.detail?.topicId && !prev.includes(ce.detail.topicId)) return prev;
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
    () => validatedOrderedIds.some(id => isBrowserPaneId(id) || isSessionViewerPaneId(id)),
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

  const openSessionViewerPane = useCallback((sessionKey: string): string => {
    const newId = createPaneId('session-viewer', sessionKey);
    // Register the pane ENTITY with its real type BEFORE the id flows into
    // openPanels (register-before-open contract, same as persistBrowserPane).
    // Without this, handleFocusPanel's generic fallback registered it as
    // { type: 'chat', title: undefined } — the tab rendered with the chat
    // icon and the "New Chat" label instead of the Session viewer's own.
    try {
      const state = usePaneStore.getState();
      if (!state.groups['group:default']?.paneIds.includes(newId)) {
        state.dispatch(openPane({
          id: newId,
          type: 'session-viewer',
          groupId: 'group:default',
        }));
      }
    } catch (err) {
      console.warn('[usePaneOrdering] openSessionViewerPane persist failed:', err);
    }
    setOrderedIds(prev => (prev.includes(newId) ? prev : [...prev, newId]));
    queueMicrotask(() => onFocusPanel(newId));
    return newId;
  }, [onFocusPanel]);

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
    ops: { reorder, pin, ensureBrowserPane, openSessionViewerPane, removeLocalPane, removeLocalPanes },
  };
}

