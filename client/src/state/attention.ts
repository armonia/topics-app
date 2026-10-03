/**
 * THE ATTENTION STATE, AS THE CLIENT HOLDS IT (notifications-redesign, design
 * section 2.3).
 *
 * The server composes one state per subject (`topic:<id>`, `terminal:<id>`,
 * `task:<id>`) and sends it in two frames: `attention:init`, the whole picture
 * at every open of the socket, which REPLACES this store (a seen lost while the
 * laptop slept is not lost for good, ATTN-07), and `attention:updated`, one
 * subject that changed. Nothing else writes here, and every surface reads from
 * here through the same two functions: `attentionOf` for one subject and
 * `rollupAttention` for a set of them. A tab, a row, a project, a group card,
 * the board tab, the inbox, the Dock and the PWA badge cannot disagree,
 * because none of them adds a fact of its own.
 *
 * ONE LOCAL INPUT: the seen this window has just sent. It is applied at once
 * (the fill goes out under the eyes of the person who looked, not one round
 * trip later) and the server's frame confirms or corrects it. It covers only
 * the epoch and the turn it was sent for: a newer epoch arriving meanwhile
 * stays lit (ATTN-06, "the epoch protects the new").
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { AttentionSeenItem, AttentionSnapshot, AttentionTask, AttentionReason } from '../../../shared/attention';
import { topicSubject, terminalSubject } from '../../../shared/attention';
import { apiFetch } from '../lib/shell/net';
import type { AttentionTier } from '../types';

export { topicSubject, terminalSubject };

export type { AttentionTier };

/** Every tier a surface can draw: the lit ones, plus the two that only show work. */
export type AttentionLevel = AttentionTier | 'background' | 'working';

/** What a surface reads about one subject. */
export interface SubjectAttention {
  subject: string;
  /** The tier to draw, or null for idle (or finished and already seen). */
  tier: AttentionLevel | null;
  /** `needs-you`, or `finished` with its epoch not seen. */
  lit: boolean;
  /** The number on the tab and the row: `max(1, unread)` while lit, else 0. */
  count: number;
  /** When the subject entered its state, in ms (0 when unknown). */
  since: number;
  reason: AttentionReason | null;
  /** One line: the question, the tool, the reason of the park, the error. */
  detail: string | null;
  /** Every task in flight, recurring crons included (the line and the Stop show them). */
  background: readonly AttentionTask[];
  epoch: number;
  seenEpoch: number;
  lastTurnAt: string | null;
  turnUnseen: boolean;
  unread: number;
}

/** The rows by subject, as the store keeps them. */
export type AttentionRows = ReadonlyMap<string, AttentionSnapshot>;

const NO_TASKS: readonly AttentionTask[] = [];

