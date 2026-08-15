/**
 * UNA CORSA DI TOOL È UN ITEM SOLO — e prima erano N messaggi.
 *
 * Il raggruppamento dei tool esisteva già ed era cablato (`GroupedToolRows` →
 * `partitionToolGroup`, soglia `GROUP_MIN`), ma non scattava quasi mai, e il
 * motivo non stava nel raggruppatore: stava nella forma dei dati.
 *
 * Claude Code emette una entry `assistant` per OGNI blocco di contenuto, e
 * l'importer la trascrive uno-a-uno. Misurato sul DB vivo: 5.098 messaggi
 * assistant con ESATTAMENTE una tool call, testo vuoto, `blocks` NULL — su una
 * chat qualsiasi sono 85 su 117. Il raggruppatore però lavora DENTRO un
 * messaggio, quindi riceveva sempre un array di lunghezza uno e non aveva
 * niente da raggruppare. I test restavano verdi perché provano le funzioni
 * pure, che sono giuste.
 *
 * Lo stesso difetto spiega il vuoto fra le righe, ed è la parte che si vede di
 * più: se ogni tool è un MESSAGGIO, ogni tool si porta dietro il vestito di un
 * messaggio — margine della bolla, margine del blocco pre-contenuto, e la riga
 * del timestamp, che sta sempre nel DOM (invisibile, `opacity-0`) e occupa il
 * suo spazio. Sono circa trenta pixel di niente attorno a una riga alta
 * ventisei.
 *
 * Qui la corsa torna a essere una cosa sola: i messaggi assistant CONSECUTIVI
 * e SENZA PROSA (solo tool, o solo ragionamento) si fondono in un item con la
 * timeline `blocks` in ordine cronologico. Il raggruppatore vede finalmente la
 * corsa intera e la collassa in «N azioni», e il vestito da messaggio si paga
 * una volta invece di N.
 *
 * Tre confini, e sono deliberati:
 *  • un messaggio CON prosa non si fonde mai — è la risposta, e resta una
 *    bolla sua (è anche come si legge nella CLI: la corsa di azioni si chiude,
 *    poi parla);
 *  • un messaggio `partial` non si fonde mai — quello in streaming è vivo, e
 *    fondere sotto di lui vorrebbe dire rimescolare l'item che sta crescendo;
 *  • gli id assorbiti NON si perdono: viaggiano in `mergedIds`, così i marker
 *    di compattazione ancorati a uno di essi e i salti da palette continuano a
 *    trovare la riga giusta.
 */

import type { ChatMessage, ContentBlock, ToolCall } from '../../types';

/** Un item della lista: un messaggio, eventualmente portatore di altri. */
export interface CoalescedMessage extends ChatMessage {
  /**
   * Gli id dei messaggi assorbiti in questo item, quello portante COMPRESO e
   * per primo. Presente solo quando una fusione è avvenuta davvero: chi non
   * l'ha, è un messaggio come prima.
   */
  mergedIds?: string[];
}

/**
 * Il messaggio è una riga di CRONACA — lavoro senza parole?
 *
 * `content` vuoto e almeno un tool (o del ragionamento). È esattamente la
 * forma che il transcript produce per ogni azione.
 */
export function isWorkOnlyAssistant(msg: ChatMessage): boolean {
  if (msg.role !== 'assistant') return false;
  if (msg.partial) return false;
  if ((msg.content ?? '').trim().length > 0) return false;
  const hasTools = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
  const hasBlocks = Array.isArray(msg.blocks) && msg.blocks.length > 0;
  return hasTools || hasBlocks || !!msg.thinking;
}

/**
 * La timeline di UN messaggio, qualunque forma abbia sulla riga.
 *
 * I messaggi nuovi ce l'hanno già (`blocks`); quelli importati no, e vanno
 * ricostruiti dai secchi — ragionamento prima, poi le azioni, che è l'ordine
 * in cui il percorso legacy li renderizzava comunque.
 */
