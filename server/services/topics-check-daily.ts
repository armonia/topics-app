/**
 * The daily self-check (CHECK-04): once a day, at the hour the settings name,
 * the three voices are recomputed over 24 hours and ONE model call reads what
 * the counts cannot: error signatures never seen in the 7 days before, the
 * scheduled jobs that declare no proof with their last outcome, and the stuck
 * cards with the cause the 5-minute round wrote. The verdict is one line; a red
 * one opens an investigation card through the cures (same board, same daily cap).
 *
 * The 5-minute round never waits for this and never depends on it: this runs on
 * its own timer, and an unreachable model only turns the row into "reading not
 * done" with the reason.
 *
 * Nothing here names a machine, a host or an account. Settings live in the same
 * `topicsCheck` JSON as the round's: `dailyHour` (0-23, default 7) and
 * `dailyModel` (default empty: the cheap tier of the provider that answers).
 * The server stores colour + reason codes; the words are the client's, except
 * the one sentence the model writes, in the app's output language.
 */
import type { Database } from "bun:sqlite";
import { getAppSettings } from "./app-settings";
import { tryGetProvider } from "../providers";
import type { CompletionOptions } from "../providers/types";
import {
  CAUSE_TEXT, SAMPLE_INTERVAL_MS, parseSettings, readSamples, runProofs, voices,
  type InvestigationSettings, type Runner, type Sample, type TopicsCheckSettings, type Voice,
} from "./topics-check";

const DAY_MS = 24 * 3_600_000;
const BASELINE_DAYS = 7;
/** What one reading may carry: the model reads a page, not a log. */
const MAX_ITEMS = 20;
const MAX_ERROR_ROWS = 5000;
export const DEFAULT_DAILY_HOUR = 7;
const MODEL_TIMEOUT_MS = 120_000;
/** A reading claimed longer ago than its own deadlines allow was lost to a restart. */
const STALE_MARGIN_MS = 60_000;
const CHECK_EVERY_MS = 10 * 60_000;
/** The cheap tier, named only for the provider that has one (the others answer with their own default). */
const CHEAP_MODEL: Record<string, string> = { "claude-code": "claude-haiku-4-5" };

export interface DailySettings { hour: number; model: string }

/** `reading`: claimed, the call is out. `interrupted`: the server restarted mid-call, a new try follows. */
export type DailyReason = "reading" | "interrupted" | "unreachable" | "unreadable";

export interface DailyVerdict {
  day: string;
  at: number;
  /** `unread`: the model could not be asked or its answer was not a verdict; `reason` says which. */
  color: "green" | "red" | "unread";
  reason: DailyReason | null;
  /** The model's sentence, or the error text of an unreachable model. Free text; everything else is a code. */
  line: string;
  cardId: string | null;
  /** Why a red verdict has no card: the day's cap was reached, or the card could not be created. */
  cardNote: "capped" | "failed" | null;
}

export interface Listed<T> { items: T[]; more: number }

export interface DailyDeps {
  now?: () => number;
  /** One model call: the prompt and the `dailyModel` setting in, the answer out; throws when the model is not reachable. */
  ask?: (prompt: string, modelSetting: string) => Promise<string>;
  /** Opens the investigation card of a red reading. */
  openCard?: (inv: InvestigationSettings, title: string, body: string) => { outcome: "opened" | "capped" | "off"; cardId: string | null };
  settings?: () => { daily: DailySettings; language: string | null; checkRaw: TopicsCheckSettings };
  /** Runs the `daily`-tier proofs. */
  run?: Runner;
}

export function parseDailySettings(raw: string | null | undefined): DailySettings {
  let o: { dailyHour?: unknown; dailyModel?: unknown } = {};
  try { o = raw ? (JSON.parse(raw) as typeof o) ?? {} : {}; } catch { /* defaults */ }
  const hour = typeof o.dailyHour === "number" && Number.isInteger(o.dailyHour) && o.dailyHour >= 0 && o.dailyHour <= 23 ? o.dailyHour : DEFAULT_DAILY_HOUR;
  return { hour, model: typeof o.dailyModel === "string" ? o.dailyModel.trim() : "" };
}

