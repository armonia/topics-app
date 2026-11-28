/**
 * Fast static gates on the realign merge, on real git repos: red stops the land and puts the branch back,
 * green lands as before, "unmeasured" is its own outcome (not a conflict).
 * @covers LAND-13
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskAutoMerge, type AutoMergeDeps } from "./task-automerge";
import { slackMs } from "../../tests/helpers/time-slack";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BRANCH = "topics/old-branch";
const WITH_REAL_GIT = slackMs(30_000);
const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
function commit(cwd: string, file: string, body: string): void {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", file);
}

/** `main` plus a branch born BEFORE main moved (`behind` = main has one more commit than the branch knows). */
function repo(behind: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "land-gates-"));
  created.push(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "Test"], ["commit.gpgsign", "false"]]) git(dir, "config", k, v);
  commit(dir, "root.txt", "root\n");
  git(dir, "switch", "-q", "-c", BRANCH);
  commit(dir, "branch.txt", "work\n");
  git(dir, "switch", "-q", "main");
  if (behind) commit(dir, "main-one.txt", "one\n");
  return dir;
}
const refs = (dir: string) => [BRANCH, "main"].map((ref) => git(dir, "rev-parse", ref).trim());
const landOn = (dir: string, extra: Partial<AutoMergeDeps>) =>
  createTaskAutoMerge({ resolveTaskMerge: () => ({ repoPath: dir, branch: BRANCH, defaultBranch: "main" }), ...extra });

describe("static gates on the realign merge, before the land goes on", () => {
  test("a red gate on the merge: nothing lands, the branch is back where it was, the reason names the gate", async () => {
    const dir = repo(true);
    const before = refs(dir);
    const seen: string[] = [];
    const staticGates = async (cwd: string) => {
      seen.push(readFileSync(join(cwd, "main-one.txt"), "utf8").trim()); // the MERGED tree
      return { kind: "red" as const, detail: "bun run lint:design-system (exit 1): 4 raw controls" };
    };
    const res = await landOn(dir, { staticGates }).tryMerge("t1", "Card with a red merge");
    expect(res).toMatchObject({ status: "skipped", code: "realign-gates-red", reason: expect.stringContaining("lint:design-system") });
    expect(seen).toEqual(["one"]);
    expect(refs(dir)).toEqual(before);
  }, WITH_REAL_GIT);

  test("a green gate lands as before; an up-to-date branch is not measured; unmeasured stops", async () => {
    let calls = 0;
    const staticGates = async () => { calls += 1; return null; };
    expect((await landOn(repo(true), { staticGates }).tryMerge("t1", "Green")).status).toBe("merged");
    expect((await landOn(repo(false), { staticGates }).tryMerge("t2", "Fresh card")).status).toBe("merged");
    expect(calls).toBe(1);
    const unmeasured = async () => ({ kind: "unmeasured" as const, detail: "no deps" });
    expect(await landOn(repo(true), { staticGates: unmeasured }).tryMerge("t3", "X")).toMatchObject({ code: "realign-gates-unmeasured" });
  }, WITH_REAL_GIT);

  test("the pre-review realign() carries the gates: red, unmeasured (own flag) and green", async () => {
    const dir = repo(true);
    const tip = refs(dir)[0];
    const gate = (kind: "red" | "unmeasured", detail: string) => landOn(dir, { staticGates: async () => ({ kind, detail }) }).realign("t1");
    const red = await gate("red", "bun run lint:design-system (exit 1)");
    expect(red).toMatchObject({ ok: false, reason: expect.stringContaining("lint:design-system") });
    expect(red).not.toHaveProperty("unmeasured");
    expect(await gate("unmeasured", "no deps")).toMatchObject({ ok: false, unmeasured: true, reason: expect.stringContaining("no deps") });
    expect(refs(dir)[0]).toBe(tip);
    expect(await landOn(dir, { staticGates: async () => null }).realign("t1")).toMatchObject({ ok: true });
  }, WITH_REAL_GIT);
});
