/**
 * The attribution gate of the land (LAND-13).
 *
 * The owner of the repo never wants a commit that credits an AI assistant:
 * no `Co-Authored-By: Claude` trailer, no assistant as the author. The agents
 * of the board start with attribution off (`claude/args.ts`), and this is the
 * second line: a branch that carries one is not landed, and the card says which
 * commit and why. Nothing is rewritten here; the agent fixes its own branch.
 */
import type { GitRunResult } from "./task-automerge";

type RunGit = (cwd: string, args: string[]) => Promise<GitRunResult>;

export interface AttributionViolation {
  sha: string;
  why: string;
}

const FIELD = "\u001f";
const RECORD = "\u001e";

/** `Co-Authored-By: <an assistant>` and the "Generated with" footer. */
const ASSISTANT_TRAILER = /^\s*(co-authored-by:.*(claude|anthropic)|.*generated with \[?claude)/im;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * The commits of `range` (minus `exclude`) that carry an assistant trailer or an
 * author other than the repo identity. `null` = git did not answer: the caller
 * decides (the land treats it as "cannot read", never as "clean").
 */
export async function findAttributionViolations(
  repoPath: string,
  range: string,
  exclude: readonly string[],
  runGit: RunGit,
): Promise<AttributionViolation[] | null> {
  const userMail = await runGit(repoPath, ["config", "user.email"]);
  const name = await runGit(repoPath, ["config", "user.name"]);
  const identity = { email: norm(userMail.stdout), name: norm(name.stdout) };

  const log = await runGit(repoPath, [
    "log", `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`, range,
    ...(exclude.length ? ["--not", ...exclude] : []),
  ]);
  if (log.code !== 0) return null;

  const out: AttributionViolation[] = [];
  for (const entry of log.stdout.split(RECORD)) {
    const [sha, an, ae, body] = entry.trim().split(FIELD);
    if (!sha) continue;
    const short = sha.slice(0, 9);
    if (ASSISTANT_TRAILER.test(body ?? "")) {
      out.push({ sha: short, why: "il messaggio porta la riga di attribuzione a un assistente (Co-Authored-By)" });
      continue;
    }
    const foreignMail = identity.email !== "" && norm(ae ?? "") !== identity.email;
    const foreignName = identity.email === "" && identity.name !== "" && norm(an ?? "") !== identity.name;
    if (foreignMail || foreignName) {
      out.push({ sha: short, why: `l'autore è '${an} <${ae}>', non l'identità del repo` });
    }
  }
  return out;
}
