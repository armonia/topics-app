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
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function personalTermsPath(root: string): string {
  return process.env.TOPICS_PERSONAL_TERMS || join(root, ".personal-terms");
}

export function personalTerms(root: string): string[] {
  const file = personalTermsPath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.split("#")[0]!.trim())
    .filter(Boolean);
}
