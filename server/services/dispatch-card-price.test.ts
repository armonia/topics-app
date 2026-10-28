/**
 * THE PRICE OF A CARD IS THE BOARD'S: what its settings make it run.
 *
 * A board that works in place and runs no local check prices its cards at the
 * agent alone; everything else keeps the price list of recent check peaks,
 * which is its floor (4 GB) while no check has run. The reservation the floor
 * line adds for the turns in flight is priced per board too, each turn at the
 * price of ITS board.
 *
 * @covers KANBAN-75
 */
import { describe, it, expect } from "bun:test";
import { GATES_CI_CHECK, E2E_CI_CHECK, type ReviewCheck } from "../../shared/board";
import { cardWeightOf, createCardPrices, type CardPriceBoard, type CardPriceTask } from "./dispatch-card-price";
import { CLI_AGENT_PEAK_GB, NATIVE_NO_LOCAL_CHECK_RESERVATION_GB } from "./dispatch-capacity";

const LOCAL_CHECK: ReviewCheck = { name: "unit", cmd: "bun test" };
const IN_PLACE_NO_CHECK: CardPriceBoard = { dispatchUseWorktree: false, reviewChecks: [] };

describe("cardWeightOf: la classe di una card la decide la sua board", () => {
  it("in place e nessun check locale: leggera", () => {
    expect(cardWeightOf(IN_PLACE_NO_CHECK)).toBe("light");
  });

  it("le prove della CI di GitHub non sono check locali: leggera", () => {
    expect(cardWeightOf({ dispatchUseWorktree: false, reviewChecks: [GATES_CI_CHECK, E2E_CI_CHECK] })).toBe("light");
  });

  it("una worktree consegna un ramo passando dai cancelli del repo: standard", () => {
    expect(cardWeightOf({ dispatchUseWorktree: true, reviewChecks: [] })).toBe("standard");
  });

  it("un check locale gira su questa macchina: standard, anche in place", () => {
    expect(cardWeightOf({ dispatchUseWorktree: false, reviewChecks: [LOCAL_CHECK] })).toBe("standard");
    expect(cardWeightOf({ dispatchUseWorktree: false, reviewChecks: [GATES_CI_CHECK, LOCAL_CHECK] })).toBe("standard");
  });

  it("una card segnata pesante è standard, su qualunque board: si prende la macchina da sola", () => {
    expect(cardWeightOf(IN_PLACE_NO_CHECK, "heavy")).toBe("standard");
    expect(cardWeightOf(IN_PLACE_NO_CHECK, "light")).toBe("light");
    expect(cardWeightOf(IN_PLACE_NO_CHECK, null)).toBe("light");
  });

  it("una board che non si conosce si prezza al costo pieno", () => {
    expect(cardWeightOf(null)).toBe("standard");
    expect(cardWeightOf(undefined)).toBe("standard");
  });
});

function prices(o: {
  boards?: Record<string, CardPriceBoard>;
  tasks?: Record<string, CardPriceTask>;
  peaks?: number[];
  cli?: boolean;
  measured?: Record<string, number>;
} = {}) {
  const boards: Record<string, CardPriceBoard> = o.boards ?? { quiet: IN_PLACE_NO_CHECK, repo: { dispatchUseWorktree: true, reviewChecks: [] } };
  return createCardPrices({
    peaks: () => o.peaks ?? [],
    isCliRuntime: () => o.cli ?? false,
    board: (projectId) => boards[projectId],
    taskOf: (taskId) => o.tasks?.[taskId],
    measured: (projectId) => o.measured?.[projectId] ?? null,
  });
}

