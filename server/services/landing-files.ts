/**
 * The paths an automatic land would bring to main: what the merge carries, not
 * what the own-commit count remembers.
 *
 * `ownBranchFiles` (routes/tasks.ts) walks `listOwnCommits`, which leaves out
 * the commit the pruning writes to save a dirty worktree (`RESIDUE_SUBJECT`) and
 * every commit another local branch can reach. The merge brings both, so a
 * path-based verdict built on that walk can miss a file that lands. Here the
 * answer is the diff between the merge base with main and the tip: the files
 * whose content the merge adds, changes or removes, nothing left out.
 *
 * `tip` is the exact commit the land will merge (the card's delivery commit), so
 * the verdict is about the object that lands and not about a branch name that
 * can move under it. A branch name still works, for callers with no commit.
 *
 * `--no-renames` so a rename shows both paths; `null` = git could not answer,
 * and a land that does not know what it changes does not happen.
 */
import { defaultRunGit, type GitRunner } from "./own-commits";

const HEX_SHA = /^[0-9a-f]{7,64}$/i;

export async function landingFiles(
  repoPath: string,
  tip: string,
  opts: { mainRef?: string; runGit?: GitRunner } = {},
): Promise<string[] | null> {
  const run = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  const target = tip.trim();
  if (!target) return null;
  // `refs/heads/` so a branch named like a file cannot make the range ambiguous;
  // a commit is used as git resolves it (the full sha, even if given abbreviated).
  let end = `refs/heads/${target}`;
  if (HEX_SHA.test(target)) {
    const commit = await run(repoPath, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
    if (commit.code === 0 && commit.stdout.trim()) end = commit.stdout.trim();
  }
  const res = await run(repoPath, ["diff", "--name-only", "--no-renames", "-z", `refs/heads/${mainRef}...${end}`, "--"]);
  if (res.code !== 0) return null;
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

/** What runs or configures the bar: a file named in any of these is part of the judge, not a test or a note. */
const JUDGE_PLACES = ["bunfig.toml", "scripts", "package.json", ".github"];

/** Code is named without its extension in an import (`./helpers/time-slack`), a document with it. */
const withoutCodeExtension = (path: string): string => path.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");

/**
 * Which of `files` are NAMED, as of `commit`, by `bunfig.toml`, `scripts/`,
 * `package.json` or `.github/`. Such a file is loaded, run or read by the bar
 * itself: a test file that the preload imports changes what every run does, and a
 * document a CI script parses changes what that script says. Matching is by the
 * repo-relative path, extension left out for code (imports omit it), and errs
 * wide: a path that is only a prefix of a longer name counts as named.
 *
 * `null` = git could not answer, and a land that cannot tell does not happen.
 */
export async function referencedByTheJudge(
  repoPath: string,
  commit: string,
  files: readonly string[],
  opts: { runGit?: GitRunner } = {},
): Promise<string[] | null> {
  if (files.length === 0) return [];
  const run = opts.runGit ?? defaultRunGit;
  const resolved = await run(repoPath, ["rev-parse", "--verify", "--quiet", `${commit.trim()}^{commit}`]);
  const sha = resolved.stdout.trim();
  if (resolved.code !== 0 || !sha) return null;
  const named = new Set<string>();
  const CHUNK = 40;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const args = ["grep", "-h", "-o", "-F", ...chunk.flatMap((f) => ["-e", withoutCodeExtension(f)]), sha, "--", ...JUDGE_PLACES];
    const res = await run(repoPath, args);
    // 1 = no match anywhere in this chunk; anything else but 0 is a git that did not answer.
    if (res.code === 1) continue;
    if (res.code !== 0) return null;
    const hits = new Set(res.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    for (const f of chunk) if (hits.has(withoutCodeExtension(f))) named.add(f);
  }
  return files.filter((f) => named.has(f));
}
