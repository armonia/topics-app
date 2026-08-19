import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { selectLocalSnapshot } from "../selectors";
import { sanitizeSnapshot } from "./sanitizeSnapshot";
import { DEFAULT_SPACE_ID } from "../types";
import type { PaneState, Pane } from "../types";

/**
 * Regression contract for the "opening a stale webapp closes the desktop's
 * topic tabs" bug (2026-07-12).
 *
 * Root cause: durable tombstone retraction is a local DELETE that never
 * crosses the wire — the maps merge by UNION, so a peer that slept through a
 * close-then-reopen cycle (a rarely-opened webapp with weeks-old localStorage)
 * still holds the dead marker. On boot it merged the server's fresh snapshot,
 * membership-stripped the re-opened pane (deterministic ids: topic tabs = the
 * topic UUID), and its first PUT closed the tab on every client.
 *
 * Fix originale: `Pane.openedAt`, per rendere il confronto causale. NON bastava:
 * `openedAt` è timbrato da chi APRE e `closedAt` da chi CHIUDE, e i due venivano
 * confrontati su una TERZA macchina. Due orologi a muro di dispositivi diversi
 * non ordinano niente — misurato il 2026-08-06, una pane chiusa il 23/07 era
 * ancora aperta su un telefono, e la ritrattazione si propagava all'indietro
 * cancellando il marcatore anche sulla macchina che aveva chiuso.
 *
 * Fix vero: `Pane.openedSeq` contro `TombstoneMark.seq`. Entrambi vengono dal
 * `lastSeq` dello store, che è tenuto al passo col `server_seq` del server —
 * quindi ordinano fra dispositivi. Un client fermo da due settimane porta un
 * `openedSeq` basso e PERDE.
 *
 * Manca uno dei due seq (pane o marcatore precedenti al campo)? Vince il
 * marcatore: al massimo si richiude una pane davvero riaperta, mai il contrario.
 * La ritrattazione avviene su entrambe le metà dell'idratazione:
 *   - strip half: lo snapshot in arrivo (LWW più nuovo) elenca la pane aperta;
 *   - union half: la pane viva locale è più avanti del marcatore in arrivo.
 */

const T_OPEN_OLD = 1_000_000; // original open, long ago
const T_CLOSE = 2_000_000; //   close recorded by some client
const T_REOPEN = 3_000_000; //  deliberate re-open AFTER the close

// I gemelli CAUSALI dei tre istanti sopra. Sono questi a decidere; i T_* restano
// solo perché il marcatore porta ancora un orologio per ordinare il cap FIFO.
const S_OPEN_OLD = 10;
const S_CLOSE = 20;
const S_REOPEN = 30;

/** Marcatore nella forma corrente. */
const mark = (at: number, seq: number) => ({ at, seq });

const blank = (): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  spaces: {},
  activeSpaceId: DEFAULT_SPACE_ID,
  focusedPaneId: null,
  groupOrder: [],
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
});

const openPane = (
  state: PaneState,
  id: string,
  opts: { type?: Pane["type"]; openedAt?: number; openedSeq?: number } = {},
) =>
  paneReducer(state, {
    type: "OPEN_PANE",
    payload: {
      id,
      type: opts.type ?? "chat",
      groupId: "group:default",
      ...(opts.openedAt !== undefined ? { openedAt: opts.openedAt } : {}),
      ...(opts.openedSeq !== undefined ? { openedSeq: opts.openedSeq } : {}),
    },
  });

const hydrate = (state: PaneState, snapshot: Record<string, unknown>, serverSeq = 999) =>
  paneReducer(state, {
    type: "HYDRATE_FROM_SNAPSHOT",
    payload: { snapshot: { ...snapshot, server_seq: serverSeq, seq: serverSeq } },
  });

const paneIds = (s: PaneState) => s.groups["group:default"]?.paneIds ?? [];

/** Minimal wire-shaped snapshot listing `panes` open in group:default. */
const snapshotWith = (
  panes: Record<string, Partial<Pane> & { id: string }>,
  extra: Record<string, unknown> = {},
) => ({
  panes: Object.fromEntries(
    Object.entries(panes).map(([id, p]) => [id, { type: "chat", ...p }]),
  ),
  groups: {
    "group:default": {
      id: "group:default",
      paneIds: Object.keys(panes),
      splitRatio: 0.5,
      splitAxis: "horizontal",
    },
  },
  groupOrder: ["group:default"],
  closedStack: [],
  ...extra,
});