export function blocksOf(msg: ChatMessage): ContentBlock[] {
  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) return msg.blocks;
  const out: ContentBlock[] = [];
  if (msg.thinking) out.push({ kind: 'thinking', text: msg.thinking });
  for (const tc of msg.toolCalls ?? []) out.push({ kind: 'tool', toolCall: tc });
  const text = (msg.content ?? '').trim();
  if (text) out.push({ kind: 'text', text: msg.content as string });
  return out;
}

/** Somma due metriche che possono mancare; assente + assente = assente. */
function addMetric(a: number | null | undefined, b: number | null | undefined): number | null | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return a + b;
}

export interface CoalesceResult {
  /** La lista da renderizzare. */
  items: CoalescedMessage[];
  /**
   * id assorbito → id dell'item che lo porta. Vuota quando non è successo
   * niente, così chi la consulta paga zero sul caso comune.
   */
  carrierById: Map<string, string>;
}

/**
 * Il portante di UNA corsa, costruito in una passata sola.
 *
 * Prima si costruiva per accumulo: a ogni messaggio assorbito si ri-spandevano
 * `blocks` e `toolCalls` dell'item che c'era già, quindi una corsa di k azioni
 * costava O(k²) copie di array e k oggetti buttati via. Su una corsa lunga (le
 * ottantacinque azioni di cui parla l'intestazione) era il grosso del lavoro di
 * OGNI frame di streaming. Qui i pezzi si raccolgono e si concatenano UNA volta,
 * quando la corsa si chiude.
 */
function buildCarrier(run: ChatMessage[]): CoalescedMessage {
  const head = run[0] as CoalescedMessage;
  const mergedIds = [...(head.mergedIds ?? [head.id])];
  const blocks: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const media: string[] = [];
  let timestamp = head.timestamp;
  let latencyMs = head.latencyMs;
  let costCents = head.costCents;
  let usagePromptTokens = head.usagePromptTokens;
  let usageCompletionTokens = head.usageCompletionTokens;
  let cacheReadTokens = head.cacheReadTokens;
  let cacheCreationTokens = head.cacheCreationTokens;
  let cacheCreation1hTokens = head.cacheCreation1hTokens;

  for (let i = 0; i < run.length; i++) {
    const m = run[i];
    for (const b of blocksOf(m)) blocks.push(b);
    if (m.toolCalls) for (const tc of m.toolCalls) toolCalls.push(tc);
    if (m.media) for (const p of m.media) media.push(p);
    if (i === 0) continue;
    mergedIds.push(m.id);
    // L'orario dell'item è quello dell'ULTIMA azione: è quando la corsa è
    // finita, ed è il numero che uno cerca guardando una riga di cronaca.
    timestamp = m.timestamp || timestamp;
    // Le metriche si sommano: la corsa ha un costo, ed è la somma dei suoi
    // pezzi. Assente resta assente (≠ zero).
    latencyMs = addMetric(latencyMs, m.latencyMs);
    costCents = addMetric(costCents, m.costCents);
    usagePromptTokens = addMetric(usagePromptTokens, m.usagePromptTokens);
    usageCompletionTokens = addMetric(usageCompletionTokens, m.usageCompletionTokens);
    cacheReadTokens = addMetric(cacheReadTokens, m.cacheReadTokens);
    cacheCreationTokens = addMetric(cacheCreationTokens, m.cacheCreationTokens);
    cacheCreation1hTokens = addMetric(cacheCreation1hTokens, m.cacheCreation1hTokens);
  }

  return {
    ...head,
    mergedIds,
    // La timeline è la sola cosa che cresce davvero. `toolCalls` la si tiene
    // allineata perché ci sono lettori che contano le azioni del messaggio
    // (il badge «in attesa di input», per dirne uno) e leggono quel secchio.
    blocks,
    toolCalls,
    // Il ragionamento vive nei blocks e da lì viene renderizzato: il secchio
    // `thinking` è la forma VECCHIA della stessa cosa, e tenerlo qui la
    // farebbe comparire due volte. (Il percorso `blocks` di MessageContent
    // non lo legge affatto — con la timeline popolata è già ignorato.)
    thinking: undefined,
    timestamp,
    latencyMs,
    costCents,
    usagePromptTokens,
    usageCompletionTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreation1hTokens,
    media,
  };
}

