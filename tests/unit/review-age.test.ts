/**
 * DA QUANTO UNA CARD ASPETTA UNA RISPOSTA.
 *
 * La colonna review chiedeva «Approva» senza dire da quanto quella richiesta
 * fosse lì. La data di aggiornamento in review era nascosta apposta, e faceva
 * bene: `updatedAt` si muove a ogni commento, a ogni etichetta, a ogni ri-audit
 * dell'atterraggio, quindi diceva «ora» su una card ferma da giorni. Il difetto
 * non era mostrarla male, era non avere il dato giusto.
 *
 * `review_at` è quell'istante, e questi casi difendono le due decisioni che lo
 * rendono utile invece che decorativo: il silenzio sotto l'ora, e i giorni
 * quando i giorni contano.
  * @covers REVAGE-01
 */
import { describe, it, expect } from "bun:test";
import { fmtAttesa } from "../../client/src/components/Board/format";

const ORA = Date.parse("2026-08-16T12:00:00.000Z");
const fa = (ms: number) => new Date(ORA - ms).toISOString();

const MIN = 60_000;
const H = 60 * MIN;
const G = 24 * H;

describe("l'attesa in review si legge dalla card", () => {
  it("sotto l'ora TACE: una richiesta appena arrivata non sta aspettando", () => {
    // Un chip su ogni card nuova sarebbe rumore, e il rumore su una colonna che
    // si legge di fretta si impara a saltare — poi il giorno che il numero
    // conta non lo guarda più nessuno.
    expect(fmtAttesa(fa(0), ORA)).toBeNull();
    expect(fmtAttesa(fa(30 * MIN), ORA)).toBeNull();
    expect(fmtAttesa(fa(59 * MIN), ORA)).toBeNull();
  });

  it("dall'ora in su parla, in ore", () => {
    expect(fmtAttesa(fa(H), ORA)).toBe("1h");
    expect(fmtAttesa(fa(5 * H), ORA)).toBe("5h");
    expect(fmtAttesa(fa(23 * H), ORA)).toBe("23h");
  });

  it("oltre il giorno conta i GIORNI, non le ore", () => {
    // È la ragione per cui questa funzione esiste invece di riusare
    // `fmtUpdatedAt`: quello scivola sull'orario assoluto («14:32»), che
    // risponde a «quando» e non a «da quanto». Una card ferma da tre giorni
    // deve dire tre giorni, non l'ora di martedì.
    expect(fmtAttesa(fa(G), ORA)).toBe("1g");
    expect(fmtAttesa(fa(3 * G), ORA)).toBe("3g");
    expect(fmtAttesa(fa(30 * G), ORA)).toBe("30g");
  });

  it("senza istante non inventa un'attesa", () => {
    // `null` = la card non è mai passata di qui dopo la migration. Un ripiego
    // su `updatedAt` sarebbe esattamente il numero sbagliato da cui si è
    // partiti, e per giunta scritto con la faccia sicura.
    expect(fmtAttesa(null, ORA)).toBeNull();
    expect(fmtAttesa("non-una-data", ORA)).toBeNull();
  });

  it("un istante nel FUTURO non diventa un'attesa negativa", () => {
    // Orologi che non concordano fra due macchine: meglio tacere che scrivere
    // «in attesa da -3h», che è il genere di stranezza che fa dubitare di tutta
    // la colonna.
    expect(fmtAttesa(new Date(ORA + 5 * H).toISOString(), ORA)).toBeNull();
  });
});
