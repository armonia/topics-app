/**
 * The replica (Litestream) of the live DB around a primary switch (track T4 of
 * `openspec/changes/nodo-principale-a-mano`): how the receiver sees that one
 * watches its DB, and the configured commands that stop and start it around
 * the swap. Replacing the file under a running replica corrupts what it publishes.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Process ids holding `path` open, by `lsof`. None where `lsof` is missing: then only the Litestream folder is looked for. */
function lsofHolders(path: string): number[] {
  if (process.platform === "win32" || !existsSync(path)) return [];
  const r = spawnSync("lsof", ["-t", "--", path], { encoding: "utf-8", timeout: 10_000 });
  if (r.error || typeof r.stdout !== "string") return [];
  return r.stdout.split(/\s+/).filter(Boolean).map(Number).filter((pid) => Number.isInteger(pid));
}

/**
 * Why the live DB looks replicated (a Litestream folder next to it, another
 * process holding it open), or null. Replacing the file under such a process
 * corrupts what it publishes, so the swap needs the replica stop and start commands.
 */
export function replicaWatching(dbPath: string, holdersOf: (path: string) => number[] = lsofHolders): string | null {
  const sidecar = join(dirname(dbPath), `.${basename(dbPath)}-litestream`);
  if (existsSync(sidecar)) return `a Litestream folder (${basename(sidecar)}) sits next to the DB`;
  return heldBy(dbPath, holdersOf);
}

/**
 * Why another process holds the live DB open, or null. Asked again after the
 * replica stop and right before the rename: a stop that only kills a Litestream
 * under a supervisor that restarts it (launchd KeepAlive, systemd Restart=)
 * exits 0 while a new one already holds the file. The Litestream folder is not
 * asked here, a stopped replica leaves it in place.
 */
function heldBy(dbPath: string, holdersOf: (path: string) => number[] = lsofHolders): string | null {
  const pids = holdersOf(dbPath).filter((pid) => pid !== process.pid);
  return pids.length > 0 ? `process ${pids.join(", ")} holds the DB open` : null;
}

export function refuseIfHeld(dbPath: string, holdersOf: ((path: string) => number[]) | undefined, when: string): void {
  const held = heldBy(dbPath, holdersOf);
  if (held) throw new Error(`${held} ${when}: a supervisor may have started the replica again (stop it through the service manager, not with a kill), so the DB is not replaced under it`);
}

export interface ReplicaCommands { stop?: string; start?: string }

/** Instance settings, read from the environment: a command line each, default empty (no replica managed). */
export const REPLICA_STOP_ENV = "TOPICS_REPLICA_STOP_COMMAND";
export const REPLICA_START_ENV = "TOPICS_REPLICA_START_COMMAND";

export function replicaCommandsFromEnv(env: NodeJS.ProcessEnv = process.env): ReplicaCommands {
  return { stop: env[REPLICA_STOP_ENV]?.trim() || undefined, start: env[REPLICA_START_ENV]?.trim() || undefined };
}

/**
 * Runs one configured replica command through the shell (no arguments of ours,
 * so nothing secret is on a command line), logs how it ended and returns why it
 * failed, or null. A command that runs past the timeout counts as failed.
 */
export function runReplicaCommand(what: "stop" | "start", command: string, log: (line: string) => void): string | null {
  const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
  let failure: string | null;
  try {
    // stdio ignored: a replica started in the background must not keep a pipe of ours open.
    const r = spawnSync(shell[0]!, shell.slice(1), { stdio: "ignore", timeout: REPLICA_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
    failure = r.status === 0 && !r.error ? null : (r.error?.message ?? `exit ${r.status}, signal ${r.signal}`);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  log(`[primary] replica ${what} command ${failure ? `failed (${failure})` : "ok"}`);
  return failure;
}

const REPLICA_COMMAND_TIMEOUT_MS = 60_000;
