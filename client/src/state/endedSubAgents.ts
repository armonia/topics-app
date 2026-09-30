/**
 * THE SUB-AGENTS A CHAT SPAWNED, INCLUDING THE ONES THAT ALREADY ENDED.
 *
 * The in-chat strip (`components/Chat/SubAgentsStrip.tsx`) used to read only
 * the live terminal roster, filtered by `parentSessionKey`. The roster is the
 * server's in-memory session map, and a sub-agent leaves it the instant its
 * process exits: Ctrl+C or `/exit` typed into its pane, a crash, a kill under
 * swap, the parent's `stop_agent`. From the chat that was a row that simply
 * VANISHED - and when it was the only one, the whole strip with it - with
 * nothing saying whether the sub-agent finished, died, or was never there.
 *
 * So the departure is recorded here, at the one place the roster is replaced
 * (`useTerminalLifecycle#applyRoster`), and the strip keeps an ended row, with
 * the same calm "done" mark finished terminals carry elsewhere, until one of
 * two things happens:
 *   - the user dismisses it (the row's own close button, or closing its
 *     terminal tab, which is the same gesture);
 *   - the parent chat closes, which in this app means ARCHIVED (the server's
 *     `topic:archived` frame).
 * A sub-agent that comes back (its pane's Resume) is live again and its ended
 * entry is dropped by the same reconcile.
 *
 * A dismissal is REMEMBERED, not only applied. Closing the tab of a sub-agent
 * that is still running retires its session on the server, and the roster that
 * follows would record that departure as an end: the row the user just closed
 * came back, marked ended. So a dismissed id is not recorded again when it
 * leaves, until it comes back to life (a revive clears it).
 *
 * Persisted in localStorage because a reload is neither of the two exits: the
 * roster cache it is compared against (`terminal-sessions-cache`) survives the
 * reload too, so a sub-agent that ended while the page was closed is still
 * caught by the first roster after boot. Every window of the browser shares
 * that storage, so every change is a read-modify-write of what is STORED, and
 * a `storage` listener brings the other windows' changes in: a window working
 * from its own copy wrote back rows another window had dismissed.
 */
import { useSyncExternalStore } from 'react';
import { subscribeFrames } from '../lib/wsFrameBus';
import type { TerminalSessionInfo } from '../types';

export interface EndedSubAgent {
  id: string;
  name: string;
  parentSessionKey: string;
  /** Epoch ms of the roster that first missed it. */
  endedAt: number;
}

export type SubAgentState = 'busy' | 'idle' | 'ended';

export interface SubAgentRow {
  id: string;
  name: string;
  state: SubAgentState;
}

/**
 * Upper bound on what is remembered. Board tasks spawn sub-agents too, and an
 * entry is only removed by a dismissal or an archive: without a bound the list
 * would only ever grow in localStorage. The oldest go first.
 */
export const MAX_ENDED_SUB_AGENTS = 50;

const STORAGE_KEY = 'topics:ended-sub-agents';

type Roster = readonly Pick<TerminalSessionInfo, 'id' | 'name' | 'parentSessionKey'>[];

/** What the store keeps: the ended rows, and the ids the user dismissed. */
export interface SubAgentMemory {
  ended: readonly EndedSubAgent[];
  /** Oldest first, bounded like `ended`. */
  dismissed: readonly string[];
}

export const EMPTY_MEMORY: SubAgentMemory = { ended: [], dismissed: [] };

function bounded<T>(list: readonly T[]): readonly T[] {
  return list.length > MAX_ENDED_SUB_AGENTS ? list.slice(list.length - MAX_ENDED_SUB_AGENTS) : list;
}

/**
 * The memory after the roster went from `previous` to `next`. Pure. Returns
 * `memory` itself when nothing changed, so a caller can skip the write and
 * the re-render.
 *
 *   - a sub-agent listed before and missing now has ended, unless the user
 *     dismissed it (closing a live sub-agent's tab is what made it leave);
 *   - one listed now is live, whatever was recorded about it;
 *   - one listed now and not before came back (a revive): its dismissal is
 *     spent, and a later end is recorded again.
 */
export function recordSubAgentDepartures(
  previous: Roster,
  next: Roster,
  memory: SubAgentMemory,
  now: number,
): SubAgentMemory {
  const liveIds = new Set(next.map((s) => s.id));
  const previousIds = new Set(previous.map((s) => s.id));
  const kept = memory.ended.filter((e) => !liveIds.has(e.id));
  const dismissed = memory.dismissed.filter((id) => !(liveIds.has(id) && !previousIds.has(id)));
  const skipIds = new Set([...kept.map((e) => e.id), ...dismissed]);
  const departed: EndedSubAgent[] = [];
  for (const s of previous) {
    if (!s.parentSessionKey || liveIds.has(s.id) || skipIds.has(s.id)) continue;
    skipIds.add(s.id);
    departed.push({ id: s.id, name: s.name, parentSessionKey: s.parentSessionKey, endedAt: now });
  }
  if (departed.length === 0 && kept.length === memory.ended.length && dismissed.length === memory.dismissed.length) {
    return memory;
  }
  return { ended: bounded(departed.length ? [...kept, ...departed] : kept), dismissed };
}

