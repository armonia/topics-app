import type { ChatMessage } from '../types';

/**
 * Riconciliazione per IDENTITÀ della storia di una chat.
 *
 * IL DIFETTO CHE CHIUDE. Al ricarico la chat nasce dalla copia locale — i
 * messaggi sono già a schermo — e subito dopo `loadHistory` chiede al server la
 * storia autorevole. Nel 99% dei casi quella risposta contiene ESATTAMENTE gli
 * stessi messaggi; ma arrivava come oggetti nuovi di zecca, quindi ogni
 * `MessageBubble` si ri-renderizzava, la lista virtuale ri-misurava tutte le
 * altezze e si ri-ancorava. Misurato con la sonda del CLS: la lista si
 * ri-assembla intorno al secondo (y 264 → 694 → 504), **0,216 di CLS sul
 * telefono** — con la conversazione già sotto gli occhi da mezzo secondo. Non
 * era la rete a essere lenta: era il ritorno trattato come una partenza.
 *
 * COSA FA. Confronta la lista che c'è con quella che arriva e riusa gli OGGETTI
 * di prima per i messaggi che non sono cambiati. Se non è cambiato niente
 * restituisce l'array PRECEDENTE — che è il caso importante: `setMessages` vede
 * lo stesso riferimento, React salta il render, e la lista non si accorge di
 * niente. Quando invece qualcosa è cambiato davvero (un messaggio nuovo, uno
 * modificato) l'array è nuovo, ma solo le bolle cambiate hanno un oggetto nuovo.
 *
 * NON è una fusione: la lista che arriva è l'autorità, sia nell'ordine sia nel
 * contenuto. Qui si decide solo di CHI riusare l'identità.
 */

/**
 * Due messaggi dicono la stessa cosa?
 *
 * Confronto per CAMPI e non `JSON.stringify` dei due interi: i due lati nascono
 * da percorsi diversi (uno è passato per `localStorage`, l'altro arriva dalla
 * risposta HTTP) e l'ordine delle chiavi non è garantito uguale — con la
 * stringa, due messaggi identici risulterebbero diversi e la riconciliazione non
 * riuserebbe mai niente, in silenzio. Sui valori annidati (blocchi tool, branch)
 * `JSON.stringify` invece va bene: lì la forma la decide il server, che è la
 * stessa sorgente per entrambi i lati.
 */
export function sameChatMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true;
  const chiavi = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of chiavi) {
    const va = (a as unknown as Record<string, unknown>)[k];
    const vb = (b as unknown as Record<string, unknown>)[k];
    if (Object.is(va, vb)) continue;
    if (va === null || vb === null || typeof va !== 'object' || typeof vb !== 'object') return false;
    try {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
    } catch {
      // Ciclico o non serializzabile: non si può dire che siano uguali.
      return false;
    }
  }
  return true;
}

/**
 * La storia autorevole PIÙ ciò che è arrivato via WS mentre la si scaricava.
 *
 * IL DIFETTO CHE CHIUDE. `loadHistory` teneva additivamente ogni messaggio
 * locale il cui id non era nella risposta. Ma a metà turno il server RESTITUISCE
 * la riga parziale (`routes/history.ts`: con uno stream attivo i parziali non si
 * filtrano, e il contenuto vivo ci viene sovrapposto) sotto il suo id di DB,
 * mentre la finestra che sta solo guardando il turno tiene un segnaposto con un
 * id coniato in locale. Due id per lo stesso turno: il filtro non poteva
 * accorgersene, li teneva entrambi, e la risposta in volo compariva DUE VOLTE
 * — una piena e una che continuava a crescere sotto.
 *
 * La regola: se la coda della storia è già un assistant parziale, quel turno il
 * server ce l'ha, e un parziale locale che non è nella risposta è lo stesso
 * turno visto con un nome provvisorio. Si butta il nome provvisorio. Tutto il
 * resto (un messaggio utente appena inviato, un `message:new` arrivato durante
 * il fetch) continua a passare come prima.
 */
export function mergeFetchedHistory(existing: ChatMessage[], fetched: ChatMessage[]): ChatMessage[] {
  if (existing.length === 0) return fetched;
  const fetchedIds = new Set<string>();
  for (const m of fetched) if (m.id) fetchedIds.add(m.id);
  const coda = fetched[fetched.length - 1];
  const codaInVolo = coda?.role === 'assistant' && coda.partial === true;
  const localOnly = existing.filter((m) => {
    if (!m.id || fetchedIds.has(m.id)) return false;
    if (codaInVolo && m.role === 'assistant' && m.partial === true) return false;
    return true;
  });
  return localOnly.length > 0 ? [...fetched, ...localOnly] : fetched;
}

/**
 * `prev` se non è cambiato NIENTE (stessa lunghezza, ogni messaggio uguale),
 * altrimenti `next` con l'identità dei messaggi invariati presa da `prev`.
 */
export function reconcileMessages(prev: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  if (prev === next) return prev;
  if (prev.length === 0) return next;
  // Indice per id: la storia autorevole può aver riordinato o inserito in mezzo
  // (una compattazione, un messaggio recuperato), e un confronto posizionale
  // butterebbe via l'identità di tutto ciò che sta dopo il primo scarto.
  const perId = new Map<string, ChatMessage>();
  for (const m of prev) if (m.id) perId.set(m.id, m);

  let identico = prev.length === next.length;
  const out = next.map((m, i) => {
    const vecchio = (m.id && perId.get(m.id)) || undefined;
    if (vecchio && sameChatMessage(vecchio, m)) {
      if (prev[i] !== vecchio) identico = false;
      return vecchio;
    }
    identico = false;
    return m;
  });
  return identico ? prev : out;
}
