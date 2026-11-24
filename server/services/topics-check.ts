/**
 * The self-check round (CHECK-01, CHECK-02): every 5 minutes the server reads
 * its own database, keeps a sample, and turns the last samples into three
 * voices, each measured in hours lost:
 *   1. cards advance, 2. nodes give the seats they promise, 3. the declared
 *   proofs pass.
 * It never calls a model. `sampleTopics` and `voices` are pure; the timer, the
 * table and the proofs' commands are the only parts that touch the world.
 *
 * Nothing here names a machine, a host or an account: thresholds and proofs
 * live in the `topicsCheck` app setting (JSON), and the default is empty and
 * works.
 */
import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { getAppSettings } from "./app-settings";
import { runBounded } from "../lib/machine-security-env";
import { NODE_UNREACHABLE_ERROR, statusEventEnters, WAITING_MEMORY_REASON, type QueueReason, type QueueReasonKind } from "../../shared/board";
import { createTasksShared } from "./tasks/shared";
import { PLAN_SPENT_NOTE } from "./task-dispatcher-support";

export const SAMPLE_INTERVAL_MS = 5 * 60_000;
export const KEEP_SAMPLES_MS = 7 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
/** What one bounce costs, as a stated estimate: a dispatch that went nowhere. */
const BOUNCE_COST_HOURS = 0.25;

/**
 * The round's queries, exported so a test can ask the planner about the very text that runs.
 * The planner picks the (task, author, kind) index by itself: with no hint, a schema without it still answers.
 */
export const QUEUE_MOVED_SQL = "SELECT 1 FROM tasks WHERE in_progress_at >= ? LIMIT 1";
export const THREADS_SQL =
  "SELECT task_id, kind, content, created_at FROM task_comments WHERE task_id IN (SELECT value FROM json_each(?)) AND (kind = 'status' OR (kind = 'comment' AND author != 'system'))";
export const PARKED_EVENTS_SQL = "SELECT content, created_at FROM task_comments WHERE task_id = ? AND kind = 'status' ORDER BY created_at DESC";
export const MOVES_SQL = "SELECT task_id, content, created_at FROM task_comments WHERE content LIKE 'Spostata %' AND created_at >= ? ORDER BY created_at DESC LIMIT 200";
export const READ_SAMPLES_SQL = "SELECT sample_json FROM topics_check_samples WHERE at >= ? ORDER BY at";

export interface CheckSpec { name: string; command: string; tier: "5min" | "daily" }

export interface Thresholds {
  /** A card in todo that has not started after this long is stuck. */
  todoStuckHours: number;
  /** A card in progress with no activity for this long is stuck. */
  progressStuckHours: number;
  /** This many moves of one card inside `cardMovesWindowMin` is a bounce. */
  cardMoves: number;
  cardMovesWindowMin: number;
  /** This many moves in 24 hours, over all cards, is red. */
  totalMoves: number;
  /** The seats voice looks back this far. */
  seatsWindowHours: number;
  /** The seats voice is red from this many lost hours. */
  seatsRedHours: number;
  /** A node with an open run that sent nothing for this long is hung. */
  nodeSilentMin: number;
  /** A slot wait is a wait only if some card started within this window. */
  queueMovedHours: number;
  /** Wall-clock cap of one proof's command. */
  checkTimeoutSec: number;
}

/** Where the cures open an investigation card, and how many a day. Off while `boardId` is empty. */
export interface InvestigationSettings { boardId: string | null; perDay: number }

export interface TopicsCheckSettings { thresholds: Thresholds; checks: CheckSpec[]; investigation: InvestigationSettings }

export const DEFAULT_THRESHOLDS: Thresholds = {
  todoStuckHours: 1, progressStuckHours: 2, cardMoves: 4, cardMovesWindowMin: 60,
  totalMoves: 10, seatsWindowHours: 12, seatsRedHours: 1, nodeSilentMin: 15, queueMovedHours: 1, checkTimeoutSec: 30,
};

