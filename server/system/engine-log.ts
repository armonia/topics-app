/**
 * The tail of the channel engine's logs, for System > Log (T4).
 *
 * Two files sit directly in the engine's home: `engine.log` (one turn error per
 * line, `YYYY-MM-DD HH:MM:SS <prefix> <text>`) and `process.log` (the engine's
 * live output, `<account>: <text>`, no date). This reads the end of each (never
 * the whole) and turns every line into `{ time, level, agent, chat, text }` so the page can
 * filter by agent and level. The files are the only state. Missing files answer
 * `exists: false`, never an error.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "fs";
import { join } from "path";
import { accountToAgent } from "../agents/registry";

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface EngineLogLine {
  /** `YYYY-MM-DD HH:MM:SS` from engine.log; process.log carries no date. */
  time: string | null;
  level: LogLevel;
  agent: string | null;
  chat: string | null;
  text: string;
}

export interface EngineLogTail {
  path: string;
  exists: boolean;
  lines: EngineLogLine[];
}

const TAIL_BYTES = 256 * 1024;
const ENGINE_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+)/;
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

/** What the engine knows, to read a prefix without any name written in the code. */
export interface EngineVocabulary {
  /** Channel names: the keys of `channels` in config.json, or the channels of the turns. */
  channels: Set<string>;
  /** Accounts the engine declares: `agents.*.account` of engine.json, plus `default`. */
  accounts: Set<string>;
}

export interface LogReadOptions {
  agent?: string;
  level?: LogLevel;
  limit?: number;
  /** The channel bridge's chat titles, keyed by chat id (or `chat:thread`). */
  titles?: Record<string, string>;
  /** Channel names read from the turns, used when config.json declares none. */
  turnChannels?: string[];
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function engineVocabulary(home: string, turnChannels: string[] = []): EngineVocabulary {
  const declared = Object.keys((readJsonFile(join(home, "config.json")).channels as Record<string, unknown> | undefined) ?? {});
  const agents = (readJsonFile(join(home, "engine.json")).agents ?? {}) as Record<string, { account?: string }>;
  const accounts = new Set<string>(["default"]);
  for (const def of Object.values(agents)) if (def?.account) accounts.add(def.account);
  return { channels: new Set(declared.length ? declared : turnChannels), accounts };
}

/**
 * Splits a channel prefix on `:`. The first piece that is a channel anchors it:
 * a piece before it is the account (`jarvis:whatsapp:<group>@g.us:`); when the channel
 * comes first, the next piece is the account only if the engine knows it
 * (`discord:visione:2:3`), else it is already the chat (`whatsapp:<group>@g.us:`).
 */
export function parseChannelPrefix(prefix: string, known: EngineVocabulary): { account: string; chat: string } {
  const parts = prefix.split(":").filter((p) => p !== "");
  const at = parts.findIndex((p) => known.channels.has(p));
  if (at < 0) return { account: "", chat: "" };
  let account = "";
  let chatFrom = at + 1;
  if (at > 0) account = parts[at - 1];
  else if (parts[1] && known.accounts.has(parts[1])) {
    account = parts[1];
    chatFrom = 2;
  }
  return { account, chat: parts.slice(chatFrom).join(":") };
}

function chatName(chat: string, titles: Record<string, string>): string | null {
  if (!chat) return null;
  return titles[chat] ?? titles[chat.split(":")[0]] ?? chat;
}

export function parseEngineLine(raw: string, owner: (account: string) => string, jobs: Map<string, string>, known: EngineVocabulary, titles: Record<string, string> = {}): EngineLogLine {
  const m = ENGINE_LINE.exec(raw);
  const prefix = m?.[2] ?? "";
  const time = m?.[1] ?? null;
  const text = m ? raw.slice(m[0].length).trim() : raw;
  let agent: string | null = null;
  let chat: string | null = null;
  if (prefix.startsWith("cli:")) agent = prefix.slice(4) || null;
  else if (prefix.startsWith("cron:")) agent = jobs.get(prefix.slice(5).replace(/:$/, "")) ?? null;
  else if (prefix) {
    const parsed = parseChannelPrefix(prefix, known);
    agent = owner(parsed.account) || null;
    chat = chatName(parsed.chat, titles);
  }
  return { time, level: "error", agent, chat, text };
}

export function parseProcessLine(raw: string, owner: (account: string) => string): EngineLogLine {
  const cut = raw.indexOf(":");
  const account = (cut < 0 ? "" : raw.slice(0, cut)).trim();
  const text = cut < 0 ? raw : raw.slice(cut + 1).trim();
  return { time: null, level: PROCESS_ERROR.test(raw) ? "error" : "info", agent: (account && owner(account)) || null, chat: null, text };
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

/** Last `limit` lines of EACH file that pass the filters, so the live output cannot push the turn errors out. */
export function readEngineLog(home: string, opts: LogReadOptions = {}): EngineLogTail {
  const path = engineLogPath(home);
  const live = processLogPath(home);
  const hasEngine = existsSync(path);
  const hasLive = existsSync(live);
  if (!hasEngine && !hasLive) return { path, exists: false, lines: [] };
  const owner = accountToAgent(home);
  const jobs = jobAgents(home);
  const known = engineVocabulary(home, opts.turnChannels);
  const wanted = opts.level ? LOG_LEVELS.indexOf(opts.level) : LOG_LEVELS.length - 1;
  const limit = opts.limit ?? 200;
  // «error» keeps errors only; any lower level adds the information lines.
  const keep = (lines: EngineLogLine[]) => lines
    .filter((l) => LOG_LEVELS.indexOf(l.level) <= wanted)
    .filter((l) => !opts.agent || l.agent === opts.agent)
    .slice(-limit);
  return {
    path,
    exists: true,
    lines: [
      ...(hasEngine ? keep(tailLines(path).map((l) => parseEngineLine(l, owner, jobs, known, opts.titles))) : []),
      ...(hasLive ? keep(tailLines(live).map((l) => parseProcessLine(l, owner))) : []),
    ],
  };
}
