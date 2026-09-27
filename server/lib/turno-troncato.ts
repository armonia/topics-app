/**
 * IL TURNO CHIUSO IN SILENZIO — chi lo chiude deve anche dire perché.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * «penso abbiano interrotto involontariamente» (20/08, su due chat che
 * sembravano a posto e non lo erano).
 *
 * Quando il server riparte, il setaccio del riattacco trova le sessioni il cui
 * figlio non ha più un turno aperto e spegne `partial` con una `UPDATE`. Per un
 * turno finito bene è giusto: non c'è niente da spiegare. Ma da lì passa anche
 * chi è MORTO col riavvio — e la sua riga si chiudeva a metà frase, senza
 * cartello, identica a una risposta arrivata in fondo.
 *
 * Nel log c'era (`reaping idle broker session`), in chat no. È il gemello del
 * difetto già corretto in `finalizeStream`: lì il turno moriva mentre il server
 * ascoltava, qui muore mentre il server non c'è più.
 *
 * ── La regola ───────────────────────────────────────────────────────────────
 * Merita il cartello SOLO chi mostra i segni di essere stato tagliato:
 *
 *   · l'ultima riga è dell'assistente (se ha già parlato l'utente, la
 *     conversazione è andata avanti e un cartello sarebbe rumore);
 *   · non ne ha già uno (chi ha spiegato, ha spiegato meglio di noi);
 *   · e il turno è finito su un TOOL — cioè stava lavorando quando è stato
 *     chiuso. Un turno che finisce con la prosa dell'agente ha detto la sua:
 *     quello è il modo normale di finire, e spiegarlo sarebbe una bugia.
 *
 * L'ultimo punto è quello che tiene: senza, ogni chat sana si sarebbe presa un
 * «turno interrotto» a ogni riavvio del server.
 */
import type { ContentBlock } from "../types";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { decodeCol, encodeCol } from "../../shared/message-blob";
import { threadChangedFrame } from "./boot-partial-sweep";

/** Il testo del cartello. Uno solo, così non divergono fra i due cammini. */
export const TURNO_TRONCATO =
  "Turno interrotto: il server si è riavviato mentre la risposta era in corso, " +
  "e quello che stava facendo non è arrivato in fondo.";

/** Quel poco di `Database` che serve. Vedi la stessa scelta in `ripresa-boot.ts`. */
interface DbLike {
  // `any` non per pigrizia: `bun:sqlite` tipizza `prepare` e `query` con
  // generici che obbligano il chiamante a dichiarare la forma della riga, e
  // riscriverli qui vorrebbe dire copiare il driver dentro questo modulo. La
  // stessa scelta, con la stessa motivazione, sta in `verdetto-turno-interrotto.ts`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- il driver tipizza con generici che legherebbero questo modulo alla sua superficie
  prepare(sql: string): any; // allow-any: stessa ragione, il driver tipizza con generici che legherebbero questo modulo alla sua superficie
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stessa ragione di `prepare` qui sopra: la forma della riga la dicono i chiamanti
  query(sql: string): any; // allow-any: come `prepare` qui sopra, la forma della riga la dicono i chiamanti
}

/**
 * Decide se questa riga è un turno troncato, guardando solo i suoi blocchi.
 *
 * Separata dal database perché è LA REGOLA: un test la interroga con tre
 * blocchi in mano, senza tabelle.
 */
export function èTroncato(ruolo: string, blocks: ContentBlock[] | null | undefined): boolean {
  if (ruolo !== "assistant") return false;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  // Ha già una spiegazione: la sua vince.
  if (blocks.some((b) => b?.kind === "error")) return false;
  // Ha chiuso parlando: è il modo normale di finire.
  const ultimo = blocks[blocks.length - 1];
  return ultimo?.kind === "tool";
}

/**
 * Mette il cartello sull'ultima riga della sessione, se le serve.
 *
 * Restituisce `true` se ha scritto. Ripetibile: alla seconda passata la riga ha
 * un blocco `error` e la regola dice di no.
 */
