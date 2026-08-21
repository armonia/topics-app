#!/usr/bin/env bun
/**
 * Block a push that would republish the names we removed from the history.
 *
 * THE HOLE THIS CLOSES. On 2026-08-21 the whole public history was rewritten to
 * take two client names out of it, and `origin/main` came out clean. What did
 * NOT change is every local branch: 223 of them still descend from the old
 * commits, and 57 worktrees have one checked out. Pushing any of them puts the
 * names back on a public repo, and until today nothing would have said a word:
 * `tests/unit/no-personal-data-tracked.test.ts` reads the TREE (the files as
 * they are now), and a push publishes the HISTORY (every commit behind the tip).
 * Those are different questions, and only the second one was unguarded.
 *
 * WHAT IT MEASURES. Not "is this branch clean" but "is what I am about to ADD
 * to the remote clean": `<tip> --not --remotes=<remote>`. Commits already on the
 * remote are excluded on purpose. They are published either way, and re-checking
 * them here would turn every push of an old branch into a red that says nothing
 * about this push.
 *
 * AN EMPTY LIST IS NOT A GREEN. `.personal-terms` is untracked, so in CI and on
 * a fresh clone there is nothing to look for and this exits 0 immediately. It
 * guards the machine that has the list, which is the machine that has the names.
 *
 * Usage:
 *   ... | bun run scripts/check-push-clean.ts <remote>   # git's pre-push protocol
 *   bun run scripts/check-push-clean.ts --range main --not origin/main
 */
import { execFileSync } from "node:child_process";
import { personalTerms, personalTermsPath } from "./personal-terms.ts";

/** The repo we are pushing FROM, not the one this file happens to live in.
 *  git runs hooks from the top level of the working tree, and in a worktree the
 *  two are different trees; resolving from cwd also lets the tests point the
 *  gate at a throwaway repo, which is the only way to watch it turn red. */
function repoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return new URL("..", import.meta.url).pathname;
  }
}

const ROOT = repoRoot();
const ZERO = /^0+$/;

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

/** Commits carrying `term`, in content or in the message. Both questions matter:
 *  a name written in a commit message touches no blob, so `-S` alone never sees
 *  it (measured during the real rewrite: 15 messages survived a `-S`-clean run). */
function hits(term: string, range: string[]): string[] {
  const content = git("log", "--format=%H", "-S", term, ...range);
  const message = git("log", "--format=%H", "--grep", term, ...range);
  return [...new Set([...content.split("\n"), ...message.split("\n")].filter(Boolean))];
}

function describe(sha: string): string {
  return git("log", "-1", "--format=%h %s", sha).trim() || sha.slice(0, 9);
}

async function ranges(): Promise<Array<{ label: string; range: string[] }>> {
  const explicit = process.argv.indexOf("--range");
  if (explicit !== -1) {
    const rest = process.argv.slice(explicit + 1);
    return rest.length ? [{ label: rest.join(" "), range: rest }] : [];
  }

  // git's pre-push protocol: "<local ref> <local sha> <remote ref> <remote sha>"
  const remote = process.argv[2] || "origin";
  const stdin = await Bun.stdin.text();
  const out: Array<{ label: string; range: string[] }> = [];
  for (const line of stdin.split("\n")) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // branch deletion: nothing published
    out.push({
      label: `${localRef || localSha} -> ${remoteRef || "?"}`,
      range: [localSha, "--not", `--remotes=${remote}/*`],
    });
  }
  return out;
}

const terms = personalTerms(ROOT);
if (terms.length === 0) {
  // Silent on purpose: this is the normal state in CI, and a gate that prints a
  // reassuring line when it is not looking at anything teaches people to trust it.
  process.exit(0);
}

const work = await ranges();
if (work.length === 0) process.exit(0);

let dirty = 0;
for (const { label, range } of work) {
  const count = git("rev-list", "--count", ...range).trim() || "0";
  for (const term of terms) {
    const found = hits(term, range);
    if (found.length === 0) continue;
    dirty += found.length;
    console.error(`\n✗ ${label} pubblicherebbe ${found.length} commit con un nome che era stato tolto:`);
    for (const sha of found.slice(0, 10)) console.error(`    ${describe(sha)}`);
    if (found.length > 10) console.error(`    ... e altri ${found.length - 10}`);
  }
  if (dirty === 0 && process.env.TOPICS_PUSH_GUARD_VERBOSE) {
    console.error(`[push-guard] ${label}: ${count} commit, puliti`);
  }
}

if (dirty > 0) {
  console.error(`
Il push e' fermo. Questo ramo discende dalla storia PRIMA della riscrittura del
21/08: pubblicarlo rimette i nomi su un repo pubblico, indipendentemente da
com'e' l'albero di oggi.

Come uscirne, in ordine di preferenza:
  1. rifai il lavoro sopra la storia nuova:
       git rebase --onto origin/main $(git merge-base HEAD origin/main) HEAD
  2. se il ramo e' gia' landato, cancellalo invece di pubblicarlo
  3. se sai cosa stai facendo:  git push --no-verify

L'elenco dei nomi sta in ${personalTermsPath(ROOT)} (non tracciato).`);
  process.exit(1);
}
process.exit(0);
