/**
 * Rilevamento dei processi "fantasma": script avviati da Topics (source:"script")
 * il cui cwd sta dentro una worktree che non esiste piu'.
 *
 * CRITERIO DI ORFANEZZA, tutte e tre obbligatorie (spec task e3240a22):
 *  1. PROPRIETA': source:"script" in runningScripts. Non si giudica MAI un
 *     processo dalla riga di comando.
 *  2. TERRENO SPARITO: cwd canonicalizzato sotto una worktree che non esiste.
 *  3. IDENTITA': pid+lstart riverificati prima di ogni segnale.
 *
 * Nota: i processi con cwd in ~/Projects/* NON sono di Topics e non si toccano.
 * Sono fuori scope, riportati da scripts/mem-report.ts.
 *
 * INTERRUTTORE: TOPICS_GHOST_REAP
 *  - non impostato / 0: solo log (default)
 *  - 1: uccide davvero
 */

export interface OwnedScript {
  processId: string;
  pid: number | null;
  pidLstart?: string;
  projectPath: string;
  source?: "script" | "detected" | "shell";
  status: string;
}

/**
 * Funzione PURA: dato un processo e la lista delle radici di worktree esistenti,
 * dice se e' un fantasma.
 *
 * Criteri (in ordine, tutti obbligatori):
 *   1. source === "script" (proprieta' di Topics)
 *   2. status === "running" (non gia' finito)
 *   3. pid presente
 *   4. cwd canonicalizzato sotto la radice worktrees che NON esiste sul disco
 *
 * Il cwd viene gia' canonicalizzato (symlink risolti) al momento del check,
 * non da questa funzione: il chiamante passa il cwd reale.
 */
export function isGhostScript(opts: {
  /** cwd canonicalizzato del processo (realpathSync), gia' risolto */
  cwdReal: string;
  /** insieme dei path di worktree ESISTENTI (realpathSync di absPath) */
  worktreeRoots: Set<string>;
  /** la cartella base di tutti i worktree di Topics, es. ~/.topics/worktrees */
  worktreesBase: string;
  source?: string;
  status?: string;
  pid: number | null;
}): boolean {
  const { cwdReal, worktreeRoots, worktreesBase, source, status, pid } = opts;
  // 1. Deve essere un processo avviato da Topics
  if (source !== "script") return false;
  // 2. Deve essere ancora segnato come running
  if (status !== "running") return false;
  // 3. Deve avere un pid
  if (!pid) return false;
  // 4. Il cwd deve stare DENTRO la base dei worktree di Topics
  const base = worktreesBase.endsWith("/") ? worktreesBase : worktreesBase + "/";
  if (!cwdReal.startsWith(base)) return false;
  // 5. Nessuna worktree esistente contiene questo cwd
  for (const root of worktreeRoots) {
    const r = root.endsWith("/") ? root : root + "/";
    if (cwdReal === root || cwdReal.startsWith(r)) return false;
  }
  return true;
}

/**
 * Controlla se ci sono processi "fantasma" gia' documentati in scrittura attiva
 * del worktree dato.
 *
 * Usato dal runner GC per decidere se rimandare lo slim: se uno script con
 * source:"script" ha il suo projectPath dentro la worktree, non si tocca.
 */
export function hasRunningScriptsInWorktree(opts: {
  scripts: OwnedScript[];
  worktreePath: string;
}): boolean {
  const { scripts, worktreePath } = opts;
  const base = worktreePath.endsWith("/") ? worktreePath : worktreePath + "/";
  return scripts.some(s => {
    if (s.source !== "script" || s.status !== "running" || !s.pid) return false;
    const p = s.projectPath;
    return p === worktreePath || p.startsWith(base);
  });
}
