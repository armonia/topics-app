#!/usr/bin/env bun
/**
 * scripts/check-repo-pulito.ts - the work is done when NOTHING IS LEFT.
 *
 * WHY IT EXISTS. On 19/09 the same instruction had to be repeated three times
 * in one session: "close and merge or clean up EVERYTHING". Each round ended
 * with a report saying it was done, and each time something was still open:
 * first 36 worktrees and 79 branches, then 215 local branches "left on
 * purpose", then nine stashes from August nobody had even looked at. Every
 * single time the claim came before the count.
 *
 * The problem is not the leftovers, it is that FINISHED was declared by a
 * narrator instead of by a measurement. A human should not have to be the
 * integration test for "is the repo clean".
 *
 * So this is the count, and it runs in the same chain as the other rails.
 *
 * WHAT IT REFUSES, and each of these was a real leftover of that session:
 *
 *  - branches other than main. The convention is `archive/<name>`: a tag keeps
 *    the work reachable forever and costs nothing, a branch keeps it in the
 *    way. `git branch <name> archive/<name>` brings one back.
 *  - stashes. A stash is invisible: it does not show up in `git status`, it is
 *    not on any branch, and after three weeks nobody remembers what is in it.
 *    Nine of them had been sitting there since August.
 *  - worktrees beyond the main checkout. They hold gigabytes and hide their own
 *    dirty state.
 *  - a dirty or unpushed main.
 *
 * WHAT IT DOES NOT DO: it says nothing about open pull requests. That is
 * deliberate - a PR waiting for review is work in flight, not a leftover, and a
 * gate that pushed toward merging it would be pushing in the wrong direction.
 *
 * DEROGATION: `TOPICS_PULITO_OK=1` skips it, for the middle of a rebase where
 * a backup branch is the point. It is not meant for "I will tidy up later".
 *
 * `--in-push <sha...>`: INSIDE the pre-push hook the commits git is about to
 * publish are still "unpushed" as far as `git rev-list` is concerned, so every
 * push printed the very work it was delivering as a leftover (seen 20/09: two
 * commits reported by the same command that was pushing them). A warning that
 * shows up ALWAYS teaches people not to read it, and that is how this gate
 * dies. Given the incoming shas the count looks at `main` MINUS those commits:
 * if something unpushed is still left - a branch the push does not touch - it
 * still says so.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";

/** One leftover found in the repo, with the way to remove it. */
interface Leftover {
  what: string;
  lines: string[];
  remedy: string;
}

const MAX_LISTED = 12;

/** A git object and nothing else: these values end up inside `sh -c`. */
const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * The shas this push is publishing, from `--in-push`. Anything that is not a
 * sha is dropped: the value comes from git's hook protocol and goes through a
 * shell. An all-zero sha (a branch deletion) publishes nothing.
 */
function inPushShas(): string[] {
  const at = process.argv.indexOf("--in-push");
  if (at === -1) return [];
  return process.argv
    .slice(at + 1)
    .filter((a) => SHA.test(a) && !/^0+$/.test(a));
}

async function sh(cmd: string): Promise<string> {
  try {
    return (await $`sh -c ${cmd}`.quiet().text()).trim();
  } catch {
    return "";
  }
}

/** Every non-empty line, trimmed. */
function lines(s: string): string[] {
  return s.split("\n").map((r) => r.trim()).filter(Boolean);
}

