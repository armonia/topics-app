#!/usr/bin/env bun
/**
 * scripts/check-repo-pulito.ts - il lavoro e' finito quando NON RESTA NIENTE.
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
 */
import { $ } from "bun";

/** Un reperto trovato nel repo, con il modo di toglierlo. */
interface Reperto {
  cosa: string;
  righe: string[];
  rimedio: string;
}

const TETTO_ELENCO = 12;

async function sh(cmd: string): Promise<string> {
  try {
    return (await $`sh -c ${cmd}`.quiet().text()).trim();
  } catch {
    return "";
  }
}

/** Ogni riga non vuota, senza spazi ai bordi. */
function righe(s: string): string[] {
  return s.split("\n").map((r) => r.trim()).filter(Boolean);
}

async function raccogli(): Promise<Reperto[]> {
  const trovati: Reperto[] = [];

  const rami = righe(await sh("git branch --format='%(refname:short)'")).filter((b) => b !== "main");
  if (rami.length > 0) {
    trovati.push({
      cosa: `${rami.length} ramo/i oltre main`,
      righe: rami,
      rimedio:
        "archivialo e toglilo:\n" +
        "    git tag archive/$(echo <ramo> | tr / -) <ramo> && git branch -D <ramo>\n" +
        "  il lavoro resta raggiungibile: git branch <nome> archive/<nome>",
    });
  }

  const stash = righe(await sh("git stash list"));
  if (stash.length > 0) {
    trovati.push({
      cosa: `${stash.length} stash`,
      righe: stash,
      rimedio:
        "archiviali e svuota la lista:\n" +
        "    git tag archive/stash-$(date +%Y%m%d)-$(git rev-parse --short stash@{0}) stash@{0}\n" +
        "    git stash clear\n" +
        "  si rileggono con: git stash show -p <tag>",
    });
  }

  // `git worktree list` stampa sempre il checkout principale: solo le altre contano.
  const wt = righe(await sh("git worktree list")).slice(1);
  if (wt.length > 0) {
    trovati.push({
      cosa: `${wt.length} worktree oltre il checkout principale`,
      righe: wt,
      rimedio: "git worktree remove --force <percorso>",
    });
  }

  const sporchi = righe(await sh("git status --porcelain"));
  if (sporchi.length > 0) {
    trovati.push({
      cosa: `${sporchi.length} file non committati`,
      righe: sporchi,
      rimedio: "committa, oppure mettili in .gitignore se non devono stare qui",
    });
  }

  // Solo se un upstream c'e': un main senza remoto non e' un reperto.
  const upstream = await sh("git rev-parse --abbrev-ref main@{upstream} 2>/dev/null");
  if (upstream) {
    const avanti = await sh(`git rev-list --count ${upstream}..main`);
    if (avanti && avanti !== "0") {
      trovati.push({
        cosa: `main ha ${avanti} commit non spinti`,
        righe: righe(await sh(`git log --oneline ${upstream}..main | head -5`)),
        rimedio: "git push",
      });
    }
  }

  return trovati;
}

if (import.meta.main) {
  if (process.env.TOPICS_PULITO_OK === "1") {
    console.log("[check-repo-pulito] saltato (TOPICS_PULITO_OK=1)");
    process.exit(0);
  }

  const trovati = await raccogli();

  if (trovati.length === 0) {
    console.log("[check-repo-pulito] solo main, niente stash, una worktree, niente da committare.");
    process.exit(0);
  }

  console.error("[check-repo-pulito] il repo non e' pulito:\n");
  for (const r of trovati) {
    console.error(`  ${r.cosa}`);
    for (const riga of r.righe.slice(0, TETTO_ELENCO)) console.error(`      ${riga}`);
    if (r.righe.length > TETTO_ELENCO) console.error(`      ... e altri ${r.righe.length - TETTO_ELENCO}`);
    console.error(`    -> ${r.rimedio}\n`);
  }
  console.error(
    "Niente di tutto questo va cancellato e basta: si archivia come tag `archive/...`,\n" +
    "cosi' il lavoro resta raggiungibile e la lista resta leggibile.\n" +
    "Deroga per un rebase in corso: TOPICS_PULITO_OK=1.",
  );
  process.exit(1);
}

export { raccogli, type Reperto };