/**
 * LA CORSA CHE NON CAMBIA NON SI RIFÀ — e durante un turno non cambia niente
 * tranne l'ultima bolla.
 *
 * Il chiamante è `MessageList`, che rideriva la lista a ogni frame di
 * streaming: senza memoria, ogni token rifondeva l'INTERO trascritto e coniava
 * un portante nuovo per ogni corsa già finita da un pezzo. Gli oggetti erano
 * diversi, quindi `MessageBubble` (che è `memo`) non poteva saltare: si
 * ridisegnavano tutte le bolle di tool visibili, sessanta volte al secondo.
 *
 * La memoria è indicizzata per RIFERIMENTO, non per contenuto: due liste che
 * condividono un prefisso di oggetti identici hanno per forza gli stessi item
 * su quel prefisso, perché la decisione di fondere guarda solo il messaggio e
 * quello prima. Il prezzo è una scansione di puntatori (nanosecondi per
 * elemento); quello che si evita è la copia di array e l'allocazione di oggetti,
 * che costano tre ordini di grandezza in più.
 *
 * Più di una voce perché le pane affiancate chiamano questa funzione a turno su
 * trascritti diversi, e una sola voce si distruggerebbe a vicenda.
 */
interface CoalesceCacheEntry {
  input: ChatMessage[];
  items: CoalescedMessage[];
  carrierById: Map<string, string>;
  /** Indice in `input` appena OLTRE l'ultimo messaggio dell'item i. Crescente. */
  itemEnd: number[];
  /** Le voci di `carrierById` in ordine, per poterne riusare un prefisso. */
  carrierEntries: Array<[string, string]>;
  /** Quante voci di `carrierEntries` esistevano dopo l'item i. */
  carrierCount: number[];
  /** Ultima volta che qualcuno ha disegnato questo trascritto. */
  touchedAt: number;
}

const CACHE_MAX = 4;
/**
 * Quanto una voce sopravvive all'ULTIMO disegno del suo trascritto.
 *
 * Il tetto di quattro voci limita QUANTE, non PER QUANTO: una voce trattiene
 * l'array dei messaggi, i portanti fusi e le mappe, e senza scadenza li teneva
 * per la vita della pagina — comprese le pane chiuse e le sessioni che lo
 * spazzino della residenza aveva già sfrattato dal message store. Chi è ancora
 * a schermo si ridisegna molte volte al secondo e non scade mai; chi scade paga
 * una ricostruzione sola, che è il comportamento che c'era prima della memoria.
 */
const CACHE_TTL_MS = 60_000;
const cache: CoalesceCacheEntry[] = [];

/** Butta le voci che nessuno guarda da un minuto. */
function sweepCache(now: number): void {
  for (let i = cache.length - 1; i >= 0; i--) {
    if (now - cache[i].touchedAt > CACHE_TTL_MS) cache.splice(i, 1);
  }
}

/**
 * La voce che parla dello STESSO trascritto. Il primo messaggio come chiave:
 * è l'oggetto che sopravvive a tutto il turno, e confrontarlo costa un puntatore
 * invece di scandire quattro liste per trovare il prefisso migliore.
 */
function lookupCache(messages: ChatMessage[]): CoalesceCacheEntry | undefined {
  if (messages.length === 0) return undefined;
  for (let i = 0; i < cache.length; i++) {
    const e = cache[i];
    if (e.input === messages || (e.input.length > 0 && e.input[0] === messages[0])) {
      if (i > 0) { cache.splice(i, 1); cache.unshift(e); }
      return e;
    }
  }
  return undefined;
}

function storeCache(entry: CoalesceCacheEntry): void {
  const at = cache.indexOf(entry);
  if (at >= 0) cache.splice(at, 1);
  cache.unshift(entry);
  if (cache.length > CACHE_MAX) cache.length = CACHE_MAX;
}

