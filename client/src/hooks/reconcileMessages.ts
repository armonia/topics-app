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
