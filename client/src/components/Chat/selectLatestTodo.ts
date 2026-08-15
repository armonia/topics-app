/**
 * Latest-TodoWrite selector (CHAT-TODO-01).
 *
 * The sticky strip above the composer mirrors the CLI's persistent todo:
 * the most recent `TodoWrite` for the session, so the current plan stays in
 * view while the user types instead of scrolling back to the inline card.
 *
 * Pure + framework-free so it unit-tests under bun:test.
 */

import type { ChatMessage, ToolCall } from '../../types';
import { TODO_TOOL_NAMES, resolveToolDetail } from './toolDetail';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TodoSnapshot {
  items: TodoItem[];
  done: number;
  total: number;
  /** The item currently in progress, if any (for the collapsed one-liner). */
  active?: TodoItem;
}

/**
 * Il filtro a monte, e serve a un motivo di costo: `resolveToolDetail` valida il
 * `detail` del server con Zod, e questa selezione gira a OGNI frame di streaming
 * su tutto il trascritto. Su una sessione che non ha mai visto una todo — la
 * maggioranza — quello era un parse per ogni tool call, sessanta volte al
 * secondo, per rispondere sempre `null`. Un confronto di stringa lo evita.
 *
 * I nomi arrivano da `toolDetail.ts`, che è anche chi li riconosce: erano due
 * liste tenute uguali da un commento.
 */
function mayCarryTodo(tc: ToolCall): boolean {
  // Il `detail` del server, quando dice `todo`, decide da solo: il nome non
  // conta (un provider può chiamare lo strumento come vuole).
  if (tc.detail?.type === 'todo') return true;
  // Ma un detail che dice ALTRO non è una risposta definitiva: `resolveToolDetail`
  // lo valida con Zod e, se non passa, ricade su `deriveToolDetail` — che sul
  // nome ricostruisce la todo. Uscire qui su `tc.detail` presente saltava proprio
  // quel ripiego: la stessa chiamata perdeva la striscia mentre `MessageContent`
  // le disegnava lo stesso la TodoCard.
  return TODO_TOOL_NAMES.has((tc.name || '').toLowerCase().trim());
}

function todoItemsFromCall(tc: ToolCall): TodoItem[] | null {
  if (!mayCarryTodo(tc)) return null;
  const detail = resolveToolDetail(tc);
  return detail.type === 'todo' ? detail.items : null;
}

function snapshotOf(items: TodoItem[]): TodoSnapshot | null {
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === 'completed').length;
  const active = items.find((t) => t.status === 'in_progress');
  return { items, done, total: items.length, ...(active ? { active } : {}) };
}

/** L'ultima risposta, con l'indice del messaggio da cui è venuta (-1 = nessuna). */
interface TodoCache {
  input: ChatMessage[];
  result: TodoSnapshot | null;
  foundAt: number;
}
let cache: TodoCache | null = null;

/** Quanti elementi in testa sono lo STESSO oggetto nelle due liste. */
function commonPrefixLength(a: ChatMessage[], b: ChatMessage[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** La scansione vera, dal fondo verso `from` compreso. */
function scanBack(messages: ChatMessage[], from: number): { result: TodoSnapshot | null; foundAt: number } {
  for (let i = messages.length - 1; i >= from; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const calls = msg.toolCalls;
    if (!calls || calls.length === 0) continue;
    for (let j = calls.length - 1; j >= 0; j--) {
      const items = todoItemsFromCall(calls[j]);
      if (items) return { result: snapshotOf(items), foundAt: i };
    }
  }
  return { result: null, foundAt: -1 };
}

/**
 * Scan messages newest-first for the most recent TodoWrite and return its
 * snapshot. Returns null when the session has no todos, or when the latest
 * todo list is empty (nothing worth pinning).
 *
 * Memorizzato sul PREFISSO PER RIFERIMENTO della chiamata precedente: durante un
 * turno cambia solo l'ultima bolla, quindi si riscandisce la coda e basta. Il
 * risultato è lo STESSO oggetto quando la risposta non è cambiata, così la
 * striscia non si ridisegna a ogni token.
 */
export function selectLatestTodo(messages: ChatMessage[]): TodoSnapshot | null {
  const prev = cache;
  if (prev && prev.input === messages) return prev.result;

  if (prev) {
    const p = commonPrefixLength(prev.input, messages);
    const coda = scanBack(messages, p);
    if (coda.foundAt >= 0) {
      cache = { input: messages, result: coda.result, foundAt: coda.foundAt };
      return coda.result;
    }
    // Niente nella coda: la risposta sta nel prefisso, che è identico a prima.
    // `foundAt === -1` vuol dire «in tutto l'ingresso precedente non c'era
    // nessuna todo», e il prefisso ne è un sottoinsieme: quindi neanche qui.
    if (prev.foundAt < p) {
      cache = { input: messages, result: prev.result, foundAt: prev.foundAt };
      return prev.result;
    }
  }

  const pieno = scanBack(messages, 0);
  cache = { input: messages, result: pieno.result, foundAt: pieno.foundAt };
  return pieno.result;
}
