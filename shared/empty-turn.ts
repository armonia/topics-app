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
 * `true` quando il turno dell'assistente non ha prodotto NIENTE di mostrabile.
 * Il ruolo va passato quando lo si conosce: solo l'assistente ha segnaposto da
 * scartare — un messaggio dell'utente vuoto non arriva mai fin qui, e se
 * arrivasse non sarebbe questo il posto per toglierlo.
 */
export function isEmptyAssistantTurn(msg: AssistantTurnShape): boolean {
  if (msg.role && msg.role !== "assistant") return false;
  if ((msg.content ?? "").trim()) return false;
  if ((msg.thinking ?? "").trim()) return false;
  if (hasItems(msg.toolCalls)) return false;
  if (hasItems(msg.blocks)) return false;
  if (hasItems(msg.media)) return false;
  return true;
}
