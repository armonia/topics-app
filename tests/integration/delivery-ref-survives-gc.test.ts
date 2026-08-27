/**
 * THE BENCH THIS CARD WAS OPENED FOR: a delivery commit must still be there
 * after the land has squashed it, `git branch -D` has taken the branch away and
 * `git gc --prune=now` has swept the unreachable.
 *
 * It is played on a synthetic repository because there is no other honest way
 * to ask it. A fake git runner would only prove that the code calls
 * `update-ref`; what has to be proved is that GIT, the real one, keeps the
 * object afterwards. On this board that question already has a measured answer:
 * 213 delivery commits out of 286 are gone, and `git fsck --unreachable`
 * returns nothing, which is gc doing exactly what it is supposed to do.
 *
 * TWO CASES, and the second is the one that makes the first mean something:
 *   1. with the ref planted, `cat-file -t` still answers `commit`;
 *   2. WITHOUT it, on the same sequence, the object is gone. Without this
 *      control a green run would prove nothing more than that the local gc was
 *      feeling lazy.
 *
 * @covers LAND-09
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../setup/bun-test-preload";
import { keepDeliveryCommit } from "../../server/services/delivery-ref-keep";

function git(cwd: string, ...args: string[]): { out: string; code: number } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { out: new TextDecoder().decode(r.stdout).trim(), code: r.exitCode ?? 0 };
}

/**
 * A repository in the state the board leaves behind: the card's work on its own
 * branch, the same content already on `main` as ONE squashed commit. That is
 * what the land does, and it is why the branch tip is unreachable the moment
 * the branch goes: nothing on `main` descends from it.
 */
function deliveredRepo(root: string): { repo: string; delivery: string } {
  const repo = join(root, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  // The 90 days this repository declares: without it the local default would
  // decide how much of this test is actually exercised.
  git(repo, "config", "gc.pruneExpire", "90.days.ago");
  writeFileSync(join(repo, "a.txt"), "base");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  git(repo, "checkout", "-q", "-b", "topics/mint-sage");
  writeFileSync(join(repo, "b.txt"), "il lavoro della card"); // allow-italian: file content, not code
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "primo pezzo");
  writeFileSync(join(repo, "b.txt"), "il lavoro della card, finito"); // allow-italian: file content, not code
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "consegna");
  const delivery = git(repo, "rev-parse", "HEAD").out;

  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--squash", "topics/mint-sage");
  git(repo, "commit", "-q", "-m", "land della card");
  return { repo, delivery };
}

/**
 * What the land does after merging, and then TIME.
 *
 * The reflog is why this needs three commands instead of two. `branch -D` drops
 * the branch's own reflog, but `HEAD`'s keeps every checkout and commit made on
 * it, and a reflog entry is a reference: for as long as it stands, gc keeps the
 * object no matter what `--prune=now` is told. That is a STAY OF EXECUTION of
 * 90 days (`gc.reflogExpire`), not a keeper, and the 213 delivery commits
 * measured missing on this board are what the far side of it looks like.
 * Expiring the reflog here is the 91st day arriving in one line.
 */
function landAndPrune(repo: string): void {
  git(repo, "branch", "-D", "topics/mint-sage");
  git(repo, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all");
  git(repo, "gc", "-q", "--prune=now");
}

describe("il commit di consegna sopravvive allo squash-and-delete", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "delivery-ref-gc-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("col ref piantato, `git cat-file -t` risponde ancora `commit`", async () => {
    const { repo, delivery } = deliveredRepo(root);
    expect(await keepDeliveryCommit({ repoPath: repo, taskId: "67622704-card", commit: delivery })).toBe(true);

    landAndPrune(repo);

    expect(git(repo, "cat-file", "-t", delivery).out).toBe("commit");
    // And it is reachable BY NAME, which is what makes it auditable a year
    // later: the sha in the column is not the only way back in.
    expect(git(repo, "rev-parse", "refs/consegne/67622704-card").out).toBe(delivery);
    // The diff of the delivery is still readable, which is the reason the object
    // was worth keeping at all.
    expect(git(repo, "show", "--name-only", "--format=", delivery).out).toContain("b.txt");
  }, 30_000);

  test("senza il ref, sulla stessa sequenza, l'oggetto non c'è più", async () => {
    const { repo, delivery } = deliveredRepo(root);

    landAndPrune(repo);

    expect(git(repo, "cat-file", "-t", delivery).code).not.toBe(0);
  }, 30_000);

  test("il ref lasciato cadere non trattiene niente: dopo la potatura l'oggetto se ne va", async () => {
    // The other half of the expiry decision. Dropping the ref has to really
    // free the object, otherwise the retention window would be a promise the
    // disk never keeps.
    const { repo, delivery } = deliveredRepo(root);
    await keepDeliveryCommit({ repoPath: repo, taskId: "card-scaduta", commit: delivery });
    git(repo, "update-ref", "-d", "refs/consegne/card-scaduta", delivery);

    landAndPrune(repo);

    expect(git(repo, "cat-file", "-t", delivery).code).not.toBe(0);
  }, 30_000);
});
