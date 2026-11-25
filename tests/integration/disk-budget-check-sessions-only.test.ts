/**
 * The nightly disk check compresses agent SESSION transcripts and nothing else
 * under the agents folder: the rest is each agent's workspace, read back as
 * plain JSONL by its own scripts (25/11: 29 such files past the cutoff, no
 * `sessions` folder at all on the live machine).
 *
 * @covers SYSTEM-DISK-01
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const root = mkdtempSync(join(tmpdir(), "disk-budget-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function oldFile(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, '{"line":1}\n');
  const monthAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(path, monthAgo, monthAgo);
  return path;
}

describe("disk-budget-check: transcript compression", () => {
  test("a session transcript is gzipped, an agent's workspace JSONL is left alone", () => {
    const app = join(root, "app");
    const data = join(root, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "topics.db"), "x".repeat(4096));
    const session = oldFile(join(app, "agents", "main", "sessions", "s1.jsonl"));
    const workspace = oldFile(join(app, "agents", "jarvis", "state", "task-mode", "log.jsonl"));

    const run = Bun.spawnSync([process.execPath, "scripts/disk-budget-check.ts", "--json"], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", HOME: root, APP_DATA_DIR: app, TOPICS_HOME: app, DATA_DIR: data },
    });
    const report = JSON.parse(run.stdout.toString());

    expect(report.compressedTranscripts).toEqual([session]);
    expect(existsSync(`${session}.gz`)).toBe(true);
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(`${workspace}.gz`)).toBe(false);
  });
});
