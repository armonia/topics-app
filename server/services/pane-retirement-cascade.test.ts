/**
 * La cascata: cosa deve succedere quando un tombstone arriva al server.
 *
 * I due errori che questo modulo puo' fare non costano uguale, e i test sono
 * pesati di conseguenza. Ritirare TROPPO POCO lascia una sessione viva senza
 * finestra: si vede al riconcilio successivo. Ritirare TROPPO archivia una chat
 * che l'utente stava usando, e quella e' una conversazione persa. Quindi la
 * meta' dei casi qui sotto e' «NON ritirare»: assenza senza tombstone, pane
 * ancora viva, riga gia' processata.
 *
 * @covers RETIRE-02
 */
import { describe, expect, test } from "bun:test";
import { computeCascade } from "./pane-retirement-cascade";

const NONE = new Set<string>();

/** Uno snapshot di `pane-store-v2` ridotto ai campi su cui si decide. */
const snap = (o: Partial<{ panes: any; tombstones: any; closedStack: any[] }>) => ({
  panes: {}, tombstones: {}, closedStack: [], ...o,
});

describe("cosa fa scattare il ritiro", () => {
  test("tombstone + pane sparita = tab chiusa", () => {
    const res = computeCascade({
      prev: snap({ panes: { p1: { id: "p1", topicId: "topic-a" } } }),
      next: snap({ tombstones: { p1: { at: 1700, seq: 9 } } }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([{ paneId: "p1", closedAt: 1700, topicId: "topic-a" }]);
  });

  test("il marcatore in forma legacy (numero nudo) vale come gli altri", () => {
    const res = computeCascade({
      prev: snap({ panes: { p1: { id: "p1", terminalSessionId: "s1" } } }),
      next: snap({ tombstones: { p1: 1234 } }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([{ paneId: "p1", closedAt: 1234, terminalSessionId: "s1" }]);
  });

  test("il contenuto si legge dal verbale di chiusura, terminale compreso", () => {
    // `closedStack` porta `terminal.sessionId`, che la pane nuda non ha.
    const res = computeCascade({
      prev: null,
      next: snap({
        tombstones: { p1: { at: 10, seq: 1 } },
        closedStack: [{ id: "p1", closedAt: 10, pane: { id: "p1" }, topicId: "t9", terminal: { sessionId: "sess-9" } }],
      }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([{ paneId: "p1", closedAt: 10, topicId: "t9", terminalSessionId: "sess-9" }]);
  });

  test("oltre le 50 voci il verbale non c'e' piu', ma lo snapshot precedente si', e il ritiro avviene lo stesso", () => {
    const res = computeCascade({
      prev: snap({ panes: { vecchia: { id: "vecchia", topicId: "t-old" } } }),
      next: snap({ tombstones: { vecchia: { at: 5, seq: 1 } }, closedStack: [{ id: "altra" }] }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([{ paneId: "vecchia", closedAt: 5, topicId: "t-old" }]);
  });

  test("una pane utility non contiene niente: si ritira lei e basta", () => {
    const res = computeCascade({
      prev: snap({ panes: { util: { id: "util" } } }),
      next: snap({ tombstones: { util: { at: 3, seq: 1 } } }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([{ paneId: "util", closedAt: 3 }]);
  });
});

describe("cosa NON lo fa scattare", () => {
  test("assenza senza tombstone non e' chiusura — l'idratazione e' un'unione", () => {
    // Il telefono manda uno snapshot che non ha mai saputo di `p1`.
    const res = computeCascade({
      prev: snap({ panes: { p1: { id: "p1", topicId: "t" } } }),
      next: snap({ panes: {} }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([]);
  });

  test("tombstone su una pane ancora viva: stato di transito, si aspetta il PUT dopo", () => {
    const res = computeCascade({
      prev: null,
      next: snap({ panes: { p1: { id: "p1", topicId: "t" } }, tombstones: { p1: { at: 9, seq: 1 } } }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([]);
  });

  test("gia' ritirata: il PUT ripetuto dello stesso snapshot non ri-uccide niente", () => {
    const next = snap({ tombstones: { p1: { at: 1, seq: 1 } } });
    const res = computeCascade({ prev: null, next, alreadyRetired: new Set(["p1"]) });
    expect(res.retire).toEqual([]);
    expect(res.reopen).toEqual([]);
  });

  test("un marcatore illeggibile non decide niente", () => {
    const res = computeCascade({
      prev: snap({ panes: { p1: { id: "p1", topicId: "t" } } }),
      next: snap({ tombstones: { p1: { seq: 3 } } }),
      alreadyRetired: NONE,
    });
    expect(res.retire).toEqual([]);
  });

  test("un valore che non e' uno snapshot non produce conseguenze", () => {
    expect(computeCascade({ prev: null, next: "dark", alreadyRetired: NONE })).toEqual({ retire: [], reopen: [] });
    expect(computeCascade({ prev: null, next: null, alreadyRetired: NONE })).toEqual({ retire: [], reopen: [] });
  });
});

describe("la ritrattazione", () => {
  test("pane viva e senza piu' marcatore = riaperta: il ritiro si ritratta", () => {
    const res = computeCascade({
      prev: null,
      next: snap({ panes: { p1: { id: "p1", topicId: "t" } } }),
      alreadyRetired: new Set(["p1"]),
    });
    expect(res.reopen).toEqual([{ paneId: "p1", topicId: "t" }]);
  });

  test("senza ritrattazione la chiusura SUCCESSIVA non avrebbe conseguenze", () => {
    // Riapertura, poi richiusura: la seconda deve tornare a essere un ritiro.
    const reopened = computeCascade({
      prev: null,
      next: snap({ panes: { p1: { id: "p1", topicId: "t" } } }),
      alreadyRetired: new Set(["p1"]),
    });
    expect(reopened.reopen).toEqual([{ paneId: "p1", topicId: "t" }]);

    const reclosed = computeCascade({
      prev: snap({ panes: { p1: { id: "p1", topicId: "t" } } }),
      next: snap({ tombstones: { p1: { at: 99, seq: 4 } } }),
      alreadyRetired: NONE, // la ritrattazione ha tolto la riga
    });
    expect(reclosed.retire).toEqual([{ paneId: "p1", closedAt: 99, topicId: "t" }]);
  });

  test("una pane ritirata e ancora assente resta ritirata", () => {
    const res = computeCascade({ prev: null, next: snap({}), alreadyRetired: new Set(["p1"]) });
    expect(res.reopen).toEqual([]);
  });

  test("viva ma ancora marcata non e' una riapertura", () => {
    const res = computeCascade({
      prev: null,
      next: snap({ panes: { p1: { id: "p1" } }, tombstones: { p1: { at: 1, seq: 1 } } }),
      alreadyRetired: new Set(["p1"]),
    });
    expect(res.reopen).toEqual([]);
  });
});
