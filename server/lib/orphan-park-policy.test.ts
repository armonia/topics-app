/**
 * Come per il censimento, il rischio è a senso unico: parcheggiare una sessione
 * viva costa il lavoro di qualcuno, risparmiarne una davvero orfana costa un
 * processo. I test insistono quindi su ciò che NON dev'essere parcheggiato.
 *
 * @covers RETIRE-09
 */
import { describe, test, expect } from "bun:test";
import { planOrphanPark, formatOrphanParkPlan } from "./orphan-park-policy";

const S = (n: string) => `0000000${n}-1111-4222-8333-444444444444`;
const base = { uiStateRows: 42, enabled: true };

describe("planOrphanPark", () => {
  test("alla PRIMA volta che la vede non agisce: aspetta la conferma", () => {
    // È la finestra in cui una pane appena creata esiste sullo schermo ma non
    // ancora in `ui_state`. Un solo avvistamento non la distingue da un'orfana.
    const p = planOrphanPark({ ...base, orphansNow: [S("1")], orphansBefore: new Set() });
    expect(p.park).toEqual([]);
    expect(p.held).toEqual([{ id: S("1"), reason: "prima-conferma" }]);
    expect(p.remember).toEqual([S("1")]);
  });

  test("orfana anche al giro precedente ⇒ si parcheggia", () => {
    const p = planOrphanPark({ ...base, orphansNow: [S("1")], orphansBefore: new Set([S("1")]) });
    expect(p.park).toEqual([S("1")]);
    expect(p.blocked).toBeNull();
  });

  test("una sessione tornata in ui_state fra i due giri NON si parcheggia", () => {
    // Il caso vero: la pane esisteva, la scrittura è arrivata tardi. Il secondo
    // censimento non la nomina più, quindi non arriva mai a `park`.
    const p = planOrphanPark({ ...base, orphansNow: [], orphansBefore: new Set([S("1")]) });
    expect(p.park).toEqual([]);
    expect(p.remember).toEqual([]);
  });

  test("ui_state a ZERO righe non è «nessuno la mostra»: non si agisce", () => {
    // Senza questo, un database vuoto o sul percorso sbagliato parcheggerebbe
    // ogni sessione viva della macchina.
    const p = planOrphanPark({
      ...base,
      uiStateRows: 0,
      orphansNow: [S("1"), S("2")],
      orphansBefore: new Set([S("1"), S("2")]),
    });
    expect(p.park).toEqual([]);
    expect(p.blocked).toBe("nessuna riga di ui_state letta");
  });

  test("un giro bloccato non lascia conferme al giro dopo", () => {
    // Altrimenti il giro cieco diventa la prima delle due conferme e la regola
    // dei due avvistamenti vale metà.
    const p = planOrphanPark({ ...base, uiStateRows: 0, orphansNow: [S("1")], orphansBefore: new Set() });
    expect(p.remember).toEqual([]);
  });

  test("interruttore spento: si censisce, non si tocca niente", () => {
    const p = planOrphanPark({
      ...base,
      enabled: false,
      orphansNow: [S("1")],
      orphansBefore: new Set([S("1")]),
    });
    expect(p.park).toEqual([]);
    expect(p.blocked).toContain("TOPICS_ORPHAN_PARK");
  });

  test("più orfane insieme: si parcheggia solo chi ha la seconda conferma", () => {
    const p = planOrphanPark({
      ...base,
      orphansNow: [S("1"), S("2")],
      orphansBefore: new Set([S("1")]),
    });
    expect(p.park).toEqual([S("1")]);
    expect(p.held.map((h) => h.id)).toEqual([S("2")]);
  });

  test("nessuna orfana: giro normale, nessun blocco", () => {
    const p = planOrphanPark({ ...base, orphansNow: [], orphansBefore: new Set() });
    expect(p.park).toEqual([]);
    expect(p.blocked).toBeNull();
  });
});

describe("formatOrphanParkPlan", () => {
  test("un giro bloccato dice PERCHÉ", () => {
    const line = formatOrphanParkPlan(planOrphanPark({ ...base, uiStateRows: 0, orphansNow: [], orphansBefore: new Set() }));
    expect(line).toContain("nessuna riga di ui_state letta");
  });

  test("nomina gli id parcheggiati: «due orfane» non è smentibile da nessuno", () => {
    const line = formatOrphanParkPlan(planOrphanPark({ ...base, orphansNow: [S("1")], orphansBefore: new Set([S("1")]) }));
    expect(line).toContain(S("1").slice(0, 8));
  });

  test("distingue «non ho parcheggiato» da «aspetto la conferma»", () => {
    const line = formatOrphanParkPlan(planOrphanPark({ ...base, orphansNow: [S("1")], orphansBefore: new Set() }));
    expect(line).toContain("seconda conferma");
  });
});
