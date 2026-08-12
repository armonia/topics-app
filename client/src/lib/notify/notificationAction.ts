/**
 * Il tasto premuto su un banner NATIVO, eseguito dal client.
 *
 * Il guscio (Rust) sa solo trasportare: il delegate legge `actionIdentifier`,
 * lo passa al webview e finisce lì. Chi esegue è questo modulo, e non è una
 * divisione arbitraria — la chiamata vuole la sessione, i cookie e gli endpoint
 * della board, cioè tre cose che vivono qui. Portarle dentro il guscio
 * significherebbe tenerne una seconda copia in un binario che l'utente
 * aggiorna molto più di rado del client.
 *
 * Il gemello per la web-push è dentro `client/public/sw.js`: là il service
 * worker riceve la richiesta già composta dal server, perché non può importare
 * niente. Qui invece si importa `shared/notify-actions` e si compone: nessuna
 * regola duplicata.
 *
 * Puro per costruzione: ogni dipendenza (risolvere il progetto, chiamare,
 * aprire il task) arriva come parametro. Il cablaggio vero sta in App.tsx.
 */
import { decodeNotifyAction, isBoardActionPath, notifyActionRequest } from '../../../../shared/notify-actions';

/** Cos'è successo. Serve al test e alla diagnosi, non alla UI. */
export type NotificationActionOutcome =
  /** Il server ha accettato: il tasto ha fatto il suo lavoro. */
  | 'executed'
  /** Non si è potuto eseguire → si è aperto il task, dove il perché si legge. */
  | 'opened'
  /** Id che non conosciamo: non è un nostro tasto, non si fa niente. */
  | 'ignored';

export interface NotificationActionDeps {
  /** Il progetto del task. `null` = non risolto (task archiviato, server giù). */
  resolveProjectId: (taskId: string) => Promise<string | null>;
  /** La chiamata vera. Torna true se il server ha accettato. */
  send: (req: { method: string; path: string; body: Record<string, unknown> }) => Promise<boolean>;
  /** Il ripiego: apri il drawer del task. */
  openTask: (taskId: string) => void;
}

/**
 * Esegue il tasto. Un click che non arriva a destinazione NON si perde: apre il
 * task. Un tasto che non fa niente e non lo dice è peggio di un tasto che non
 * c'è — e i modi di non arrivare sono tanti e tutti normali (il task nel
 * frattempo è uscito da review, i checks sono rossi e il server rifiuta senza
 * `force`, la rete non c'è).
 */
export async function runNotificationAction(
  taskId: string,
  actionId: string,
  deps: NotificationActionDeps,
): Promise<NotificationActionOutcome> {
  const verb = decodeNotifyAction(actionId);
  // Nessun ripiego qui: un id che non sappiamo decodificare non è un tasto
  // nostro (macOS usa lo stesso campo anche per il click sul corpo e per lo
  // scarto), e aprire il task su uno SCARTO sarebbe l'app che si spalanca
  // proprio quando hai detto di no.
  if (!verb || !taskId) return 'ignored';

  const fallback = (): NotificationActionOutcome => { deps.openTask(taskId); return 'opened'; };
  let projectId: string | null = null;
  try { projectId = await deps.resolveProjectId(taskId); } catch { projectId = null; }
  if (!projectId) return fallback();

  const req = notifyActionRequest(verb, { projectId, taskId });
  // Stesso cancello del service worker: una richiesta composta male non deve
  // poter uscire da qui come chiamata arbitraria con i cookie dell'utente.
  if (!req || !isBoardActionPath(req.path)) return fallback();

  let ok = false;
  try { ok = await deps.send(req); } catch { ok = false; }
  return ok ? 'executed' : fallback();
}
