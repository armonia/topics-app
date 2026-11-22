/**
 * The daily self-check (CHECK-04): once a day, at the hour the settings name,
 * the three voices are recomputed over 24 hours and ONE model call reads what
 * the counts cannot: error signatures never seen in the 7 days before, the
 * scheduled jobs that declare no proof with their last outcome, and the stuck
 * cards with the cause the 5-minute round wrote. The verdict is one line; a red
 * one opens an investigation card.
 *
 * The 5-minute round never waits for this and never depends on it: this runs on
 * its own timer, and an unreachable model only turns the line into "reading
 * not done" with the reason.
 *
 * Nothing here names a machine, a host or an account. Settings live in the same
 * `topicsCheck` JSON as the round's: `dailyHour` (0-23, default 7), `dailyModel`
 * (default: the cheap tier) and `investigationBoard` (project id; empty = no
 * card is opened).
 */
import type { Database } from "bun:sqlite";
import { getAppSettings } from "./app-settings";
import { createTaskService } from "./tasks";
import { tryGetProvider } from "../providers";
import { CAUSE_TEXT, SAMPLE_INTERVAL_MS, parseSettings, readSamples, voices, type Sample, type Voice } from "./topics-check";

const DAY_MS = 24 * 3_600_000;
const BASELINE_DAYS = 7;
/** What one reading may carry: the model reads a page, not a log. */
const MAX_ITEMS = 20;
const MAX_ERROR_ROWS = 5000;
export const DEFAULT_DAILY_HOUR = 7;
export const DEFAULT_DAILY_MODEL = "claude-haiku-4-5";
const MODEL_TIMEOUT_MS = 120_000;
const CHECK_EVERY_MS = 10 * 60_000;

export interface DailySettings { hour: number; model: string; board: string }

export interface DailyVerdict {
  day: string;
  at: number;
  /** `unread`: the model could not be asked or its answer was not a verdict. */
  color: "green" | "red" | "unread";
  /** The one line the Verifica row shows. */
  line: string;
  cardId: string | null;
}

export interface DailyDeps {
  now?: () => number;
  /** One model call: the prompt in, the answer out; throws when the model is not reachable. */
  ask?: (prompt: string, model: string) => Promise<string>;
  /** Opens the investigation card; returns its id. */
  openCard?: (board: string, title: string, body: string, day: string) => string;
  settings?: () => { daily: DailySettings; checkNames: string[]; checkRaw: ReturnType<typeof parseSettings> };
}

export function parseDailySettings(raw: string | null | undefined): DailySettings {
  let o: { dailyHour?: unknown; dailyModel?: unknown; investigationBoard?: unknown } = {};
  try { o = raw ? (JSON.parse(raw) as typeof o) ?? {} : {}; } catch { /* defaults */ }
  const hour = typeof o.dailyHour === "number" && Number.isInteger(o.dailyHour) && o.dailyHour >= 0 && o.dailyHour <= 23 ? o.dailyHour : DEFAULT_DAILY_HOUR;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { hour, model: text(o.dailyModel) || DEFAULT_DAILY_MODEL, board: text(o.investigationBoard) };
}