/** Reads the JSON setting; anything unreadable or out of range falls back to the default. */
export function parseSettings(raw: string | null | undefined): TopicsCheckSettings {
  let o: { thresholds?: Record<string, unknown>; checks?: unknown; investigation?: { boardId?: unknown; perDay?: unknown } } = {};
  try { o = raw ? (JSON.parse(raw) as typeof o) ?? {} : {}; } catch { /* defaults */ }
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(thresholds) as (keyof Thresholds)[]) {
    const v = o.thresholds?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) thresholds[k] = v;
  }
  const checks = (Array.isArray(o.checks) ? o.checks : []).flatMap((c: unknown): CheckSpec[] => {
    const r = c as Partial<CheckSpec> | null;
    if (!r || typeof r.name !== "string" || typeof r.command !== "string" || !r.name || !r.command) return [];
    return [{ name: r.name, command: r.command, tier: r.tier === "daily" ? "daily" : "5min" }];
  });
  const perDay = o.investigation?.perDay;
  const investigation: InvestigationSettings = {
    boardId: typeof o.investigation?.boardId === "string" && o.investigation.boardId ? o.investigation.boardId : null,
    perDay: typeof perDay === "number" && Number.isInteger(perDay) && perDay >= 0 ? perDay : 3,
  };
  return { thresholds, checks, investigation };
}

export type StuckCause =
  | "person" | "chain-parked" | "hung-node" | "offline" | "seats" | "memory" | "stay-local" | "plan" | "spend" | "resources"
  | "attempts" | "parent-review" | "parent-idle" | "no-project" | "missed-run" | "unknown";
export interface StuckCard { id: string; status: "todo" | "in_progress"; hours: number; cause: StuckCause }
export interface MachineSample { id: string; name: string; online: boolean; slots: number | null; cards: number; heartbeatAt: number }
/** `silent`: the target machine was off and had not beaten since before the move. */
export interface Move { id: string; at: number; to: string; silent: boolean }
export interface ProofResult { name: string; ok: boolean; reason: string | null }

export type CureOutcome = "cured" | "investigated" | "capped" | "off" | "skipped";
export interface CureReport { key: string; outcome: CureOutcome }

