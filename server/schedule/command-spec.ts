/** What a `command` job may say, checked once at the door and again when it launches (R11, R13). */
import { isAbsolute } from "node:path";
import { ScheduleError } from "../../shared/schedule";
import type { CommandJobAction } from "./store";

/** The time limit written on a job that names none (R13). */
export const DEFAULT_COMMAND_TIMEOUT_SEC = 3600;
const MAX_ARGV_ITEMS = 256;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeCommandAction(input: unknown): CommandJobAction {
  const value = (input ?? {}) as Record<string, unknown>;
  const argv = value.argv;
  if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGV_ITEMS || !argv.every(item => typeof item === "string" && !item.includes("\0")) || !(argv[0] as string).trim()) {
    throw new ScheduleError("A command needs an argv: a non-empty list of strings.");
  }
  const timeoutSec = value.timeoutSec === undefined || value.timeoutSec === null ? DEFAULT_COMMAND_TIMEOUT_SEC : value.timeoutSec;
  if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec) || timeoutSec < 1) throw new ScheduleError("timeoutSec must be a whole number of seconds above 0.");
  if (value.stdin !== undefined && value.stdin !== null && typeof value.stdin !== "string") throw new ScheduleError("stdin must be text.");
  if (value.cwd !== undefined && value.cwd !== null && (typeof value.cwd !== "string" || !isAbsolute(value.cwd))) throw new ScheduleError("cwd must be an absolute path.");
  const env: Record<string, string> = {};
  for (const [name, text] of Object.entries((value.env ?? {}) as Record<string, unknown>)) {
    if (!ENV_NAME.test(name) || typeof text !== "string") throw new ScheduleError(`Invalid environment variable ${name}.`);
    env[name] = text;
  }
  return { kind: "command", argv: argv as string[], stdin: (value.stdin as string | null | undefined) ?? null, cwd: (value.cwd as string | null | undefined) ?? null, env, timeoutSec };
}
