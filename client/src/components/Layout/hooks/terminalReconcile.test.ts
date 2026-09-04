/**
 * Tests for decideRestoredTerminalPane — the guard that stops a refresh /
 * hot-reload from deleting a project's restored Claude Code tabs while the
 * server session roster is momentarily empty or incomplete, and that stops an
 * EXIT from deleting the tab of a session the server just parked.
 *
 * Three verdicts, and the middle one is the whole point: `verify` means "this
 * id left the roster and the dormant list in hand is older than its
 * disappearance", so the caller keeps the pane and asks again.
 *
 * @covers TERM-01
 */
import { describe, test, expect } from "bun:test";
import { decideRestoredTerminalPane } from "./terminalReconcile";

const set = (...ids: string[]) => new Set(ids);
/** No id has been confirmed dead by a fresh read yet. */
const NONE = new Set<string>();

describe("decideRestoredTerminalPane", () => {
  test("keeps a pane whose session is in the current roster", () => {
    expect(decideRestoredTerminalPane("s1", set("s1", "s2"), set("s1"))).toBe("keep");
  });

  test("keeps a restored pane never seen yet (roster not caught up after reload)", () => {
    // Empty roster (server mid-restart): nothing seen → keep everything.
    expect(decideRestoredTerminalPane("s1", set(), set())).toBe("keep");
  });

  test("keeps a restored pane during a PARTIAL roster (reconnect race)", () => {
    // Roster lists s2 but not yet s1; s1 has never been seen → still pending.
    expect(decideRestoredTerminalPane("s1", set("s2"), set("s2"))).toBe("keep");
  });

  test("a seen-then-gone session is VERIFIED, not pruned on the spot", () => {
    // s1 was seen in an earlier roster and is now absent. Closed in another
    // window, or parked one second ago: from here the two are identical, and
    // only a dormant read taken AFTER the disappearance separates them.
    expect(decideRestoredTerminalPane("s1", set("s2"), set("s1", "s2"))).toBe("verify");
  });

  test("and it is pruned once a fresh read has confirmed it gone", () => {
    expect(
      decideRestoredTerminalPane("s1", set("s2"), set("s1", "s2"), true, NONE, set("s1")),
    ).toBe("prune");
  });

  test("the reload scenario: empty roster never prunes restored tabs", () => {
    const restored = ["t1", "t2", "t3"];
    const kept = restored.filter((id) => decideRestoredTerminalPane(id, set(), set()) !== "prune");
    expect(kept).toEqual(restored);
  });

  test("after the real roster lands, survivors stay and a genuinely-closed one is checked then pruned", () => {
    const seen = new Set<string>();
    for (const id of ["t1", "t2", "t3"]) seen.add(id);
    const roster = set("t1", "t2");
    expect(decideRestoredTerminalPane("t1", roster, seen)).toBe("keep");
    expect(decideRestoredTerminalPane("t2", roster, seen)).toBe("keep");
    // t3 disappeared: one round trip, then the verdict.
    expect(decideRestoredTerminalPane("t3", roster, seen)).toBe("verify");
    expect(decideRestoredTerminalPane("t3", roster, seen, true, NONE, set("t3"))).toBe("prune");
  });

  // ── Authoritative-roster reaping (the app-restart "sessioni morte" fix) ──────

  test("prunes a never-seen id when an authoritative (non-empty) roster omits it", () => {
    // App restart: a dead terminal id restored from a project's persisted
    // nonChatPanes. The real roster is populated (server is up) but doesn't list
    // it, and it was never seen this mount → genuine corpse, reap it. No verify
    // round here: the mount-time dormant read already covers this id.
    expect(decideRestoredTerminalPane("dead", set("s1", "s2"), set(), true)).toBe("prune");
  });

  test("keeps a never-seen id when the roster is EMPTY even if flagged authoritative", () => {
    // Defensive: an empty roster can never be authoritative in practice (the
    // caller only sets the flag when size>0), but the guard must never reap on
    // an empty roster — that is the hot-reload window.
    expect(decideRestoredTerminalPane("s1", set(), set(), false)).toBe("keep");
  });

  test("keeps a live id present in an authoritative roster", () => {
    expect(decideRestoredTerminalPane("s1", set("s1", "s2"), set("s1"), true)).toBe("keep");
  });

  test("still keeps never-seen ids during a partial roster that is NOT authoritative", () => {
    // Server mid-restart delivered a roster the caller judged unproven → keep.
    expect(decideRestoredTerminalPane("s1", set("s2"), set("s2"), false)).toBe("keep");
  });

  test("the restart scenario: one live tab survives, the dead ones are reaped", () => {
    // Persisted project tabs: t-live (still running) + two corpses from a prior
    // run. The authoritative roster lists only t-live.
    const restored = ["t-live", "t-dead1", "t-dead2"];
    const roster = set("t-live", "other-project-session");
    const seen = new Set<string>();
    for (const id of roster) seen.add(id); // roster ids are seen this pass
    const kept = restored.filter((id) =>
      decideRestoredTerminalPane(id, roster, seen, true) !== "prune",
    );
    expect(kept).toEqual(["t-live"]);
  });
});

