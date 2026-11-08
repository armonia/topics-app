/**
 * WHICH SESSIONS TOPICS IS HOLDING STOPPED RIGHT NOW.
 *
 * Mirror of the server's freezer (`server/services/swap-freeze.ts`): with the
 * Mac in sustained swap the heaviest command an agent launched in the background
 * is SIGSTOPped until there is room again. The server sends the whole list on
 * every change and again on every connect, so a reload lands on the same frost;
 * an empty list is a thaw.
 *
 * Same shape as `providerHold.ts`, and for the same reason: the store is read by
 * a card, a sidebar row, a tab and a pane at once, and a per-component fetch of
 * a fact the socket already carries would be four readings that can disagree.
 */
import { useSyncExternalStore } from 'react';
import { subscribeFrames } from '../lib/wsFrameBus';
import type { SwapFreezeView } from '../../../shared/swap-freeze';

export type { SwapFreezeView };

const EMPTY: SwapFreezeView[] = [];

let views: SwapFreezeView[] = EMPTY;
const listeners = new Set<() => void>();
let wired = false;

function announce(): void {
  for (const cb of listeners) cb();
}

function adopt(frame: unknown): void {
  const f = frame as { type?: string; views?: unknown } | null;
  if (!f || f.type !== 'swap-freeze:state') return;
  const next = Array.isArray(f.views)
    ? (f.views as SwapFreezeView[]).filter((v) => v && typeof v.id === 'string')
    : [];
  // The array's identity is the change: components read it with
  // `useSyncExternalStore`, and a new array on every frame would re-render every
  // card on the board for a freeze that did not move.
  if (next.length === 0 && views.length === 0) return;
  if (next.length === views.length && next.every((v, i) => v.id === views[i]!.id && v.frozenAt === views[i]!.frozenAt)) return;
  views = next.length === 0 ? EMPTY : next;
  announce();
}

function wire(): void {
  if (wired) return;
  wired = true;
  subscribeFrames(adopt, { types: ['swap-freeze:state'] });
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Everything frozen, newest first. */
export function useSwapFreezeViews(): SwapFreezeView[] {
  return useSyncExternalStore(subscribe, () => views, () => views);
}

/**
 * The freeze that belongs to one surface. A pane knows its terminal id, a chat
 * and a sidebar row their topic, a board card only the task - and a card's
 * session is reached through `assignedTopicId`, which is why the topic match is
 * tried for it too.
 */
export function pickSwapFreeze(
  list: readonly SwapFreezeView[],
  q: { topicId?: string | null; terminalId?: string | null; taskId?: string | null },
): SwapFreezeView | null {
  if (list.length === 0) return null;
  const byTerminal = q.terminalId ? list.find((v) => v.terminalId === q.terminalId) : undefined;
  if (byTerminal) return byTerminal;
  const byTopic = q.topicId
    ? list.find((v) => v.topicId === q.topicId || v.sessionKey === q.topicId || v.sessionKey === `topic:${q.topicId}`)
    : undefined;
  if (byTopic) return byTopic;
  const byTask = q.taskId ? list.find((v) => v.taskId === q.taskId) : undefined;
  return byTask ?? null;
}

export function useSwapFreeze(q: { topicId?: string | null; terminalId?: string | null; taskId?: string | null }): SwapFreezeView | null {
  return pickSwapFreeze(useSwapFreezeViews(), q);
}

/** Test seam: feed a frame as the socket would. */
export const _adoptForTests = adopt;
/** Test seam: what a mounted component would read, without React. */
export const _readForTests = (): SwapFreezeView[] => views;
/** Test seam: subscribe as the hook does. */
export const _subscribeForTests = subscribe;
/** Test seam: one test's frames must not reach the next one. */
export function _resetForTests(): void {
  views = EMPTY;
}
