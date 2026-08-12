/**
 * notify-actions.ts — i TASTI di una notifica, decisi una volta per tutte le
 * superfici.
 *
 * Una notifica di Topics è sempre stata un link: ti sveglia, la clicchi, apre
 * il task. Ma la decisione che ti sveglia è quasi sempre di UN click — «Landa
 * su main?», «pronto per la review», «parcheggiato» — e quel click esisteva
 * solo sulla card. Qui si decide QUALI tasti porta una notifica e COSA fanno.
 *
 * La regola che tiene insieme tutto: **un tasto della notifica è il tasto della
 * board, telecomandato.** Stessa chiamata, stessi cancelli lato server, stesse
 * conseguenze. Nessuna azione esiste qui che non esista già sulla card: una
 * seconda via di decisione sarebbe una seconda semantica da tenere allineata, e
 * il primo disallineamento se lo mangia l'utente convinto di aver premuto la
 * cosa che vedeva sulla board.
 *
 * Tre lettori, un solo modulo (per questo sta in `shared/`):
 *   · il SERVER (`push-triggers`) compone le azioni dentro il payload web-push;
 *   · il CLIENT (`useCompletionNotifier` → `notifyNative`) le passa al guscio
 *     nativo, che ne fa dei `UNNotificationAction`;
 *   · il SERVICE WORKER le esegue — ma lui non può importare niente (è JS
 *     servito a parte, fuori dal bundle), quindi non decodifica un bel niente:
 *     riceve la richiesta HTTP già composta (`notifyActionRequest`) e la spara.
 *     È il motivo per cui `NotifyActionRequest` esiste come DATO e non come
 *     funzione da richiamare: un `switch` copiato dentro sw.js sarebbe la
 *     quarta verità, e sarebbe quella che nessun test compila.
 */

/** Il verbo di un tasto: cosa succede davvero quando lo premi. */
export type NotifyVerb =
  /** Rispondi alla domanda dell'agente con QUESTO testo (= quick-reply della card). */
  | { kind: 'answer'; text: string }
  /** Approva la consegna (= tasto "Approva" della card in Review). */
  | { kind: 'approve' }
  /** Rimetti in coda un task parcheggiato (= riportarlo in Todo). */
  | { kind: 'requeue' };

/** Un tasto come lo vede la superficie che lo disegna. */
export interface NotifyAction {
  /**
   * L'identificatore che torna indietro al click. CODIFICA il verbo per intero
   * (`answer:<testo url-encoded>`, `approve`, `requeue`): così non serve nessun
   * registro in memoria che leghi id → azione, e una notifica sopravvissuta al
   * riavvio dell'app resta premibile invece di diventare un tasto morto.
   */
  id: string;
  /** L'etichetta stampata sul bottone. */
  title: string;
}

/**
 * Quanti tasti al massimo — e perché non se ne mostra un SOTTOINSIEME.
 *
 * Due è il minimo garantito ovunque: Chrome espone `Notification.maxActions`
 * (2 sulle piattaforme desktop) e il banner di macOS mostra il primo tasto
 * inline e il resto sotto un chevron.
 *
 * La regola vera però non è il numero, è il TUTTO-O-NIENTE di
 * `buildNotifyActions`: una domanda con più opzioni di così non ne mostra
 * nessuna. Mostrarne due su quattro metterebbe a un click di distanza una
 * risposta sbagliata mentre quella giusta non si vede nemmeno — e una scelta
 * troncata è peggio di nessuna scelta, perché non sembra troncata.
 */
export const MAX_NOTIFY_ACTIONS = 2;

/** L'evento che alza la notifica, ridotto a ciò che serve per decidere i tasti. */
export type NotifyEvent =
  | {
      kind: 'review-ready';
      /**
       * La domanda pendente dell'agente, o assente/null se la consegna non è
       * una domanda. È un OGGETTO e non la sola lista di opzioni perché i due
       * casi «nessuna domanda» e «una domanda senza opzioni» chiedono cose
       * opposte e una lista vuota li confonde: sul primo il tasto giusto è
       * "Approva", sul secondo approvare CHIUDE un task che ti sta chiedendo
       * una cosa. Il tipo costringe il chiamante a dire quale dei due è.
       */
      question?: { options?: readonly string[] | null } | null;
    }
  | { kind: 'parked' };

function encodeAnswer(text: string): string {
  return `answer:${encodeURIComponent(text)}`;
}

/**
 * I tasti di questa notifica. Puro, e volutamente avaro.
 *
 *  · review con domanda pendente (1..MAX opzioni) → le opzioni, e SOLO quelle:
 *    finché c'è una domanda aperta, "Approva" non è tra le risposte possibili —
 *    chiuderebbe un task che sta aspettando di sapere una cosa.
 *  · review con domanda ingestibile (nessuna opzione, o troppe) → nessun tasto:
 *    resta il click che apre il task, dove la domanda si legge per intero.
 *  · review senza domanda → "Approva", lo stesso identico tasto che la card
 *    offre senza nemmeno aprire il drawer.
 *  · parcheggiato → "Rimetti in coda": un task parcheggiato non riparte da solo,
 *    e rimetterlo in Todo è l'unica mossa che lo fa ripartire.
 */
