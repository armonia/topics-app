import type { GitRunResult } from "./task-automerge";

/**
 * The land gate for commit attribution. A branch is refused when one of its
 * commits carries a `Co-Authored-By` trailer naming Claude/Anthropic, or when
 * its author is not the identity the repo is configured with. The agents are
 * started with the attribution switched off, so this is the net under that
 * switch: a commit made by hand, or by an older session, still cannot reach main.
 */

const CLAUDE_TRAILER = /^\s*co-authored-by:.*\b(claude|anthropic)\b/im;

export type RunGit = (cwd: string, args: string[]) => Promise<GitRunResult>;

const FIELD = "\x1f";
const RECORD = "\x1e";

/** The refusal sentence for the card, or null when every commit is clean. */
export async function attributionViolation(
  runGit: RunGit,
  repoPath: string,
  range: string[],
): Promise<string | null> {
  const log = await runGit(repoPath, [
    "log", "--no-merges", `--format=%h${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`, ...range,
  ]);
  if (log.code !== 0) return null;

  const name = (await runGit(repoPath, ["config", "user.name"])).stdout.trim();
  const email = (await runGit(repoPath, ["config", "user.email"])).stdout.trim();

  const trailers: string[] = [];
  const authors: string[] = [];
  for (const rec of log.stdout.split(RECORD)) {
    if (rec.trim() === "") continue;
    const [sha, an, ae, ...rest] = rec.trim().split(FIELD);
    const body = rest.join(FIELD);
    if (CLAUDE_TRAILER.test(body)) trailers.push(sha);
    const foreign = (email !== "" && ae.toLowerCase() !== email.toLowerCase())
      || (name !== "" && an !== name);
    if (foreign) authors.push(`${sha} (${an} <${ae}>)`);
  }
  if (trailers.length === 0 && authors.length === 0) return null;

  const parts: string[] = [];
  if (trailers.length > 0) parts.push(`commit con la riga Co-Authored-By di Claude: ${trailers.join(", ")}`);
  if (authors.length > 0) {
    parts.push(`commit con un autore diverso dall'identità del repo (${name} <${email}>): ${authors.join(", ")}`);
  }
  return `attribuzione non ammessa, ${parts.join("; ")}`;
}
