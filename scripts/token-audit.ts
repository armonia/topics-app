import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";

/**
 * `--project` keeps only the chats whose topic lives in that folder (an
 * always-on agent's chats live in its own: `server/agents/registry.ts`), and
 * `--calls` prints the size of each call instead of the per-chat table: the
 * two numbers an agent's compaction ceiling (CHAT-COMPACT-06) is judged by,
 * before and after, with `--since`/`--until` around the restart.
 */
interface Args { since: string; until: string | null; dbPath: string; logPath: string; projects: string[]; calls: boolean }
interface UsageRow {
  session_key: string;
  user_turns: number;
  /** Assistant rows with a measured prompt, and their prompt tokens summed over each turn's calls. */
  measured_turns: number;
  turn_prompt_tokens: number;
  cache_writes: number;
  measured_cache_write_rows: number;
  first_message_at: string | null;
  last_message_at: string | null;
}
interface RoundUsage {
  at: number;
  round: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
interface CompactionEvent { at: number; postTokens: number }
interface ChatLog {
  rounds: RoundUsage[];
  compactions: CompactionEvent[];
  auxiliaryCalls: number;
  timestamps: number[];
}

/** A day (`2026-11-27`, midnight UTC) or an instant (`2026-11-27T20:30:00Z`). */
const WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const instant = (when: string): number => Date.parse(when.length === 10 ? `${when}T00:00:00Z` : when);
/** The same instant in the DB's own format (`2026-11-27T20:30:00.000Z`), so string comparison agrees with the log's. */
const isoOf = (when: string): string => new Date(instant(when)).toISOString();
const expandHome = (p: string): string => resolve(p.replace(/^~(?=\/|$)/, homedir())).replace(/\/+$/, "");

function parseArgs(argv: string[]): Args {
  let since = "1970-01-01";
  let until: string | null = null;
  let dbPath = resolve("data/topics.db");
  let logPath = join(homedir(), ".claude", "jarvis", "logs", "topics-server.log");
  const projects: string[] = [];
  let calls = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--calls") { calls = true; continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--since") since = value;
    else if (flag === "--until") until = value;
    else if (flag === "--db") dbPath = resolve(value);
    else if (flag === "--log") logPath = resolve(value);
    else if (flag === "--project") projects.push(expandHome(value));
    else throw new Error(`Unknown option: ${flag}`);
    i++;
  }
  for (const [name, when] of [["--since", since], ["--until", until]] as const) {
    if (when != null && (!WHEN.test(when) || Number.isNaN(instant(when)))) throw new Error(`Invalid ${name}: ${when}`);
  }
  return { since, until, dbPath, logPath, projects, calls };
}

function chatLog(logs: Map<string, ChatLog>, sessionKey: string): ChatLog {
  let stats = logs.get(sessionKey);
  if (!stats) {
    stats = { rounds: [], compactions: [], auxiliaryCalls: 0, timestamps: [] };
    logs.set(sessionKey, stats);
  }
  return stats;
}

function logTimestamp(line: string): number | null {
  const match = /\bat=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/.exec(line);
  if (!match) return null;
  const timestamp = Date.parse(match[1]!);
  return Number.isNaN(timestamp) ? null : timestamp;
}

async function readLogs(path: string, since: string, until: string | null): Promise<Map<string, ChatLog>> {
  const logs = new Map<string, ChatLog>();
  if (!existsSync(path)) return logs;

  const sinceTime = instant(since);
  const untilTime = until != null ? instant(until) : Number.POSITIVE_INFINITY;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const at = logTimestamp(line);
    if (at == null || at < sinceTime || at >= untilTime) continue;
    const sessionKey = /\bsession_key=([^\s]+)/.exec(line)?.[1];
    if (!sessionKey || sessionKey === "unknown") continue;

    const stats = chatLog(logs, sessionKey);
    stats.timestamps.push(at);

    if (line.includes("[native] round:")) {
      const values = {
        round: /\bround=(\d+)/.exec(line)?.[1],
        input: /\binput=(\d+)/.exec(line)?.[1],
        cacheRead: /\bcache_read=(\d+)/.exec(line)?.[1],
        cacheWrite: /\bcache_write=(\d+)/.exec(line)?.[1],
        output: /\boutput=(\d+)/.exec(line)?.[1],
      };
      if (Object.values(values).some((value) => value == null)) continue;
      stats.rounds.push({
        at,
        round: Number(values.round),
        input: Number(values.input),
        cacheRead: Number(values.cacheRead),
        cacheWrite: Number(values.cacheWrite),
        output: Number(values.output),
      });
      continue;
    }

    if (line.includes("[native] contesto compattato:") || line.includes("[native] prompt troppo lungo")) {
      const postTokens = /\bpost_tokens=(\d+)/.exec(line)?.[1];
      if (postTokens != null) stats.compactions.push({ at, postTokens: Number(postTokens) });
      continue;
    }

    if (line.includes("goal-loop: judge call") || line.includes("[AutoName] AI call")) {
      stats.auxiliaryCalls++;
    }
  }
  return logs;
}