function idle(subject: string): SubjectAttention {
  return {
    subject, tier: null, lit: false, count: 0, since: 0, reason: null, detail: null,
    background: NO_TASKS, epoch: 0, seenEpoch: 0, lastTurnAt: null, turnUnseen: false, unread: 0,
  };
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** The tier of a row: the lit ones from `lit`, the quiet ones from the state. */
function tierOfRow(row: AttentionSnapshot): AttentionLevel | null {
  if (row.state === 'needs-you') return 'needs-you';
  if (row.state === 'finished') return row.lit ? (row.outcome === 'error' ? 'error' : 'done') : null;
  if (row.state === 'background') return 'background';
  if (row.state === 'working') return 'working';
  return null;
}

/** One subject, read from its row (or from nothing: idle). */
export function attentionOfRow(row: AttentionSnapshot | undefined, subject = row?.subject ?? ''): SubjectAttention {
  if (!row) return idle(subject);
  const tier = tierOfRow(row);
  const lit = row.lit && (tier === 'needs-you' || tier === 'done' || tier === 'error');
  return {
    subject,
    tier,
    lit,
    count: lit ? Math.max(1, row.unread || 0) : 0,
    since: ms(row.since),
    reason: row.reason,
    detail: row.detail,
    background: row.background.length ? row.background : NO_TASKS,
    epoch: row.epoch,
    seenEpoch: row.seenEpoch,
    lastTurnAt: row.lastTurnAt,
    turnUnseen: row.turnUnseen,
    unread: row.unread || 0,
  };
}

/** `attentionOf(subject)` of design section 2.3, over a set of rows. */
export function attentionOf(rows: AttentionRows, subject: string): SubjectAttention {
  return attentionOfRow(rows.get(subject), subject);
}

/** The lit tier of a subject, or null: the fill of a tab or a row. */
export function litTierOf(rows: AttentionRows, subject: string): AttentionTier | null {
  const a = attentionOf(rows, subject);
  return a.lit ? (a.tier as AttentionTier) : null;
}

const TIER_RANK: Record<AttentionTier, number> = { 'needs-you': 3, error: 2, done: 1 };

/**
 * A set of subjects as one: the loudest lit child (`needs-you` over `error`
 * over `done`) and how many children are lit. The project row and tab, the
 * group card and the board tab read this, never a sum of their own.
 */
export function rollupAttention(views: Iterable<SubjectAttention>): { tier: AttentionTier | null; count: number } {
  let tier: AttentionTier | null = null;
  let count = 0;
  for (const v of views) {
    if (!v.lit) continue;
    count += 1;
    const t = v.tier as AttentionTier;
    if (!tier || TIER_RANK[t] > TIER_RANK[tier]) tier = t;
  }
  return { tier, count };
}

// ─── The store ────────────────────────────────────────────────────────────────

interface LocalSeen {
  epoch: number;
  turnAt: string | null;
}

interface AttentionStoreState {
  rows: AttentionRows;
  /** An `attention:init` has arrived on this page. */
  ready: boolean;
}

export const useAttentionStore = create<AttentionStoreState>(() => ({
  rows: new Map(),
  ready: false,
}));

/** The seens this window sent and the server has not confirmed yet. */
const localSeen = new Map<string, LocalSeen>();

/** The row as this window shows it: the server's, with this window's pending seen on top. */
function withLocalSeen(row: AttentionSnapshot): AttentionSnapshot {
  const mine = localSeen.get(row.subject);
  if (!mine) return row;
  const turnCovered = (row.lastTurnAt ?? '') <= (mine.turnAt ?? '');
  if (row.epoch > mine.epoch || !turnCovered) {
    // Something newer than what was seen: the server's row stands as it is.
    localSeen.delete(row.subject);
    return row;
  }
  if (row.seenEpoch >= row.epoch && !row.turnUnseen) {
    // Confirmed.
    localSeen.delete(row.subject);
    return row;
  }
  return {
    ...row,
    seenEpoch: Math.max(row.seenEpoch, row.epoch),
    turnUnseen: false,
    unread: 0,
    lit: row.state === 'needs-you',
  };
}

function sameTasks(a: readonly AttentionTask[], b: readonly AttentionTask[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.kind === b[i].kind && t.label === b[i].label
    && t.startedAt === b[i].startedAt && !!t.recurring === !!b[i].recurring);
}

function sameRow(a: AttentionSnapshot, b: AttentionSnapshot): boolean {
  return a.state === b.state && a.reason === b.reason && a.outcome === b.outcome && a.detail === b.detail
    && a.since === b.since && a.epoch === b.epoch && a.seenEpoch === b.seenEpoch && a.lit === b.lit
    && a.unread === b.unread && a.turnUnseen === b.turnUnseen && a.lastTurnAt === b.lastTurnAt
    && sameTasks(a.background, b.background);
}

/** A row with nothing to show is the same as no row: the map holds only what a surface can draw. */
function isQuiet(row: AttentionSnapshot): boolean {
  return row.state === 'idle' && !row.lit && row.background.length === 0 && !row.unread && !row.turnUnseen;
}

function asSnapshot(raw: unknown): AttentionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AttentionSnapshot>;
  if (typeof r.subject !== 'string' || typeof r.state !== 'string') return null;
  return {
    subject: r.subject,
    state: r.state,
    reason: r.reason ?? null,
    outcome: r.outcome ?? null,
    detail: r.detail ?? null,
    since: typeof r.since === 'string' ? r.since : '',
    epoch: typeof r.epoch === 'number' ? r.epoch : 0,
    seenEpoch: typeof r.seenEpoch === 'number' ? r.seenEpoch : 0,
    lit: !!r.lit,
    unread: typeof r.unread === 'number' ? r.unread : 0,
    turnUnseen: !!r.turnUnseen,
    lastTurnAt: r.lastTurnAt ?? null,
    background: Array.isArray(r.background) ? r.background : [],
  };
}

/** Every row of an `attention:init`, keeping the identity of each one that did not change. */
function replaceRows(prev: AttentionRows, incoming: AttentionSnapshot[]): AttentionRows {
  const next = new Map<string, AttentionSnapshot>();
  for (const raw of incoming) {
    const row = withLocalSeen(raw);
    if (isQuiet(row)) continue;
    const old = prev.get(row.subject);
    next.set(row.subject, old && sameRow(old, row) ? old : row);
  }
  return next;
}

