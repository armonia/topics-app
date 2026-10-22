/**
 * The list of names that must never reach the public repo, in one place.
 *
 * WHY A MODULE AND NOT A `readFileSync` IN EACH CALLER. Two gates read this
 * list (`scrub-history.ts` measures the published history, `check-push-clean.ts`
 * blocks a push that would republish it) and a third would be one copy too
 * many: the day the file grows a comment syntax or moves, a caller that parses
 * it by hand goes quietly blind, and a blind gate is worse than no gate.
 *
 * `.personal-terms` is deliberately NOT tracked: a file listing what must be
 * hidden, inside the repo it must be hidden from, is the leak it claims to
 * close. It is therefore normal for this to return an empty list on a fresh
 * clone or in CI. An empty list means "nothing to look for here", not "clean".
 *
 * TOPICS_PERSONAL_TERMS overrides the path. It exists so the tests can hand the
 * gate a list of their own invented names: a gate whose only input is a file
 * that must not exist in CI could never be shown to turn red.
 *
 * THE FILE FORMAT, documented here because `.personal-terms` is untracked and
 * therefore cannot carry its own legend where anyone would find it.
 *
 *   One term per line. `#` starts a comment, blank lines are ignored.
 *
 *   A line starting with `>` is FORWARD-ONLY: block it in commits that have not
 *   been pushed yet, but do not fail the published-history gate over it.
 *
 *     Acme Industries          # blocked everywhere, history included
 *     > /Users/someone         # blocked in new commits; already published
 *
 * WHY FORWARD-ONLY EXISTS. Without it the list has exactly one tier: a term in
 * it that already appears in the published history makes `check:history-clean`
 * red forever, because the only cure would be a history rewrite — and a rewrite
 * is measured not to help, since GitHub keeps serving objects by SHA after a
 * force-push (31 commits from the 21/08/2026 rewrite were still reachable 62
 * days later). So a term worth blocking GOING FORWARD could not be added at
 * all, and the obvious candidate stayed out of the list for two months: the
 * author's home directory path, which then leaked into a launchd plist in
 * PR #405 with nothing looking for it. One tier meant the choice was "red
 * forever" or "unguarded", and unguarded always won.
 *
 * The marker is a prefix and not a section header because the file grows at the
 * end, and a positional header breaks on the first term appended after it. Two
 * limits come with that choice and are deliberate: a term that itself begins
 * with `>` cannot be written (no name or path does), and `>` alone is dropped
 * like any empty line.
 *
 * The two gates read the same list and ask different questions of it, so the
 * marker lands in only one of them: `scrub-history.ts --check` reports a
 * forward-only term as a known exposure with its count instead of failing,
 * while `check-push-clean.ts` refuses it in commits not yet pushed, message
 * included. Nothing about the marker weakens the push guard, which is the
 * half that can still prevent something.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A LINKED WORKTREE READS THE LIST OF ITS MAIN CHECKOUT. The file is untracked,
 * so a worktree never has its own copy, and the push guard resolves `root` as
 * the worktree's top level: until 15/09/2026 every push from a worktree looked
 * for the list where it cannot be, found nothing and exited 0. That includes
 * the push the board makes on delivery (server/services/ci-evidence.ts), which
 * publishes the intermediate commits of a card before anyone reviews them.
 */
export function personalTermsPath(root: string): string {
  if (process.env.TOPICS_PERSONAL_TERMS) return process.env.TOPICS_PERSONAL_TERMS;
  const own = join(root, ".personal-terms");
  if (existsSync(own)) return own;
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const shared = join(dirname(common), ".personal-terms");
    if (common && existsSync(shared)) return shared;
  } catch { /* not a git checkout: only the root's own file can exist */ }
  return own;
}

export type PersonalTerm = {
  term: string;
  /** Blocked in commits not yet pushed, but not a failure of the published-history gate. */
  forwardOnly: boolean;
};

/** The marker that opens a forward-only line. See the file format above. */
const FORWARD_ONLY_MARK = ">";

export function personalTermEntries(root: string): PersonalTerm[] {
  const file = personalTermsPath(root);
  if (!existsSync(file)) return [];
  const entries: PersonalTerm[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const forwardOnly = line.startsWith(FORWARD_ONLY_MARK);
    const term = forwardOnly ? line.slice(FORWARD_ONLY_MARK.length).trim() : line;
    if (term) entries.push({ term, forwardOnly });
  }
  return entries;
}

/**
 * Every term, marker stripped. This is what a caller wants when the answer is
 * the same for both tiers — the push guard blocks forward-only terms exactly
 * like the rest, which is the whole point of marking them.
 */
export function personalTerms(root: string): string[] {
  return personalTermEntries(root).map((entry) => entry.term);
}
