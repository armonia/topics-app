/**
 * The badge is a WARNING, so every test here is about when it must stay quiet.
 *
 * The defect this file guards against is not "the icon does not appear" — that
 * one you notice in a second. It is the opposite: an icon on every tab, which
 * costs nothing to ship, looks correct in a screenshot, and quietly destroys
 * the only thing the mark is for. Measured on this installation on
 * 2026-08-25: ten projects out of ten carry `org_id`, all pointing at an
 * organisation whose live membership is one. Wired to the column, the feature
 * would have marked every tab as shared while nobody could see any of them.
 *
 * @covers PROJECT-04
 */
import { describe, expect, test } from "bun:test";
import { sharedWith, sharedTitle, type OrgRef, type ProjectSharing } from "./projectSharing";

const org = (o: Partial<OrgRef> = {}): OrgRef =>
  ({ id: "o1", name: "Danceroom", logoUrl: null, members: 3, ...o });

const proj = (p: Partial<ProjectSharing> = {}): ProjectSharing =>
  ({ path: "/p", orgId: "o1", incognito: false, ...p });

const indice = (p: ProjectSharing[], o: OrgRef[]) =>
  [new Map(p.map((x) => [x.path, x])), new Map(o.map((x) => [x.id, x]))] as const;

describe("quando il marchio compare", () => {
  test("progetto di un'organizzazione con altre persone dentro", () => {
    const [pp, oo] = indice([proj()], [org({ members: 3 })]);
    expect(sharedWith("/p", pp, oo)?.name).toBe("Danceroom");
  });

  test("due persone bastano: il secondo membro e' gia' qualcuno che legge", () => {
    const [pp, oo] = indice([proj()], [org({ members: 2 })]);
    expect(sharedWith("/p", pp, oo)).not.toBeNull();
  });
});

describe("quando tace, e perche'", () => {
  test("un'organizzazione di UNA persona non condivide niente con nessuno", () => {
    // La riga per cui esiste questo file: sull'installazione di chi scrive,
    // dieci progetti su dieci cadono qui.
    const [pp, oo] = indice([proj()], [org({ members: 1 })]);
    expect(sharedWith("/p", pp, oo)).toBeNull();
  });

  test("`incognito` vince sull'appartenenza: il proprietario ha gia' detto di no", () => {
    const [pp, oo] = indice([proj({ incognito: true })], [org({ members: 5 })]);
    expect(sharedWith("/p", pp, oo)).toBeNull();
  });

  test("`org_id` nullo: nessuna organizzazione, nessun marchio", () => {
    const [pp, oo] = indice([proj({ orgId: null })], [org()]);
    expect(sharedWith("/p", pp, oo)).toBeNull();
  });

  test("un'organizzazione che l'indice non sa nominare non diventa «condiviso con ?»", () => {
    // Il senso del marchio e' il CON CHI. Senza il nome resterebbe solo
    // l'allarme, che e' la meta' che non si puo' verificare guardandola.
    const [pp, oo] = indice([proj({ orgId: "fantasma" })], [org()]);
    expect(sharedWith("/p", pp, oo)).toBeNull();
  });

  test("un progetto che l'indice non conosce e' una domanda aperta, non un «no»", () => {
    const [pp, oo] = indice([proj()], [org()]);
    expect(sharedWith("/altro", pp, oo)).toBeNull();
  });

  test("senza path non si indovina", () => {
    const [pp, oo] = indice([proj()], [org()]);
    expect(sharedWith(null, pp, oo)).toBeNull();
    expect(sharedWith("", pp, oo)).toBeNull();
  });

  test("indici vuoti: la prima risposta e' silenzio, non un marchio a caso", () => {
    expect(sharedWith("/p", new Map(), new Map())).toBeNull();
  });
});

describe("il titolo dice CON CHI", () => {
  test("nomina l'organizzazione e quanti la vedono", () => {
    const t = sharedTitle(org({ name: "Armonia", members: 4 }));
    expect(t).toContain("Armonia");
    expect(t).toContain("4");
  });

  test("e non e' la stringa vuota per un'organizzazione senza logo", () => {
    // Il logo e' opzionale, il NOME no: un marchio senza titolo dice «condiviso»
    // e lascia aperta l'unica domanda che conta.
    expect(sharedTitle(org({ logoUrl: null })).length).toBeGreaterThan(10);
  });
});
