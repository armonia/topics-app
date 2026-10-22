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

/** A guard that cannot measure must not let the push through: for this script
 *  `""` from a failed `git` would mean "no dirty commits", i.e. it would fail
 *  OPEN, which is the one direction a guard may never fail. */
const cannotMeasure: string[] = [];

function gitMeasure(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const raw = (error as { stderr?: string | Buffer }).stderr?.toString() ?? String(error);
    let first = raw.split("\n")[0] ?? "";
    // The names are the one thing a guard must never print.
    for (const term of terms) first = first.split(term).join("«termine»");
    cannotMeasure.push(`git ${args[0]} ${args[1]}: ${first}`);
    return "";
  }
}

/** Commits carrying `term`, in content or in the message. Both questions matter:
 *  a name written in a commit message touches no blob, so `-S` alone never sees
 *  it (measured during the real rewrite: 15 messages survived a `-S`-clean run).
 *
 *  `-F` is not decoration: `--grep` is a REGEX, so a term carrying `[`, `(` or
 *  `.` matched NOTHING in the messages and the guard exited 0 on a commit whose
 *  message held the name. Measured 22/10/2026 with `Acme [Milano] srl`: 0 hits
 *  without `-F`, 1 with it. `-S` is a fixed string already. The trailing `--`
 *  closes the rev list, so a path spelled like a ref cannot turn the whole
 *  question into a fatal that `git()` would have swallowed into zero. */
function hits(term: string, range: string[]): string[] {
  const content = gitMeasure("log", "--format=%H", "-S", term, ...range, "--");
  const message = gitMeasure("log", "--format=%H", "-F", "--grep", term, ...range, "--");
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
  // Two different causes, and the old text asserted only one of them: a branch
  // that descends from the pre-21/08 history, and a commit written TODAY that
  // simply contains the term (which is the normal case for a forward-only
  // term). Telling someone to rebase onto main when they just typed the name
  // five minutes ago sends them to fix the wrong thing, and leaves
  // `--no-verify` — which disables the guard for every term in that push — as
  // the only remedy that seems to apply.
  console.error(`
Il push e' fermo: pubblicherebbe dei commit che contengono un nome dell'elenco,
indipendentemente da com'e' l'albero di oggi.

Se il nome l'hai scritto TU in questi commit (contenuto o messaggio):
  1. toglilo e riscrivi i commit:  git rebase -i origin/main   (reword/edit)

Se il ramo discende dalla storia PRIMA della riscrittura del 21/08:
  2. rifai il lavoro sopra la storia nuova:
       git rebase --onto origin/main $(git merge-base HEAD origin/main) HEAD
  3. se il ramo e' gia' landato, cancellalo invece di pubblicarlo

  4. ultima spiaggia, e vale per TUTTI i termini di questo push:
       git push --no-verify

L'elenco dei nomi sta in ${personalTermsPath(ROOT)} (non tracciato).`);
  process.exit(1);
}
if (cannotMeasure.length > 0) {
  // Fail closed: nothing was found, but nothing was looked at either.
  console.error("\n✗ il controllo non ha potuto misurare, quindi il push e' fermo:");
  for (const why of [...new Set(cannotMeasure)]) console.error(`    ${why}`);
  console.error("  se sai cosa stai facendo:  git push --no-verify");
  process.exit(1);
}
process.exit(0);
