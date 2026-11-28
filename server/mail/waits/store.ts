/**
 * THE WAITS FOR A MAIL (rules P3, P4, P5): one row, one wake, once.
 *
 * `createWait` writes the row and, in the same transaction, looks among the
 * messages already received. `matchWaits` is called by the receiving round
 * inside ITS transaction (`commitRound`'s `onStored`), so a message and the
 * waits it completes are written together or not at all. Every transition is a
 * conditional update (`WHERE status = 'open'`): two connections racing for one
 * wait make one winner. The wake is written by the same statement that
 * completes the wait and is delivered later with the wait id as its key.
 */
import type { Database } from "bun:sqlite";
import type { Mailbox } from "../inbox/mailboxes";
import type { StoredMessage } from "../inbox/store";
import { wakeText } from "./wake-text";

export const MAX_WAIT_DAYS = 30;
/** How far before the wait a message still counts, by default. */
export const DEFAULT_LOOKBACK_MS = 10 * 60_000;

export type WaitOwnerKind = "card" | "chat";
export type WaitStatus = "open" | "matched" | "expired" | "cancelled";
export type WakeState = "none" | "pending" | "delivered" | "dropped";

export interface MailWait {
  id: string;
  ownerKind: WaitOwnerKind;
  ownerId: string;
  mailbox: string;
  fromMatch: string;
  subjectContains: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  since: string;
  expiresAt: string;
  status: WaitStatus;
  matchedMessageId: number | null;
  rejectNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  wakeState: WakeState;
  wakeText: string | null;
}

interface WaitRow {
  id: string; owner_kind: WaitOwnerKind; owner_id: string; mailbox: string; from_match: string;
  subject_contains: string | null; thread_id: string | null; in_reply_to: string | null; since: string; expires_at: string;
  status: WaitStatus; matched_message_id: number | null; reject_note: string | null; created_at: string; resolved_at: string | null;
  wake_state: WakeState; wake_text: string | null;
}

const toWait = (r: WaitRow): MailWait => ({
  id: r.id, ownerKind: r.owner_kind, ownerId: r.owner_id, mailbox: r.mailbox, fromMatch: r.from_match,
  subjectContains: r.subject_contains, threadId: r.thread_id, inReplyTo: r.in_reply_to, since: r.since, expiresAt: r.expires_at,
  status: r.status, matchedMessageId: r.matched_message_id, rejectNote: r.reject_note, createdAt: r.created_at, resolvedAt: r.resolved_at,
  wakeState: r.wake_state, wakeText: r.wake_text,
});

export function getWait(db: Database, id: string): MailWait | null {
  const row = db.query("SELECT * FROM mail_waits WHERE id = ?").get(id) as WaitRow | null;
  return row ? toWait(row) : null;
}

export function listOpenWaits(db: Database): MailWait[] {
  return (db.query("SELECT * FROM mail_waits WHERE status = 'open' ORDER BY created_at, id").all() as WaitRow[]).map(toWait);
}

// ---- the criterion -------------------------------------------------------------------------------------------

/** The address inside `Name <addr@host>`, lowercased. */
export function addressOf(from: string): string {
  const angle = /<([^<>]+)>/.exec(from);
  return (angle ? angle[1]! : from).trim().toLowerCase();
}

/** Does the sender fit the criterion: a whole address, or a domain (with or without the leading `@`)? */
export function senderFits(criterion: string, from: string): boolean {
  const want = criterion.trim().toLowerCase();
  const got = addressOf(from);
  if (want.includes("@") && !want.startsWith("@")) return got === want;
  const domain = want.replace(/^@/, "");
  return !!domain && got.endsWith(`@${domain}`);
}

/**
 * Is the sender vouched for by the mailbox's own provider? The `Authentication-Results` line counts only when its
 * `authserv-id` is the one the mailbox trusts, and only with `dmarc=pass`: a line another server wrote proves nothing.
 */