describe("strip half: incoming snapshot lists a pane the local client tombstoned", () => {
  test("stale local marker (webapp boot) — pane re-opened elsewhere survives, marker retracted", () => {
    // The stale webapp: holds a weeks-old tombstone for topic X, no pane X.
    const s = blank();
    s.tombstones["topic-X"] = mark(T_CLOSE, S_CLOSE);
    s.closedStack.push({
      id: "topic-X",
      closedAt: T_CLOSE,
      pane: { id: "topic-X", type: "chat", title: "X" },
      groupId: "group:default",
      groupIndex: 0,
      level: "app",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: S_CLOSE,
    });
    // Server hydrate: X was re-opened on the desktop AFTER the close.
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X", openedAt: T_REOPEN, openedSeq: S_REOPEN } }));

    expect(s.panes["topic-X"]).toBeDefined();
    expect(paneIds(s)).toContain("topic-X");
    // Marker retracted everywhere so this client's next PUT can't re-close the
    // tab on its peers (the second half of the original bug).
    expect(s.tombstones["topic-X"]).toBeUndefined();
    expect(s.closedStack.some((r) => r.id === "topic-X")).toBe(false);
  });

  test("marker NEWER than the pane's open (wake-from-sleep stale PUT) — strip still wins", () => {
    // This client closed X at T_CLOSE; a peer that slept through the close
    // wakes and PUTs its stale state still listing X open since T_OPEN_OLD.
    const s = blank();
    s.tombstones["topic-X"] = mark(T_CLOSE, S_CLOSE);
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X", openedAt: T_OPEN_OLD, openedSeq: S_OPEN_OLD } }));

    expect(s.panes["topic-X"]).toBeUndefined();
    expect(paneIds(s)).not.toContain("topic-X");
    expect(s.tombstones["topic-X"]).toEqual(mark(T_CLOSE, S_CLOSE)); // il marcatore sopravvive
  });

  test("pane in arrivo SENZA openedSeq (legacy) — vince il marcatore", () => {
    const s = blank();
    s.tombstones["topic-X"] = mark(T_CLOSE, S_CLOSE);
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X" } }));

    expect(s.panes["topic-X"]).toBeUndefined();
    expect(s.tombstones["topic-X"]).toEqual(mark(T_CLOSE, S_CLOSE));
  });
});

describe("union half: incoming snapshot carries a marker for a pane open locally", () => {
  test("local pane re-opened AFTER the incoming marker — kept, marker not merged", () => {
    // The desktop: topic X deliberately re-opened at T_REOPEN.
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN, openedSeq: S_REOPEN });
    // A stale peer's PUT: no pane X, but its ancient tombstone for X rides in.
    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": mark(T_CLOSE, S_CLOSE) } }));

    expect(s.panes["topic-X"]).toBeDefined();
    expect(paneIds(s)).toContain("topic-X");
    expect(s.tombstones["topic-X"]).toBeUndefined();
  });

  test("stale closedStack record alone (no tombstone) is also beaten by a newer open", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN, openedSeq: S_REOPEN });
    hydrate(
      s,
      snapshotWith(
        {},
        {
          closedStack: [
            {
              id: "topic-X",
              closedAt: T_CLOSE,
              pane: { id: "topic-X", type: "chat", title: "X" },
              groupId: "group:default",
              groupIndex: 0,
              level: "app",
              focusedAtClose: false,
              tabOrderSnapshot: [],
              seq: S_CLOSE,
            },
          ],
        },
      ),
    );

    expect(s.panes["topic-X"]).toBeDefined();
    expect(paneIds(s)).toContain("topic-X");
    // The stale undo record must not survive either — it would re-close the
    // pane on every peer via their union filter on our next PUT.
    expect(s.closedStack.some((r) => r.id === "topic-X")).toBe(false);
  });

  test("incoming marker NEWER than the local open — genuine remote close, pane dropped", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_OPEN_OLD, openedSeq: S_OPEN_OLD });
    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": mark(T_CLOSE, S_CLOSE) } }));

    expect(s.panes["topic-X"]).toBeUndefined();
    expect(paneIds(s)).not.toContain("topic-X");
    expect(s.tombstones["topic-X"]).toEqual(mark(T_CLOSE, S_CLOSE));
  });

  test("pane locale SENZA openedSeq (legacy) — vince il marcatore in arrivo", () => {
    const s = blank();
    openPane(s, "topic-X");
    delete s.panes["topic-X"].openedSeq; // pane persistita prima del campo
    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": mark(T_CLOSE, S_CLOSE) } }));

    expect(s.panes["topic-X"]).toBeUndefined();
  });
});

