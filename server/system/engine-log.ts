/**
 * The tail of the channel engine's logs, for System > Log (T4).
 *
 * Two files sit directly in the engine's home: `engine.log` (one turn error per
 * line, `YYYY-MM-DD HH:MM:SS <prefix> <text>`) and `process.log` (the engine's
 * live output, `<account>: <text>`, no date). This reads the end of each (never
 * the whole) and turns every line into `{ level, agent, text }` so the page can
 * filter by agent and level. The files are the only state. Missing files answer
 * `exists: false`, never an error.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "fs";
import { join } from "path";
import { accountToAgent } from "../agents/registry";

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface EngineLogLine {
  level: LogLevel;
  agent: string | null;
  text: string;
}

export interface EngineLogTail {
  path: string;
  exists: boolean;
  lines: EngineLogLine[];
}

const TAIL_BYTES = 256 * 1024;
const ENGINE_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (\S+)/;
const PROCESS_ERROR = /error|failed|non riuscito/i; // allow-italian: the engine's own wording

export function engineLogPath(home: string): string {
  return join(home, "engine.log");
}

export function processLogPath(home: string): string {
  return join(home, "process.log");
}

/** Cron job id -> the agent its `run` names, from `<home>/jobs.json`. */
function jobAgents(home: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const jobs = JSON.parse(readFileSync(join(home, "jobs.json"), "utf8")) as Array<{ id?: string; run?: { kind?: string; agent?: string } }>;
    for (const j of jobs) if (j.id && j.run?.kind === "agent" && j.run.agent) out.set(j.id, j.run.agent);
  } catch { /* no jobs file: those lines carry no agent */ }
  return out;
}

/** The account a channel prefix names: `acct:whatsapp:1@g.us:` and `discord:acct:2:3` carry one, `whatsapp:1@g.us:` does not. */
function prefixAccount(prefix: string): string {
  const parts = prefix.split(":");
  if (parts[0] === "acct") return parts[1] ?? "";
  if (parts[0] === "discord") return parts[1] === "acct" ? (parts[2] ?? "") : (parts[1] ?? "");
  return "";
}

export function parseEngineLine(raw: string, owner: (account: string) => string, jobs: Map<string, string>): EngineLogLine {
  const prefix = ENGINE_LINE.exec(raw)?.[1] ?? "";
  let agent: string | null = null;
  if (prefix.startsWith("cli:")) agent = prefix.slice(4) || null;
  else if (prefix.startsWith("cron:")) agent = jobs.get(prefix.slice(5).replace(/:$/, "")) ?? null;
  else if (prefix) agent = owner(prefixAccount(prefix)) || null;
  return { level: "error", agent, text: raw };
}

export function parseProcessLine(raw: string, owner: (account: string) => string): EngineLogLine {
  const account = raw.split(":", 1)[0].trim();
  return { level: PROCESS_ERROR.test(raw) ? "error" : "info", agent: (account && owner(account)) || null, text: raw };
}

function tailLines(path: string): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const chunk = Buffer.alloc(size - start);
    readSync(fd, chunk, 0, chunk.length, start);
    let text = chunk.toString("utf8");
    // A cut at the front leaves half a line: drop it.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

/** Last `limit` lines that pass the filters: the turn errors first, then the live output. */
export function readEngineLog(home: string, opts: { agent?: string; level?: LogLevel; limit?: number } = {}): EngineLogTail {
  const path = engineLogPath(home);
  const live = processLogPath(home);
  const hasEngine = existsSync(path);
  const hasLive = existsSync(live);
  if (!hasEngine && !hasLive) return { path, exists: false, lines: [] };
  const owner = accountToAgent(home);
  const jobs = jobAgents(home);
  const all = [
    ...(hasEngine ? tailLines(path).map((l) => parseEngineLine(l, owner, jobs)) : []),
    ...(hasLive ? tailLines(live).map((l) => parseProcessLine(l, owner)) : []),
  ];
  const wanted = opts.level ? LOG_LEVELS.indexOf(opts.level) : LOG_LEVELS.length - 1;
  // «error» keeps errors only; any lower level adds the information lines.
  const lines = all
    .filter((l) => LOG_LEVELS.indexOf(l.level) <= wanted)
    .filter((l) => !opts.agent || l.agent === opts.agent);
  return { path, exists: true, lines: lines.slice(-(opts.limit ?? 200)) };
}
