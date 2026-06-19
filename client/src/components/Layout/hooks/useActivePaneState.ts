/**
 * useActivePaneState — Hook 3 of the StandaloneChatGroup refactor (PLAN v2).
 *
 * Pure derivations from `validatedOrderedIds + activePaneId + topics`.
 * No state, no effects EXCEPT the `browserContextIdRef` sync (relocated
 * for cohesion with the `browserContextId` memo, per CRITIQUE B6).
 *
 * Path 4: `activePaneId` is consumed as an arg (derived inside
 * usePaneOrdering) — eliminates the cycle and first-mount race.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Topic } from '../../../types';
import {
  isBrowserPaneId,
  isProjectPaneId,
  isTerminalPaneId,
  isSessionViewerPaneId,
  isDraftPaneId,
  getProjectPathFromPaneId,
  getSessionKeyFromViewerPaneId,
  getBrowserContextFromPaneId,
} from '../../../state/pane/adapters';
import { isUtilityPanelId, parseUtilityPanelType } from '../UtilityPanel';
import type { UseActivePaneStateArgs, UseActivePaneStateReturn } from './standaloneTypes';

// Fixed sentinel timestamp (epoch) for synthetic draft topics, so a draft keeps
// a stable identity across recomputes — `new Date()` would mint fresh timestamps
// each time `validatedOrderedIds` changes, breaking referential stability.
// Module-scoped so it is a single stable reference (no hook dependency).
const DRAFT_SENTINEL_TS = new Date(0).toISOString();

export function useActivePaneState(args: UseActivePaneStateArgs): UseActivePaneStateReturn {
  const { validatedOrderedIds, activePaneId, topics } = args;

  // Active type checks.
  const activeIsBrowser = activePaneId ? isBrowserPaneId(activePaneId) : false;
  const activeIsTerminal = activePaneId ? isTerminalPaneId(activePaneId) : false;
  const activeIsSessionViewer = activePaneId ? isSessionViewerPaneId(activePaneId) : false;
  const activeSessionKey = activePaneId && activeIsSessionViewer ? getSessionKeyFromViewerPaneId(activePaneId) : null;
  const activeIsProject = activePaneId && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer ? isProjectPaneId(activePaneId) : false;
  const activeProjectPath = activePaneId && activeIsProject ? getProjectPathFromPaneId(activePaneId) : null;
  const activeIsUtility = activePaneId && !activeIsProject && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer ? isUtilityPanelId(activePaneId) : false;
  const activeUtilityType = activePaneId && activeIsUtility ? parseUtilityPanelType(activePaneId) : null;

  // Synthetic topics for draft panes (not yet persisted on server).
  const draftTopics = useMemo(() => {
    const map: Record<string, Topic> = {};
    for (const id of validatedOrderedIds) {
      if (isDraftPaneId(id)) {
        map[id] = {
          id,
          name: 'New Chat',
          icon: '💬',
          color: '#0066ff',
          sessionKey: `draft-session:${id}`,
          createdAt: DRAFT_SENTINEL_TS,
          updatedAt: DRAFT_SENTINEL_TS,
        } as Topic;
      }
    }
    return map;
  }, [validatedOrderedIds]);

  const activeTopic = activePaneId && !activeIsUtility && !activeIsProject && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer
    ? (topics[activePaneId] || draftTopics[activePaneId] || null)
    : null;

  // Browser context ID for RemoteBrowserPanel.
  const browserContextId = useMemo(() => {
    if (activePaneId && isBrowserPaneId(activePaneId)) {
      const ctx = getBrowserContextFromPaneId(activePaneId);
      if (ctx) return ctx;
    }
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id)) {
        const p = getProjectPathFromPaneId(id);
        if (p) return p;
      }
      const t = topics[id];
      if (t?.projectPath) return t.id.slice(0, 8);
    }
    return validatedOrderedIds[0]?.slice(0, 8) || 'default';
  }, [activePaneId, validatedOrderedIds, topics]);
  const browserContextIdRef = useRef(browserContextId);
  useEffect(() => { browserContextIdRef.current = browserContextId; });

  return {
    activePaneId,
    activeIsBrowser,
    activeIsTerminal,
    activeIsSessionViewer,
    activeIsProject,
    activeIsUtility,
    activeSessionKey,
    activeProjectPath,
    activeUtilityType,
    draftTopics,
    activeTopic,
    browserContextId,
    browserContextIdRef,
  };
}
