/**
 * IMPORTING THE PROCESS REGISTRY TOUCHES NO STATE FOLDER; LOADING IT DOES.
 * @covers E2E-ISO-01
 *
 * The defect (04/10/2026). `server/routes/processes.ts` loaded its registry at
 * MODULE IMPORT: it resolved the state folder from `process.cwd()`, created
 * `.state/scripts/` there and read `.state/scripts.json`. A test file imports
 * `./chat` at the top, `chat.ts` imports `./processes`, and ES imports run
 * before any line of the file, so the folder was resolved before the file's
 * `beforeAll(setupTestDataDir)` could name an isolated one. Run from the repo
 * without DATA_DIR, 64 test files opened the LIVE registry of the checkout:
 * they re-adopted the live server's running commands and, for one found dead,
 * closed it and rewrote the live `scripts.json`.
 *
 * What is checked here, each in a child process started in an empty folder
 * with neither DATA_DIR nor TOPICS_DATA_DIR set (a child, because a module is
 * evaluated once per process and its working directory is the run's):
 *   - importing `processes.ts`, and `chat.ts` that reaches it, creates nothing
 *     in that folder;
 *   - loading the registry (`loadProcessRegistry`, what `server.ts` calls at
 *     boot) still resolves the SAME folder production uses with no variable
 *     set, the working directory, and creates `.state/scripts/` there.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { testTmpDir } from "../../tests/integration/helpers";

const ROOT = testTmpDir("processes-import-touches-nothing");

const PROCESSES = join(import.meta.dir, "processes.ts");
const CHAT = join(import.meta.dir, "chat.ts");

/** Runs `script` with `bun -e` in a fresh empty folder; returns that folder and the child's exit. */
function runIn(label: string, script: string): { cwd: string; exitCode: number | null; stderr: string } {
  const cwd = join(ROOT, label);
  const home = join(ROOT, `${label}-home`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, TOPICS_HOME: join(home, ".topics") };
  delete env.DATA_DIR;
  delete env.TOPICS_DATA_DIR;
  const out = Bun.spawnSync(["bun", "-e", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { cwd, exitCode: out.exitCode, stderr: out.stderr.toString() };
}

describe("the process registry and the state folder", () => {
  test("importing processes.ts and chat.ts creates nothing in the working directory", () => {
    const run = runIn("import-only", `await import(${JSON.stringify(PROCESSES)}); await import(${JSON.stringify(CHAT)}); process.exit(0);`);
    expect(run.stderr).not.toContain("error:");
    expect(run.exitCode).toBe(0);
    expect(readdirSync(run.cwd)).toEqual([]);
  }, 60_000);

  test("loading the registry resolves the working directory and creates .state/scripts there", () => {
    const run = runIn(
      "load",
      `const m = await import(${JSON.stringify(PROCESSES)}); m.loadProcessRegistry(); process.exit(0);`,
    );
    expect(run.stderr).not.toContain("error:");
    expect(run.exitCode).toBe(0);
    expect(readdirSync(run.cwd)).toEqual([".state"]);
    expect(statSync(join(run.cwd, ".state", "scripts")).isDirectory()).toBe(true);
  }, 60_000);
});
