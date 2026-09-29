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
 * Persisted in localStorage because a reload is neither of the two exits: the
 * roster cache it is compared against (`terminal-sessions-cache`) survives the
 * reload too, so a sub-agent that ended while the page was closed is still
 * caught by the first roster after boot.
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

/**
 * The new list of ended sub-agents after the roster went from `previous` to
 * `next`. Pure. Returns `ended` itself when nothing changed, so a caller can
 * skip the write and the re-render.
 *
 *   - a sub-agent listed before and missing now has ended;
 *   - one listed now is live, whatever was recorded about it (a revive).
 */
export function recordSubAgentDepartures(
  previous: Roster,
  next: Roster,
  ended: readonly EndedSubAgent[],
  now: number,
): readonly EndedSubAgent[] {
  const liveIds = new Set(next.map((s) => s.id));
  const kept = ended.filter((e) => !liveIds.has(e.id));
  const knownIds = new Set(kept.map((e) => e.id));
  const departed: EndedSubAgent[] = [];
  for (const s of previous) {
    if (!s.parentSessionKey || liveIds.has(s.id) || knownIds.has(s.id)) continue;
    knownIds.add(s.id);
    departed.push({ id: s.id, name: s.name, parentSessionKey: s.parentSessionKey, endedAt: now });
  }
  if (departed.length === 0 && kept.length === ended.length) return ended;
  const merged = departed.length ? [...kept, ...departed] : kept;
  return merged.length > MAX_ENDED_SUB_AGENTS ? merged.slice(merged.length - MAX_ENDED_SUB_AGENTS) : merged;
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

const EMPTY: readonly EndedSubAgent[] = [];

function isEndedSubAgent(v: unknown): v is EndedSubAgent {
  const e = v as Partial<EndedSubAgent> | null;
  return !!e && typeof e.id === 'string' && typeof e.name === 'string'
    && typeof e.parentSessionKey === 'string' && typeof e.endedAt === 'number';
}

function load(): readonly EndedSubAgent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEndedSubAgent) : EMPTY;
  } catch {
    return EMPTY;
  }
}

let ended: readonly EndedSubAgent[] | null = null;
const listeners = new Set<() => void>();
let wired = false;

function current(): readonly EndedSubAgent[] {
  if (ended === null) ended = load();
  return ended;
}

function commit(next: readonly EndedSubAgent[]): void {
  if (next === current()) return;
  ended = next.length ? next : EMPTY;
  try {
    if (ended.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(ended));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage full or denied: the in-memory list still holds */ }
  for (const cb of listeners) cb();
}

function wire(): void {
  if (wired) return;
  wired = true;
  // The parent chat closing is the second exit. `topic:archived` carries the
  // whole topic, so its sessionKey is right there.
  subscribeFrames((frame) => {
    const key = (frame as { topic?: { sessionKey?: unknown } } | null)?.topic?.sessionKey;
    if (typeof key !== 'string') return;
    const list = current();
    if (list.some((e) => e.parentSessionKey === key)) commit(list.filter((e) => e.parentSessionKey !== key));
  }, { types: ['topic:archived'] });
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Called with every roster the client ACCEPTS, before it replaces the old one. */
export function noteTerminalRosterReplaced(previous: Roster, next: Roster): void {
  wire();
  commit(recordSubAgentDepartures(previous, next, current(), Date.now()));
}

/** The user is done with this sub-agent: stop showing it as ended. */
export function dismissEndedSubAgent(id: string): void {
  const list = current();
  if (list.some((e) => e.id === id)) commit(list.filter((e) => e.id !== id));
}

export function useEndedSubAgents(): readonly EndedSubAgent[] {
  return useSyncExternalStore(subscribe, current, current);
}
