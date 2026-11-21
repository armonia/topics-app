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
import { getAppSettings } from "./app-settings";
import { runBounded } from "../lib/machine-security-env";

export const SAMPLE_INTERVAL_MS = 5 * 60_000;
export const KEEP_SAMPLES_MS = 7 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
/** What one bounce costs, as a stated estimate: a dispatch that went nowhere. */
const BOUNCE_COST_HOURS = 0.25;

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
  /** Wall-clock cap of one proof's command. */
  checkTimeoutSec: number;
}

export interface TopicsCheckSettings { thresholds: Thresholds; checks: CheckSpec[] }

export const DEFAULT_THRESHOLDS: Thresholds = {
  todoStuckHours: 1, progressStuckHours: 2, cardMoves: 4, cardMovesWindowMin: 60,
  totalMoves: 10, seatsWindowHours: 12, seatsRedHours: 1, checkTimeoutSec: 30,
};

/** Reads the JSON setting; anything unreadable or out of range falls back to the default. */
export function parseSettings(raw: string | null | undefined): TopicsCheckSettings {
  let o: { thresholds?: Record<string, unknown>; checks?: unknown } = {};
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
  return { thresholds, checks };
}

export type StuckCause = "person" | "offline" | "seats" | "memory" | "stay-local" | "unknown";
export interface StuckCard { id: string; status: "todo" | "in_progress"; hours: number; cause: StuckCause }
export interface MachineSample { id: string; name: string; online: boolean; slots: number | null; cards: number }
export interface Move { id: string; at: number; to: string }
export interface CheckResult { name: string; ok: boolean; reason: string | null }

export interface Sample {
  at: number;
  todo: number;
  machines: MachineSample[];
  stuck: StuckCard[];
  moves: Move[];
  /** Filled by the round after the proofs ran; `sampleTopics` leaves it out. */
  checks?: CheckResult[];
}

interface CardRow {
  id: string; status: "todo" | "in_progress"; machine_id: string | null; human_ask: string | null;
  stage: string | null; wait_reason: string | null; stay_local: number; last_at: string | null; board_auto: number;
}

