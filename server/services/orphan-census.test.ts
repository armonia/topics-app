/**
 * La decisione è già provata in `lib/orphan-sessions.test.ts`. Qui si prova
 * l'unica cosa che questo modulo aggiunge — l'UNIONE fra le righe di `ui_state`
 * — e si prova nel verso in cui sbagliare fa danno: una sessione referenziata da
 * UNA sola riga deve essere risparmiata.
 *
 * @covers RETIRE-05
 */
import { describe, test, expect } from "bun:test";
import { censusOnce, formatCensus, createOrphanCensusRunner, type CensusDeps } from "./orphan-census";

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

/**
 * LE QUATTRO STRUTTURE, UNA PER VOLTA.
 *
 * È il modo in cui questo censimento può fare danno: se conosce tre forme su
 * quattro, la sessione che vive SOLO nella quarta risulta orfana e chi agisce la
 * spegne. I casi qui sotto usano le forme VERE lette dal database del 10/08 —
 * inventarle sarebbe provare la propria idea delle strutture, non le strutture —
 * e ognuno popola una sola chiave: la sessione dev'essere risparmiata da
 * quell'unica riga, senza aiuto dalle altre.
 */
describe("le quattro strutture di ui_state, una per volta", () => {
  const id = S("8");
  // In tutti e quattro i casi la sessione ha una tab APERTA a schermo: nessuno
  // dei quattro deve mai finire fra le candidate.
  const soloQuestaRiga = (value: string) => censusOnce(deps([{ id }], [value]));

  test("1. pane store globale (`pane-store-v2`): la pane sta in `panes`", () => {
    const v = JSON.stringify({
      panes: { [`terminal:${id}`]: { id: `terminal:${id}`, type: "terminal", terminalType: "claude-code" } },
      groups: {}, groupOrder: ["group:default"], closedStack: [], tombstones: {}, lastSeq: 12,
    });
    expect(soloQuestaRiga(v).orphans).toEqual([]);
  });

  test("2. layout di progetto (`project-layout-*`): la pane sta in `nonChatPanes`", () => {
    const v = JSON.stringify({
      nonChatPanes: [{ id: `terminal:${id}`, type: "terminal", title: "Claude Code", preview: false, terminalType: "claude-code" }],
      groups: [], rows: [{ groupIds: ["group:1774706851253-15"], widths: [1] }], rowHeights: [],
      sidebarCollapsed: false, openChatTopicIds: [], activeChatTopicId: null,
    });
    expect(soloQuestaRiga(v).orphans).toEqual([]);
  });

  test("3. pane di progetto (`topics-project-panes-*`): stessa forma, chiave diversa", () => {
    // Due chiavi distinte con la stessa forma non sono una ridondanza da
    // semplificare: il layout può avere `nonChatPanes` VUOTO mentre le pane
    // vivono nell'altra riga — è com'è messo il database vero.
    const v = JSON.stringify({
      nonChatPanes: [
        { id: "browser:term-bdfbeebf-77cd-4878-8f4d-1fe42fc10586", type: "browser", url: "https://esempio.it" },
        { id: `terminal:${id}`, type: "terminal", title: "è arrivato tutto", preview: false, terminalType: "claude-code" },
      ],
    });
    expect(soloQuestaRiga(v).orphans).toEqual([]);
  });

  test("4. tab standalone: l'id nudo dentro un gruppo del pane store", () => {
    // La tab non ancorata a un progetto compare come id dentro la lista delle
    // pane del suo gruppo, senza il prefisso `terminal:`.
    const v = JSON.stringify({
      panes: {},
      groups: { "group:default": { id: "group:default", paneIds: [id], activePaneId: id, splitRatio: 0.5 } },
      groupOrder: ["group:default"],
    });
    expect(soloQuestaRiga(v).orphans).toEqual([]);
  });

  test("nessuna delle quattro la nomina ⇒ solo allora è candidata", () => {
    // Il controllo che dà senso ai quattro sopra: se il censimento risparmiasse
    // comunque, passerebbero anche essendo ciechi.
    const vuote = [
      JSON.stringify({ panes: {}, groups: {}, groupOrder: [] }),
      JSON.stringify({ nonChatPanes: [], groups: [], rows: [] }),
      JSON.stringify({ nonChatPanes: [] }),
    ];
    expect(censusOnce(deps([{ id }], vuote)).orphans).toEqual([id]);
  });

  test("una pane CHIUSA di recente (`closedStack`) risparmia lo stesso, ed è voluto", () => {
    // Generosità deliberata: la riga chiusa può essere riaperta, e comunque il
    // costo di sbagliare qui è un processo in più — l'errore opposto è una
    // conversazione persa.
    const v = JSON.stringify({
      panes: {}, groups: {}, groupOrder: [],
      closedStack: [{ id: `terminal:${id}`, closedAt: 1786027727904, pane: { id: `terminal:${id}`, type: "terminal" } }],
    });
    expect(soloQuestaRiga(v).orphans).toEqual([]);
  });
});

