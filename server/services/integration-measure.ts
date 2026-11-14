/**
 * THE INTEGRATION COMMIT: `origin/main` plus every branch of the batch, built in
 * a throwaway checkout and measured once by the board's CI rows.
 *
 * Deterministic on purpose: author and committer dates are pinned to the base
 * commit's, so the same base and the same branches give the same sha. A restart
 * in the middle of a 30-minute CI run then finds the run already there for that
 * sha instead of starting a new one.
 *
 * The branch pushed is `topics/integrazione-<sha8>`, its draft pull request is
 * opened by `awaitCiEvidence` like a card's, and both are closed as soon as the
 * verdict is read: the cards land through the usual land, never through this
 * pull request.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckRun, ReviewCheck } from "../../shared/board";
import type { IntegrationMeasure } from "./integration-queue";
import { INTEGRATION_BRANCH_PREFIX } from "./own-commits";

export interface GitResult { code: number; out: string; err: string }

export interface IntegrationMeasureDeps {
  git(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult>;
  /** `awaitCiEvidence` bound to its port: pushes `cwd`'s branch, opens the draft, waits for every row. */
  awaitCi(input: { cwd: string; sha: string; taskId: string; checks: readonly ReviewCheck[] }): Promise<CheckRun[]>;
  /** `closeCiDraft`: the integration pull request and branch end with the verdict. */
  closeDraft(input: { cwd: string; branch: string; reason: string }): Promise<unknown>;
  /**
   * Ask the CI to run the failed jobs of `sha` again. A red on the integration
   * commit sends a card back to its agent, and this suite has flaky tests (14/11:
   * the first batch went red on a slot.ts timing test that is red now and then on
   * main too). One rerun before blaming anyone. `false` = could not ask.
   */
  rerunFailed?: (cwd: string, sha: string) => Promise<boolean>;
  /** The failing rows as the agent reads them (`formatChecksComment`). */
  describeRed(runs: CheckRun[], commit: string): string;
  tmpRoot?: string;
}

export interface IntegrationCard { taskId: string; commit: string }

export async function measureIntegration(
  repoPath: string,
  cards: readonly IntegrationCard[],
  checks: readonly ReviewCheck[],
  deps: IntegrationMeasureDeps,
): Promise<IntegrationMeasure> {
  const conflicts: IntegrationMeasure["conflicts"] = [];
  const measured: string[] = [];
  const unmeasured = (why: string, commit: string | null = null): IntegrationMeasure =>
    ({ measured: measured.length ? measured : cards.map((c) => c.taskId), conflicts, verdict: "unmeasured", commit, why });

  // A fetch that fails measures on the copy of origin/main this machine has: stale, never wrong.
  await deps.git(repoPath, ["fetch", "--quiet", "origin", "main"]);
  const base = (await deps.git(repoPath, ["rev-parse", "origin/main"])).out.trim();
  if (!base) return unmeasured("origin/main non si risolve in questo repo");
  const baseDate = (await deps.git(repoPath, ["show", "-s", "--format=%ct", base])).out.trim();

  const dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "topics-integrazione-"));
  const added = await deps.git(repoPath, ["worktree", "add", "--detach", "--quiet", dir, base]);
  if (added.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return unmeasured(`il checkout di integrazione non si crea: ${added.err.trim().slice(0, 200)}`);
  }
  let branch = "";
  try {
    let i = 0;
    for (const card of cards) {
      // One second apart, from the base's own date: same inputs, same sha.
      const when = `${Number(baseDate || 0) + (++i)} +0000`;
      const env = { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
      const merged = await deps.git(dir, ["merge", "--no-ff", "--no-edit", "-m", `integrazione: card ${card.taskId.slice(0, 8)}`, card.commit], env);
      if (merged.code === 0) { measured.push(card.taskId); continue; }
      const files = (await deps.git(dir, ["diff", "--name-only", "--diff-filter=U"])).out.trim().split("\n").filter(Boolean);
      await deps.git(dir, ["merge", "--abort"]);
      const others = measured.length ? ` e le ${measured.length} card fuse prima nel lotto` : "";
      conflicts.push({
        taskId: card.taskId,
        why: files.length
          ? `Il tuo ramo va in conflitto con main${others} su: ${files.slice(0, 20).join(", ")}. Rifai la base del ramo su origin/main (\`git fetch origin main && git rebase origin/main\`), risolvi, committa e rimetti in review: la card rientra da sola nella fase CI.`
          : `Il tuo ramo non si fonde su main${others}: ${(merged.err || merged.out).trim().slice(0, 300)}. Rifai la base su origin/main e rimetti in review.`,
      });
    }
    if (!measured.length) return { measured, conflicts, verdict: "empty" };
    const sha = (await deps.git(dir, ["rev-parse", "HEAD"])).out.trim();
    branch = `${INTEGRATION_BRANCH_PREFIX}${sha.slice(0, 8)}`;
    const switched = await deps.git(dir, ["switch", "--quiet", "-C", branch]);
    if (switched.code !== 0) return unmeasured(`il ramo di integrazione non si crea: ${switched.err.trim().slice(0, 200)}`, sha);
    // The queue is serial per repo: any other integration branch on origin is a measure a restart cut
    // short, with its draft still open and its CI still running. It ends here.
    const stale = (await deps.git(repoPath, ["ls-remote", "--heads", "origin", `refs/heads/${INTEGRATION_BRANCH_PREFIX}*`])).out
      .split("\n").map((l) => l.split("refs/heads/")[1]?.trim() ?? "").filter((b) => b && b !== branch);
    for (const old of stale) {
      await deps.closeDraft({ cwd: repoPath, branch: old, reason: "Misura di integrazione interrotta (riavvio del server): sostituita da una misura nuova." })
        .catch(() => undefined);
    }
    // Same for the local copy the cut measure never deleted (its `finally` died with the process).
    const localStale = (await deps.git(repoPath, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${INTEGRATION_BRANCH_PREFIX}*`])).out
      .split("\n").map((l) => l.trim()).filter((b) => b && b !== branch);
    for (const old of localStale) await deps.git(repoPath, ["branch", "-D", old]);
    const ask = { cwd: dir, sha, taskId: `${sha.slice(0, 8)}-integrazione`, checks };
    let runs = await deps.awaitCi(ask);
    let red = runs.filter((r) => !r.ok && !r.notMeasured && !r.timedOut);
    // A red is confirmed by a second run of the failed jobs: a flake must not cost a card a round.
    if (red.length && deps.rerunFailed && (await deps.rerunFailed(dir, sha).catch(() => false))) {
      runs = await deps.awaitCi(ask);
      red = runs.filter((r) => !r.ok && !r.notMeasured && !r.timedOut);
    }
    if (red.length) return { measured, conflicts, verdict: "fail", commit: sha, why: deps.describeRed(runs, sha) };
    if (runs.length < checks.length || runs.some((r) => !r.ok)) {
      const missing = runs.find((r) => !r.ok)?.name ?? "una riga";
      return unmeasured(`\`${missing}\` non ha un esito della CI`, sha);
    }
    return { measured, conflicts, verdict: "pass", commit: sha };
  } finally {
    if (branch) {
      await deps.closeDraft({ cwd: repoPath, branch, reason: "Misura di integrazione della board conclusa: le card atterrano col land, non da questa PR." })
        .catch(() => undefined);
    }
    await deps.git(repoPath, ["worktree", "remove", "--force", dir]);
    if (branch) await deps.git(repoPath, ["branch", "-D", branch]);
    rmSync(dir, { recursive: true, force: true });
  }
}
