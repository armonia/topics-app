/**
 * HOW THE DETACHED AI-BRIDGE DAEMON IS LAUNCHED, and why it is not one line.
 *
 * The client used to spawn it as
 *
 *     process.execPath  <dir>/../ai-bridge.mjs  --socket …
 *
 * which is right in a checkout (execPath is the Bun that runs the server, and
 * the script is its sibling on disk) and WRONG, in a way that fires back, in the
 * installed app. There the server is a single-file compiled binary: measured on
 * 2026-09-08 with a throwaway `bun build --compile`,
 *
 *     import.meta.dir            = /$bunfs/root
 *     resolve(dir, "../x.mjs")   = /$bunfs/x.mjs      exists: false
 *     process.execPath           = the topics-server binary itself
 *
 * So the argv became "topics-server /$bunfs/ai-bridge.mjs --socket …". A Bun
 * single-file executable ignores argv[1] and runs its OWN embedded entry: the
 * spawn does not fail, it starts A SECOND DETACHED TOPICS SERVER. And it repeats
 * every time a chat turn cannot reach the bridge, up to the spawn cap.
 *
 * The fix keeps ONE implementation of the daemon and picks the way in by asking
 * the disk instead of sniffing the runtime: if the sibling script is really
 * there we run it (checkout); if it is not, we are inside a binary that embeds
 * it, and that binary knows how to be the daemon when it is given the flag (see
 * `server/sidecar-entry.ts`, the compiled sidecar's entry point).
 *
 * No `node`, no `bun` off PATH, no second copy of the daemon: the runtime that
 * runs the bridge is always the one already running the server.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The argv[1] that tells the compiled server binary to be the ai-bridge daemon
 * instead of a server. A flag, not a subcommand, because the daemon reads the
 * rest of the command line itself (`--socket`, `--store-dir`, `--parent-pid`).
 */
export const AI_BRIDGE_DAEMON_FLAG = "--ai-bridge-daemon";

/**
 * The daemon script as it sits in a checkout, next to `server/lib`.
 *
 * runtime-dep-ok: a path, not a command. It is used ONLY when it exists on
 * disk, which is only ever true in a checkout, where the runtime that would
 * read it is already the one running this code.
 */
export const AI_BRIDGE_SCRIPT_REL = "../ai-bridge.mjs";

export interface DaemonLaunchDeps {
  /** Directory of the module asking (defaults to this one). */
  moduleDir?: string;
  /** The runtime currently executing us. */
  execPath?: string;
  /** Injected for the test: does this path exist on the real filesystem? */
  exists?: (path: string) => boolean;
}

/**
 * The command line that starts the detached daemon: always our own executable,
 * never a runtime looked up on PATH.
 */
export function aiBridgeDaemonLaunch(deps: DaemonLaunchDeps = {}): { cmd: string; args: string[] } {
  const moduleDir = deps.moduleDir ?? import.meta.dir;
  const cmd = deps.execPath ?? process.execPath;
  const exists = deps.exists ?? existsSync;
  const script = resolve(moduleDir, AI_BRIDGE_SCRIPT_REL);
  // The script is on disk: this is a checkout, and `cmd` is the Bun running us.
  if (exists(script)) return { cmd, args: [script] };
  // It is not: we are a single-file binary that embedded it. Ask ourselves.
  return { cmd, args: [AI_BRIDGE_DAEMON_FLAG] };
}
