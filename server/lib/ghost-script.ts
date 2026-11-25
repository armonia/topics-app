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
  source?: "script" | "detected" | "shell" | "command";
  status: string;
}

/**
 * Spawned by Topics itself, so Topics answers for it: a manifest script
 * (`run_script`; no `source` on rows older than the field) or a `run_command`.
 * A detected process and a background shell of the CLI are somebody else's.
 */
export function isTopicsSpawned(source: string | undefined): boolean {
  return source === undefined || source === "script" || source === "command";
}
