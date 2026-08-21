/**
 * "Un turno che non ha prodotto niente non lascia niente."
 *
 * Quando si ferma una risposta PRIMA che il modello abbia detto qualcosa, il
 * segnaposto dell'assistente — la riga creata all'inizio dello stream — veniva
 * finalizzato così com'era: `partial: 0`, contenuto vuoto. Risultato: una
 * bolla vuota che resta nella chat (e nella history che si rimanda al modello a
 * ogni turno successivo). In DB se ne contano a decine nei giorni di dispatch:
 * 26 il 19/07, 20 il 20/07, e ancora 1-5 al giorno.
 *
 * Il predicato sta qui, in `shared/`, perché la stessa domanda se la fanno in
 * due: il server prima di cancellare la riga, e il client prima di togliere la
 * bolla locale. Due copie della regola vorrebbero dire due definizioni diverse
 * di "vuoto" — e la bolla sparirebbe da una parte sola.
 *
 * "Niente" è letterale: nessun testo, nessun ragionamento, nessuna tool call,
 * nessun blocco, nessun media. Un turno interrotto DOPO una tool call, o con
 * mezza frase scritta, ha prodotto qualcosa e va tenuto: è lavoro fatto, e
 * cancellarlo sarebbe perdita di dati.
 */

/** Vista strutturale del messaggio: regge sia `ChatMessage` (client, campi già
 *  deserializzati) sia la riga SQLite (server, JSON come stringa). */
export interface AssistantTurnShape {
  role?: string;
  content?: string | null;
  thinking?: string | null;
  /** Array sul client, stringa JSON (o null) sulla riga del DB. */
  toolCalls?: unknown[] | string | null;
  blocks?: unknown[] | string | null;
  media?: unknown[] | string | null;
}

/** Vuoto = assente, o presente ma senza elementi. Una stringa JSON conta come
 *  piena solo se contiene davvero qualcosa: `"[]"` è vuota quanto `null`. */
function hasItems(v: unknown[] | string | null | undefined): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  const s = v.trim();
  if (!s || s === "[]" || s === "null") return false;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.length > 0 : parsed != null;
  } catch {
    // Non è JSON: se c'è del testo, è roba. Meglio tenere che cancellare.
    return true;
  }
}

/**
 * LE FRASI CON CUI LA CLI DICE «NIENTE».
 *
 * Non sono risposte: sono segnaposto che Claude Code emette quando un turno si
 * chiude senza avere nulla da dire. Stanno una accanto all'altra nel suo
 * binario (`XI = "(no content)"`, `lX = "No response requested."`), e la CLI
 * stessa le tratta come marcatori — il suo classificatore di stato le legge
 * come «finito», non come contenuto.
 *
 * Per noi contano perché arrivano nel canale del testo, quindi il predicato
 * qui sotto le vedeva come una risposta vera e teneva la riga. Su un turno
 * CHIESTO da una persona non si notano (una in mezzo a una conversazione).
 * Su un turno RISVEGLIATO sì: un Monitor che si chiude sveglia un turno per
 * annunciarlo, quel turno non ha niente da dire, e in chat resta una riga che
 * l'utente non ha chiesto sotto la risposta che invece aveva senso — osservato
 * sulla chat 205d1fbb il 20/08.
 *
 * Confronto sul testo INTERO, non `includes`: un modello che scrive «la CLI
 * risponde "No response requested." quando…» sta dicendo qualcosa, e cancellare
 * quella riga sarebbe perdita di dati.
 */
const SENTINELLE_VUOTE = new Set(["(no content)", "No response requested."]);

/** Il testo è una delle sentinelle con cui la CLI dice di non avere risposta? */
export function isNoContentSentinel(text: string | null | undefined): boolean {
  return SENTINELLE_VUOTE.has((text ?? "").trim());
}

/**
 * I blocchi contano come LAVORO solo se non sono l'eco di un testo nullo.
 *
 * Il testo di un turno finisce anche nei blocchi, quindi una riga il cui unico
 * contenuto è una sentinella arriva qui con un blocco `text` e verrebbe salvata
 * da `hasItems` — mentre il campo `content`, appena sopra, l'ha dichiarata
 * vuota. Due letture della stessa riga che si contraddicono.
 *
 * Vale anche per il cartello `woken`, che dice DA DOVE viene una risposta e non
 * È la risposta: da solo, su un risveglio che non ha niente da dire, sarebbe
 * un'intestazione senza corpo — una bolla in chat per annunciare il nulla.
 *
 * Un blocco `tool` (o qualunque altro tipo) è lavoro e vince sempre.
 */
function blocksAreOnlyEmptyText(v: unknown[] | string | null | undefined): boolean {
  if (!hasItems(v)) return false;
  let arr: unknown[];
  try {
    arr = Array.isArray(v) ? v : JSON.parse(String(v));
  } catch {
    return false; // illeggibile: non è «solo testo vuoto», nel dubbio si tiene
  }
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.every((b) => {
    const blocco = b as { kind?: string; text?: string } | null;
    if (!blocco) return false;
    if (blocco.kind === "woken") return true; // un cartello non è un contenuto
    if (blocco.kind !== "text") return false;
    const t = (blocco.text ?? "").trim();
    return !t || isNoContentSentinel(t);
  });
}

/**
 * `true` quando il turno dell'assistente non ha prodotto NIENTE di mostrabile.
 * Il ruolo va passato quando lo si conosce: solo l'assistente ha segnaposto da
 * scartare — un messaggio dell'utente vuoto non arriva mai fin qui, e se
 * arrivasse non sarebbe questo il posto per toglierlo.
 */
export function isEmptyAssistantTurn(msg: AssistantTurnShape): boolean {
  if (msg.role && msg.role !== "assistant") return false;
  const testo = (msg.content ?? "").trim();
  // Una sentinella non conta come contenuto: vedi `SENTINELLE_VUOTE`. Il resto
  // del predicato prosegue — se quel turno ha comunque prodotto tool o media,
  // ha fatto lavoro e resta.
  if (testo && !isNoContentSentinel(testo)) return false;
  if ((msg.thinking ?? "").trim()) return false;
  if (hasItems(msg.toolCalls)) return false;
  if (hasItems(msg.blocks) && !blocksAreOnlyEmptyText(msg.blocks)) return false;
  if (hasItems(msg.media)) return false;
  return true;
}
