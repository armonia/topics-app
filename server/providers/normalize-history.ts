/**
 * L'API Anthropic non accetta una conversazione con due turni dello stesso
 * ruolo di fila, e pretende che il primo sia dell'utente: sbagliare vuol dire
 * 400 secco, tutto il turno perso.
 *
 * Il thread salvato quell'alternanza ce l'ha, ma la history che si manda al
 * provider è il thread MENO qualcosa: un turno vuoto, un envelope di contesto,
 * un segnaposto ancora `partial` (`empty-after-strip`, `context-message`,
 * `partial` in server/context/assemble.ts). Tolto un assistente in mezzo, i due
 * turni utente che lo circondavano diventano adiacenti — nel DB vivo di bolle
 * vuote in mezzo al thread se ne contavano 170.
 *
 * Qui si ricuce, all'ULTIMO passo prima della chiamata: chi costruisce la
 * history può cambiare (e sono due posti diversi), il vincolo del provider no.
 */

import type { ChatMessage } from "./types";

type Turn = { role: "user" | "assistant"; content: string };

/**
 * Rende la sequenza alternata senza perdere una parola:
 *  · turni consecutivi dello stesso ruolo si fondono in uno (separati da riga
 *    vuota) — sono comunque roba detta di fila dallo stesso interlocutore;
 *  · un assistente in testa se ne va: senza la domanda che lo ha prodotto non
 *    ha un turno a cui appartenere, e l'API lo rifiuterebbe comunque;
 *  · i turni vuoti spariscono (non aggiungono niente e romperebbero il conto).
 */
export function normalizeAlternating(messages: ChatMessage[]): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = typeof m.content === "string" ? m.content : String(m.content ?? "");
    if (!content.trim()) continue;
    if (out.length === 0 && role === "assistant") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content = `${prev.content}\n\n${content}`;
    else out.push({ role, content });
  }
  return out;
}
