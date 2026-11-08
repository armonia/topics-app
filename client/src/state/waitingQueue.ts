/**
 * The queue of chats waiting for you, as the sidebar orders it (CHAT-WAIT-03).
 *
 * `TopicTree` owns the order (pinned first, then the «Attende te» section) and computes the
 * queue with `waitingQueue` in `lib/waitingQueue.ts`: it writes it here so the
 * phone door (`MobileChromeBar`, mounted by App outside the tree) can show how
 * many there are. Door number and ⌘J targets therefore come from one list and
 * cannot disagree (CHAT-WAIT-04).
 *
 * `last` is where the previous step took you, with the queue it was taken
 * from: after you answer that chat it leaves the queue, and «the one after it»
 * can only be read in the queue of before (see `nextWaiting`).
 */
import { create } from 'zustand';

/** ⌘J and the phone door announce it; the sidebar answers. */
export const NEXT_WAITING_EVENT = 'topics:next-waiting';

/** The previous step: the chat it opened, and the queue it chose it from. */
export interface WaitingStep {
  queue: string[];
  target: string;
}

interface WaitingQueueState {
  /** Subjects (topic id, or terminal session id) in sidebar order. */
  queue: string[];
  last: WaitingStep | null;
}

export const useWaitingQueueStore = create<WaitingQueueState>(() => ({
  queue: [],
  last: null,
}));

function sameQueue(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export const waitingQueueActions = {
  /** Writes only on a real change: the tree rebuilds its items on every
   *  signal, and a new array each time would wake the door for nothing. */
  setQueue: (queue: string[]) =>
    useWaitingQueueStore.setState((s) => (sameQueue(s.queue, queue) ? s : { queue })),
  setLast: (last: WaitingStep) => useWaitingQueueStore.setState({ last }),
};