/**
 * The user is done with this sub-agent: its ended row goes, and its next
 * departure from the roster is not recorded. Pure; `memory` back unchanged
 * when it was already dismissed and has no row.
 */
export function dismissInMemory(memory: SubAgentMemory, id: string): SubAgentMemory {
  const hasRow = memory.ended.some((e) => e.id === id);
  if (!hasRow && memory.dismissed.includes(id)) return memory;
  return {
    ended: hasRow ? memory.ended.filter((e) => e.id !== id) : memory.ended,
    dismissed: bounded([...memory.dismissed.filter((d) => d !== id), id]),
  };
}

/**
 * The strip's rows for one chat: the live children first (busy or idle, in
 * roster order), then the ended ones that are not live again, oldest first.
 */
export function subAgentRowsFor(
  parentSessionKey: string,
  live: readonly Pick<TerminalSessionInfo, 'id' | 'name' | 'parentSessionKey' | 'busy'>[],
  ended: readonly EndedSubAgent[],
): SubAgentRow[] {
  const rows: SubAgentRow[] = [];
  const liveIds = new Set<string>();
  for (const s of live) {
    if (s.parentSessionKey !== parentSessionKey) continue;
    liveIds.add(s.id);
    rows.push({ id: s.id, name: s.name, state: s.busy ? 'busy' : 'idle' });
  }
  for (const e of ended) {
    if (e.parentSessionKey !== parentSessionKey || liveIds.has(e.id)) continue;
    rows.push({ id: e.id, name: e.name, state: 'ended' });
  }
  return rows;
}

// --- The store ----------------------------------------------------------------

function isEndedSubAgent(v: unknown): v is EndedSubAgent {
  const e = v as Partial<EndedSubAgent> | null;
  return !!e && typeof e.id === 'string' && typeof e.name === 'string'
    && typeof e.parentSessionKey === 'string' && typeof e.endedAt === 'number';
}

function parse(raw: string | null): SubAgentMemory {
  if (!raw) return EMPTY_MEMORY;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SubAgentMemory, unknown>> | null;
    return {
      ended: Array.isArray(v?.ended) ? v.ended.filter(isEndedSubAgent) : [],
      dismissed: Array.isArray(v?.dismissed) ? v.dismissed.filter((d): d is string => typeof d === 'string') : [],
    };
  } catch {
    return EMPTY_MEMORY;
  }
}

/** The in-memory copy the UI renders, and the stored text it was read from. */
let snapshot: SubAgentMemory = EMPTY_MEMORY;
let snapshotRaw: string | null | undefined;
const listeners = new Set<() => void>();
let wired = false;

function notify(): void {
  for (const cb of listeners) cb();
}

/**
 * The memory as STORED now, which another window may have changed since this
 * one last looked. Same object back while the stored text is the same. When
 * storage cannot be read the in-memory copy is all there is.
 */
function refresh(): SubAgentMemory {
  let raw: string | null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return snapshot; }
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = parse(raw);
  }
  return snapshot;
}

function update(change: (memory: SubAgentMemory) => SubAgentMemory): void {
  const before = snapshot;
  const base = refresh();
  const next = change(base);
  if (next !== base) {
    snapshot = next;
    const empty = next.ended.length === 0 && next.dismissed.length === 0;
    const raw = empty ? null : JSON.stringify(next);
    try {
      if (raw === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, raw);
      snapshotRaw = raw;
    } catch { /* storage full or denied: the in-memory copy still holds */ }
  }
  if (snapshot !== before) notify();
}

/** What this window renders now. */
export function subAgentMemorySnapshot(): SubAgentMemory {
  if (snapshotRaw === undefined) refresh();
  return snapshot;
}

function wire(): void {
  if (wired) return;
  wired = true;
  // Another window of this browser changed the list (`key` is null when it
  // cleared the whole storage).
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    const before = snapshot;
    if (refresh() !== before) notify();
  });
  // The parent chat closing is the second exit. `topic:archived` carries the
  // whole topic, so its sessionKey is right there.
  subscribeFrames((frame) => {
    const key = (frame as { topic?: { sessionKey?: unknown } } | null)?.topic?.sessionKey;
    if (typeof key !== 'string') return;
    update((m) => (m.ended.some((e) => e.parentSessionKey === key)
      ? { ...m, ended: m.ended.filter((e) => e.parentSessionKey !== key) }
      : m));
  }, { types: ['topic:archived'] });
}

export function subscribeSubAgentMemory(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Called with every roster the client ACCEPTS, before it replaces the old one. */
export function noteTerminalRosterReplaced(previous: Roster, next: Roster): void {
  wire();
  update((m) => recordSubAgentDepartures(previous, next, m, Date.now()));
}

/**
 * The user is done with this sub-agent: its row's close button, or its
 * terminal tab closed, whichever way (tab bar, shortcut, sidebar, project).
 */
export function dismissSubAgent(sessionId: string): void {
  wire();
  update((m) => dismissInMemory(m, sessionId));
}

function currentEnded(): readonly EndedSubAgent[] {
  return subAgentMemorySnapshot().ended;
}

export function useEndedSubAgents(): readonly EndedSubAgent[] {
  return useSyncExternalStore(subscribeSubAgentMemory, currentEnded, currentEnded);
}