export interface Sample {
  at: number;
  todo: number;
  machines: MachineSample[];
  stuck: StuckCard[];
  moves: Move[];
  /** Filled by the round after the proofs ran; `sampleTopics` leaves it out. */
  checks?: ProofResult[];
  /** Filled after the cures ran on this sample: what they did, so the view can say it (CHECK-03). */
  cures?: CureReport[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: string | null | undefined) => Date.parse(v ?? "") || 0;
const MAX_CHAIN_DEPTH = 20;
/** A note that names a role (the board's owner, a coordinator) speaks about the card, not on it: no life. */
const ROLE_NOTE = /^[^a-z]{0,6}(padrone|coordinatore)\b/i; // allow-italian: the role words those notes open with
/** The causes a queue reason names by itself, whatever else the card shows. */
const CAUSE_OF_KIND: Partial<Record<QueueReasonKind, StuckCause>> = {
  spend_cap: "spend", attempts: "attempts", parent_review: "parent-review", parent_idle: "parent-idle", no_project: "no-project",
};

/** An assignee that names the agent, not a person: the board writes it on cards it hands to an agent. */
export const AGENT_ASSIGNEE = /^(agents?|agente|agenti|ai|bot)$/i; // allow-italian: the generic word boards use for the agent

/** Counts what a round computed, so a test can prove the work stays on the few old cards. */
export interface SampleProbe { reasons: number }

/** The columns of a `tasks` row this round reads. */
interface TaskSampleRow {
  id: string; status: "todo" | "in_progress"; project_id: string | null; created_at: string; reopened_at: string | null;
  in_progress_at: string | null; scheduled_at: string | null; scheduled_by: string | null;
  dispatch_state: string | null; dispatch_error: string | null; dispatch_deferred_until: string | null;
  wait_source: string | null; wait_since: string | null; wait_reason: string | null;
  node_run_open: number | null; machine_id: string | null; stay_local: number | null; stay_local_until: string | null;
  parent_task_id: string | null; blocked_by_task_id: string | null;
  human_ask: string | null; stage: string | null; assigned_to: string | null;
}

/** One reading of the database at `now`. Read-only. */
export function sampleTopics(db: Database, now: number, t: Thresholds = DEFAULT_THRESHOLDS, localHost: string = hostname(), probe?: SampleProbe): Sample {
  const rows = db.query("SELECT * FROM tasks WHERE status IN ('todo', 'in_progress') AND archived = 0").all() as TaskSampleRow[];
  // Same predicate as the dispatcher: the machine-wide switch lives in app_settings and a board can only pause itself.
  const globalAuto = !!(db.query("SELECT auto_dispatch FROM app_settings LIMIT 1").get() as { auto_dispatch?: number | null } | null)?.auto_dispatch;
  const pausedBoards = new Set((db.query("SELECT project_id FROM board_settings WHERE dispatch_paused = 1").all() as { project_id: string }[]).map((r) => r.project_id));
  const machineRows = db.query("SELECT id, name, hostname, status, slots, last_heartbeat_at FROM machines").all() as
    { id: string; name: string; hostname: string; status: string; slots: number | null; last_heartbeat_at: string | null }[];
  const machines: MachineSample[] = machineRows.map((m) => ({
    id: m.id, name: m.name, online: m.status === "online", slots: m.slots,
    cards: rows.filter((r) => r.machine_id === m.id).length,
    heartbeatAt: ms(m.last_heartbeat_at),
  }));
  const byId = new Map(machines.map((m) => [m.id, m]));
  // The local row is always online with no declared seats: it says nothing about the seats other machines give.
  const remote = machineRows.filter((m) => m.hostname !== localHost).map((m) => byId.get(m.id)!);
  const noSeats = remote.length > 0 && remote.every((m) => !m.online || m.slots === 0);

  // Age first, from the cheap columns: the reasons are read only for the few cards already past a threshold.
  const since = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "todo") {
      if (!globalAuto || (r.project_id && pausedBoards.has(r.project_id))) continue;
      // A node that keeps failing defers the card by 5 minutes at a time: its age is the whole series (`wait_since`).
      const nodeWait = r.dispatch_error === NODE_UNREACHABLE_ERROR || r.wait_source === "machine";
      const deferral = nodeWait ? ms(r.wait_since) : Math.min(ms(r.dispatch_deferred_until), now);
      since.set(r.id, Math.max(ms(r.created_at), ms(r.reopened_at), deferral, Math.min(ms(r.scheduled_at), now)));
    } else if (r.dispatch_state !== "working" || r.node_run_open === 1) {
      since.set(r.id, Math.max(ms(r.in_progress_at) || ms(r.created_at), ms(r.reopened_at)));
    }
  }
  const limitH = (r: TaskSampleRow) => (r.status === "todo" ? t.todoStuckHours : t.progressStuckHours);
  const over = (r: TaskSampleRow) => since.has(r.id) && (now - since.get(r.id)!) / HOUR_MS >= limitH(r);
  // One read of the threads of the cards already past a threshold, which can only make them younger:
  // a todo card is as old as its last entry into todo (`reopened_at` is written only on the way out of review
  // or done), a card in progress as its last entry into in_progress, and it lives as long as a person or an
  // agent writes on it. The planner picks the (task, author, kind) index by itself: with no hint, a schema
  // without that index still answers.
  const firstCut = rows.filter(over);
  const threads = db.query(THREADS_SQL).all(JSON.stringify(firstCut.map((r) => r.id))) as { task_id: string; kind: string; content: string; created_at: string }[];
  const statusOf = new Map(firstCut.map((r) => [r.id, r.status]));
  for (const c of threads) {
    const status = statusOf.get(c.task_id)!;
    const life = c.kind === "status" ? statusEventEnters(c.content, status) : status === "in_progress" && !ROLE_NOTE.test(c.content);
    if (life) since.set(c.task_id, Math.max(since.get(c.task_id)!, ms(c.created_at)));
  }
  const old = firstCut.filter(over);

  // The board's own reading of those cards, with the context the board uses: nothing is rebuilt here.
  const shared = createTasksShared(db, {});
  const batch = shared.buildBatch(old, { reasonsOnly: true });
  batch.nowIso = iso(now);
  let moved: boolean | null = null;
  const queueMoved = () => (moved ??= !!db.query(QUEUE_MOVED_SQL).get(iso(now - t.queueMovedHours * HOUR_MS)));
  /** When a card last went into backlog: its last status event there, or its birth when it was born there. */
  const parkedAt = (id: string, createdAt: string): number => {
    const events = db.query(PARKED_EVENTS_SQL).all(id) as { content: string; created_at: string }[];
    return ms(events.find((e) => statusEventEnters(e.content, "backlog"))?.created_at ?? createdAt);
  };
  /** The card that holds a chain: the first one parked in backlog, or closed, along the blockers; `since` is when it was parked. */
  const roots = new Map<string, { status: string; since: number } | null>();
  const chainRoot = (id: string | null): { status: string; since: number } | null => {
    if (!id) return null;
    if (roots.has(id)) return roots.get(id)!;
    let root: { status: string; since: number } | null = null;
    let cur: string | null = id;
    for (let i = 0; cur && i < MAX_CHAIN_DEPTH; i++) {
      const k = db.query("SELECT status, archived, blocked_by_task_id, created_at FROM tasks WHERE id = ?").get(cur) as { status: string; archived: number; blocked_by_task_id: string | null; created_at: string } | null;
      if (!k || k.archived) break;
      if (k.status === "backlog" || k.status === "done") {
        root = { status: k.status, since: k.status === "backlog" ? parkedAt(cur, k.created_at) : 0 };
        break;
      }
      cur = k.blocked_by_task_id;
    }
    roots.set(id, root);
    return root;
  };
  /** A slot wait is lost when a plan holds it, when its machine is off, or when nothing started for a while. */
  const queueWait = (r: TaskSampleRow, pinnedOff: boolean): StuckCause | null => {
    // A held resume carries the memory code without a published block; the provider's plan hold writes its own
    // sentence next to the bare queued chip, and publishes no machine block either. Only a spent plan is lost:
    // the five-hour window and the deferral after a restart end by themselves.
    if (r.dispatch_state === "queued" && r.dispatch_error) {
      if (r.dispatch_error === WAITING_MEMORY_REASON) return "memory";
      return String(r.dispatch_error).includes(PLAN_SPENT_NOTE) ? "plan" : null;
    }
    if (pinnedOff) return "offline";
    if (queueMoved()) return null;
    if (r.stay_local && !(r.stay_local_until && ms(r.stay_local_until) <= now)) return "stay-local";
    return noSeats ? "seats" : "unknown";
  };
  /** Why a card past its threshold has not moved, or null when its wait is one somebody chose. */
  const classify = (r: TaskSampleRow, reason: QueueReason | null, pinnedOff: boolean): StuckCause | null => {
    if (reason === null) {
      if (r.status === "todo") return r.scheduled_by && ms(r.scheduled_at) > 0 && ms(r.scheduled_at) <= now ? "missed-run" : null;
      // A resume waiting for its slot is a queue wait like any other.
      if (r.dispatch_state === "queued") return queueWait(r, pinnedOff);
      // A subtask whose parent is at work waits on purpose.
      if (r.parent_task_id) return batch.parentStatus.get(r.parent_task_id) === "in_progress" ? null : "parent-idle";
      return "unknown";
    }
    const byKind = CAUSE_OF_KIND[reason.kind];
    if (byKind) return byKind;
    switch (reason.kind) {
      case "node_unreachable": return pinnedOff ? "offline" : "hung-node";
      // A chain held by a card the dispatcher parked will never move.
      case "blocked": return chainRoot(r.blocked_by_task_id)?.status === "backlog" ? "chain-parked" : null;
      // A heavy card held behind the memory floor waits on memory like any other; held for load alone, it waits.
      case "heavy_hold":
      case "resource_floor":
        if (r.dispatch_error === WAITING_MEMORY_REASON) return r.dispatch_state === "queued" ? "memory" : null;
        return reason.kind === "resource_floor" ? "resources" : null;
      case "slot": return queueWait(r, pinnedOff);
      case "no_agent":
        // A wait the agent declared, with its date still ahead, is chosen; a chip left on the card with no reason is not.
        if (r.dispatch_state === "waiting" && r.wait_reason && ms(r.dispatch_deferred_until) > now) return null;
        if (pinnedOff) return "offline";
        return reason.tone === "waiting" ? null : "unknown";
      default: return reason.tone === "stalled" ? "unknown" : null;
    }
  };

  const stuck: StuckCard[] = [];
  for (const r of old) {
    const pinned = r.machine_id ? byId.get(r.machine_id) : undefined;
    const pinnedOff = !!pinned && !pinned.online;
    const openRun = r.status === "in_progress" && r.node_run_open === 1;
    let from = since.get(r.id)!;
    let cause: StuckCause | null;
    if (r.dispatch_state === "working" || openRun) {
      // A run on a node that went off is lost from the node's last beat; on a node that answers, only a failing poll or silence is.
      if (openRun && pinnedOff) { cause = "offline"; from = Math.max(from, pinned!.heartbeatAt); }
      else if (openRun && pinned && (r.dispatch_error === NODE_UNREACHABLE_ERROR || (now - pinned.heartbeatAt) / 60_000 >= t.nodeSilentMin)) cause = "hung-node";
      else continue;
    } else if (r.human_ask?.trim() || r.stage === "human_review" || (r.status === "in_progress" && r.assigned_to && !AGENT_ASSIGNEE.test(r.assigned_to))) {
      cause = "person";
    } else {
      if (probe) probe.reasons++;
      cause = classify(r, shared.queueReasonOf(r, batch), pinnedOff);
      // A parked chain loses time from when its root was parked, not from when each card entered the queue.
      if (cause === "chain-parked") from = Math.max(from, chainRoot(r.blocked_by_task_id)!.since);
    }
    const hours = (now - from) / HOUR_MS;
    if (cause && hours >= limitH(r)) stuck.push({ id: r.id, status: r.status, hours, cause });
  }

  const sinceDay = iso(now - 24 * HOUR_MS);
  const moves = (db.query(MOVES_SQL).all(sinceDay) as
    { task_id: string; content: string; created_at: string }[]).map((c): Move => {
    const at = Date.parse(c.created_at);
    const to = /^Spostata su ([^:]+):/.exec(c.content)?.[1] ?? /^Spostata da .+? a ([^:]+):/.exec(c.content)?.[1] ?? "";
    const target = machines.find((m) => m.name === to);
    return { id: c.task_id, at, to, silent: !!target && !target.online && target.heartbeatAt < at };
  });
  return { at: now, todo: rows.filter((r) => r.status === "todo").length, machines, stuck, moves };
}

