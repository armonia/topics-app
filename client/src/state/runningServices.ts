/**
 * THE SERVERS A CHAT RUNS, as the client keeps them (BGVIS-08).
 *
 * A `run_command` that listens on a port and does not wake its chat is a
 * server, not work the chat waits for: the server leaves it out of the
 * background rows of `GET /api/topics/streaming` (so no grey ring, no waiting
 * line, no active agent) and lists it in `services`. This keeps that list by
 * topic for the chat's server row, apart from the background work on purpose:
 * nothing that reads the background work (glyphs, the composer's Stop, the
 * agent list) may see a server.
 *
 * Every poll answers with new objects; an entry that did not change keeps its
 * reference, so the row of a chat whose servers did not change does not render.
 *
 * An ended server is told for `SERVICE_ENDED_SHOWN_MS`, counted here from the
 * first poll that says it ended, and then left out even while the server still
 * lists it. The row kept that clock itself, and the transcript's footer it
 * lives in remounts: each remount inside the server's window showed it again.
 */
import { useSyncExternalStore } from 'react';
import type { RunningServiceSummary, TopicServices } from '../../../shared/background-work';

type ServicesByTopic = ReadonlyMap<string, readonly RunningServiceSummary[]>;

const EMPTY: ServicesByTopic = new Map();
let current: ServicesByTopic = EMPTY;
const listeners = new Set<() => void>();

/** The next map from a poll's `services`, keeping every unchanged entry, and `prev` itself when nothing changed. */
export function mergeServices(prev: ServicesByTopic, rows: ReadonlyArray<TopicServices> | undefined): ServicesByTopic {
  const next = new Map<string, readonly RunningServiceSummary[]>();
  let changed = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.topicId || !Array.isArray(row.services) || row.services.length === 0) continue;
    const old = prev.get(row.topicId);
    if (old && JSON.stringify(old) === JSON.stringify(row.services)) next.set(row.topicId, old);
    else { next.set(row.topicId, row.services); changed = true; }
  }
  if (!changed && next.size === prev.size) return prev;
  return next.size === 0 ? EMPTY : next;
}

/** How long an ended server keeps its row on screen, saying how it ended. */
export const SERVICE_ENDED_SHOWN_MS = 5_000;

/** When each ended server was first seen ended, while polls still carry it. */
const endedSeenAt = new Map<string, number>();
let lastRows: ReadonlyArray<TopicServices> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** `rows` without the ended servers past their few seconds; records in `seen` when each was first seen ended. */
function withinEndedWindow(rows: ReadonlyArray<TopicServices> | undefined, seen: Map<string, number>, now: number): TopicServices[] {
  const carried = new Set<string>();
  const out: TopicServices[] = [];
  const list: ReadonlyArray<TopicServices> = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!row || !Array.isArray(row.services)) continue;
    const services = row.services.filter((s) => {
      if (!s.ended) return true;
      carried.add(s.processId);
      const at = seen.get(s.processId) ?? now;
      seen.set(s.processId, at);
      return now - at < SERVICE_ENDED_SHOWN_MS;
    });
    out.push(services.length === row.services.length ? row : { ...row, services });
  }
  for (const id of [...seen.keys()]) if (!carried.has(id)) seen.delete(id);
  return out;
}

/** Adopt a poll's `services` (an older server sends none: no servers). */
export function setRunningServices(rows: ReadonlyArray<TopicServices> | undefined, now = Date.now()): void {
  lastRows = rows;
  const next = mergeServices(current, withinEndedWindow(rows, endedSeenAt, now));
  // The row goes when its few seconds are over, not at the next poll.
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const due = [...endedSeenAt.values()].map((at) => at + SERVICE_ENDED_SHOWN_MS - now).filter((ms) => ms > 0);
  if (due.length) expiryTimer = setTimeout(() => setRunningServices(lastRows), Math.min(...due) + 1);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** A chat's servers, running or just ended, or undefined. A stable reference while they do not change. */
export function topicRunningServices(topicId: string | undefined): readonly RunningServiceSummary[] | undefined {
  return topicId ? current.get(topicId) : undefined;
}

/** `topicRunningServices`, for a component. */
export function useTopicRunningServices(topicId: string | undefined): readonly RunningServiceSummary[] | undefined {
  return useSyncExternalStore(subscribe, () => topicRunningServices(topicId));
}
