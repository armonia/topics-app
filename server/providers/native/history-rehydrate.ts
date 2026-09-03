/**
 * LA STORIA DEL RUNTIME NATIVO NON PUÒ VIVERE SOLO IN RAM.
 *
 * `NativeProvider` tiene le conversazioni in una `Map` di processo e dichiara
 * `contextStrategy = "inline-system"`, che alla rotta significa: «la storia me
 * la ricordo io, non mandarmela». Per una CLI residente è vero — il figlio
 * sopravvive al riavvio del server, sta nel broker. Per il runtime nativo NON è
 * vero: la Map muore col processo, e su questa macchina il processo si riavvia a
 * ogni salvataggio in `server/`.
 *
 * Il risultato misurato il 2026-08-18 su topic:9fe7a291: l'utente chiede «fammi
 * un report di fine giornata» in una conversazione con dentro un'analisi da
 * 2.396 caratteri, e si sente rispondere «Non ho trovato messaggi nel topic "New
 * Chat"». Non era un modello che sbaglia: era un modello a cui non era stato
 * dato niente. Stessa causa del saluto generico che compariva a ogni riadozione.
 *
 * Il pezzo che mancava non è il canale — `sendChat` accetta già
 * `options.history` e la fa vincere su quella in memoria — ma la FONTE: dopo un
 * riavvio nessuno gliela passa, perché la strategia dice che non serve. Qui la
 * sessione fresca si ricostruisce dal DB, che è l'unico posto dove la
 * conversazione è sopravvissuta.
 *
 * La funzione pura sta separata dal caricatore apposta: le regole di sotto sono
 * quattro decisioni vere, e vanno provate senza un database.
 */

import type { ToolCall } from "../../../shared/types";
import { toolCallResultText } from "../../../shared/lean-tool-call";
import type { AgentMessage, Block } from "./agent-loop";
import { clipToolResult, RESULT_HEAD_CHARS, RESULT_TAIL_CHARS } from "./compaction";

/** Una riga di conversazione come sta nel DB. */
export interface PersistedTurn {
  role: string;
  content: string;
  /** 1/true = turno tagliato a metà: non è una risposta, è un moncone. */
  partial?: number | boolean | null;
  /**
   * The tool calls of that row, as the route wrote them. Without them the
   * rebuilt history was PROSE ONLY: an agent resumed after a restart no
   * longer knew which files it had read or edited, and started over.
   */
  toolCalls?: ToolCall[] | null;
}

/** In the same shape the loop keeps in memory: prose or blocks. */
export type RehydratedTurn = AgentMessage;

/**
 * What a `tool_use` gets as its result when the row recorded none: the turn
 * was cut (restart, stop) before the call finished. Flagged as an error so the
 * model does not read silence as success.
 */
const NO_RESULT_RECORDED =
  "[no result recorded: the turn was interrupted before this call finished; run it again if its outcome matters]";

export type PersistedThreadLoader = (sessionKey: string) => PersistedTurn[];

let loadThread: PersistedThreadLoader | null = null;

/**
 * Il server inietta qui il suo `loadActiveThread`. Senza, la riparazione è un
 * no-op silenzioso: il provider è usabile anche fuori dal server (test,
 * strumenti), e in quel caso «non c'è storia» è la risposta giusta.
 */
export function configureNativeHistorySource(fn: PersistedThreadLoader | null): void {
  loadThread = fn;
}

