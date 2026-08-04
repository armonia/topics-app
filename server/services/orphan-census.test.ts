/**
 * La decisione è già provata in `lib/orphan-sessions.test.ts`. Qui si prova
 * l'unica cosa che questo modulo aggiunge — l'UNIONE fra le righe di `ui_state`
 * — e si prova nel verso in cui sbagliare fa danno: una sessione referenziata da
 * UNA sola riga deve essere risparmiata.
 */
import { describe, test, expect } from "bun:test";
import { censusOnce, formatCensus, type CensusDeps } from "./orphan-census";

const S = (n: string) => `0000000${n}-1111-4222-8333-444444444444`;
const deps = (
  sessions: Array<{ id: string; attached?: boolean; isSubAgent?: boolean }>,
  values: string[],
): CensusDeps => ({
  listSessions: () => sessions.map((s) => ({ attached: false, isSubAgent: false, ...s })),
  listUiStateValues: () => values,
});

describe("censusOnce", () => {
  test("una sessione referenziata da UNA SOLA riga è risparmiata", () => {
    // È il caso che rompe un censimento che guarda una struttura alla volta: la
    // pane vive in un `project-layout-*` e non nel pane store globale.
    const r = censusOnce(
      deps([{ id: S("1") }], [
        JSON.stringify({ panes: {} }),
        JSON.stringify({ rows: [{ paneIds: [`terminal:${S("1")}`] }] }),
      ]),
    );
    expect(r.orphans).toEqual([]);
  });

  test("nessuna riga la nomina ⇒ è candidata", () => {
    const r = censusOnce(deps([{ id: S("2") }], [JSON.stringify({ panes: {} }), "{}"]));
    expect(r.orphans).toEqual([S("2")]);
  });

  test("attaccata o sotto-agente non è mai candidata, qualunque cosa dica ui_state", () => {
    const r = censusOnce(
      deps([{ id: S("3"), attached: true }, { id: S("4"), isSubAgent: true }], ["{}"]),
    );
    expect(r.orphans).toEqual([]);
    expect(r.examined).toBe(2);
  });

  test("una riga illeggibile non fa saltare il censimento né inventa referenze", () => {
    const r = censusOnce(deps([{ id: S("5") }], ["{non json", JSON.stringify({ a: 1 })]));
    expect(r.orphans).toEqual([S("5")]);
  });
});

describe("formatCensus", () => {
  test("nomina le candidate: «due orfane» non permette a nessuno di riconoscerle", () => {
    const line = formatCensus(censusOnce(deps([{ id: S("6") }], ["{}"])));
    expect(line).toContain(S("6"));
    expect(line).toContain("sola lettura");
  });

  test("zero candidate si distingue da «non ho guardato»", () => {
    const zero = formatCensus(censusOnce(deps([], [])));
    expect(zero).toContain("0 sessioni esaminate");
    const spared = formatCensus(censusOnce(deps([{ id: S("7"), attached: true }], [])));
    expect(spared).toContain("risparmiate");
  });
});