function readDatabase(dbPath: string, since: string, until: string | null): {
  usage: Map<string, UsageRow>;
  names: Map<string, string>;
  projects: Map<string, string>;
  markers: Array<{ session_key: string; created_at: string; post_tokens: number }>;
} {
  const uri = `${pathToFileURL(dbPath).href}?mode=ro`;
  const db = new Database(uri, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT session_key,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_turns,
        SUM(CASE WHEN role = 'assistant' AND usage_prompt_tokens > 0 THEN 1 ELSE 0 END) AS measured_turns,
        COALESCE(SUM(CASE WHEN role = 'assistant' AND usage_prompt_tokens > 0 THEN usage_prompt_tokens END), 0) AS turn_prompt_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_writes,
        COUNT(cache_creation_tokens) AS measured_cache_write_rows,
        MIN(timestamp) AS first_message_at,
        MAX(timestamp) AS last_message_at
      FROM messages
      WHERE timestamp >= ? AND timestamp < ?
      GROUP BY session_key
    `).all(isoOf(since), until != null ? isoOf(until) : "9999") as UsageRow[];
    const topics = db.prepare("SELECT session_key, name, project_path FROM topics").all() as Array<{ session_key: string; name: string; project_path: string | null }>;
    // The compactions the server already stored: the log only names the chat from this change on.
    const markers = db.prepare(
      "SELECT session_key, created_at, post_tokens FROM compaction_markers WHERE created_at >= ? AND created_at < ? AND post_tokens IS NOT NULL",
    ).all(isoOf(since), until != null ? isoOf(until) : "9999") as Array<{ session_key: string; created_at: string; post_tokens: number }>;
    return {
      usage: new Map(rows.map((row) => [row.session_key, row])),
      names: new Map(topics.map((row) => [row.session_key, row.name])),
      projects: new Map(topics.map((row) => [row.session_key, row.project_path ? expandHome(row.project_path) : ""])),
      markers,
    };
  } finally {
    db.close();
  }
}

function numberFromSqlDate(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatRate(log: ChatLog | undefined, usage: UsageRow | undefined): string {
  if (!usage || !log || (log.rounds.length === 0 && log.compactions.length === 0)) return "—";
  if (log.compactions.length === 0) return "0.0";
  const timestamps = [
    ...log.timestamps,
    ...(usage ? [numberFromSqlDate(usage.first_message_at), numberFromSqlDate(usage.last_message_at)] : []),
  ].filter((value): value is number => value != null);
  if (timestamps.length < 2) return "—";
  const hours = (Math.max(...timestamps) - Math.min(...timestamps)) / 3_600_000;
  if (hours <= 0) return "—";
  return (log.compactions.length / hours).toFixed(1);
}

function averageFirstRoundTokens(log: ChatLog | undefined): string {
  const firstRounds = log?.rounds.filter((round) => round.round === 1) ?? [];
  if (firstRounds.length === 0) return "—";
  const total = firstRounds.reduce((sum, round) => sum + round.input + round.cacheRead + round.cacheWrite + round.output, 0);
  return Math.round(total / firstRounds.length).toLocaleString("en-US");
}

function formatCompactionWriteShare(log: ChatLog | undefined, usage: UsageRow | undefined): string {
  if (!log || (log.rounds.length === 0 && log.compactions.length === 0)) return "—";
  if (!usage || usage.measured_cache_write_rows === 0 || usage.cache_writes === 0) return "—";
  const estimatedWrites = log.compactions.reduce((sum, event) => sum + event.postTokens, 0);
  return `${(estimatedWrites / usage.cache_writes * 100).toFixed(1)}%`;
}

function formatAuxiliaryRate(log: ChatLog | undefined, usage: UsageRow | undefined, hasRoundTelemetry: boolean): string {
  if (!usage || usage.user_turns === 0) return "—";
  if (!hasRoundTelemetry && (log?.auxiliaryCalls ?? 0) === 0) return "—";
  return ((log?.auxiliaryCalls ?? 0) / usage.user_turns).toFixed(2);
}

function printTable(
  logs: Map<string, ChatLog>,
  usage: Map<string, UsageRow>,
  names: Map<string, string>,
): void {
  const keys = new Set([...logs.keys(), ...usage.keys()]);
  const rows = [...keys].sort().map((sessionKey) => {
    const log = logs.get(sessionKey);
    const chat = usage.get(sessionKey);
    return [
      sessionKey,
      names.get(sessionKey) ?? "—",
      formatRate(log, chat),
      formatCompactionWriteShare(log, chat),
      averageFirstRoundTokens(log),
      formatAuxiliaryRate(log, chat, (log?.rounds.length ?? 0) > 0),
    ];
  });
  const headers = ["session_key", "chat", "compact/h", "cache_write_compact", "first_round_avg_tokens", "aux_calls/turn"];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)));
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

/** Per call: what each request weighed (input + cache read + cache write), from the log; per turn, from the DB rows. */
function printCalls(logs: Map<string, ChatLog>, usage: Map<string, UsageRow>): void {
  const sizes = [...logs.values()].flatMap((log) => log.rounds.map((r) => r.input + r.cacheRead + r.cacheWrite)).sort((a, b) => a - b);
  const chats = [...logs.values()].filter((log) => log.rounds.length > 0).length;
  const compactions = [...logs.values()].reduce((n, log) => n + log.compactions.length, 0);
  const turns = [...usage.values()].reduce((n, row) => n + row.measured_turns, 0);
  const turnTokens = [...usage.values()].reduce((n, row) => n + row.turn_prompt_tokens, 0);
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const at = (q: number) => sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))] ?? 0;
  const over = (n: number) => sizes.length ? `${Math.round(sizes.filter((s) => s > n).length / sizes.length * 100)}%` : "—";
  console.log(sizes.length === 0 ? "calls=0" : [
    `calls=${sizes.length}`, `chats=${chats}`,
    `mean=${k(sizes.reduce((a, b) => a + b, 0) / sizes.length)}`, `p50=${k(at(0.5))}`, `p90=${k(at(0.9))}`, `max=${k(sizes[sizes.length - 1]!)}`,
    `over_150k=${over(150_000)}`, `over_200k=${over(200_000)}`, `compactions=${compactions}`,
    `db_turns=${turns}`, `db_prompt_per_turn=${turns ? k(turnTokens / turns) : "—"}`,
  ].join(" "));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { usage, names, projects, markers } = readDatabase(args.dbPath, args.since, args.until);
  const logs = await readLogs(args.logPath, args.since, args.until);
  if (args.projects.length > 0) {
    const kept = new Set(args.projects);
    for (const map of [logs, usage] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) if (!kept.has(projects.get(key) ?? "")) map.delete(key);
    }
    for (let i = markers.length - 1; i >= 0; i--) if (!kept.has(projects.get(markers[i]!.session_key) ?? "")) markers.splice(i, 1);
  }
  // A chat with no compaction in the log falls back to the stored markers.
  const fromLog = new Set([...logs].filter(([, stats]) => stats.compactions.length > 0).map(([key]) => key));
  for (const marker of markers) {
    if (fromLog.has(marker.session_key)) continue;
    const at = Date.parse(marker.created_at);
    if (Number.isFinite(at)) chatLog(logs, marker.session_key).compactions.push({ at, postTokens: marker.post_tokens });
  }
  if (args.calls) printCalls(logs, usage);
  else printTable(logs, usage, names);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
