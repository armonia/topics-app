/**
 * @covers PROJECT-07
 */
import { describe, expect, test } from "bun:test";
import {
  vedeProgetto, envelopeProgettoPer, visibilitaDi,
  type Osservatore, type ProgettoVisibilita,
} from "./project-visibility";

const MACCHINA: Osservatore = { macchina: true, personId: null, orgIds: [], proprietarioInstallazione: false };
const chi = (o: Partial<Osservatore>): Osservatore => ({
  macchina: false, personId: null, orgIds: [], proprietarioInstallazione: false, ...o,
});
const prog = (p: Partial<ProgettoVisibilita>): ProgettoVisibilita => ({
  orgId: null, ownerPersonId: null, incognito: false, ...p,
});

describe("vedeProgetto", () => {
  test("la macchina stessa vede tutto, incognito compresi", () => {
    expect(vedeProgetto(MACCHINA, prog({ incognito: true, ownerPersonId: "altri", orgId: "o9" }))).toBe(true);
  });

  test("stessa organizzazione, stesso progetto", () => {
    const p = prog({ orgId: "o1", ownerPersonId: "attilio" });
    expect(vedeProgetto(chi({ personId: "mircea", orgIds: ["o1"] }), p)).toBe(true);
  });

  test("un'altra organizzazione non lo vede", () => {
    const p = prog({ orgId: "o1", ownerPersonId: "attilio" });
    expect(vedeProgetto(chi({ personId: "estraneo", orgIds: ["o2"] }), p)).toBe(false);
    expect(vedeProgetto(chi({ personId: "senzaorg", orgIds: [] }), p)).toBe(false);
  });

  test("incognito: lo vede SOLO chi l'ha marcato, nemmeno i compagni d'org", () => {
    const p = prog({ orgId: "o1", ownerPersonId: "attilio", incognito: true });
    expect(vedeProgetto(chi({ personId: "attilio", orgIds: ["o1"] }), p)).toBe(true);
    expect(vedeProgetto(chi({ personId: "mircea", orgIds: ["o1"] }), p)).toBe(false);
  });

  test("incognito: nemmeno il proprietario dell'installazione, se il progetto è di un altro", () => {
    const p = prog({ orgId: "o1", ownerPersonId: "mircea", incognito: true });
    expect(
      vedeProgetto(chi({ personId: "attilio", orgIds: ["o1"], proprietarioInstallazione: true }), p),
    ).toBe(false);
  });

  test("incognito senza proprietario ricade sul proprietario dell'installazione", () => {
    const p = prog({ orgId: "o1", ownerPersonId: null, incognito: true });
    expect(vedeProgetto(chi({ personId: "attilio", proprietarioInstallazione: true }), p)).toBe(true);
    expect(vedeProgetto(chi({ personId: "mircea", orgIds: ["o1"] }), p)).toBe(false);
  });

  test("org_id NULL resta al proprietario della macchina: com'era prima della 092", () => {
    const p = prog({ orgId: null, ownerPersonId: null });
    expect(vedeProgetto(chi({ personId: "attilio", proprietarioInstallazione: true }), p)).toBe(true);
    expect(vedeProgetto(chi({ personId: "mircea", orgIds: ["o1"] }), p)).toBe(false);
  });

  test("due NULL non sono la stessa persona", () => {
    const p = prog({ orgId: "o1", ownerPersonId: null, incognito: true });
    expect(vedeProgetto(chi({ personId: null, orgIds: ["o1"] }), p)).toBe(false);
  });
});

describe("visibilitaDi", () => {
  test("`undefined` cade dove cade `null`, e `incognito` vale solo su `true`", () => {
    expect(visibilitaDi({})).toEqual({ orgId: null, ownerPersonId: null, incognito: false });
    // Il cast è il punto: se un `1` passasse per un sì, un errore di battitura
    // del client diventerebbe una condivisione (o il suo contrario).
    expect(visibilitaDi({ incognito: 1 as unknown as boolean }).incognito).toBe(false);
  });
});

describe("envelopeProgettoPer — chi non vede riceve la RITRATTA", () => {
  const RIGA = { id: "p1", orgId: "o1", ownerPersonId: "attilio", incognito: true, name: "Segreto", path: "/tmp/x" };

  test("chi lo vede riceve la riga intera, col tipo chiesto", () => {
    const e = envelopeProgettoPer(chi({ personId: "attilio", orgIds: ["o1"] }), "project:updated", RIGA);
    expect(e).toEqual({ type: "project:updated", project: RIGA, payload_version: 1 });
  });

  test("chi non lo vede riceve `project:deleted` col solo id — niente nome, niente path", () => {
    const e = envelopeProgettoPer(chi({ personId: "mircea", orgIds: ["o1"] }), "project:updated", RIGA);
    expect(e).toEqual({ type: "project:deleted", project: { id: "p1" }, payload_version: 1 });
    // La prova vera è sulla stringa che parte: è lì che una fuga si vede.
    expect(JSON.stringify(e)).not.toContain("Segreto");
    expect(JSON.stringify(e)).not.toContain("/tmp/x");
  });

  test("la ritratta parte per tutti e tre i verbi, `project:new` compreso", () => {
    // Un no-op sul client (un id che non conosce) invece di un ramo in più
    // proprio dove sbagliarsi vuol dire consegnare un nome.
    for (const tipo of ["project:new", "project:updated", "project:archived"] as const) {
      expect(envelopeProgettoPer(chi({ personId: "mircea", orgIds: ["o1"] }), tipo, RIGA).type)
        .toBe("project:deleted");
      expect(envelopeProgettoPer(MACCHINA, tipo, RIGA).type).toBe(tipo);
    }
  });
});