describe("priceFor: quanto pesa una card in più", () => {
  it("una board leggera paga l'agente e i suoi comandi, il resto il listino", () => {
    const p = prices();
    expect(p.priceFor("quiet")).toBe(NATIVE_NO_LOCAL_CHECK_RESERVATION_GB);
    // An empty list of check peaks reads as the floor of the price list.
    expect(p.priceFor("repo")).toBe(4);
  });

  it("il listino vale per le board standard e lo muovono i picchi misurati", () => {
    expect(prices({ peaks: [4.5, 4.5, 4.5] }).priceFor("repo")).toBe(4.5);
    // The ceiling stops one outlier from pricing the machine out.
    expect(prices({ peaks: [11, 11, 11] }).priceFor("repo")).toBe(6);
    // The light price does not follow the list.
    expect(prices({ peaks: [4.5, 4.5, 4.5] }).priceFor("quiet")).toBe(NATIVE_NO_LOCAL_CHECK_RESERVATION_GB);
  });

  it("una card pesante paga il listino anche su una board leggera", () => {
    const p = prices();
    expect(p.priceFor("quiet", "heavy")).toBe(4);
    expect(p.priceFor("quiet", null)).toBe(NATIVE_NO_LOCAL_CHECK_RESERVATION_GB);
  });

  it("con un agente CLI la card leggera pesa il picco del processo, non il nativo", () => {
    expect(prices({ cli: true }).priceFor("quiet")).toBe(CLI_AGENT_PEAK_GB);
  });

  it("nessuna board in mano, o una lettura che salta: il prezzo caro", () => {
    const p = prices();
    expect(p.priceFor(undefined)).toBe(4);
    expect(p.priceFor(null)).toBe(4);
    expect(p.priceFor("sconosciuta")).toBe(4);
    const broken = createCardPrices({
      peaks: () => [], isCliRuntime: () => false,
      board: () => { throw new Error("db chiuso"); },
      taskOf: () => ({ projectId: "quiet" }),
    });
    expect(broken.priceFor("quiet")).toBe(4);
    const noPeaks = createCardPrices({
      peaks: () => { throw new Error("registro illeggibile"); }, isCliRuntime: () => false,
      board: () => ({ dispatchUseWorktree: true, reviewChecks: [] }),
      taskOf: () => undefined,
    });
    expect(noPeaks.priceFor("repo")).toBe(4);
  });
});

describe("priceFor: il peso misurato della board vince sulle costanti", () => {
  it("una board misurata paga quello che hanno pesato le sue card, leggera o standard", () => {
    const p = prices({ measured: { quiet: 0.5, repo: 0.6 } });
    expect(p.priceFor("quiet")).toBe(0.5);
    expect(p.priceFor("repo")).toBe(0.6);
  });

  it("una card pesante paga il listino anche su una board misurata", () => {
    expect(prices({ measured: { quiet: 0.5, repo: 0.6 } }).priceFor("repo", "heavy")).toBe(4);
  });

  it("finché la board non ha misure, o la misura salta, vale il prezzo della sua classe", () => {
    expect(prices({ measured: { quiet: 0.5 } }).priceFor("repo")).toBe(4);
    const broken = createCardPrices({
      peaks: () => [], isCliRuntime: () => false,
      board: () => ({ dispatchUseWorktree: false, reviewChecks: [] }),
      taskOf: () => undefined,
      measured: () => { throw new Error("misura illeggibile"); },
    });
    expect(broken.priceFor("quiet")).toBe(NATIVE_NO_LOCAL_CHECK_RESERVATION_GB);
  });

  it("la prenotazione dei turni in volo usa lo stesso peso misurato", () => {
    const p = prices({ measured: { repo: 0.5 }, tasks: { t1: { projectId: "repo" } } });
    expect(p.reservedMemGB([["t1", 1_000_000]], 1_000_000)).toBeCloseTo(0.5, 6);
  });
});

describe("reservedMemGB: ogni turno in volo a prezzo della sua board", () => {
  const NOW = 1_000_000;
  /** The whole-life reservation: an instant earlier than any ramp. */
  const AT = NOW - 60_000;

  it("due turni leggeri e uno standard si sommano ciascuno al suo prezzo", () => {
    const p = prices({ tasks: { a: { projectId: "quiet" }, b: { projectId: "quiet" }, c: { projectId: "repo" } } });
    const reserved = p.reservedMemGB([["a", AT], ["b", AT], ["c", AT]], NOW);
    expect(reserved).toBeCloseTo(2 * NATIVE_NO_LOCAL_CHECK_RESERVATION_GB + 4, 6);
  });

  it("un turno leggero diventato pesante a metà volo si prenota al listino", () => {
    const p = prices({ tasks: { a: { projectId: "quiet", dispatchWeight: "heavy" }, b: { projectId: "quiet" } } });
    expect(p.reservedMemGB([["a", AT], ["b", AT]], NOW)).toBeCloseTo(4 + NATIVE_NO_LOCAL_CHECK_RESERVATION_GB, 6);
  });

  it("un turno la cui board non si legge più costa il prezzo caro", () => {
    const p = prices({ tasks: {} });
    expect(p.reservedMemGB([["orfano", AT]], NOW)).toBeCloseTo(4, 6);
  });

  it("nessun turno, nessuna prenotazione", () => {
    expect(prices().reservedMemGB([], NOW)).toBe(0);
  });
});
