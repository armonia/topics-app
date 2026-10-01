/**
 * The runs of the replies on screen, one request per reply (CHAT-RUN-03).
 *
 * Every code block of a reply reads the same list, so it is fetched once per
 * reply and shared: a reply with five `bash` blocks is one request, not five.
 * The list is read again when the server says a run of that reply changed
 * (`command-run:updated`), from any window or device of the owner; a running
 * run's output is read from the registry by its block, poked by
 * `scripts:output`. Nothing here starts a run: only a click does.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { commandRunsApi, type CommandRunInfo } from '../../lib/api';

const runsByMessage = new Map<string, CommandRunInfo[]>();
const sessionOf = new Map<string, string>();
const loading = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const outputPokes = new Map<string, Set<() => void>>();

function emit(messageId: string): void {
  for (const fn of listeners.get(messageId) ?? []) fn();
}

/** Asked again while a request was in flight: that answer may predate the change, so one more follows it. */
const askedAgain = new Set<string>();

function load(sessionKey: string, messageId: string): void {
  if (loading.has(messageId)) { askedAgain.add(messageId); return; }
  loading.add(messageId);
  commandRunsApi.list(sessionKey, messageId)
    .then((runs) => { runsByMessage.set(messageId, runs); emit(messageId); })
    .catch(() => { /* no list: the blocks show no run, and the next frame or mount asks again */ })
    .finally(() => {
      loading.delete(messageId);
      if (askedAgain.delete(messageId)) load(sessionKey, messageId);
    });
}

const NO_RUNS: CommandRunInfo[] = [];

/** The last run of each block of a reply; empty until the list arrives. */
export function useMessageRuns(sessionKey: string | null, messageId: string | null): CommandRunInfo[] {
  const subscribe = useCallback((fn: () => void) => {
    if (!sessionKey || !messageId) return () => {};
    sessionOf.set(messageId, sessionKey);
    let set = listeners.get(messageId);
    // The first block of a reply to come on screen asks: what it held may have
    // changed from another device while nobody here was looking.
    if (!set) { listeners.set(messageId, (set = new Set())); load(sessionKey, messageId); }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) listeners.delete(messageId);
    };
  }, [sessionKey, messageId]);
  const snapshot = useCallback(() => (messageId ? runsByMessage.get(messageId) ?? NO_RUNS : NO_RUNS), [messageId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A run just started here: shown at once, before the list comes back. */
export function putStartedRun(messageId: string, run: CommandRunInfo): void {
  const rest = (runsByMessage.get(messageId) ?? []).filter((r) => r.blockKey !== run.blockKey);
  runsByMessage.set(messageId, [...rest, run]);
  emit(messageId);
}

/** The list of a reply again, now: after a Stop, or when a frame says it changed. */
export function refreshMessageRuns(sessionKey: string, messageId: string): void {
  load(sessionKey, messageId);
}

export function subscribeRunOutput(processId: string, fn: () => void): () => void {
  let set = outputPokes.get(processId);
  if (!set) outputPokes.set(processId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) outputPokes.delete(processId);
  };
}

/**
 * The two frames this store listens to, from the app's one WebSocket. A reply
 * nobody has on screen is not fetched: it reads its list when it mounts.
 */
export function noteCommandRunFrame(msg: { type?: string; sessionKey?: string; messageId?: string; processId?: string }): void {
  if (msg.type === 'command-run:updated' && msg.messageId && listeners.has(msg.messageId)) {
    load(msg.sessionKey ?? sessionOf.get(msg.messageId) ?? '', msg.messageId);
  } else if (msg.type === 'scripts:output' && msg.processId) {
    for (const fn of outputPokes.get(msg.processId) ?? []) fn();
  }
}
