/**
 * Every external process the server launches has a deadline, or a written
 * reason for not having one.
 *
 * On 21/09 a `ps` with no deadline froze the server for minutes
 * (`fleet-usage.ts`); T5 hunted for the others of the same kind and found dozens
 * on the path of requests (`/api/git/*`, `lib/git-status`, the process panel's
 * `ps`/`lsof`...). This test does not look for new ones by eye: it walks
 * `server/` and demands that every call to `Bun.spawn`, `Bun.spawnSync`,
 * `spawn`, `spawnSync`, `execFile*`, `execSync` shows a deadline in its own text
 * (`timeout`, `timeoutMs`) or sits in the list below, each with its why. The
 * right deadline for a request path is `spawnBounded` (`lib/bounded-spawn.ts`):
 * not Bun's `timeout:` alone, because a grandchild holding the pipe open makes
 * it useless.
 * @covers GIT-DEADLINE-01
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(ROOT, "server");

/** Calls that have NO deadline by choice. `snippet` is a piece of the call's line. */
const LONG_LIVED: Array<{ file: string; snippet: string; why: string }> = [
  { file: "server/webrtc-bridge.ts", snippet: "spawn(bin, [\"--socket\"", why: "WebRTC bridge daemon: lives as long as the server" },
  { file: "server/providers/muse.ts", snippet: "spawn(bin, args", why: "an agent turn: governed by the turn's abort, not by a fixed deadline" },
  { file: "server/providers/acp.ts", snippet: "spawn(bin", why: "an agent turn (ACP)" },
  { file: "server/providers/codex.ts", snippet: "spawn(bin, args", why: "an agent turn (Codex)" },
  { file: "server/providers/claude-code.ts", snippet: "spawn(resolveCliPath()", why: "an agent turn (CLI)" },
  { file: "server/providers/native/tools.ts", snippet: "spawn(argv[0]!", why: "an agent's command: the caller has its cap and its abort" },
  { file: "server/providers/native/mcp-client.ts", snippet: "spawn(this.command", why: "an MCP server: lives as long as the session" },
  { file: "server/ai-bridge.mjs", snippet: "spawn(cliPath", why: "the AI bridge: a long-lived child by design" },
  { file: "server/lib/ai-bridge-client.ts", snippet: "spawn(", why: "start of the ai-bridge daemon and the session `spawn` method, not a short process" },
  { file: "server/routes/terminal.ts", snippet: "spawn(cmd, [...baseArgs", why: "start of the pty-bridge daemon" },
  { file: "server/browser-chromium-sidecar.ts", snippet: "spawn(engine.executablePath", why: "the browser: lives as long as the pane" },
  { file: "server/services/preview-manager.ts", snippet: "spawn(cmd: string[]", why: "a type declaration, not a call" },
  { file: "server/routes/processes.ts", snippet: "proc = Bun.spawn(argv, { cwd: o.cwd", why: "run_command: the user stops it (Stop), its duration is the command's own" },
  { file: "server/routes/processes.ts", snippet: "const proc = Bun.spawn(argv, {", why: "project script launched from the panel: lives until the user stops it" },
  { file: "server/services/review-checks.ts", snippet: "proc = Bun.spawn(lowPriorityArgv", why: "pre-review checks have their own cap and tree kill (`killCheckTree`)" },
  { file: "server/services/worktree-manager.ts", snippet: "Bun.spawn(installArgv(dir)", why: "`install` of the user's package manager: lasts as long as the network, in the worktree queue" },
  { file: "server/lib/low-priority.ts", snippet: "spawn(cmd, args, { stdio: \"ignore\" })", why: "renice fired and forgotten: nobody waits for its result" },
  { file: "server/lib/fleet-usage.ts", snippet: "Bun.spawn([\"ps\"", why: "deadline in `snapshot()` with Promise.race (21/09)" },
  { file: "server/lib/fleet-usage.ts", snippet: "const proc = spawn();", why: "the injected `ps` above: the deadline is in the same function" },
  { file: "server/lib/listening-ports.ts", snippet: "Bun.spawn(command", why: "deadline in `readProcessProbe` with Promise.race" },
  { file: "server/lib/bounded-capture.ts", snippet: "Bun.spawn(argv", why: "it is the deadline: `captureWithDeadline`" },
  { file: "server/lib/outbound-cli.ts", snippet: "Bun.spawn([opts.file", why: "deadline in `runCli` with Promise.race" },
  { file: "server/services/turn-checkpoints.ts", snippet: "Bun.spawn([\"git\", ...args]", why: "deadline in `runGit` with Promise.race" },
  { file: "server/services/dispatch-capacity.ts", snippet: "Bun.spawn(argv", why: "`vm_stat`/`sysctl` have no children: the 2 s timer kills the only process" },
  { file: "server/services/ci-evidence.ts", snippet: "spawn(bin!, args", why: "`spawnCapped`: cap on the process group" },
  { file: "server/utils/executable.ts", snippet: "spawn(path, [\"--version\"]", why: "probe whose timer settles the promise without waiting for the streams" },
  { file: "server/lib/stt.ts", snippet: "Bun.spawn([cfg.ffmpegBin", why: "Bun's `timeout:` (a single process, no children)" },
  { file: "server/providers/native/image-normalize.ts", snippet: "promisify(execFile)", why: "declaration; the `sips` call has `timeout`" },
  { file: "server/integrations/chrome-cookies.ts", snippet: "promisify(execFile)", why: "declaration; the calls have `timeout`" },
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "migrations") continue;
    if (name === "bounded-spawn.ts") continue; // it IS the deadline
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(name) && !/\.(test|fixture|harness)\.ts$/.test(name)) out.push(p);
  }
}

