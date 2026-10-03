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
 *
 * Since the person's rows carry the send's key (`clientMessageId`), a bubble
 * is matched to the row with ITS key, and the words are asked only of rows
 * with no key at all (stored before the key was written on the row).
 */
export interface MergeHistoryOptions {
  /**
   * A turn of this session ended in this window while the answer was in
   * flight: the answer's partial copy of that turn is older than the bubble
   * the end closed here.
   */
  endedMeanwhile?: boolean;
  /** The row of the turn streaming into this window now, if any. */
  liveRowId?: string;
}

export function mergeFetchedHistory(existing: ChatMessage[], fetched: ChatMessage[], opts: MergeHistoryOptions = {}): ChatMessage[] {
  if (existing.length === 0) return fetched;
  const fetchedIds = new Set<string>();
  for (const m of fetched) if (m.id) fetchedIds.add(m.id);
  const existingIds = new Set<string>();
  for (const m of existing) if (m.id) existingIds.add(m.id);
  const coda = fetched[fetched.length - 1];
  const codaInVolo = coda?.role === 'assistant' && coda.partial === true;

  // The keys the history rows were sent with: a bubble under its local name
  // whose key is here IS that row, whatever its words.
  const fetchedKeys = new Set<string>();
  for (const m of fetched) if (m.role === 'user' && m.clientMessageId) fetchedKeys.add(m.clientMessageId);

  // The history rows no message on screen already claims by id, and that
  // carry no key (stored before the key was written on the row): the only
  // ones a local bubble can recognise by its words. Counted, because two equal
  // rows are two echoes, not one. A row WITH a key is never matched by words:
  // it belongs to the send that carried that key, and another send with the
  // same words is another message.
  const echiDisponibili = new Map<string, number>();
  for (const m of fetched) {
    if (m.id && existingIds.has(m.id)) continue;
    if (m.clientMessageId) continue;
    const k = echoKey(m);
    if (!k) continue;
    echiDisponibili.set(k, (echiDisponibili.get(k) ?? 0) + 1);
  }

  // The server's copy of the live turn is a snapshot taken when the request
  // was READ, and the socket may have delivered more of the same turn before
  // the answer arrived. Replacing the bubble with the older snapshot dropped
  // those chunks, and the ones after were appended to it: a hole in the
  // middle of the turn (card 423e016f). The local copy of the SAME row wins
  // when it extends the server's text from its first character, or when the
  // turn ended here while the answer was in flight and the end closed it.
  const liveAhead = codaInVolo ? localAheadOf(existing, coda, opts.endedMeanwhile === true) : null;
  const base = liveAhead ? [...fetched.slice(0, -1), liveAhead] : fetched;

  const localOnly = existing.filter((m) => {
    if (!m.id || fetchedIds.has(m.id)) return false;
    if (codaInVolo && m.role === 'assistant' && m.partial === true) return false;
    // A partial row the SERVER named, which the server no longer has, is a row
    // it deleted: an empty turn stopped or woken with nothing to say. Kept, it
    // was a bubble with a spinner and a locked composer until a reload. Not
    // the row of the turn streaming here: it can be younger than the read.
    if (m.role === 'assistant' && m.partial === true && !isClientGeneratedMessageId(m.id) && m.id !== opts.liveRowId) return false;
    // A bubble still under its local name is one whose row's announcement did
    // not reach this window (the announcement renames it, `hooks/ownBubble.ts`).
    // Its row is the one with its key; failing that, a row with no key and
    // the same words (`echiDisponibili`).
    if (isClientGeneratedMessageId(m.id)) {
      if (m.clientMessageId && fetchedKeys.has(m.clientMessageId)) return false;
      const k = echoKey(m);
      const disponibili = k ? echiDisponibili.get(k) ?? 0 : 0;
      if (k && disponibili > 0) {
        echiDisponibili.set(k, disponibili - 1);
        return false;
      }
    }
    return true;
  });
  return localOnly.length > 0 ? [...base, ...localOnly] : base;
}

/**
 * The local copy of the server's live tail, when it is NEWER than it: same row
 * id, and either closed by an end that came while the answer was in flight,
 * or still partial with a text that starts with the server's and goes
 * further. Null otherwise, and then the server's copy is the truth: a local
 * bubble built from the live chunks alone does not start with the server's
 * text, and that is exactly the one to replace.
 *
 * A closed bubble wins only on an answer older than an end seen HERE: a
 * bubble closed for another reason (the stream watchdog, a frame lost) is not
 * evidence that the server's partial row is stale.
 */
function localAheadOf(existing: ChatMessage[], serverTail: ChatMessage, endedMeanwhile: boolean): ChatMessage | null {
  if (!serverTail.id) return null;
  const local = existing.find((m) => m.id === serverTail.id);
  if (!local || local.role !== 'assistant') return null;
  if (local.partial !== true) return endedMeanwhile ? withServerBanners(local, serverTail) : null;
  const mine = local.content ?? '';
  const theirs = serverTail.content ?? '';
  if (!(mine.length > theirs.length && mine.startsWith(theirs))) return null;
  return withServerBanners(local, serverTail);
}

/**
 * The row's banners (a woken turn, a resumed one) are written by the server at
 * the start of the timeline and no live frame carries them: the local copy may
 * not have them, and keeping it, still streaming or closed by an end seen here,
 * must not drop them. A woken turn is short enough that the closed case is the
 * common one: its answer came back after the end, and the Monitor's event
 * stayed hidden until a reload.
 */
function withServerBanners(local: ChatMessage, serverTail: ChatMessage): ChatMessage {
  const localBlocks = local.blocks ?? [];
  const banners = (serverTail.blocks ?? []).filter(
    (b) => (b.kind === 'woken' || b.kind === 'ripreso') && !localBlocks.some((l) => l.kind === b.kind),
  );
  return banners.length > 0 ? { ...local, blocks: [...banners, ...localBlocks] } : local;
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
