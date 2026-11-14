/**
 * @covers LAND-16
 * A DEDUCED "landed" ON A CARD NOBODY LANDED (card c2908b93).
 *
 * Card 572f8a09 delivered a MERGE commit (its branch merged onto main) that
 * never reached origin/main. The landing audit read it as landed: `git show`
 * of a clean merge prints no diff, and "no own change" was taken for "nothing
 * to lose". The card was in review, entering the CI phase, and everything
 * downstream trusted the field.
 *
 * Two contracts:
 *  - a merge delivery is "cannot tell" for the commit verdict, never "inside";
 *  - on a card still in review, the deduction writes `landed` only when a merge
 *    is visible on main (the delivery commit is an ancestor, or the land's own
 *    `merge task <id>` is there).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLandings, type AuditTask, type LandingAuditDeps, type LandingState } from "./landing-audit";
import { classifyCommitLanding } from "./landing-verdict";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe("classifyCommitLanding on a merge delivery", () => {
  it("a merge of the branch onto main that main never received is not 'inside'", async () => {
    const repo = mkdtempSync(join(tmpdir(), "landing-merge-"));
    dirs.push(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "base.ts"), "export const base = 1;\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
    git(repo, "switch", "-q", "-c", "topics/card");
    writeFileSync(join(repo, "tools-page.ts"), [
      "export function renderAgentToolsPage(rows: ReadonlyArray<string>): string {",
      "  const compactRows = rows.map((row) => `<li class=\"device-row\">${row}</li>`);",
      "  return `<ul class=\"agent-tools-compact-list\">${compactRows.join(\"\")}</ul>`;",
      "}",
      "export const agentToolsRowHeightInPixels = 28;",
      "export const agentToolsIconButtonSizeInPixels = 22;",
    ].join("\n") + "\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "tools page");
    // The delivery: the branch merged onto a throwaway copy of main, which main never takes.
    git(repo, "switch", "-q", "-c", "land-attempt", "main");
    writeFileSync(join(repo, "base.ts"), "export const base = 2;\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "release bump");
    git(repo, "merge", "-q", "--no-ff", "-m", "bring the work onto main", "topics/card");
    const delivery = git(repo, "rev-parse", "HEAD");
    const verdict = await classifyCommitLanding(repo, delivery, { mainRef: "main" });
    expect(verdict.esito).not.toBe("dentro");
    expect(verdict.esito).toBe("non-decidibile");
  });
});

function harness(task: AuditTask, opts: { onMain: boolean | null; landedMerge?: boolean | null }) {
  const recorded: Array<{ id: string; state: LandingState }> = [];
  const deps: LandingAuditDeps = {
    listCandidates: () => [task],
    repoPath: () => "/repo",
    // The deduction's content guess: "inside".
    commitStatus: async () => "merged",
    onMain: async () => opts.onMain,
    ...(opts.landedMerge !== undefined ? { landedMerge: async () => opts.landedMerge ?? null } : {}),
    record: (id, state) => { recorded.push({ id, state }); },
    previousState: () => null,
    now: () => "2026-11-14T01:35:15.000Z",
    log: () => {},
  };
  return { deps, recorded };
}

const card = (status: string): AuditTask => ({ id: "572f8a09", projectId: "p", deliveryBranch: "topics/card", deliveryCommit: "2765494b7", status });

describe("a deduced 'landed' on a card still in review", () => {
  it("delivery not an ancestor of main and no land merge: not 'landed'", async () => {
    const h = harness(card("review"), { onMain: false, landedMerge: null });
    await auditLandings(h.deps);
    expect(h.recorded).toEqual([{ id: "572f8a09", state: "unverifiable" }]);
  });

  it("git cannot say: not 'landed' either", async () => {
    const h = harness(card("review"), { onMain: null });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("unverifiable");
  });

  it("the delivery commit is inside main: 'landed'", async () => {
    const h = harness(card("review"), { onMain: true });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("landed");
  });

  it("the land's own merge is on main: 'landed'", async () => {
    const h = harness(card("review"), { onMain: false, landedMerge: true });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("landed");
  });

  it("a done card keeps the deduction's other proofs (a land copies commits)", async () => {
    const h = harness(card("done"), { onMain: false, landedMerge: null });
    await auditLandings(h.deps);
    expect(h.recorded[0]!.state).toBe("landed");
  });
});
