/**
 * "LANDED" MEANS ON origin/main, and a land that was undone is not a land.
 *
 * Card 2e3649aa, after the incident of card 48588f6e (2026-11-12): the GC merged
 * a card closed without a land into the LOCAL main (`3be5ccbad merge task …`),
 * the card read `landed` although origin did not have it, and once the merge
 * and its manual revert both reached origin, three checks still acquitted it:
 * the delivery commit was a "Merge main" (its diff from the first parent is
 * main's own files), it was an ancestor of main, and the land merge carrying
 * the card's name was there.
 *
 * Real git, with a bare origin: the questions are git's to answer.
 *
 * @covers LAND-05
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLandingAudit, type AuditWiring } from "./landing-audit-pass";
import type { AuditTask, LandingState } from "./landing-audit";
import { commitStatusFromRepo } from "./branch-status";
import { projectIdForPath } from "./tasks";
import type { ProjectStore } from "./project-store";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** Long lines: below 60 characters the content verdict has nothing to fingerprint. */
const LINE = (tag: string, n: number) => `export const distinctiveValueForTheOriginTest_${tag}_${n} = ${n}; // ${"y".repeat(30)}\n`;
const LINES = (tag: string) => [1, 2, 3, 4, 5].map((n) => LINE(tag, n)).join("");

const STRAY_ID = "48588f6e-0000-4000-8000-000000000000";

let root: string;
let repo: string;
let boardId = "";
let localOnly = "";
let pushed = "";
let strayDelivery = "";
let landedMergeMain = "";
let editedLater = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "landing-origin-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  repo = join(root, "checkout");
  git(root, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "checkout", "-q", "-b", "main");
  const base = commit(repo, "base.ts", LINE("base", 0), "base");
  git(repo, "push", "-q", "origin", "main");
  boardId = projectIdForPath(repo);

  // PUSHED: landed with --no-ff like the land, and published.
  git(repo, "checkout", "-q", "-b", "topics/pushed", base);
  pushed = commit(repo, "pushed.ts", LINES("pushed"), "pushed work");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-q", "-m", "merge topics/pushed", "topics/pushed");

  // LANDED, THEN EDITED BY OTHER WORK: a busy file is not a revert.
  git(repo, "checkout", "-q", "-b", "topics/edited", "main");
  editedLater = commit(repo, "edited.ts", LINES("edited"), "edited work");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-q", "-m", "merge topics/edited", "topics/edited");
  commit(repo, "edited.ts", LINES("edited").replace("_edited_3 = 3", "_edited_3 = 33"), "someone else edits it");

  // THE INCIDENT SHAPE: the card's work, then a "Merge main" as the delivery
  // tip, a stray land merge named after the card, a manual revert (file
  // removal, not `git revert`), and both published.
  git(repo, "checkout", "-q", "-b", "topics/hasty", "main");
  commit(repo, "hasty.ts", LINES("hasty"), "the card's own work");
  git(repo, "checkout", "-q", "main");
  commit(repo, "other.ts", LINES("other"), "main moves on");
  git(repo, "checkout", "-q", "topics/hasty");
  git(repo, "merge", "--no-ff", "-q", "-m", "Merge main", "main");
  strayDelivery = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-q", "-m", `merge task ${STRAY_ID}: closed without a land`, "topics/hasty");
  unlinkSync(join(repo, "hasty.ts"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Revert the stray merge of the card");
  landedMergeMain = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "main");

  // LOCAL ONLY: on this disk's main, never pushed.
  git(repo, "checkout", "-q", "-b", "topics/local", "main");
  localOnly = commit(repo, "local.ts", LINES("local"), "local work");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-q", "-m", "merge topics/local", "topics/local");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface FakeCard extends AuditTask {
  landingState: LandingState | null;
}

function wiring(card: FakeCard): AuditWiring {
  return {
    projectStore: { list: () => [] } as unknown as ProjectStore,
    workspaceDir: join(root, "no-workspace"),
    extraPaths: () => [repo],
    svc: {
      addComment: () => null,
      get: (id) => (id === card.id ? { task: card } : null),
      recordLandingState: (a) => { card.landingState = a.state; return null; },
      listLandingAuditCandidates: () => [card],
    },
    broadcast: () => {},
    backfill: async () => {},
  };
}

async function verdictOf(card: Partial<FakeCard> & { id: string }): Promise<LandingState | null> {
  const full: FakeCard = { projectId: boardId, deliveryBranch: null, deliveryCommit: null, landingState: null, status: "done", ...card };
  await runLandingAudit(wiring(full));
  return full.landingState;
}

describe("the audit asks origin/main", () => {
  test("a commit only on the local main is unpushed, not landed", async () => {
    // The fixture really is local-only: guard it, or the test proves nothing.
    expect(git(repo, "merge-base", "--is-ancestor", localOnly, "main")).toBe("");
    expect(Bun.spawnSync(["git", "-C", repo, "merge-base", "--is-ancestor", localOnly, "origin/main"]).exitCode).toBe(1);

    expect(await verdictOf({ id: "local-only", deliveryCommit: localOnly })).toBe("unpushed");
  });

  test("a commit that origin has is landed", async () => {
    expect(await verdictOf({ id: "pushed", deliveryCommit: pushed })).toBe("landed");
  });

  test("a landed change that later work edited stays landed", async () => {
    expect(await verdictOf({ id: "edited", deliveryCommit: editedLater })).toBe("landed");
  });
});

describe("a land that was undone is not a land (the shape of 48588f6e)", () => {
  test("the 'Merge main' delivery, ancestor of a reverted merge, is not landed", async () => {
    // Ancestry alone says yes, and that is the trap.
    expect(git(repo, "merge-base", "--is-ancestor", strayDelivery, "origin/main")).toBe("");
    expect(await commitStatusFromRepo(repo, strayDelivery, "refs/remotes/origin/main")).toBe("reverted");
    expect(await verdictOf({ id: STRAY_ID, deliveryCommit: strayDelivery })).toBe("unlanded");
  });

  test("with the delivery commit gone, the reverted land merge does not acquit the card", async () => {
    // The third handle: only the merge named after the card is left.
    expect(git(repo, "log", "--format=%H", "-n", "1", landedMergeMain)).toBe(landedMergeMain);
    const verdict = await verdictOf({ id: STRAY_ID, deliveryCommit: "f".repeat(40), landingState: "unlanded" });
    expect(verdict).not.toBe("landed");
  });

  test("a 'Merge main' delivery with no work of its own does not read merged from main's files", async () => {
    // A branch whose only commit over main is the merge of main itself: what
    // it brings over the side it merged is nothing, so it answers nothing.
    git(repo, "checkout", "-q", "-b", "topics/empty-merge", "main~1");
    // Its own subject: a "Merge main" with the same second would pass for the
    // published one as the land copy (same author time, same subject).
    git(repo, "merge", "--no-ff", "-q", "-m", "Merge main into the empty branch", "main");
    const tip = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    expect(await commitStatusFromRepo(repo, tip, "refs/remotes/origin/main")).toBe("empty");
  });
});