/** The local calendar day of `ms`, as YYYY-MM-DD. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** An error line without what changes from one occurrence to the next: ids, numbers, quoted text. */
export function errorSignature(category: string, title: string): string {
  const body = title
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{12,}/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/(["'`]).*?\1/g, "$1$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${category}: ${body}`;
}

/** The signatures of the last 24 hours that do not appear in the 7 days before, with how often they came. */
export function newErrorSignatures(db: Database, now: number): { signature: string; count: number }[] {
  const rows = db.query(
    "SELECT category, title, timestamp FROM activity_log WHERE level = 'error' AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
  ).all(new Date(now - (BASELINE_DAYS + 1) * DAY_MS).toISOString(), MAX_ERROR_ROWS) as { category: string; title: string; timestamp: string }[];
  const dayStart = now - DAY_MS;
  const before = new Set<string>();
  const today = new Map<string, number>();
  for (const r of rows) {
    const sig = errorSignature(r.category, r.title);
    if (Date.parse(r.timestamp) >= dayStart) today.set(sig, (today.get(sig) ?? 0) + 1);
    else before.add(sig);
  }
  return [...today].filter(([sig]) => !before.has(sig)).map(([signature, count]) => ({ signature, count })).sort((a, b) => b.count - a.count).slice(0, MAX_ITEMS);
}

/** Enabled scheduled jobs no declared proof covers, with the outcome of the last run. */
export function jobsWithoutProof(db: Database, proofNames: readonly string[]): { name: string; lastStatus: string; lastReason: string | null }[] {
  const jobs = db.query(
    `SELECT j.name AS name,
            COALESCE((SELECT r.status FROM scheduled_job_runs r WHERE r.job_id = j.id ORDER BY r.created_at DESC LIMIT 1), 'never ran') AS lastStatus,
            (SELECT r.reason FROM scheduled_job_runs r WHERE r.job_id = j.id ORDER BY r.created_at DESC LIMIT 1) AS lastReason
       FROM scheduled_jobs j WHERE j.enabled = 1 AND j.deleted_at IS NULL ORDER BY j.name`,
  ).all() as { name: string; lastStatus: string; lastReason: string | null }[];
  const proven = new Set(proofNames);
  return jobs.filter((j) => !proven.has(j.name)).slice(0, MAX_ITEMS);
}

/** The cards the last 5-minute sample found stuck, each with the cause it wrote. */
export function stuckWithCause(last: Sample | undefined): { id: string; hours: number; cause: string }[] {
  return (last?.stuck ?? []).slice(0, MAX_ITEMS).map((c) => ({ id: c.id, hours: Math.round(c.hours * 10) / 10, cause: CAUSE_TEXT[c.cause] }));
}

export function buildPrompt(input: {
  voices: Voice[];
  errors: { signature: string; count: number }[];
  jobs: { name: string; lastStatus: string; lastReason: string | null }[];
  stuck: { id: string; hours: number; cause: string }[];
}): string {
  const section = (title: string, lines: string[]) => `## ${title}\n${lines.length ? lines.join("\n") : "(none)"}`;
  return [
    "You read the daily health report of a task-board server. Decide if something needs an investigation today.",
    "Answer with ONE line only, in Italian, starting with GREEN or RED, then a colon and a sentence of at most 25 words.",
    "RED only for a pattern that costs work (a new error that repeats, a job that fails, cards stuck for one cause); noise is GREEN.",
    "",
    section("Voices over 24 hours", input.voices.map((v) => `${v.id}: ${v.red ? "red" : "green"}, ${v.detail}${v.cause ? ` (${v.cause})` : ""}`)),
    section("Error signatures never seen in the 7 days before", input.errors.map((e) => `${e.count}x ${e.signature}`)),
    section("Scheduled jobs without a proof, last outcome", input.jobs.map((j) => `${j.name}: ${j.lastStatus}${j.lastReason ? ` (${j.lastReason})` : ""}`)),
    section("Stuck cards, with the cause written by the 5-minute round", input.stuck.map((c) => `${c.id}: ${c.hours} h, ${c.cause}`)),
  ].join("\n");
}

/** The model's answer as `GREEN: ...` or `RED: ...`; anything else is not a verdict. */
export function parseVerdict(answer: string): { color: "green" | "red"; line: string } | null {
  const first = answer.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const m = /^(green|red)\b\s*[:-]?\s*(.*)$/i.exec(first);
  if (!m) return null;
  const color = m[1]!.toLowerCase() as "green" | "red";
  return { color, line: m[2]!.trim().slice(0, 240) || (color === "green" ? "nessun problema" : "da indagare") };
}

const defaultAsk = async (prompt: string, model: string): Promise<string> => {
  const provider = tryGetProvider();
  if (!provider?.connected) throw new Error("nessun modello connesso");
  const out = await provider.complete([{ role: "user", content: prompt }], { model, timeoutMs: MODEL_TIMEOUT_MS, isolated: true, purpose: "topics-check" });
  return out.content ?? "";
};

const defaultOpenCard = (db: Database) => (board: string, title: string, body: string, day: string): string =>
  createTaskService(db).create({ projectId: board, text: title, description: body, status: "todo", idempotencyKey: `topics-check-daily:${day}` }).id;

const defaultSettings = () => {
  const raw = getAppSettings().topicsCheck;
  const checkRaw = parseSettings(raw);
  return { daily: parseDailySettings(raw), checkNames: checkRaw.checks.map((c) => c.name), checkRaw };
};

/** The verdict stored for `day`, or null. */
export function readVerdict(db: Database, day: string): DailyVerdict | null {
  const r = db.query("SELECT verdict_json FROM topics_check_daily WHERE day = ?").get(day) as { verdict_json: string } | null;
  return r ? (JSON.parse(r.verdict_json) as DailyVerdict) : null;
}

/** The newest verdict, for the Verifica row. */
export function readLatestVerdict(db: Database): DailyVerdict | null {
  const r = db.query("SELECT verdict_json FROM topics_check_daily ORDER BY day DESC LIMIT 1").get() as { verdict_json: string } | null;
  return r ? (JSON.parse(r.verdict_json) as DailyVerdict) : null;
}

/**
 * One daily round. Does nothing before the settings' hour, and nothing when the
 * day already has its row; the row is claimed before the model is asked, so two
 * calls the same day make one model call.
 */
export async function runDaily(db: Database, deps: DailyDeps = {}): Promise<DailyVerdict | null> {
  const now = (deps.now ?? Date.now)();
  const { daily, checkNames, checkRaw } = (deps.settings ?? defaultSettings)();
  if (new Date(now).getHours() < daily.hour) return null;
  const day = dayKey(now);
  const claimed = db.query("INSERT OR IGNORE INTO topics_check_daily (day, verdict_json) VALUES (?, ?)")
    .run(day, JSON.stringify({ day, at: now, color: "unread", line: "lettura in corso", cardId: null } satisfies DailyVerdict)).changes;
  if (claimed === 0) return null;

  const samples = readSamples(db, now - DAY_MS - SAMPLE_INTERVAL_MS);
  const dayVoices = voices(samples, { ...checkRaw, thresholds: { ...checkRaw.thresholds, seatsWindowHours: 24 } });
  const last = samples.reduce<Sample | undefined>((a, s) => (!a || s.at > a.at ? s : a), undefined);
  const prompt = buildPrompt({ voices: dayVoices, errors: newErrorSignatures(db, now), jobs: jobsWithoutProof(db, checkNames), stuck: stuckWithCause(last) });

  let verdict: DailyVerdict = { day, at: now, color: "unread", line: "", cardId: null };
  try {
    const parsed = parseVerdict(await (deps.ask ?? defaultAsk)(prompt, daily.model));
    verdict = parsed ? { ...verdict, ...parsed } : { ...verdict, line: "lettura non fatta: risposta non leggibile" };
  } catch (e) {
    verdict = { ...verdict, line: `lettura non fatta: ${e instanceof Error ? e.message : String(e)}`.slice(0, 240) };
  }
  if (verdict.color === "red" && daily.board) {
    try { verdict.cardId = (deps.openCard ?? defaultOpenCard(db))(daily.board, `Verifica di Topics: ${verdict.line}`.slice(0, 120), prompt, day); }
    catch (e) { verdict.line += ` (card non aperta: ${e instanceof Error ? e.message : String(e)})`; }
  }
  db.query("UPDATE topics_check_daily SET verdict_json = ? WHERE day = ?").run(JSON.stringify(verdict), day);
  return verdict;
}

/** Boot: look every 10 minutes whether today's reading is due; a failure is logged and never reaches the 5-minute round. */
export function startTopicsCheckDaily(db: Database): void {
  const safeRun = () => void runDaily(db).catch((e) => console.warn("[topics-check] daily failed:", e instanceof Error ? e.message : e));
  setTimeout(() => {
    safeRun();
    setInterval(safeRun, CHECK_EVERY_MS).unref?.();
  }, 60_000).unref?.();
}
