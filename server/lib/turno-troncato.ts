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
import { decodeCol, encodeCol } from "../../shared/message-blob";

/** Il testo del cartello. Uno solo, così non divergono fra i due cammini. */
export const TURNO_TRONCATO =
  "Turno interrotto: il server si è riavviato mentre la risposta era in corso, " +
  "e quello che stava facendo non è arrivato in fondo.";

/** Quel poco di `Database` che serve. Vedi la stessa scelta in `ripresa-boot.ts`. */
interface DbLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepare(sql: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string): any;
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
