/**
 * WHO THE DISPATCHER KEEPS IN TODO, for the board's «Frenato» chip (HUBBR-20).
 *
 * Read from `GET /api/dispatch/brakes`, which applies the dispatcher's rule on
 * the server: Claude's hold or its five-hour window past the dispatch line,
 * and Codex's hold, which the socket does not announce. So the store reads
 * again on the frames that move Claude's side (`provider:hold`,
 * `provider:usage`), every minute for Codex's, and when the first brake is due
 * to end. It reads only while something on screen asks (a board, the
 * sidebar's Board row): the last subscriber that leaves stops the timers.
 *
 * Besides the walls it keeps the dispatcher's verdict card by card: which Todo
 * cards a wall holds, and how many cards each runtime has at work. A wall that
 * holds no card is not a brake (the cards on Automatic start elsewhere), so the
 * chip names only the providers with a held card.
 */
import { useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';
import { subscribeFrames } from '../lib/wsFrameBus';
import type { DispatchBrake, DispatchWork } from '../../../shared/provider-hold';

const POLL_MS = 60_000;
/** A card that moves is a burst of frames: one read after it settles. */
const CARD_SETTLE_MS = 1_500;

export interface DispatchBrakeState {
  /** Every wall in force, holding cards or not. */
  brakes: readonly DispatchBrake[];
  /** The Todo cards a wall keeps waiting, by task id. */
  held: ReadonlyMap<string, DispatchBrake['provider']>;
  /** Cards at work per runtime: `claude`, `codex`, `muse`. */
  working: Readonly<Record<string, number>>;
  /** Claude's five-hour share, for the row of a Claude that is free. */
  claudeFiveHour: number | null;
}

const EMPTY: DispatchBrakeState = { brakes: [], held: new Map(), working: {}, claudeFiveHour: null };

let current: DispatchBrakeState = EMPTY;
let wire = '';
const listeners = new Set<() => void>();
let poll: ReturnType<typeof setInterval> | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
let dropFrames: (() => void) | null = null;
let dropCardFrames: (() => void) | null = null;
let settle: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function announce(): void {
  for (const cb of listeners) cb();
}

function isBrake(raw: unknown): raw is DispatchBrake {
  const b = raw as Partial<DispatchBrake> | null;
  return !!b && (b.provider === 'claude' || b.provider === 'codex') && typeof b.window === 'string'
    && (b.utilization === null || typeof b.utilization === 'number')
    && (b.untilMs === null || typeof b.untilMs === 'number');
}

/** The brakes still in force at `nowMs`: one past its end is dropped without asking the server. */
export function liveBrakes(brakes: readonly DispatchBrake[], nowMs: number): readonly DispatchBrake[] {
  const live = brakes.filter((b) => b.untilMs === null || b.untilMs > nowMs);
  return live.length === brakes.length ? brakes : live;
}

function isHeld(raw: unknown): raw is DispatchWork['held'][number] {
  const h = raw as Partial<DispatchWork['held'][number]> | null;
  return !!h && typeof h.taskId === 'string' && (h.provider === 'claude' || h.provider === 'codex');
}

/** The server's answer as the store keeps it; a held card of a wall past its end is dropped with it. */
export function readBrakeAnswer(body: unknown, nowMs: number): DispatchBrakeState {
  const b = (body ?? {}) as { brakes?: unknown; held?: unknown; working?: unknown; claudeFiveHour?: unknown };
  const brakes = liveBrakes(Array.isArray(b.brakes) ? b.brakes.filter(isBrake) : [], nowMs);
  const walls = new Set(brakes.map((x) => x.provider));
  const held = new Map<string, DispatchBrake['provider']>();
  for (const h of Array.isArray(b.held) ? b.held.filter(isHeld) : []) if (walls.has(h.provider)) held.set(h.taskId, h.provider);
  const working: Record<string, number> = {};
  if (b.working && typeof b.working === 'object') {
    for (const [k, v] of Object.entries(b.working as Record<string, unknown>)) if (typeof v === 'number' && v > 0) working[k] = v;
  }
  const five = typeof b.claudeFiveHour === 'number' && Number.isFinite(b.claudeFiveHour) ? b.claudeFiveHour : null;
  return { brakes, held, working, claudeFiveHour: five };
}

let lastBody: unknown = null;

function adopt(body: unknown): void {
  lastBody = body;
  const next = readBrakeAnswer(body, Date.now());
  const key = JSON.stringify([next.brakes, [...next.held], next.working, next.claudeFiveHour]);
  if (key === wire) return;
  wire = key;
  current = next;
  armExpiry();
  announce();
}

/** The end of a brake is an event the server sends no frame for: a timer reads again then. */
function armExpiry(): void {
  if (expiry !== null) { clearTimeout(expiry); expiry = null; }
  const ends = current.brakes.map((b) => b.untilMs).filter((t): t is number => t !== null);
  if (ends.length === 0 || listeners.size === 0) return;
  expiry = setTimeout(() => { expiry = null; adopt(lastBody); void read(); }, Math.max(0, Math.min(...ends) - Date.now()) + 1_000);
}

async function read(): Promise<void> {
  const mine = ++seq;
  try {
    const res = await apiFetch('/api/dispatch/brakes');
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (mine !== seq) return;
    adopt(body);
  } catch {
    // A failed read keeps the last answer: the timer still drops a brake past its end.
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    void read();
    poll = setInterval(() => { void read(); }, POLL_MS);
    dropFrames = subscribeFrames(() => { void read(); }, { types: ['provider:hold', 'provider:usage'] });
    // A card entering or leaving Todo changes who is held, and the server sends no brake frame for it.
    dropCardFrames = subscribeFrames(() => {
      if (settle !== null) return;
      settle = setTimeout(() => { settle = null; void read(); }, CARD_SETTLE_MS);
    }, { types: ['task:created', 'task:updated', 'task:deleted'] });
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size > 0) return;
    if (poll !== null) { clearInterval(poll); poll = null; }
    if (expiry !== null) { clearTimeout(expiry); expiry = null; }
    if (settle !== null) { clearTimeout(settle); settle = null; }
    dropFrames?.();
    dropCardFrames?.();
    dropFrames = null;
    dropCardFrames = null;
  };
}

/** The walls and the cards behind them, right now. */
export function useDispatchBrakes(): DispatchBrakeState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
