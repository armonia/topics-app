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
import type { ChildAgentRow } from '../../../shared/live-work';

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
