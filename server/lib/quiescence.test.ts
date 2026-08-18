/**
 * Il cancello di `restart-when-idle` guardava solo le CARD della board.
 *
 * Le tre prove che contano sono le tre fonti prese una alla volta: la seconda e
 * la terza sono quelle che prima non esistevano, e sono rosse contro
 * l'implementazione vecchia (`while (busyCount() > 0)`) per costruzione — con
 * `cards: 0` quel predicato usciva subito, cioè `null`, cioè «riavvia pure».
 */
import { test, expect, describe } from "bun:test";
import { describeInFlight } from "./quiescence";

const nothing = { cards: 0, streamKeys: [], brokerOpenKeys: [] };

describe("describeInFlight — che cosa trattiene un riavvio pianificato", () => {
  test("niente in volo ⇒ null, ed è l'unica risposta che autorizza il riavvio", () => {
    expect(describeInFlight(nothing)).toBeNull();
  });

  test("una card della board trattiene", () => {
    const out = describeInFlight({ ...nothing, cards: 3 });
    expect(out).toContain("3");
    expect(out).toContain("card");
  });

  /**
   * IL BUCO STORICO #1: una chat umana non è una card. `activeStreams` è
   * popolata da `startStream` per OGNI turno, dispacciato o no, ma il cancello
   * non la guardava. Con la logica vecchia questo caso valeva «idle».
   */
  test("una chat che sta streammando in questo processo trattiene", () => {
    const out = describeInFlight({ ...nothing, streamKeys: ["topic:9fe7a291"] });
    expect(out).not.toBeNull();
    expect(out).toContain("topic:9fe7a291");
    expect(out).toContain("streaming");
  });

  /**
   * IL BUCO STORICO #2, ed è il più insidioso: dopo un riavvio il turno vivo NON
   * ha nessuna rappresentazione in questo processo. La gamba di riadozione si
   * chiude in un attimo e `endStream` toglie la voce da `activeStreams`; da lì
   * in poi card e stream dicono «fermo» ed è vero — il figlio CLI però sta
   * ancora lavorando, e solo il broker lo sa.
   */
  test("un turno adottato, visibile SOLO al broker, trattiene", () => {
    const out = describeInFlight({ ...nothing, brokerOpenKeys: ["topic:9fe7a291"] });
    expect(out).not.toBeNull();
    expect(out).toContain("topic:9fe7a291");
    expect(out).toContain("broker");
  });

  test("più fonti insieme: si nomina la più economica e più certa", () => {
    const out = describeInFlight({ cards: 2, streamKeys: ["topic:aaa"], brokerOpenKeys: ["topic:bbb"] });
    // La frase finisce in un log letto da chi si chiede perché il suo
    // salvataggio non è ancora in produzione: una fonte sola, la prima.
    expect(out).toContain("card");
    expect(out).not.toContain("topic:aaa");
    expect(out).not.toContain("topic:bbb");
  });

  test("liste vuote non sono «qualcosa in volo»", () => {
    expect(describeInFlight({ cards: 0, streamKeys: [], brokerOpenKeys: [] })).toBeNull();
  });
});
