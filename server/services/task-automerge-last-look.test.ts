/**
 * The automatic land's LAST LOOK, proved on real git repos.
 *
 * The verdict is taken when the land is offered and again when its turn in the
 * queue comes. Between that and the merge itself `tryMerge` still waits for the
 * repo's chain, fetches the network and walks the branch, and two things can
 * happen in that window (verifier repro `race.ts`, 09/11):
 *   A. a commit lands on the branch AFTER the tip check, and `git merge <name>`
 *      publishes it unmeasured, because the merge was given a NAME;
 *   B. the card is archived, asks something or goes back to work, and nothing
 *      reads it again before the merge.
 * Cure: the merge takes the measured SHA, and `DeliverySnapshot.beforeMerge` is
 * asked under the chain a moment before the merge, after the fetch.  @covers LAND-05
 */
import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskAutoMerge, defaultRunGit } from "./task-automerge";
import { slackMs } from "../../tests/helpers/time-slack";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BRANCH = "topics/card";
const WITH_REAL_GIT = slackMs(30_000);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

function commit(cwd: string, path: string, body: string, message: string): void {
  const abs = join(cwd, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

/**
 * A repo with a bare `origin` (so every land really fetches), `main` published,
 * and the card's branch checked out in its OWN worktree, the way an agent's is.
 */
function repoWithAgentWorktree(): { repo: string; agent: string; tip: string } {
  const root = mkdtempSync(join(tmpdir(), "land-lastlook-"));
  created.push(root);
  const bare = join(root, "origin.git");
  const repo = join(root, "work");
  const agent = join(root, "agent");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "clone", "-q", bare, repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "switch", "-q", "-c", "main");
  commit(repo, "r.txt", "radice\n", "radice");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "worktree", "add", "-q", "-b", BRANCH, agent, "main");
  commit(agent, "card.txt", "misurato\n", "card: card.txt");
  return { repo, agent, tip: git(repo, "rev-parse", BRANCH).trim() };
}

function landOn(repo: string, runGit?: typeof defaultRunGit) {
  return createTaskAutoMerge({
    resolveTaskMerge: () => ({ repoPath: repo, branch: BRANCH, defaultBranch: "main" }),
    ...(runGit ? { runGit } : {}),
  });
}

const onMain = (repo: string, path: string): boolean => {
  try { git(repo, "cat-file", "-e", `main:${path}`); return true; } catch { return false; }
};

describe("the automatic land merges the measured SHA, not the branch name", () => {
  test("a commit that lands on the branch at the very moment of the merge is NOT published", async () => {
    const { repo, agent, tip } = repoWithAgentWorktree();
    let injected = false;
    // The agent commits in its worktree while git is asked to merge: whatever the
    // name `topics/card` points to by then is not what the bar measured.
    const runGit: typeof defaultRunGit = async (cwd, args) => {
      if (!injected && args[0] === "merge" && args.includes("--no-ff")) {
        injected = true;
        commit(agent, "late.txt", "mai misurato\n", "card: late.txt");
      }
      return defaultRunGit(cwd, args);
    };

    const res = await landOn(repo, runGit).tryMerge("t1", "Card", { branch: BRANCH, commit: tip, noRealign: true });

    expect(injected).toBe(true);
    expect(res.status).toBe("merged");
    expect(onMain(repo, "card.txt")).toBe(true);
    expect(onMain(repo, "late.txt")).toBe(false);
  }, WITH_REAL_GIT);

  test("a commit added after the tip check, before the merge, stops the land (scenario A of the repro)", async () => {
    const { repo, agent, tip } = repoWithAgentWorktree();
    const before = git(repo, "rev-parse", "main").trim();
    let injected = false;
    // The status call comes after the pin check and before the merge step.
    const runGit: typeof defaultRunGit = async (cwd, args) => {
      if (!injected && args.includes("--untracked-files=no")) {
        injected = true;
        commit(agent, "scripts/check-security.ts", "process.exit(0)\n", "card: more");
      }
      return defaultRunGit(cwd, args);
    };

    const res = await landOn(repo, runGit).tryMerge("t1", "Card", { branch: BRANCH, commit: tip, noRealign: true });

    expect(injected).toBe(true);
    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("not-as-measured");
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
    expect(onMain(repo, "scripts/check-security.ts")).toBe(false);
  }, WITH_REAL_GIT);

  test("without noRealign (a person's gesture) the merge still takes the branch, as before", async () => {
    const { repo, agent } = repoWithAgentWorktree();
    commit(agent, "later.txt", "dopo\n", "card: later.txt");

    const res = await landOn(repo).tryMerge("t1", "Card", { branch: BRANCH, commit: git(repo, "rev-parse", BRANCH).trim() });

    expect(res.status).toBe("merged");
    expect(onMain(repo, "later.txt")).toBe(true);
  }, WITH_REAL_GIT);
});

