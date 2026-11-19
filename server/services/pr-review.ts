/**
 * Automatic review of new open pull requests.
 *
 * On each tick, if a GitHub repository is configured, every open PR whose head
 * commit is not yet in the state file gets one review run through a local
 * workflow script. The state lives on disk, so a PR opened while the machine was
 * off is picked up by the first tick after boot.
 *
 * Off by default: with an empty repo or an empty workflow path the tick does
 * nothing and touches nothing. Nothing here reads secrets: `gh` uses its own
 * login, and the review runs through the local CLI.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PrReviewSettings {
  /** GitHub repository in `owner/name` form. Empty = feature off. */
  repo: string;
  /** Absolute path of the local review workflow script. Empty = feature off. */
  workflowPath: string;
  /** Model passed to the workflow (`haiku` keeps the quota low). */
  model: string;
  /** Minutes between two ticks. */
  intervalMinutes: number;
}

export const PR_REVIEW_DEFAULTS: PrReviewSettings = {
  repo: "",
  workflowPath: "",
  model: "haiku",
  intervalMinutes: 15,
};

/**
 * Resolves the settings as `setting ?? env ?? default`. The UI store is not wired
 * yet, so the environment is the only override for now; an empty string counts as unset.
 */
export function resolvePrReviewSettings(env: NodeJS.ProcessEnv = process.env): PrReviewSettings {
  const text = (name: string, fallback: string) => {
    const value = env[name]?.trim();
    return value ? value : fallback;
  };
  const minutes = Number(text("TOPICS_PR_REVIEW_INTERVAL_MINUTES", String(PR_REVIEW_DEFAULTS.intervalMinutes)));
  return {
    repo: text("TOPICS_PR_REVIEW_REPO", PR_REVIEW_DEFAULTS.repo),
    workflowPath: text("TOPICS_PR_REVIEW_WORKFLOW_PATH", PR_REVIEW_DEFAULTS.workflowPath),
    model: text("TOPICS_PR_REVIEW_MODEL", PR_REVIEW_DEFAULTS.model),
    intervalMinutes: Number.isFinite(minutes) && minutes >= 1 ? minutes : PR_REVIEW_DEFAULTS.intervalMinutes,
  };
}

export interface OpenPullRequest {
  number: number;
  title: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}

export type PrReviewStatus = "done" | "failed";

export interface PrReviewRecord {
  status: PrReviewStatus;
  at: string;
  reason?: string;
}

/** Keyed by `owner/name#number@sha`: a new commit on the same PR is a new review. */
export type PrReviewState = Record<string, PrReviewRecord>;

export interface PrReviewRun {
  repo: string;
  base: string;
  head: string;
  model: string;
  workflowPath: string;
  cloneDir: string;
  outFile: string;
}

export interface PrReviewDeps {
  listOpenPullRequests(repo: string): Promise<OpenPullRequest[]>;
  /** Clones the repo on first use, otherwise fetches it; makes base and head available locally. */
  prepareClone(repo: string, cloneDir: string, pr: OpenPullRequest): Promise<void>;
  /** Runs the workflow and returns its JSON output as text. */
  runReview(run: PrReviewRun): Promise<string>;
  loadState(): PrReviewState;
  saveState(state: PrReviewState): void;
  /** Root for clones and results, e.g. `~/.topics/pr-review`. */
  rootDir: string;
  now(): Date;
  log(message: string): void;
}

export function stateKey(repo: string, pr: OpenPullRequest): string {
  return `${repo}#${pr.number}@${pr.headRefOid}`;
}

/** Directory name for a repo, safe for the filesystem: `owner/name` becomes `owner-name`. */
export function cloneSlug(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * One tick. Reviews every open PR that is not in the state yet, one at a time.
 * Returns the keys it launched, which is what the tests check.
 */
export async function tickPrReview(settings: PrReviewSettings, deps: PrReviewDeps): Promise<string[]> {
  if (!settings.repo || !settings.workflowPath) return [];

  const launched: string[] = [];
  const state = deps.loadState();
  let open: OpenPullRequest[];
  try {
    open = await deps.listOpenPullRequests(settings.repo);
  } catch (err) {
    deps.log(`pr-review: elenco PR fallito: ${(err as Error).message}`);
    return [];
  }

  for (const pr of open) {
    const key = stateKey(settings.repo, pr);
    if (state[key]) continue;
    launched.push(key);

    const cloneDir = join(deps.rootDir, "clones", cloneSlug(settings.repo));
    const outFile = join(deps.rootDir, "results", cloneSlug(settings.repo), `${pr.number}.json`);
    const at = deps.now().toISOString();
    try {
      await deps.prepareClone(settings.repo, cloneDir, pr);
      const output = await deps.runReview({
        repo: settings.repo,
        base: `origin/${pr.baseRefName}`,
        head: pr.headRefOid,
        model: settings.model,
        workflowPath: settings.workflowPath,
        cloneDir,
        outFile,
      });
      mkdirSync(join(outFile, ".."), { recursive: true });
      writeFileSync(outFile, output);
      state[key] = { status: "done", at };
      deps.log(`pr-review: ${key} revisionata -> ${outFile}`);
    } catch (err) {
      // A failure is recorded too: the same commit is not retried on every tick.
      state[key] = { status: "failed", at, reason: (err as Error).message.slice(0, 300) };
      deps.log(`pr-review: ${key} fallita: ${(err as Error).message}`);
    }
    deps.saveState(state);
  }
  return launched;
}

/** Default state location: `<root>/state.json`, written atomically. */
export function createFileStateStore(path: string) {
  return {
    load(): PrReviewState {
      if (!existsSync(path)) return {};
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PrReviewState;
      } catch {
        return {};
      }
    },
    save(state: PrReviewState): void {
      mkdirSync(join(path, ".."), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, path);
    },
  };
}

export function defaultPrReviewRoot(): string {
  return join(homedir(), ".topics", "pr-review");
}

/** Runs a command with an argument list (never a shell string). Rejects on non-zero exit. */
export function execFileText(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args[0] ?? ""}: ${stderr.toString().trim() || err.message}`));
      else resolve(stdout.toString());
    });
  });
}
