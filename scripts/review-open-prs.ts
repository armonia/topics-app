#!/usr/bin/env bun
// Prepares the review arguments for every open pull request of this repository.
//
// `bun run review:open-prs` lists the open PRs with gh, keeps a bare mirror
// that is only ever fetched (never checked out, never pushed to), and writes
// one review prompt per PR under the output directory. Calling the model is
// opt-in: `--run-haiku` sends the prompts to claude-haiku-5-5 and spends tokens.
//
// Exit code: 0 when every PR was prepared (or there are no open PRs),
// 1 when gh, git or a PR fails, or when the arguments are wrong.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const REVIEW_MODEL = "claude-haiku-5-5";
export const DEFAULT_DIFF_CHARS = 60_000;
export const DEFAULT_LIMIT = 50;

export interface OpenPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  updatedAt: string;
}

export interface Options {
  limit: number;
  out: string;
  runHaiku: boolean;
}

// Extracts "owner/name" from an SSH or HTTPS GitHub remote, null otherwise.
export function repoFromRemote(remote: string): string | null {
  const match = remote.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function isOpenPr(value: unknown): value is OpenPr {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.number === "number" &&
    typeof row.title === "string" &&
    typeof row.url === "string" &&
    typeof row.headRefName === "string" &&
    typeof row.baseRefName === "string" &&
    typeof row.isDraft === "boolean" &&
    typeof row.updatedAt === "string"
  );
}

// Validates the JSON printed by `gh pr list --json ...`. Throws on any drift.
export function parseOpenPullRequests(json: string): OpenPr[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error("gh pr list did not return an array");
  return data.map((item, index) => {
    if (!isOpenPr(item)) throw new Error(`gh pr list: entry ${index} has an unexpected shape`);
    return item;
  });
}

export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const left = diff.length - maxChars;
  return `${diff.slice(0, maxChars)}\n[diff truncated: ${left} characters left out]\n`;
}

// The review brief for one PR. It is English on purpose: it is a prompt, not a UI text.
export function buildReviewPrompt(pr: OpenPr, diffSummary: string, diff: string, maxChars: number): string {
  const draft = pr.isDraft ? " (draft)" : "";
  return [
    `You are reviewing pull request #${pr.number} "${pr.title}" (${pr.url}).`,
    `Base ${pr.baseRefName} <- head ${pr.headRefName}${draft}.`,
    "Report only concrete problems: bugs, regressions, missing tests, unsafe changes.",
    "Give each finding a file and a line range. Say clearly when you found nothing.",
    "Do not edit files and do not run commands: the diff below is all you read.",
    "",
    "Diffstat:",
    diffSummary.trim() || "(empty)",
    "",
    "Diff:",
    "```diff",
    truncateDiff(diff.trimEnd(), maxChars),
    "```",
    "",
  ].join("\n");
}

export function parseArgs(argv: string[], defaultOut: string): Options {
  const options: Options = { limit: DEFAULT_LIMIT, out: defaultOut, runHaiku: false };
  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-haiku") options.runHaiku = true;
    else if (arg === "--limit") options.limit = Number(value(++i, arg));
    else if (arg === "--out") options.out = resolve(value(++i, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return options;
}

function defaultOutDir(): string {
  const base = process.env.APP_DATA_DIR ?? join(homedir(), ".topics");
  return join(base, "review-prep");
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: Blob } = {},
): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (exit ${code}): ${stderr.trim()}`);
  return stdout;
}

// Creates the bare mirror once and keeps its origin URL in step with the checkout.
async function ensureMirror(mirror: string, origin: string): Promise<void> {
  if (!(await Bun.file(join(mirror, "HEAD")).exists())) {
    await run("git", ["init", "--bare", "--quiet", mirror]);
  }
  await run("git", ["-C", mirror, "config", "remote.origin.url", origin]);
}

// Fetches the PR head and its base into refs of the mirror, then reads the diff.
// Nothing is checked out and the mirror is never pushed to.
async function fetchAndDiff(mirror: string, pr: OpenPr): Promise<{ diffSummary: string; diff: string }> {
  const head = `refs/review/pr-${pr.number}`;
  const base = `refs/review/base-${pr.number}`;
  await run("git", [
    "-C", mirror, "fetch", "--no-tags", "--quiet", "origin",
    `+refs/pull/${pr.number}/head:${head}`,
    `+refs/heads/${pr.baseRefName}:${base}`,
  ]);
  const range = `${base}...${head}`;
  const diffSummary = await run("git", ["-C", mirror, "diff", "--no-color", "--stat", range]);
  const diff = await run("git", ["-C", mirror, "diff", "--no-color", "--no-ext-diff", range]);
  return { diffSummary, diff };
}

async function callReviewModel(prompt: string): Promise<string> {
  return run("claude", ["-p", "--model", REVIEW_MODEL], { stdin: new Blob([prompt]) });
}

function indexLine(pr: OpenPr, status: string): string {
  const draft = pr.isDraft ? " [draft]" : "";
  return `- #${pr.number}${draft} ${pr.title} (${status}) ${pr.url}`;
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv, defaultOutDir());
  // Raw config, not `remote get-url`: that one returns URLs rewritten by insteadOf.
  const origin = (await run("git", ["config", "--get", "remote.origin.url"])).trim();
  const repo = repoFromRemote(origin);
  if (!repo) throw new Error(`origin (${origin}) is not a GitHub remote`);

  const listing = await run("gh", [
    "pr", "list", "--repo", repo, "--state", "open", "--limit", String(options.limit),
    "--json", "number,title,url,headRefName,baseRefName,isDraft,updatedAt",
  ]);
  const pullRequests = parseOpenPullRequests(listing);
  const reviewsDir = join(options.out, "reviews");
  await mkdir(reviewsDir, { recursive: true });

  if (pullRequests.length === 0) {
    console.log(`No open pull requests in ${repo}.`);
    return 0;
  }

  const mirror = join(options.out, "mirror.git");
  await ensureMirror(mirror, origin);

  const failures: string[] = [];
  const lines: string[] = [];
  for (const pr of pullRequests) {
    try {
      const { diffSummary, diff } = await fetchAndDiff(mirror, pr);
      const prompt = buildReviewPrompt(pr, diffSummary, diff, DEFAULT_DIFF_CHARS);
      const promptFile = join(reviewsDir, `pr-${pr.number}.prompt.md`);
      await writeFile(promptFile, prompt);
      if (options.runHaiku) {
        const review = await callReviewModel(prompt);
        await writeFile(join(reviewsDir, `pr-${pr.number}.review.md`), review);
        lines.push(indexLine(pr, `reviewed on ${REVIEW_MODEL}`));
      } else {
        lines.push(indexLine(pr, `prompt ${promptFile}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`#${pr.number}: ${message}`);
      lines.push(indexLine(pr, "FAILED"));
    }
  }

  const header = `# Open pull requests of ${repo}\n\nPrepared ${new Date().toISOString()}.\n`;
  await writeFile(join(options.out, "index.md"), `${header}\n${lines.join("\n")}\n`);
  console.log(`${pullRequests.length} open PR(s) of ${repo} in ${options.out}`);
  if (!options.runHaiku) {
    console.log("Dry run: prompts only. Add --run-haiku to call the model (spends tokens).");
  } else if (failures.length === 0) {
    console.log("Reviews written next to the prompts.");
  }
  for (const failure of failures) console.error(`FAILED ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
