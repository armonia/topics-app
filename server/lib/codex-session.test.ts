/**
 * @covers CODEXSESS-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { discoverCodexSessionId, codexRolloutExists } from "./codex-session";

// Build a fake ~/.codex/sessions tree and drive discovery against it via the
// `root` override (no real codex / no env needed).
let root: string;

function meta(payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-06-24T00:00:00.000Z", type: "session_meta", payload }) + "\n" +
    JSON.stringify({ type: "event", payload: { kind: "noise" } }) + "\n";
}

/** Write a rollout file under YYYY/MM/DD and stamp its mtime (ms since epoch). */
function writeRollout(dateDir: string, uuid: string, payload: Record<string, unknown>, mtimeMs: number): string {
  const dir = join(root, ...dateDir.split("/"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${dateDir.replace(/\//g, "-")}T12-00-00-${uuid}.jsonl`);
  writeFileSync(file, meta({ id: uuid, cwd: "/x", originator: "codex-tui", ...payload }));
  const sec = mtimeMs / 1000;
  utimesSync(file, sec, sec);
  return file;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
});
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("discoverCodexSessionId", () => {
  test("returns null when the sessions root does not exist", () => {
    expect(discoverCodexSessionId({ cwd: "/p", sinceMs: 0, root: join(root, "nope") })).toBeNull();
  });

  test("matches a fresh codex-tui rollout by cwd, returning its UUID", () => {
    const spawn = 1_000_000;
    writeRollout("2026/06/24", "uuid-match", { cwd: "/proj/a" }, spawn + 500);
    expect(discoverCodexSessionId({ cwd: "/proj/a", sinceMs: spawn, root })).toBe("uuid-match");
  });

  test("ignores rollouts in a different cwd", () => {
    const spawn = 2_000_000;
    writeRollout("2026/06/24", "uuid-other-cwd", { cwd: "/proj/elsewhere" }, spawn + 500);
    expect(discoverCodexSessionId({ cwd: "/proj/none", sinceMs: spawn, root })).toBeNull();
  });

  test("ignores rollouts written before the spawn time (beyond skew)", () => {
    const spawn = 3_000_000;
    // 10s before spawn — older than the default 5s skew tolerance.
    writeRollout("2026/06/24", "uuid-stale", { cwd: "/proj/b" }, spawn - 10_000);
    expect(discoverCodexSessionId({ cwd: "/proj/b", sinceMs: spawn, root })).toBeNull();
  });

  test("tolerates small negative clock skew (file stamped just before spawn)", () => {
    const spawn = 3_500_000;
    writeRollout("2026/06/24", "uuid-skew", { cwd: "/proj/skew" }, spawn - 2_000);
    expect(discoverCodexSessionId({ cwd: "/proj/skew", sinceMs: spawn, root })).toBe("uuid-skew");
  });

  test("skips subagent rollouts (thread_source / source.subagent)", () => {
    const spawn = 4_000_000;
    writeRollout("2026/06/24", "uuid-sub1", { cwd: "/proj/c", thread_source: "subagent" }, spawn + 100);
    writeRollout("2026/06/24", "uuid-sub2", { cwd: "/proj/c", source: { subagent: { other: "guardian" } } }, spawn + 200);
    expect(discoverCodexSessionId({ cwd: "/proj/c", sinceMs: spawn, root })).toBeNull();
  });

  test("skips non-codex-tui originators (e.g. exec)", () => {
    const spawn = 5_000_000;
    writeRollout("2026/06/24", "uuid-exec", { cwd: "/proj/d", originator: "codex-exec" }, spawn + 100);
    expect(discoverCodexSessionId({ cwd: "/proj/d", sinceMs: spawn, root })).toBeNull();
  });

  test("picks the NEWEST matching rollout when several qualify", () => {
    const spawn = 6_000_000;
    writeRollout("2026/06/24", "uuid-old", { cwd: "/proj/e" }, spawn + 100);
    writeRollout("2026/06/24", "uuid-new", { cwd: "/proj/e" }, spawn + 9_000);
    expect(discoverCodexSessionId({ cwd: "/proj/e", sinceMs: spawn, root })).toBe("uuid-new");
  });
});

describe("codexRolloutExists", () => {
  test("true when a rollout file with the id suffix exists", () => {
    writeRollout("2026/06/20", "uuid-exists", { cwd: "/proj/f" }, 7_000_000);
    expect(codexRolloutExists("uuid-exists", root)).toBe(true);
  });

  test("false for an unknown id and for an empty id", () => {
    expect(codexRolloutExists("uuid-ghost", root)).toBe(false);
    expect(codexRolloutExists("", root)).toBe(false);
  });
});
