/**
 * @covers LAND-04
 *
 * A card title the repo's pre-push hook refuses must not stop the land from
 * reaching origin: the merge message keeps `merge task <id>` and drops the title.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTaskAutoMerge } from "./task-automerge";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BAD_WORD = "forbiddenword";
let dir: string;

/** CI runners have no git identity: the commits made here carry one explicitly. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...gitEnv, ...IDENTITY }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  Object.assign(process.env, IDENTITY);
  dir = mkdtempSync(join(tmpdir(), "prepush-land-"));
  const repo = join(dir, "repo");
  git(dir, "init", "-q", "-b", "main", repo);
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
  writeFileSync(script, `#!/bin/sh\nwhile read l r s rs; do\n  if git log --format=%B "$rs..$s" | grep -qi ${BAD_WORD}; then exit 1; fi\ndone\nexit 0\n`);
  chmodSync(script, 0o755);
  git(repo, "config", "core.hooksPath", hook);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function land(title: string) {
  const repo = join(dir, "repo");
  const am = createTaskAutoMerge({ resolveTaskMerge: () => ({ repoPath: repo, branch: "topics/card", defaultBranch: "main" }) });
  const res = await am.tryMerge("abc123", title);
  return { res, msg: git(repo, "log", "-1", "--format=%s", "main"), tree: git(repo, "rev-parse", "main^{tree}") };
}

describe("land: pre-push refusing the title", () => {
  test("a refused title is replaced by the bare id prefix", async () => {
    const { res, msg } = await land(`fix ${BAD_WORD} thing`);
    expect(res.status).toBe("merged");
    expect(msg).toBe("merge task abc123");
    expect(msg).not.toContain(BAD_WORD);
  });

  test("an accepted title keeps today's message", async () => {
    const { res, msg } = await land("fix harmless thing");
    expect(res.status).toBe("merged");
    expect(msg).toBe("merge task abc123: fix harmless thing");
  });
});
