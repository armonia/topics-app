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
import {
  createPaneId,
  getBrowserTombstones,
  getTerminalTombstones,
  getViewTombstones,
  viewTombstoneKey,
  getBrowserContextFromPaneId,
  getTerminalSessionFromPaneId,
} from '../../../state/pane/adapters';
import { projectFocusActions } from '../../../state/projectFocus';
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
  /** Cross-hook gate from `useProjectPersistenceLoad`. Reads/writes
   *  `initialChatsSyncedRef` so server-hydrate AND the mount effect
   *  converge on the same "initial restore done" flag. */
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

  // Track previous topicIds set so we can detect "just-arrived" topics
  // (e.g. created in another window via WS) and surface them as chat panes
  // without re-opening every closed tab on every render.
  //
  // Initial value is empty on purpose: the first effect run is intercepted
  // by the `!initialChatsSyncedRef.current` branch below (first-sync path)
  // BEFORE the delta-add branch can fire. Once first-sync sets the gate and
  // populates `prevTopicIdsSetRef` at the end of that run, subsequent runs
  // see the prior snapshot and only treat genuinely-new ids as additions.
  const prevTopicIdsSetRef = useRef<Set<string>>(new Set());

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

    // Empty topicIds with chat panes still open: mark the chat-sync gate as
    // complete so the persistence-save effect is unblocked (a project whose
    // topics are slow to load — or never load — must not suppress every
    // save, or tab closures don't stick across reloads). This branch used to
    // ALSO early-return, skipping the removal pass — but the transient it
    // feared (topics state temporarily cleared) is already covered per-pane
    // below (`!topics[p.topicId]` → keep), and the blanket skip made
    // archiving a project's ONLY topic leave a ghost chat pane for the rest
    // of the session: the KNOWN-archived topic could never be removed while
    // currentSet stayed empty.
    const existingChatPanes = curPanes.filter(p => p.type === 'chat');
    if (currentSet.size === 0 && existingChatPanes.length > 0) {
      if (!gateRefs.initialChatsSyncedRef.current) {
        gateRefs.initialChatsSyncedRef.current = true;
        markChatSyncDone();
      }
    }

    // Remove chat panes whose topic no longer belongs in the project — but ONLY
    // when the topic is KNOWN. A chat pane whose topic is still LOADING (absent
    // from `topics`, e.g. created on another device and not yet fetched here) is
    // KEPT: removing it would drop a pane the user has open AND make the ensuing
    // save PUT a smaller openChatTopicIds, stripping that topic from the shared
    // cross-device record. This mirrors the seed (useProjectLayout) and
    // onServerHydrate, which both keep unknown ids until topics populate. A
    // known topic absent from currentSet means archived or moved to another
    // project → genuinely remove.
    const remove: string[] = [];
    for (const p of curPanes) {
      if (p.type !== 'chat') continue;
      if (!p.topicId) { remove.push(p.id); continue; }
      if (!topics[p.topicId]) continue; // still loading → keep
      if (!currentSet.has(p.topicId)) remove.push(p.id);
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
            title: topic?.name || 'New Chat',
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
        // Search by pane membership regardless of group type — a chat created
        // via a specific tab bar's "+ new chat" can live in a non-'chat' group
        // (e.g. alongside terminals). Gating on g.type === 'chat' would skip it
        // and fail to re-activate it on reload.
        const containingGroup = curGroups.find(
          g => g.paneIds.includes(targetPaneId),
        );
        if (containingGroup) {
          activateInGroup = {
            groupId: containingGroup.id,
            paneId: targetPaneId,
          };
        }
      }
    } else {
      // Post-first-sync: surface topics that JUST arrived (delta vs the
      // previous topicIds snapshot) as new chat panes. This handles the
      // cross-window case where another window (Electron vs browser) creates
      // a topic in this project — without this, the topic enters `topics`
      // and the global sidebar, but the project window never opens a tab
      // for it. We do NOT auto-focus the new pane (the local user shouldn't
      // lose context) and we do NOT re-add panes the user has explicitly
      // closed (they'd reappear on every re-render).
      const prevSet = prevTopicIdsSetRef.current;
      for (const tid of topicIds) {
        if (survivingChatTopicIds.has(tid)) continue;
        if (prevSet.has(tid)) continue; // not new — was here last time
        const topic = topics[tid];
        add.push({
          id: createPaneId('chat', tid),
          type: 'chat' as PaneType,
          topicId: tid,
          title: topic?.name || 'New Chat',
          preview: false,
        });
        survivingChatTopicIds.add(tid);
      }
    }
    prevTopicIdsSetRef.current = currentSet;

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
    // `panes` manca di proposito, e si legge da `panesRef.current`: questo
    // effetto AGGIUNGE e TOGLIE pane, quindi dipendere da loro vorrebbe dire
    // ripartire sul proprio output — un ciclo, non una sincronizzazione.
    // `applyChatReconciliation` è una prop che il chiamante non memoizza, e
    // passa comunque per updater funzionali (vedi l'intestazione del file),
    // quindi non invecchia. Gli ingressi veri sono i tre elencati: quali topic
    // esistono, come si chiamano, e in quale progetto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicIds, topics, projectPath]);

  // --- Server-fetch hydration callback ---
  // Replaces the inline shim that lived in ProjectWindow.tsx during Commits 2-3.
  // Uses functional updaters via `applyChatReconciliation` (which itself uses
  // functional setState) so it composes safely with concurrent state changes.
  const onServerHydrate = useCallback(
    (fresh: PersistedSnapshot) => {
      // Cross-device convergence is ADDITIVE (union): applying a remote snapshot
      // can only ADD tabs this device is missing, never remove a pane the local
      // user has open. That is what makes hydration safe to run at ANY time, so
      // we deliberately DON'T gate on userEditedRef anymore — that gate used to
      // suppress every steady-state remote update (it flips true on the first
      // post-mount reconcile), which silently killed convergence after load.
      // Echo/stale frames are already filtered upstream in
      // projectLayoutSync.applyServerValue (sourceClientId + server_seq +
      // last-synced-JSON dedupe), so dropping the gate cannot loop.

      // Non-chat panes (terminal/browser/file): UNION by id — add only the ones
      // we don't already have. A remote empty/smaller set therefore can never
      // wipe a terminal/browser the local user has open (the old code did a
      // remove-all-then-add, which an empty `[]` turned into a destructive
      // wipe).
      if (fresh.nonChatPanes && fresh.nonChatPanes.length > 0) {
        const curIds = new Set(panesRef.current.map(p => p.id));
        // Per-project singleton VIEW panes (git, files, dashboard, activity,
        // browser, …) are created with createPaneId(type) and
        // NO key, i.e. a RANDOM uuid, so the same logical pane has a different id
        // on each device — union-by-id would add the peer's copy as a visual
        // DUPLICATE. Only chat / terminal carry a STABLE
        // cross-device id (keyed by topic/session) and may legitimately appear
        // more than once per project, so those union by id. Every other type is
        // a singleton: skip a remote one when we already hold that type locally.
        const STABLE_MULTI_TYPES = new Set<PaneType>(['chat', 'terminal']);
        const localSingletonTypes = new Set(
          panesRef.current.filter(p => !STABLE_MULTI_TYPES.has(p.type)).map(p => p.type),
        );
        // Removal signal for the union. The project tab-identity channel syncs
        // only the OPEN set ({nonChatPanes, openChatTopicIds}) with no tombstone
        // on the wire, and this hydrate is additive — so a stale server value or
        // a peer that still lists a pane the LOCAL user just closed would
        // resurrect it (the "chiudo la tab e ritorna" bug, worst for
        // browser/terminal which — unlike chats — carry no archived flag). The
        // durable browser/terminal tombstones ARE the local removal record;
        // consult them here exactly as the mount-time seed already does
        // (useProjectLayout.ts). Chats stay shielded by their archived flag below.
        const browserTombstones = getBrowserTombstones();
        const terminalTombstones = getTerminalTombstones();
        // And the SINGLETON VIEWS (board, git, files, processes...). They were
        // the hole: the union already skips a remote singleton whose type the
        // local client STILL holds, which hid it until you closed the LAST one
        // of its kind - i.e. exactly the case a person hits. Closing the board
        // tab and reloading brought it back.
        const viewTombstones = getViewTombstones();
        const isTombstoned = (p: Pane): boolean => {
          if (p.type === 'browser') {
            const ctx = getBrowserContextFromPaneId(p.id);
            return !!ctx && browserTombstones.has(ctx);
          }
          if (p.type === 'terminal') {
            const sid = getTerminalSessionFromPaneId(p.id);
            return !!sid && terminalTombstones.has(sid);
          }
          if (!STABLE_MULTI_TYPES.has(p.type)) {
            return viewTombstones.has(viewTombstoneKey(projectPath, p.type));
          }
          return false;
        };
        const add = fresh.nonChatPanes.filter(p => {
          if (curIds.has(p.id)) return false;
          if (!STABLE_MULTI_TYPES.has(p.type) && localSingletonTypes.has(p.type)) return false;
          if (isTombstoned(p)) return false;
          return true;
        });
        if (add.length > 0) {
          applyChatReconciliation({ add, remove: [], retitle: new Map() });
        }
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
          // A utility-pane id is never a topic — don't materialise a stub.
          if (tid.startsWith('__') && tid.endsWith('__')) continue;
          // Only open chats whose topic is KNOWN locally and belongs to THIS
          // project. Skipping unknown ids avoids the add-then-remove churn that
          // used to strip a lagging topic from the shared set (the chat-sync
          // reconcile removes any chat pane not in `topicIds`, and the ensuing
          // save would PUT the smaller set). When the topic actually loads via
          // WS, chat-sync's delta-add opens it.
          const ftopic = topics[tid];
          if (!ftopic || ftopic.archived || ftopic.projectPath !== projectPath) continue;
          stubs.push({
            id: createPaneId('chat', tid),
            type: 'chat' as PaneType,
            topicId: tid,
            title: ftopic.name || 'New Chat',
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
    [applyChatReconciliation, gateRefs, markChatSyncDone, topics, projectPath],
  );

  // --- reopenTopic: delegates to layout's atomic placement helper ---
  const reopenTopic = useCallback(
    (topicId: string) => {
      reopenChatPane(topicId, topics[topicId]?.name || 'New Chat');
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

  // Report the focused inner group's active pane id (ANY type — chat, terminal,
  // browser) to the projectFocus store, so the sidebar can light the child row
  // you're actually in, not just the project folder. activeTopicId above is
  // chat-only; this covers terminals/browsers too.
  const focusedInnerPaneId = useMemo(() => {
    const g = groups.find(gr => gr.id === focusedGroupId);
    return g?.activePaneId ?? null;
  }, [groups, focusedGroupId]);
  useEffect(() => {
    projectFocusActions.setActivePane(projectPath, focusedInnerPaneId);
  }, [projectPath, focusedInnerPaneId]);

  return {
    topicIds,
    activeTopicId,
    activeTopic,
    reopenTopic,
    onServerHydrate,
  };
}
