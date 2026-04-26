/**
 * Shared types for the ProjectWindow hooks. Extracted from
 * `client/src/components/Layout/ProjectWindow.tsx` during the
 * useProjectPersistenceLoad / useProjectLayout / useProjectChatSync /
 * useProjectPersistenceSave refactor.
 *
 * Do NOT add behavior here — types only. Hooks own their own logic.
 */

import type { MutableRefObject } from 'react';
import type { Pane, PaneGroup, GroupLayoutRow } from '../../../types';

/**
 * Combined snapshot persisted across sessions for a project window.
 * - Tab identity (`nonChatPanes`, `openChatTopicIds`, `activeChatTopicId`)
 *   is server-synced via the topics API.
 * - Layout (`groups`, `rows`, `rowHeights`, `sidebarCollapsed`) is
 *   local-only (per-device) via localStorage.
 *
 * The shape mirrors the existing union of `PersistedTabState` and
 * `PersistedLayoutState` in `ProjectWindow.tsx` — keep the two in sync
 * during the refactor; the source-of-truth declaration moves here once
 * the file's local copies are deleted in the cleanup commit.
 */
export interface PersistedSnapshot {
  // Tab identity (server-synced):
  nonChatPanes: Pane[];
  openChatTopicIds?: string[];
  activeChatTopicId?: string;
  // Layout (local-only):
  groups?: PaneGroup[];
  rows?: GroupLayoutRow[];
  rowHeights?: number[];
  sidebarCollapsed?: boolean;
}

/**
 * Cross-hook synchronization gates owned by `useProjectPersistenceLoad`
 * and consumed by `useProjectChatSync` (reads `initialChatsSyncedRef`)
 * and `useProjectPersistenceSave` (reads `userEditedRef` + `mountedRef`).
 *
 * Single source of truth for "has the user touched layout yet" and
 * "has the initial chat-tab restoration completed". Avoids duplication
 * across hooks; whoever flips a flag, everyone sees the flip immediately.
 */
export interface PersistenceGateRefs {
  /** Set to `true` on first render-after-mount inside the save effect.
   *  Once true, the server-fetch async callback skips overwriting. */
  userEditedRef: MutableRefObject<boolean>;
  /** Sentinel: `false` on initial mount, `true` thereafter. The save
   *  effect uses this to distinguish "first commit" from "user edit". */
  mountedRef: MutableRefObject<boolean>;
  /** Set to `true` once the initial chat-tab restoration has happened
   *  (server-fetch path OR the chat-sync mount effect — whichever fires
   *  first wins; the other observes and skips). Both sides MUST go
   *  through this single ref. */
  initialChatsSyncedRef: MutableRefObject<boolean>;
}

/**
 * Atomic chat-pane diff that `useProjectChatSync` computes and
 * `useProjectLayout.applyChatReconciliation` applies. All four fields
 * are independently optional; an empty diff is a no-op.
 *
 * The layout hook applies the diff in this order: `remove` → `add`
 * → `retitle` → `activateInGroup`. This guarantees that any pane named
 * in `activateInGroup` exists at activation time.
 */
export interface ChatReconciliation {
  /** Chat panes to append to the panes array (deduped by id). */
  add: Pane[];
  /** Pane IDs to drop from panes AND from any group that contains them. */
  remove: string[];
  /** Pane id → new title. Only chat panes are retitled; non-chat panes
   *  with matching ids are ignored (defensive — should not happen). */
  retitle: Map<string, string>;
  /** Optional: activate this paneId inside this groupId. Used by the
   *  restore-active-chat path on first hydration. Layout sets the
   *  group's `activePaneId` and updates `focusedGroupId`. */
  activateInGroup?: { groupId: string; paneId: string };
}
