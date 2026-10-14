/**
 * WHAT EACH GIT RUNNER ANSWERS, fixed in one table before they share `runBounded`.
 *
 * Every runner below launches one process with a deadline and turns the outcome
 * into its own shape. The callers read those shapes, and some read them very
 * closely: `commitIsIn` takes exit 1 as "verified outside", so own-commits says
 * 124 on a timeout; `worktree-base-ref` and the branch scanners say 1, which
 * their callers read as "no answer". Five outcomes per runner: success, a
 * non-zero exit, the deadline, a process that does not start, and a process
 * killed by a signal from elsewhere (Bun's `exited` gives 128 + n, 137 here).
 *
 * The child is faked at `Bun.spawn`, the one door `spawnBounded` goes through:
 * the runner's own argv is replaced by a tiny `sh` script, every option it
 * passed (cwd, env, pipes, detached) is kept. Only calls carrying MARK are
 * faked, so the identity probe of `gitEnvFor` still talks to the real git.
 * @covers GIT-DEADLINE-01
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunGit as ownCommitsRunGit } from "./own-commits";
import { defaultRunGit as automergeRunGit, runRepoScript } from "./task-automerge";
import { defaultRunGit as baseRefRunGit } from "./worktree-base-ref";
import { defaultRunGit as residueRunGit } from "./worktree-residue";
import { commitIsAncestor, gitExit, gitOut } from "./branch-status";
import { run as inventoryRun } from "./branch-inventory";
import { runGitCap } from "../routes/tasks";
import { gitEnvFor } from "../lib/git-identity";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const MARK = "t14-contract-mark";
const SPAWN_ERROR = "t14: the process did not start";

type Outcome = "ok" | "fail" | "fail1" | "timeout" | "spawn" | "signal";
const SCRIPT: Record<Exclude<Outcome, "spawn">, string> = {
  ok: "printf out; printf err >&2; exit 0",
  fail: "printf out; printf err >&2; exit 3",
  fail1: "printf out; printf err >&2; exit 1",
  // What arrived before the deadline is part of the answer.
  timeout: "printf partial; exec sleep 30",
  signal: "printf out; kill -9 $$",
};

let dir = "";
let mode: Outcome = "ok";
let seen: { argv: string[]; cwd?: string; env?: Record<string, string | undefined> }[] = [];
let spy: ReturnType<typeof spyOn> | null = null;
const realSpawn = Bun.spawn;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-runners-contract-"));
  writeFileSync(join(dir, "bun.lock"), ""); // `runRepoScript` resolves the package manager from it
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: gitEnv() });
  await gitEnvFor(dir); // the identity probe runs once per folder, on the real git, before any fake
  process.env.TOPICS_SPAWN_TIMEOUT_CAP_MS = "300";
  spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[], opts: Parameters<typeof Bun.spawn>[1]) => {
    if (!argv.some((a) => a.includes(MARK))) return realSpawn(argv, opts);
    const o = opts as { cwd?: string; env?: Record<string, string | undefined> };
    seen.push({ argv, cwd: o.cwd, env: o.env });
    if (mode === "spawn") throw new Error(SPAWN_ERROR);
    return realSpawn(["sh", "-c", SCRIPT[mode]], opts);
  }) as unknown as typeof Bun.spawn);
});

afterEach(() => { seen = []; });

afterAll(() => {
  spy?.mockRestore();
  delete process.env.TOPICS_SPAWN_TIMEOUT_CAP_MS;
  rmSync(dir, { recursive: true, force: true });
});

async function as<T>(m: Outcome, call: () => Promise<T>): Promise<T> {
  mode = m;
  return call();
}

/** `{ code, stdout, stderr }` runners, with the code each one gives a deadline. */
const RESULT_RUNNERS: { name: string; timeoutCode: number; call: () => Promise<unknown>; argv: () => string[]; cwd?: () => string }[] = [
  {
    name: "own-commits defaultRunGit", timeoutCode: 124,
    call: () => ownCommitsRunGit(dir, ["rev-parse", MARK]),
    argv: () => ["git", "-C", dir, "rev-parse", MARK],
  },
  {
    name: "task-automerge defaultRunGit", timeoutCode: 124,
    call: () => automergeRunGit(dir, ["rev-parse", MARK]),
    argv: () => ["git", "rev-parse", MARK], cwd: () => dir,
  },
  {
    name: "task-automerge runRepoScript", timeoutCode: 124,
    call: () => runRepoScript(dir, [MARK]),
    argv: () => ["bun", "run", MARK], cwd: () => dir,
  },
  {
    name: "worktree-base-ref defaultRunGit", timeoutCode: 1,
    call: () => baseRefRunGit(dir, ["rev-parse", MARK]),
    argv: () => ["git", "-C", dir, "rev-parse", MARK],
  },
  {
    name: "worktree-residue defaultRunGit", timeoutCode: 1,
    call: () => residueRunGit(dir, ["rev-parse", MARK]),
    argv: () => ["git", "rev-parse", MARK], cwd: () => dir,
  },
];

