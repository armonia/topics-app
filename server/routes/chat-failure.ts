import { type CrashedTurnRow, sendFailureNotice, shortErrorDetail } from "./crashedTurnNotice";
import { decodeCol } from "../../shared/message-blob";
import { restoreBlocksJson } from "../lib/tool-output-store";
import type { ContentBlock } from "../types";
import { stopTurnBodyOf } from "../lib/turn-body-flush";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Closes the row of a failed turn with the reason. */
export function createFailureHandlers(turn: ChatTurnScope): void {
  const { boardAgentTurn, broadcastToAll, db, endStream, endTurnAttention, finalizeTurnActivity, matchedTopic, sessionKey, updateLastMessage } = turn;
  /**
   * La riga com'è ADESSO, per decidere se un cartello d'errore può scriverci
   * sopra. Le tre colonne servono tutte: `content` da solo direbbe «vuota»
   * su una riga che a schermo è un turno intero, perché la prosa è
   * persistita anche in `blocks` ed è da lì che il client la rende.
   */
  const readRowForNotice = (rowId: string | null): CrashedTurnRow | null => {
    if (!rowId) return null;
    try {
      const r = db.prepare("SELECT content, tool_calls, blocks FROM messages WHERE id = ?")
        .get(rowId) as { content?: string; tool_calls?: string | null; blocks?: string | null } | undefined;
      // Whole: this timeline is written back and broadcast, so a tool
      // output stored out of the row comes back into it first.
      return r ? { content: r.content ?? "", toolCallsJson: decodeCol(r.tool_calls), blocksJson: restoreBlocksJson(db, rowId, decodeCol(r.blocks)) } : null;
    } catch { return null; }
  };
  turn.readRowForNotice = readRowForNotice;
  /**
   * I blocchi della riga con in fondo il verdetto. `undefined` se non c'è
   * niente da scrivere (riga illeggibile e nessun blocco): passare un array
   * vuoto a `updateLastMessage` cancellerebbe la colonna.
   */
  const appendErrorBlock = (row: CrashedTurnRow | null, text: string): ContentBlock[] | undefined => {
    if (!row?.blocksJson) return [{ kind: "error", text }];
    try {
      const parsed = JSON.parse(decodeCol(row.blocksJson) ?? "null");
      if (Array.isArray(parsed)) return [...(parsed as ContentBlock[]), { kind: "error", text }];
    } catch { /* vedi sotto */ }
    // Colonna illeggibile: NON si riscrive. Rimpiazzarla col solo verdetto
    // butterebbe via un turno intero per non saperlo leggere — è la stessa
    // prudenza di `rowCarriesWork`. Il `undefined` fa scattare il COALESCE
    // in `updateMessage`, che lascia la colonna dov'è.
    return undefined;
  };
  /**
   * Chiude il turno quando non si è potuto GUIDARE: `sendChat` ha rigettato,
   * o il montaggio è morto prima di partire.
   *
   * Le due vie che finiscono qui scrivevano `content: errorMsg` senza
   * guardare la riga. Il commento che le accompagnava — «il turno non è mai
   * arrivato alla CLI» — descriveva l'unico caso per cui erano state
   * scritte, ma non è l'unico che ci arriva: `sendChat` resta pendente per
   * TUTTO il turno, quindi un rigetto tardivo cadeva nello stesso ramo e
   * cancellava lavoro vero.
   *
   * Ora il cartello si scrive solo su una riga che non porta niente. Se
   * porta qualcosa, quel qualcosa resta e l'errore viaggia comunque sul filo
   * e nel log: non si perde, e non si mangia il turno.
   *
   * Torna il testo da mandare sull'SSE — sempre, anche quando la riga non è
   * stata toccata: quello è il canale che chiude il client, e lasciarlo muto
   * lo terrebbe appeso.
   */
  const closeTurnWithFailure = (err: unknown, rowId: string): string => {
    stopTurnBodyOf(rowId);
    endStream(sessionKey, { rowId });
    const row = readRowForNotice(rowId);
    const notice = sendFailureNotice(row, err);
    const verdict = `Non sono riuscito ad avviare il turno: ${shortErrorDetail(err)}`;
    // `updateLastMessage` scrive sull'ULTIMA riga della sessione, mentre qui
    // la riga si legge per ID. Di norma sono la stessa — il cancello a 409
    // impedisce un secondo turno mentre uno è in volo — ma "di norma" non è
    // "sempre": se nel frattempo ne fosse nata una più recente, scriverci
    // sopra il nostro esito metterebbe i blocchi del NOSTRO turno dentro
    // quello di un altro. Meglio saperlo che scoprirlo da una riga sbagliata.
    const ultima = (() => {
      try {
        return (db.prepare("SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1")
          .get(sessionKey) as { id?: string } | undefined)?.id;
      } catch { return undefined; }
    })();
    if (ultima === rowId) {
      // Il verdetto va nei blocchi in OGNI caso — anche, e soprattutto,
      // quando la riga porta già lavoro e il cartello non può toccare
      // `content`. È lì che sta la differenza fra «un turno giallo senza
      // spiegazione» e un errore che si legge.
      const withVerdict = appendErrorBlock(row, verdict);
      if (notice) {
        updateLastMessage(sessionKey, { content: notice, blocks: withVerdict, partial: undefined, streamedAt: undefined, endReason: "error" });
      } else {
        // La riga si tiene il suo contenuto; cade solo il flag che la
        // dichiara ancora in volo, o il setaccio di boot la crederebbe viva.
        updateLastMessage(sessionKey, { blocks: withVerdict, partial: undefined, streamedAt: undefined, endReason: "error" });
        console.warn(`[StreamWS] ${sessionKey}: turno fallito su una riga che porta già lavoro — contenuto preservato, errore aggiunto come blocco`);
      }
    } else {
      // Non è più l'ultima: si chiude solo la NOSTRA, per id, e non si tocca
      // il turno che è subentrato.
      try { db.run("UPDATE messages SET partial = 0, end_reason = 'error' WHERE id = ?", [rowId]); } catch { /* best effort */ }
      console.warn(`[StreamWS] ${sessionKey}: la riga ${rowId} non è più l'ultima (${ultima ?? "nessuna"}) — chiusa per id, esito non riscritto`);
    }
    const wire = notice ?? `⚠️ ${verdict}`;
    if (matchedTopic) {
      broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: wire });
      broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: rowId });
      endTurnAttention(matchedTopic, { messageId: rowId, reason: "error", error: wire, dispatched: boardAgentTurn });
      finalizeTurnActivity(matchedTopic);
    }
    return wire;
  };
  turn.closeTurnWithFailure = closeTurnWithFailure;
}