describe("openedAt lifecycle", () => {
  test("OPEN_PANE stamps a fresh insert; re-OPEN of an already-open pane preserves it", () => {
    const s = blank();
    const before = Date.now();
    openPane(s, "topic-X");
    const stamped = s.panes["topic-X"].openedAt;
    expect(typeof stamped).toBe("number");
    expect(stamped as number).toBeGreaterThanOrEqual(before);

    // Re-OPEN (persistBrowserPane-style re-entry) must NOT restamp — a passive
    // refresh must not outrank a peer's genuine concurrent close.
    openPane(s, "topic-X");
    expect(s.panes["topic-X"].openedAt).toBe(stamped as number);
  });

  test("UNDO_CLOSE stamps the restore as a fresh open", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_OPEN_OLD, openedSeq: S_OPEN_OLD });
    paneReducer(s, {
      type: "CLOSE_PANE",
      payload: { id: "topic-X", groupId: "group:default", groupIndex: 0 },
    });
    const before = Date.now();
    paneReducer(s, { type: "UNDO_CLOSE" });
    expect(s.panes["topic-X"].openedAt as number).toBeGreaterThanOrEqual(before);
  });

  test("openedAt survives the serialize → sanitize → hydrate round-trip", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN, openedSeq: S_REOPEN });
    const snap = selectLocalSnapshot(s);
    const clean = sanitizeSnapshot(snap);
    expect(clean?.panes?.["topic-X"]?.openedAt).toBe(T_REOPEN);

    const fresh = blank();
    hydrate(fresh, { ...snap });
    expect(fresh.panes["topic-X"].openedAt).toBe(T_REOPEN);
  });

  test("PANE_ID_REMAP porta openedAt E openedSeq attraverso la promozione bozza → reale", () => {
    const s = blank();
    openPane(s, "draft:1", { openedAt: T_REOPEN, openedSeq: S_REOPEN });
    paneReducer(s, {
      type: "PANE_ID_REMAP",
      payload: { from: "draft:1", to: "topic-X", updates: {} },
    });
    expect(s.panes["topic-X"].openedAt).toBe(T_REOPEN);
    expect(s.panes["topic-X"].openedSeq).toBe(S_REOPEN);
  });
});

describe("formato del filo: retrocompatibile, e il seq viaggia a fianco", () => {
  // `selectLocalSnapshot` emette `tombstones` come MAPPA DI NUMERI perché il
  // sanitizer delle versioni precedenti pretende `typeof v === 'number'` e
  // scarterebbe un oggetto — buttando via OGNI marcatore e riaprendo le pane
  // chiuse su quel client. Il seq viaggia in `tombstoneSeqs`, chiave nuova che
  // un client vecchio ignora. Questo test è ciò che impedisce a un refactor
  // "tanto ora è un oggetto" di trasformare un aggiornamento in una resurrezione.

  test("in uscita `tombstones` è una mappa di NUMERI, il seq sta in `tombstoneSeqs`", () => {
    const s = blank();
    s.tombstones["topic-X"] = mark(T_CLOSE, S_CLOSE);
    s.tombstones["topic-legacy"] = mark(T_CLOSE, 0);

    const snap = selectLocalSnapshot(s) as unknown as {
      tombstones: Record<string, unknown>;
      tombstoneSeqs: Record<string, number>;
    };

    expect(snap.tombstones["topic-X"]).toBe(T_CLOSE);
    expect(typeof snap.tombstones["topic-X"]).toBe("number");
    expect(snap.tombstoneSeqs["topic-X"]).toBe(S_CLOSE);
    // Un marcatore senza seq non inquina la chiave parallela con uno zero.
    expect(snap.tombstoneSeqs["topic-legacy"]).toBeUndefined();
  });

  test("giro completo: il seq sopravvive a uscita → sanitize → idratazione", () => {
    const a = blank();
    openPane(a, "topic-X", { openedAt: T_OPEN_OLD, openedSeq: S_OPEN_OLD });
    a.tombstones["topic-X"] = mark(T_CLOSE, S_CLOSE);

    const b = blank();
    hydrate(b, { ...selectLocalSnapshot(a) });

    expect(b.tombstones["topic-X"]).toEqual(mark(T_CLOSE, S_CLOSE));
  });

  test("client vecchio (nessun `tombstoneSeqs`): seq 0, e decide il marcatore", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN, openedSeq: S_REOPEN });

    // Lo snapshot di un peer sul bundle precedente: solo la mappa di numeri.
    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": T_CLOSE as unknown as never } }));

    expect(s.tombstones["topic-X"]).toEqual(mark(T_CLOSE, 0));
    expect(s.panes["topic-X"]).toBeUndefined();
  });
});

