/**
 * live-terminals — ALL live terminals on the Mac, not just Topics' own.
 *
 * WHY IT EXISTS. Topics can read and write its own PTYs (`/api/terminal/
 * sessions/:id/screen|send`, the MCP `session_*` tools), but a `claude`
 * opened by hand in Terminal.app or inside tmux did not exist for Topics: the
 * UI could not see it, no agent could reach it, the phone could not drive it.
 * On 10/15 there were four sessions in Terminal.app and two in tmux, against
 * zero visible.
 *
 * THREE SOURCES, one shape (`LiveTerminal`):
 *  - `topics`   — Topics' PTYs (provided by the caller, the server already has them);
 *  - `tmux`     — every pane of the tmux server (`list-panes -a`): read with
 *                 `capture-pane`, written with `send-keys`;
 *  - `terminal` — every Terminal.app tab, via AppleScript: `contents` for the
 *                 screen, `do script … in tab` for writing.
 *
 * Warp, iTerm and the rest stay out on purpose: Warp has no interface
 * for reading or writing a tab, the others do not run on this Mac.
 *
 * IDENTITY is stable across reads: the tmux pane id (`%8`) and the
 * Terminal tab tty (`ttys004`). A tab index changes when another one
 * closes; the tty does not.
 *
 * EVERYTHING IS ASYNC and has a timeout: the server has a single loop, and a hung
 * osascript must not stall chats. A failing source drops out of the
 * list without taking the others with it.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";

import type { LiveTerminal, LiveTerminalSource } from "../../shared/live-terminals";
import { createChangeLogger } from "./log-on-change";
import { LSOF } from "./system-bins";

export interface LiveScreen {
  id: string;
  text: string;
}

/** Runs external commands: replaceable in tests. */
export type Runner = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export const defaultRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts?.timeoutMs ?? 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // The reason of a failure lives in stderr: the first line of err.message is only the command line.
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout));
    });
  });

// ── tmux ─────────────────────────────────────────────────────────────────────

const TMUX_FORMAT = [
  "#{pane_id}", "#{session_name}", "#{window_index}", "#{pane_index}",
  "#{pane_tty}", "#{pane_current_command}", "#{pane_current_path}", "#{window_name}",
].join("\t");

/** One row per pane of `tmux list-panes -a -F TMUX_FORMAT`. Malformed rows are skipped. */
export function parseTmuxPanes(stdout: string): LiveTerminal[] {
  const out: LiveTerminal[] = [];
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    if (f.length < 8 || !/^%\d+$/.test(f[0])) continue;
    const [paneId, session, win, pane, tty, cmd, cwd] = f;
    out.push({
      id: `tmux:${paneId}`,
      source: "tmux",
      title: `${session}:${win}.${pane}`,
      command: cmd || null,
      cwd: cwd || null,
      tty: tty || null,
      busy: null,
    });
  }
  return out;
}

/**
 * The tmux args pointing at the right server. `TOPICS_TMUX_SOCKET`
 * exists for the test server, which must neither see nor touch the user's real
 * sessions: same boundary as the isolated HOME.
 *
 * `-u` because the production server runs under launchd with no UTF-8 locale:
 * there tmux prints the tabs of TMUX_FORMAT as `_`, every row looked malformed
 * and the list came back without a single pane (10/15).
 */
export function tmuxBase(): string[] {
  const sock = process.env.TOPICS_TMUX_SOCKET;
  return sock ? ["-u", "-S", sock] : ["-u"];
}

// ── Terminal.app ─────────────────────────────────────────────────────────────

// `is running` BEFORE every `tell`: a `tell application "Terminal"` to a
// closed Terminal OPENS it, and a listing that lights up windows on the Mac
// would be worse than no listing.
const TERMINAL_LIST_SCRIPT = `
if application "Terminal" is not running then return ""
set out to ""
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (tty of t) & (character id 9) & (custom title of t) & linefeed
    end repeat
  end repeat
end tell
return out`;

const TERMINAL_READ_SCRIPT = `
on run argv
  if application "Terminal" is not running then return "__missing__"
  tell application "Terminal"
    repeat with w in windows
      repeat with i from 1 to (count tabs of w)
        if tty of tab i of w is (item 1 of argv) then return contents of tab i of w
      end repeat
    end repeat
  end tell
  return "__missing__"
end run`;