export interface Voice {
  id: "cards" | "seats" | "proofs";
  red: boolean;
  hoursLost: number;
  /** What was measured, in one line. */
  detail: string;
  /** The most likely cause, in one sentence; null while green. */
  cause: string | null;
}

export const CAUSE_TEXT: Record<StuckCause, string> = {
  person: "in attesa di una persona",
  "hung-node": "il nodo ha preso la corsa e non risponde più (appeso)",
  "chain-parked": "la catena è bloccata da una card parcheggiata in backlog",
  offline: "la card è fissata a una macchina spenta",
  seats: "nessuna macchina dà posti",
  memory: "il pavimento di memoria tiene ferma la coda",
  "stay-local": "il pin «solo Mac» tiene la card dove non c'è posto",
  plan: "il piano del provider è esaurito: le card non ripartono da sole",
  spend: "il tetto di spesa tiene ferma la coda",
  resources: "il pavimento di disco o di RAM tiene ferma la coda",
  attempts: "tentativi esauriti: la card aspetta che qualcuno la rimetta in coda",
  "parent-review": "il genitore è in revisione e i sottotask aspettano",
  "parent-idle": "il genitore è fermo e i sottotask non partono",
  "no-project": "la card non ha un progetto in cui girare",
  "missed-run": "la corsa programmata è passata senza partire",
  unknown: "nessun turno vivo e nessuna domanda aperta",
};