describe("il caso Japan: un dispositivo dormiente non resuscita piu' nulla", () => {
  // Riproduzione del guasto misurato il 2026-08-06.
  //
  // Una pane chiusa il 23/07 risultava ancora aperta su un telefono. Il telefono
  // l'aveva aperta DOPO quella data secondo il proprio orologio — ma senza mai
  // riuscire a sincronizzare (in quel periodo ogni /api tornava 401 per la
  // barriera di pairing). Quindi: `openedAt` piu' recente del `closedAt`, e
  // `openedSeq` FERMO a prima della chiusura, perche' quel client non aveva mai
  // visto avanzare la storia condivisa.
  //
  // Vecchia regola (orologi): la pane sopravvive E il marcatore viene ritratto,
  // quindi la resurrezione si propaga all'indietro fino alla macchina che aveva
  // chiuso. Regola nuova (causalita'): la pane cade e il marcatore resta.
  const T_PHONE_OPEN = T_CLOSE + 999_000; // orologio del telefono: PIU' AVANTI
  const S_PHONE_OPEN = S_CLOSE - 5; //      storia condivisa vista: INDIETRO

  test("openedAt piu' recente ma openedSeq indietro: la pane cade, il marcatore RESTA", () => {
    const phone = blank();
    openPane(phone, "topic-X", { openedAt: T_PHONE_OPEN, openedSeq: S_PHONE_OPEN });

    hydrate(phone, snapshotWith({}, { tombstones: { "topic-X": mark(T_CLOSE, S_CLOSE) } }));

    expect(phone.panes["topic-X"]).toBeUndefined();
    expect(paneIds(phone)).not.toContain("topic-X");
    // La meta' che contava davvero: il marcatore NON viene ritratto, quindi il
    // prossimo PUT del telefono non riapre la pane sulle altre macchine.
    expect(phone.tombstones["topic-X"]).toEqual(mark(T_CLOSE, S_CLOSE));
  });

  test("stessa scena dall'altra meta': lo snapshot in arrivo elenca la pane, il marcatore locale vince", () => {
    const desktop = blank();
    desktop.tombstones["topic-X"] = mark(T_CLOSE, S_CLOSE);

    // Il telefono ha PUTtato il suo stato: elenca la pane con un orologio
    // avanti e un seq indietro.
    hydrate(
      desktop,
      snapshotWith({
        "topic-X": { id: "topic-X", openedAt: T_PHONE_OPEN, openedSeq: S_PHONE_OPEN },
      }),
    );

    expect(desktop.panes["topic-X"]).toBeUndefined();
    expect(desktop.tombstones["topic-X"]).toEqual(mark(T_CLOSE, S_CLOSE));
  });

  test("ma una riapertura VERA sopravvive: chi ha visto la chiusura puo' riaprire", () => {
    // La regola nuova non deve uccidere il caso legittimo insieme al guasto:
    // qui il client ha visto la chiusura (seq avanti) e ha riaperto davvero.
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_OPEN_OLD, openedSeq: S_CLOSE + 1 });

    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": mark(T_CLOSE, S_CLOSE) } }));

    expect(s.panes["topic-X"]).toBeDefined();
    expect(paneIds(s)).toContain("topic-X");
    expect(s.tombstones["topic-X"]).toBeUndefined();
  });

  test("marcatore LEGACY (senza seq): vince il marcatore, che e' la direzione sicura", () => {
    // Migrazione: i 381 marcatori gia' sul server sono numeri nudi. Normalizzati
    // a seq 0, e con seq 0 nessun openedSeq li scavalca. Al massimo si richiude
    // una pane davvero riaperta — l'utente la riapre — mai il contrario.
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN, openedSeq: S_REOPEN });

    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": T_CLOSE as unknown as never } }));

    expect(s.panes["topic-X"]).toBeUndefined();
    expect(s.tombstones["topic-X"]).toEqual(mark(T_CLOSE, 0));
  });
});

