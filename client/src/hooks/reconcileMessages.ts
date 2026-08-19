import type { ChatMessage } from '../types';
import { isClientGeneratedMessageId } from './streamCatchupMerge';

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
 *
 * IL SECONDO DIFETTO CHE CHIUDE, ed è quello visto in chat. Il messaggio che
 * scrivi lo disegna subito questa finestra, con un id coniato in locale; il
 * server lo scrive nel DB sotto un id suo e lo annuncia in broadcast, ma il
 * `message:new` della PROPRIA finestra viene scartato (`isOwnStream`), quindi
 * quel nome provvisorio resta. Finché nessuno ricarica la storia non si vede
 * niente. Al primo `loadHistory` (e nella notte fra il 18 e il 19/08 la
 * WebSocket cadeva e si riapriva di continuo, quindi di ricarichi ce n'erano a
 * decine) la riga del server arriva al suo posto e il segnaposto locale, non
 * essendo in `fetchedIds`, veniva tenuto e appeso IN FONDO: la domanda compariva
 * due volte, e con essa sembrava che la chat avesse risposto due volte.
 *
 * La regola: un id coniato in locale non è un'autorità, è un'attesa di nome. Se
 * nella storia c'è una riga con lo STESSO ruolo e lo STESSO testo che nessun id
 * locale ha già rivendicato, quel segnaposto è la sua eco e si butta.
 *
 * E il caso che morde, quello per cui il conto è a MOLTEPLICITÀ e non un
 * `Set` di testi: mandare due volte la stessa domanda è legittimo. Ogni
 * segnaposto consuma UNA riga di storia; se la storia ne ha due, restano due, e
 * se ne ha una sola mentre a schermo ce ne sono due (la seconda appena spedita,
 * che il server ancora non conosce) la seconda resta a schermo. Nascondere un
 * messaggio che c'è sarebbe un difetto peggiore di mostrarne uno di troppo.
 */
export function mergeFetchedHistory(existing: ChatMessage[], fetched: ChatMessage[]): ChatMessage[] {
  if (existing.length === 0) return fetched;
  const fetchedIds = new Set<string>();
  for (const m of fetched) if (m.id) fetchedIds.add(m.id);
  const existingIds = new Set<string>();
  for (const m of existing) if (m.id) existingIds.add(m.id);
  const coda = fetched[fetched.length - 1];
  const codaInVolo = coda?.role === 'assistant' && coda.partial === true;

  // Le righe della storia che nessun messaggio a schermo rivendica già per id:
  // sono le sole su cui un segnaposto locale può riconoscersi, e si contano
  // perché due righe uguali valgono due echi, non uno.
  const echiDisponibili = new Map<string, number>();
  for (const m of fetched) {
    if (m.id && existingIds.has(m.id)) continue;
    const k = echoKey(m);
    if (!k) continue;
    echiDisponibili.set(k, (echiDisponibili.get(k) ?? 0) + 1);
  }

  const localOnly = existing.filter((m) => {
    if (!m.id || fetchedIds.has(m.id)) return false;
    if (codaInVolo && m.role === 'assistant' && m.partial === true) return false;
    if (isClientGeneratedMessageId(m.id)) {
      const k = echoKey(m);
      const disponibili = k ? echiDisponibili.get(k) ?? 0 : 0;
      if (k && disponibili > 0) {
        echiDisponibili.set(k, disponibili - 1);
        return false;
      }
    }
    return true;
  });
  return localOnly.length > 0 ? [...fetched, ...localOnly] : fetched;
}

/**
 * IL NOME VERO DELLA BOLLA CHE HAI APPENA SCRITTO.
 *
 * La finestra da cui parte il messaggio lo disegna subito, con un id coniato in
 * locale, e il `message:new` che porta l'id del DB lo scarta come «roba mia»
 * (`isOwnStream`). Quel segnaposto resta quindi senza nome vero per tutta la
 * vita della pagina, e ogni ricarico della storia deve riconoscerlo dal TESTO
 * per non disegnarlo due volte. Qui il nome arriva: la copia ottimistica adotta
 * l'id durevole, e da quel momento la dedupe torna a essere per identità.
 *
 * Si prende la PRIMA bolla con un nome provvisorio, stesso ruolo e stesso testo,
 * non l'ultima: gli annunci arrivano nell'ordine in cui il server ha scritto le
 * righe, quindi la stessa domanda mandata due volte prende i due id nell'ordine
 * giusto. Se l'id c'è già nella lista non si tocca niente.
 *
 * Restituisce l'array PRECEDENTE quando non c'è niente da adottare.
 */
export function adoptDurableMessageId(
  messages: ChatMessage[],
  incoming: { role: ChatMessage['role']; content: string; id: string },
): ChatMessage[] {
  if (!incoming.id || !incoming.content.trim()) return messages;
  const chiave = `${incoming.role}\n${incoming.content.trim()}`;
  if (messages.some((m) => m.id === incoming.id)) return messages;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isClientGeneratedMessageId(m.id)) continue;
    if (echoKey(m) !== chiave) continue;
    const out = [...messages];
    out[i] = { ...m, id: incoming.id };
    return out;
  }
  return messages;
}

/**
 * Ruolo + testo, la sola coppia su cui due copie dello stesso messaggio possono
 * riconoscersi quando i loro id non lo permettono. Vuoto (`null`) per i corpi
 * senza testo: un segnaposto ancora vuoto non deve poter «riconoscersi» in una
 * riga qualunque della storia.
 */
function echoKey(m: ChatMessage): string | null {
  const testo = (m.content ?? '').trim();
  if (!testo) return null;
  return `${m.role}\n${testo}`;
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