/** One reading of the database at `now`. Read-only. */
export function sampleTopics(db: Database, now: number, t: Thresholds = DEFAULT_THRESHOLDS): Sample {
  const rows = db.query(`SELECT t.id, t.status, t.machine_id, t.human_ask, t.stage, t.wait_reason, t.stay_local,
      MAX(t.updated_at, COALESCE(t.in_progress_at, ''), COALESCE((SELECT MAX(c.created_at) FROM task_comments c WHERE c.task_id = t.id), '')) AS last_at,
      EXISTS (SELECT 1 FROM board_settings b WHERE b.project_id = t.project_id AND b.auto_dispatch = 1) AS board_auto
    FROM tasks t WHERE t.status IN ('todo', 'in_progress') AND t.archived = 0`).all() as CardRow[];
  const machineRows = db.query("SELECT id, name, status, slots FROM machines").all() as
    { id: string; name: string; status: string; slots: number | null }[];
  const machines: MachineSample[] = machineRows.map((m) => ({
    id: m.id, name: m.name, online: m.status === "online", slots: m.slots,
    cards: rows.filter((r) => r.machine_id === m.id).length,
  }));
  const byId = new Map(machines.map((m) => [m.id, m]));
  const noSeats = machines.length > 0 && machines.every((m) => !m.online || m.slots === 0);

  const stuck: StuckCard[] = [];
  for (const r of rows) {
    const hours = Math.max(0, (now - (Date.parse(r.last_at ?? "") || now)) / HOUR_MS);
    const waitingOnPerson = !!r.human_ask?.trim() || r.stage === "human_review";
    if (r.status === "todo") {
      // A board that does not dispatch on its own leaves its todo cards where they are on purpose.
      if (!r.board_auto || hours < t.todoStuckHours) continue;
    } else if (hours < t.progressStuckHours) continue;
    const pinned = r.machine_id ? byId.get(r.machine_id) : undefined;
    const cause: StuckCause = waitingOnPerson ? "person"
      : pinned && !pinned.online ? "offline"
      : /memori/i.test(r.wait_reason ?? "") ? "memory"
      : r.stay_local ? "stay-local"
      : noSeats ? "seats" : "unknown";
    stuck.push({ id: r.id, status: r.status, hours, cause });
  }

  const since = new Date(now - 24 * HOUR_MS).toISOString();
  const moves = (db.query("SELECT task_id, content, created_at FROM task_comments WHERE content LIKE 'Spostata %' AND created_at >= ? ORDER BY created_at DESC LIMIT 200").all(since) as
    { task_id: string; content: string; created_at: string }[]).map((c) => ({
    id: c.task_id, at: Date.parse(c.created_at),
    to: /^Spostata su ([^:]+):/.exec(c.content)?.[1] ?? /^Spostata da .+? a ([^:]+):/.exec(c.content)?.[1] ?? "",
  }));
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

const CAUSE_TEXT: Record<StuckCause, string> = {
  person: "in attesa di una persona",
  offline: "la card è fissata a una macchina spenta",
  seats: "nessuna macchina dà posti",
  memory: "il pavimento di memoria tiene ferma la coda",
  "stay-local": "il pin «solo Mac» tiene la card dove non c'è posto",
  unknown: "nessun turno vivo e nessuna domanda aperta",
};

const fmtHours = (h: number) => `${Math.round(h * 10) / 10} h`;
const mostCommon = <T,>(xs: T[]): T | undefined => {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** The three voices from the samples (oldest first or not, the order does not matter). */
export function voices(samples: readonly Sample[], settings: TopicsCheckSettings): Voice[] {
  const { thresholds: t } = settings;
  const last = samples.reduce<Sample | null>((a, s) => (!a || s.at > a.at ? s : a), null);

  // 1. Cards advance: stuck cards, and bounces counted from the "moved to" notes.
  const stuck = last?.stuck ?? [];
  const moves = last?.moves ?? [];
  const perCard = new Map<string, number[]>();
  for (const m of moves) perCard.set(m.id, [...(perCard.get(m.id) ?? []), m.at]);
  const windowMs = t.cardMovesWindowMin * 60_000;
  const bouncing = [...perCard].filter(([, ats]) => ats.some((a) => ats.filter((b) => b >= a && b < a + windowMs).length >= t.cardMoves));
  const stuckHours = stuck.reduce((s, c) => s + c.hours, 0);
  const bounceHours = (bouncing.length > 0 || moves.length >= t.totalMoves) ? moves.length * BOUNCE_COST_HOURS : 0;
  const parts: string[] = [];
  let cause: string | null = null;
  if (stuck.length) {
    parts.push(`${stuck.length} card ferme`);
    cause = CAUSE_TEXT[mostCommon(stuck.map((c) => c.cause))!];
  }
  if (bounceHours > 0) {
    parts.push(`${moves.length} rimbalzi`);
    const toOff = moves.filter((m) => last?.machines.some((x) => !x.online && x.name === m.to)).length;
    cause ??= toOff * 2 > moves.length ? "le card vengono mandate a una macchina spenta" : "le card rimbalzano fra i nodi: segnala «solo Mac»";
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

type Runner = typeof runBounded;

/** Runs the 5-minute proofs, each under the wall-clock cap; a non-zero exit or a timeout is red. */
export async function runProofs(checks: readonly CheckSpec[], timeoutSec: number, run: Runner = runBounded): Promise<CheckResult[]> {
  const shell = process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];
  return Promise.all(checks.filter((c) => c.tier === "5min").map(async (c): Promise<CheckResult> => {
    const r = await run([...shell, c.command], timeoutSec * 1000);
    if (r.timedOut) return { name: c.name, ok: false, reason: `oltre ${timeoutSec} s` };
    if (r.missing) return { name: c.name, ok: false, reason: "comando non avviabile" };
    return r.code === 0 ? { name: c.name, ok: true, reason: null } : { name: c.name, ok: false, reason: `esce con ${r.code}` };
  }));
}

/** The samples of the last 7 days, oldest first. */
export function readSamples(db: Database): Sample[] {
  return (db.query("SELECT sample_json FROM topics_check_samples ORDER BY at").all() as { sample_json: string }[]).map((r) => JSON.parse(r.sample_json) as Sample);
}

export interface TopicsCheckRound {
  /** One round: sample, run the proofs, store, trim. Returns the voices. */
  tick(): Promise<Voice[]>;
  current(): Voice[];
}

export function createTopicsCheck(opts: { db: Database; now?: () => number; settings?: () => TopicsCheckSettings; run?: Runner }): TopicsCheckRound {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const settings = opts.settings ?? (() => parseSettings(getAppSettings().topicsCheck));
  return {
    async tick() {
      const s = settings();
      const at = now();
      const sample: Sample = { ...sampleTopics(db, at, s.thresholds), checks: await runProofs(s.checks, s.thresholds.checkTimeoutSec, opts.run) };
      db.query("INSERT OR REPLACE INTO topics_check_samples (at, sample_json) VALUES (?, ?)").run(at, JSON.stringify(sample));
      db.query("DELETE FROM topics_check_samples WHERE at < ?").run(at - KEEP_SAMPLES_MS);
      return voices(readSamples(db), s);
    },
    current: () => voices(readSamples(db), settings()),
  };
}

/** Boot: the first round after a short wait, then every 5 minutes; a failed round never stops the timer. */
export function startTopicsCheck(db: Database): TopicsCheckRound {
  const round = createTopicsCheck({ db });
  const safeTick = () => void round.tick().catch((e) => console.warn("[topics-check] round failed:", e instanceof Error ? e.message : e));
  setTimeout(() => {
    safeTick();
    setInterval(safeTick, SAMPLE_INTERVAL_MS).unref?.();
  }, 30_000).unref?.();
  return round;
}
