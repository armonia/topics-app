/**
 * Which process answers on the PTY bridge socket, and since when, read from the
 * operating system instead of from the bridge.
 *
 * WHY THE BRIDGE'S OWN WORD IS NOT ENOUGH. A bridge says what it is in its
 * `pong` only since 15/10/2026, and a bridge outlives every server restart by
 * design (it holds the live terminals), so the one a server reuses can be much
 * older than the code on disk. Measured on 16/10: a Node bridge started on 7/10
 * answered without the field, and the Performance panel said "not identified"
 * under a Rust switch that, as far as the reader could tell, had done nothing.
 * Its age was nowhere either, and the age is what says why: the switch, and two
 * bridge changes since, wait for that process to stop.
 */
import { basename } from "node:path";

import type { PtyBridgeReason } from "../../shared/pty-bridge";
import { defaultRunner, LSOF, type Runner } from "./live-terminals";

export type BridgeImplementation = "rust" | "node" | "unknown";

/** The bridge in use, as the server knows it: what it is, why, and since when. */
export interface ActiveBridge {
  implementation: BridgeImplementation;
  reason: PtyBridgeReason;
  path: string | null;
  /** The process holding the socket, and since when: see `identifyBridgeProcess`. */
  pid: number | null;
  startedAt: string | null;
}

export interface PtyBridgeRuntimeStatus extends ActiveBridge {
  connected: boolean;
}

export interface BridgeProcessInfo {
  pid: number;
  implementation: BridgeImplementation;
  /** ISO time the process started, to the second. */
  startedAt: string;
}

/** `ps -o etime=` is `[[dd-]hh:]mm:ss`. Milliseconds, or null for anything else. */
export function parseElapsed(elapsedText: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(elapsedText.trim());
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

/**
 * The bridge a process is, from its executable and its command line. The Rust
 * bridge is its own binary (`pty-bridge`, `pty-bridge-<target>`); the Node one is
 * a runtime running `pty-bridge.mjs`. The socket path alone proves nothing: it
 * is called `topics-pty-bridge-*.sock` for both.
 */
export function bridgeImplementationFromProcess(executable: string, command: string): BridgeImplementation {
  if (/^pty-bridge/.test(basename(executable.trim()))) return "rust";
  if (/pty-bridge\.mjs(\s|$)/.test(command)) return "node";
  return "unknown";
}

/**
 * Asks `lsof` who holds the socket and `ps` what it is and since when. Null
 * where those tools do not apply (Windows, where the bridge is a named pipe) or
 * have nothing to say; never throws, because a status line is not worth a
 * failed connection.
 */
export async function identifyBridgeProcess(
  socketPath: string,
  opts: { run?: Runner; selfPid?: number; now?: () => number; platform?: NodeJS.Platform } = {},
): Promise<BridgeProcessInfo | null> {
  const run = opts.run ?? defaultRunner;
  const selfPid = opts.selfPid ?? process.pid;
  if ((opts.platform ?? process.platform) === "win32") return null;
  try {
    const pids = (await run(LSOF, ["-t", socketPath], { timeoutMs: 3000 }))
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== selfPid);
    const pid = pids[0];
    if (!pid) return null;
    const opt = { timeoutMs: 3000 };
    const elapsedText = (await run("ps", ["-p", String(pid), "-o", "etime="], opt)).trim();
    const executable = (await run("ps", ["-p", String(pid), "-o", "comm="], opt)).trim();
    const command = (await run("ps", ["-p", String(pid), "-o", "command="], opt)).trim();
    const elapsed = parseElapsed(elapsedText);
    if (elapsed === null) return null;
    const now = opts.now ?? Date.now;
    return {
      pid,
      implementation: bridgeImplementationFromProcess(executable, command),
      startedAt: new Date(Math.floor((now() - elapsed) / 1000) * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * What the OS said, laid over what the bridge said. The `pong` stays the
 * authority when it speaks: the process only fills an "unknown".
 */
export function withBridgeProcess(active: ActiveBridge, info: BridgeProcessInfo): ActiveBridge {
  return {
    ...active,
    implementation: active.implementation === "unknown" ? info.implementation : active.implementation,
    pid: info.pid,
    startedAt: info.startedAt,
  };
}
