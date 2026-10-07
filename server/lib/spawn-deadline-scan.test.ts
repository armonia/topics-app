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

describe("external processes in the server", () => {
  const files: string[] = [];
  walk(SERVER, files);
  const unbounded: string[] = [];
  const usedAllow = new Set<number>();

  for (const file of files) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (!CALL.test(line)) return;
      const text = callText(lines, i);
      if (/timeout/i.test(text)) return;
      const allowIdx = LONG_LIVED.findIndex((a) => a.file === rel && line.includes(a.snippet));
      if (allowIdx >= 0) { usedAllow.add(allowIdx); return; }
      unbounded.push(`${rel}:${i + 1}  ${t.slice(0, 110)}`);
    });
  }

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
