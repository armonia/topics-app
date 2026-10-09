/**
 * THE ATTENTION STORE: the only writer of a subject's attention state
 * (openspec change notifications-redesign, design sections 2.2, 4, 6, 7, 10).
 *
 * Every fact the server already has about a chat, a terminal or a card lands
 * here as an INPUT (`turnStarted`, `turnEnded`, `openHold`, `setCard`,
 * `setBackgroundTasks`, `setClosed`, `processEnded`...). After every patch the
 * store recomposes the subject (`compose.ts`, pure), and only here:
 *
 *   - the EPOCH grows, once per new lit fact: a recomposition of the same
 *     facts (a reload, a reopening, a process ending with nothing in flight)
 *     has the same cause and makes none (section 4.1);
 *   - a new live epoch writes ONE history row (born seen when the subject is
 *     in front of the person), decides the announce and sends the push
 *     (section 10.1);
 *   - the seen is written, per person, as `seen_epoch` and `seen_at`
 *     (section 6);
 *   - `attention:updated` goes out, and `attention:init` is composed for
 *     every new socket of the person (section 7).
 *
 * Two kinds of inputs (section 2.2): SAVED ones live in `subject_attention`
 * because nobody else remembers them (last turn, seen, tasks in flight, epoch
 * and its cause); RE-READ ones (turn open, waits, card, archived, closed,
 * dispatched) are held in memory and read again from where they live at every
 * start (`recomposeAttentionOnBoot`).
 *
 * `server/attention/boundary.test.ts` checks with `git grep` that no other file
 * writes `subject_attention`.
 */
import type { Database } from "bun:sqlite";
import { getDatabase } from "../db";
import { recordAndAnnounce, markSubjectSeenAndAnnounce } from "../notification-registry";
import { sendPushToAll, type OutgoingPushPayload } from "../push-service";
import { buildAnnouncement, type AnnounceFact } from "../push-triggers";
import type { NotificationRecordInput, NotificationRow } from "../../shared/notification-log";
import type { OutboundMessage } from "../../shared/ws-outbound";
import {
  taskIdOfSubject,
  terminalIdOfSubject,
  topicIdOfSubject,
  SEEN_DWELL_MS,
  type AttentionAnnounce,
  type AttentionOutcome,
  type AttentionReason,
  type AttentionSeenItem,
  type AttentionSnapshot,
  type AttentionState,
  type AttentionTask,
  type AttentionTaskMap,
} from "../../shared/attention";
import {
  composeAttention,
  countingTaskCount,
  isLitComposition,
  isTurnUnseen,
  type AttentionCard,
  type AttentionComposition,
  type AttentionHold,
  type AttentionInputs,
  type AttentionLastTurn,
} from "./compose";
import type { TaskChange } from "./background-tasks";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies, injected at bootstrap (`createAppContext`) like the push
// triggers and the notification registry: the module stays testable with two
// fake functions.
// ─────────────────────────────────────────────────────────────────────────────

/** What the store needs to word an announce, read where it lives. */
export interface SubjectDescription {
  /** The chat's or the card's name. */
  name?: string | null;
  /** Muted topic or project (MUTE-01, MUTE-03): the row is written, the announce is not. */
  silenced?: boolean;
  projectId?: string | null;
  /** A card in review: its pending question, and whether the agent's last word asks something. */
  question?: unknown;
  isAsk?: boolean | null;
  /** A parked card: `failed`, `blocked` or `waited_out`. */
  parkState?: string | null;
}

export interface AttentionStoreDeps {
  /** The database, or null for a store held in memory only (unit tests). */
  db: () => Database | null;
  /** To every socket of the person: `broadcastToAll` already keeps `attention:*` off guests. */
  broadcast: (frame: OutboundMessage) => void;
  now: () => number;
  /** The chat's unread counter. */
  unreadOf: (topicId: string) => number;
  /** The chat seen: its unread goes to zero (same write as `markTopicSeen`). */
  resetUnread: (topicId: string) => void;
  /** Writes one history row; `null` when it was not written (dedup, archived topic). */
  recordRow: (input: NotificationRecordInput) => NotificationRow | null;
  /** The subject's rows seen, those written before `before` when given. */
  markRowsSeen: (subject: string, before?: string | null) => number;
  sendPush: (payload: OutgoingPushPayload) => void;
  describe: (subject: string) => SubjectDescription | null;
  /** How long a background that just emptied waits for the wake's turn (T7). */
  graceMs: number;
  /** Is this subject a sub-agent (a row in `subagents`)? Its attention stays quiet until the person opens it. */
  isSubagent: (subject: string) => boolean;
  /** Write down that a person engaged with this sub-agent: it survives a restart. */
  engageSubagent: (subject: string) => void;
  /** A person engaged with this sub-agent before (on record, any process). */
  subagentEngaged: (subject: string) => boolean;
  /** How long a sub-agent stays in front before the focus counts as engaged: the seen's dwell. */
  engageDwellMs: number;
}

