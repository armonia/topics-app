/**
 * `getLastAgentText`: the agent's own words, not the sign announcing its death.
 *
 * WHAT IT IS FOR. When a turn ends before the agent can call `comment_task`,
 * the dispatcher mirrors its last prose into the card thread: whoever reviews
 * reads "here is what I did" instead of being met by a system note. It is the
 * safety net that stops a card that was actually worked on from arriving mute.
 *
 * THE FLAW. It took the last assistant message WHATEVER IT WAS. But when a turn
 * dies, the most recent message is precisely the sign announcing that death
 * ("Turn interrupted by a server restart..."), so the net mirrored the failure
 * notice onto the card in place of the work.
 *
 * Measured on card `235afe11` (20/08): underneath that sign were the agent's
 * real words, two lines further down. The card reached review mute with the
 * good text sitting right below, and the flaw REACHED THE SCREEN: it is the
 * card that showed "Fan-out closed: 3 attempts" instead of a summary.
 *
 * The two messages below are the real ones from `topic:85561235`.
 *
 * @covers KANBAN-05
 * @covers KANBAN-72
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { TURN_ERROR_PREFIX } from "../../shared/board";

/**
 * The rule of `getLastAgentText` (server.ts), on its own.
 *
 * Copied and not imported because over there it is a closure inside the
 * dispatcher's dependency object, which is built with half a server attached.
 * The rule is three lines long: what matters is that the real case is covered,
 * and this file names it so that anybody changing the closure finds the test by
 * searching for the phrase.
 */
function ultimaProsaDellAgente(
  msgs: ReadonlyArray<{ id?: string; role: string; content: unknown }>,
): { text: string; id: string } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    const testo = m.content.trim();
    if (!testo) continue;
    if (testo.startsWith(TURN_ERROR_PREFIX)) continue;
    return { text: m.content, id: m.id ?? "" };
  }
  return null;
}

/** The words alone, for the cases that only care about which row was picked. */
const wordsOnly = (msgs: ReadonlyArray<{ id?: string; role: string; content: unknown }>) =>
  ultimaProsaDellAgente(msgs)?.text ?? null;

const CARTELLO = TURN_ERROR_PREFIX + " Turno interrotto da un riavvio del server. Il messaggio che hai inviato e' ancora qui: premi Riprova per inviarlo di nuovo.";
const PROSA = "I'll start by framing the work: reading the task and exploring the tab/browser code.";

describe("l'ultima prosa dell'agente", () => {
  /** THE 235afe11 CASE, with the real messages in the real order. */
  test("salta il cartello e trova le parole sotto", () => {
    const out = wordsOnly([
      { role: "user", content: "vai" },
      { role: "assistant", content: PROSA },
      { role: "assistant", content: CARTELLO },
    ]);
    expect(out).toBe(PROSA);
  });

  test("più cartelli di fila non fermano la discesa", () => {
    const out = wordsOnly([
      { role: "assistant", content: PROSA },
      { role: "assistant", content: "⚠️ Turno interrotto prima di una risposta finale." },
      { role: "assistant", content: CARTELLO },
    ]);
    expect(out).toBe(PROSA);
  });

  /**
   * If there is NOTHING underneath, null beats the sign: on `null` the
   * dispatcher writes its own system note, which is honest. Mirroring the sign
   * as "the agent's words" would be a false attribution.
   */
  test("solo cartelli: nessuna parola da rispecchiare", () => {
    expect(wordsOnly([{ role: "assistant", content: CARTELLO }])).toBeNull();
  });

  test("un turno sano non è toccato", () => {
    const out = wordsOnly([
      { role: "assistant", content: PROSA },
      { role: "assistant", content: "Fatto: tre file, typecheck verde." },
    ]);
    expect(out).toBe("Fatto: tre file, typecheck verde.");
  });

  /**
   * THE ID COMES BACK WITH THE WORDS, and it is the id of the row the words are
   * on: the note that mirrors them is anchored to it, so a reader draws them
   * under the step that said them. Picking the last row's id instead would
   * anchor the quote to the sign announcing the death.
   */
  test("torna l'id della riga giusta, non quello dell'ultima", () => {
    const out = ultimaProsaDellAgente([
      { id: "m1", role: "assistant", content: PROSA },
      { id: "m2", role: "assistant", content: CARTELLO },
    ]);
    expect(out).toEqual({ text: PROSA, id: "m1" });
  });

  /** A warning sign in the MIDDLE of the prose is not a sign: only the start counts. */
  test("un ⚠️ dentro il testo non lo squalifica", () => {
    const con = "Fatto, ma ⚠️ attenzione al caso limite.";
    expect(wordsOnly([{ role: "assistant", content: con }])).toBe(con);
  });
});

/**
 * THE DOUBT THAT WAS RAISED, and the measurement that settles it.
 *
 * The objection received: "the authoritative verdict is the `error` BLOCK, the
 * prefix is legacy; a turn interrupted TODAY writes the block and leaves
 * `content` empty, so the guard on the prefix never fires and the flaw survives
 * for every future turn".
 *
 * That would be serious if it were true, and it has to be checked against the
 * database rather than reasoned about: `routes/chat.ts` has TWO branches that
 * assign `fullContent`, and both of them write the prefix when the row would
 * otherwise be empty, for a reason stated right there (it is the only column
 * search queries, and old clients read from it).
 *
 * Measured on 20/08 against the live DB, assistant rows since 18/08:
 *   · with an `error` block and EMPTY `content`  ->  0
 *   · with the prefix in `content`               ->  573
 * And over the turns after tonight's fix alone: 6 out of 6 carried text, zero
 * empty.
 *
 * So the guard on the prefix covers the new turns as well. This test keeps the
 * measurement alive: if one day somebody stopped writing `content`, an
 * uncovered case would show up here and be visible at once.
 */
describe("la forma dei cartelli, misurata sul database", () => {
  test("nessun turno interrotto lascia `content` vuoto col solo blocco", () => {
    let db: Database;
    try { db = new Database("data/topics.db", { readonly: true }); }
    catch { return; } // no DB (clean CI): the test has nothing to measure
    const r = db.query(`
      SELECT
        SUM(CASE WHEN TRIM(COALESCE(content,'')) = '' AND blocks LIKE '%"kind":"error"%' THEN 1 ELSE 0 END) AS vuoti,
        SUM(CASE WHEN content LIKE ? THEN 1 ELSE 0 END) AS con_prefisso,
        COUNT(*) AS turni
      FROM messages WHERE role = 'assistant' AND timestamp > '2026-08-18'
    `).get(TURN_ERROR_PREFIX + "%") as { vuoti: number | null; con_prefisso: number | null; turni: number };
    db.close();
    // The same condition as the `catch` above, one step further on: a DB that
    // EXISTS but does not hold a single agent turn yet is not a healthy DB, it
    // is an empty one. It happens in every isolated worktree, where the file is
    // born when the server starts. Measuring zero rows says nothing about the
    // shape of the signs.
    if (r.turni === 0) return;
    // If this ever became > 0, the guard on the prefix would no longer be
    // enough and the block would have to be read instead, at the cost of
    // loading ~20 KB per message.
    expect(r.vuoti ?? 0).toBe(0);
    expect(r.con_prefisso ?? 0).toBeGreaterThan(0);
  });
});