/**
 * Da un thread persistito alla storia con cui far ripartire una sessione.
 *
 * Quattro regole, e ognuna è un modo in cui la trascrizione di Topics NON
 * coincide con quello che l'API accetta:
 *
 * 1. **Le righe vuote e i monconi si buttano.** Una riga `partial = 1` è un
 *    turno tagliato a metà (riavvio, stop, rete caduta); una riga senza testo è
 *    un segnaposto. Rimandarle non aggiunge contesto, e un `assistant` vuoto in
 *    mezzo confonde e basta.
 * 2. **Si comincia da `user`.** L'API rifiuta una conversazione che apre con
 *    l'assistente, e in Topics può succedere: un messaggio di sistema iniettato
 *    (`POST /api/topics/:id/system-message`) è una riga assistant senza domanda
 *    davanti.
 * 3. **L'ultima riga `user` si toglie, ed è ESATTAMENTE UNA.** È il messaggio
 *    del turno che sta per partire: la rotta lo scrive in DB *prima* di chiamare
 *    il provider, e `sendChat` lo rimette lui in fondo. Senza, il modello si
 *    vede la stessa domanda due volte e la seconda sembra un'insistenza.
 * 4. **I ruoli si alternano.** Due `assistant` di fila sono normali qui (una
 *    risposta più una nota di sistema) e non lo sono per l'API: si fondono in
 *    una riga sola, separate da una riga vuota.
 *
 * L'ORDINE FRA 3 E 4 È IL PUNTO, e l'ho sbagliato al primo giro. Fondendo prima
 * di togliere, due `user` consecutivi — che qui capitano davvero: una domanda
 * rimasta senza risposta perché il turno è morto, poi la domanda nuova —
 * diventano UNA riga, e toglierla butta via anche la domanda vecchia. Il thread
 * `[user "domanda", assistant tagliato, user "altra domanda"]` restituiva `[]`:
 * cioè, proprio nel caso in cui la storia era stata interrotta, la riparazione
 * non riparava niente. Prima si toglie una riga sola, poi si fonde.
 *
 * Una `user` può quindi restare in coda, ed è voluto: chi chiama la fonde con il
 * messaggio nuovo (vedi `sendChat`), così la domanda rimasta senza risposta
 * arriva al modello invece di sparire.
 *
 * 5. **Tool calls come back as pairs, not as prose.** An assistant row with
 *    `toolCalls` is, for the API, a SEQUENCE: `assistant [text before,
 *    tool_use...]` -> `user [tool_result...]` -> ... -> `assistant [closing
 *    text]`. The text splits on the `contentOffset`s, which say where the
 *    cursor was when each call started; calls with the same offset are the
 *    same round and stay together. The result is read with
 *    `toolCallResultText`, NEVER from `result` alone: `leanToolCall` drops it
 *    from disk when `detail` carries a copy. A call with no outcome (turn cut,
 *    permission never granted) gets a synthetic `tool_result` flagged as an
 *    error, right after its `tool_use`: the API demands the pair, and silence
 *    must not read as success.
 *
 *    A stump WITH calls is not thrown away: the cut text is, but the calls are
 *    accomplished facts (files read, commands run) and precisely what the
 *    resumed agent has to know. It is the measured case: "Tutto committato...
 *    Consegno", turn interrupted, a resume that did not know it had already
 *    delivered.
 */
export function historyFromPersistedThread(thread: readonly PersistedTurn[]): RehydratedTurn[] {
  // Rule 1 (+5): stumps and placeholders out; tool calls expand into pairs.
  const rows: RehydratedTurn[] = [];
  for (const row of thread) {
    const partial = row.partial === 1 || row.partial === true;
    const content = typeof row.content === "string" ? row.content : "";
    const calls = row.role === "assistant" && Array.isArray(row.toolCalls) ? row.toolCalls : [];
    if (calls.length > 0) {
      rows.push(...expandToolCalls(content, calls, partial));
      continue;
    }
    if (partial) continue;
    if (!content.trim()) continue;
    rows.push({ role: row.role === "assistant" ? "assistant" : "user", content });
  }
  // Regola 2: via tutto ciò che precede il primo `user`.
  const firstUser = rows.findIndex((m) => m.role === "user");
  if (firstUser < 0) return [];
  const fromUser = rows.slice(firstUser);
  // Rule 3: ONE row only, and only if it is the user's AND prose. A tail of
  // `tool_result` is not the question of the turn about to start: it is the
  // answer to the `tool_use` before it, and popping it would orphan them.
  const last = fromUser[fromUser.length - 1];
  if (last && last.role === "user" && typeof last.content === "string") fromUser.pop();
  // Regola 4: alternanza, fondendo i vicini di pari ruolo.
  const merged: RehydratedTurn[] = [];
  for (const m of fromUser) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content = joinContent(prev.content, m.content);
    else merged.push({ ...m });
  }
  return merged;
}