export function senderVerified(authResults: string | null, trustedAuthserv: string): { ok: boolean; why: string } {
  if (!trustedAuthserv) return { ok: false, why: "the mailbox names no trusted authserv-id" };
  if (!authResults) return { ok: false, why: "the message carries no Authentication-Results" };
  const parts = authResults.split(";").map((p) => p.trim());
  const served = (parts[0] ?? "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (served !== trustedAuthserv.trim().toLowerCase()) return { ok: false, why: "the Authentication-Results line is not from the trusted authserv-id" };
  if (!parts.slice(1).some((p) => /^dmarc=pass(\s|$)/i.test(p))) return { ok: false, why: "dmarc did not pass" };
  return { ok: true, why: "" };
}

type Candidate = Pick<StoredMessage, "from" | "subject" | "threadId" | "messageId" | "inReplyTo" | "authResults" | "receivedAt">;

/** The criterion alone, with no verification: the verdict a reader of the table can reproduce. */
export function criterionFits(wait: Pick<MailWait, "fromMatch" | "subjectContains" | "threadId" | "inReplyTo" | "since">, message: Candidate): boolean {
  if (!senderFits(wait.fromMatch, message.from)) return false;
  if (Date.parse(message.receivedAt) < Date.parse(wait.since)) return false;
  if (wait.subjectContains && !message.subject.toLowerCase().includes(wait.subjectContains.toLowerCase())) return false;
  if (wait.threadId && message.threadId !== wait.threadId) return false;
  if (wait.inReplyTo && message.inReplyTo !== wait.inReplyTo) return false;
  return true;
}

/**
 * THE ONE STATEMENT THAT COMPLETES A WAIT, with its wake. Conditional on `status = 'open'`: of two connections that read
 * the wait open, one gets `true` and the other `false`, so one wake exists whoever races.
 */
export function completeWait(db: Database, id: string, messageRowId: number, at: string, wake: string): boolean {
  return db.prepare(
    "UPDATE mail_waits SET status = 'matched', matched_message_id = ?, resolved_at = ?, wake_state = 'pending', wake_text = ?, reject_note = NULL WHERE id = ? AND status = 'open'",
  ).run(messageRowId, at, wake, id).changes === 1;
}

// ---- matching ------------------------------------------------------------------------------------------------

interface Stored extends Candidate { rowId: number; mailbox: string; id: string; own: boolean }

/** Completes, for ONE message, the oldest open wait of each owner that it satisfies. Runs inside the caller's transaction. */
function matchMessage(db: Database, box: Mailbox, message: Stored, now: Date): number {
  if (message.own) return 0;
  const at = now.toISOString();
  const open = db.query("SELECT * FROM mail_waits WHERE status = 'open' AND mailbox = ? AND expires_at > ? ORDER BY created_at, id").all(box.name, at) as WaitRow[];
  let completed = 0;
  const served = new Set<string>();
  for (const row of open) {
    const wait = toWait(row);
    const owner = `${wait.ownerKind}:${wait.ownerId}`;
    // A message handed to an owner completes no second wait of that owner: the oldest one took it.
    if (served.has(owner)) continue;
    const already = db.query("SELECT 1 FROM mail_waits WHERE owner_kind = ? AND owner_id = ? AND matched_message_id = ? LIMIT 1").get(wait.ownerKind, wait.ownerId, message.rowId);
    if (already) continue;
    if (!criterionFits(wait, message)) continue;
    const verdict = senderVerified(message.authResults, box.trustedAuthserv);
    if (!verdict.ok) {
      db.prepare("UPDATE mail_waits SET reject_note = ? WHERE id = ? AND status = 'open'")
        .run(`a message from the sender was not matched: ${verdict.why}`.slice(0, 300), wait.id);
      continue;
    }
    const text = wakeText({ kind: "match", waitId: wait.id, mailbox: box.name, from: message.from, subject: message.subject, receivedAt: message.receivedAt, messageId: message.id });
    if (completeWait(db, wait.id, message.rowId, at, text)) { completed++; served.add(owner); }
  }
  return completed;
}

/** The hook of the receiving round: the new rows of one round meet the open waits, in the round's transaction. */
export function matchWaits(db: Database, box: Mailbox, fresh: StoredMessage[], now: Date): number {
  let completed = 0;
  for (const message of [...fresh].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))) completed += matchMessage(db, box, message, now);
  return completed;
}

// ---- creating ------------------------------------------------------------------------------------------------

export interface NewWait {
  id: string;
  ownerKind: WaitOwnerKind;
  ownerId: string;
  mailbox: string;
  from: string;
  subjectContains?: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  /** When the wait starts counting messages; default ten minutes before now. */
  since?: string | null;
  expiresAt: string;
}

export class WaitRefused extends Error {}

/** Checks the request against the rules of P3; throws `WaitRefused` with the reason. */
export function validateNewWait(input: NewWait, boxes: Mailbox[], now: Date): { box: Mailbox; since: string; expiresAt: string } {
  const from = input.from?.trim() ?? "";
  if (!from) throw new WaitRefused("a wait needs the sender (an address or a domain)");
  if (!/^@?[^\s@]+(\.[^\s@]+)+$/.test(from) && !/^[^\s@]+@[^\s@]+$/.test(from)) throw new WaitRefused(`the sender "${from.slice(0, 80)}" is neither an address nor a domain`);
  if (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) throw new WaitRefused("a wait needs a deadline");
  const expires = new Date(input.expiresAt);
  if (expires.getTime() <= now.getTime()) throw new WaitRefused("the deadline is already past");
  if (expires.getTime() - now.getTime() > MAX_WAIT_DAYS * 86_400_000) throw new WaitRefused(`the deadline is more than ${MAX_WAIT_DAYS} days away`);
  const box = boxes.find((b) => b.name === input.mailbox);
  if (!box) throw new WaitRefused(`the mailbox "${input.mailbox.slice(0, 80)}" is not declared`);
  if (!box.agentsMayWait) throw new WaitRefused(`the mailbox "${box.name}" does not let agents wait for mail`);
  let since = new Date(now.getTime() - DEFAULT_LOOKBACK_MS).toISOString();
  if (input.since) {
    if (Number.isNaN(Date.parse(input.since))) throw new WaitRefused("'since' is not a date");
    since = new Date(input.since).toISOString();
  }
  return { box, since, expiresAt: expires.toISOString() };
}