const fmtHours = (h: number) => `${Math.round(h * 10) / 10} h`;
const mostCommon = <T,>(xs: T[]): T | undefined => {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** The cards that moved `cardMoves` times inside `cardMovesWindowMin`: one card ping-ponging between machines. */
export function pingPongCards(moves: readonly Move[], t: Thresholds): Set<string> {
  const perCard = new Map<string, number[]>();
  for (const m of moves) perCard.set(m.id, [...(perCard.get(m.id) ?? []), m.at]);
  const windowMs = t.cardMovesWindowMin * 60_000;
  return new Set([...perCard].filter(([, ats]) => ats.some((a) => ats.filter((b) => b >= a && b < a + windowMs).length >= t.cardMoves)).map(([id]) => id));
}

/** The three voices from the samples (oldest first or not, the order does not matter). */
export function voices(samples: readonly Sample[], settings: TopicsCheckSettings): Voice[] {
  const { thresholds: t } = settings;
  const last = samples.reduce<Sample | null>((a, s) => (!a || s.at > a.at ? s : a), null);

  // 1. Cards advance: stuck cards, and bounces. A healthy overflow also writes a "moved to" note, so a
  // move is only a bounce when one card ping-pongs, or when it went to a machine that was not answering.
  const stuck = last?.stuck ?? [];
  const moves = last?.moves ?? [];
  const pingPong = pingPongCards(moves, t);
  const silentMoves = moves.filter((m) => m.silent);
  const toSilent = silentMoves.length >= t.totalMoves;
  const bounces = moves.filter((m) => pingPong.has(m.id) || (toSilent && m.silent));
  const stuckHours = stuck.reduce((s, c) => s + c.hours, 0);
  const bounceHours = bounces.length * BOUNCE_COST_HOURS;
  const parts: string[] = [];
  let cause: string | null = null;
  if (stuck.length) {
    parts.push(`${stuck.length} card ferme`);
    cause = CAUSE_TEXT[mostCommon(stuck.map((c) => c.cause))!];
  }
  if (bounces.length > 0) {
    parts.push(`${bounces.length} rimbalzi`);
    cause ??= bounces.filter((m) => m.silent).length * 2 > bounces.length ? "le card vengono mandate a una macchina spenta" : "le card rimbalzano fra i nodi: segnala «solo Mac»";
  }
  const cardsVoice: Voice = {
    id: "cards", red: parts.length > 0, hoursLost: stuckHours + bounceHours,
    detail: parts.length ? `${parts.join(", ")}: ${fmtHours(stuckHours + bounceHours)} perse` : "le card avanzano",
    cause,
  };

  // 2. Nodes give the seats they promise: a sample is lost while cards wait and a node that promised seats gives none.
  const windowStart = (last?.at ?? 0) - t.seatsWindowHours * HOUR_MS;
  const inWindow = samples.filter((s) => s.at > windowStart);
  const promised = new Map<string, number>();
  for (const s of inWindow) for (const m of s.machines) promised.set(m.id, Math.max(promised.get(m.id) ?? 0, m.slots ?? 0));
  const lostBy = new Map<string, { name: string; n: number; off: number }>();
  for (const s of inWindow) {
    if (s.todo + s.stuck.length === 0) continue;
    for (const m of s.machines) {
      const emptied = m.online && m.slots === 0 && (promised.get(m.id) ?? 0) > 0;
      const offChosen = !m.online && m.cards > 0;
      if (!emptied && !offChosen) continue;
      const e = lostBy.get(m.id) ?? { name: m.name, n: 0, off: 0 };
      e.n++; if (offChosen) e.off++;
      lostBy.set(m.id, e);
    }
  }
  const seatHours = [...lostBy.values()].reduce((s, e) => s + e.n, 0) * SAMPLE_INTERVAL_MS / HOUR_MS;
  const worst = [...lostBy.values()].sort((a, b) => b.n - a.n)[0];
  const seatsRed = seatHours >= t.seatsRedHours;
  const seatsVoice: Voice = {
    id: "seats", red: seatsRed, hoursLost: seatHours,
    detail: seatsRed ? `${fmtHours(seatHours)} su ${t.seatsWindowHours} h` : "i nodi danno i posti promessi",
    cause: !seatsRed || !worst ? null : worst.off * 2 > worst.n ? "un nodo spento resta fra le macchine scelte" : "un nodo ha dichiarato posti e ne dà 0 mentre c'è coda",
  };

  // 3. The declared proofs.
  const results = last?.checks ?? [];
  const red = results.filter((r) => !r.ok);
  const proofsVoice: Voice = {
    id: "proofs", red: red.length > 0, hoursLost: 0,
    detail: settings.checks.length === 0 ? "nessuna prova dichiarata" : red.length ? `${red.length} prove su ${results.length} rosse` : `${results.length} prove verdi`,
    cause: red.length ? `${red[0]!.name}: ${red[0]!.reason ?? "esce con errore"}` : null,
  };
  return [cardsVoice, seatsVoice, proofsVoice];
}

export type Runner = typeof runBounded;

/** Runs the proofs of one tier (the 5-minute ones by default), each under the wall-clock cap; a non-zero exit or a timeout is red. */
export async function runProofs(checks: readonly CheckSpec[], timeoutSec: number, run: Runner = runBounded, tier: CheckSpec["tier"] = "5min"): Promise<ProofResult[]> {
  const shell = process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];
  return Promise.all(checks.filter((c) => c.tier === tier).map(async (c): Promise<ProofResult> => {
    const r = await run([...shell, c.command], timeoutSec * 1000);
    if (r.timedOut) return { name: c.name, ok: false, reason: `oltre ${timeoutSec} s` };
    if (r.missing) return { name: c.name, ok: false, reason: "comando non avviabile" };
    return r.code === 0 ? { name: c.name, ok: true, reason: null } : { name: c.name, ok: false, reason: `esce con ${r.code}` };
  }));
}

