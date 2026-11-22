/**
 * machineHealthStore - the last health round of every machine
 * (`GET /api/machines/health`), in one module store like `machinesStore`.
 *
 * The round runs on the server every 30 minutes for security, so a slow poll
 * while somebody is looking is enough; with no subscriber nothing is fetched.
 * "Not read yet" stays `null` and never becomes an empty list.
 */
import { useSyncExternalStore } from 'react';
import type { MachineHealthEntry, MachinesHealthFile } from '../../../shared/machine-health';
import { apiFetch } from '../lib/shell/net';

const POLL_MS = 60_000;

let entries: MachineHealthEntry[] | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    const r = await apiFetch('/api/machines/health', { credentials: 'same-origin' });
    if (!r.ok) return;
    entries = ((await r.json()) as MachinesHealthFile).machines ?? [];
    listeners.forEach((cb) => cb());
  } catch {
    // Keep what we had: a failed read must not turn a known state into "unknown".
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    void load();
    timer = setInterval(() => void load(), POLL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

/** The rounds' machines, or `null` until the first read answers. */
export function useMachineHealth(): MachineHealthEntry[] | null {
  return useSyncExternalStore(subscribe, () => entries, () => null);
}

/** The entry of a paired node (by id) or of this computer (`id` null). */
export function healthOf(all: MachineHealthEntry[] | null, id: string | null): MachineHealthEntry | null {
  return (all ?? []).find((m) => (id === null ? m.kind === 'local' : m.id === id)) ?? null;
}

/** The cloud node is a placeholder row (its base URL is a scheme, not an address): no round ever measures it. Mirrors `CLOUD_NODE_BASE_URL` on the server. */
export function isCloudNode(node: { baseUrl: string | null }): boolean {
  return !!node.baseUrl?.startsWith('claude-cloud://');
}
