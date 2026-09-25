/**
 * WHO A TEST MAY KILL BY PORT (card feb80e11).
 *
 * 25/09: a reviewer ran a spec with `E2E_PORT=${PORT:-13450}` from a session
 * Topics launched, whose environment carries PORT=3333. global-setup killed
 * every listener on that port, that is the production server, and had its
 * first GET succeeded the wipe and the reset would have gone to the real one.
 *
 * Two rules, for every place that kills by port:
 *   - never on the live server's port (`~/.topics/daemon-state.json`), 3333 or
 *     3434, whatever E2E_PORT says: refused before anything is looked up;
 *   - only a listener that IS a test server: `start-test-server` on its command
 *     line, where both launchers put it. Any other is named and left alive, and
 *     the caller stops. Not a DATA_DIR: macOS reads it from `ps -E`, split on
 *     spaces, so any argument spelling `DATA_DIR=` passed for one.
 *
 * A PID saved earlier, the server global-setup spawned, is killed under the
 * same rule (`killSavedTestServer`).
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { IS_WINDOWS, killPids, killProcessTree, listenerPids } from "./platform";

/** The live server's ports on this machine: the app listens on 3333 and 3434. */
export const PRODUCTION_PORTS: readonly number[] = [3333, 3434];

/** Why a test must not touch `port`, or null. */
export function productionPortReason(port: number): string | null {
  const statePath = join(homedir(), ".topics", "daemon-state.json");
  try {
    if (Number(JSON.parse(readFileSync(statePath, "utf8"))?.port) === port) return `${port} is the live Topics server's port (${statePath})`;
  } catch { /* no live server recorded on this machine */ }
  return PRODUCTION_PORTS.includes(port) ? `${port} is a production port (${PRODUCTION_PORTS.join(", ")})` : null;
}

/** Throws before anything is looked up or killed, when `port` belongs to a real server. */
export function refuseProductionPort(port: number): void {
  const reason = productionPortReason(port);
  if (!reason) return;
  throw new Error(
    `[port-guard] E2E_PORT=${port} refused: ${reason}. Nothing was killed. A session Topics launched has ` +
      "PORT=3333 in its environment, so `${PORT:-…}` lands on the live server: set E2E_PORT to a test port by hand.",
  );
}

function commandOf(pid: string): string {
  const quiet = { encoding: "utf-8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
  try {
    return (IS_WINDOWS
      ? execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], quiet)
      : execFileSync("ps", ["-ww", "-o", "command=", "-p", pid], quiet)).trim();
  } catch {
    return "";
  }
}

/** A test server: `--started-by=start-test-server`, the tag both launchers in scripts/ pass to the server. */
export function isTestServer(pid: string): boolean {
  return commandOf(pid).includes("start-test-server");
}

/**
 * The server global-setup spawned (`__TEST_SERVER_PID`), if that PID is still a
 * test server. A spec that restarts the server leaves the saved PID pointing at
 * nothing, and this Mac hands PIDs out again about every two hours: a review
 * probe saw the teardown kill a `sleep` given the old number. The setup drops
 * the variable when its server exits; this covers an exit not seen yet.
 */
export function killSavedTestServer(): void {
  const pid = process.env.__TEST_SERVER_PID;
  const command = pid ? commandOf(pid) : "";
  if (!pid || !command) return;
  if (!command.includes("start-test-server")) {
    console.warn(`[port-guard] PID ${pid} is no longer the test server (${command}), left alive.`);
    return;
  }
  // The whole tree: a process group signal on POSIX, `taskkill /T` on Windows, then the process itself.
  killProcessTree(Number(pid));
  killPids([pid]);
}

/**
 * Kill the test servers listening on `port`, and only them: their PIDs.
 *
 * `onForeign: "throw"` (the default) stops the caller with the others' names.
 * `"warn"` is for the cleanups that must go on (the teardown, the exit
 * handler): the names are printed, the exit code set, nothing thrown.
 */
export function killTestListeners(port: number, opts: { force?: boolean; onForeign?: "throw" | "warn" } = {}): string[] {
  const refuse = (message: string): string[] => {
    if (opts.onForeign !== "warn") throw new Error(message);
    console.warn(message);
    process.exitCode = 1;
    return [];
  };
  const reason = productionPortReason(port);
  if (reason) return refuse(`[port-guard] not killing anything on port ${port}: ${reason}.`);
  const ours: string[] = [];
  const foreign: string[] = [];
  for (const pid of listenerPids(port)) {
    if (isTestServer(pid)) ours.push(pid);
    else foreign.push(`PID ${pid} (${commandOf(pid) || "command unknown"})`);
  }
  killPids(ours, { force: opts.force });
  if (foreign.length) {
    refuse(`[port-guard] port ${port} is held by something that is not a test server, left alive: ${foreign.join(", ")}. Stop it yourself or pick another E2E_PORT.`);
  }
  return ours;
}