const CALL = /(Bun\.spawnSync\(|Bun\.spawn\(|(?<![\w.])spawnSync\(|(?<![\w.])execFileSync\(|(?<![\w.])execSync\(|(?<![\w.])execFile\(|(?<![\w.])spawn\(|promisify\(execFile\)|promisify\(exec\))/;

/**
 * The code of a source file with comments blanked and string contents emptied,
 * keeping every newline (so line numbers still match). What is left is what the
 * compiler sees: a word in a comment, in a string, or in a variable name outside
 * the call cannot be mistaken for the call's deadline.
 */
function lastSignificant(text: string): string {
  for (let k = text.length - 1; k >= 0; k--) if (!/\s/.test(text[k]!)) return text[k]!;
  return "";
}

export function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2;
    } else if (c === "/" && /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant(out) || "(")) {
      // A regex literal (a quote inside it must not open a string). It follows an
      // operator or an opening bracket; after a name or `)` a slash is a division.
      out += "/";
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n" && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        i++;
      }
      out += "/";
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n" && c !== "`") break;
        if (src[i] === "\n") out += "\n";
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The text of the call: from the line that opens it to the parenthesis that closes it (40 lines at most). */
function callText(lines: string[], i: number): string {
  let depth = 0;
  let started = false;
  const parts: string[] = [];
  for (let j = i; j < Math.min(lines.length, i + 40); j++) {
    const line = lines[j]!;
    parts.push(line);
    const from = j === i ? line.search(CALL) : 0;
    for (const ch of line.slice(Math.max(from, 0))) {
      if (ch === "(") { depth++; started = true; }
      else if (ch === ")") depth--;
    }
    if (started && depth <= 0) break;
  }
  return parts.join("\n");
}

/** A deadline among the call's own options: `timeout:` / `timeoutMs:` as an object key (or shorthand). */
const DEADLINE_OPTION = /[{,\s](timeoutMs|timeout)\s*[:,}]/;

/** 0-based line numbers of the calls whose own options carry no deadline. */
export function callsWithoutDeadline(source: string): number[] {
  const lines = codeOnly(source).split("\n");
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (!CALL.test(line)) return;
    if (!DEADLINE_OPTION.test(callText(lines, i))) found.push(i);
  });
  return found;
}

describe("external processes in the server", () => {
  const files: string[] = [];
  walk(SERVER, files);
  const unbounded: string[] = [];
  const usedAllow = new Set<number>();

  for (const file of files) {
    const rel = relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    for (const i of callsWithoutDeadline(source)) {
      const line = lines[i]!;
      const allowIdx = LONG_LIVED.findIndex((a) => a.file === rel && line.includes(a.snippet));
      if (allowIdx >= 0) { usedAllow.add(allowIdx); continue; }
      unbounded.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
    }
  }

  it("the scan still sees the calls (a blind matcher would pass everything)", () => {
    let seen = 0;
    for (const file of files) for (const line of codeOnly(readFileSync(file, "utf8")).split("\n")) if (CALL.test(line)) seen++;
    expect(seen).toBeGreaterThan(40);
  });

  it("no call without a deadline and outside the list", () => {
    expect(unbounded).toEqual([]);
  });

  it("the list does not rot: every entry matches a call that exists", () => {
    const stale = LONG_LIVED.filter((_, i) => !usedAllow.has(i)).map((a) => `${a.file}: ${a.snippet}`);
    // Entries the first test did not have to use because the call already has `timeout` in its
    // text are not rotten: only the file's existence and the snippet are checked.
    const missing = stale.filter((s) => {
      const [file, ...rest] = s.split(": ");
      const src = readFileSync(join(ROOT, file!), "utf8");
      return !src.includes(rest.join(": "));
    });
    expect(missing).toEqual([]);
  });
});

describe("the scan reads the call's own options, not the words around it", () => {
  it("a call with a deadline option passes", () => {
    expect(callsWithoutDeadline('Bun.spawn(["ls"], { timeoutMs: 5000 });')).toEqual([]);
    expect(callsWithoutDeadline('execFileSync("ps", [], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });')).toEqual([]);
    expect(callsWithoutDeadline('Bun.spawnSync(["ps"], {\n  stdout: "pipe",\n  timeout: 5000,\n});')).toEqual([]);
    expect(callsWithoutDeadline('spawn("x", [], { stdio: "ignore", timeout })')).toEqual([]);
  });

  it("a call with no deadline next to a comment that says timeout is flagged", () => {
    expect(callsWithoutDeadline('// timeout: 5000 is handled elsewhere\nBun.spawn(["ls"]);')).toEqual([1]);
    expect(callsWithoutDeadline('Bun.spawn(["ls"], {\n  // timeout: the caller aborts\n  stdout: "pipe",\n});')).toEqual([0]);
    expect(callsWithoutDeadline('/* timeoutMs: 5 */ Bun.spawn(["ls"]);')).toEqual([0]);
  });

  it("a variable or string that mentions timeout is not a deadline", () => {
    expect(callsWithoutDeadline('const timeoutMs = 5000;\nBun.spawn(["ls"], opts);')).toEqual([1]);
    expect(callsWithoutDeadline('Bun.spawn(["sh", "-c", "run --timeout: 5"]);')).toEqual([0]);
    expect(callsWithoutDeadline('Bun.spawn(["ls"], { env: { TIMEOUT: "timeout: 1" } });')).toEqual([0]);
  });

  it("a regex literal with a quote in it does not swallow the code after it", () => {
    expect(callsWithoutDeadline("const R = /^'x/; Bun.spawn([\"ls\"]);")).toEqual([0]);
  });

  it("comment markers inside strings do not hide the code after them", () => {
    expect(callsWithoutDeadline('const u = "http://x"; Bun.spawn(["ls"]);')).toEqual([0]);
  });
});
