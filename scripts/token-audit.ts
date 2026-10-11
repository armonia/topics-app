import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";

interface Args { since: string; dbPath: string; logPath: string }
interface UsageRow {
  session_key: string;
  user_turns: number;
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

function parseArgs(argv: string[]): Args {
  let since = "1970-01-01";
  let dbPath = resolve("data/topics.db");
  let logPath = join(homedir(), ".claude", "jarvis", "logs", "topics-server.log");
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--since") since = value;
    else if (flag === "--db") dbPath = resolve(value);
    else if (flag === "--log") logPath = resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
    i++;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) {
    throw new Error(`Invalid --since date: ${since}`);
  }
  return { since, dbPath, logPath };
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

async function readLogs(path: string, since: string): Promise<Map<string, ChatLog>> {
  const logs = new Map<string, ChatLog>();
  if (!existsSync(path)) return logs;

  const sinceTime = Date.parse(`${since}T00:00:00Z`);
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const at = logTimestamp(line);
    if (at == null || at < sinceTime) continue;
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

function readDatabase(dbPath: string, since: string): {
  usage: Map<string, UsageRow>;
  names: Map<string, string>;
} {
  const uri = `${pathToFileURL(dbPath).href}?mode=ro`;
  const db = new Database(uri, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT session_key,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_turns,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_writes,
        COUNT(cache_creation_tokens) AS measured_cache_write_rows,
        MIN(timestamp) AS first_message_at,
        MAX(timestamp) AS last_message_at
      FROM messages
      WHERE timestamp >= ?
      GROUP BY session_key
    `).all(since) as UsageRow[];
    const topics = db.prepare("SELECT session_key, name FROM topics").all() as Array<{ session_key: string; name: string }>;
    return {
      usage: new Map(rows.map((row) => [row.session_key, row])),
      names: new Map(topics.map((row) => [row.session_key, row.name])),
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { usage, names } = readDatabase(args.dbPath, args.since);
  const logs = await readLogs(args.logPath, args.since);
  printTable(logs, usage, names);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
