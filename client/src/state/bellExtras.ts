/**
 * THE BELL'S LISTS THE SOCKET DOES NOT CARRY, read once for every reader.
 *
 * The bell's number and its «Ora» tab count the same rows (one ledger), and
 * some of those rows are not in the live topics: the automations that need
 * you and the broken ones (`/api/hub/automations`, about a megabyte), the
 * contradictions of the agents' rules (`/api/hub/contesto`) and the links to
 * write to Jarvis (`/api/hub/hub-config`). The Dock, the button and the panel
 * read them from here, so the closed bell and the open panel can never list
 * different things.
 *
 * Cheap on purpose: the automations are read only when the hub's own counters
 * (`needsYou`, `broken`, streamed in the live summary) change or when there is
 * something to list, never on a timer; the two small reads run every five
 * minutes while a window is visible. One read at a time, whoever asks.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { readJson } from '../lib/readJson';
import { startVisibleInterval } from './documentVisibility';
import { setGateWaits } from './gateWaits';
import { automationWaitsOf, type AutomationWait } from '../lib/hubGates';
import { contradictions, failedJobs, jarvisLinks, type Contradiction, type FailedJob, type JarvisLinks } from '../lib/hubSystem';

export interface BellExtras {
  failed: FailedJob[];
  automations: AutomationWait[];
  contradictions: Contradiction[];
  jarvis: JarvisLinks | null;
}

export const NO_BELL_EXTRAS: BellExtras = { failed: [], automations: [], contradictions: [], jarvis: null };

/** The small reads (contradictions, links) are refreshed this often while a window is visible. */
const SMALL_REFRESH_MS = 300_000;

let state: BellExtras = NO_BELL_EXTRAS;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
/** The hub counters the automations were last read for: a new pair reads them again. */
let automationsReadFor: string | null = null;
/** The counters the readers last saw: what «read again now» reads for. */
let lastKey: string | null = null;
/** Counters that arrived while a read was going: read as soon as it ends. */
let queued: { key: string | null; force: boolean } | null = null;

function publish(next: BellExtras): void {
  state = next;
  for (const l of listeners) l();
}

/**
 * Read what the socket does not carry. `automationsKey` is the hub's pair of
 * counters (`needsYou:broken`): the megabyte is read again only when it moves,
 * or when `force` (the panel opening, the «Retry» of a band).
 */
export function refreshBellExtras(automationsKey: string | null, force = false): Promise<void> {
  lastKey = automationsKey;
  const readAutomations = automationsKey !== null && (force || automationsKey !== automationsReadFor);
  if (inFlight) {
    // A read is going and these counters are not the ones it reads for: they
    // are read right after it, never dropped. Dropped, the hub's first frame
    // (which arrives while the first read runs) left the automations unread
    // and the closed bell said 217 where the open panel listed 231.
    if (readAutomations) queued = { key: automationsKey, force };
    return inFlight;
  }
  const nothingToList = automationsKey === '0:0';
  inFlight = (async () => {
    const [automations, contesto, config] = await Promise.all([
      readAutomations && !nothingToList ? readJson('/api/hub/automations', { cache: 'no-store' }) : Promise.resolve(undefined),
      readJson('/api/hub/contesto'),
      readJson('/api/hub/hub-config'),
    ]);
    // A read that failed keeps what the last one said: a blip is not «no contradictions».
    const next: BellExtras = {
      ...state,
      ...(contesto !== null ? { contradictions: contradictions(contesto) } : {}),
      ...(config !== null ? { jarvis: jarvisLinks(config) } : {}),
    };
    if (readAutomations && nothingToList) {
      next.failed = [];
      next.automations = [];
      automationsReadFor = automationsKey;
      setGateWaits(0);
    } else if (automations !== undefined && automations !== null) {
      next.failed = failedJobs(automations);
      next.automations = automationWaitsOf(automations);
      automationsReadFor = automationsKey;
      setGateWaits(next.automations.filter((a) => a.gate).length);
    }
    publish(next);
  })().finally(() => {
    inFlight = null;
    const next = queued;
    queued = null;
    if (next && (next.force || next.key !== automationsReadFor)) void refreshBellExtras(next.key, next.force);
  });
  return inFlight;
}

/** Read everything again now, the megabyte included: the panel opening, a «Retry». */
export function rereadBellExtras(): Promise<void> {
  return refreshBellExtras(lastKey, true);
}

/** The hub went silent: nothing of what it said stays listed. */
export function clearBellExtras(): void {
  automationsReadFor = null;
  queued = null;
  if (state !== NO_BELL_EXTRAS) publish(NO_BELL_EXTRAS);
}

/**
 * The bell's extras, kept fresh while `answering`. Every caller shares the one
 * store and the one read: the Dock's provider and the open panel together cost
 * what one of them did.
 */
export function useBellExtras(answering: boolean, automationsKey: string | null): BellExtras {
  const extras = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
  );
  useEffect(() => {
    if (!answering) { clearBellExtras(); return; }
    void refreshBellExtras(automationsKey);
  }, [answering, automationsKey]);
  useEffect(() => {
    if (!answering) return;
    return startVisibleInterval(() => { void refreshBellExtras(automationsKey); }, SMALL_REFRESH_MS);
  }, [answering, automationsKey]);
  return answering ? extras : NO_BELL_EXTRAS;
}
