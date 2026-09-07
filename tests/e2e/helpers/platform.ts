/**
 * The three POSIX tools the E2E harness leans on, and what answers instead on
 * Windows.
 *
 * WHY THIS FILE EXISTS. The bench was born on macOS and grew on a Linux runner,
 * so `lsof`, `ps ax` and `kill -PID` are written inline all over global-setup,
 * global-teardown and server-death. None of the three exists on Windows, and a
 * missing binary there does not fail loudly: `execSync` throws, the surrounding
 * `try {} catch {}` swallows it, and the harness carries on believing the port
 * is free and the browsers are reaped. That is worse than an error, because the
 * next red is blamed on the product.
 *
 * WHAT IT GUARANTEES. On POSIX every function below runs exactly the command
 * that was inline before, so the macOS and Linux behaviour is unchanged. On
 * Windows each one has a real implementation, never a silent no-op, and where a
 * capability genuinely does not exist it SAYS so instead of pretending.
 *
 * THE LOCALE TRAP, paid for on this machine. `netstat -ano` prints the socket
 * state in the system language ("IN ASCOLTO" on an Italian Windows), so parsing
 * the word LISTENING finds nothing on half the machines in the world. The shape
 * that IS locale independent: a listening TCP row has `0.0.0.0:0` as its remote
 * address. That is what the parser below keys on.
 */
import { execFileSync, execSync } from "child_process";

export const IS_WINDOWS = process.platform === "win32";

/** One row of the process table, in the only three fields the bench uses. */
export interface ProcessRow {
  pid: string;
  ppid: string;
  command: string;
}

/**
 * Who is LISTENING on `port` right now.
 *
 * `-sTCP:LISTEN` on the POSIX side is not decoration: without it `lsof -ti`
 * also lists the sockets that merely have this port as their REMOTE end, i.e.
 * the clients. Killing those takes the test's own browsers down with the
 * server, and the failure then surfaces somewhere else as a flake.
 */
export function listenerPids(port: number): string[] {
  if (IS_WINDOWS) {
    try {
      const rows = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pids = new Set<string>();
      for (const row of rows.split("\n")) {
        const cols = row.trim().split(/\s+/);
        // proto local remote state pid
        if (cols.length < 5) continue;
        if (!cols[1].endsWith(`:${port}`)) continue;
        if (cols[2] !== "0.0.0.0:0" && cols[2] !== "[::]:0") continue;
        if (/^\d+$/.test(cols[4])) pids.add(cols[4]);
      }
      return [...pids];
    } catch {
      return [];
    }
  }
  try {
    return execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null || true`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill these PIDs, politely by default.
 *
 * Windows has no signals: `taskkill` without `/F` posts a WM_CLOSE, which is
 * the closest thing to SIGTERM, and with `/F` it is SIGKILL. A PID that is
 * already gone is not an error here, on either platform.
 */
export function killPids(pids: Array<string | number>, opts: { force?: boolean } = {}): void {
  const list = pids.map(String).filter((p) => /^\d+$/.test(p));
  if (!list.length) return;
  if (IS_WINDOWS) {
    // ALWAYS `/F` here, and it is not impatience. Plain `taskkill` posts a
    // WM_CLOSE, which only a process with a message loop answers: a console
    // program like the test server ignores it entirely. Measured on the first
    // Windows run: the polite kill reported success, nobody died, and the
    // teardown then sat in `waitForServersGone` for its whole ten seconds
    // before killing hard anyway. The polite step exists to let a server flush;
    // on this platform it flushes nothing and only buys the wait.
    for (const pid of list) {
      try {
        execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    execSync(`kill ${opts.force ? "-9 " : ""}${list.join(" ")} 2>/dev/null || true`);
  } catch {
    /* already gone */
  }
}

/**
 * Kill a process AND everything it spawned.
 *
 * On POSIX the bench relies on the server being spawned `detached`, which makes
 * it the leader of its own process group, so a negative PID reaches the whole
 * tree in one signal. Windows has no process groups of that kind: `taskkill /T`
 * walks the parent chain instead, which is why the tree is named here rather
 * than open-coded at the call sites.
 */
export function killProcessTree(pid: number, opts: { force?: boolean } = {}): void {
  if (IS_WINDOWS) {
    try {
      // `/F` always, for the reason spelled out in `killPids`.
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
      });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, opts.force ? "SIGKILL" : "SIGTERM");
  } catch {
    /* already gone */
  }
}

/**
 * The process table: pid, parent pid, command line.
 *
 * On Windows this is one CIM query, and it costs about a second: the callers
 * are the teardown and the emergency cleanup, which run once per suite, so the
 * price is paid where nobody is waiting on it. `Get-CimInstance` and not
 * `wmic`, which Microsoft has been removing since Windows 11 24H2.
 */
export function processRows(): ProcessRow[] {
  if (IS_WINDOWS) {
    try {
      const json = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 },
      );
      const parsed = JSON.parse(json || "[]");
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((row) => ({
        pid: String(row.ProcessId ?? ""),
        ppid: String(row.ParentProcessId ?? ""),
        command: String(row.CommandLine ?? ""),
      }));
    } catch {
      return [];
    }
  }
  try {
    return execSync("ps ax -o pid=,ppid=,command= 2>/dev/null || true")
      .toString()
      .split("\n")
      .map((row) => {
        const trimmed = row.trim();
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
        return match ? { pid: match[1], ppid: match[2], command: match[3] } : null;
      })
      .filter((row): row is ProcessRow => row !== null);
  } catch {
    return [];
  }
}

/** Is this PID still alive? `process.kill(pid, 0)` answers on both platforms. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every Chromium the bench's cleanup considers fair game, machine-wide.
 *
 * It lives here because BOTH the emergency cleanup in global-setup and the
 * teardown reap with it, and until now each carried its own copy of the rule
 * with a comment saying it had to stay identical to the other. The rule itself
 * is unchanged: a command line naming ms-playwright or mcp-chrome that also
 * names chromium or chrome. Who is OURS among them is decided by the caller
 * (`descendantsOf`), not here.
 */
export function playwrightChromiumPids(): string[] {
  return processRows()
    .filter(
      (row) => /ms-playwright|mcp-chrome/.test(row.command) && /chromium|chrome/i.test(row.command),
    )
    .map((row) => row.pid)
    .filter((pid) => /^\d+$/.test(pid));
}