// Tabs are indexed (`tab i of w`), not iterated (`repeat with t in tabs`):
// with the loop variable, `contents of t` is the REFERENCE'S CONTENT
// (i.e. "tab 1 of window id …"), not the tab text.
// `do script` in an existing tab types the text into its input and presses Enter.
// There is no no-Enter variant: that is why writing to Terminal
// only accepts text to send, and control keys stay with tmux and Topics.
const TERMINAL_SEND_SCRIPT = `
on run argv
  if application "Terminal" is not running then return "missing"
  tell application "Terminal"
    repeat with w in windows
      repeat with i from 1 to (count tabs of w)
        if tty of tab i of w is (item 1 of argv) then
          do script (item 2 of argv) in tab i of w
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

/** `tty<TAB>title` per line, the TERMINAL_LIST_SCRIPT output. */
export function parseTerminalTabs(stdout: string): Array<{ tty: string; title: string }> {
  const out: Array<{ tty: string; title: string }> = [];
  for (const line of stdout.split("\n")) {
    const [tty, title = ""] = line.split("\t");
    if (!tty || !tty.startsWith("/dev/")) continue;
    out.push({ tty: tty.trim(), title: title.trim() });
  }
  return out;
}

// ── Foreground process per tty ──────────────────────────────────────────

export interface ForegroundProc { pid: number; command: string }

/**
 * The foreground process of each tty, from ONE `ps` call.
 *
 * Foreground is the process group the terminal declares (`tpgid`), and its
 * leader is the process with `pid == tpgid`: it is `claude` even when it has
 * ten `node` children in the same group underneath. Taking "a process with `+`"
 * returned a random child.
 */
export function parseForeground(psOut: string): Map<string, ForegroundProc> {
  const byTty = new Map<string, ForegroundProc>();
  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(-?\d+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, tt, tpgid, comm] = m;
    if (tt === "??" || pid !== tpgid) continue;
    byTty.set(`/dev/tty${tt}`, { pid: Number(pid), command: basename(comm.trim()).replace(/^-/, "") });
  }
  return byTty;
}

/** `lsof -Fpn` → pid → cwd. */
export function parseLsofCwd(out: string): Map<number, string> {
  const res = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) res.set(pid, line.slice(1));
  }
  return res;
}

// ── The service ──────────────────────────────────────────────────────────────

export interface LiveTerminalsDeps {
  /** Topics' PTYs, already in the right shape. */
  topics: () => LiveTerminal[];
  /** Screen and writing for Topics' PTYs: owned by the terminals route. */
  topicsScreen: (sessionId: string) => Promise<string | null>;
  topicsSend: (sessionId: string, data: string) => boolean;
  run?: Runner;
  /** List cache. Short: a list of live things, read only by whoever watches it. */
  ttlMs?: number;
  now?: () => number;
  /** External sources enabled. The test server turns Terminal.app off: the real tabs are not its own. */
  sources?: { tmux?: boolean; terminal?: boolean };
  log?: (msg: string, err?: unknown) => void;
}

export interface LiveTerminalsService {
  list(opts?: { force?: boolean }): Promise<LiveTerminal[]>;
  screen(id: string): Promise<LiveScreen | null>;
  /** `enter` = press Enter after the text. Returns false when the terminal is gone. */
  send(id: string, text: string, opts?: { enter?: boolean }): Promise<boolean>;
}

const TERMINAL_LIST_TIMEOUT_MS = 1500;
const TERMINAL_PAUSE_MS = 60_000;

/**
 * One-line reason of a failed command: the first non-empty stderr line when
 * present, else the first message line unless it is Node's "Command failed:"
 * preamble (which only repeats the command), else nothing.
 */
function terminalFailureReason(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  if (typeof stderr === "string") {
    const line = stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return line;
  }
  const first = String((err as Error)?.message ?? err).split("\n")[0].trim();
  return first.startsWith("Command failed:") ? "" : first;
}

/**
 * `code=… killed=… signal=…` of a failed command, each field only when the
 * error carries a value: an exit code (1) or an errno (ENOENT) is often the
 * only clue, while Bun's ENOENT has no killed/signal at all and printed them
 * as "undefined".
 */
function terminalFailureFacts(err: unknown): string {
  const e = err as { code?: unknown; killed?: unknown; signal?: unknown } | null;
  const facts: string[] = [];
  for (const field of ["code", "killed", "signal"] as const) {
    const value = e?.[field];
    if (value !== undefined && value !== null) facts.push(`${field}=${String(value)}`);
  }
  return facts.join(" ");
}

/** osascript's code for "Not authorized to send Apple events": the Automation permission is denied. */
const NOT_AUTHORIZED_CODE = /\(-1743\)/;

export function createLiveTerminals(deps: LiveTerminalsDeps): LiveTerminalsService {
  const run = deps.run ?? defaultRunner;
  const ttlMs = deps.ttlMs ?? 2000;
  const now = deps.now ?? Date.now;
  const tmuxOn = deps.sources?.tmux ?? true;
  const terminalOn = deps.sources?.terminal ?? process.platform === "darwin";
  const log = deps.log ?? ((m: string, e?: unknown) => console.warn("[live-terminals] " + m, e ?? ""));

  let cache: LiveTerminal[] = [];
  let cachedAt = 0;
  let inflight: Promise<LiveTerminal[]> | null = null;
  // Without the Automation permission osascript hangs until killed: after a
  // failure Terminal.app is skipped for a while, or every list waits for it.
  let terminalPausedUntil = 0;
  // The failure line is printed when it changes, and again after the change
  // logger's heartbeat while the same failure lasts; `null` forgets it, so the
  // same failure after a recovery is news again.
  const logTerminalFailure = createChangeLogger((line) => log(line), now);
  let terminalFailing = false;

  async function scanTmux(): Promise<LiveTerminal[]> {
    if (!tmuxOn) return [];
    try {
      return parseTmuxPanes(await run("tmux", [...tmuxBase(), "list-panes", "-a", "-F", TMUX_FORMAT]));
    } catch (err) {
      // No tmux server running is the normal case, not an error worth logging.
      if (!/no server running|error connecting/i.test(String(err))) log("tmux non risponde", err);
      return [];
    }
  }

  async function scanTerminal(): Promise<LiveTerminal[]> {
    if (!terminalOn || now() < terminalPausedUntil) return [];
    let tabs: Array<{ tty: string; title: string }>;
    try {
      tabs = parseTerminalTabs(await run("osascript", ["-e", TERMINAL_LIST_SCRIPT], { timeoutMs: TERMINAL_LIST_TIMEOUT_MS }));
      // Back to reachable: announce the recovery once.
      if (terminalFailing) {
        terminalFailing = false;
        logTerminalFailure("terminal", null);
        log("Terminal.app di nuovo raggiungibile");
      }
    } catch (err) {
      terminalPausedUntil = now() + TERMINAL_PAUSE_MS;
      terminalFailing = true;
      // One compact line per distinct failure: reason plus exit/kill facts.
      // Never pass the full error object to the log.
      const reason = terminalFailureReason(err);
      // A kill is the timeout and gets the two hypotheses (slow Mac, or the
      // Automation permission pending/denied). An immediate failure says its
      // own reason; -1743 is the one whose cause is certain, so it is named.
      const what = (err as { killed?: unknown })?.killed === true
        ? `osascript ucciso dopo ${TERMINAL_LIST_TIMEOUT_MS} ms (Mac lento, o permesso di Automazione in attesa/negato)`
        : NOT_AUTHORIZED_CODE.test(reason)
          ? "osascript fallito (permesso di Automazione negato)"
          : "osascript fallito";
      const facts = terminalFailureFacts(err);
      logTerminalFailure("terminal", `Terminal.app: ${what}${reason ? ": " + reason : ""}${facts ? " " + facts : ""}`);
      return [];
    }
    return tabs.map((t) => ({
      id: `terminal:${basename(t.tty)}`,
      source: "terminal" as const,
      title: t.title,
      command: null,
      cwd: null,
      tty: t.tty,
      busy: null,
    }));
  }

  /** Foreground program and folder, for sources that do not report them. */
  async function enrich(rows: LiveTerminal[]): Promise<void> {
    const ttys = rows.filter((r) => r.tty);
    if (!ttys.length) return;
    let fg: Map<string, ForegroundProc>;
    try {
      fg = parseForeground(await run("ps", ["-A", "-o", "pid=,tt=,tpgid=,comm="]));
    } catch { return; }
    const pids: number[] = [];
    for (const r of ttys) {
      const p = fg.get(r.tty!);
      if (!p) continue;
      // tmux already gives the command, but as the process title: claude calls
      // itself "2.1.296". `ps -o comm` reports the real name.
      r.command = p.command;
      if (!r.cwd) pids.push(p.pid);
    }
    if (!pids.length) return;
    try {
      const cwds = parseLsofCwd(await run(LSOF, ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]));
      for (const r of ttys) {
        const p = fg.get(r.tty!);
        if (p && !r.cwd) r.cwd = cwds.get(p.pid) ?? null;
      }
    } catch { /* without a folder the row is still useful */ }
  }

  async function scan(): Promise<LiveTerminal[]> {
    const [tmux, terminal] = await Promise.all([scanTmux(), scanTerminal()]);
    const external = [...tmux, ...terminal];
    // A Topics PTY has a tty too: when tmux runs inside, the tmux pane
    // and the Topics session are two doors onto the same thing, and both
    // should show. Terminal tabs can never be Topics ones.
    await enrich(external);
    let topics: LiveTerminal[] = [];
    try { topics = deps.topics(); } catch (err) { log("roster Topics illeggibile", err); }
    return [...topics, ...external];
  }

  async function list(opts?: { force?: boolean }): Promise<LiveTerminal[]> {
    const t = now();
    if (!opts?.force && cachedAt !== 0 && t - cachedAt < ttlMs) return cache;
    // Two concurrent reads (two clients open on the menu) share one scan.
    if (!inflight) {
      inflight = scan()
        .then((rows) => { cache = rows; cachedAt = now(); return rows; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  function parseId(id: string): { source: LiveTerminalSource; key: string } | null {
    const m = id.match(/^(topics|tmux|terminal):(.+)$/);
    if (!m) return null;
    const key = m[2];
    // The key ends up in tmux and osascript arguments: only accept
    // the shape that source produces, so an id cannot become an option.
    if (m[1] === "tmux" && !/^%\d+$/.test(key)) return null;
    if (m[1] === "terminal" && !/^ttys\d+$/.test(key)) return null;
    return { source: m[1] as LiveTerminalSource, key };
  }

  async function screen(id: string): Promise<LiveScreen | null> {
    const p = parseId(id);
    if (!p) return null;
    try {
      if (p.source === "topics") {
        const text = await deps.topicsScreen(p.key);
        return text == null ? null : { id, text };
      }
      if (p.source === "tmux") {
        // `-J` rejoins margin-wrapped lines: a long path stays one line.
        const text = await run("tmux", [...tmuxBase(), "capture-pane", "-p", "-J", "-t", p.key]);
        return { id, text: trimTrailingBlank(text) };
      }
      const text = await run("osascript", ["-e", TERMINAL_READ_SCRIPT, `/dev/${p.key}`]);
      if (text.startsWith("__missing__")) return null;
      return { id, text: trimTrailingBlank(text) };
    } catch {
      return null;
    }
  }

  async function send(id: string, text: string, opts?: { enter?: boolean }): Promise<boolean> {
    const p = parseId(id);
    if (!p) return false;
    const enter = opts?.enter ?? true;
    try {
      if (p.source === "topics") return deps.topicsSend(p.key, enter ? text + "\r" : text);
      if (p.source === "tmux") {
        const base = [...tmuxBase(), "send-keys", "-t", p.key];
        // `-l`: the text arrives LITERAL. Without it, "Enter" or "C-c" typed in a
        // message would become keys. Enter goes in a separate call
        // for the same reason.
        if (text) await run("tmux", [...base, "-l", "--", text]);
        if (enter) await run("tmux", [...base, "Enter"]);
        return true;
      }
      if (!enter) return false;
      const res = await run("osascript", ["-e", TERMINAL_SEND_SCRIPT, `/dev/${p.key}`, text]);
      return res.trim() === "ok";
    } catch {
      // Pane closed meanwhile, tab gone: for the writer that means "gone".
      return false;
    } finally {
      // The screen changed: the next list must not reuse the stale one.
      cachedAt = 0;
    }
  }

  return { list, screen, send };
}

function trimTrailingBlank(text: string): string {
  // AppleScript returns lines with classic-Mac CR.
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}