export interface CreatedWait { wait: MailWait; matched: boolean }

/**
 * Writes the wait and looks among the messages already received, in ONE transaction. When one is there the wait is
 * answered on the spot (`wake_state` stays `none`: the caller reads the outcome from the return, no wake follows).
 */
export function createWait(db: Database, input: NewWait, boxes: Mailbox[], now: Date): CreatedWait {
  const { box, since, expiresAt } = validateNewWait(input, boxes, now);
  const at = now.toISOString();
  const write = db.transaction((): CreatedWait => {
    db.prepare(
      `INSERT INTO mail_waits (id, owner_kind, owner_id, mailbox, from_match, subject_contains, thread_id, in_reply_to, since, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.ownerKind, input.ownerId, box.name, input.from.trim().toLowerCase(), input.subjectContains?.trim() || null, input.threadId || null, input.inReplyTo || null, since, expiresAt, at);
    const wait = getWait(db, input.id)!;
    const rows = db.query("SELECT * FROM mail_messages WHERE mailbox = ? AND own = 0 AND received_at >= ? ORDER BY received_at, id").all(box.name, since) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const message: Stored = {
        rowId: Number(r.id), mailbox: box.name, id: String(r.provider_id), threadId: (r.thread_id as string | null) ?? null, messageId: (r.message_id as string | null) ?? null,
        inReplyTo: (r.in_reply_to as string | null) ?? null, from: String(r.from_addr), subject: String(r.subject ?? ""), authResults: (r.auth_results as string | null) ?? null,
        receivedAt: String(r.received_at), own: false,
      };
      if (!criterionFits(wait, message)) continue;
      // Handed to this owner by another of its waits already: one message, one wake per owner.
      if (db.query("SELECT 1 FROM mail_waits WHERE owner_kind = ? AND owner_id = ? AND matched_message_id = ? LIMIT 1").get(wait.ownerKind, wait.ownerId, message.rowId)) continue;
      const verdict = senderVerified(message.authResults, box.trustedAuthserv);
      if (!verdict.ok) {
        db.prepare("UPDATE mail_waits SET reject_note = ? WHERE id = ? AND status = 'open'").run(`a message from the sender was not matched: ${verdict.why}`.slice(0, 300), wait.id);
        continue;
      }
      const res = db.prepare("UPDATE mail_waits SET status = 'matched', matched_message_id = ?, resolved_at = ?, reject_note = NULL WHERE id = ? AND status = 'open'").run(message.rowId, at, wait.id);
      if (res.changes === 1) break;
    }
    const after = getWait(db, input.id)!;
    return { wait: after, matched: after.status === "matched" };
  });
  return write.immediate();
}

// ---- ending --------------------------------------------------------------------------------------------------

/** Every open wait past its deadline becomes `expired` with a pending wake. Runs even when reading is stopped. */
export function expireDue(db: Database, now: Date): MailWait[] {
  const at = now.toISOString();
  const due = db.query("SELECT * FROM mail_waits WHERE status = 'open' AND expires_at <= ?").all(at) as WaitRow[];
  const done: MailWait[] = [];
  for (const row of due) {
    const wait = toWait(row);
    const text = wakeText({ kind: "expired", waitId: wait.id, mailbox: wait.mailbox, from: wait.fromMatch, subject: wait.subjectContains ?? "", receivedAt: wait.expiresAt, messageId: "" });
    const res = db.prepare("UPDATE mail_waits SET status = 'expired', resolved_at = ?, wake_state = 'pending', wake_text = ? WHERE id = ? AND status = 'open'").run(at, text, wait.id);
    if (res.changes === 1) done.push(getWait(db, wait.id)!);
  }
  return done;
}

/** Withdraws an open wait. False when it was not open any more (already completed: the wake owns it). */
export function cancelWait(db: Database, id: string, now: Date, note = "cancelled"): boolean {
  return db.prepare("UPDATE mail_waits SET status = 'cancelled', resolved_at = ?, reject_note = ? WHERE id = ? AND status = 'open'").run(now.toISOString(), note.slice(0, 300), id).changes === 1;
}

export function pendingWakes(db: Database): MailWait[] {
  return (db.query("SELECT * FROM mail_waits WHERE wake_state = 'pending' ORDER BY resolved_at, id").all() as WaitRow[]).map(toWait);
}

export function markWake(db: Database, id: string, state: "delivered" | "dropped"): boolean {
  return db.prepare("UPDATE mail_waits SET wake_state = ? WHERE id = ? AND wake_state = 'pending'").run(state, id).changes === 1;
}

/** When the first open wait of the mailbox expires: the receiving round reads faster near it. */
export function nextExpiry(db: Database, mailbox: string): Date | null {
  const row = db.query("SELECT MIN(expires_at) AS at FROM mail_waits WHERE status = 'open' AND mailbox = ?").get(mailbox) as { at: string | null } | null;
  return row?.at ? new Date(row.at) : null;
}

export function countOpen(db: Database, mailbox: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM mail_waits WHERE status = 'open' AND mailbox = ?").get(mailbox) as { n: number }).n;
}
