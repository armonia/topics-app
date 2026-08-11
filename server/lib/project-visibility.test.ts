import { describe, expect, test } from "bun:test";
import { vedeProgetto, type Osservatore, type ProgettoVisibilita } from "./project-visibility";

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
