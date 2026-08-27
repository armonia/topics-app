/**
 * WHO ACTUALLY ANSWERS ON THIS LOCALHOST PORT — the check behind the
 * `open_browser_pane` warning (board card f9cf765e).
 *
 * `open-pane` (browser-bridge.ts) happily navigates to whatever URL the agent
 * asks for. When that URL is `localhost:<port>` / `127.0.0.1:<port>` there is
 * a case the agent cannot see from the tool result alone: the port is real and
 * answers, but the process behind it belongs to a DIFFERENT project than the
 * one the calling topic/terminal is working in — a leftover dev server from
 * yesterday's task, or a neighbour project that happens to run on the same
 * port. The agent then drives a browser against the wrong app and reads
 * results that make no sense for the code it is looking at.
 *
 * This module answers ONE question — "whose process is this port, and is that
 * project the caller's own?" — as a pure, injectable resolver so the port→
 * project attribution itself is unit-testable without `lsof` on the test
 * machine. The wiring into open-pane (which fields carry the caller's own
 * project path) lives in browser-bridge.ts; this file never blocks anything,
 * it only classifies.
 *
 * ATTRIBUTION IS BY CWD, not by process tree: unlike the dev-server auto
 * detector in routes/processes.ts (which also has a Claude-PTY subtree to walk
 * and cross-checks it against cwd), here the caller may be a topic with no
 * live PTY at all. The owning process' current working directory is the only
 * signal open-pane can always get, so a `null` cwd (permission denied, pid
 * gone by the time we ask) means "can't tell" — and we never warn on a guess.
 */

/** Who (if anyone) is listening on the port right now. */
export interface PortListener {
  pid: number;
  command: string;
}

/** Injectable seams so the resolver runs off fakes in tests. */
export interface PortOwnerDeps {
  /** Loopback listener on this port, or null if nobody answers. */
  findListener: (port: number) => Promise<PortListener | null>;
  /** Working directory of a live pid, or null when it can't be read. */
  cwdForPid: (pid: number) => Promise<string | null>;
}

export type PortWarning =
  | { kind: "no-response"; port: number }
  | { kind: "foreign-project"; port: number; pid: number; command: string; ownerCwd: string };

/**
 * `localhost:PORT` / `127.0.0.1:PORT` / `[::1]:PORT` with an EXPLICIT port →
 * that port number. Anything else (a real host, no port meaning the default
 * 80/443) → null: this check only concerns dev-server-style local ports.
 */
export function parseLoopbackPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return null;
  if (!parsed.port) return null;
  const port = Number(parsed.port);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** Strip a trailing slash so `/a/b/` and `/a/b` compare equal. */
function norm(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Same project? Either directory containing the other counts as "same": the
 * owner may run from the repo root while the caller's topic is bound to a
 * subdirectory (a client/ workspace), or the reverse.
 */
export function isSameProject(ownerCwd: string, callerProjectPath: string): boolean {
  const a = norm(ownerCwd);
  const b = norm(callerProjectPath);
  if (a === b) return true;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * The one entry point open-pane calls. Returns null when there is nothing to
 * warn about: not a loopback+port URL, the port answers from the caller's own
 * project, or the owner's cwd could not be established (never accuse on a
 * guess). `callerProjectPath` null (topic not bound to a project, or a
 * terminal with no cwd) also short-circuits to null for the same reason.
 */
export async function checkPortOwnership(
  url: string,
  callerProjectPath: string | null,
  deps: PortOwnerDeps,
): Promise<PortWarning | null> {
  const port = parseLoopbackPort(url);
  if (port === null) return null;

  const listener = await deps.findListener(port);
  if (!listener) return { kind: "no-response", port };

  if (!callerProjectPath) return null;
  const ownerCwd = await deps.cwdForPid(listener.pid);
  if (!ownerCwd) return null;
  if (isSameProject(ownerCwd, callerProjectPath)) return null;

  return { kind: "foreign-project", port, pid: listener.pid, command: listener.command, ownerCwd };
}

/** The line the agent reads in the tool result — prominent, not a footnote. */
export function formatPortWarning(w: PortWarning): string {
  if (w.kind === "no-response") {
    return `⚠ Nothing answers on port ${w.port} right now. The page is likely blank or erroring; check that its dev server is running.`;
  }
  return (
    `⚠ Port ${w.port} is served by pid ${w.pid} (${w.command}) from another project ` +
    `(${w.ownerCwd}), not the one this session is working in. You may be looking at ` +
    `the wrong app's dev server.`
  );
}

/**
 * Real deps: one `lsof` for "who listens on this port" (loopback and remote
 * both match — a dev server usually binds `0.0.0.0` or `::`, not strictly
 * `127.0.0.1`), one for the owner's cwd. Both best-effort: `lsof` missing or
 * unreadable just means "can't tell", never a thrown error into open-pane.
 */
export function realPortOwnerDeps(): PortOwnerDeps {
  return {
    findListener: async (port) => {
      try {
        const proc = Bun.spawn(["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const pid = out.match(/^p(\d+)/m)?.[1];
        const command = out.match(/^c(.+)/m)?.[1];
        return pid ? { pid: Number(pid), command: command ?? "" } : null;
      } catch {
        return null;
      }
    },
    cwdForPid: async (pid) => {
      try {
        const proc = Bun.spawn(["/usr/sbin/lsof", "-a", "-d", "cwd", "-Fn", "-p", String(pid)], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const line = out.split("\n").find((l) => l[0] === "n");
        return line ? line.slice(1) : null;
      } catch {
        return null;
      }
    },
  };
}
