/**
 * Chi tiene il proprio trascritto in memoria, e chi lo restituisce.
 *
 * IL PROBLEMA. Il tetto di residenza delle pane (`state/pane/residency/`) smonta
 * la chat, ma i suoi MESSAGGI no: vivono in `messageStore`, indicizzati per
 * sessione, e da lì non usciva mai niente. Ogni chat aperta anche una volta sola
 * lasciava dentro il trascritto INTERO — `loadHistory` chiede la cronologia con
 * `limit: 0`, cioè tutta — e ci restava per tutta la vita della finestra. Il
 * 2026-07-29 il processo della UI React teneva 1844 MB con la curva piatta:
 * memoria presa e mai restituita, che è esattamente la forma di questo difetto.
 *
 * L'idratazione al boot era già a budget (`getInitialMessages`), ma copre solo
 * ciò che arriva da `localStorage`: quello che si accumula DURANTE la sessione
 * non lo toccava nessuno.
 *
 * PERCHÉ SFRATTARE È SICURO. Una chat che rientra ricarica da `/api/history`
 * (`useChat.loadHistory`), che è già ciò che succede per ogni sessione mai vista
 * prima. Il server è la fonte di verità; questa è una cache, e una cache senza
 * sfratto è solo una perdita scritta piano.
 *
 * QUESTO MODULO È LA DECISIONE, ed è puro: nessun DOM, nessun React, nessun
 * timer, nessun `Date.now()` — l'istante arriva come input. Applicare l'esito è
 * compito dello store; misurare i fatti è compito di chi conosce lo stato delle
 * sessioni. Stessa separazione di `pane/residency/policy.ts`, per lo stesso
 * motivo: una decisione testabile in isolamento è una decisione che si può
 * spiegare quando qualcuno chiede «perché questa chat si è ricaricata?».
 */

export interface MessageSessionFacts {
  key: string;
  /** Qualcuno la sta guardando: una pane montata è iscritta allo store. */
  watched: boolean;
  /** Occupata: stream in corso, caricamento, invio in volo, coda in uscita. */
  busy: boolean;
  /** Quanti messaggi tiene. A zero non c'è niente da liberare. */
  messages: number;
  /** Ultimo istante in cui è stata scritta o lasciata. */
  lastTouchedAt: number;
}

export interface MessageResidencyInput {
  sessions: readonly MessageSessionFacts[];
  now: number;
  /** Quante sessioni INATTIVE tenere calde, oltre a quelle guardate. */
  budget: number;
  /** Tetto sui messaggi complessivi tenuti dalle sessioni inattive. */
  maxIdleMessages: number;
  /** Grazia dopo l'ultimo tocco: sotto questa soglia non si sfratta. */
  minIdleMs: number;
}

export interface MessageResidencyDecision {
  keep: string[];
  evict: string[];
}

/**
 * Quante conversazioni inattive restano calde. Sei, non dodici come le pane
 * `light`: una pane smontata costa DOM, un trascritto costa il trascritto — e i
 * trascritti veri hanno migliaia di messaggi con dentro l'output dei tool.
 */
export const MESSAGE_RESIDENCY_BUDGET = 6;

/**
 * Tetto sui messaggi complessivi delle sessioni inattive. Serve la SECONDA
 * dimensione perché il conto delle sessioni non dice niente sul peso: sei chat
 * corte non sono un problema, una sola da diecimila messaggi sì. La più recente
 * fra le inattive è esente (vedi `decideMessageResidency`), altrimenti la chat
 * grossa che hai appena lasciato si ricaricherebbe ogni volta che torni.
 */
export const MESSAGE_RESIDENCY_MAX_IDLE_MESSAGES = 4000;

/**
 * Grazia dopo l'ultimo tocco. Un minuto, non i 4 s delle pane: qui non si
 * previene il thrash del montaggio ma una fetch di rete, e una chat lasciata
 * mezzo minuto fa è ancora «quella di prima» per chi la usa.
 */
export const MESSAGE_MIN_IDLE_MS = 60_000;

/**
 * Regole, in ordine. Le prime quattro sono pavimenti: una sessione che le
 * soddisfa resta, il budget non la tocca.
 *
 *  1. GUARDATA  — c'è una pane montata su quella chat. Sfrattarla sotto gli
 *                 occhi di chi la legge svuoterebbe una lista a schermo.
 *  2. OCCUPATA  — stream in corso, invio in volo, coda in uscita. Qui i messaggi
 *                 in memoria sono più freschi di quelli sul server: buttarli
 *                 PERDE lavoro, non lo rilegge.
 *  3. FRESCA    — lasciata da meno di `minIdleMs`. Chi torna indietro subito
 *                 ritrova la chat senza una fetch.
 *  4. VUOTA     — zero messaggi: non c'è niente da liberare, e sfrattarla
 *                 costerebbe solo un giro di ri-idratazione.
 *  5. BUDGET    — le restanti in ordine MRU, finché ci sono slot E il tetto sui
 *                 messaggi regge. La prima (la più recente) passa comunque:
 *                 è la chat da cui sei appena uscito.
 *  6. il resto è sfrattato.
 */
export function decideMessageResidency(input: MessageResidencyInput): MessageResidencyDecision {
  const { sessions, now, budget, maxIdleMessages, minIdleMs } = input;

  const keep: string[] = [];
  const evict: string[] = [];
  const contested: MessageSessionFacts[] = [];

  for (const s of sessions) {
    if (s.watched || s.busy || s.messages === 0 || now - s.lastTouchedAt < minIdleMs) {
      keep.push(s.key);
      continue;
    }
    contested.push(s);
  }

  // MRU, e a parità la chiave: l'esito non deve dipendere dall'ordine di
  // iterazione di una mappa costruita altrove.
  contested.sort((a, b) => (b.lastTouchedAt - a.lastTouchedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let slots = budget;
  let items = 0;
  for (let i = 0; i < contested.length; i += 1) {
    const s = contested[i];
    const isMostRecent = i === 0;
    const fitsCount = slots > 0;
    const fitsItems = isMostRecent || items + s.messages <= maxIdleMessages;
    if (fitsCount && fitsItems) {
      slots -= 1;
      items += s.messages;
      keep.push(s.key);
    } else {
      evict.push(s.key);
    }
  }

  return { keep, evict };
}
