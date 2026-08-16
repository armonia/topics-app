/**
 * OGNI CHIP DELLA CARD DEVE ESSERE NELL'ELENCO CHE MONTA LA SUA RIGA.
 *
 * `Card.tsx` disegna i chip dentro `{hasMetaRow && (...)}`, e `hasMetaRow` è un
 * OR scritto a mano dei chip possibili. Chi ne aggiunge uno e non lo scrive lì
 * ottiene un chip che non si monta mai — con il dato giusto nel DB, giusto
 * nella rotta, giusto in mano al client.
 *
 * Non è teorico: è successo il 16/08 con `card-delivery-stat` ed è costato tre
 * giri di debug. Ogni misura diceva che tutto funzionava (il DB aveva 7, il
 * feed HTTP aveva 7, `page.evaluate` nel browser aveva 7, la condizione
 * compilata nel bundle era corretta) mentre a schermo non c'era niente, perché
 * il contenitore non esisteva.
 *
 * Il test legge il SORGENTE: è l'unico posto in cui la domanda «esistono chip
 * fuori dall'elenco?» ha una risposta, dato che un chip mancante non produce
 * DOM da interrogare.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SORGENTE = readFileSync(
  resolve(import.meta.dir, "../../client/src/components/Board/Card.tsx"), "utf8",
);

/** La riga che decide se la fascia dei chip si monta. */
function condizioneRiga(): string {
  const riga = SORGENTE.split("\n").find((l) => l.includes("const hasMetaRow ="));
  if (!riga) throw new Error("hasMetaRow non trovato: il contenitore dei chip è cambiato nome");
  return riga;
}

/** I `data-testid` dei chip disegnati DENTRO la fascia. */
function chipDentroLaFascia(): string[] {
  const inizio = SORGENTE.indexOf("{hasMetaRow && (");
  expect(inizio, "la fascia dei chip deve esistere").toBeGreaterThan(0);
  // Fino alla fine del componente: i chip stanno tutti lì dentro, e prendere
  // qualche testid di troppo renderebbe il test più severo, non più debole.
  const corpo = SORGENTE.slice(inizio);
  return [...corpo.matchAll(/data-testid="(card-[a-z-]+)"/g)].map((m) => m[1]!);
}

describe("la fascia dei chip conosce tutti i suoi chip", () => {
  it("ogni chip condizionato compare nell'elenco di hasMetaRow", () => {
    const condizione = condizioneRiga();
    const trovati = chipDentroLaFascia();
    expect(trovati.length, "nessun chip trovato: il selettore è andato a vuoto").toBeGreaterThan(1);

    // La mappa da `data-testid` al nome della variabile che lo governa. Sta qui
    // e non è dedotta: dedurla dal sorgente vorrebbe dire riscrivere JSX, e un
    // parser approssimativo darebbe verdi falsi proprio nel caso che conta.
    const governatoDa: Record<string, string> = {
      "card-delivery-stat": "deliveryStat",
      "card-not-landed": "notLanded",
      "card-conductor-closes": "conductorCloses",
      "card-checks-green": "checksGreen",
      "card-checks-running": "checksRunning",
    };

    const mancanti = trovati
      .filter((t) => governatoDa[t])
      .filter((t) => !condizione.includes(governatoDa[t]!));

    expect(mancanti,
      `chip che non montano mai perché fuori da hasMetaRow: ${mancanti.join(", ")}`,
    ).toEqual([]);
  });

  it("il chip della consegna ha UN solo predicato, non due copie", () => {
    // Due copie della stessa condizione (una nella riga, una sul chip) sono il
    // modo esatto in cui la riga smette di montarsi mentre il chip crede di
    // esserci. Il predicato si dichiara una volta e si usa in entrambi i punti.
    const occorrenze = SORGENTE.split("deliveryFilesChanged != null").length - 1;
    expect(occorrenze,
      "la condizione del chip va dichiarata una volta sola (const deliveryStat)",
    ).toBe(1);
  });
});
