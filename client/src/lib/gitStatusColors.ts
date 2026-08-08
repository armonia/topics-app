/**
 * I COLORI DELLO STATO GIT, UNA VOLTA SOLA E TEMA-CONSAPEVOLI.
 *
 * Lo stesso lavoro era scritto due volte, in due pannelli che stanno UNO SOPRA
 * L'ALTRO nella colonna di progetto: `FileExplorer.getGitStatusColor` e
 * `GitChanges.statusLabel`. Le due copie non erano d'accordo, e la differenza
 * non era di gusto: GitChanges scriveva coppie (`text-amber-600
 * dark:text-amber-400`), FileExplorer scriveva la tinta NUDA — `text-amber-400`
 * senza `dark:`. Cioè in tema chiaro l'albero dei file dipingeva col colore
 * pensato per il fondo scuro.
 *
 * Quanto costa, misurato sulla palette vera (oklch → sRGB) sopra `--bg-elevated`
 * in chiaro e sopra il suo gemello scuro:
 *
 *              chiaro   scuro
 *   amber-400   1,65     9,26   ← il valore che c'era: in scuro è un accento,
 *   green-400   1,70     8,96     in chiaro un evidenziatore fluo. Sei volte.
 *   red-400     2,77     5,50
 *   blue-400    2,53     6,03
 *   amber-600   3,06     4,98   ← perfino la coppia «curata» di GitChanges
 *                                 fallisce in chiaro.
 *
 * Le coppie qui sotto sono scelte SUL NUMERO, non a occhio: in scuro la scala
 * 400, in chiaro la più chiara che supera il 4,5:1 di WCAG AA sul fondo VERO su
 * cui questi colori atterrano.
 *
 * ── E IL FONDO VERO È CAMBIATO L'08/08 ──────────────────────────────────────
 * Questa nota diceva: «il chrome della sidebar è più scuro del pannello —
 * #eaecf0 contro #fafafa — e lì la scala 700 non basta per l'ambra e il verde».
 * Era una parentesi su un caso che non ci riguardava. Poi la barra dei progetti
 * è passata dal token sbagliato (`bg-elevated`) al chrome che dichiarava di
 * essere, e l'albero dei file — l'unico consumatore di queste classi — si è
 * ritrovato proprio su quel fondo. Misurato lì (canvas → sRGB, soglia AA):
 *
 *                    su #eaecf0
 *   amber-700          4,25   ✗   → amber-800   5,99  ✓
 *   green-700          4,18   ✗   → green-800   6,03  ✓
 *   red-700            5,43   ✓
 *   blue-700           5,78   ✓
 *   purple-700         5,97   ✓
 *
 * Scendono di un gradino SOLO ambra e verde, cioè i due che non passavano: le
 * altre tre restano dove sono, perché scurire una tinta che già passa costa
 * saturazione e non compra niente. Sono gli stessi due gradini — e gli stessi
 * numeri — a cui era già arrivata la barra di stato, che sul chrome ci vive da
 * prima (SidebarStatusBar.tsx). Il rosso non l'ha trovato una revisione a
 * occhio: l'ha trovato il cancello di contrasto FILETREE-CONTRAST-01.
 *
 *   amber-800 / amber-400    5,99 / 9,26
 *   green-800 / green-400    6,03 / 8,96
 *   red-700   / red-400      5,43 / 5,50
 *   blue-700  / blue-400     5,78 / 6,03
 *   purple-700 / purple-400  5,97 / 5,70
 */

/** Le famiglie di stato che hanno una tinta propria. */
type GitStatusTone =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflict'
  | 'unknown';

/**
 * Classi di TESTO per ogni famiglia. `unknown` non è ambra ma il grigio del
 * testo muto: «non so cosa sia questo codice» non è un avviso, e vestire il
 * fallback da «modificato» significa affermare una cosa che non si sa.
 */
const GIT_STATUS_TEXT: Record<GitStatusTone, string> = {
  added: 'text-green-800 dark:text-green-400',
  modified: 'text-amber-800 dark:text-amber-400',
  deleted: 'text-red-700 dark:text-red-400',
  renamed: 'text-blue-700 dark:text-blue-400',
  untracked: 'text-purple-700 dark:text-purple-400',
  conflict: 'text-red-700 dark:text-red-400',
  unknown: 'text-app-text-muted',
};

/**
 * Un percorso è in conflitto quando git mette la STESSA lettera nelle due
 * colonne (`DD`, `AA`, `UU`) o una `U` da un lato qualsiasi. Copiata dal
 * predicato di GitChanges perché la classificazione sta tutta qui.
 */
function isConflicted(status: string): boolean {
  const x = status[0] ?? '';
  const y = status[1] ?? '';
  return x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A');
}

/**
 * Dal codice XY grezzo di `git status --porcelain` alla famiglia.
 *
 * Il `trim()` non è cosmetico: il watcher passa il codice a DUE caratteri con
 * lo spazio (`"A "`, `" D"`), e senza normalizzarlo l'aggiunta e la
 * cancellazione non incrociavano mai i casi a un carattere — cadevano nel
 * fallback e si vestivano da «modificato».
 *
 * `??` sta a sé e non è un'aggiunta: un file non tracciato git non lo conosce
 * ancora, uno aggiunto sì. FileExplorer li dipingeva dello stesso verde,
 * GitChanges già no; qui vince la distinzione, che è quella che porta
 * informazione.
 */
function gitStatusTone(status: string): GitStatusTone {
  const s = status.trim();
  if (isConflicted(status)) return 'conflict';
  if (s === '??') return 'untracked';
  if (s === 'A' || s === 'AM') return 'added';
  if (s === 'M' || s === 'MM') return 'modified';
  if (s === 'D') return 'deleted';
  if (s === 'C' || s.startsWith('R')) return 'renamed';
  return 'unknown';
}

/** Scorciatoia: dal codice grezzo alle classi di testo. */
export function gitStatusTextClass(status: string): string {
  return GIT_STATUS_TEXT[gitStatusTone(status)];
}

/**
 * La lettera che si stampa accanto al nome. `??` diventa `U` (untracked); un
 * codice che non riconosciamo si stampa com'è, invece di travestirsi da `M`:
 * un codice sconosciuto mostrato come «modificato» è un'informazione FALSA, e
 * costa più di un codice strano a schermo.
 */
export function gitStatusLabel(status: string): string {
  const s = status.trim();
  if (s === '??') return 'U';
  if (s === 'A' || s === 'AM') return 'A';
  if (s === 'D') return 'D';
  if (s === 'M' || s === 'MM') return 'M';
  if (s.startsWith('R')) return 'R';
  if (s === 'C') return 'C';
  return s || status;
}
