/**
 * useProjectChatSync — owns chat-pane reconciliation against the project's
 * topic list. Extracted from `ProjectWindow.tsx` during the four-hook
 * refactor (Commit 4).
 *
 * Owns:
 *  - `topicIds` memo: which topics belong to this project (sorted).
 *  - The chat-sync effect: removes panes for deleted topics, restores
 *    last-session chats on first sync, syncs titles, restores active chat
 *    on first sync. Expressed as a single `ChatReconciliation` and applied
 *    via `args.applyChatReconciliation`.
 *  - `reopenTopic(topicId)` — delegates to `args.reopenChatPane`.
 *  - `activeTopicId` / `activeTopic` derivations from the focused group.
 *  - `onServerHydrate(fresh)` — async server-fetch path. Uses functional
 *    updaters (via `applyChatReconciliation`) so it composes safely with
 *    concurrent state changes from layout.
 *
 * Does NOT own:
 *  - Any layout state or setters — all writes flow through
 *    `applyChatReconciliation` / `reopenChatPane` (functional updaters
 *    inside layout, no stale-closure races).
 *  - `userEditedRef` — only the persistence-save effect mutates that flag.
 *
 * `initialChatsSyncedRef` is shared via `gateRefs` (single source of truth).
 * Whichever runs first (server-hydrate OR mount effect) flips the flag; the
 * other observes the flip and skips its first-run branch.
 *
 * NOTE on args.focusedGroupId: the PLAN's documented signature lists
 * `panes` + `groups` but not `focusedGroupId`. Mirroring the original
 * `ProjectWindow.tsx` derivation of `activeTopicId` (focused group → active
 * pane → topicId) requires it. Added as an additive arg — the component
 * already has it on `layout.state.focusedGroupId`, so no caller burden.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Pane, PaneGroup, PaneType, Topic } from '../../../types';
import { createPaneId } from '../../../state/pane/adapters';
import type {
  ChatReconciliation,
  PersistedSnapshot,
  PersistenceGateRefs,
} from './types';

export interface UseProjectChatSyncArgs {
  projectPath: string;
  topics: Record<string, Topic>;
  /** Snapshot from `useProjectPersistenceLoad`. Read once on first sync to
   *  restore last-session open chats + active chat. */
  initial: PersistedSnapshot | null;
  /** Live layout state. Read inside effects; writes go through the layout
   *  atomic API below. */
  panes: Pane[];
  groups: PaneGroup[];
  /** Currently focused group id from `useProjectLayout.state`. Required for
   *  `activeTopicId` derivation (focused group → active pane → topicId). */
  focusedGroupId: string | null;
  /** Atomic chat-pane diff applier owned by `useProjectLayout`. */
  applyChatReconciliation: (recon: ChatReconciliation) => void;
  /** Re-open (or focus) a chat pane for `topicId`. Owned by
   *  `useProjectLayout` so the fallback chain (focused-or-first chat group;
   *  create new group if none) stays atomic. */
  reopenChatPane: (topicId: string, title: string) => void;
  /** Cross-hook gates from `useProjectPersistenceLoad`. Reads/writes
   *  `initialChatsSyncedRef` so server-hydrate AND the mount effect
   *  converge on the same flag. Reads `userEditedRef` to suppress
   *  server-hydrate after the user has edited. */
  gateRefs: PersistenceGateRefs;
  /** Idempotent signal that the initial chat-tab restoration has happened
   *  — unblocks the persistence-save effect. */
  markChatSyncDone: () => void;
}

export interface UseProjectChatSyncReturn {
  topicIds: string[];
  activeTopicId: string | null;
  activeTopic: Topic | null;
  reopenTopic: (topicId: string) => void;
  /** Server-fetch async hydration callback. Wired into
   *  `loaded.setOnServerHydrate` by the component. */
  onServerHydrate: (fresh: PersistedSnapshot) => void;
}

