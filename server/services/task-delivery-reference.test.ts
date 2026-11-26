/**
 * `resolveDeliveryReference` is the exact call site `boot/preview-delivery.ts`
 * uses to feed the delivery sheet (`services/delivery-sheet.ts`): resolve
 * `mainRef` FIRST, then ask for the own commit and the own diffstat against
 * THAT ref. `own-commits.test.ts` already proves `resolveMainRef` and
 * `deliveryPointer` work in isolation; this file proves the WIRING between
 * them does not silently drop back to the literal `"main"`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { deliveryPointer, resolveMainRef } from "./own-commits";
import { worktreeDiffStat } from "./branch-status";
import { resolveDeliveryReference, type DeliveryReferenceDeps } from "./task-delivery-reference";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, body: string, msg: string): void {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
}

describe("resolveDeliveryReference — the delivery sheet's actual call site", () => {
  let remote: string;
  let repo: string;
  let ownCommit: string;

  const deps: DeliveryReferenceDeps = {
    resolveMainRef, deliveryPointer, worktreeDiffStat, cardOwnBranches: () => [],
  };

  beforeAll(() => {
    // The board's own checkout: `main` only moves when a card LANDS here,
    // never on a fetch — so it is routinely behind `origin/main`, which a
    // node always forks the planted branch from.
    remote = mkdtempSync(join(tmpdir(), "delivery-ref-origin-"));
    git(remote, "init", "-q", "--bare", "-b", "main");

    repo = mkdtempSync(join(tmpdir(), "delivery-ref-planted-"));
    git(repo, "init", "-q", "-b", "trunk"); // this checkout never created a local `main` of its own
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "remote", "add", "origin", remote);
    commit(repo, "base.txt", "base\n", "base");
    git(repo, "push", "-q", "origin", "trunk:main");
    git(repo, "fetch", "-q", "origin");

    // The planted branch, forked straight off `origin/main`, ten files ahead.
    git(repo, "checkout", "-q", "-b", "topics/velvet-quasar", "origin/main");
    for (let i = 0; i < 10; i++) commit(repo, `spec-${i}.txt`, `GAUGE-10 line ${i}\n`, `own work ${i}`);
    ownCommit = git(repo, "rev-parse", "topics/velvet-quasar");
  }, 60_000);

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  test("resolves origin/main first, and the sheet counts the planted branch's own commit", async () => {
    const out = await resolveDeliveryReference(deps, { repoPath: repo, branch: "topics/velvet-quasar" }, "task-1");
    expect(out).not.toBeNull();
    expect(out!.commit).toBe(ownCommit);
    expect(out!.filesChanged).toBe(10);
  });

  test("without resolving mainRef first (the literal local `main`), the same branch reads as no commit", async () => {
    // This is the wiring that was removed and left no test red: asking
    // `deliveryPointer`/`worktreeDiffStat` with no `mainRef` at all falls back
    // to the literal ref `"main"`, which THIS checkout never created.
    const pointer = await deliveryPointer(repo, "topics/velvet-quasar");
    expect(pointer).toBeNull();
    const stat = await worktreeDiffStat(repo, { branch: "topics/velvet-quasar" });
    expect(stat).toBeNull();
  });
});