async function collect(): Promise<Leftover[]> {
  const found: Leftover[] = [];

  const branches = lines(await sh("git branch --format='%(refname:short)'")).filter((b) => b !== "main");
  if (branches.length > 0) {
    found.push({
      what: `${branches.length} ramo/i oltre main`,
      lines: branches,
      // `report:branches` (scripts/branch-audit.ts) is the tool that decides
      // WHICH of these can go: it compares content file by file, because
      // delivery lands as a squash and `git branch --merged` calls a landed
      // branch alive forever. This gate only counts them, and hands over.
      remedy:
        "chiedi a chi sa quali sono davvero dentro:\n" +
        "    bun run report:branches\n" +
        "  poi, per ognuno da togliere, archivia prima di cancellare:\n" +
        "    git tag archive/$(echo <ramo> | tr / -) <ramo> && git branch -D <ramo>\n" +
        "  il lavoro resta raggiungibile: git branch <nome> archive/<nome>",
    });
  }

  const stash = lines(await sh("git stash list"));
  if (stash.length > 0) {
    found.push({
      what: `${stash.length} stash`,
      lines: stash,
      remedy:
        "archiviali e svuota la lista:\n" +
        "    git tag archive/stash-$(date +%Y%m%d)-$(git rev-parse --short stash@{0}) stash@{0}\n" +
        "    git stash clear\n" +
        "  si rileggono con: git stash show -p <tag>",
    });
  }

  // `git worktree list` always prints the main checkout: only the others count.
  const wt = lines(await sh("git worktree list")).slice(1);

  // GHOSTS FIRST, because they are the free half of the problem. A worktree
  // whose folder is gone is a registration git still carries: it costs no disk
  // and holds no work, and `git worktree prune` removes it without a decision.
  // Lumping it in with the real ones hides a fix that needs no thought behind
  // one that does - found on 20/09, when six of eight worktrees across the box
  // were ghosts (tdh had five).
  const ghosts: string[] = [];
  const real: string[] = [];
  for (const line of wt) {
    const path = line.split(/\s+/)[0] ?? "";
    (path && !existsSync(path) ? ghosts : real).push(line);
  }

  if (ghosts.length > 0) {
    found.push({
      what: `${ghosts.length} worktree FANTASMA (cartella sparita, registrazione rimasta)`,
      lines: ghosts,
      remedy: "gratis, non c'e' niente da salvare:\n    git worktree prune",
    });
  }

  if (real.length > 0) {
    found.push({
      what: `${real.length} worktree oltre il checkout principale`,
      lines: real,
      // ARCHIVE BEFORE REMOVING, and the reason is measured: of the 16 removed
      // on 20/09, ten carried commits that were NOT in main (up to 6 each).
      // "The agent finished" does not mean "the work landed".
      remedy:
        "prima guarda se dentro c'e' lavoro:\n" +
        "    cd <percorso> && git log --oneline main..HEAD && git status --porcelain\n" +
        "  poi archivia e rimuovi:\n" +
        "    git tag archive/wt-<nome> $(cd <percorso> && git rev-parse HEAD)\n" +
        "    git worktree remove --force <percorso>",
    });
  }

  const uncommitted = lines(await sh("git status --porcelain"));
  if (uncommitted.length > 0) {
    found.push({
      what: `${uncommitted.length} file non committati`,
      lines: uncommitted,
      remedy: "committa, oppure mettili in .gitignore se non devono stare qui",
    });
  }

  // Only when an upstream exists: a main without a remote is not a leftover.
  const upstream = await sh("git rev-parse --abbrev-ref main@{upstream} 2>/dev/null");
  if (upstream) {
    // `--not <sha>` drops what the push is publishing RIGHT NOW: without it the
    // pre-push hook reports its own payload as a leftover (see the head).
    const excluded = inPushShas().flatMap((sha) => ["--not", sha]);
    const avanti = await sh(
      `git rev-list --count ${upstream}..main ${excluded.join(" ")}`.trim(),
    );
    if (avanti && avanti !== "0") {
      found.push({
        what: `main ha ${avanti} commit non spinti`,
        lines: lines(
          await sh(
            `git log --oneline ${upstream}..main ${excluded.join(" ")} | head -5`.trim(),
          ),
        ),
        remedy: "git push",
      });
    }
  }

  return found;
}

if (import.meta.main) {
  if (process.env.TOPICS_PULITO_OK === "1") {
    console.log("[check-repo-pulito] saltato (TOPICS_PULITO_OK=1)");
    process.exit(0);
  }

  const found = await collect();

  if (found.length === 0) {
    console.log("[check-repo-pulito] solo main, niente stash, una worktree, niente da committare.");
    process.exit(0);
  }

  console.error("[check-repo-pulito] il repo non e' pulito:\n");
  for (const r of found) {
    console.error(`  ${r.what}`);
    for (const line of r.lines.slice(0, MAX_LISTED)) console.error(`      ${line}`);
    if (r.lines.length > MAX_LISTED) console.error(`      ... e altri ${r.lines.length - MAX_LISTED}`);
    console.error(`    -> ${r.remedy}\n`);
  }
  console.error(
    "Niente di tutto questo va cancellato e basta: si archivia come tag `archive/...`,\n" +
    "cosi' il lavoro resta raggiungibile e la lista resta leggibile.\n" +
    "Deroga per un rebase in corso: TOPICS_PULITO_OK=1.",
  );
  process.exit(1);
}

export { collect, type Leftover };
