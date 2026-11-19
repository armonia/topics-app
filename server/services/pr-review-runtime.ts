/**
 * Real adapters for the PR review tick: `gh` for the PR list, `git` for the
 * read-only clone, the `claude` CLI for the workflow run. Kept apart from
 * `pr-review.ts` so the tick itself stays testable with fakes.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createFileStateStore,
  defaultPrReviewRoot,
  execFileText,
  resolvePrReviewSettings,
  tickPrReview,
  type OpenPullRequest,
  type PrReviewDeps,
  type PrReviewRun,
} from "./pr-review";

/** `gh` lives in Homebrew on Apple Silicon; fall back to PATH elsewhere. */
function ghBinary(): string {
  const brew = "/opt/homebrew/bin/gh";
  return existsSync(brew) ? brew : "gh";
}

function claudeBinary(): string {
  const local = join(homedir(), ".local", "bin", "claude");
  return existsSync(local) ? local : "claude";
}

export function createPrReviewDeps(rootDir = defaultPrReviewRoot(), log: (m: string) => void = console.log): PrReviewDeps {
  const store = createFileStateStore(join(rootDir, "state.json"));
  return {
    rootDir,
    now: () => new Date(),
    log,
    loadState: () => store.load(),
    saveState: (state) => store.save(state),
    async listOpenPullRequests(repo) {
      const out = await execFileText(ghBinary(), [
        "pr", "list", "--repo", repo, "--state", "open", "--limit", "100",
        "--json", "number,title,baseRefName,headRefName,headRefOid",
      ]);
      return JSON.parse(out) as OpenPullRequest[];
    },
    async prepareClone(repo, cloneDir, pr) {
      if (!existsSync(join(cloneDir, ".git"))) {
        await execFileText("git", ["clone", "--quiet", `https://github.com/${repo}.git`, cloneDir]);
      }
      await execFileText("git", ["-C", cloneDir, "fetch", "--quiet", "origin", pr.baseRefName]);
      // GitHub exposes every PR head under refs/pull/<n>/head, even when the branch is gone.
      await execFileText("git", ["-C", cloneDir, "fetch", "--quiet", "origin", `+refs/pull/${pr.number}/head:refs/topics-pr-review/${pr.number}`]);
    },
    async runReview(run: PrReviewRun) {
      return runWorkflowWithClaude(run);
    },
  };
}

/**
 * Asks the local `claude` CLI to run the workflow with the given args and print its JSON.
 * Open point: a non-interactive run may need a permission mode to execute the
 * workflow's Bash steps; nothing is granted here on purpose.
 */
async function runWorkflowWithClaude(run: PrReviewRun): Promise<string> {
  const args = {
    repo: run.cloneDir,
    base: run.base,
    head: run.head,
    modello: run.model,
  };
  const prompt = [
    `Esegui il workflow ${run.workflowPath} con args ${JSON.stringify(args)}.`,
    "Stampa come unica uscita il JSON del risultato, senza altro testo.",
  ].join("\n");
  return execFileText(claudeBinary(), ["-p", prompt, "--model", run.model]);
}

/** Starts the periodic tick. With empty settings each tick returns at once and does nothing. */
export function startPrReviewTicker(env: NodeJS.ProcessEnv = process.env): () => void {
  const settings = resolvePrReviewSettings(env);
  if (!settings.repo || !settings.workflowPath) return () => {};
  const deps = createPrReviewDeps();
  const run = () => {
    tickPrReview(settings, deps).catch((err) => console.warn("[pr-review] giro fallito:", (err as Error).message));
  };
  const timer = setInterval(run, settings.intervalMinutes * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