export function useProjectChatSync(
  args: UseProjectChatSyncArgs,
): UseProjectChatSyncReturn {
  const {
    projectPath,
    topics,
    initial,
    panes,
    groups,
    focusedGroupId,
    applyChatReconciliation,
    reopenChatPane,
    gateRefs,
    markChatSyncDone,
  } = args;

  // Mirror initial in a ref so the chat-sync effect reads the latest value
  // (including any in-place mutations from `loaded.bumpInitial`) without
  // forcing the effect to re-run on identity-stable updates.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  // Mirror panes/groups in refs so callbacks (notably onServerHydrate) read
  // the latest values without re-creating the callback on every render.
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // --- topicIds: sorted list of topics belonging to this project ---
  const topicIds = useMemo(
    () =>
      Object.values(topics)
        .filter(t => t.projectPath === projectPath && !t.archived)
        .sort(
          (a, b) =>
            (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
            a.createdAt.localeCompare(b.createdAt),
        )
        .map(t => t.id),
    [topics, projectPath],
  );

  // --- Chat-sync effect: reconcile chat panes with topicIds ---
  // Ports the inline effect from ProjectWindow.tsx (pre-Commit-4 lines 422-480).
  // Computes a single ChatReconciliation diff covering remove + add + retitle
  // + activateInGroup, then applies atomically via layout.
  useEffect(() => {
    const currentSet = new Set(topicIds);
    const curPanes = panesRef.current;

    // Guard: if topicIds is transiently empty but we already have chat panes,
    // skip removal — an empty topicIds for a project with open chats is almost
    // certainly a re-render transient (topics state temporarily cleared).
    // We still mark the chat-sync gate as complete so the persistence-save
    // effect is unblocked: otherwise a project whose topics are slow to load
    // (or never load) keeps suppressing every save, and tab closures don't
    // stick across reloads.
    const existingChatPanes = curPanes.filter(p => p.type === 'chat');
    if (currentSet.size === 0 && existingChatPanes.length > 0) {
      if (!gateRefs.initialChatsSyncedRef.current) {
        gateRefs.initialChatsSyncedRef.current = true;
        markChatSyncDone();
      }
      return;
    }

    // Remove chat panes whose topic no longer exists in the project.
    const remove: string[] = [];
    for (const p of curPanes) {
      if (p.type === 'chat' && !(p.topicId && currentSet.has(p.topicId))) {
        remove.push(p.id);
      }
    }

    const add: Pane[] = [];
    let activateInGroup: ChatReconciliation['activateInGroup'];

    // Compute the post-remove chat-topic set (used for first-sync dedup).
    const removeSet = new Set(remove);
    const survivingChatTopicIds = new Set(
      curPanes
        .filter(p => p.type === 'chat' && !removeSet.has(p.id))
        .map(p => p.topicId)
        .filter((tid): tid is string => !!tid),
    );

    // On first sync only: restore chats that were open last session +
    // restore the saved active chat.
    if (!gateRefs.initialChatsSyncedRef.current) {
      gateRefs.initialChatsSyncedRef.current = true;
      markChatSyncDone();

      const persisted = initialRef.current;
      const openSet = new Set(persisted?.openChatTopicIds || []);
      // `topicIds` is already filtered by `t.projectPath === projectPath`
      // (see line 112-122), so iterating it is safe — the only way a foreign
      // topic enters the chat-pane set is via the seed loop in
      // useProjectLayout (now guarded) or onServerHydrate below.
      for (const tid of topicIds) {
        if (survivingChatTopicIds.has(tid)) continue;
        if (openSet.has(tid)) {
          const topic = topics[tid];
          add.push({
            id: createPaneId('chat', tid),
            type: 'chat' as PaneType,
            topicId: tid,
            title: topic?.name || 'Chat',
            preview: false,
          });
          survivingChatTopicIds.add(tid);
        }
      }

      // Restore-active-chat: if a chat group containing the saved topic
      // exists (post-add), activate it. Idempotent w/r/t the layout-side
      // `restoredActiveChatRef` effect (which guards itself with its own
      // ref so re-activation is a no-op).
      const savedTopicId = persisted?.activeChatTopicId;
      if (savedTopicId && currentSet.has(savedTopicId)) {
        const targetPaneId = createPaneId('chat', savedTopicId);
        const curGroups = groupsRef.current;
        const containingGroup = curGroups.find(
          g => g.type === 'chat' && g.paneIds.includes(targetPaneId),
        );
        if (containingGroup) {
          activateInGroup = {
            groupId: containingGroup.id,
            paneId: targetPaneId,
          };
        }
      }
    }

    // Title sync: update chat pane titles when topic names change.
    const retitle = new Map<string, string>();
    for (const p of curPanes) {
      if (removeSet.has(p.id)) continue;
      if (p.type === 'chat' && p.topicId) {
        const topic = topics[p.topicId];
        if (topic && topic.name !== p.title) {
          retitle.set(p.id, topic.name);
        }
      }
    }

    if (
      remove.length === 0 &&
      add.length === 0 &&
      retitle.size === 0 &&
      !activateInGroup
    ) {
      return;
    }

    applyChatReconciliation({ add, remove, retitle, activateInGroup });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicIds, topics, projectPath]);

  // --- Server-fetch hydration callback ---
  // Replaces the inline shim that lived in ProjectWindow.tsx during Commits 2-3.
  // Uses functional updaters via `applyChatReconciliation` (which itself uses
  // functional setState) so it composes safely with concurrent state changes.
  const onServerHydrate = useCallback(
    (fresh: PersistedSnapshot) => {
      if (gateRefs.userEditedRef.current) return;

      // Replace non-chat panes via reconciliation: remove the current set,
      // add the fresh set. Preserves the prior `setPanes(fresh.nonChatPanes)`
      // semantics while flowing through the atomic API (so chat panes are
      // not stomped).
      if (fresh.nonChatPanes) {
        const curPanes = panesRef.current;
        const remove: string[] = [];
        for (const p of curPanes) {
          if (p.type !== 'chat') remove.push(p.id);
        }
        applyChatReconciliation({
          add: fresh.nonChatPanes,
          remove,
          retitle: new Map(),
        });
      }

      if (fresh.openChatTopicIds) {
        const curPanes = panesRef.current;
        const existing = new Set(
          curPanes
            .filter(p => p.type === 'chat')
            .map(p => p.topicId)
            .filter((tid): tid is string => !!tid),
        );
        const stubs: Pane[] = [];
        for (const tid of fresh.openChatTopicIds) {
          if (existing.has(tid)) continue;
          // Same guard as the initial seed in useProjectLayout: a
          // utility-pane id is never a topic, so don't materialise it
          // as a "Topic not found" stub on cross-device hydrate.
          if (tid.startsWith('__') && tid.endsWith('__')) continue;
          // Cross-project leak guard: server-hydrate may carry foreign-project
          // topic ids if a previous buggy build wrote them. Drop them here so
          // they don't get materialised as ghost tabs in this project.
          const ftopic = topics[tid];
          if (ftopic && ftopic.projectPath !== projectPath) continue;
          stubs.push({
            id: createPaneId('chat', tid),
            type: 'chat' as PaneType,
            topicId: tid,
            title: topics[tid]?.name || 'Chat',
            preview: false,
          });
        }
        if (stubs.length > 0) {
          applyChatReconciliation({
            add: stubs,
            remove: [],
            retitle: new Map(),
          });
        }
        gateRefs.initialChatsSyncedRef.current = true;
        markChatSyncDone();
      }
    },
    [applyChatReconciliation, gateRefs, markChatSyncDone, topics],
  );

  // --- reopenTopic: delegates to layout's atomic placement helper ---
  const reopenTopic = useCallback(
    (topicId: string) => {
      reopenChatPane(topicId, topics[topicId]?.name || 'Chat');
    },
    [reopenChatPane, topics],
  );

  // --- activeTopicId / activeTopic derivations ---
  // Mirrors the pre-refactor ProjectWindow.tsx derivation:
  //   focusedGroup = groups.find(g => g.id === focusedGroupId)
  //   focusedPane  = focusedGroup ? panes.find(p => p.id === focusedGroup.activePaneId) : null
  //   activeTopicId = focusedPane?.type === 'chat' ? focusedPane.topicId || null : null
  const activeTopicId = useMemo(() => {
    const focusedGroup = groups.find(g => g.id === focusedGroupId);
    if (!focusedGroup) return null;
    const focusedPane = panes.find(p => p.id === focusedGroup.activePaneId);
    if (!focusedPane || focusedPane.type !== 'chat') return null;
    return focusedPane.topicId || null;
  }, [groups, panes, focusedGroupId]);

  const activeTopic = useMemo(
    () => (activeTopicId ? topics[activeTopicId] || null : null),
    [activeTopicId, topics],
  );

  return {
    topicIds,
    activeTopicId,
    activeTopic,
    reopenTopic,
    onServerHydrate,
  };
}
