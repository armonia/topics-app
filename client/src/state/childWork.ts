/**
 * THE SUB-AGENTS AT WORK, for the surfaces that are not under one chat: a
 * child's own tab, the agents list, the sidebar, the bell, the tray. One read
 * of `GET /api/live-work` for all of them, the same rows the strips under the
 * chats show, so no surface can say another thing.
 *
 * Nothing polls on a timer: the frames that already exist say when to read
 * again (a child changed phase, a turn started or ended, the hooks moved a
 * CLI child, a context was measured), at most once every `REFETCH_MS`. The
 * reads run only while some surface is mounted.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { liveWorkApi } from '../lib/api';
import { subscribeFrames, subscribeLifecycle } from '../lib/wsFrameBus';
import { agentsAtWorkUnder, type ChildAgentRow, type LiveAgentState } from '../../../shared/live-work';
import { useTopicInProgress } from './signals';

/** Context frames arrive on every model call: reading each one would be a read per call. */
const REFETCH_MS = 2000;
const NO_CHILDREN: ReadonlyMap<string, ChildAgentRow> = new Map();

let current: ReadonlyMap<string, ChildAgentRow> = NO_CHILDREN;
let currentKey = '';
const subs = new Set<() => void>();
let stopFeed: (() => void) | null = null;

/** The live children by id: those that ended are not at work and are left out. */
export function indexChildren(agents: readonly ChildAgentRow[]): ReadonlyMap<string, ChildAgentRow> {
  const live = agents.filter((a) => a.state !== 'ended');
  return live.length === 0 ? NO_CHILDREN : new Map(live.map((a) => [a.id, a]));
}

function startFeed(): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  const publish = (next: ReadonlyMap<string, ChildAgentRow>) => {
    if (!alive || (next === NO_CHILDREN && current === NO_CHILDREN)) return;
    current = next;
    for (const s of [...subs]) s();
  };
  const load = async () => {
    if (inFlight) { again = true; return; }
    inFlight = true;
    try {
      const answer = await liveWorkApi.children();
      // Same rows as last time: no new map, so nothing re-renders (the clocks tick on the client).
      const key = JSON.stringify(answer.agents);
      if (key === currentKey) return;
      currentKey = key;
      publish(indexChildren(answer.agents));
    } catch {
      // The rows on screen stay: the next frame asks again.
    } finally {
      inFlight = false;
      if (again && alive) { again = false; void load(); }
    }
  };
  const soon = () => {
    if (!timer && alive) timer = setTimeout(() => { timer = null; void load(); }, REFETCH_MS);
  };
  void load();
  const offFrames = subscribeFrames(soon, { types: ['terminal:sessions', 'stream:start', 'stream:end', 'stream:context', 'session:state'] });
  const offSocket = subscribeLifecycle((e) => { if (e === 'open') soon(); });
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
    offFrames(); offSocket();
    current = NO_CHILDREN;
    currentKey = '';
  };
}

function subscribe(notify: () => void): () => void {
  subs.add(notify);
  if (!stopFeed) stopFeed = startFeed();
  return () => {
    subs.delete(notify);
    if (subs.size === 0 && stopFeed) { stopFeed(); stopFeed = null; }
  };
}

/** All live children by id. */
export function useChildren(): ReadonlyMap<string, ChildAgentRow> {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** One child's row: a terminal's id for a CLI child, a chat's topic id for a native one. `null` while it is not at work. */
export function useChildRow(id: string | null | undefined): ChildAgentRow | null {
  const children = useChildren();
  return id ? children.get(id) ?? null : null;
}

/** The live children of one chat (a card's assigned topic, a chat with a strip). */
export function useChildrenOf(topicId: string | null | undefined): readonly ChildAgentRow[] {
  const children = useChildren();
  return useMemo(() => (topicId ? [...children.values()].filter((c) => c.parentTopicId === topicId) : []), [children, topicId]);
}

/** How many agents work for this chat now, at any depth (`agentsAtWorkUnder`): the number beside its loader. */
export function useAgentsAtWork(topicId: string | null | undefined): number {
  const children = useChildren();
  return useMemo(() => (topicId ? agentsAtWorkUnder([...children.values()], topicId) : 0), [children, topicId]);
}

/**
 * IS THIS CHAT AT WORK, and how many agents work under it: the one answer the
 * tab, the sidebar row and the loaders read. At work = a turn open, work its
 * closed turn left running (attention `working`, ATTN-02), or agents at work
 * under it. The last clause is the board agent's chat: its attention is the
 * card's (rule 2 of `compose.ts`), so with its turn closed and its sub-agents
 * working nothing else said it worked, and its tab went quiet (23/11).
 */
export function useTopicAtWork(topicId: string | null | undefined): { atWork: boolean; agents: number } {
  const inProgress = useTopicInProgress(topicId ?? undefined);
  const agents = useAgentsAtWork(topicId);
  const atWork = inProgress || agents > 0;
  return useMemo(() => ({ atWork, agents }), [atWork, agents]);
}

/**
 * A live child's row as every surface draws it. `awaiting` (its turn closed,
 * it waits on its own work) is drawn at work while that work visibly runs:
 * agents of its own at work, or a command or job of its own among its tasks.
 * Its sub-agents are judged by the tree, not by its `subagent` task, which
 * stays in the map while a child only owes a result. With nothing running it
 * stays `awaiting`, a clock (18/11).
 */
export function shownChildState(
  state: LiveAgentState,
  agentsBeneath: number,
  ownTasks: readonly { kind: string; recurring?: boolean }[],
): LiveAgentState {
  if (state !== 'awaiting') return state;
  if (agentsBeneath > 0) return 'working';
  return ownTasks.some((t) => !t.recurring && t.kind !== 'subagent' && t.kind !== 'wake') ? 'working' : 'awaiting';
}
