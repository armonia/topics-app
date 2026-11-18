/**
 * THE «WAITING FOR YOU» INBOX, OWNED BY TOPICS (card 10508340).
 *
 * Decisions, spends, public things and sign-offs only a person can give used
 * to live in the usage hub's own registry, next to Topics' attention store:
 * two inboxes for the one question «what is waiting for the person». Topics
 * now keeps the items itself. The hub stays a bridge until its callers move:
 * every read of the hub's list is ingested here (`ingestHubItems`), and the
 * list the bell shows is this store's, so an item opened through either door
 * appears ONCE and closes from Topics.
 *
 * Same rules as the hub's registry, so callers see no change:
 *   - the identity of an item is its `key`, or `from` + title when there is none
 *     (a second open of the same identity rewrites the first, never a second row);
 *   - an item waits since its FIRST open;
 *   - a close may carry `until`: the item is only snoozed and comes back after it;
 *   - ordered by `due` (nearest first), then by age.
 *
 * Closing a bridged item also has to reach the hub, or its next list would
 * bring the item back: the store remembers the hub ids of each item
 * (`hubIds`) and keeps a tombstone for a closed one, so a re-read is ignored.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { WAITING_KINDS, type WaitingKind } from "../../shared/waiting-kind";
export { WAITING_KINDS };
export type { WaitingKind };

export interface WaitingEntry {
  id: string;
  tipo: WaitingKind; // allow-italian: wire field of the hub
  title: string;
  why: string;
  link: string | null;
  from: string;
  /** Since when it waits (ms). */
  at: number;
  /** By when it is the person's turn (ms). */
  due?: number;
  key?: string;
  taskId?: string;
}

export interface WaitingOpenInput {
  tipo?: unknown; // allow-italian: wire field of the hub
  title?: unknown;
  why?: unknown;
  link?: unknown;
  from?: unknown;
  due?: unknown;
  key?: unknown;
  taskId?: unknown;
}

interface Row extends WaitingEntry {
  hubIds: string[];
  /** Set once closed: `until` null is forever, a number is a snooze. */
  closed?: { at: number; until: number | null };
}

const WHY_MAX = 1500;
const TITLE_MAX = 200;
const FROM_MAX = 80;

const asMs = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : NaN;
};

