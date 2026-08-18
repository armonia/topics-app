// Pure merge logic for `stream:catchup` events.
//
// The server emits `stream:catchup` on every fresh WS connect (initial app
// load, browser refresh, network reconnect, second window). It carries the
// in-memory accumulated text + thinking AND the persisted toolCalls + blocks
// from the partial DB row, so a late joiner sees the full mid-stream state
// instead of an empty bubble that suddenly fills in via subsequent
// stream:content_chunk deltas.
//
// This module isolates the merge from React state hooks so the invariants
// can be unit-tested without rendering the chat. The actual integration
// path lives in `useChat.ts` (case 'stream:catchup').
//
// Merge invariants
// ────────────────
// 1. When a partial assistant message already exists locally (e.g. a tool
//    call that arrived via WS before catchup, or a previous catchup), we
//    UPDATE it in place — never replace it. Replacing would discard local
//    progress that the server hasn't observed yet.
//
// 2. Server-truth fields (toolCalls/blocks from DB) take precedence ONLY
//    when present in the catchup event. `undefined` means "server did not
//    send this — keep whatever the local partial already had". This is
//    what makes a tool_call event arriving before catchup safe: catchup
//    doesn't wipe it.
//
// 3. Content/thinking: catchup carries the cumulative text from the
//    in-memory stream buffer. We prefer the catchup value when non-empty,
//    but fall back to the existing partial to avoid clobbering local
//    state with a "" (e.g. when the stream just started and the buffer
//    hasn't received its first delta yet).

import type { ChatMessage, ContentBlock, ToolCall } from '../types';

/**
 * Il prefisso degli id CONIATI DAL CLIENT.
 *
 * Il server usa `crypto.randomUUID()` (`createPartialMessage`, server/utils.ts),
 * quindi un id che comincia così non è mai stato in DB: è un segnaposto che
 * questa finestra si è disegnata da sola in attesa di sapere il nome vero della
 * riga. Serve saperlo distinguere perché quel segnaposto DEVE farsi da parte
 * quando l'id durevole arriva: due nomi per lo stesso turno significano due
 * bolle non appena la storia si ricarica.
 */
export const CLIENT_MESSAGE_ID_PREFIX = 'msg_';

export function isClientGeneratedMessageId(id: string | undefined): boolean {
  return !!id && id.startsWith(CLIENT_MESSAGE_ID_PREFIX);
}

/**
 * Un `message:new` che arriva mentre un turno è in volo: È la sua fine, o è
 * un'altra riga?
 *
 * IL DIFETTO CHE CHIUDE. La risposta si dava per POSIZIONE: «l'ultimo messaggio
 * è un assistant parziale, quindi questa riga persistita è lui». Ma a turno
 * aperto il server scrive e trasmette anche righe che con quel turno non
 * c'entrano — l'uscita di un sotto-agente, che `server/lib/subagent-watch.ts`
 * consegna come un `message:new` qualunque. Quella riga si prendeva id, testo e
 * bandiera della bolla viva; il turno continuava a scrivere DENTRO il rapporto
 * del sotto-agente, e il resto della risposta usciva incollato sotto di lui.
 *
 * La risposta giusta è per IDENTITÀ: `stream:start` annuncia l'id della riga che
 * il turno sta scrivendo, il segnaposto lo porta, e la riga che chiude il turno
 * ha quello stesso id. Tutto il resto si accoda.
 *
 * `streamingMessageId` è la seconda rete, indipendente dalla prima: copre il
 * segnaposto rimasto senza nome (un server che non annuncia `messageId`), dove
 * l'unica cosa che sappiamo è che l'id in volo NON è quello che sta arrivando.
 */
export function shouldAdoptIntoPlaceholder(args: {
  incomingId: string | undefined;
  incomingRole: ChatMessage['role'];
  last: ChatMessage | undefined;
  streamingMessageId: string | undefined;
}): boolean {
  const { incomingId, incomingRole, last, streamingMessageId } = args;
  // Senza id è una aggiunta sintetica (i marcatori `agents:spawned`): non deve
  // poter toccare un segnaposto in volo.
  if (!incomingId) return false;
  if (incomingRole !== 'assistant') return false;
  if (last?.role !== 'assistant' || !last.partial) return false;
  if (!isClientGeneratedMessageId(last.id)) return incomingId === last.id;
  if (streamingMessageId && streamingMessageId !== incomingId) return false;
  return true;
}

export interface CatchupPayload {
  messageId?: string;
  content?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  blocks?: ContentBlock[];
}

/**
 * Compute the next assistant message for a session given the incoming
 * catchup payload and the current last message (may be undefined).
 *
 * Returns the new/updated assistant message that should replace or be
 * appended to the session's message list. The caller is responsible for
 * splicing it into state.
 */
export function mergeCatchupIntoPartial(
  payload: CatchupPayload,
  lastMessage: ChatMessage | undefined,
  generateId: () => string,
  nowIso: string,
): ChatMessage {
  if (lastMessage?.role === 'assistant' && lastMessage.partial) {
    // Merging INTO the local partial: prefer server-truth tool/block lists when
    // the catchup carries them; otherwise keep the partial's own so a tool_call
    // event that arrived between WS open and catchup delivery isn't lost.
    return {
      ...lastMessage,
      // L'id durevole si ADOTTA, ma solo sopra un segnaposto coniato qui. Un id
      // che viene dal DB non si tocca mai (ci sono già dei marker ancorati, e il
      // server non cambia idea sul nome di una riga a metà turno); un `msg_…`
      // invece è provvisorio per costruzione, e tenerlo vuol dire che il
      // prossimo `loadHistory` non riconoscerà la bolla che ha davanti.
      ...(payload.messageId && isClientGeneratedMessageId(lastMessage.id)
        ? { id: payload.messageId }
        : {}),
      content: payload.content || lastMessage.content || '',
      thinking: payload.thinking || lastMessage.thinking,
      toolCalls: payload.toolCalls ?? lastMessage.toolCalls,
      blocks: payload.blocks ?? lastMessage.blocks,
    };
  }

  // Creating a NEW assistant message: do NOT fall back to lastMessage's
  // tool/block lists. Here lastMessage is a *different*, already-finalized
  // message (e.g. the previous turn), so inheriting its toolCalls would render
  // that turn's stale tool-call card on this fresh bubble.
  return {
    id: payload.messageId || generateId(),
    role: 'assistant',
    content: payload.content || '',
    thinking: payload.thinking || undefined,
    toolCalls: payload.toolCalls,
    blocks: payload.blocks,
    timestamp: nowIso,
    partial: true,
  };
}
