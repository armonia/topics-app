/**
 * Chi altro c'è, della tua organizzazione.
 *
 * La regola che questi casi difendono: la riga risponde a «con chi sto
 * lavorando», non a «quante sessioni ci sono». È la differenza fra un numero
 * utile e un contatore, e si vede tutta nel primo caso — te stesso non conti.
 */
import { describe, it, expect } from "bun:test";
import { presentiOra, PRESENZA_MS } from "../../client/src/components/Sidebar/orgPresence";

const ADESSO = 1_700_000_000_000;
const fa = (ms: number) => ADESSO - ms;

describe("presenza dell'organizzazione", () => {
  it("TE STESSO non conti: sei la riga sopra", () => {
    // Sommarsi direbbe «1 online» a chi è da solo, ed è il modo più rapido di
    // rendere il numero una decorazione.
    const membri = [{ id: "io", lastSeenAt: fa(1000) }];
    expect(presentiOra(membri, "io", ADESSO)).toBe(0);
    // …e senza sapere chi sei, quello stesso membro conta.
    expect(presentiOra(membri, null, ADESSO)).toBe(1);
  });

  it("conta chi è stato visto dentro la soglia, non chi esiste", () => {
    const membri = [
      { id: "a", lastSeenAt: fa(60_000) },        // un minuto fa: c'è
      { id: "b", lastSeenAt: fa(PRESENZA_MS * 2) }, // dieci minuti fa: non c'è
      { id: "c", lastSeenAt: null },               // mai visto: non c'è
    ];
    expect(presentiOra(membri, "io", ADESSO)).toBe(1);
  });

  it("il bordo della soglia: dentro conta, fuori no", () => {
    expect(presentiOra([{ id: "a", lastSeenAt: fa(PRESENZA_MS - 1) }], null, ADESSO)).toBe(1);
    expect(presentiOra([{ id: "a", lastSeenAt: fa(PRESENZA_MS) }], null, ADESSO)).toBe(0);
  });

  it("un orologio avanti non nasconde chi c'è", () => {
    // Due macchine non concordano mai al millisecondo. Un `lastSeenAt` nel
    // futuro conta come presente: il verso opposto nasconderebbe qualcuno che
    // c'è davvero, ed è l'errore peggiore per una riga che esiste per dire
    // «non sei solo».
    expect(presentiOra([{ id: "a", lastSeenAt: ADESSO + 30_000 }], null, ADESSO)).toBe(1);
  });

  it("valori assurdi non diventano presenze", () => {
    // `NaN` da un JSON malformato non deve contare: `NaN < soglia` è false, ma
    // la guardia è esplicita perché è il tipo di cosa che cambia con un
    // refactor e nessuno se ne accorge.
    expect(presentiOra([{ id: "a", lastSeenAt: Number.NaN }], null, ADESSO)).toBe(0);
    expect(presentiOra([], null, ADESSO)).toBe(0);
  });

  it("la soglia si può cambiare da fuori: è del client, non del server", () => {
    // Il server manda i millisecondi grezzi apposta. Se dichiarasse lui
    // «online», due schermate con due soglie direbbero due verità sullo stesso
    // membro.
    const m = [{ id: "a", lastSeenAt: fa(30_000) }];
    expect(presentiOra(m, null, ADESSO, 10_000)).toBe(0);
    expect(presentiOra(m, null, ADESSO, 60_000)).toBe(1);
  });
});
