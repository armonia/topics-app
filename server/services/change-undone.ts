/**
 * WAS THIS CHANGE UNDONE ON MAIN?
 *
 * Ancestry says a commit is in main's history; it does not say its content is
 * still there. The incident of card 48588f6e (2026-11-12): the GC merged a card
 * closed without a land (`3be5ccbad merge task 48588f6e`), a person reverted it
 * by hand (`dc45baa74`, not a `git revert`, so no "This reverts commit" line to
 * grep), both reached origin, and every check kept reading `landed`: the merge
 * was an ancestor, and the land merge carried the card's name.
 *
 * The question asked here is the mirror of `contenutoGiaNellAlbero`: does the
 * change's diff apply FORWARD on main's tree? If it does, every line it adds is
 * absent and every line it removes is present, which is what "undone" means.
 * A change that landed and was later edited by other work does not apply
 * forward (its added files exist, its removed lines are gone), so a busy file
 * is not mistaken for a revert. The opposite question, "is it all still there",
 * would accuse every landed card whose files somebody touched afterwards.
 *
 * Only meaningful AFTER something said the change reached main: on a change
 * that never arrived, "applies forward" is just as true and means nothing new.
 *
 * `null` = cannot tell (empty diff, git error, binary patch). Never `false`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunGit, type GitRunner } from "./own-commits";

export async function changeUndoneOn(
  repoPath: string,
  base: string,
  tip: string,
  mainRef: string,
  runGit: GitRunner = defaultRunGit,
): Promise<boolean | null> {
  const diff = await runGit(repoPath, ["diff", "--no-color", base, tip]).catch(() => null);
  if (!diff || diff.code !== 0 || !diff.stdout.trim()) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "change-undone-"));
    const patch = join(dir, "change.patch");
    await writeFile(patch, diff.stdout);
    // A private index holds main's tree: the answer must not depend on what
    // the checkout has on disk, and nothing in the repo is written.
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if ((await runGit(repoPath, ["read-tree", mainRef], { env })).code !== 0) return null;
    const check = await runGit(repoPath, ["apply", "--cached", "--check", patch], { env });
    if (check.code === 0) return true;
    return /without full index line|binary patch/i.test(check.stderr ?? "") ? null : false;
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Above this many hunks the per-hunk question is not asked: "cannot tell". */
const MAX_HUNKS = 200;

/** One patch per hunk, each with its file's header, so each can be applied on its own. */
export function splitIntoHunks(diff: string): string[] {
  const out: string[] = [];
  for (const file of diff.split(/^(?=diff --git )/m)) {
    if (!file.startsWith("diff --git ")) continue;
    const at = file.search(/^@@ /m);
    if (at < 0) continue;
    const header = file.slice(0, at);
    for (const hunk of file.slice(at).split(/^(?=@@ )/m)) if (hunk.startsWith("@@ ")) out.push(header + hunk);
  }
  return out;
}

/** How many times each line occurs in a text. */
function lineCounts(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of text.split("\n")) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

/** The lines a hunk removes and adds, without the `-`/`+` marks. */
function hunkLines(hunk: string): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const l of hunk.slice(hunk.search(/^@@ /m)).split("\n").slice(1)) {
    if (l.startsWith("-")) removed.push(l.slice(1));
    else if (l.startsWith("+")) added.push(l.slice(1));
  }
  return { removed, added };
}

/** `diff --git a/x b/x` → `x` (the b side: the path on the branch's tip). */
function hunkPath(hunk: string): string | null {
  const m = /^\+\+\+ b\/(.*)$/m.exec(hunk) ?? /^--- a\/(.*)$/m.exec(hunk);
  return m ? m[1]! : null;
}

/**
 * IS ANY PART OF THIS CHANGE UNDONE ON MAIN? Asked hunk by hunk, for a squash C that held it.
 *
 * Main may take back one of the branch's two edits in a file (15/11, verifier on #1113): every
 * file-level check still says "there". Applying hunks either way fails once a neighbouring line
 * moved, and pairing a hunk's `-` and `+` lines by position is wrong as soon as git puts an
 * inserted line before a replaced one. So the rule is the plain one: the work is still there only
 * if every line the branch added is on main and no line it replaced came back. Main that went on
 * to rewrite one of the card's own lines therefore reads "undone" too: the land goes on, and the
 * worst case is a conflict a person sees.
 *
 * `true` = some hunk was undone · `false` = none was · `null` = cannot tell (empty or binary
 * diff, too many hunks, git error). Only `false` may close a card as "nothing to land".
 */
export async function someHunkUndoneOn(
  repoPath: string,
  base: string,
  tip: string,
  mainRef: string,
  paths: readonly string[],
  runGit: GitRunner = defaultRunGit,
): Promise<boolean | null> {
  const diff = await runGit(repoPath, ["diff", "--no-color", "--no-renames", base, tip, "--", ...paths]).catch(() => null);
  if (!diff || diff.code !== 0 || !diff.stdout.trim()) return null;
  if (/^Binary files /m.test(diff.stdout)) return null;
  const hunks = splitIntoHunks(diff.stdout);
  if (hunks.length === 0 || hunks.length > MAX_HUNKS) return null;
  const show = async (ref: string, path: string): Promise<string | null> => {
    const r = await runGit(repoPath, ["show", `${ref}:${path}`]).catch(() => null);
    return r && r.code === 0 ? r.stdout : null;
  };
  const files = new Map<string, { onMain: Map<string, number> | null; onTip: Map<string, number> }>();
  try {
    for (const hunk of hunks) {
      const path = hunkPath(hunk);
      if (!path) return null;
      let f = files.get(path);
      if (!f) {
        const m = await show(mainRef, path);
        const t = await show(tip, path);
        f = { onMain: m === null ? null : lineCounts(m), onTip: lineCounts(t ?? "") };
        files.set(path, f);
      }
      const { removed, added } = hunkLines(hunk);
      // The branch's file is gone from main: everything the hunk added went with it.
      if (f.onMain === null) { if (added.length > 0 || removed.length === 0) return true; continue; }
      const main = f.onMain;
      const tipCounts = f.onTip;
      // Blank lines come and go with every edit: they say nothing about a revert.
      const back = (l: string) => l.trim() !== "" && (main.get(l) ?? 0) > (tipCounts.get(l) ?? 0);
      const gone = (l: string) => l.trim() !== "" && (main.get(l) ?? 0) < (tipCounts.get(l) ?? 0);
      // Any line the card added that main no longer has, or any line it replaced that came back.
      // Main rewriting one of the card's own lines reads the same as taking it back, and goes on
      // with the land too: a conflict reaches a person, a wrong "nothing" loses the work quietly.
      // Counting a line over the whole file only proves something when the line is unique there:
      // a `return null;` the card added can leave and come back elsewhere with the count unchanged.
      // An added line seen more than once on the tip, or a replaced line still present on it, makes
      // the hunk unreadable: "cannot tell", so the land goes on and a person sees any conflict.
      const real = (l: string) => l.trim() !== "";
      if (added.some((l) => real(l) && (tipCounts.get(l) ?? 0) > 1)) return null;
      if (removed.some((l) => real(l) && (tipCounts.get(l) ?? 0) > 0)) return null;
      if (removed.some(back) || added.some(gone)) return true;
    }
    return false;
  } catch {
    return null;
  }
}