// ── Parcheggio per inattività: dormiente ≠ morta ────────────────────────────
//
// Il caso che rompeva il parcheggio prima che questo parametro esistesse: una
// sessione parcheggiata esce dalla mappa in memoria del server (la sua PTY
// muore) ma la riga resta `dormant` e riparte con --resume. Per la regola
// "vista e poi sparita" è identica a una chiusa altrove: veniva potata, e il
// layout persisteva la potatura. Cioè il parcheggio si mangiava le tab che
// stava parcheggiando.
describe("decideRestoredTerminalPane — sessioni parcheggiate", () => {
  test("una sessione VISTA e poi parcheggiata si tiene (non è un cadavere)", () => {
    const roster = set("altra");        // la parcheggiata non c'è più nel roster
    const seen = set("s1", "altra");    // ma era stata vista in questa sessione
    // Senza l'informazione "è dormiente": si va a chiedere, e intanto si tiene.
    expect(decideRestoredTerminalPane("s1", roster, seen, true)).toBe("verify");
    // Con: tenuta subito. La pane la rianimerà quando diventa attiva.
    expect(decideRestoredTerminalPane("s1", roster, seen, true, set("s1"))).toBe("keep");
  });

  test("una sessione MAI vista ma dormiente si tiene, anche con roster autorevole", () => {
    // Riavvio dell'app: la tab arriva dal layout salvato, il roster è popolato
    // e non la elenca — ma la riga dormiente esiste, quindi è ripristinabile.
    expect(decideRestoredTerminalPane("s1", set("altra"), new Set(), true, set("s1"))).toBe("keep");
  });

  test("un cadavere vero resta un cadavere: nessuna lettura fresca lo elenca", () => {
    expect(
      decideRestoredTerminalPane("morta", set("viva"), set("morta", "viva"), true, set("parcheggiata"), set("morta")),
    ).toBe("prune");
  });

  test("il roster batte tutto: una sessione viva si tiene comunque", () => {
    expect(decideRestoredTerminalPane("s1", set("s1"), set("s1"), true, set("s1"))).toBe("keep");
  });

  test("essere parcheggiata batte l'essere stata confermata sparita", () => {
    // It does not happen on its own, but it pins the order: the fresh read that
    // lists it parked is the most recent one, and it beats an earlier verdict.
    expect(
      decideRestoredTerminalPane("s1", set("altra"), set("s1"), true, set("s1"), set("s1")),
    ).toBe("keep");
  });
});

/**
 * THE PARKED LIST GOES STALE THE INSTANT YOU READ IT.
 *
 * `useProjectTerminalSync` read it once, at mount. Then the user types `/exit`
 * in a live claude tab: the server drops the session from its in-memory map,
 * marks the row `dormant` and rebroadcasts a roster built from that map alone.
 * To a set read ten minutes earlier that id is "seen and then gone", i.e. a
 * corpse - and the prune is destructive (`prev.filter`), with the layout saved
 * right after with no debounce.
 *
 * Hence the verdict is no longer binary: a disappearance on its own proves
 * nothing, and whoever decides must be able to say "I do not know yet".
 */
test('una sessione uscita ADESSO non è un cadavere: prima si richiede', () => {
  const roster = new Set(['live-1']);       // after the exit: A is gone
  const seen = new Set(['live-1', 'A']);    // but A was alive a moment ago
  const dormantAtMount = new Set<string>(); // read before A exited

  expect(decideRestoredTerminalPane('A', roster, seen, true, dormantAtMount)).toBe('verify');
  // The fresh read says parked, so the tab stays, overlay and all.
  expect(decideRestoredTerminalPane('A', roster, seen, true, new Set(['A']))).toBe('keep');
});
