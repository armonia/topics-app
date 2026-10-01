/**
 * `scripts.json` on disk: the process registry is replaced by tmp + rename,
 * a boot killed in the middle of that leaves the registry it read, and one
 * that cannot be parsed is logged and kept aside. Each boot is a process of
 * its own (`helpers/process-registry-life.ts`), the way a server reload is.
 *
 * @covers CMDRUN-04
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { testTmpDir } from "./helpers";

const ROOT = testTmpDir("process-registry-file");
const PROJECT = realpathSync((mkdirSync(join(ROOT, "project"), { recursive: true }), join(ROOT, "project")));
const LIFE = join(import.meta.dir, "helpers", "process-registry-life.ts");

/** One boot of the registry on a state folder, as the reload tests run it. */
function lifeIn(dir: string, ...args: string[]): void {
  Bun.spawnSync(["bun", LIFE, ...args], { env: { ...process.env, DATA_DIR: dir, TOPICS_DATA_DIR: dir }, stderr: "pipe" });
}

describe("the registry file survives a kill and a corruption", () => {
  // SRV-06. `scripts.json` was rewritten in place (open with O_TRUNC, then
  // write): a SIGKILL or an ENOSPC between the two left it empty or cut, and
  // the next boot's JSON.parse failed inside a `catch {}`. Every re-adoptable
  // process and every owed wake was gone, with no log line, and the first save
  // overwrote the evidence.
  test("the registry is replaced by a rename, never rewritten in place", () => {
    const dir = join(ROOT, `atomic-${Date.now()}`);
    mkdirSync(join(dir, ".state", "scripts"), { recursive: true });
    const file = join(dir, ".state", "scripts.json");
    // A command found dead at boot: closing it saves the registry.
    writeFileSync(file, JSON.stringify({
      running: [{ processId: "dead-cmd", scriptName: "echo", command: "echo", projectPath: PROJECT, status: "running",
        startedAt: new Date().toISOString(), pid: 999999, pidLstart: "gone",
        source: "command", cmd: { sessionKey: "topic:life", topicId: "topic-life", wake: false } }],
      recent: [],
    }));
    const fileIdBefore = statSync(file).ino;
    lifeIn(dir, "load");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { recent: Array<{ processId: string }> };
    expect(saved.recent.map((r) => r.processId)).toEqual(["dead-cmd"]);
    // Same inode = the file was truncated and rewritten where it stood.
    expect(statSync(file).ino).not.toBe(fileIdBefore);
    expect(readdirSync(join(dir, ".state")).filter((n) => n.includes(".tmp."))).toEqual([]);
  }, 30_000);

  test("a boot killed between the temp write and the rename leaves the registry it read", () => {
    const dir = join(ROOT, `killed-${Date.now()}`);
    mkdirSync(join(dir, ".state", "scripts"), { recursive: true });
    const file = join(dir, ".state", "scripts.json");
    // A command found dead at boot: closing it saves the registry.
    const before = JSON.stringify({
      running: [{ processId: "dead-cmd", scriptName: "echo", command: "echo", projectPath: PROJECT, status: "running",
        startedAt: new Date().toISOString(), pid: 999999, pidLstart: "gone",
        source: "command", cmd: { sessionKey: "topic:life", topicId: "topic-life", wake: false } }],
      recent: [],
    });
    writeFileSync(file, before);
    const out = Bun.spawnSync(["bun", "--preload", join(dirname(LIFE), "kill-on-rename.ts"), LIFE, "load"], {
      env: { ...process.env, DATA_DIR: dir, TOPICS_DATA_DIR: dir, KILL_ON_RENAME_OF: "scripts.json" },
      stderr: "pipe",
    });
    // Written in place, the save would already have replaced it here.
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(out.signalCode).toBe("SIGKILL");
  }, 30_000);

  test("an unreadable registry is logged and set aside, not dropped in silence", () => {
    const dir = join(ROOT, `torn-${Date.now()}`);
    mkdirSync(join(dir, ".state", "scripts"), { recursive: true });
    const file = join(dir, ".state", "scripts.json");
    const torn = JSON.stringify({ running: [], recent: [{ processId: "owed", cmd: { wake: true } }] }).slice(0, 40);
    writeFileSync(file, torn);
    const out = Bun.spawnSync(["bun", LIFE, "load"], { env: { ...process.env, DATA_DIR: dir, TOPICS_DATA_DIR: dir }, stderr: "pipe" });
    const aside = readdirSync(join(dir, ".state")).filter((n) => n.startsWith("scripts.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, ".state", aside[0]!), "utf8")).toBe(torn);
    expect(out.stderr.toString()).toContain("scripts.json");
  }, 30_000);
});
