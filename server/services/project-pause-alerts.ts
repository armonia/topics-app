/**
 * THE OWNER'S OWN CHANNEL, outside the app (project quota limits, USAGE-30).
 *
 * `TOPICS_OWNER_ALERT_COMMAND` names a CLI as a JSON array of argv elements
 * (OUTBOUND-02): the recipient, subject and body never arrive as one shell
 * string, so a quote or a newline in generated text lands as one literal
 * argument, never as a second command. The TEXT (the alert's words) goes on
 * the child's STDIN instead of argv, because it is the one part with no fixed
 * shape. Empty or unset = no process at all, which is this feature's default
 * on a fresh install.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Parses `TOPICS_OWNER_ALERT_COMMAND`: a JSON array of non-empty strings, or `null` (no alert configured). */
export function parseOwnerAlertCommand(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.TOPICS_OWNER_ALERT_COMMAND;
  if (!raw) return null;
  let argv: unknown;
  try { argv = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string" && a)) return null;
  return argv as string[];
}

// launchd's PATH carries neither of these (OUTBOUND-02): an executable named
// without a `/` is looked up here before falling back to PATH itself.
const EXTRA_BIN_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".local", "bin")];

function resolveExecutable(name: string, extraDirs: string[] = EXTRA_BIN_DIRS): string {
  if (name.includes("/")) return name;
  for (const dir of extraDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name; // let the OS try PATH; a missing one surfaces as a spawn error, logged by the caller
}

export interface SendOwnerAlertOptions {
  /** Injected for tests. */
  spawn?: typeof spawnSync;
  resolve?: (name: string) => string;
}

/**
 * Runs the configured command once, with `text` on stdin. Never throws:
 * a failed spawn is a warning, because a pause that cannot be announced
 * must still take effect (fail open belongs to the BRAKE, not the alert).
 */
export function sendOwnerAlert(argv: string[] | null, text: string, opts: SendOwnerAlertOptions = {}): void {
  if (!argv) return;
  const spawn = opts.spawn ?? spawnSync;
  const resolve = opts.resolve ?? resolveExecutable;
  const [name, ...rest] = argv;
  const executable = resolve(name!);
  const result = spawn(executable, rest, { input: text, stdio: ["pipe", "ignore", "pipe"], timeout: 15_000 });
  if (result.error || (result.status !== null && result.status !== 0)) {
    const detail = result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${result.status}`;
    console.warn(`[project-pause-alerts] owner alert failed (${executable}): ${detail}`);
  }
}

export interface AlertTextInput {
  projectName: string;
  points24h: number | null;
  limit: number | null;
  link: string;
}

/** The one line the owner's channel gets, once per pause. */
export function pauseAlertText(i: AlertTextInput): string {
  const points = i.points24h !== null ? i.points24h.toFixed(1) : "?";
  const limit = i.limit !== null ? i.limit : "?";
  return `${i.projectName}: in pausa, ${points} punti sul limite di ${limit} nelle 24 ore. ${i.link}`; // allow-italian: outbound message text, product default language
}
