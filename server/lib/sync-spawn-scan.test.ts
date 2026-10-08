/**
 * EVERY SYNCHRONOUS SPAWN LEFT IN THE SERVER, WITH ITS REASON.
 *
 * A `spawnSync` / `execSync` / `execFileSync` stops the single event loop for
 * as long as the child lives: streams, WebSockets and every other request wait
 * with it. T5 gave each one a deadline (`spawn-deadline-scan.test.ts`); this
 * scan says WHERE they may still be, so that none comes back on a periodic or
 * per-request path. Each entry names the call and why it is not on such a path.
 * A new call, or an entry whose call is gone, turns it red.
 *
 * Lines that are comments (`//`, `*`, `/*`) are skipped: several files explain
 * in prose the `spawnSync` they no longer run.
 *
 * @covers LOOP-SPAWN-01
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(ROOT, "server");

const SYNC_CALL = /(?<![\w])(Bun\.spawnSync|spawnSync|execSync|execFileSync)\(/;

const ALLOWED: Array<{ file: string; snippet: string; why: string }> = [
  { file: "server/routes/processes.ts", snippet: `Bun.spawnSync(["ps", "-o", "lstart="`, why: "pidStartTime: the identity stamp of a re-adopted row at boot, and of a row at its launch, which must be on disk before the launch answers (a server that exits right after a launch must still re-adopt it: CMDRUN-03). Never on a timer." },
  { file: "server/utils/path-env.ts", snippet: "execFileSync(shell", why: "the login shell's PATH, read once at boot" },
  { file: "server/lib/nome-installazione.ts", snippet: "execFileSync(\"/usr/sbin/scutil\"", why: "the computer name, memoized after the first read" },
  { file: "server/services/discord-ipc.ts", snippet: "execFileSync(\"/usr/bin/getconf\"", why: "the per-user temp dir, macOS only, remembered after the first good read (the presence asks on every connect attempt, every 30 s while Discord is closed)" },
  { file: "server/services/browser-orphan-reap.ts", snippet: "Bun.spawnSync([\"ps\"", why: "the orphan browser sweep, at boot only (reapOrphanBrowsersAtBoot)" },
  { file: "server/browser-chromium-sidecar.ts", snippet: "execFileSync(\"ps\"", why: "the profile's stale browsers, once per sidecar launch" },
  { file: "server/browser-chromium-sidecar.ts", snippet: "execFileSync(\"lsof\"", why: "who owns the CDP port, once per sidecar launch" },
  { file: "server/lib/port-squatter.ts", snippet: "spawnSync(\"/usr/sbin/lsof\"", why: "who holds the server's own port, at boot when it is taken" },
  { file: "server/webrtc-bridge.ts", snippet: "spawnSync(\"pkill\"", why: "the orphan bridge reaped before its replacement is spawned, once per bridge start (must finish first, see the comment there)" },
  { file: "server/services/dispatch-capacity.ts", snippet: "spawnSync(VM_STAT_BIN", why: "macOS only, and only when the async 10 s sample of mem-signal.ts is missing (first beat, a failed probe)" },
  { file: "server/lib/native-parity.ts", snippet: "spawnSync(\"git\", [\"-C\", cwd, \"rev-parse\"", why: "KNOWN DEBT, like the Keychain read below: the git common dir of the turn's folder, to find Claude Code's memory index (claudeMemoryDir), 1 s timeout, once per native turn's context (context/assemble.ts is synchronous)" },
  { file: "server/pty-bridge-platform.mjs", snippet: "execFileSync('/bin/launchctl', ['managername']", why: "the launchd session of a bridge (guiSessionName), in the PTY and AI bridge processes, not the server's loop: once per pong, 2 s timeout" },
  { file: "server/providers/native/auth.ts", snippet: "spawnSync(cmd, args", why: "KNOWN DEBT (T9 REPORT, «Trovato e non fatto»): the Keychain read, macOS only, once per native turn and per providers snapshot; making it async changes the credential chain of the native provider" },
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "migrations") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(name) && !/\.(test|fixture|harness)\.ts$/.test(name)) out.push(p);
  }
}

/** `file:line  text` of every synchronous spawn call that is not on a comment line. */
function syncSpawnCalls(rel: string, source: string): Array<{ where: string; text: string }> {
  const found: Array<{ where: string; text: string }> = [];
  source.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (SYNC_CALL.test(line)) found.push({ where: `${rel}:${i + 1}`, text: t });
  });
  return found;
}

describe("synchronous spawns in the server", () => {
  const files: string[] = [];
  walk(SERVER, files);
  const calls = files.flatMap((f) => syncSpawnCalls(relative(ROOT, f), readFileSync(f, "utf8")));

  test("each one is listed with its reason", () => {
    const unlisted = calls.filter((c) => !ALLOWED.some((a) => c.where.startsWith(`${a.file}:`) && c.text.includes(a.snippet)));
    expect(unlisted.map((c) => `${c.where}  ${c.text}`)).toEqual([]);
  });

  test("no entry outlives its call", () => {
    const stale = ALLOWED.filter((a) => !calls.some((c) => c.where.startsWith(`${a.file}:`) && c.text.includes(a.snippet)));
    expect(stale.map((a) => `${a.file}  ${a.snippet}`)).toEqual([]);
  });

  test("the scan sees a call, and not a comment about one", () => {
    expect(syncSpawnCalls("x.ts", "const r = Bun.spawnSync([\"ps\"]);")).toHaveLength(1);
    expect(syncSpawnCalls("x.ts", "  out = execFileSync(\"git\", []);")).toHaveLength(1);
    expect(syncSpawnCalls("x.ts", "// the old spawnSync( froze the loop\n * execSync( was here")).toHaveLength(0);
    expect(syncSpawnCalls("x.ts", "import { spawnSync } from \"child_process\";")).toHaveLength(0);
  });
});