/** The samples taken at or after `sinceMs` (default: everything kept), oldest first. */
export function readSamples(db: Database, sinceMs = 0): Sample[] {
  return (db.query(READ_SAMPLES_SQL).all(sinceMs) as { sample_json: string }[]).map((r) => JSON.parse(r.sample_json) as Sample);
}

export type RoundState = "waiting" | "stale" | "live";

/** No sample yet is `waiting`; a last sample older than two intervals is `stale`. Neither is ever green. */
export function roundState(samples: readonly { at: number }[], now: number): { state: RoundState; ageMin: number | null } {
  const lastAt = samples.reduce<number | null>((a, s) => (a === null || s.at > a ? s.at : a), null);
  if (lastAt === null) return { state: "waiting", ageMin: null };
  const age = Math.max(0, now - lastAt);
  return { state: age > 2 * SAMPLE_INTERVAL_MS ? "stale" : "live", ageMin: Math.floor(age / 60_000) };
}

/** What the last round's cures did, by problem key. The ones that did nothing are left out. */
export interface CureSummary { cured: string[]; investigated: string[]; capped: string[] }

export function summarizeCures(reports: readonly CureReport[] = []): CureSummary {
  const keys = (o: CureOutcome) => reports.filter((r) => r.outcome === o).map((r) => r.key);
  return { cured: keys("cured"), investigated: keys("investigated"), capped: keys("capped") };
}

