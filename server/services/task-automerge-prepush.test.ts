/**
 * @covers LAND-04
 *
 * A card title the repo's pre-push hook refuses must not stop the land from
 * reaching origin: the merge message keeps `merge task <id>` and drops the title.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTaskAutoMerge } from "./task-automerge";
import type { LandViaPrResult } from "./land-via-pull-request";
import { prePushVerdict } from "./land-prepush-message";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BASE_CONFIG_COUNT = process.env.GIT_CONFIG_COUNT;
const BAD_WORD = "forbiddenword";
let dir: string;


function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prepush-land-"));
  const repo = join(dir, "repo");
  git(dir, "init", "-q", "-b", "main", repo);
  // CI runners have no global identity: the repo carries its own.
  git(repo, "config", "user.name", "Land Test");
  git(repo, "config", "user.email", "land-test@example.invalid");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "topics/card");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "work");
  git(repo, "checkout", "-q", "main");
  // The hook refuses any outgoing commit message containing the word, like a real pre-push scan.
  const hook = join(dir, "hooks");
  git(dir, "init", "-q", hook);
  const script = join(hook, "pre-push");
  writeFileSync(script, `#!/bin/sh\nwhile read lref lsha rref rsha; do\n  if git log --format=%B "$rsha..$lsha" | grep -qi ${BAD_WORD}; then exit 1; fi\ndone\nexit 0\n`);
  chmodSync(script, 0o755);
  git(repo, "config", "core.hooksPath", hook);
  // The suite's isolation pins `core.hooksPath` through GIT_CONFIG_*, which beats the repo setting: a later pair wins.
  const n = Number(BASE_CONFIG_COUNT ?? "0") || 0;
  process.env[`GIT_CONFIG_KEY_${n}`] = "core.hooksPath";
  process.env[`GIT_CONFIG_VALUE_${n}`] = hook;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
});
afterEach(() => {
  if (BASE_CONFIG_COUNT === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = BASE_CONFIG_COUNT;
  rmSync(dir, { recursive: true, force: true });
});

async function land(title: string) {
  const repo = join(dir, "repo");
  const am = createTaskAutoMerge({ resolveTaskMerge: () => ({ repoPath: repo, branch: "topics/card", defaultBranch: "main" }) });
  const res = await am.tryMerge("abc123", title);
  return { res, msg: git(repo, "log", "-1", "--format=%s", "main"), tree: git(repo, "rev-parse", "main^{tree}") };
}

describe("land: pre-push refusing the title", () => {
  test("the hook itself refuses a commit carrying the word", async () => {
    const repo = join(dir, "repo");
    git(repo, "commit", "-q", "--allow-empty", "-m", `x ${BAD_WORD}`);
    const sha = git(repo, "rev-parse", "HEAD");
    const probe = spawnSync(process.platform === "win32" ? "sh" : join(dir, "hooks", "pre-push"), [...(process.platform === "win32" ? [join(dir, "hooks", "pre-push")] : []), "origin", "origin"], {
      cwd: repo, encoding: "utf8", input: `refs/heads/main ${sha} refs/heads/main ${git(repo, "rev-parse", "HEAD^1")}\n`,
    });
    expect(`${probe.status} ${probe.error ?? ""} ${probe.stderr}`).toBe("1  ");
    const verdict = await prePushVerdict(repo, git(repo, "rev-parse", "HEAD^1"), sha);
    expect(verdict.detail.length > 0 && verdict.refused ? "refused" : verdict.detail).toBe("refused");
  });

  test("a refused title is replaced by the bare id prefix", async () => {
    const { res, msg } = await land(`fix ${BAD_WORD} thing`);
    expect(res).toMatchObject({ status: "merged" });
    expect(msg).toBe("merge task abc123");
    expect(msg).not.toContain(BAD_WORD);
  });

  test("an accepted title keeps today's message", async () => {
    const { res, msg } = await land("fix harmless thing");
    expect(res).toMatchObject({ status: "merged" });
    expect(msg).toBe("merge task abc123: fix harmless thing");
  });
});

/**
 * The land through the pull request: GitHub writes the merge commit, so the
 * hook is asked about the message BEFORE it is handed over. The fake stands
 * for GitHub and the fast forward: it merges locally with the message it got.
 */
describe("land through the pull request: the message GitHub gets", () => {
  async function landViaPr(title: string, outcome: "merged" | "failed") {
    const repo = join(dir, "repo");
    const handed: string[] = [];
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => ({ repoPath: repo, branch: "topics/card", defaultBranch: "main" }),
      landViaPullRequest: async (input): Promise<LandViaPrResult> => {
        handed.push(input.mergeMessage);
        if (outcome === "failed") return { status: "failed", reason: "auto-merge refused by GitHub" };
        git(input.cwd, "merge", "--no-ff", "--no-verify", "-m", input.mergeMessage, input.expectedHead);
        return { status: "merged", commit: git(input.cwd, "rev-parse", "HEAD") };
      },
    });
    const res = await am.tryMerge("abc123", title);
    return { res, handed, msg: git(repo, "log", "-1", "--format=%s", "main") };
  }

  test("a refused title reaches GitHub already neutralized, and the land finishes as merged", async () => {
    const { res, handed, msg } = await landViaPr(`fix ${BAD_WORD} thing`, "merged");
    expect(handed).toEqual(["merge task abc123"]);
    expect(res).toMatchObject({ status: "merged", branch: "topics/card" });
    expect((res as { commit?: string }).commit).toBe(git(join(dir, "repo"), "rev-parse", "--short", "main"));
    expect(msg).toBe("merge task abc123");
  });

  test("an accepted title reaches GitHub unchanged", async () => {
    const { res, handed } = await landViaPr("fix harmless thing", "merged");
    expect(handed).toEqual(["merge task abc123: fix harmless thing"]);
    expect(res).toMatchObject({ status: "merged" });
  });

  test("a hook that fails with any other exit code counts as a refusal too", async () => {
    const script = join(dir, "hooks", "pre-push");
    writeFileSync(script, "#!/bin/sh\nexit 2\n");
    chmodSync(script, 0o755);
    const { handed } = await landViaPr("fix harmless thing", "merged");
    expect(handed).toEqual(["merge task abc123"]);
  });

  test("a failed land through the pull request is a skip with its real reason, not a conflict", async () => {
    const { res } = await landViaPr("fix harmless thing", "failed");
    expect(res).toMatchObject({ status: "skipped", code: "pull-request-land-failed", reason: "auto-merge refused by GitHub" });
  });
});