/**
 * Two neighbours of the same role become one message. Prose joins prose with
 * a blank line, as before; anything with blocks becomes blocks, so a
 * `tool_result` message followed by a plain user line keeps the results FIRST,
 * which is where the API wants them inside a user message.
 */
function joinContent(a: string | Block[], b: string | Block[]): string | Block[] {
  if (typeof a === "string" && typeof b === "string") return `${a}\n\n${b}`;
  return [...toBlocks(a), ...toBlocks(b)];
}

function toBlocks(c: string | Block[]): Block[] {
  if (typeof c !== "string") return c;
  return c.trim() ? [{ type: "text", text: c }] : [];
}

/** The persisted row of a turn with tool calls, back in the API's own shape. */
function expandToolCalls(content: string, calls: readonly ToolCall[], partial: boolean): RehydratedTurn[] {
  // Calls that started at the same cursor are one round: their `tool_use`
  // share an assistant message and their results share the user message
  // after it. A call with no offset joins the round before it.
  const rounds: Array<{ offset: number | null; calls: ToolCall[] }> = [];
  for (const tc of calls) {
    const offset = typeof tc.contentOffset === "number" ? tc.contentOffset : null;
    const current = rounds[rounds.length - 1];
    if (current && (offset === null || current.offset === offset)) current.calls.push(tc);
    else rounds.push({ offset, calls: [tc] });
  }
  const out: RehydratedTurn[] = [];
  let cursor = 0;
  for (const round of rounds) {
    const at = round.offset === null ? cursor : Math.min(Math.max(round.offset, cursor), content.length);
    const before = content.slice(cursor, at);
    cursor = at;
    const uses: Block[] = round.calls.map((tc) => ({
      type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {},
    }));
    out.push({ role: "assistant", content: [...toBlocks(before), ...uses] });
    out.push({ role: "user", content: round.calls.map(resultBlock) });
  }
  // The closing sentence: dropped on a cut turn, it is a stump, not an answer.
  const trailing = content.slice(cursor);
  if (!partial && trailing.trim()) out.push({ role: "assistant", content: trailing });
  return out;
}

function resultBlock(tc: ToolCall): Block {
  const text = toolCallResultText(tc);
  const error = typeof tc.error === "string" && tc.error.length > 0 ? tc.error : undefined;
  if (text === undefined && error === undefined) {
    return { type: "tool_result", tool_use_id: tc.id, content: NO_RESULT_RECORDED, is_error: true };
  }
  const isError = tc.status === "error" || text === undefined;
  return {
    type: "tool_result",
    tool_use_id: tc.id,
    // Capped like a live result: a 400k read stored on disk would rebuild the
    // very oversized tail the compaction has to defend against.
    content: clipToolResult(text ?? error!, RESULT_HEAD_CHARS, RESULT_TAIL_CHARS),
    ...(isError ? { is_error: true } : {}),
  };
}

/**
 * La storia con cui ripartire per questa sessione, o vuota se non c'è modo di
 * saperlo. Non lancia mai: una riparazione che fallisce deve costare un turno
 * senza memoria, non un turno che non parte.
 */
export function rehydrateHistory(sessionKey: string): RehydratedTurn[] {
  if (!loadThread) return [];
  try {
    return historyFromPersistedThread(loadThread(sessionKey));
  } catch {
    return [];
  }
}
