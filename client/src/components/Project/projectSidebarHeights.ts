/**
 * QUANTO È ALTA UNA SEZIONE APERTA della colonna di progetto.
 *
 * Sta fuori da `ProjectSidebar.tsx` per la stessa ragione di
 * `pinnedTileMetrics.ts`: un file che esporta un componente E altro spegne il
 * fast refresh di Vite per quel file — ogni ritocco alla colonna diventerebbe un
 * ricarico pieno invece di uno scambio a caldo.
 */

/** Le sezioni della colonna, in ordine. Il numero serve al tetto qui sotto. */
export const SEZIONI = ['files', 'git', 'processes'] as const;

/**
 * IL TETTO DI UNA SEZIONE IN ALTEZZA AUTOMATICA — `1/N` della colonna.
 *
 * Aperte, Git e Processi prendono l'altezza del loro CONTENUTO, non più un
 * numero fisso. «Fai in modo che gli accordion quando aperti si adattino al
 * contenuto per quanto riguarda l'altezza, fino a un massimo tipo di 1 / numero
 * di accordion» (Attilio, 10/08). Prima erano 200 e 150 px scritti a mano: due
 * file modificati lasciavano ~160px di vuoto sotto, e un repo con quaranta ne
 * mostrava sei.
 *
 * Il tetto non è prudenza: senza, una sezione piena si prende tutto e le altre
 * due diventano intestazioni impilate in fondo — il difetto opposto, con lo
 * stesso effetto (una sola sezione utile per volta). A `1/N`, Files — che è
 * `flex-1` e assorbe il resto — non scende mai sotto un terzo nemmeno con le
 * altre due piene.
 *
 * È una PERCENTUALE, e vuole che il contenitore delle sezioni abbia un'altezza
 * definita: ce l'ha (`flex-1` dentro una colonna a altezza fissa). Senza, una
 * `max-height` in percentuale non si risolve e la sezione crescerebbe senza
 * fermo — il caso che questa funzione esiste per non avere.
 *
 * Derivato dalla lista, non scritto a mano: se le sezioni diventano quattro il
 * tetto scende da sé.
 */
export function capSezione(n: number = SEZIONI.length): string {
  return `calc(100% / ${n})`;
}

/** The column it opens at: 224px, the old hard-wired `w-56`. */
export const DEFAULT_SIDEBAR_W = 224;
/** Below this the file tree stops being readable; above it, it eats the window. */
export const MIN_SIDEBAR_W = 160;
export const MAX_SIDEBAR_W = 560;

/** Per project, like the open sections and the heights: a deep tree and a flat
 *  one do not want the same column. */
export function projectSidebarWidthKey(projectPath: string): string {
  return `project-sidebar-width:${projectPath}`;
}

/**
 * THE WIDTH THE COLUMN WILL OPEN AT, readable BEFORE the column exists.
 *
 * `ProjectSidebar` is a lazy chunk now (it and `FileExplorer` were 52 kB of
 * the eager entry, parsed on every boot even with no project window open), and
 * a lazy component means a frame in which its `Suspense` fallback stands where
 * it will be. A fallback of the wrong width is a layout shift on the ONE
 * surface this whole line of work exists to keep still - so the placeholder
 * reserves the exact column, and it can only do that if the number lives out
 * here rather than inside the component's `useState` initialiser.
 *
 * Both stores, in the same order the column itself reads them: localStorage is
 * the real one, sessionStorage is where an E2E fixture seeds a layout.
 */
export function readProjectSidebarWidth(projectPath: string): number {
  const key = projectSidebarWidthKey(projectPath);
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(key) ?? sessionStorage.getItem(key);
  } catch {
    /* storage denied: the default is the answer */
  }
  const n = saved ? parseInt(saved, 10) : NaN;
  return Number.isFinite(n) ? clampSidebarWidth(n) : DEFAULT_SIDEBAR_W;
}

/** The drag, the saved value and the placeholder all obey the same two ends. */
export function clampSidebarWidth(w: number): number {
  return Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, w));
}