function defaultDb(): Database | null {
  try {
    return getDatabase();
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: AttentionStoreDeps = {
  db: defaultDb,
  broadcast: () => {},
  now: () => Date.now(),
  unreadOf: () => 0,
  resetUnread: () => {},
  recordRow: (input) => recordAndAnnounce(input),
  markRowsSeen: (subject, before) => markSubjectSeenAndAnnounce(subject, before),
  sendPush: (payload) => { sendPushToAll(payload).catch((err) => console.warn("[attention] push failed:", err?.message || err)); },
  describe: () => null,
  graceMs: 5_000,
  isSubagent: () => false,
  engageSubagent: () => {},
  subagentEngaged: () => false,
  engageDwellMs: SEEN_DWELL_MS,
};

let deps: AttentionStoreDeps = { ...DEFAULT_DEPS };

/**
 * Merge these dependencies into the current ones. `fresh`: start from the
 * defaults instead, so nothing a previous configuration left (a test's fake
 * push, a closed database) survives into this one.
 */
export function configureAttentionStore(partial: Partial<AttentionStoreDeps>, opts: { fresh?: boolean } = {}): void {
  deps = { ...(opts.fresh ? DEFAULT_DEPS : deps), ...partial };
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** The saved part of a subject: one row of `subject_attention`. */
interface SavedRow {
  subject: string;
  state: AttentionState;
  reason: AttentionReason | null;
  outcome: AttentionOutcome | null;
  detail: string | null;
  since: string;
  epoch: number;
  epochCause: string | null;
  seenEpoch: number;
  lastTurn: AttentionLastTurn | null;
  seenAt: string | null;
  background: AttentionTaskMap;
  updatedAt: string;
}

/** The re-read part: gone at a restart, read again from where it lives. */
interface LiveInputs {
  archived?: boolean;
  deleted?: boolean;
  closed?: boolean;
  dispatched?: boolean;
  holds: Record<string, AttentionHold>;
  /** The card's state, and the words of its announce, which the task service knows. */
  card?: (AttentionCard & { words?: SubjectDescription }) | null;
  turnOpen?: boolean;
  backgroundGrace?: boolean;
}

interface Entry {
  row: SavedRow;
  live: LiveInputs;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** What the last frame said, so an unchanged recomposition stays silent. */
  sentKey: string | null;
  /**
   * Read from the table after a restart: the wait that was open when the
   * server stopped, by kind. The bridge of a child that outlived the restart
   * says it again with an id of the new process; it is the same wait.
   */
  carriedHolds?: Partial<Record<AttentionHold["kind"], string>>;
  /** Causes that are the current epoch's too: the wait open at the restart, and what its end left. */
  sameEpochCauses?: Set<string>;
  /**
   * The person opened this sub-agent (its seen door): from then on it is a chat
   * like any other. Memory only: after a restart it is quiet again until reopened.
   */
  engaged?: boolean;
  /** The last `FINISHED_KEEP` ids of tasks whose end was read (`finishBackgroundTasks`). Memory only. */
  finishedTasks?: Set<string>;
}

const entries = new Map<string, Entry>();
/** The table, for a store held in memory: what survives a simulated restart. */
const memoryTable = new Map<string, SavedRow>();
/** The source the entries were loaded from: a new database is a new world. */
let loadedFrom: Database | "memory" | null = null;
/** The person's sockets and what each has in front, for the epoch born seen. */
const focus = new Map<string, { subject: string | null; awake: boolean }>();

/** Tests only: forget everything; `keepRows` keeps the in-memory table, as a restart would. */
export function resetAttentionStore(opts: { keepRows?: boolean } = {}): void {
  for (const e of entries.values()) if (e.graceTimer) clearTimeout(e.graceTimer);
  entries.clear();
  focus.clear();
  for (const id of [...engageDwells.keys()]) cancelEngageDwell(id);
  loadedFrom = null;
  if (!opts.keepRows) memoryTable.clear();
  deps = { ...DEFAULT_DEPS };
}

function nowIso(): string {
  return new Date(deps.now()).toISOString();
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Load the table once per source: the entries ARE the table, plus what memory holds. */
function ensureLoaded(): void {
  const db = deps.db();
  const source = db ?? "memory";
  if (loadedFrom === source) return;
  for (const e of entries.values()) if (e.graceTimer) clearTimeout(e.graceTimer);
  entries.clear();
  loadedFrom = source;
  const rows: SavedRow[] = [];
  if (db) {
    try {
      const raw = db.query("SELECT * FROM subject_attention").all() as Array<Record<string, unknown>>;
      for (const r of raw) {
        rows.push({
          subject: String(r.subject),
          // A row saved before 2026-10-04 may say `background`, which is `working` now.
          state: (r.state === "background" ? "working" : r.state) as AttentionState,
          reason: (r.reason as AttentionReason | null) ?? null,
          outcome: (r.outcome as AttentionOutcome | null) ?? null,
          detail: (r.detail as string | null) ?? null,
          since: String(r.since),
          epoch: Number(r.epoch ?? 0),
          epochCause: (r.epoch_cause as string | null) ?? null,
          seenEpoch: Number(r.seen_epoch ?? 0),
          lastTurn: parseJson<AttentionLastTurn | null>(r.last_turn, null),
          seenAt: (r.seen_at as string | null) ?? null,
          background: parseJson<AttentionTaskMap>(r.background, {}),
          updatedAt: String(r.updated_at),
        });
      }
    } catch (err) {
      console.warn("[attention] load failed:", (err as Error)?.message || err);
    }
  } else {
    for (const r of memoryTable.values()) rows.push(structuredClone(r));
  }
  for (const row of rows) entries.set(row.subject, { row, live: { holds: {} }, graceTimer: null, sentKey: null, ...carriedOf(row) });
}

/**
 * The wait a saved row was lit by when the server stopped: its cause is
 * `hold:<kind>:<id>` and its state still says it. A wait already answered
 * (the row moved on) carries nothing, so a new question is a new epoch.
 */
function carriedOf(row: SavedRow): Pick<Entry, "carriedHolds" | "sameEpochCauses"> {
  const cause = row.epochCause;
  if (!cause || row.state !== "needs-you" || !row.reason || !cause.startsWith(`hold:${row.reason}:`)) return {};
  const id = cause.slice(`hold:${row.reason}:`.length);
  if (!id) return {};
  return { carriedHolds: { [row.reason as AttentionHold["kind"]]: id }, sameEpochCauses: new Set([cause]) };
}

function persist(row: SavedRow): void {
  const db = deps.db();
  if (!db) {
    memoryTable.set(row.subject, structuredClone(row));
    return;
  }
  try {
    db.run(
      `INSERT INTO subject_attention
         (subject, state, reason, outcome, detail, since, epoch, epoch_cause, seen_epoch, last_turn, seen_at, background, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject) DO UPDATE SET
         state = excluded.state, reason = excluded.reason, outcome = excluded.outcome, detail = excluded.detail,
         since = excluded.since, epoch = excluded.epoch, epoch_cause = excluded.epoch_cause,
         seen_epoch = excluded.seen_epoch, last_turn = excluded.last_turn, seen_at = excluded.seen_at,
         background = excluded.background, updated_at = excluded.updated_at`,
      [
        row.subject, row.state, row.reason, row.outcome, row.detail, row.since, row.epoch, row.epochCause,
        row.seenEpoch, row.lastTurn ? JSON.stringify(row.lastTurn) : null, row.seenAt,
        Object.keys(row.background).length ? JSON.stringify(row.background) : null, row.updatedAt,
      ],
    );
  } catch (err) {
    console.warn("[attention] write failed:", (err as Error)?.message || err);
  }
}

function blankRow(subject: string): SavedRow {
  const at = nowIso();
  return {
    subject, state: "idle", reason: null, outcome: null, detail: null, since: at,
    epoch: 0, epochCause: null, seenEpoch: 0, lastTurn: null, seenAt: null, background: {}, updatedAt: at,
  };
}

function entryOf(subject: string): Entry {
  ensureLoaded();
  let e = entries.get(subject);
  if (!e) {
    e = { row: blankRow(subject), live: { holds: {} }, graceTimer: null, sentKey: null };
    entries.set(subject, e);
  }
  return e;
}

function peek(subject: string): Entry | undefined {
  ensureLoaded();
  return entries.get(subject);
}

function inputsOf(e: Entry): AttentionInputs {
  const quiet = isSubagentSubject(e.row.subject) && !isEngaged(e);
  return { ...e.live, lastTurn: e.row.lastTurn, seenAt: e.row.seenAt, background: e.row.background, ...(quiet ? { quiet } : {}) };
}

function isSubagentSubject(subject: string): boolean {
  try { return deps.isSubagent(subject); } catch { return false; }
}

function isEngaged(e: Entry): boolean {
  if (e.engaged) return true;
  try { e.engaged = deps.subagentEngaged(e.row.subject) || undefined; } catch { /* nothing on record */ }
  return e.engaged === true;
}

/**
 * A person engaged with this subject: they opened it (`seen`) or put it in
 * front (`focus`). A quiet sub-agent is never lit, so its `seen` never came,
 * and the seen alone never fired: the focus counts too, and a sub-agent's is
 * written down, so its chat stays open across a restart.
 */
function engage(subject: string): Entry {
  const e = entryOf(subject);
  if (!e.engaged && isSubagentSubject(subject)) {
    try { deps.engageSubagent(subject); } catch { /* best-effort: the process still knows */ }
  }
  e.engaged = true;
  return e;
}

/**
 * `at`, or one millisecond past `prev` when the clock has not moved: two turns
 * closed in the same millisecond are still two turns, and the seen of the
 * first must not cover the second.
 */
function after(prev: string | null | undefined, at: string): string {
  if (!prev || at > prev) return at;
  return new Date(Date.parse(prev) + 1).toISOString();
}

function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

function taskList(map: AttentionTaskMap): AttentionTask[] {
  return Object.entries(map).map(([id, t]) => ({ id, ...t }));
}

function snapshotOf(e: Entry): AttentionSnapshot {
  const r = e.row;
  const topicId = topicIdOfSubject(r.subject);
  let unread = 0;
  if (topicId) {
    try { unread = deps.unreadOf(topicId); } catch { unread = 0; }
  }
  return {
    subject: r.subject,
    state: r.state,
    reason: r.reason,
    outcome: r.outcome,
    detail: r.detail,
    since: r.since,
    epoch: r.epoch,
    seenEpoch: r.seenEpoch,
    lit: isLitComposition(r),
    unread,
    turnUnseen: isTurnUnseen(r.lastTurn, r.seenAt),
    lastTurnAt: r.lastTurn?.at ?? null,
    background: taskList(r.background),
  };
}

/** The state of one subject; an unknown subject is `idle`. */
export function getAttention(subject: string): AttentionSnapshot {
  const e = peek(subject);
  if (e) return snapshotOf(e);
  return snapshotOf({ row: blankRow(subject), live: { holds: {} }, graceTimer: null, sentKey: null });
}

/**
 * The snapshot a new socket of the person receives (section 7): every subject
 * that is not idle (a `finished` one is always unseen). The client REPLACES
 * its store with it, so a seen lost while a phone slept is not lost for good.
 */
export function attentionInitFrame(): OutboundMessage {
  ensureLoaded();
  const rows: AttentionSnapshot[] = [];
  for (const e of entries.values()) if (e.row.state !== "idle") rows.push(snapshotOf(e));
  return { type: "attention:init", rows } as OutboundMessage;
}

/** How many subjects are lit: the number of the Dock, the tray and the PWA badge. */
export function litSubjectCount(): number {
  ensureLoaded();
  let n = 0;
  for (const e of entries.values()) if (isLitComposition(e.row)) n++;
  return n;
}

/** How many tasks in flight count for this subject: what the phase machine reads at `Stop`. */
export function countingTasks(subject: string): number {
  return countingTaskCount(peek(subject)?.row.background);
}

// ─────────────────────────────────────────────────────────────────────────────
// The recomposition: the one place that moves the epoch, writes the row of a
// new epoch, announces and pushes.
// ─────────────────────────────────────────────────────────────────────────────

interface RecomposeOpts {
  /** False at a restart: no row, no announce, no push, `live: false` on the frame. */
  live: boolean;
  /**
   * The recomposition of every start: a wait open when the server stopped is
   * not re-read (its bridge is gone), and what it covered (an unseen turn, a
   * card) is the same epoch, not a new one (ATTN-07).
   */
  boot?: boolean;
  /** A turn of the subject just closed: it is seen if the subject is in front of the person (T3, T5). */
  turnClosed?: boolean;
  /** Facts that happened while no server read them (a reattach's catch-up): recomposed under the same epoch. */
  sameEpoch?: boolean;
  /** The seen door: the frame goes out even when nothing changed (defect E). */
  force?: boolean;
}

function inFrontOfThePerson(subject: string): boolean {
  for (const f of focus.values()) if (f.subject === subject && f.awake) return true;
  return false;
}

function factOf(subject: string, composition: AttentionComposition, row: SavedRow, description: SubjectDescription | null): AnnounceFact | null {
  const topicId = topicIdOfSubject(subject);
  const terminalId = terminalIdOfSubject(subject);
  const taskId = taskIdOfSubject(subject);
  const name = description?.name ?? null;
  if (composition.state === "finished") {
    if (composition.outcome === "error") return { kind: "error", subject, topicId, terminalId, name, error: row.lastTurn?.detail ?? null };
    return { kind: "finished", subject, topicId, terminalId, name, detail: row.lastTurn?.detail ?? null };
  }
  if (composition.state !== "needs-you") return null;
  if (composition.reason === "review") {
    return { kind: "review", subject, projectId: description?.projectId ?? null, taskId, taskTitle: name, question: description?.question, isAsk: description?.isAsk ?? undefined };
  }
  if (composition.reason === "parked") {
    return { kind: "parked", subject, projectId: description?.projectId ?? null, taskId, taskTitle: name, state: description?.parkState ?? null };
  }
  return { kind: "waiting", subject, reason: composition.reason ?? "question", topicId, terminalId, taskId, projectId: description?.projectId ?? null, name, prompt: composition.detail };
}

// A task's kind and name are part of the key: the CLI lists a Monitor as a
// Bash and recognises it a moment later under the same id, and a frame keyed
// on the ids alone never told the windows it was a Monitor.
function frameKey(s: AttentionSnapshot): string {
  return JSON.stringify([s.state, s.reason, s.outcome, s.detail, s.epoch, s.seenEpoch, s.unread, s.turnUnseen, s.background.map((t) => [t.id, t.kind, t.label, t.recurring ? 1 : 0])]);
}

function recompose(subject: string, opts: RecomposeOpts): AttentionSnapshot {
  const e = entryOf(subject);
  const row = e.row;
  // Closed (archived, deleted, a terminal's tab shut): every turn that closes
  // now is seen as it closes, so reopening relights nothing of before (ATTN-13)
  // and a woken chat under the archive is not deferred to the unarchive (ATTN-11).
  if ((e.live.archived || e.live.deleted || e.live.closed) && row.lastTurn && isTurnUnseen(row.lastTurn, row.seenAt)) row.seenAt = row.lastTurn.at;
  let composition = composeAttention(inputsOf(e));
  let newEpoch = false;
  let bornSeen = false;

  const cause = isLitComposition(composition) ? composition.cause : null;
  if (cause && cause !== row.epochCause && (opts.sameEpoch || e.sameEpochCauses?.has(cause) || (opts.boot && e.sameEpochCauses?.size))) {
    // The same epoch under another of its causes: no bump, no announce.
    e.sameEpochCauses?.add(cause);
    row.epochCause = cause;
  } else if (cause && cause !== row.epochCause) {
    e.sameEpochCauses = undefined;
    row.epoch += 1;
    row.epochCause = composition.cause;
    newEpoch = true;
    if (opts.live && inFrontOfThePerson(subject)) {
      // Born seen (section 6): no count, no unseen row, no push.
      bornSeen = true;
      row.seenEpoch = row.epoch;
      if (composition.state === "finished" && row.lastTurn) row.seenAt = laterOf(row.seenAt, row.lastTurn.at);
      composition = composeAttention(inputsOf(e));
    }
  }
  // A turn that closes on running tasks in front of the person is seen too:
  // the end of the wait (T7) must not light it again.
  if (opts.live && opts.turnClosed && !isLitComposition(composition) && row.lastTurn && isTurnUnseen(row.lastTurn, row.seenAt) && inFrontOfThePerson(subject)) {
    row.seenAt = row.lastTurn.at;
    composition = composeAttention(inputsOf(e));
  }

  if (composition.state !== row.state || composition.reason !== row.reason || composition.outcome !== row.outcome) row.since = nowIso();
  row.state = composition.state;
  row.reason = composition.reason;
  row.outcome = composition.outcome;
  row.detail = composition.detail;
  row.updatedAt = nowIso();
  persist(row);

  let announce: AttentionAnnounce | undefined;
  if (newEpoch && opts.live) {
    let description: SubjectDescription | null = null;
    try { description = deps.describe(subject); } catch { description = null; }
    if (e.live.card?.words) description = { ...(description ?? {}), ...e.live.card.words };
    const fact = factOf(subject, composition.state === "idle" ? composeAttentionForAnnounce(e) : composition, row, description);
    const words = fact ? buildAnnouncement(fact) : null;
    if (words) {
      // The row is written always, born seen when the subject was in front
      // (section 10.1 step 1); an archived subject never gets here (rule 1).
      try { deps.recordRow({ ...words.record, ...(bornSeen ? { seen: true } : {}) }); } catch (err) {
        console.warn("[attention] history row failed:", (err as Error)?.message || err);
      }
      // The announce, unless the subject is silenced or a board agent's (rule 2 never lights one).
      if (!description?.silenced) {
        announce = { title: words.push.title, body: words.push.body, tag: subject, url: words.push.url ?? "/",
          ...(words.push.actions ? { actions: words.push.actions } : {}),
          ...(words.push.requests ? { requests: words.push.requests } : {}) };
        // The push, for every announce not born seen, with the current count.
        if (!bornSeen) {
          try { deps.sendPush({ ...words.push, badge: litSubjectCount() }); } catch (err) {
            console.warn("[attention] push failed:", (err as Error)?.message || err);
          }
        }
      }
    }
  }

  const snap = snapshotOf(e);
  const key = frameKey(snap);
  if (opts.force || announce || key !== e.sentKey) {
    e.sentKey = key;
    try {
      deps.broadcast({
        type: "attention:updated",
        row: snap,
        live: opts.live,
        ...(announce ? { announce, bornSeen } : {}),
      } as OutboundMessage);
    } catch (err) {
      console.warn("[attention] broadcast failed:", (err as Error)?.message || err);
    }
  }
  return snap;
}

/**
 * The composition an epoch was born with, before the born-seen made it idle:
 * a finished turn seen at birth still has its words (the row, the banner the
 * setting "notify even when in front" may show).
 */
function composeAttentionForAnnounce(e: Entry): AttentionComposition {
  return composeAttention({ ...inputsOf(e), seenAt: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

function clearGrace(e: Entry): void {
  if (e.graceTimer) clearTimeout(e.graceTimer);
  e.graceTimer = null;
  e.live.backgroundGrace = false;
}

/**
 * The last counting task left with no turn open: hold `working` for
 * `graceMs`, so the wake that carries the report is the one turn that
 * announces (T6); if no turn opens, the end of the wait decides (T7).
 * Not when all that left was the queued `wake` itself: it leaves by the
 * clock once its turn can no longer come, and there is nothing to wait for.
 */
function armGraceOnLastTask(subject: string, e: Entry, before: AttentionTaskMap): void {
  const counted = Object.values(before).filter((t) => !t.recurring);
  if (counted.length === 0 || countingTaskCount(e.row.background) > 0 || e.live.turnOpen) return;
  if (counted.every((t) => t.kind === "wake")) return;
  if (deps.graceMs <= 0) return;
  clearGrace(e);
  e.live.backgroundGrace = true;
  e.graceTimer = setTimeout(() => {
    e.graceTimer = null;
    e.live.backgroundGrace = false;
    recompose(subject, { live: true });
  }, deps.graceMs);
  (e.graceTimer as { unref?: () => void }).unref?.();
}

/**
 * T1: a turn opens. `dispatched`: a board agent's turn, whose subject is its
 * card. `archived`: the topic as it is now, which a topic born archived (a
 * board agent's) says nowhere else until the next start.
 */
export function turnStarted(subject: string, opts: { dispatched?: boolean; archived?: boolean } = {}): AttentionSnapshot {
  const e = entryOf(subject);
  clearGrace(e);
  e.live.turnOpen = true;
  // The plan panel is answered by the turn it opens: the next turn is the answer.
  if (e.live.holds.plan) {
    const next = { ...e.live.holds };
    delete next.plan;
    e.live.holds = next;
  }
  if (opts.dispatched !== undefined) e.live.dispatched = opts.dispatched;
  if (opts.archived !== undefined) e.live.archived = opts.archived;
  return recompose(subject, { live: true });
}

export interface TurnEnd {
  /** The turn's id (its assistant message): a new id is a new fact. */
  turnId?: string | null;
  /** `done` = something to read, `error` = the turn died; null = nothing to announce (T12, T17). */
  outcome?: AttentionOutcome | null;
  detail?: string | null;
  /** The tasks the turn left in flight, when the caller knows them. */
  background?: AttentionTaskMap;
  /** An error the system resumes by itself (T10b): still `working`, no epoch. */
  resumes?: boolean;
  at?: string;
}

/** T2, T3, T5, T6, T10, T12, T17: a turn closes. */
export function turnEnded(subject: string, end: TurnEnd): AttentionSnapshot {
  const e = entryOf(subject);
  if (end.background !== undefined) e.row.background = { ...end.background };
  if (end.resumes) {
    // The resend reopens the turn: until then the subject stays at work.
    e.live.turnOpen = true;
    return recompose(subject, { live: true });
  }
  e.live.turnOpen = false;
  e.carriedHolds = undefined;
  clearGrace(e);
  if (end.outcome) {
    e.row.lastTurn = {
      id: end.turnId || `turn-${deps.now()}`,
      outcome: end.outcome,
      at: after(e.row.lastTurn?.at, end.at ?? nowIso()),
      ...(end.detail ? { detail: end.detail } : {}),
    };
  }
  return recompose(subject, { live: true, turnClosed: !!end.outcome });
}

/** The whole task map of a subject, as its source knows it now (the CLI's snapshot). */
export function setBackgroundTasks(subject: string, tasks: AttentionTaskMap): AttentionSnapshot {
  const e = entryOf(subject);
  const before = e.row.background;
  e.row.background = { ...tasks };
  armGraceOnLastTask(subject, e, before);
  return recompose(subject, { live: true });
}

/** How many finished task ids a subject remembers: more than the hooks still on their way. */
const FINISHED_KEEP = 64;

/**
 * Tasks leave: their reports arrived, each under every id it may sit under
 * (the CLI's, and its call's until `PostToolUse` re-keys it). The ids stay
 * known, so a hook still on its way (hooks are async, `lib/hook-order.ts`)
 * does not put a finished task back. False when the map did not change.
 *
 * `late`: reports read after the fact, by a reattach's catch-up. What they
 * close ended before this server could tell, so it is recomposed the way a
 * restart is: no row, no announce, no push, no new epoch, no grace to fire one.
 */
export function finishBackgroundTasks(subject: string, ids: readonly string[], opts: { late?: boolean } = {}): boolean {
  const e = entryOf(subject);
  const finished = (e.finishedTasks ??= new Set());
  for (const id of ids) { finished.delete(id); finished.add(id); }
  for (const id of finished) { if (finished.size <= FINISHED_KEEP) break; finished.delete(id); }
  const gone = ids.filter((id) => id in e.row.background);
  if (gone.length === 0) return false;
  const before = e.row.background;
  const next = { ...e.row.background };
  for (const id of gone) delete next[id];
  e.row.background = next;
  if (opts.late) {
    recompose(subject, { live: false, sameEpoch: true });
    return true;
  }
  armGraceOnLastTask(subject, e, before);
  recompose(subject, { live: true });
  return true;
}

/**
 * A batch of changes to the task map, from one hook (`background-tasks.ts`),
 * in one recomposition. Returns whether the map changed.
 */
export function applyTaskChanges(subject: string, changes: readonly TaskChange[]): boolean {
  if (changes.length === 0) return false;
  const e = entryOf(subject);
  const before = e.row.background;
  const next: AttentionTaskMap = { ...e.row.background };
  for (const c of changes) {
    if (c.op === "clear") for (const k of Object.keys(next)) delete next[k];
    else if (c.op === "remove") delete next[c.id];
    else if (c.op === "remove-kind") { for (const [k, t] of Object.entries(next)) if (t.kind === c.kind) delete next[k]; }
    else if (c.op === "remove-one-shot-crons") { for (const [k, t] of Object.entries(next)) if (t.kind === "cron" && !t.recurring) delete next[k]; }
    else if (e.finishedTasks?.has(c.id) || (c.replaces && e.finishedTasks?.has(c.replaces))) {
      // A hook that arrives after the task's end (`finishBackgroundTasks`): the task stays out.
      if (c.replaces) delete next[c.replaces];
    } else {
      const prev = c.replaces ? next[c.replaces] : undefined;
      if (c.replaces) delete next[c.replaces];
      next[c.id] = { ...c.task, startedAt: prev?.startedAt ?? next[c.id]?.startedAt ?? c.task.startedAt };
    }
  }
  if (JSON.stringify(next) === JSON.stringify(e.row.background)) return false;
  e.row.background = next;
  if (countingTaskCount(next) > 0) clearGrace(e);
  else armGraceOnLastTask(subject, e, before);
  recompose(subject, { live: true });
  return true;
}

/** A wait opens (T8). The same id again is the same wait: no new epoch. */
export function openHold(subject: string, source: string, hold: { kind: AttentionHold["kind"]; id: string; text?: string | null; since?: string }): AttentionSnapshot {
  const e = entryOf(subject);
  const prev = e.live.holds[source];
  // The first wait of this kind after a restart, while the one open at the
  // stop is still carried: the surviving bridge saying it again (ATTN-07).
  const carried = !prev ? e.carriedHolds?.[hold.kind] : undefined;
  if (carried) delete e.carriedHolds![hold.kind];
  const id = carried ?? hold.id;
  e.live.holds = { ...e.live.holds, [source]: { kind: hold.kind, id, text: hold.text ?? null, since: prev?.id === id ? prev.since : hold.since ?? nowIso() } };
  return recompose(subject, { live: true });
}

/** A wait ends (T9): answered, decided, cancelled. */
export function closeHold(subject: string, source: string): AttentionSnapshot | null {
  const e = peek(subject);
  if (!e || !e.live.holds[source]) return null;
  const next = { ...e.live.holds };
  delete next[source];
  e.live.holds = next;
  return recompose(subject, { live: true });
}

/** The card's state is not a wait any more: its rows are seen with it (NOTIF-SEEN-01). */
function seeEverything(e: Entry): void {
  e.row.seenEpoch = e.row.epoch;
  if (e.row.lastTurn) e.row.seenAt = laterOf(e.row.seenAt, e.row.lastTurn.at);
  try { deps.markRowsSeen(e.row.subject); } catch { /* best-effort: the frame still says it */ }
}

/**
 * The board card's state (T14, T15). The `since` of a card that stays in the
 * same state is kept, so a new comment on a card in review is the same fact.
 */
export function setCard(subject: string, card: { status: AttentionCard["status"]; since?: string | null; detail?: string | null; words?: SubjectDescription } | null): AttentionSnapshot {
  if (!card && !peek(subject)) return getAttention(subject);
  const e = entryOf(subject);
  const prev = e.live.card;
  if (!card) {
    if (!prev && !(e.row.epochCause?.startsWith("card:") && isLitComposition(e.row))) return snapshotOf(e);
    e.live.card = null;
    if (e.row.epochCause?.startsWith("card:")) seeEverything(e);
    return recompose(subject, { live: true });
  }
  let since = prev?.status === card.status ? prev.since : null;
  // After a restart the cause remembers when the card entered this state.
  if (!since && e.row.epochCause?.startsWith(`card:${card.status}:`)) since = e.row.epochCause.slice(`card:${card.status}:`.length);
  since ??= card.since ?? nowIso();
  e.live.card = { status: card.status, since, detail: card.detail ?? null, ...(card.words ? { words: card.words } : {}) };
  return recompose(subject, { live: true });
}

/**
 * Archived, deleted, closed (T13): the subject goes idle, and its epoch, its
 * last turn and its rows are seen in the same step. Reopening (T18) recomposes
 * without the flag, and the turn seen at the closes makes no epoch.
 */
export function setClosed(subject: string, flags: { archived?: boolean; deleted?: boolean; closed?: boolean }): AttentionSnapshot {
  const e = entryOf(subject);
  // Every closes sees, even of a subject already closed: closes again repairs.
  const closes = !!(flags.archived || flags.deleted || flags.closed);
  if (flags.archived !== undefined) e.live.archived = flags.archived;
  if (flags.deleted !== undefined) e.live.deleted = flags.deleted;
  if (flags.closed !== undefined) e.live.closed = flags.closed;
  if (closes) {
    seeEverything(e);
    clearGrace(e);
  }
  return recompose(subject, { live: true });
}

/** The topic of a board agent (rule 2): its card is the subject. */
export function setDispatched(subject: string, dispatched: boolean): AttentionSnapshot {
  const e = entryOf(subject);
  e.live.dispatched = dispatched;
  return recompose(subject, { live: true });
}

export type ProcessEndCause = "session-end" | "pty-exit" | "cli-exit" | "reaper" | "lifetime-cap" | "crash" | "swap-kill" | "restart";

/**
 * The tasks a process's end leaves in the map. A `run_command` of Topics is
 * not the CLI's: it runs on in Topics' process registry and its exit wakes the
 * chat again, so the CLI's end neither takes it nor counts it (design 5.5: the
 * reaper lights nothing). A restart keeps it only while the registry still
 * owes its wake (review 2 of notifications-redesign, B3).
 */
function survivorsOfProcessEnd(background: AttentionTaskMap, end: { cause: ProcessEndCause; commandsOwed?: boolean }): AttentionTaskMap {
  const survivors: AttentionTaskMap = {};
  if (end.cause !== "restart" || end.commandsOwed) for (const [id, t] of Object.entries(background)) if (t.kind === "command") survivors[id] = t;
  return survivors;
}

/**
 * How many counting tasks died with the process. A restart does not count a
 * saved `wake`: the reattach reads the CLI's own queue again, and a wake the
 * server remembers is no task that died.
 */
function lostWithProcess(background: AttentionTaskMap, survivors: AttentionTaskMap, end: { cause: ProcessEndCause }): number {
  const lost: AttentionTaskMap = {};
  for (const [id, t] of Object.entries(background)) if (!(id in survivors) && !(end.cause === "restart" && t.kind === "wake")) lost[id] = t;
  return countingTaskCount(lost);
}

/**
 * The process of a subject is gone (section 5.5, T16): its tasks go with it.
 * With a turn open or tasks that counted, and an end the person did not ask
 * for, the wait it promised will never be answered: `finished(error)` with a
 * new epoch. Otherwise nothing changes but the map: same cause, no epoch.
 */
export function processEnded(
  subject: string,
  end: {
    cause: ProcessEndCause;
    byPerson?: boolean;
    resumes?: boolean;
    /**
     * A chat: the route closes its own open turn with the error it caught
     * (`stream:end`), and a second error here would be a second epoch of the
     * same death. Only the tasks in flight are this end's to report.
     */
    turnClosedByRoute?: boolean;
    /** A restart: the Topics commands still owe their wake (re-adopted by the process registry). */
    commandsOwed?: boolean;
  },
): AttentionSnapshot {
  const e = entryOf(subject);
  const survivors = survivorsOfProcessEnd(e.row.background, end);
  const counted = lostWithProcess(e.row.background, survivors, end);
  const inFlight = (!!e.live.turnOpen && !end.turnClosedByRoute) || counted > 0;
  e.row.background = survivors;
  e.carriedHolds = undefined;
  if (!end.turnClosedByRoute) e.live.turnOpen = false;
  clearGrace(e);
  if (e.live.holds.phase) {
    const next = { ...e.live.holds };
    delete next.phase;
    e.live.holds = next;
  }
  if (inFlight && !end.byPerson && !end.resumes) {
    const at = nowIso();
    e.row.lastTurn = {
      id: `end:${end.cause}:${at}`,
      outcome: "error",
      at,
      detail: counted > 0
        ? `Il processo è finito con ${counted} ${counted === 1 ? "compito" : "compiti"} in volo`
        : "Il processo è finito a metà turno",
    };
  }
  return recompose(subject, { live: end.cause !== "restart" });
}

// ─────────────────────────────────────────────────────────────────────────────
// The seen (section 6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one door of the seen. For every item: the seen epoch up to the epoch the
 * client showed (never past the current one), the seen turns up to the turn
 * the client showed (never past the last one), the chat's unread to zero, the
 * subject's rows seen up to that epoch, and `attention:updated` ALWAYS, even
 * when nothing changed. A guest's seen is dropped.
 */
export function markAttentionSeen(items: readonly AttentionSeenItem[], origin: { guest?: boolean } = {}): AttentionSnapshot[] {
  if (origin.guest) return [];
  const out: AttentionSnapshot[] = [];
  for (const item of items) {
    if (!item || typeof item.subject !== "string" || !item.subject) continue;
    const e = engage(item.subject);
    const row = e.row;
    const epoch = Number.isFinite(item.epoch) ? Math.max(0, Math.floor(item.epoch)) : 0;
    const covered = Math.min(epoch, row.epoch);
    row.seenEpoch = Math.max(row.seenEpoch, covered);
    let seenTo: string | null = null;
    if (item.turnAt && row.lastTurn) seenTo = item.turnAt < row.lastTurn.at ? item.turnAt : row.lastTurn.at;
    // The epoch of the last turn, seen whole, covers that turn too.
    if (row.lastTurn && epoch >= row.epoch && row.epochCause?.endsWith(`:${row.lastTurn.id}`)) seenTo = laterOf(seenTo, row.lastTurn.at);
    if (seenTo) row.seenAt = laterOf(row.seenAt, seenTo);
    const topicId = topicIdOfSubject(item.subject);
    if (topicId) {
      try { deps.resetUnread(topicId); } catch { /* best-effort */ }
    }
    // The rows up to that epoch: a row of a newer epoch was written after the list was read.
    try { deps.markRowsSeen(item.subject, epoch >= row.epoch ? null : row.since); } catch { /* best-effort */ }
    out.push(recompose(item.subject, { live: true, force: true }));
  }
  return out;
}

/** Everything about this subject seen now: the aliases of the old doors. */

export function seenItemNow(subject: string): AttentionSeenItem {
  const s = getAttention(subject);
  return { subject, epoch: s.epoch, turnAt: s.lastTurnAt };
}

/** The chat's unread changed: a lit chat's count moves in the same frame. */
export function noteUnreadChanged(topicId: string): void {
  const subject = `topic:${topicId}`;
  if (!peek(subject)) return;
  recompose(subject, { live: true });
}

/**
 * The `focus` frame: what this socket has in front, and whether its window is
 * awake. A guest's focus does not count (section 6). The close of the socket
 * clears it (`forgetSocket`).
 */
export function setSocketFocus(socketId: string, f: { subject: string | null; awake: boolean; chosen?: boolean } | null, origin: { guest?: boolean } = {}): void {
  if (origin.guest) return;
  if (!f) focus.delete(socketId);
  else focus.set(socketId, { subject: f.subject, awake: !!f.awake });
  armEngageDwell(socketId, f);
}

/**
 * Per socket: the sub-agent the person chose, waiting out the dwell before it
 * counts as engaged. `timer` is null while the window sleeps: the choice
 * stays, and the dwell runs again when the window wakes on the same subject.
 */
const engageDwells = new Map<string, { subject: string; timer: ReturnType<typeof setTimeout> | null }>();

function cancelEngageDwell(socketId: string): void {
  const pending = engageDwells.get(socketId);
  if (pending?.timer) clearTimeout(pending.timer);
  engageDwells.delete(socketId);
}

/**
 * A sub-agent the person put in front (`chosen`: a click on its row or tab,
 * not a layout the window restored), kept there for the seen's own dwell
 * (`SEEN_DWELL_MS`) with the window awake, is engaged. A pass over it shorter
 * than the dwell does not count. The choice holds until the person puts
 * something else in front: a window that loses focus before the dwell runs
 * out pauses it, and waking on the same subject runs it again, though the
 * frame that wakes it is no gesture. The same subject announced again (a
 * second sender) leaves a running dwell alone.
 */
function armEngageDwell(socketId: string, f: { subject: string | null; awake: boolean; chosen?: boolean } | null): void {
  const pending = engageDwells.get(socketId);
  if (pending && f?.subject === pending.subject) {
    if (!f.awake) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
    } else if (!pending.timer) {
      pending.timer = startEngageDwell(socketId, pending.subject);
    }
    return;
  }
  cancelEngageDwell(socketId);
  if (!f?.chosen || !f.subject || !isSubagentSubject(f.subject) || peek(f.subject)?.engaged) return;
  engageDwells.set(socketId, { subject: f.subject, timer: f.awake ? startEngageDwell(socketId, f.subject) : null });
}

function startEngageDwell(socketId: string, subject: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const now = focus.get(socketId);
    if (now?.subject !== subject || !now.awake) {
      const pending = engageDwells.get(socketId);
      if (pending?.timer === timer) pending.timer = null;
      return;
    }
    engageDwells.delete(socketId);
    engage(subject);
    recompose(subject, { live: true });
  }, deps.engageDwellMs);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

export function forgetSocket(socketId: string): void {
  focus.delete(socketId);
  cancelEngageDwell(socketId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Every start (section 7, T19)
// ─────────────────────────────────────────────────────────────────────────────

export interface AttentionBootReader {
  /** Is the process that holds this subject's tasks still alive? */
  liveProcess?: (subject: string) => boolean;
  /** A chat's Topics `run_command` still owes it a wake: alive in the process registry, whatever its CLI. */
  commandOwed?: (subject: string) => boolean;
  /** The plan panel this subject was waiting on when the server stopped is still unanswered on its row. */
  planWaiting?: (subject: string, toolCallId: string) => boolean;
  /** Cards in review or parked, read from `tasks`. */
  cards?: () => Array<{ taskId: string; status: AttentionCard["status"]; since?: string | null; detail?: string | null }>;
  /** Of these subjects, the ones archived or deleted (`topics`). */
  archived?: (subjects: string[]) => Set<string>;
  /** Of these subjects, the terminals closed (roster and pane store). */
  closed?: (subjects: string[]) => Set<string>;
  /** Topics of board agents in flight (dispatcher). */
  dispatched?: () => string[];
}

/**
 * The store reads its table again, the re-read inputs from where they live,
 * ends the subjects whose process is gone (`processEnded` with `restart`), and
 * recomposes everything with `live: false`. By section 4.1 no epoch is born
 * of the same facts; with an empty table only what is true now lights up.
 */
export function recomposeAttentionOnBoot(reader: AttentionBootReader = {}): void {
  // What THIS process already said before the recomposition (a reattached
  // turn's `stream:start`, a bridge's wait) is current: it survives the reread.
  const prior = new Map<string, LiveInputs>();
  for (const [subject, e] of entries) {
    if (e.live.turnOpen || Object.keys(e.live.holds).length) prior.set(subject, { holds: { ...e.live.holds }, ...(e.live.turnOpen ? { turnOpen: true } : {}) });
  }
  loadedFrom = null;
  ensureLoaded();
  for (const [subject, e] of entries) {
    clearGrace(e);
    e.live = prior.get(subject) ?? { holds: {} };
    if (Object.keys(e.live.holds).length) e.carriedHolds = undefined;
    e.sentKey = null;
  }
  for (const [subject, live] of prior) if (!entries.has(subject)) entryOf(subject).live = live;
  for (const c of reader.cards?.() ?? []) {
    const subject = `task:${c.taskId}`;
    const e = entryOf(subject);
    let since = e.row.epochCause?.startsWith(`card:${c.status}:`) ? e.row.epochCause.slice(`card:${c.status}:`.length) : null;
    since ??= c.since ?? nowIso();
    e.live.card = { status: c.status, since, detail: c.detail ?? null };
  }
  const subjects = [...entries.keys()];
  const archived = reader.archived?.(subjects) ?? new Set<string>();
  const closed = reader.closed?.(subjects) ?? new Set<string>();
  for (const s of archived) { const e = entries.get(s); if (e) e.live.archived = true; }
  for (const s of closed) { const e = entries.get(s); if (e) e.live.closed = true; }
  for (const s of reader.dispatched?.() ?? []) entryOf(s).live.dispatched = true;
  // A saved wait (HOLD-04): the plan panel lives on its row, not in a bridge,
  // so it is read again; a bridge's wait comes back when its child says it.
  for (const [subject, e] of entries) {
    const planId = e.carriedHolds?.plan;
    if (!planId || e.live.holds.plan || !reader.planWaiting?.(subject, planId)) continue;
    e.live.holds = { ...e.live.holds, plan: { kind: "plan", id: planId, text: e.row.detail, since: e.row.since } };
    delete e.carriedHolds!.plan;
  }
  for (const [subject, e] of [...entries]) {
    const alive = reader.liveProcess ? reader.liveProcess(subject) : true;
    if (!alive) {
      const end = { cause: "restart" as const, commandsOwed: reader.commandOwed?.(subject) === true };
      const survivors = survivorsOfProcessEnd(e.row.background, end);
      if (lostWithProcess(e.row.background, survivors, end) > 0) {
        processEnded(subject, end);
        continue;
      }
      e.row.background = survivors;
    }
    recompose(subject, { live: false, boot: true });
  }
}