describe("formatCensus", () => {
  test("nomina le candidate: «due orfane» non permette a nessuno di riconoscerle", () => {
    const line = formatCensus(censusOnce(deps([{ id: S("6") }], ["{}"])));
    expect(line).toContain(S("6"));
    expect(line).toContain("candidate al parcheggio");
  });

  test("zero candidate si distingue da «non ho guardato»", () => {
    const zero = formatCensus(censusOnce(deps([], [])));
    expect(zero).toContain("0 sessioni esaminate");
    const spared = formatCensus(censusOnce(deps([{ id: S("7"), attached: true }], [])));
    expect(spared).toContain("risparmiate");
  });

  test("dice quante righe di ui_state ha letto: zero non è «nessuna interfaccia»", () => {
    // Il numero su cui `planOrphanPark` si rifiuta di agire. Senza, dal log un
    // database vuoto e un database senza pane sono la stessa riga.
    expect(censusOnce(deps([{ id: S("9") }], [])).uiStateRows).toBe(0);
    expect(formatCensus(censusOnce(deps([{ id: S("9") }], ["{}", "{}"])))).toContain("2 righe di ui_state");
  });
});

/**
 * LA CATENA INTERA, giro dopo giro.
 *
 * I pezzi sono provati altrove; questo prova il MONTAGGIO, che è dove la
 * regressione può tornare senza che nessuno se ne accorga. E prova l'unica cosa
 * che un giro solo non può mostrare: che serve la conferma del giro successivo.
 *
 * `park` è iniettato e registra soltanto: nessuna PTY viene toccata qui.
 */
describe("createOrphanCensusRunner — la catena censimento → decisione → parcheggio", () => {
  const id = S("1");
  const setup = (opts?: { enabled?: boolean }) => {
    const parked: string[][] = [];
    const logs: string[] = [];
    // Mutabile: i giri successivi leggono lo stato di ADESSO, come in produzione.
    const state = { sessions: [{ id, attached: false, isSubAgent: false }], values: ["{}"] };
    const run = createOrphanCensusRunner({
      listSessions: () => state.sessions,
      listUiStateValues: () => state.values,
      park: (ids) => parked.push([...ids]),
      enabled: opts?.enabled ?? true,
      log: (m) => logs.push(m),
    });
    return { run, parked, logs, state };
  };

  test("un giro solo NON parcheggia: la conferma arriva al secondo", () => {
    const { run, parked } = setup();
    run();
    expect(parked).toEqual([]);
    run();
    expect(parked).toEqual([[id]]);
  });

  test("se fra i due giri la pane ricompare in ui_state, non si parcheggia più", () => {
    // È il falso positivo che questa regola esiste per fermare: la pane c'era
    // sullo schermo, la scrittura di `ui_state` è arrivata dopo il primo giro.
    const { run, parked, state } = setup();
    run();
    state.values = [JSON.stringify({ nonChatPanes: [{ id: `terminal:${id}`, type: "terminal" }] })];
    run();
    run();
    expect(parked).toEqual([]);
  });

  test("ui_state senza righe: non parcheggia MAI, per quanti giri passino", () => {
    const { run, parked, state, logs } = setup();
    state.values = [];
    run(); run(); run();
    expect(parked).toEqual([]);
    expect(logs.join("\n")).toContain("nessuna riga di ui_state letta");
  });

  test("interruttore spento: censisce e basta, anche al secondo giro", () => {
    const { run, parked, logs } = setup({ enabled: false });
    run(); run();
    expect(parked).toEqual([]);
    expect(logs.some((l) => l.includes("sessioni esaminate"))).toBe(true);
  });

  test("una sessione ATTACCATA non arriva mai al parcheggio, quanti giri si voglia", () => {
    const { run, parked, state } = setup();
    state.sessions = [{ id, attached: true, isSubAgent: false }];
    run(); run(); run();
    expect(parked).toEqual([]);
  });

  test("un sotto-agente non arriva mai al parcheggio: ha un padre, non una tab", () => {
    const { run, parked, state } = setup();
    state.sessions = [{ id, attached: false, isSubAgent: true }];
    run(); run(); run();
    expect(parked).toEqual([]);
  });

  test("il log nomina chi parcheggia: un'azione che nessuno può smentire non va bene", () => {
    const { run, logs } = setup();
    run(); run();
    expect(logs.join("\n")).toContain("[orphan-park]");
    expect(logs.join("\n")).toContain(id.slice(0, 8));
  });
});
