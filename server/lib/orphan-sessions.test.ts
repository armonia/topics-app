/**
 * Il rischio di questo censimento è a senso unico: marcare orfana una sessione
 * VIVA la condanna, mentre risparmiarne una che orfana lo era davvero costa un
 * processo in più. I test insistono quindi sui casi che devono essere
 * RISPARMIATI — è lì che uno sbaglio fa danno.
 *
 * @covers EXTSESS-05
 */
import { describe, test, expect } from "bun:test";
import { scanOrphanSessions, referencedSessionIdsIn } from "./orphan-sessions";

const S = (n: string) => `0000000${n}-1111-4222-8333-444444444444`;

describe("scanOrphanSessions", () => {
  test("una sessione che nessuna struttura referenzia è orfana", () => {
    const r = scanOrphanSessions({ liveSessionIds: [S("1")], referencedIds: new Set() });
    expect(r.orphans).toEqual([S("1")]);
    expect(r.examined).toBe(1);
  });

  test("referenziata ⇒ risparmiata", () => {
    const r = scanOrphanSessions({ liveSessionIds: [S("1")], referencedIds: new Set([S("1")]) });
    expect(r.orphans).toEqual([]);
    expect(r.sparedReasons["referenziata da una struttura dell'interfaccia"]).toBe(1);
  });

  test("QUALCUNO ATTACCATO batte tutto, anche ui_state che non la conosce", () => {
    // È il caso in cui `ui_state` è indietro di una scrittura: la tab è aperta
    // davanti agli occhi di qualcuno e il registro non lo sa ancora. Ciò che è
    // vero adesso vince su ciò che è scritto.
    const r = scanOrphanSessions({
      liveSessionIds: [S("1")],
      referencedIds: new Set(),
      attachedIds: new Set([S("1")]),
    });
    expect(r.orphans).toEqual([]);
    expect(r.sparedReasons["qualcuno è attaccato adesso"]).toBe(1);
  });

  test("un SOTTO-AGENTE non è un orfano: ha un padre, non una tab", () => {
    // Nessuna interfaccia lo mostra per costruzione. Trattarlo come orfano
    // ucciderebbe il lavoro di un agente vivo.
    const r = scanOrphanSessions({
      liveSessionIds: [S("1")],
      referencedIds: new Set(),
      subAgentIds: new Set([S("1")]),
    });
    expect(r.orphans).toEqual([]);
    expect(r.sparedReasons["sotto-agente: ha un padre, non una tab"]).toBe(1);
  });

  test("nessuna sessione viva: zero orfani E zero esaminate (non è lo stesso)", () => {
    // «Nessuna orfana» e «non ho guardato» darebbero entrambi orphans: [].
    const r = scanOrphanSessions({ liveSessionIds: [], referencedIds: new Set() });
    expect(r.orphans).toEqual([]);
    expect(r.examined).toBe(0);
  });

  test("i motivi del risparmio si contano, così un censimento a zero si spiega", () => {
    const r = scanOrphanSessions({
      liveSessionIds: [S("1"), S("2"), S("3")],
      referencedIds: new Set([S("1")]),
      attachedIds: new Set([S("2")]),
      subAgentIds: new Set([S("3")]),
    });
    expect(r.orphans).toEqual([]);
    expect(Object.values(r.sparedReasons).reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("referencedSessionIdsIn", () => {
  test("trova la forma `terminal:<id>` delle pane", () => {
    const v = JSON.stringify({ panes: { [`terminal:${S("1")}`]: { id: `terminal:${S("1")}` } } });
    expect(referencedSessionIdsIn(v).has(S("1"))).toBe(true);
  });

  test("trova anche l'id nudo dentro un layout", () => {
    const v = JSON.stringify({ rows: [{ paneIds: [S("2")] }] });
    expect(referencedSessionIdsIn(v).has(S("2"))).toBe(true);
  });

  test("è generoso di proposito: meglio risparmiare che uccidere", () => {
    // Un id che compare per un motivo diverso fa risparmiare la sessione. Il
    // costo è un processo in più; l'errore opposto è una conversazione persa.
    const v = JSON.stringify({ qualcosaDiAltro: S("3") });
    expect(referencedSessionIdsIn(v).has(S("3"))).toBe(true);
  });

  test("un valore senza id non ne inventa", () => {
    expect(referencedSessionIdsIn(JSON.stringify({ a: 1, b: "ciao" })).size).toBe(0);
  });

  test("valore illeggibile: nessun id, nessuna eccezione", () => {
    expect(referencedSessionIdsIn("{non json").size).toBe(0);
  });
});