export function buildNotifyActions(event: NotifyEvent): NotifyAction[] {
  if (event.kind === 'parked') {
    return [{ id: 'requeue', title: 'Rimetti in coda' }];
  }
  // Nessuna domanda: la consegna è da guardare e approvare.
  if (!event.question) return [{ id: 'approve', title: 'Approva' }];
  const options = (event.question.options ?? []).map((o) => String(o ?? '').trim()).filter(Boolean);
  // C'è una domanda ma non se ne possono offrire i tasti (zero opzioni, o più
  // del tetto): nessun tasto. In particolare MAI "Approva" — approvare non è
  // una risposta, è chiudere la conversazione al posto suo.
  if (options.length === 0 || options.length > MAX_NOTIFY_ACTIONS) return [];
  return options.map((o) => ({ id: encodeAnswer(o), title: o }));
}

/** Rilegge il verbo dall'id di un tasto. `null` = id che non conosciamo. */
export function decodeNotifyAction(id: string | null | undefined): NotifyVerb | null {
  if (!id) return null;
  if (id === 'approve') return { kind: 'approve' };
  if (id === 'requeue') return { kind: 'requeue' };
  if (id.startsWith('answer:')) {
    let text: string;
    try {
      text = decodeURIComponent(id.slice('answer:'.length));
    } catch {
      return null; // percent-encoding rotto: meglio nessuna azione che una a caso
    }
    return text.trim() ? { kind: 'answer', text } : null;
  }
  return null;
}

/** La chiamata HTTP che un tasto esegue: la stessa che preme la board. */
export interface NotifyActionRequest {
  method: 'POST' | 'PATCH';
  /** Sempre sotto `/api/boards/` — vedi `isBoardActionPath`. */
  path: string;
  body: Record<string, unknown>;
}

/**
 * Il cancello sul path, per chi esegue una richiesta che gli è ARRIVATA invece
 * di comporla (il service worker legge il payload della push).
 *
 * Il payload è nostro e viaggia cifrato VAPID, quindi non è una difesa contro
 * un attaccante: è la rete contro un errore di composizione qui dentro, che
 * altrimenti diventerebbe una richiesta arbitraria eseguita con i cookie
 * dell'utente e nessuno se ne accorgerebbe.
 */
export function isBoardActionPath(path: unknown): path is string {
  return typeof path === 'string' && /^\/api\/boards\/[^/]+\/tasks\/[^/]+(\/[a-z-]+)?$/.test(path);
}

/**
 * Compone la richiesta di un verbo. `answer` è un `reject` che PORTA il testo:
 * non è un rifiuto della consegna, è la semantica che il server ha già (route
 * review → `dispatcher.resume`) e che la card usa da sempre — rispondere a un
 * agente vuol dire rimandarlo al lavoro con la risposta in mano.
 */
export function notifyActionRequest(
  verb: NotifyVerb,
  ref: { projectId: string; taskId: string },
): NotifyActionRequest | null {
  const projectId = String(ref.projectId ?? '');
  const taskId = String(ref.taskId ?? '');
  if (!projectId || !taskId) return null;
  const base = `/api/boards/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  switch (verb.kind) {
    case 'answer':
      return { method: 'POST', path: `${base}/review`, body: { decision: 'reject', comment: verb.text } };
    case 'approve':
      return { method: 'POST', path: `${base}/review`, body: { decision: 'approve' } };
    case 'requeue':
      // PATCH dello stato, esattamente come trascinare la card in Todo: è lì che
      // il dispatcher la ripesca.
      return { method: 'PATCH', path: base, body: { status: 'todo' } };
  }
}

/**
 * Il pacchetto pronto per una superficie che non sa decodificare niente: i
 * tasti da disegnare e, per ciascuno, la richiesta già composta.
 */
export function buildNotifyActionBundle(
  event: NotifyEvent,
  ref: { projectId: string; taskId: string },
): { actions: NotifyAction[]; requests: Record<string, NotifyActionRequest> } {
  const actions: NotifyAction[] = [];
  const requests: Record<string, NotifyActionRequest> = {};
  for (const action of buildNotifyActions(event)) {
    const verb = decodeNotifyAction(action.id);
    if (!verb) continue;
    const request = notifyActionRequest(verb, ref);
    // Senza progetto o senza task non c'è nessuna chiamata da fare: il tasto
    // non si disegna proprio, invece di disegnarlo e non fare niente.
    if (!request) continue;
    actions.push(action);
    requests[action.id] = request;
  }
  return { actions, requests };
}