/** The model a provider is asked for: the setting wins, else the provider's cheap tier, else its own default. */
export function modelFor(providerName: string, setting: string): string | undefined {
  return setting || CHEAP_MODEL[providerName];
}

/** The local calendar day of `ms`, as YYYY-MM-DD. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const listed = <T>(all: T[]): Listed<T> => ({ items: all.slice(0, MAX_ITEMS), more: Math.max(0, all.length - MAX_ITEMS) });

/** Text without what changes from one occurrence to the next: paths, ids, ports, durations, sizes, quoted text. */
function normalize(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"'`]+|(?:\/[\w.@~-]+){2,}/g, "<path>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{12,}/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/(["'`]).*?\1/g, "$1$1")
    .replace(/:\d{2,5}\b/g, ":#")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|min|h|[kmg]?i?b)\b/gi, "#")
    .replace(/\d{4,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** One error line as a signature: the fixed title plus the normalized detail, where the real text is. */
export function errorSignature(category: string, title: string, detail: string | null = null): string {
  const head = normalize(title).slice(0, 80);
  const rest = detail ? ` | ${normalize(detail).slice(0, 120)}` : "";
  return `${category}: ${head}${rest}`;
}

/**
 * The signatures of the last 24 hours that do not appear in the 7 days before, with how often they came.
 * `baselineDays` is how much of those 7 days the log really holds (it keeps a fixed number of rows of every
 * level, so a busy server remembers less than a week): the prompt says so when it is short.
 */
export function newErrorSignatures(db: Database, now: number): Listed<{ signature: string; count: number }> & { baselineDays: number } {
  const rows = db.query(
    "SELECT category, title, detail, timestamp FROM activity_log WHERE level = 'error' AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
  ).all(new Date(now - (BASELINE_DAYS + 1) * DAY_MS).toISOString(), MAX_ERROR_ROWS) as { category: string; title: string; detail: string | null; timestamp: string }[];
  const dayStart = now - DAY_MS;
  const before = new Set<string>();
  const today = new Map<string, number>();
  for (const r of rows) {
    const sig = errorSignature(r.category, r.title, r.detail);
    if (Date.parse(r.timestamp) >= dayStart) today.set(sig, (today.get(sig) ?? 0) + 1);
    else before.add(sig);
  }
  const oldest = (db.query("SELECT MIN(timestamp) AS t FROM activity_log").get() as { t: string | null }).t;
  const baselineDays = oldest ? Math.max(0, Math.min(BASELINE_DAYS, Math.floor((dayStart - Date.parse(oldest)) / DAY_MS))) : 0;
  const fresh = [...today].filter(([sig]) => !before.has(sig)).map(([signature, count]) => ({ signature, count })).sort((a, b) => b.count - a.count);
  return { ...listed(fresh), baselineDays };
}

/** Enabled scheduled jobs no declared proof covers, with the outcome of the last run. */
export function jobsWithoutProof(db: Database, proofNames: readonly string[]): Listed<{ name: string; lastStatus: string; lastReason: string | null }> {
  const jobs = db.query(
    `SELECT j.name AS name,
            COALESCE((SELECT r.status FROM scheduled_job_runs r WHERE r.job_id = j.id ORDER BY r.created_at DESC LIMIT 1), 'never ran') AS lastStatus,
            (SELECT r.reason FROM scheduled_job_runs r WHERE r.job_id = j.id ORDER BY r.created_at DESC LIMIT 1) AS lastReason
       FROM scheduled_jobs j WHERE j.enabled = 1 AND j.deleted_at IS NULL ORDER BY j.name`,
  ).all() as { name: string; lastStatus: string; lastReason: string | null }[];
  const proven = new Set(proofNames);
  return listed(jobs.filter((j) => !proven.has(j.name)));
}

/** The cards the last 5-minute sample found stuck, each with the cause it wrote. */
export function stuckWithCause(last: Sample | undefined): Listed<{ id: string; hours: number; cause: string }> {
  return listed((last?.stuck ?? []).map((c) => ({ id: c.id, hours: Math.round(c.hours * 10) / 10, cause: CAUSE_TEXT[c.cause] })));
}

export function buildPrompt(input: {
  voices: Voice[];
  errors: Listed<{ signature: string; count: number }> & { baselineDays?: number };
  jobs: Listed<{ name: string; lastStatus: string; lastReason: string | null }>;
  stuck: Listed<{ id: string; hours: number; cause: string }>;
  language: string | null;
}): string {
  const section = (title: string, l: Listed<unknown> & { lines: string[] }) =>
    `## ${title}\n${l.lines.length ? l.lines.join("\n") : "(none)"}${l.more ? `\n...and ${l.more} more` : ""}`;
  const short = input.errors.baselineDays !== undefined && input.errors.baselineDays < BASELINE_DAYS;
  return [
    "You read the daily health report of a task-board server. Decide if something needs an investigation today.",
    `Answer with ONE line only: GREEN or RED (in English), then a colon and a sentence of at most 25 words written in ${input.language ? `the language with code "${input.language}"` : "English"}.`,
    "RED only for a pattern that costs work (a new error that repeats, a job that fails, cards stuck for one cause); noise is GREEN.",
    "",
    section("Voices over 24 hours", { items: [], more: 0, lines: input.voices.map((v) => `${v.id}: ${v.red ? "red" : "green"}, ${v.detail}${v.cause ? ` (${v.cause})` : ""}`) }),
    section("Error signatures never seen in the 7 days before", { ...input.errors, lines: input.errors.items.map((e) => `${e.count}x ${e.signature}`) }),
    ...(short ? [`Note: the log holds only ${input.errors.baselineDays} full day(s) before the last 24 hours, so "never seen" is relative to that.`] : []),
    section("Scheduled jobs without a proof, last outcome", { ...input.jobs, lines: input.jobs.items.map((j) => `${j.name}: ${j.lastStatus}${j.lastReason ? ` (${j.lastReason})` : ""}`) }),
    section("Stuck cards, with the cause written by the 5-minute round", { ...input.stuck, lines: input.stuck.items.map((c) => `${c.id}: ${c.hours} h, ${c.cause}`) }),
  ].join("\n");
}

/** The model's answer as `GREEN: ...` or `RED: ...`; anything else is not a verdict. */
export function parseVerdict(answer: string): { color: "green" | "red"; line: string } | null {
  const first = answer.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const m = /^(green|red)\b\s*[:-]?\s*(.*)$/i.exec(first);
  if (!m) return null;
  return { color: m[1]!.toLowerCase() as "green" | "red", line: m[2]!.trim().slice(0, 240) };
}

/** The ask of the live server: the provider that is connected, with the model the settings or its cheap tier give. */
export function makeAsk(getProvider: typeof tryGetProvider = tryGetProvider) {
  return async (prompt: string, modelSetting: string): Promise<string> => {
    const provider = getProvider();
    if (!provider?.connected) throw new Error("no model connected");
    const options: CompletionOptions = { timeoutMs: MODEL_TIMEOUT_MS, isolated: true, purpose: "topics-check" };
    const model = modelFor(provider.name, modelSetting);
    if (model) options.model = model;
    const out = await provider.complete([{ role: "user", content: prompt }], options);
    return out.content ?? "";
  };
}

const defaultSettings = () => {
  const raw = getAppSettings().topicsCheck;
  return { daily: parseDailySettings(raw), language: getAppSettings().outputLanguage, checkRaw: parseSettings(raw) };
};

const parseRow = (json: string): DailyVerdict => JSON.parse(json) as DailyVerdict;

/** The newest verdict, for the self-check row. */
export function readLatestVerdict(db: Database): DailyVerdict | null {
  const r = db.query("SELECT verdict_json FROM topics_check_daily ORDER BY day DESC LIMIT 1").get() as { verdict_json: string } | null;
  return r ? parseRow(r.verdict_json) : null;
}

/**
 * Claims today's reading. The row is written before anything slow runs, so two calls the same day make one
 * model call. A row still in flight past its own deadlines was lost to a restart: it is taken over once
 * (compare-and-swap) and marked `interrupted` while the new try runs.
 */
function claim(db: Database, day: string, now: number, staleAfterMs: number): DailyReason | null {
  const row = (reason: DailyReason) => JSON.stringify({ day, at: now, color: "unread", reason, line: "", cardId: null, cardNote: null } satisfies DailyVerdict);
  if (db.query("INSERT OR IGNORE INTO topics_check_daily (day, verdict_json) VALUES (?, ?)").run(day, row("reading")).changes > 0) return "reading";
  const old = db.query("SELECT verdict_json FROM topics_check_daily WHERE day = ?").get(day) as { verdict_json: string } | null;
  const v = old ? parseRow(old.verdict_json) : null;
  const lost = v && v.color === "unread" && (v.reason === "reading" || v.reason === "interrupted") && now - v.at > staleAfterMs;
  if (!lost) return null;
  return db.query("UPDATE topics_check_daily SET verdict_json = ? WHERE day = ? AND verdict_json = ?").run(row("interrupted"), day, old!.verdict_json).changes > 0 ? "interrupted" : null;
}

/** One daily round. Does nothing before the settings' hour, and nothing when the day already has its reading. */
export async function runDaily(db: Database, deps: DailyDeps = {}): Promise<DailyVerdict | null> {
  const now = (deps.now ?? Date.now)();
  const { daily, language, checkRaw } = (deps.settings ?? defaultSettings)();
  if (new Date(now).getHours() < daily.hour) return null;
  const day = dayKey(now);
  const proofTimeoutMs = checkRaw.thresholds.checkTimeoutSec * 1000;
  const state = claim(db, day, now, proofTimeoutMs + MODEL_TIMEOUT_MS + STALE_MARGIN_MS);
  if (!state) return null;

  let verdict: DailyVerdict = { day, at: now, color: "unread", reason: null, line: "", cardId: null, cardNote: null };
  let prompt = "";
  try {
    const samples = readSamples(db, now - DAY_MS - SAMPLE_INTERVAL_MS);
    // The proofs of the daily tier run here (nobody else runs them) and count in the proofs voice of the day.
    const dailyProofs = await runProofs(checkRaw.checks, checkRaw.thresholds.checkTimeoutSec, deps.run, "daily");
    const lastAt = samples.reduce((a, s) => Math.max(a, s.at), 0);
    const last = samples.find((s) => s.at === lastAt);
    const withProofs: Sample[] = [
      ...samples.filter((s) => s !== last),
      { ...(last ?? { at: now, todo: 0, machines: [], stuck: [], moves: [] }), checks: [...(last?.checks ?? []), ...dailyProofs] },
    ];
    const dayVoices = voices(withProofs, { ...checkRaw, thresholds: { ...checkRaw.thresholds, seatsWindowHours: 24 } });
    prompt = buildPrompt({ voices: dayVoices, errors: newErrorSignatures(db, now), jobs: jobsWithoutProof(db, checkRaw.checks.map((c) => c.name)), stuck: stuckWithCause(last), language });
    const parsed = parseVerdict(await (deps.ask ?? makeAsk())(prompt, daily.model));
    verdict = parsed ? { ...verdict, ...parsed } : { ...verdict, reason: "unreadable" };
  } catch (e) {
    verdict = { ...verdict, reason: "unreachable", line: (e instanceof Error ? e.message : String(e)).slice(0, 240) };
  }
  if (verdict.color === "red") {
    try {
      const opened = (deps.openCard ?? (() => ({ outcome: "off" as const, cardId: null })))(checkRaw.investigation, `Topics check: ${verdict.line}`.slice(0, 120), prompt);
      verdict.cardId = opened.cardId;
      if (opened.outcome === "capped") verdict.cardNote = "capped";
    } catch {
      verdict.cardNote = "failed";
    }
  }
  db.query("UPDATE topics_check_daily SET verdict_json = ? WHERE day = ?").run(JSON.stringify(verdict), day);
  return verdict;
}

/**
 * Boot: look every 10 minutes whether today's reading is due; a failure is logged and never reaches the 5-minute
 * round. The caller keeps this off in the e2e server, where a call to a model costs money.
 */
export function startTopicsCheckDaily(db: Database, openCard: DailyDeps["openCard"]): void {
  const safeRun = () => void runDaily(db, { openCard }).catch((e) => console.warn("[topics-check] daily failed:", e instanceof Error ? e.message : e));
  setTimeout(() => {
    safeRun();
    setInterval(safeRun, CHECK_EVERY_MS).unref?.();
  }, 60_000).unref?.();
}
