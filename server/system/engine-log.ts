/**
 * The tail of the channel engine's log, for System > Log (T4).
 *
 * The engine writes one line per event into `<home>/logs/engine.log`. This
 * reads the end of that file (never the whole of it) and turns each line into
 * `{ level, agent, text }` so the page can filter by agent and level. The file
 * is the only state: a reload of the page, or a new server, reads the same
 * lines again. A missing file answers `exists: false`, never an error.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "fs";
import { join } from "path";

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
const LEVEL_WORD = /\b(error|warn(?:ing)?|info|debug)\b/i;
const AGENT_TAG = /\bagent[=:]\s*([\w.-]+)|\[agent:([\w.-]+)\]/i;

export function engineLogPath(home: string): string {
  return join(home, "logs", "engine.log");
}

export function parseLogLine(raw: string): EngineLogLine {
  const word = LEVEL_WORD.exec(raw)?.[1]?.toLowerCase() ?? "info";
  const level: LogLevel = word.startsWith("warn") ? "warn" : (word as LogLevel);
  const tag = AGENT_TAG.exec(raw);
  return { level, agent: tag ? (tag[1] ?? tag[2] ?? null) : null, text: raw };
}

/** Last `limit` lines that pass the filters, oldest first. */
export function readEngineLog(home: string, opts: { agent?: string; level?: LogLevel; limit?: number } = {}): EngineLogTail {
  const path = engineLogPath(home);
  if (!existsSync(path)) return { path, exists: false, lines: [] };
  const fd = openSync(path, "r");
  let text = "";
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
    // A cut at the front leaves half a line: drop it.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
  const wanted = opts.level ? LOG_LEVELS.indexOf(opts.level) : LOG_LEVELS.length - 1;
  const lines = text.split("\n").filter((l) => l.trim()).map(parseLogLine)
    // «error» keeps errors only, «warn» keeps warnings and errors, and so on down to debug.
    .filter((l) => LOG_LEVELS.indexOf(l.level) <= wanted)
    .filter((l) => !opts.agent || l.agent === opts.agent);
  return { path, exists: true, lines: lines.slice(-(opts.limit ?? 200)) };
}