export function spiegaTurnoTroncato(db: DbLike, sessionKey: string): boolean {
  try {
    const r = db.query(
      `SELECT id, role, blocks FROM messages WHERE session_key = ?
        ORDER BY sort_order DESC, rowid DESC LIMIT 1`,
    ).get(sessionKey) as { id: string; role: string; blocks: unknown } | undefined;
    if (!r) return false;
    const raw = decodeCol(r.blocks);
    if (!raw) return false;
    let blocks: ContentBlock[];
    try { blocks = JSON.parse(raw) as ContentBlock[]; } catch { return false; }
    if (!èTroncato(r.role, blocks)) return false;
    blocks.push({ kind: "error", text: TURNO_TRONCATO });
    db.prepare(`UPDATE messages SET blocks = ? WHERE id = ?`)
      .run(encodeCol(JSON.stringify(blocks)) ?? null, r.id);
    console.log(`[turno-troncato] ${sessionKey}: chiuso dal riavvio, cartello aggiunto`);
    return true;
  } catch (err) {
    // Un cartello che non si riesce a scrivere non deve portarsi via il boot.
    console.warn(`[turno-troncato] ${sessionKey}: non riesco a spiegare la chiusura:`, err);
    return false;
  }
}

/**
 * THE END OF A BOOT REATTACH LEG (`reattachSurvivingChatTurns`, server.ts).
 * Returns how many rows it closed. Never throws: it runs in the `.finally` of a
 * promise nobody awaits.
 *
 * The leg is over, the TURN may not be: a child stopped on
 * `ask_user_question` stays open for hours, and the muted replay that reattaches
 * it lasts a moment. So the broker is asked again.
 *
 * - `open`: the row belongs to a live turn, and its `partial` is switched back
 *   ON, not merely left alone. The leg's finalize already wrote it off
 *   (`updateMessage` sets `partial` with no COALESCE), and the next reattach
 *   reuses only an assistant row with `partial = 1`: without this each restart
 *   opened a NEW row, nine where there should be one on topic:9fe7a291
 *   (2026-08-18), five copies of one message on topic:ed2070df. Nothing is
 *   sent: the windows are watching that turn.
 * - anything else (`idle`, no answer): the turn is over. The rows it left open
 *   are closed, and a turn that died working gets its notice
 *   (`spiegaTurnoTroncato`): closing it in silence left it cut mid-sentence and
 *   identical to an answer that finished, the two chats of 20/08. A closed row
 *   is announced (`threadChangedFrame`): before, the open windows kept the
 *   bubble open and unexplained until a reload (card edf3c4db). Nothing closed,
 *   nothing sent.
 */
export async function settleReattachLeg(
  /** The server's context: the frame goes through `broadcastToAll`, which filters guests. */
  ctx: {
    db: DbLike;
    getTopicBySessionKey(sessionKey: string): { id: string } | null | undefined;
    broadcastToAll(msg: OutboundMessage): void;
  },
  sessionKey: string,
  /** The broker's word on the session's turn (the claude-code provider's `brokerTurnState`). */
  brokerTurnState: (sessionKey: string) => Promise<"open" | "idle" | "unknown"> | undefined,
): Promise<number> {
  try {
    const state = await brokerTurnState(sessionKey)?.catch(() => "unknown" as const);
    if (state === "open") {
      try {
        ctx.db.prepare(
          "UPDATE messages SET partial = 1 WHERE id = (SELECT id FROM messages WHERE session_key = ? AND role = 'assistant' ORDER BY sort_order DESC LIMIT 1)",
        ).run(sessionKey);
      } catch { /* at worst the next reattach opens a new row, as before */ }
      console.log(`[chat-reattach] ${sessionKey}: la gamba è finita ma il turno è ancora aperto (domanda a schermo) — la riga resta viva`);
      return 0;
    }
  } catch { /* no answer from the broker: the rows are closed, as before */ }
  try {
    const closed = ctx.db.prepare("UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1")
      .run(sessionKey).changes as number;
    if (closed > 0) {
      spiegaTurnoTroncato(ctx.db, sessionKey);
      const topic = ctx.getTopicBySessionKey(sessionKey);
      if (topic) ctx.broadcastToAll(threadChangedFrame(topic, sessionKey));
    }
    return closed;
  } catch {
    return 0; // the next boot's reset catches it
  }
}