/** A reason in words when the input is not an item, else null. */
export function validateWaitingOpen(b: WaitingOpenInput): string | null {
  if (!(WAITING_KINDS as readonly string[]).includes(String(b.tipo))) return `tipo: ${WAITING_KINDS.join(", ")}`;
  if (typeof b.title !== "string" || !b.title.trim()) return "title required";
  if (b.due != null && Number.isNaN(asMs(b.due))) return "due is not a date";
  // claude:// opens a session in the desktop app
  if (b.link && !/^(https?:\/\/|#|claude:\/\/)/.test(String(b.link))) return "link: http(s), #page or claude://";
  return null;
}

const identity = (r: { key?: string; from: string; title: string }): string => (r.key ? `key:${r.key}` : `title:${r.from}|${r.title.slice(0, TITLE_MAX).trim().toLowerCase()}`);

export interface WaitingStore {
  open(input: WaitingOpenInput, opts?: { hubId?: string; at?: number }): WaitingEntry;
  /** Closes (or snoozes with `until`); false when no such item is open. */
  close(id: string, opts?: { until?: unknown; by?: string }): boolean;
  list(): WaitingEntry[];
  /** The hub ids behind an item, to forward its close. */
  hubIdsOf(id: string): string[];
  /** Ingest the hub's current list: new items open, known ones refresh, closed ones stay closed. */
  ingestHubItems(items: unknown[]): boolean;
}

/** `file` null keeps everything in memory (tests, a server with no data dir). */
export function createWaitingStore(opts: { file?: string | null; now?: () => number } = {}): WaitingStore {
  const now = opts.now ?? Date.now;
  const file = opts.file ?? null;
  const rows = new Map<string, Row>();

  const persist = (): void => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([...rows.values()]));
    } catch { /* best-effort: the in-memory inbox keeps working */ }
  };
  if (file) {
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) for (const r of saved as Row[]) if (r?.id && r.title) rows.set(r.id, { ...r, hubIds: r.hubIds ?? [] });
    } catch { /* no file yet, or unreadable: start empty */ }
  }

  const isOpen = (r: Row, t: number): boolean => !r.closed || (r.closed.until !== null && r.closed.until <= t);
  const openRows = (): Row[] => [...rows.values()].filter((r) => isOpen(r, now()));
  const publicItem = ({ hubIds: _h, closed: _c, ...item }: Row): WaitingEntry => item;

  function open(input: WaitingOpenInput, o: { hubId?: string; at?: number } = {}): WaitingEntry {
    const t = now();
    const key = input.key ? String(input.key).slice(0, 80) : undefined;
    const taskId = input.taskId ? String(input.taskId).trim().slice(0, 80) : undefined;
    const draft = { key, from: String(input.from ?? "").slice(0, FROM_MAX), title: String(input.title).slice(0, TITLE_MAX) };
    const id = identity(draft);
    // an identity that is snoozed or closed and now written again: closed for good stays closed only for a bridged re-read (see ingest)
    const same = [...rows.values()].filter((r) => identity(r) === id && isOpen(r, t));
    const since = Math.min(o.at ?? t, ...same.map((r) => r.at));
    const hubIds = [...new Set([...same.flatMap((r) => r.hubIds), ...(o.hubId ? [o.hubId] : [])])];
    for (const r of same) rows.delete(r.id);
    const due = asMs(input.due);
    const row: Row = {
      id: same[0]?.id ?? crypto.randomBytes(4).toString("hex"), tipo: input.tipo as WaitingKind, title: draft.title,
      why: String(input.why ?? "").slice(0, WHY_MAX), link: input.link ? String(input.link) : null, from: draft.from, at: since,
      ...(due != null ? { due } : {}), ...(key ? { key } : {}), ...(taskId ? { taskId } : {}), hubIds,
    };
    rows.set(row.id, row);
    persist();
    return publicItem(row);
  }

  function close(id: string, c: { until?: unknown } = {}): boolean {
    const r = rows.get(id);
    if (!r || !isOpen(r, now())) return false;
    const until = asMs(c.until);
    r.closed = { at: now(), until: until != null && !Number.isNaN(until) ? until : null };
    persist();
    return true;
  }

  function ingestHubItems(items: unknown[]): boolean {
    let changed = false;
    const t = now();
    for (const raw of items) {
      const h = raw as Record<string, unknown> | null;
      if (!h || typeof h.id !== "string" || validateWaitingOpen(h)) continue;
      // closed here (forever or still snoozed) and not yet closed on the hub: leave it closed
      const closedHere = [...rows.values()].some((r) => r.hubIds.includes(h.id as string) && !isOpen(r, t));
      if (closedHere) continue;
      const before = JSON.stringify(openRows().map(publicItem));
      open(h as WaitingOpenInput, { hubId: h.id, at: typeof h.at === "number" ? h.at : undefined });
      if (JSON.stringify(openRows().map(publicItem)) !== before) changed = true;
    }
    // A tombstone has done its job once the hub no longer lists the item: drop it, so a later item with the same id is not hidden.
    const listed = new Set(items.map((i) => (i as { id?: unknown } | null)?.id));
    for (const r of [...rows.values()]) {
      if (r.hubIds.length === 0 || r.hubIds.some((id) => listed.has(id))) continue;
      // Forever-closed: the tombstone is spent. Open or snoozed: the hub closed it on its side, so it no longer waits here either.
      if (!r.closed || r.closed.until === null || isOpen(r, t)) { rows.delete(r.id); changed = true; }
    }
    if (changed) persist();
    return changed;
  }

  return {
    open, close, ingestHubItems,
    list: () => openRows().map(publicItem).sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.at - b.at),
    hubIdsOf: (id) => rows.get(id)?.hubIds ?? [],
  };
}