export interface TopicsCheckRound {
  /** One round: sample, run the proofs, store, trim. Returns the voices. A round already in flight is joined, never doubled. */
  tick(): Promise<Voice[]>;
  /** What the view shows, from one read of only the window the voices use. */
  current(): { at: number | null; state: RoundState; ageMin: number | null; voices: Voice[]; cures: CureSummary };
}

/** The oldest sample `voices` can use: its widest window, with one interval of slack. */
const oldestUsed = (now: number, s: TopicsCheckSettings) => now - s.thresholds.seatsWindowHours * HOUR_MS - SAMPLE_INTERVAL_MS;

export function createTopicsCheck(opts: { db: Database; now?: () => number; settings?: () => TopicsCheckSettings; run?: Runner; cure?: (sample: Sample, s: TopicsCheckSettings) => CureReport[] | void }): TopicsCheckRound {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const settings = opts.settings ?? (() => parseSettings(getAppSettings().topicsCheck));
  let inFlight: Promise<Voice[]> | null = null;
  const run = async (): Promise<Voice[]> => {
    const s = settings();
    const at = now();
    const sample: Sample = { ...sampleTopics(db, at, s.thresholds), checks: await runProofs(s.checks, s.thresholds.checkTimeoutSec, opts.run) };
    db.query("INSERT OR REPLACE INTO topics_check_samples (at, sample_json) VALUES (?, ?)").run(at, JSON.stringify(sample));
    db.query("DELETE FROM topics_check_samples WHERE at < ?").run(at - KEEP_SAMPLES_MS);
    try {
      const reports = opts.cure?.(sample, s);
      if (reports?.length) db.query("UPDATE topics_check_samples SET sample_json = ? WHERE at = ?").run(JSON.stringify({ ...sample, cures: reports }), at);
    } catch (e) { console.warn("[topics-check] cures failed:", e instanceof Error ? e.message : e); }
    return voices(readSamples(db, oldestUsed(at, s)), s);
  };
  return {
    tick() {
      inFlight ??= run().finally(() => { inFlight = null; });
      return inFlight;
    },
    current() {
      const s = settings();
      const at = now();
      const lastAt = (db.query("SELECT MAX(at) AS at FROM topics_check_samples").get() as { at: number | null }).at;
      const window = readSamples(db, oldestUsed(at, s));
      return { at: lastAt, ...roundState(lastAt === null ? [] : [{ at: lastAt }], at), voices: voices(window, s), cures: summarizeCures(window.at(-1)?.cures) };
    },
  };
}

/** Boot: the first round after a short wait, then every 5 minutes; a failed round never stops the timer. */
export function startTopicsCheck(db: Database, cure?: (sample: Sample, s: TopicsCheckSettings) => CureReport[] | void): TopicsCheckRound {
  const round = createTopicsCheck({ db, cure });
  const safeTick = () => void round.tick().catch((e) => console.warn("[topics-check] round failed:", e instanceof Error ? e.message : e));
  setTimeout(() => {
    safeTick();
    setInterval(safeTick, SAMPLE_INTERVAL_MS).unref?.();
  }, 30_000).unref?.();
  return round;
}