describe("beforeMerge is asked under the chain, after the fetch, right before the merge", () => {
  test("a card that changed during the fetch is not merged (scenario B of the repro)", async () => {
    const { repo, tip } = repoWithAgentWorktree();
    const before = git(repo, "rev-parse", "main").trim();
    const card = { archived: false, humanAsk: null as string | null };
    const order: string[] = [];
    const runGit: typeof defaultRunGit = async (cwd, args) => {
      // Only the fetch of the base is the network read under test: the one that
      // brings the card's own branch from origin (`refs/heads/<b>:refs/heads/<b>`)
      // runs earlier, before anything is measured.
      if (args[0] === "fetch" && !args.some((x) => x.startsWith("refs/heads/"))) {
        order.push("fetch");
        // The card is archived and asks the person while the network is being read.
        await new Promise((r) => setTimeout(r, 50));
        card.archived = true;
        card.humanAsk = "Non landare, aspetta me";
      }
      if (args[0] === "merge" && args.includes("--no-ff")) order.push("merge");
      return defaultRunGit(cwd, args);
    };

    const res = await landOn(repo, runGit).tryMerge("t1", "Card", {
      branch: BRANCH, commit: tip, noRealign: true,
      beforeMerge: async () => {
        order.push("beforeMerge");
        return card.archived || card.humanAsk ? "the card changed: it is archived and asks something" : null;
      },
    });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("auto-land-stopped");
    expect(res.reason).toContain("archived");
    expect(order).toEqual(["fetch", "beforeMerge"]);
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
    expect(onMain(repo, "card.txt")).toBe(false);
  }, WITH_REAL_GIT);

  test("it is given the full measured sha, and a yes lets the merge through", async () => {
    const { repo, tip } = repoWithAgentWorktree();
    const asked: string[] = [];

    const res = await landOn(repo).tryMerge("t1", "Card", {
      branch: BRANCH, commit: tip.slice(0, 10), noRealign: true,
      beforeMerge: async (sha) => { asked.push(sha); return null; },
    });

    expect(res.status).toBe("merged");
    expect(asked).toEqual([tip]);
    expect(onMain(repo, "card.txt")).toBe(true);
  }, WITH_REAL_GIT);

  test("a callback that throws is a stop, never a merge", async () => {
    const { repo, tip } = repoWithAgentWorktree();

    const res = await landOn(repo).tryMerge("t1", "Card", {
      branch: BRANCH, commit: tip, noRealign: true,
      beforeMerge: async () => { throw new Error("db closed"); },
    });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("auto-land-stopped");
    expect(res.reason).toContain("db closed");
    expect(onMain(repo, "card.txt")).toBe(false);
  }, WITH_REAL_GIT);

  test("it also runs on the throwaway-worktree path (the checkout is parked on a dev branch)", async () => {
    const { repo, tip } = repoWithAgentWorktree();
    git(repo, "switch", "-q", "-c", "dev-parcheggio");
    const before = git(repo, "rev-parse", "main").trim();

    const res = await landOn(repo).tryMerge("t1", "Card", {
      branch: BRANCH, commit: tip, noRealign: true,
      beforeMerge: async () => "a turn opened",
    });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("auto-land-stopped");
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
  }, WITH_REAL_GIT);

  test("a person's gesture (no noRealign) never calls it", async () => {
    const { repo, tip } = repoWithAgentWorktree();
    let calls = 0;

    const res = await landOn(repo).tryMerge("t1", "Card", {
      branch: BRANCH, commit: tip,
      beforeMerge: async () => { calls += 1; return "stop"; },
    });

    expect(res.status).toBe("merged");
    expect(calls).toBe(0);
  }, WITH_REAL_GIT);
});
