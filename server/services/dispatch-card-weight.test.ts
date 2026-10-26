/**
 * THE MEASURED WEIGHT OF A CARD (`dispatch-card-weight.ts`).
 *
 *  1. the server tree with no local turn is the baseline, and a turn weighs
 *     what the tree grew over it, split across the turns in flight;
 *  2. a card keeps its highest reading, and its check peak when that is higher;
 *  3. a board prices from its measured cards only from the third one, over 72
 *     hours, and the price never goes under one CLI agent's peak;
 *  4. a turn never read, an unknown baseline or a broken reading is no vote.
 */
import { describe, it, expect } from "bun:test";
import {
  MEASURED_WEIGHT_FLOOR_GB, MEASURED_WEIGHT_KEPT, MEASURED_WEIGHT_MIN_CARDS, MEASURED_WEIGHT_WINDOW_MS,
  createCardWeightMeter,
} from "./dispatch-card-weight";
import { AGENT_COST_CEILING_MEM_GB } from "../../shared/board";

const B = "attilio";

function meter(checks: Record<string, number> = {}) {
  const clock = { t: Date.UTC(2026, 9, 27, 9, 0, 0) };
  const m = createCardWeightMeter({ now: () => clock.t, checkPeakGB: (id) => checks[id] ?? null });
  /** One card of `board` whose turn reads `tree` GB once, alone, then ends. */
  const card = (id: string, tree: number, board = B) => {
    m.sample(tree, [{ taskId: id, projectId: board }]);
    m.finish(id);
    clock.t += 60_000;
  };
  return { m, clock, card };
}

describe("il peso di una card è quanto l'albero del server cresce sopra la base", () => {
  it("tre card da mezzo giga sopra una base di 0,8 prezzano la board a 0,5", () => {
    const { m, card } = meter();
    m.sample(0.8, []);
    card("a", 1.3); card("b", 1.3);
    expect(m.measuredGB(B)).toBeNull(); // two cards are not a price yet
    card("c", 1.3);
    expect(m.measuredGB(B)).toBeCloseTo(0.5, 6);
  });

  it("due turni in volo si dividono la crescita", () => {
    const { m, clock } = meter();
    m.sample(1, []);
    for (const pair of [["a", "b"], ["c", "d"]]) {
      m.sample(2.2, pair.map((taskId) => ({ taskId, projectId: B })));
      pair.forEach((id) => m.finish(id));
      clock.t += 60_000;
    }
    expect(m.measuredGB(B)).toBeCloseTo(0.6, 6);
  });

  it("la card tiene la lettura più alta della sua vita", () => {
    const { m } = meter();
    m.sample(1, []);
    for (const id of ["a", "b", "c"]) {
      for (const tree of [1.2, 1.6, 1.3]) m.sample(tree, [{ taskId: id, projectId: B }]);
      m.finish(id);
    }
    expect(m.measuredGB(B)).toBeCloseTo(0.6, 6);
  });

  it("il picco dei check vale quando è più alto dell'albero, anche se arriva dopo il turno", () => {
    const checks: Record<string, number> = {};
    const { m, card } = meter(checks);
    m.sample(1, []);
    card("a", 1.5); card("b", 1.5); card("c", 1.5);
    expect(m.measuredGB(B)).toBeCloseTo(0.5, 6);
    checks.a = 4.3; checks.b = 4.3; // the checks ran after the turns ended
    expect(m.measuredGB(B)).toBeCloseTo(4.3, 6);
  });

  it("il prezzo misurato non scende sotto il picco di un agente CLI e non supera il soffitto del listino", () => {
    const { m, card } = meter();
    m.sample(1, []);
    card("a", 1.01); card("b", 1.01); card("c", 1.01);
    expect(m.measuredGB(B)).toBe(MEASURED_WEIGHT_FLOOR_GB);
    card("d", 20, "heavy-board"); card("e", 20, "heavy-board"); card("f", 20, "heavy-board");
    expect(m.measuredGB("heavy-board")).toBe(AGENT_COST_CEILING_MEM_GB);
  });
});

describe("cosa non è un voto", () => {
  it("senza una base non si misura niente: la prima lettura con un turno in volo non sa cosa sottrarre", () => {
    const { m, card } = meter();
    card("a", 1.5); card("b", 1.5); card("c", 1.5);
    expect(m.measuredGB(B)).toBeNull();
  });

  it("una lettura assente o rotta non tocca né la base né le card", () => {
    const { m, card } = meter();
    m.sample(null, []);
    m.sample(Number.NaN, []);
    m.sample(0, []);
    card("a", 1.5);
    m.sample(1, []);
    m.sample(null, [{ taskId: "b", projectId: B }]);
    m.finish("b");
    card("c", 1.5); card("d", 1.5);
    expect(m.measuredGB(B)).toBeNull(); // only c and d voted
    card("e", 1.5);
    expect(m.measuredGB(B)).toBeCloseTo(0.5, 6);
  });

  it("le card di una board non votano sul prezzo di un'altra", () => {
    const { m, card } = meter();
    m.sample(1, []);
    card("a", 1.5, "altra"); card("b", 1.5, "altra"); card("c", 1.5, "altra");
    expect(m.measuredGB("altra")).toBeCloseTo(0.5, 6);
    expect(m.measuredGB(B)).toBeNull();
    expect(m.measuredGB(null)).toBeNull();
  });

  it("oltre 72 ore una card non vota più, e la board torna al suo prezzo", () => {
    const { m, clock, card } = meter();
    m.sample(1, []);
    card("a", 1.5); card("b", 1.5); card("c", 1.5);
    expect(m.measuredGB(B)).not.toBeNull();
    clock.t += MEASURED_WEIGHT_WINDOW_MS;
    expect(m.measuredGB(B)).toBeNull();
  });

  it("la board tiene le ultime card: il lavoro che cambia si vede", () => {
    const { m, card } = meter();
    m.sample(1, []);
    for (let i = 0; i < MEASURED_WEIGHT_KEPT; i++) card(`old${i}`, 3);
    expect(m.measuredGB(B)).toBeCloseTo(2, 6);
    for (let i = 0; i < Math.ceil(MEASURED_WEIGHT_KEPT / 2); i++) card(`new${i}`, 1.5);
    expect(m.measuredGB(B)).toBeCloseTo(0.5, 6);
    expect(MEASURED_WEIGHT_MIN_CARDS).toBe(3);
  });
});
