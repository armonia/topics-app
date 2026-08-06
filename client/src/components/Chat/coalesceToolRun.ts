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

import type { ChatMessage, ContentBlock } from '../../types';

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
 * Fonde le corse di messaggi assistant senza prosa. Puro: nessun React, si
 * prova sotto `bun:test`.
 */
export function coalesceToolRuns(messages: ChatMessage[]): CoalesceResult {
  const items: CoalescedMessage[] = [];
  const carrierById = new Map<string, string>();

  for (const msg of messages) {
    const prev = items[items.length - 1];
    const fondibile =
      prev !== undefined &&
      isWorkOnlyAssistant(prev) &&
      isWorkOnlyAssistant(msg) &&
      // Un item già fuso resta fondibile: la corsa può essere lunga quanto
      // vuole. Ma senza id non si può tenere la contabilità dei marker.
      !!prev.id &&
      !!msg.id;

    if (!fondibile) {
      items.push(msg);
      continue;
    }

    const portante = prev as CoalescedMessage;
    const mergedIds = [...(portante.mergedIds ?? [portante.id]), msg.id];
    carrierById.set(msg.id, portante.id);

    items[items.length - 1] = {
      ...portante,
      mergedIds,
      // La timeline è la sola cosa che cresce davvero. `toolCalls` la si tiene
      // allineata perché ci sono lettori che contano le azioni del messaggio
      // (il badge «in attesa di input», per dirne uno) e leggono quel secchio.
      blocks: [...blocksOf(portante), ...blocksOf(msg)],
      toolCalls: [...(portante.toolCalls ?? []), ...(msg.toolCalls ?? [])],
      // Il ragionamento vive nei blocks e da lì viene renderizzato: il secchio
      // `thinking` è la forma VECCHIA della stessa cosa, e tenerlo qui la
      // farebbe comparire due volte. (Il percorso `blocks` di MessageContent
      // non lo legge affatto — con la timeline popolata è già ignorato.)
      thinking: undefined,
      // L'orario dell'item è quello dell'ULTIMA azione: è quando la corsa è
      // finita, ed è il numero che uno cerca guardando una riga di cronaca.
      timestamp: msg.timestamp || portante.timestamp,
      // Le metriche si sommano: la corsa ha un costo, ed è la somma dei suoi
      // pezzi. Assente resta assente (≠ zero).
      latencyMs: addMetric(portante.latencyMs, msg.latencyMs),
      costCents: addMetric(portante.costCents, msg.costCents),
      usagePromptTokens: addMetric(portante.usagePromptTokens, msg.usagePromptTokens),
      usageCompletionTokens: addMetric(portante.usageCompletionTokens, msg.usageCompletionTokens),
      cacheReadTokens: addMetric(portante.cacheReadTokens, msg.cacheReadTokens),
      cacheCreationTokens: addMetric(portante.cacheCreationTokens, msg.cacheCreationTokens),
      cacheCreation1hTokens: addMetric(portante.cacheCreation1hTokens, msg.cacheCreation1hTokens),
      media: [...(portante.media ?? []), ...(msg.media ?? [])],
    };
  }

  return { items, carrierById };
}