describe.each(RESULT_RUNNERS)("$name", ({ call, argv, cwd, timeoutCode }) => {
  test("success: exit 0, both streams", async () => {
    expect(await as("ok", call)).toEqual({ code: 0, stdout: "out", stderr: "err" });
    expect(seen.map((s) => s.argv)).toEqual([argv()]);
    if (cwd) expect(seen[0]?.cwd).toBe(cwd());
  });
  test("non-zero exit: the code as it is, both streams", async () => {
    expect(await as("fail", call)).toEqual({ code: 3, stdout: "out", stderr: "err" });
  });
  test(`deadline: code ${timeoutCode}, what arrived before it`, async () => {
    expect(await as("timeout", call)).toEqual({ code: timeoutCode, stdout: "partial", stderr: "" });
  });
  test("did not start: code 1, the error in stderr", async () => {
    expect(await as("spawn", call)).toEqual({ code: 1, stdout: "", stderr: SPAWN_ERROR });
  });
  test("killed by a signal from elsewhere: Bun's 128 + n", async () => {
    expect(await as("signal", call)).toEqual({ code: 137, stdout: "out", stderr: "" });
  });
});

describe("routes/tasks runGitCap", () => {
  const call = () => runGitCap(dir, ["rev-parse", MARK]);
  test("success: exit 0, both streams, no credential prompt", async () => {
    expect(await as("ok", call)).toEqual({ code: 0, out: "out", err: "err" });
    expect(seen.map((s) => [s.argv, s.cwd, s.env?.GIT_TERMINAL_PROMPT])).toEqual([[["git", "rev-parse", MARK], dir, "0"]]);
  });
  test("non-zero exit", async () => {
    expect(await as("fail", call)).toEqual({ code: 3, out: "out", err: "err" });
  });
  test("deadline: 124", async () => {
    expect(await as("timeout", call)).toEqual({ code: 124, out: "partial", err: "" });
  });
  test("did not start: 1, the error in err", async () => {
    expect(await as("spawn", call)).toEqual({ code: 1, out: "", err: SPAWN_ERROR });
  });
  test("killed by a signal", async () => {
    expect(await as("signal", call)).toEqual({ code: 137, out: "out", err: "" });
  });
});

describe("own-commits defaultRunGit with an env", () => {
  test("the env goes to git on top of the server's own", async () => {
    await as("ok", () => ownCommitsRunGit(dir, ["rev-parse", MARK], { env: { T14_PROBE: "yes" } }));
    expect(seen[0]?.env?.T14_PROBE).toBe("yes");
    expect(seen[0]?.env?.PATH).toBe(process.env.PATH);
  });
});

describe("branch-inventory run", () => {
  const call = () => inventoryRun(dir, ["rev-parse", MARK]);
  test("success", async () => {
    expect(await as("ok", call)).toEqual({ code: 0, stdout: "out" });
    expect(seen.map((s) => s.argv)).toEqual([["git", "-C", dir, "rev-parse", MARK]]);
  });
  test("non-zero exit", async () => { expect(await as("fail", call)).toEqual({ code: 3, stdout: "out" }); });
  test("deadline: 1", async () => { expect(await as("timeout", call)).toEqual({ code: 1, stdout: "partial" }); });
  test("did not start: 1", async () => { expect(await as("spawn", call)).toEqual({ code: 1, stdout: "" }); });
  test("killed by a signal", async () => { expect(await as("signal", call)).toEqual({ code: 137, stdout: "out" }); });
});

describe("branch-status gitExit / gitOut / commitIsAncestor", () => {
  const exit = () => gitExit(dir, ["show-ref", MARK]);
  const out = () => gitOut(dir, ["rev-parse", MARK]);
  const ancestor = () => commitIsAncestor(dir, MARK, "main");

  test.each([
    ["ok", 0], ["fail", 3], ["timeout", 1], ["spawn", 1], ["signal", 137],
  ] as const)("gitExit, %s: %d", async (m, code) => {
    expect(await as(m, exit)).toBe(code);
  });

  test.each([
    // The text whatever the exit code: the callers that need the code use gitExit.
    ["ok", "out"], ["fail", "out"], ["timeout", "partial"], ["spawn", ""], ["signal", "out"],
  ] as const)("gitOut, %s: %p", async (m, text) => {
    expect(await as(m, out)).toBe(text);
  });

  test.each([
    // 1 is git's "no" and stays a no; everything else is "cannot tell".
    ["ok", true], ["fail1", false], ["fail", null], ["timeout", null], ["spawn", null], ["signal", null],
  ] as const)("commitIsAncestor, %s: %p", async (m, verdict) => {
    expect(await as(m, ancestor)).toBe(verdict);
  });

  test("the argv each one launches", async () => {
    await as("ok", exit); await as("ok", out); await as("ok", ancestor);
    expect(seen.map((s) => s.argv)).toEqual([
      ["git", "-C", dir, "show-ref", MARK],
      ["git", "-C", dir, "rev-parse", MARK],
      ["git", "-C", dir, "merge-base", "--is-ancestor", MARK, "main"],
    ]);
  });
});
