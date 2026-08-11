/**
 * Da dove nasce il ramo di una card: da MAIN, non dall'HEAD del checkout
 * condiviso.
 *
 * Con `baseRef: "HEAD"` il worktree di ogni task ereditava il ramo di chi stava
 * lavorando nel checkout da cui gira il server — e l'11/08 quella sola riga ha
 * prodotto, in una notte: rami di task con 147 commit altrui (il land pubblicava
 * lavoro di terzi finché non ha imparato a prendere solo i propri); consegne
 * appoggiate su commit mai landati; DUE collisioni di numero di migration,
 * perché l'agente contava da un albero fermo a 088 mentre main era già a 089; un
 * manifest rigenerato senza la migration di un altro; e un agente che ha
 * «corretto» due test su main inseguendo un messaggio che esisteva solo su un
 * ramo non landato, lasciando main rossa per un'ora.
 *
 * Nessuno aveva chiesto quell'eredità: era un effetto collaterale del fatto che
 * il server gira dallo stesso checkout dove si sviluppa. Main è già il ramo
 * d'integrazione dichiarato (`resolveTaskMerge`, `own-commits`), quindi è anche
 * la base giusta: l'agente parte da ciò che è PUBBLICATO, non da ciò che
 * qualcuno ha in mano.
 *
 * SI RIPIEGA SU `HEAD` quando `main` non c'è (repo appena inizializzato, repo
 * con un altro ramo d'integrazione, git che non risponde): meglio il vecchio
 * difetto che un dispatch che non parte. Il ripiego è DICHIARATO nel risultato,
 * così chi chiama può avvisare invece di scoprirlo dai sintomi.
 */

import type { GitRunner } from "./own-commits";

export interface WorktreeBaseRef {
  /** Il ref da passare a `worktreeManager.create({ baseRef })`. */
  baseRef: string;
  /**
   * `true` = si è ripiegato su `HEAD` perché il ramo d'integrazione non è
   * verificabile. Non è un errore, è una rinuncia: chi chiama la logga.
   */
  fallback: boolean;
  /** Perché si è ripiegato — vuoto quando `fallback` è `false`. */
  reason: string;
}

export interface WorktreeBaseRefOptions {
  /** Il ramo d'integrazione. Default `main`, lo stesso di `resolveTaskMerge`. */
  mainRef?: string;
  /** Iniettato nei test. Default: `git` vero. */
  runGit?: GitRunner;
}

async function defaultRunGit(cwd: string, args: string[]) {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `repoPath` può mancare (progetto senza path noto): senza un repo su cui
 * chiedere non si può affermare che `main` esista, e la risposta è il ripiego.
 *
 * La domanda è su `refs/heads/<main>` per esteso, non su `main`: un file o un
 * remote che si chiamano allo stesso modo renderebbero ambigua la richiesta, e
 * un ramo REMOTO (`origin/main`) non è una base checkout-abile per un worktree.
 */
export async function resolveWorktreeBaseRef(
  repoPath: string | null | undefined,
  opts: WorktreeBaseRefOptions = {},
): Promise<WorktreeBaseRef> {
  const mainRef = opts.mainRef ?? "main";
  if (!repoPath) return { baseRef: "HEAD", fallback: true, reason: "progetto senza path di repo" };
  const run = opts.runGit ?? defaultRunGit;
  const res = await run(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${mainRef}`]);
  if (res.code === 0) return { baseRef: mainRef, fallback: false, reason: "" };
  return { baseRef: "HEAD", fallback: true, reason: `nessun ramo '${mainRef}'` };
}