describe("mixed-version peers: incoming snapshot stripped of openedAt", () => {
  test("local openedAt survives a wholesale apply from an old-build peer and still beats the stale marker", () => {
    // Local (new build): topic X re-opened after the close.
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN, openedSeq: S_REOPEN });
    // Old-build peer re-PUTs: it lists X open (it hydrated it) but its
    // sanitizer stripped openedAt, and its merged map still carries the
    // stale marker (old code never retracts).
    hydrate(
      s,
      snapshotWith(
        { "topic-X": { id: "topic-X" } }, // niente openedAt NE' openedSeq sul filo
        { tombstones: { "topic-X": mark(T_CLOSE, S_CLOSE) } },
      ),
    );

    // The max-graft must restore the local timestamp so the strip retracts
    // the marker instead of killing the tab (the mixed-version bleed window
    // while some clients still run the pre-fix bundle).
    expect(s.panes["topic-X"]).toBeDefined();
    expect(s.panes["topic-X"].openedAt).toBe(T_REOPEN);
    // È QUESTO il campo che tiene viva la regola: perderlo in un giro su un
    // peer vecchio non degrada la precisione, spegne la ritrattazione.
    expect(s.panes["topic-X"].openedSeq).toBe(S_REOPEN);
    expect(paneIds(s)).toContain("topic-X");
    expect(s.tombstones["topic-X"]).toBeUndefined();
  });

  test("the graft keeps the NEWEST of the two timestamps", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_OPEN_OLD, openedSeq: S_OPEN_OLD });
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X", openedAt: T_REOPEN, openedSeq: S_REOPEN } }));
    expect(s.panes["topic-X"].openedAt).toBe(T_REOPEN);
  });
});

describe("end-to-end: the reported bug, two stores through the LWW blob", () => {
  test("desktop reopens a topic; a stale webapp boots, hydrates, PUTs — the tab survives everywhere", () => {
    // ── Desktop: topic X was closed at some point, then deliberately reopened.
    const desktop = blank();
    openPane(desktop, "topic-X", { openedAt: T_OPEN_OLD, openedSeq: S_OPEN_OLD });
    paneReducer(desktop, {
      type: "CLOSE_PANE",
      payload: { id: "topic-X", groupId: "group:default", groupIndex: 0 },
    });
    const closedMark = desktop.tombstones["topic-X"];
    expect(closedMark.at).toBeGreaterThan(0);
    expect(closedMark.seq).toBeGreaterThan(0);
    // Riapertura DOPO la chiusura, e "dopo" si misura sul seq.
    openPane(desktop, "topic-X", {
      openedAt: closedMark.at + 60_000,
      openedSeq: closedMark.seq + 1,
    });
    expect(desktop.tombstones["topic-X"]).toBeUndefined();

    // Desktop PUTs → this is the server blob the webapp will hydrate.
    const serverBlob = selectLocalSnapshot(desktop);

    // ── Webapp: stale localStorage from BEFORE the reopen — it still holds the
    // marker (it merged the close, never learned of the retraction).
    const webapp = blank();
    webapp.tombstones["topic-X"] = closedMark;

    // Webapp boots and hydrates the server blob (LWW-newer).
    hydrate(webapp, { ...serverBlob }, 1000);
    // The reopened tab must survive the webapp's strip…
    expect(webapp.panes["topic-X"]).toBeDefined();
    expect(paneIds(webapp)).toContain("topic-X");
    expect(webapp.tombstones["topic-X"]).toBeUndefined();

    // …and the webapp's own PUT back must not close it on the desktop.
    const webappPut = selectLocalSnapshot(webapp);
    hydrate(desktop, { ...webappPut }, 1001);
    expect(desktop.panes["topic-X"]).toBeDefined();
    expect(paneIds(desktop)).toContain("topic-X");
  });
});
