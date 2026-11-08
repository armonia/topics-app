import { useSyncExternalStore } from 'react';
import {
  SLOW_INTERACTION_MS,
  addInteraction,
  emptyInteractionHistogram,
  interactionBucket,
  interactionPercentile,
} from '../../../shared/interaction-histogram';

/**
 * Slow interaction tracking built on the browser Event Timing API.
 *
 * Event Timing reports one entry per slow event, and several entries share
 * one interaction id (pointerdown, pointerup and click belong to the same
 * tap). This module groups entries by id, keeps the slow ones in a bounded
 * store, and shares that store through useSyncExternalStore, following the
 * fpsMonitor shape: a module singleton, one shared snapshot, no timers and
 * no animation frames. The observer only wakes for slow input, so an idle
 * page pays nothing.
 *
 * Bucket arithmetic lives in shared/interaction-histogram, next to the gate
 * that reads it back from the server log.
 */

/** One raw Event Timing entry, without depending on fresh DOM library types. */
export interface EventTimingLike {
  name: string;
  duration: number;
  startTime: number;
  interactionId?: number;
  target?: unknown;
}

/** The facts a panel shows about one slow interaction. */
export interface WorstInteraction {
  name: string;
  durationMs: number;
  target: string;
  atMs: number;
}

export interface InteractionSnapshot {
  supported: boolean;
  total: number;
  slow: number;
  worst: WorstInteraction | null;
  recent: readonly WorstInteraction[];
  histogram: readonly number[];
  p95Ms: number | null;
}

/** The entries object the observer hands to its callback. */
interface EntryListLike {
  getEntries(): readonly EventTimingLike[];
}

/** The observer surface this module needs, read off globalThis at start. */
type ObserverFactory = new (callback: (list: EntryListLike) => void) => {
  observe(options: { type: string; durationThreshold: number; buffered: boolean }): void;
  disconnect?: () => void;
};

/** Browser-wide interaction totals when the engine exposes them. */
interface InteractionCounters {
  interactionCount?: unknown;
  eventCounts?: unknown;
}

/** One interaction seen before, with the bucket it was counted in. */
interface TrackedInteraction {
  duration: number;
  bucket: number;
  record: WorstInteraction | null;
}

const MAX_TRACKED_IDS = 8;
const MAX_RECENT = 32;

let started = false;
let supported = false;
let histogram: number[] = emptyInteractionHistogram();
let slow = 0;
let total = 0;
let worst: WorstInteraction | null = null;
let recentEntries: WorstInteraction[] = [];
const seen = new Map<number, TrackedInteraction>();
const listeners = new Set<() => void>();
let activeObserver: { disconnect?: () => void } | null = null;
let snapshot: InteractionSnapshot = {
  supported: false,
  total: 0,
  slow: 0,
  worst: null,
  recent: [],
  histogram: emptyInteractionHistogram(),
  p95Ms: null,
};

function emit(): void {
  for (const listener of listeners) listener();
}

function readObserverFactory(): ObserverFactory | null {
  const holder = globalThis as unknown as { PerformanceObserver?: unknown };
  if (typeof holder.PerformanceObserver !== 'function') return null;
  return holder.PerformanceObserver as ObserverFactory;
}

function eventTypeSupported(factory: ObserverFactory): boolean {
  const kinds = (factory as unknown as { supportedEntryTypes?: unknown }).supportedEntryTypes;
  return Array.isArray(kinds) && kinds.includes('event');
}

function readInteractionTotal(slowCount: number): number {
  const holder = globalThis as unknown as { performance?: InteractionCounters };
  const counters = holder.performance;
  if (counters) {
    if (typeof counters.interactionCount === 'number' && Number.isFinite(counters.interactionCount)) {
      return Math.max(counters.interactionCount, slowCount);
    }
    if (counters.eventCounts instanceof Map) {
      const pointerUp = counters.eventCounts.get('pointerup');
      const keyDown = counters.eventCounts.get('keydown');
      let sum = 0;
      if (typeof pointerUp === 'number' && Number.isFinite(pointerUp)) sum += pointerUp;
      if (typeof keyDown === 'number' && Number.isFinite(keyDown)) sum += keyDown;
      return Math.max(sum, slowCount);
    }
  }
  return slowCount;
}

function readTestId(candidate: object): string {
  const fields = (candidate as { dataset?: unknown }).dataset;
  if (typeof fields === 'object' && fields !== null) {
    const testId = (fields as { testid?: unknown }).testid;
    if (typeof testId === 'string' && testId.length > 0) return testId;
  }
  const getAttribute = (candidate as { getAttribute?: unknown }).getAttribute;
  if (typeof getAttribute === 'function') {
    const found = (getAttribute as (name: string) => unknown).call(candidate, 'data-testid');
    if (typeof found === 'string' && found.length > 0) return found;
  }
  return '';
}

