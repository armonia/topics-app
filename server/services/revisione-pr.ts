/**
 * Automatic review of every newly opened pull request, on a cheap model, run on this machine.
 *
 * Nothing is hard-wired to a repository: the repo to watch and the review workflow come from
 * the environment (`REVIEW_PR_REPO`, `REVIEW_PR_WORKFLOW`). Both empty means the tick does
 * nothing. Each open PR is reviewed once per head commit; the verdict is written to a file,
 * never posted back to GitHub.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REVIEW_PR_MODEL = "claude-haiku-5-5";
const REVIEW_TIMEOUT_MS = 45 * 60_000;
const POLL_INTERVAL_MS = 10 * 60_000;

export interface RevisionePrConfig {
  /** `owner/name` of the repository to watch. */
  repo: string;
  /** Path of the `revisione-pr` workflow file. */
  workflowPath: string;
  /** Where the read-only clone, the verdict files and the state live. */
  dataDir: string;
  intervalMs: number;
}

export interface OpenPr {
  number: number;
  title: string;
  baseRefName: string;
  headRefOid: string;
}

/** Reads the configuration; null when the feature is off (empty repo or workflow). */
export function readRevisionePrConfig(env: NodeJS.ProcessEnv, appDataDir: string): RevisionePrConfig | null {
  const repo = (env.REVIEW_PR_REPO || "").trim();
  const workflowPath = (env.REVIEW_PR_WORKFLOW || "").trim();
  if (!repo || !workflowPath) return null;
  return {
    repo,
    workflowPath,
    dataDir: join(appDataDir, "revisione-pr"),
    intervalMs: Number(env.REVIEW_PR_INTERVAL_MS) > 0 ? Number(env.REVIEW_PR_INTERVAL_MS) : POLL_INTERVAL_MS,
  };
}

/** A PR is reviewed once per head commit: a new push to the PR asks for a new review. */
export function reviewKey(pr: Pick<OpenPr, "number" | "headRefOid">): string {
  return `${pr.number}@${pr.headRefOid}`;
}

/** The open PRs whose current head has no verdict yet. */
export function pendingPrs(open: OpenPr[], done: ReadonlySet<string>): OpenPr[] {
  return open.filter((pr) => !done.has(reviewKey(pr)));
}

/** The prompt that asks the model to run the workflow on one PR, with args as JSON. */
export function buildReviewPrompt(workflowPath: string, args: { repo: string; base: string; head: string }): string {
  const payload = JSON.stringify({ ...args, modello: "haiku" });
  return [
    `Esegui il workflow di revisione «revisione-pr» (file ${workflowPath}) con args ${payload}.`,
    "Restituisci solo il risultato del workflow, in JSON.",
  ].join("\n");
}

export interface RevisionePrDeps {
  listOpenPrs(repo: string): Promise<OpenPr[]>;
  /** Makes `base` and the PR head available in the read-only clone, returns their refs. */
  prepareRefs(clone: string, repo: string, pr: OpenPr): Promise<{ base: string; head: string }>;
  runReview(prompt: string, cwd: string): Promise<string>;
  log(message: string, err?: unknown): void;
}

function run(file: string, args: string[], opts: { cwd?: string; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0]}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

export const realRevisionePrDeps: RevisionePrDeps = {
  async listOpenPrs(repo) {
    const out = await run("gh", ["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", "number,title,baseRefName,headRefOid"], {});
    return JSON.parse(out) as OpenPr[];
  },
  async prepareRefs(clone, repo, pr) {
    const exists = await readFile(join(clone, "HEAD")).then(() => true, () => false);
    if (!exists) await run("git", ["clone", "--quiet", "--bare", `https://github.com/${repo}.git`, clone], {});
    const base = `refs/revisione/base/${pr.baseRefName}`;
    const head = `refs/revisione/pr/${pr.number}`;
    await run("git", ["-C", clone, "fetch", "--quiet", "--force", "origin", `+refs/heads/${pr.baseRefName}:${base}`, `+refs/pull/${pr.number}/head:${head}`], {});
    return { base, head };
  },
  async runReview(prompt, cwd) {
    return run("claude", ["-p", prompt, "--model", REVIEW_PR_MODEL], { cwd, timeout: REVIEW_TIMEOUT_MS });
  },
  log(message, err) {
    console.warn(`[RevisionePR] ${message}`, err ?? "");
  },
};

async function loadDone(dir: string): Promise<Set<string>> {
  const raw = await readFile(join(dir, "reviewed.json"), "utf8").catch(() => "[]");
  return new Set(JSON.parse(raw) as string[]);
}

/**
 * One pass: reviews every open PR whose current head has no verdict yet. A PR that fails stays
 * pending and is retried on the next pass. Returns the keys reviewed in this pass.
 */
export async function tickRevisionePr(
  cfg: RevisionePrConfig,
  deps: RevisionePrDeps = realRevisionePrDeps,
): Promise<string[]> {
  await mkdir(cfg.dataDir, { recursive: true });
  const clone = join(cfg.dataDir, "clone.git");
  const done = await loadDone(cfg.dataDir);
  const open = await deps.listOpenPrs(cfg.repo);
  const reviewed: string[] = [];
  for (const pr of pendingPrs(open, done)) {
    try {
      const refs = await deps.prepareRefs(clone, cfg.repo, pr);
      const verdict = await deps.runReview(buildReviewPrompt(cfg.workflowPath, { repo: clone, ...refs }), cfg.dataDir);
      const key = reviewKey(pr);
      await writeFile(join(cfg.dataDir, `esito-${pr.number}-${pr.headRefOid.slice(0, 12)}.json`), verdict);
      done.add(key);
      await writeFile(join(cfg.dataDir, "reviewed.json"), JSON.stringify([...done]));
      reviewed.push(key);
    } catch (err) {
      deps.log(`PR #${pr.number}: revisione fallita, riprova al giro dopo`, err);
    }
  }
  return reviewed;
}

/** Starts the periodic pass. Returns null (and starts nothing) when the feature is off. */
export function startRevisionePrTick(
  cfg: RevisionePrConfig | null,
  deps: RevisionePrDeps = realRevisionePrDeps,
): NodeJS.Timeout | null {
  if (!cfg) return null;
  let busy = false;
  const pass = () => {
    if (busy) return;
    busy = true;
    tickRevisionePr(cfg, deps)
      .catch((err) => deps.log("giro di revisione fallito", err))
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(pass, cfg.intervalMs);
  timer.unref?.();
  pass();
  return timer;
}
