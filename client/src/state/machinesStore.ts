/**
 * machinesStore - the machines this installation knows (`GET /api/machines`),
 * in ONE place, kept live by the `machine:*` frames.
 *
 * WHY A MODULE STORE AND NOT A FETCH PER COMPONENT. Two surfaces read the same
 * rows: the node picker in the task drawer, and the chip on every card that
 * names a node. A card cannot fetch: there are dozens on a board, and one
 * request each for a list of two rows is the defect. A per-component copy also
 * drifts, which is what the live half is for: a node that goes offline has to
 * grey out on the open picker without anyone reopening it.
 *
 * THE LOCAL ROW IS NOT A NODE. `baseUrl === null` marks the machine this server
 * runs on (MACHINE-02): it is never a pairing target and must not appear as a
 * choice, otherwise "run it there" would be offered for "here".
 */
import { useSyncExternalStore } from 'react';
import type { Machine, WSMachineMessage } from '../types';
import { subscribeFrames } from '../lib/wsFrameBus';

let machines: Machine[] | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
let unsubFrames: (() => void) | null = null;

function publish(): void {
  listeners.forEach((cb) => cb());
}

const byName = (a: Machine, b: Machine) => a.name.localeCompare(b.name);

async function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch('/api/machines', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json() as { machines?: Machine[] };
      machines = (body.machines ?? []).slice().sort(byName);
      publish();
    } catch {
      // "Not known" stays null and never becomes an empty list: `[]` would read
      // as "no node paired" and hide the chip on a card that HAS one, which is
      // worse than a picker that is still loading.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Fold one frame in. `machine:updated` carries the whole row, but it is typed
 * as a patch on the wire: merging instead of replacing keeps a field a future
 * server sends partially from being wiped here.
 */
function applyFrame(frame: unknown): void {
  const msg = frame as WSMachineMessage | null;
  const id = msg?.machine?.id;
  if (!msg || !id) return;
  const current = machines ?? [];
  if (msg.type === 'machine:deleted') {
    if (!current.some((m) => m.id === id)) return;
    machines = current.filter((m) => m.id !== id);
    publish();
    return;
  }
  const at = current.findIndex((m) => m.id === id);
  if (at >= 0) {
    const next = current.slice();
    next[at] = { ...next[at], ...msg.machine };
    machines = next.sort(byName);
  } else {
    // A row we have never seen: only a full one can be added, and only once
    // the first read has happened. Before that the list is still `null` and
    // adding here would turn "not read yet" into "one machine exists".
    if (machines === null) return;
    machines = [...current, msg.machine as Machine].sort(byName);
  }
  publish();
}

function start(): void {
  unsubFrames = subscribeFrames(applyFrame, {
    types: ['machine:upserted', 'machine:updated', 'machine:deleted'],
  });
  void load();
}

function stop(): void {
  unsubFrames?.();
  unsubFrames = null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) start();
  // A remount is a retry: a first read that failed left `machines` null, and
  // without this the list stayed unread for the life of the document.
  else if (machines === null && !inflight) void load();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stop();
  };
}

const snapshot = () => machines;
const noopSubscribe = () => () => {};
const getNull = () => null;

/**
 * Every machine row, or `null` until the first read answers.
 *
 * `enabled=false` neither subscribes nor fetches: a card without a `machineId`
 * has nothing to name, and a board full of them would otherwise hold a
 * subscription each for an answer none of them reads.
 */
export function useMachines(enabled = true): Machine[] | null {
  return useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    enabled ? snapshot : getNull,
    getNull,
  );
}

/** The paired nodes: every machine except the local row. */
export function nodesOf(all: Machine[] | null): Machine[] {
  return (all ?? []).filter((m) => m.baseUrl !== null);
}

/**
 * What to print for a `machineId`. Falls back to the id when the row has not
 * arrived (or is gone): a chip that says "on <name>" with an empty name reads
 * as a bug, an id at least points at something.
 */
export function machineLabel(all: Machine[] | null, id: string): string {
  return (all ?? []).find((m) => m.id === id)?.name ?? id;
}

/** Refresh after a pairing: the approved row arrives on the same frame bus,
 *  but a client whose socket is down would otherwise never see its own node. */
export function reloadMachines(): void {
  void load();
}