/** Quanti elementi in testa sono lo STESSO oggetto nelle due liste. */
function commonPrefixLength(a: ChatMessage[], b: ChatMessage[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Quanti item finiscono a `p` o prima (`itemEnd` è crescente). */
function itemsEndingWithin(itemEnd: number[], p: number): number {
  let lo = 0;
  let hi = itemEnd.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (itemEnd[mid] <= p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Fonde le corse di messaggi assistant senza prosa. Puro nel risultato: a parità
 * di ingresso torna lo stesso valore, e sul prefisso invariato gli STESSI
 * oggetti (vedi la memoria qui sopra). Si prova sotto `bun:test`.
 */
export function coalesceToolRuns(messages: ChatMessage[], now: number = Date.now()): CoalesceResult {
  sweepCache(now);
  const hit = lookupCache(messages);
  if (hit && hit.input === messages) {
    hit.touchedAt = now;
    return { items: hit.items, carrierById: hit.carrierById };
  }

  let reuse = 0;
  if (hit) {
    const p = commonPrefixLength(hit.input, messages);
    let k = itemsEndingWithin(hit.itemEnd, p);
    // Un item che finisce ESATTAMENTE sul confine del prefisso si riusa solo se
    // il messaggio che gli sta dietro NON può fondercisi: lì il prefisso non
    // dice più niente, e riusarlo alla cieca congelerebbe una corsa che invece
    // deve continuare a crescere.
    if (k > 0 && hit.itemEnd[k - 1] === p && p < messages.length && isWorkOnlyAssistant(messages[p])) k--;
    reuse = k;
  }

  const from = reuse > 0 ? hit!.itemEnd[reuse - 1] : 0;
  const items: CoalescedMessage[] = reuse > 0 ? hit!.items.slice(0, reuse) : [];
  const itemEnd: number[] = reuse > 0 ? hit!.itemEnd.slice(0, reuse) : [];
  const carrierCount: number[] = reuse > 0 ? hit!.carrierCount.slice(0, reuse) : [];
  const carrierEntries: Array<[string, string]> =
    reuse > 0 ? hit!.carrierEntries.slice(0, carrierCount[reuse - 1]) : [];
  const reusedEntries = carrierEntries.length;

  let run: ChatMessage[] = [];
  const closeRun = (end: number): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      // Un messaggio solo non si tocca: stesso oggetto, nessun `mergedIds`.
      items.push(run[0]);
    } else {
      const carrier = buildCarrier(run);
      for (let i = 1; i < run.length; i++) carrierEntries.push([run[i].id, carrier.id]);
      items.push(carrier);
    }
    itemEnd.push(end);
    carrierCount.push(carrierEntries.length);
    run = [];
  };

  for (let i = from; i < messages.length; i++) {
    const msg = messages[i];
    const prev = run.length > 0 ? run[run.length - 1] : undefined;
    const fondibile =
      prev !== undefined &&
      isWorkOnlyAssistant(prev) &&
      isWorkOnlyAssistant(msg) &&
      // Una corsa già aperta resta fondibile: può essere lunga quanto vuole. Ma
      // senza id non si può tenere la contabilità dei marker.
      !!run[0].id &&
      !!msg.id;
    if (!fondibile) closeRun(i);
    run.push(msg);
  }
  closeRun(messages.length);

  // La mappa si riusa TALE E QUALE quando la coda ricalcolata non ha prodotto
  // nessuna fusione nuova: è il caso di ogni frame di streaming, e ricostruirla
  // regalerebbe a chi la consulta un'identità nuova per niente.
  const carrierById =
    hit && carrierEntries.length === reusedEntries && reusedEntries === hit.carrierEntries.length
      ? hit.carrierById
      : new Map(carrierEntries);

  storeCache({ input: messages, items, carrierById, itemEnd, carrierEntries, carrierCount, touchedAt: now });
  return { items, carrierById };
}
