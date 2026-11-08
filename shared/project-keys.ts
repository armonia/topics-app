/**
 * Le chiavi `ui_state` per-progetto, e l'hash che le genera.
 *
 * Perche' qui: lo stesso djb2 esisteva in TRE copie indipendenti — il client
 * (`state/pane/adapters/projectLayoutSync.ts`), il server
 * (`lib/relocate-pane.ts`) e un suo test (`routes/topics.control.test.ts`) —
 * ognuna con un commento che diceva "MUST match the client's". Nessun test di
 * parita' le teneva insieme: se una fosse derivata, il server avrebbe scritto
 * l'appartenenza di un pane sotto una chiave che il renderer non legge mai, e
 * il pane sarebbe semplicemente sparito senza un errore da nessuna parte. Ora
 * la funzione e' una sola e il problema non e' rappresentabile.
 *
 * Hash a 32 bit: una collisione fra progetti diversi e' possibile in linea di
 * principio (~1/4e9 per coppia — due path che condividono un record di
 * layout), ma cambiare l'hash adesso orfanerebbe ogni chiave localStorage E
 * ogni riga `ui_state` esistente, buttando via in silenzio tutti i layout
 * salvati. Accettato a questa scala; le chiavi vengono potate all'archiviazione
 * del progetto (usePanelLifecycle.handleArchiveProject).
 */

export const PROJECT_PANES_PREFIX = 'topics-project-panes-';
export const PROJECT_LAYOUT_PREFIX = 'topics-project-layout-';

/** djb2 (variante `h * 33 + c` a 32 bit con segno), base36 del valore assoluto. */
export function projectHash(projectPath: string): string {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = projectPath.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Identita' dei tab interni alla finestra di progetto:
 * `{ nonChatPanes, openChatTopicIds }`. E' l'UNICA chiave per-progetto che
 * sincronizza cross-device (vedi `projectLayoutSync.ts`).
 */
export function projectPanesKey(projectPath: string): string {
  return `${PROJECT_PANES_PREFIX}${projectHash(projectPath)}`;
}

/** Geometria del layout (split/righe/sidebar). Resta DEVICE-LOCAL: solo localStorage. */
export function projectLayoutKey(projectPath: string): string {
  return `${PROJECT_LAYOUT_PREFIX}${projectHash(projectPath)}`;
}
