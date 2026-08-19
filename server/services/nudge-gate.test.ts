/**
 * Il caso vero, riprodotto: quattro solleciti identici in novanta secondi.
 *
 * Su `topic:7d043b7e` la chat del task portava «Your previous turn on this task
 * was interrupted» alle 00:37:07, 00:38:01, 00:38:18 e 00:38:28. Quattro
 * paragrafi identici sopra la conversazione vera, per UNA sequenza di riprese.
 *
 * Il test che conta è il primo: la stessa sequenza, un paragrafo solo e tre
 * righe corte. Sotto ci sono le prove che il cancello sa anche NON scattare
 * (finestra scaduta, testo diverso) e che sa diventare rosso: azzerata la
 * finestra, i paragrafi tornano quattro.
 */
import { describe, expect, test } from "bun:test";
import {
  NO_NUDGE_CLAIM,
  NUDGE_CLAIM_MS,
  gateNudge,
  nudgeFingerprint,
  shortNudge,
  type NudgeClaim,
} from "./nudge-gate";

const TASK = "14a188b6";

/** Il sollecito vero, quello che si ripeteva. */
const NUDGE = [
  "Your previous turn on this task was interrupted. No fault of yours, the work done so far is valid.",
  `Resume where you were: get_task(task_id="${TASK}") to review your steps and the comments.`,
].join("\n");

/** L'ultimo turno: un sollecito DIVERSO, che impone la consegna. */
const LAST = `LAST TURN on \`${TASK}\`: do not start new work and do not keep investigating.`;

/** Le quattro riprese misurate, in millisecondi dalla prima. */
const RIPRESE = [0, 54_000, 71_000, 81_000];

/** Un banco con l'orologio in mano al test: la rivendicazione vive qui, come sul task. */
function banco(windowMs?: number) {
  let claim: NudgeClaim = NO_NUDGE_CLAIM;
  const t0 = Date.parse("2026-08-19T00:37:07.000Z");
  return {
    /** Solleciti come li manderebbe il dispatcher, e raccoglie cosa esce davvero. */
    sollecita(text: string, afterMs: number): string {
      const v = gateNudge({ text, claim, now: t0 + afterMs, taskId: TASK, ...(windowMs === undefined ? {} : { windowMs }) });
      claim = v.claim;
      return v.text;
    },
    get claim() { return claim; },
  };
}

describe("gateNudge: una interruzione, un sollecito", () => {
  test("le quattro riprese del 19/08 lasciano UN paragrafo e tre righe corte", () => {
    const b = banco();
    const usciti = RIPRESE.map((ms) => b.sollecita(NUDGE, ms));

    expect(usciti[0]).toBe(NUDGE);
    expect(usciti.filter((t) => t === NUDGE)).toHaveLength(1);
    // Le altre tre sono righe corte, numerate, e nessuna è uguale all'altra:
    // chi legge conta le riprese invece di rileggere lo stesso paragrafo.
    expect(usciti.slice(1)).toEqual([shortNudge(2, TASK), shortNudge(3, TASK), shortNudge(4, TASK)]);
    for (const t of usciti.slice(1)) expect(t.length).toBeLessThan(NUDGE.length);
  });

  test("azzerata la finestra tornano quattro paragrafi (il cancello sa diventare rosso)", () => {
    const b = banco(0);
    expect(RIPRESE.map((ms) => b.sollecita(NUDGE, ms))).toEqual([NUDGE, NUDGE, NUDGE, NUDGE]);
  });

  test("fuori dalla finestra il testo intero torna a passare", () => {
    const b = banco();
    expect(b.sollecita(NUDGE, 0)).toBe(NUDGE);
    expect(b.sollecita(NUDGE, NUDGE_CLAIM_MS - 1)).not.toBe(NUDGE);
    // Una interruzione nuova qualche minuto dopo merita di nuovo le istruzioni.
    expect(b.sollecita(NUDGE, NUDGE_CLAIM_MS + 1)).toBe(NUDGE);
  });

  test("la finestra è ancorata alla prima: riprese fitte non la tengono aperta per sempre", () => {
    const b = banco();
    b.sollecita(NUDGE, 0);
    for (let ms = 20_000; ms < NUDGE_CLAIM_MS; ms += 20_000) {
      expect(b.sollecita(NUDGE, ms)).not.toBe(NUDGE);
    }
    expect(b.sollecita(NUDGE, NUDGE_CLAIM_MS + 1_000)).toBe(NUDGE);
  });

  test("un sollecito DIVERSO entro la finestra passa intero", () => {
    const b = banco();
    b.sollecita(NUDGE, 0);
    // L'ultimo turno impone la consegna: zittirlo perché «ne è già passato uno»
    // costerebbe la consegna, non una riga di rumore.
    expect(b.sollecita(LAST, 10_000)).toBe(LAST);
    // E adesso è LUI il rivendicatore: il vecchio testo riparte intero.
    expect(b.claim.fingerprint).toBe(nudgeFingerprint(LAST));
  });

  test("un sollecito vuoto non rivendica niente", () => {
    const v = gateNudge({ text: "   ", claim: NO_NUDGE_CLAIM, now: Date.now() });
    expect(v.text).toBe("   ");
    expect(v.claim).toEqual(NO_NUDGE_CLAIM);
  });

  test("una rivendicazione illeggibile non zittisce nessuno", () => {
    // Riga sporca sul disco (o colonna mai scritta): il cancello si apre, non
    // si chiude. Un sollecito di troppo è rumore, uno mancato è un turno cieco.
    const rotta: NudgeClaim = { at: "mai", fingerprint: nudgeFingerprint(NUDGE), repeats: 3 };
    expect(gateNudge({ text: NUDGE, claim: rotta, now: Date.now() }).text).toBe(NUDGE);
    expect(gateNudge({ text: NUDGE, claim: null, now: Date.now() }).text).toBe(NUDGE);
  });

  test("l'impronta distingue i testi e ignora gli spazi", () => {
    expect(nudgeFingerprint(NUDGE)).toBe(nudgeFingerprint(`  ${NUDGE.replace(/\n/g, "\n  ")}  `));
    expect(nudgeFingerprint(NUDGE)).not.toBe(nudgeFingerprint(LAST));
  });
});