// A short string only, never the node: holding the node would pin the whole
// subtree in the store and grow with the page.
function describeTarget(entry: EventTimingLike): string {
  const candidate = entry.target;
  if (typeof candidate === 'object' && candidate !== null) {
    const tag = (candidate as { tagName?: unknown }).tagName;
    if (typeof tag === 'string' && tag.length > 0) {
      const lower = tag.toLowerCase();
      const testId = readTestId(candidate);
      return testId === '' ? lower : `${lower}[data-testid=${testId}]`;
    }
  }
  return entry.name;
}

function rebuildSnapshot(): void {
  snapshot = {
    supported,
    total,
    slow,
    worst,
    recent: recentEntries.slice(),
    histogram: histogram.slice(),
    p95Ms: interactionPercentile(histogram, total, 0.95),
  };
}

// One entry moves at most one interaction. Answers true when the store changed.
function processEntry(entry: EventTimingLike): boolean {
  const id = entry.interactionId;
  if (id === undefined || !(id > 0)) return false;
  const duration = entry.duration;
  const known = seen.get(id);
  if (known !== undefined) {
    // The interaction lasts as long as the longest of its entries.
    if (!(duration > known.duration)) return false;
    if (known.bucket >= 0) histogram[known.bucket] = (histogram[known.bucket] ?? 0) - 1;
    const bucket = interactionBucket(duration);
    if (bucket >= 0) {
      addInteraction(histogram, duration);
      known.bucket = bucket;
    } else {
      known.bucket = -1;
    }
    known.duration = duration;
    if (known.record !== null) {
      const next: WorstInteraction = {
        name: entry.name,
        durationMs: duration,
        target: describeTarget(entry),
        atMs: Date.now(),
      };
      const at = recentEntries.indexOf(known.record);
      if (at >= 0) recentEntries[at] = next;
      if (worst === known.record) worst = next;
      known.record = next;
    }
    return true;
  }
  if (seen.size >= MAX_TRACKED_IDS) {
    const oldest = seen.keys().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  const bucket = interactionBucket(duration);
  if (bucket < 0) {
    seen.set(id, { duration, bucket: -1, record: null });
    return false;
  }
  addInteraction(histogram, duration);
  slow += 1;
  const record: WorstInteraction = {
    name: entry.name,
    durationMs: duration,
    target: describeTarget(entry),
    atMs: Date.now(),
  };
  if (recentEntries.length >= MAX_RECENT) recentEntries.shift();
  recentEntries.push(record);
  if (worst === null || duration > worst.durationMs) worst = record;
  seen.set(id, { duration, bucket, record });
  return true;
}

/**
 * Start observing slow events. Idempotent, and a no-op where there is no
 * PerformanceObserver (server render, unit tests). Stays unsupported where
 * the engine does not list the event entry type, or where observe throws.
 */
export function startEventTiming(): void {
  if (started) return;
  started = true;
  const factory = readObserverFactory();
  if (factory === null) return;
  if (!eventTypeSupported(factory)) return;
  try {
    const observer = new factory((list) => {
      recordEventEntries(list.getEntries());
    });
    observer.observe({ type: 'event', durationThreshold: SLOW_INTERACTION_MS, buffered: true });
    activeObserver = observer;
  } catch {
    activeObserver = null;
    return;
  }
  supported = true;
  rebuildSnapshot();
  emit();
}

/** The entry point for the observer callback, and for unit tests. */
export function recordEventEntries(entries: readonly EventTimingLike[]): void {
  let changed = false;
  for (const entry of entries) {
    if (processEntry(entry)) changed = true;
  }
  // Fast interactions never reach the callback, yet they move the total the
  // percentile divides by, so refresh it on every callback.
  const nextTotal = readInteractionTotal(slow);
  if (nextTotal !== total) {
    total = nextTotal;
    changed = true;
  }
  if (!changed) return;
  rebuildSnapshot();
  emit();
}

/** The shared snapshot: the same reference until something changed. */
export function getEventTimingSnapshot(): InteractionSnapshot {
  return snapshot;
}

export function subscribeEventTiming(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Refresh the total without waiting for the next slow event. The panel calls
 * this when it opens, so a freshly mounted view divides by a fresh total.
 */
export function refreshTotal(): void {
  const nextTotal = readInteractionTotal(slow);
  if (nextTotal === total) return;
  total = nextTotal;
  rebuildSnapshot();
  emit();
}

export function useInteractionTiming(): InteractionSnapshot {
  return useSyncExternalStore(subscribeEventTiming, getEventTimingSnapshot, getEventTimingSnapshot);
}

/** Test-only: drop the observer and start from a blank store. */
export function resetEventTimingForTests(): void {
  if (activeObserver?.disconnect) {
    try {
      activeObserver.disconnect();
    } catch {
      // A test double with a throwing disconnect still resets the store.
    }
  }
  activeObserver = null;
  started = false;
  supported = false;
  histogram = emptyInteractionHistogram();
  slow = 0;
  total = 0;
  worst = null;
  recentEntries = [];
  seen.clear();
  snapshot = {
    supported: false,
    total: 0,
    slow: 0,
    worst: null,
    recent: [],
    histogram: emptyInteractionHistogram(),
    p95Ms: null,
  };
}
