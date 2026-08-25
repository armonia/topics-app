/**
 * @covers SHARD-01
 */
import { describe, test, expect } from "bun:test";
import { planShards } from "./e2e-plan-shards";

/**
 * Il pacchettamento degli shard per DURATA.
 *
 * Ciò che deve reggere è una cosa sola: il wall-clock di una suite parallela è
 * il suo shard PIÙ LENTO. Quindi ogni proprietà qui sotto guarda il massimo, non
 * la media — una divisione che fa 10/10/10/220 è "in media" perfetta e in
 * pratica inutile, ed è esattamente ciò che faceva `--shard=i/N` di Playwright
 * (che riparte per numero di test, non conoscendo le durate: 193s, 326s, 186s,
 * 209s misurati il 30/07).
 */

const dur = (entries: Array<[string, number]>) => Object.fromEntries(entries);

describe("planShards", () => {
  test("nessun file va perso e nessuno viene eseguito due volte", () => {
    const files = Array.from({ length: 37 }, (_, i) => `f${i}.spec.ts`);
    const durations = dur(files.map((f, i) => [f, (i % 9) + 1] as [string, number]));

    const buckets = planShards(files, durations, 5);
    const placed = buckets.flatMap((b) => b.files);

    expect(placed.slice().sort()).toEqual(files.slice().sort());
    expect(new Set(placed).size).toBe(files.length);
  });

  test("il file più lento non finisce mai insieme al secondo più lento, se c'è posto", () => {
    // È il caso che rendeva la run del 30/07 lunga 326s: due file grossi nello
    // stesso secchio mentre un altro secchio prendeva solo briciole.
    const durations = dur([
      ["heavy-a.spec.ts", 100],
      ["heavy-b.spec.ts", 95],
      ["light-1.spec.ts", 2],
      ["light-2.spec.ts", 2],
    ]);
    const buckets = planShards(Object.keys(durations), durations, 2);

    const together = buckets.some(
      (b) => b.files.includes("heavy-a.spec.ts") && b.files.includes("heavy-b.spec.ts"),
    );
    expect(together, "i due file pesanti sono finiti nello stesso shard").toBe(false);
  });

  test("lo shard più lento resta entro 4/3 dell'ideale (garanzia di LPT)", () => {
    const files = Array.from({ length: 60 }, (_, i) => `f${i}.spec.ts`);
    // Distribuzione realistica: pochi file lunghi, una coda di file corti.
    const durations = dur(
      files.map((f, i) => [f, i < 4 ? 60 - i * 5 : 1 + (i % 4)] as [string, number]),
    );

    for (const shards of [2, 4, 8]) {
      const buckets = planShards(files, durations, shards);
      const total = buckets.reduce((a, b) => a + b.seconds, 0);
      const ideal = total / shards;
      const slowest = Math.max(...buckets.map((b) => b.seconds));
      // Il vincolo vero non è (4/3)·ideale ma max(ideale, file più lungo): un
      // singolo file non si spezza, ed è il pavimento sotto cui nessuna
      // divisione può scendere.
      const floor = Math.max(ideal, Math.max(...Object.values(durations)));
      expect(slowest, `${shards} shard: ${slowest}s contro un pavimento di ${floor}s`).toBeLessThanOrEqual(
        floor * (4 / 3),
      );
    }
  });

  test("un file mai misurato prende la mediana, non zero", () => {
    // Con zero, tutti i file nuovi si ammucchierebbero nello stesso secchio: per
    // il pacchettamento sarebbero gratis, e il primo che li esegue scoprirebbe
    // che non lo erano.
    const durations = dur([
      ["a.spec.ts", 10],
      ["b.spec.ts", 10],
      ["c.spec.ts", 10],
    ]);
    const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "nuovo-1.spec.ts", "nuovo-2.spec.ts"];

    const buckets = planShards(files, durations, 2);
    const withNew = buckets.filter((b) => b.files.some((f) => f.startsWith("nuovo-")));

    expect(withNew.length, "i file nuovi sono finiti tutti nello stesso shard").toBe(2);
  });

  test("senza NESSUNA misura la divisione resta uniforme per numero di file", () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.spec.ts`);
    const buckets = planShards(files, {}, 4);
    expect(buckets.map((b) => b.files.length)).toEqual([3, 3, 3, 3]);
  });

  test("un solo shard riceve tutto", () => {
    const files = ["a.spec.ts", "b.spec.ts"];
    const buckets = planShards(files, dur([["a.spec.ts", 5], ["b.spec.ts", 1]]), 1);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].files.slice().sort()).toEqual(files);
    expect(buckets[0].seconds).toBe(6);
  });
});