export const attentionActions = {
  /** `attention:init`: the store becomes exactly this. */
  applyInit(rows: unknown[]): void {
    const parsed = rows.map(asSnapshot).filter((r): r is AttentionSnapshot => r !== null);
    useAttentionStore.setState((s) => ({ rows: replaceRows(s.rows, parsed), ready: true }));
  },
  /** `attention:updated`: one subject. */
  applyUpdated(raw: unknown): void {
    const parsed = asSnapshot(raw);
    if (!parsed) return;
    const row = withLocalSeen(parsed);
    useAttentionStore.setState((s) => {
      const old = s.rows.get(row.subject);
      if (isQuiet(row)) {
        if (!old) return s;
        const next = new Map(s.rows);
        next.delete(row.subject);
        return { rows: next };
      }
      if (old && sameRow(old, row)) return s;
      const next = new Map(s.rows);
      next.set(row.subject, row);
      return { rows: next };
    });
  },
  /** Either frame, from the socket. Returns whether it was one of them. */
  applyFrame(raw: object): boolean {
    const msg = raw as { type?: unknown; rows?: unknown; row?: unknown };
    if (msg.type === 'attention:init') {
      attentionActions.applyInit(Array.isArray(msg.rows) ? msg.rows : []);
      return true;
    }
    if (msg.type === 'attention:updated') {
      attentionActions.applyUpdated(msg.row);
      return true;
    }
    return false;
  },
  /**
   * This window saw the subject: applied now, confirmed by the server's frame.
   * Returns the seen item to send, or null when there is nothing to see.
   */
  seeLocally(subject: string): AttentionSeenItem | null {
    const row = useAttentionStore.getState().rows.get(subject);
    if (!row) return null;
    const item: AttentionSeenItem = { subject, epoch: row.epoch, turnAt: row.lastTurnAt };
    localSeen.set(subject, { epoch: row.epoch, turnAt: row.lastTurnAt });
    attentionActions.applyUpdated(row);
    return item;
  },
  /** Tests only: an empty store. */
  reset(): void {
    localSeen.clear();
    useAttentionStore.setState({ rows: new Map(), ready: false });
  },
};

/**
 * Does the person looking at this subject have something to tell the server?
 * A lit epoch not yet seen, unread messages, or a closed turn not yet seen
 * (a chat in `background` whose turn the person read: T7 must know). A
 * `needs-you` already seen stays lit and asks for nothing more.
 */
export function needsSeen(a: SubjectAttention): boolean {
  return (a.lit && a.seenEpoch < a.epoch) || a.unread > 0 || a.turnUnseen;
}

/**
 * THE SEEN DOOR (`POST /api/attention/seen`), with the epochs and the turns
 * this window was showing: a newer one stays lit. Applied here first.
 * Fire-and-forget: the frame that answers is what every window reads.
 */
export function sendAttentionSeen(subjects: readonly string[]): void {
  const items: AttentionSeenItem[] = [];
  for (const subject of subjects) {
    const item = attentionActions.seeLocally(subject);
    if (item) items.push(item);
  }
  postSeen(items);
}

/** The same door with the epochs a list showed (the inbox's «Mark all seen»). */
export function sendAttentionSeenItems(items: readonly AttentionSeenItem[]): void {
  const shown = new Map(items.map((i) => [i.subject, i]));
  for (const [subject, item] of shown) {
    const row = useAttentionStore.getState().rows.get(subject);
    if (row && row.epoch === item.epoch) attentionActions.seeLocally(subject);
  }
  postSeen([...shown.values()]);
}

function postSeen(items: readonly AttentionSeenItem[]): void {
  if (items.length === 0) return;
  try {
    void apiFetch('/api/attention/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* the seen is a gesture: a failed door must not break the click */ }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Every row: for the surfaces that walk many subjects (the tab bar, the sidebar, the rollups). */
export function useAttentionRows(): AttentionRows {
  return useAttentionStore((s) => s.rows);
}

/** One subject. Re-renders only when that subject's row changes. */
export function useSubjectAttention(subject: string | null | undefined): SubjectAttention {
  const row = useAttentionStore((s) => (subject ? s.rows.get(subject) : undefined));
  return useMemo(() => attentionOfRow(row, subject ?? ''), [row, subject]);
}

/** A chat's attention, by topic id. */
export function useTopicAttention(topicId: string | null | undefined): SubjectAttention {
  return useSubjectAttention(topicId ? topicSubject(topicId) : null);
}

/** A terminal's attention, by session id. */
export function useTerminalAttention(sessionId: string | null | undefined): SubjectAttention {
  return useSubjectAttention(sessionId ? terminalSubject(sessionId) : null);
}
