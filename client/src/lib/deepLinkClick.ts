/**
 * Cosa succede quando si clicca un link dentro un markdown dell'app.
 *
 * La ROTTA la decide `deepLinkClickRoute` (task, tab, esterno). Qui sta l'altra
 * metà: cosa fare quando la rotta in casa non arriva in fondo. Sono due
 * decisioni diverse e tenerle separate ha un motivo pratico — la prima è pura e
 * già testata, la seconda dipende dall'ORDINE di due callback e per un anno è
 * stata scritta dentro un `onClick` di un componente, dove non la eseguiva
 * nessun test.
 *
 * IL VICOLO CIECO HA DUE FACCE, e vogliono ripieghi opposti:
 *   • non si è aperto NIENTE → si apre fuori. È esattamente ciò che quel link
 *     faceva PRIMA che i self-origin venissero intercettati: l'utente vede il
 *     contenuto, che è il punto. Un click che non fa e non dice niente è il
 *     peggiore dei tre esiti.
 *   • si è aperto QUALCOSA e poi il secondo salto si è arreso (`/tab/file/…`
 *     apre la finestra di progetto e poi insegue il file) → il ripiego sarebbe
 *     un danno: l'utente si ritroverebbe la finestra di progetto in-app PIÙ una
 *     seconda copia completa di Topics nel browser di sistema, connessa allo
 *     stesso WS e allo stesso pane-store. Qui il canale giusto è DIRLO.
 *
 * Il secondo ramo taceva, e il motivo scritto sopra `ChatMarkdown` non vale più:
 * diceva che un `useToast()` lì dentro avrebbe reso ogni link di ogni messaggio
 * un consumatore che si ri-renderizza a ogni giro, perché il valore del context
 * si ricostruiva a ogni render di App. Oggi l'API dei toast sta in un context
 * suo (`ToastApiContext`) che dopo il mount non cambia MAI identità, quindi
 * quel costo non esiste e non c'è più niente che giustifichi il silenzio.
 */
import type { DeepLinkClickRoute } from './tabLink';
import type { TabTarget } from '../../../shared/tab-link';
import type { TaskTarget } from './openTaskLink';

export interface DeepLinkClickDeps {
  route(href: string): DeepLinkClickRoute;
  openTask(target: TaskTarget): void;
  openTab(target: TabTarget, opts: { onRouted: () => void; notify: (message: string) => void }): void;
  openExternal(href: string): void;
  /** Come si dice all'utente che l'apertura in casa si è fermata a metà. */
  warn(message: string): void;
}

export function openDeepLinkFromClick(href: string, deps: DeepLinkClickDeps): void {
  const route = deps.route(href);
  if (route.via === 'task') { deps.openTask(route.target); return; }
  if (route.via === 'tab') {
    // `onRouted` arriva PRIMA dell'esito e disarma il ripiego: è il solo modo
    // di distinguere «non ho aperto niente» da «ho aperto a metà». `openTabInApp`
    // chiama `notify` una volta sola e solo su vicolo cieco.
    let openedInApp = false;
    deps.openTab(route.target, {
      onRouted: () => { openedInApp = true; },
      notify: (message) => {
        if (!openedInApp) { deps.openExternal(href); return; }
        deps.warn(message);
      },
    });
    return;
  }
  deps.openExternal(href);
}
