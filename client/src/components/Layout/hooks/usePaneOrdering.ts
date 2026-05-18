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
import { findPreviewInList, replaceInList } from '../../../lib/previewTabs';
import type { UsePaneOrderingArgs, UsePaneOrderingReturn } from './standaloneTypes';
import { usePaneStore } from '../../../state/pane/store';
import { openPane } from '../../../state/pane/actions';

/**
 * Phase 30.1 polish — persist a browser pane in the global pane store so
 * it survives renderer reload (Cmd+R, Vite HMR, dev restart). Without this
 * the browser pane only lived in `usePaneOrdering`'s local `orderedIds`
 * useState, and `loadPanelOrder()` (which seeds initial state from the
 * store on mount) returned an array missing the browser pane → tab lost
 * on every reload.
 */
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
 * Singleton reducer shared by `ensureBrowserPane` op and the WS
 * browser:navigate listener. Keeps the swap/reuse/create logic DRY.
 */
function browserSingletonReducer(
  prev: string[],
  contextId?: string,
): { next: string[]; resolvedId: string } {
  const targetId = contextId ? createPaneId('browser', contextId) : null;
  // 1. Exact-match pane already exists.
  if (targetId && prev.includes(targetId)) {
    return { next: prev, resolvedId: targetId };
  }
  // 2. Any browser pane exists.
  const existing = prev.find(id => isBrowserPaneId(id));
  if (existing) {
    if (targetId) {
      return {
        next: prev.map(id => (id === existing ? targetId : id)),
        resolvedId: targetId,
      };
    }
    return { next: prev, resolvedId: existing };
  }
  // 3. No browser pane → create one.
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
    if (s.size === prev.size && [...s].every(id => prev.has(id))) {
      return prev;
    }
    prevEffectivePinnedRef.current = s;
    return s;
  }, [pinnedIds, validatedOrderedIds]);
  const pinnedIdsRef = useRef(effectivePinnedIds);
  useEffect(() => { pinnedIdsRef.current = effectivePinnedIds; });

  // 6. Preview-replacement protocol — 3 refs + 2 effects, all co-located (B4).
  const prevTopicIdsRef = useRef(topicIds);
  const pendingCloseRef = useRef<string | null>(null);
  useEffect(() => {
    const prevTopicIds = prevTopicIdsRef.current;
    prevTopicIdsRef.current = topicIds;

    const wasAdded = topicIds.length > prevTopicIds.length;

    setOrderedIds(prev => {
      const existing = prev.filter(id => {
        if (isBrowserPaneId(id)) return true;
        if (isSessionViewerPaneId(id)) return true;
        return topicIds.includes(id);
      });
      const added = topicIds.filter(id => !prev.includes(id));

      if (wasAdded && added.length === 1) {
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
  const lastLocalActiveRef = useRef<string | null>(null);
  if (focusedPanelId && validatedOrderedIds.includes(focusedPanelId)) {
    lastLocalActiveRef.current = focusedPanelId;
  } else if (lastLocalActiveRef.current && !validatedOrderedIds.includes(lastLocalActiveRef.current)) {
    // The remembered tab was closed/moved out of this group — drop it so we
    // don't keep pointing at a stale id.
    lastLocalActiveRef.current = null;
  }
  const activePaneId = useMemo<string | null>(
    () => {
      if (focusedPanelId && validatedOrderedIds.includes(focusedPanelId)) return focusedPanelId;
      if (lastLocalActiveRef.current && validatedOrderedIds.includes(lastLocalActiveRef.current)) {
        return lastLocalActiveRef.current;
      }
      return validatedOrderedIds[0] || null;
    },
    [validatedOrderedIds, focusedPanelId],
  );
  const activePaneIdRef = useRef(activePaneId);
  useEffect(() => { activePaneIdRef.current = activePaneId; });

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
    const unsub = onWSMessage((msg: any) => {
      if (msg.type === 'browser:navigate' && msg.url) {
        if (hasProjectPaneRef.current) return; // Let ProjectWindowPane handle it
        // Rewrite localhost URLs to use the current hostname (Tailscale / remote).
        let navigateUrl: string = msg.url;
        try {
          const parsed = new URL(navigateUrl);
          if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
            parsed.hostname = window.location.hostname;
            parsed.protocol = window.location.protocol;
            navigateUrl = parsed.toString();
          }
        } catch { /* not a valid URL, leave as-is */ }
        onBrowserNavigateUrl(navigateUrl);
        setOrderedIds(prev => {
          // Today's extra guard: msg.topicId must already be open in this group.
          if (msg.topicId && !prev.includes(msg.topicId)) return prev;
          const { next, resolvedId } = browserSingletonReducer(prev);
          if (resolvedId) {
            queueMicrotask(() => onFocusPanel(resolvedId));
            persistBrowserPane(resolvedId);
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
      if (hasProjectPaneRef.current) return; // Project window owns its panes
      let navigateUrl: string = ce.detail.url;
      try {
        const parsed = new URL(navigateUrl);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          parsed.hostname = window.location.hostname;
          parsed.protocol = window.location.protocol;
          navigateUrl = parsed.toString();
        }
      } catch { /* not a valid URL, leave as-is */ }
      onBrowserNavigateUrl(navigateUrl);
      setOrderedIds(prev => {
        if (ce.detail?.topicId && !prev.includes(ce.detail.topicId)) return prev;
        const { next, resolvedId } = browserSingletonReducer(prev);
        if (resolvedId) {
          queueMicrotask(() => onFocusPanel(resolvedId));
          persistBrowserPane(resolvedId);
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

  return {
    state: { orderedIds, pinnedIds },
    derived: { validatedOrderedIds, effectivePinnedIds, activePaneId },
    refs: { pinnedIdsRef },
    ops: { reorder, pin, ensureBrowserPane, openSessionViewerPane, removeLocalPane, removeLocalPanes },
  };
}

