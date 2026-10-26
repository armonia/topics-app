import { describe, it, expect } from "bun:test";
import { admittedCards, parseMemsig, replay } from "./card-weight-replay";

/** A `[memsig]` line as the server prints it, behind a log prefix. */
const line = (iso: string, held: string, inFlight = 0) =>
  `[server] ${iso} [memsig] avail=${held} held2m=${held} cover=120s swapin/s=0.0 inFlight=${inFlight} checkRuns=0 altri=-`;

describe("card-weight-replay", () => {
  it("legge held2m, l'istante e le card in volo, e salta le righe senza misura", () => {
    const got = parseMemsig([
      line("2026-10-26T10:00:00.000Z", "8.0", 1),
      line("2026-10-26T10:01:00.000Z", "?"),
      "un'altra riga del log",
    ].join("\n"));
    expect(got).toEqual([{ at: Date.parse("2026-10-26T10:00:00.000Z"), heldGB: 8, availGB: 8, inFlight: 1 }]);
  });

  it("chiede al pavimento vero: a 8 GB il listino ammette una card, 1 GB due, mezzo giga quattro", () => {
    expect(admittedCards(8, 4)).toBe(1);   // 6 + 4 + 4 = 14 for the second
    expect(admittedCards(8, 1)).toBe(2);   // 6 + 1 + 1 = 8
    expect(admittedCards(8, 0.5)).toBe(4); // 6 + 0.5 + 1.5 = 8
    expect(admittedCards(4, 0.5)).toBe(1); // under the floor only the first one goes
    expect(admittedCards(30, 0.5, { max: 3 })).toBe(3);
    expect(admittedCards(13, 0.5, { cli: true })).toBe(2); // CLI floor, 12 GB
  });

  it("la media è sulle ultime N ore, contate dalla riga più nuova", () => {
    const samples = parseMemsig([
      line("2026-10-23T09:00:00.000Z", "30"), // outside the 72 hours
      line("2026-10-26T10:00:00.000Z", "8.0"),
      line("2026-10-26T10:01:00.000Z", "6.5"),
    ].join("\n"));
    const [list, measured] = replay(samples, [4, 0.5]);
    expect(list).toMatchObject({ priceGB: 4, samples: 2, mean: 1, atLeastTwo: 0 });
    expect(measured).toMatchObject({ priceGB: 0.5, samples: 2, mean: 2.5, atLeastTwo: 0.5 }); // 4 and 1
  });

  it("--add-back rende a ogni card in volo il suo peso prima di decidere", () => {
    const samples = parseMemsig(line("2026-10-26T10:00:00.000Z", "6.5", 2));
    expect(replay(samples, [0.5])[0]!.mean).toBe(1);                   // 6.5 < 6 + 0.5 + 0.5
    expect(replay(samples, [0.5], { addBackGB: 0.5 })[0]!.mean).toBe(3); // 7.5: lines 7 and 7.5 pass, 8 does not
  });
});
