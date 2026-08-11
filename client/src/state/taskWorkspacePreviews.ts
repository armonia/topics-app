/**
 * taskWorkspacePreviews — chi ha aperto quelle pane, e quindi chi le richiude.
 *
 * Aprendo un task, le sue tab possono comparire da sole nel workspace del
 * progetto (vedi `TaskDetail`). È comodo finché dura la lettura del task, ma
 * lasciare dietro una pane per ogni task guardato riempie il workspace di roba
 * che l'utente non ha mai chiesto — ed è il rischio vero di un'apertura
 * automatica: non il costo del mount (quello lo tiene già il tetto di residenza,
 * `state/pane/residency/`), ma l'accumulo.
 *
 * La regola, che è anche il contratto verso l'utente:
 *
 *  - AUTOMATICO si richiude. Le pane aperte da sole all'apertura del task
 *    vengono chiuse quando esci da quel task.
 *  - A MANO resta. «Apri nel workspace» è un gesto: quelle pane non passano di
 *    qui e non le chiude nessuno.
 *
 * Il tetto (`MAX_TASKS`) è la rete di sicurezza per il caso in cui l'uscita non
 * arrivi mai — due board aperte su due superfici, una finestra chiusa di colpo:
 * registrare un task in più sfratta il più vecchio invece di lasciarlo lì per
 * sempre. Modulo di stato puro, senza React e senza DOM: chi chiama traduce i
 * contextId restituiti in chiusure vere.
 */

/** Quante task-preview automatiche possono coesistere prima che parta lo sfratto. */
export const MAX_AUTO_OPENED_TASKS = 2;

interface AutoOpenedEntry {
  taskId: string;
  projectPath: string;
  contextIds: string[];
}

/** MRU: l'ultimo registrato è in fondo, il primo sfrattabile è in testa. */
const entries: AutoOpenedEntry[] = [];

/**
 * Registra le pane appena aperte da sole per `taskId`, e torna i contextId che
 * il chiamante deve CHIUDERE perché sfrattati dal tetto. Ri-registrare lo stesso
 * task aggiorna la sua voce e la porta in cima (nessuno sfratto di se stesso).
 */
export function noteAutoOpenedPreview(taskId: string, projectPath: string, contextIds: string[]): string[] {
  if (!taskId || contextIds.length === 0) return [];
  const at = entries.findIndex((e) => e.taskId === taskId);
  if (at >= 0) entries.splice(at, 1);
  entries.push({ taskId, projectPath, contextIds: [...new Set(contextIds)] });
  const evicted: string[] = [];
  while (entries.length > MAX_AUTO_OPENED_TASKS) {
    const gone = entries.shift();
    if (gone) evicted.push(...gone.contextIds);
  }
  return evicted;
}

/**
 * Esci dal task: torna i contextId aperti automaticamente per lui (da chiudere)
 * e dimentica la voce. Vuoto se per quel task non ne era stata aperta nessuna —
 * cioè anche quando l'utente le aveva aperte a mano, che è il punto.
 */
export function releaseAutoOpenedPreview(taskId: string): string[] {
  const at = entries.findIndex((e) => e.taskId === taskId);
  if (at < 0) return [];
  const [gone] = entries.splice(at, 1);
  return gone.contextIds;
}

/** Le pane automatiche vive per questo task (per i test e per le diagnosi). */
export function autoOpenedPreviewOf(taskId: string): string[] {
  return entries.find((e) => e.taskId === taskId)?.contextIds ?? [];
}

/** Solo per i test. */
export function __resetAutoOpenedPreviews(): void {
  entries.length = 0;
}
