#!/usr/bin/env bun
/**
 * card-weight-replay - how many local cards the memory line would have let in,
 * minute by minute, if a card weighed N GB. The replay of the measured weight
 * (`server/services/dispatch-card-weight.ts`) over the last 72 real hours.
 *
 * WHERE THE NUMBERS COME FROM. The `[memsig]` lines of the server log, one a
 * minute even with the queue stopped (`formatMemorySignalLine`): `held2m` is the
 * lowest reading of the last two minutes, the one the floor decides on. For
 * each line the REAL floor is asked (`dispatchResourceVerdict`, not a copy of
 * its formula) whether a card starts, then another with the first one reserved
 * at its price, and so on until the first no or `--max`. The first card with
 * nothing of ours in flight always goes (the first-card exemption), so the
 * mean never drops under 1.
 *
 * WHAT IT DOES NOT KNOW. A line's reading already carries the cards that were
 * in flight that minute (`inFlight=`). The replay does not subtract them: it
 * decides on a machine that still carries them, which errs low. `--add-back=GB`
 * gives that weight back to each card in flight, for the estimate from the
 * other side. The disk is left out: this measures memory.
 *
 * USAGE
 *   bun scripts/card-weight-replay.ts <log...> [--price=0.5] [--price=4]
 *       [--hours=72] [--cli] [--max=9] [--add-back=0] [--min-mean=2.0]
 *
 * Each `--price` is a column (default: the list price 4, the native light card
 * 1, the measured 0.5). `--min-mean` is the gate: exit 1 when the mean of the
 * FIRST column is under it. Exit 2 when no readable line is in the window.
 */
import { readFileSync } from "node:fs";
import { dispatchResourceVerdict } from "../server/services/dispatch-capacity";

export interface MemorySignalSample { at: number; heldGB: number; availGB: number | null; inFlight: number }

/** The `[memsig]` lines of a log, in order; lines without a measured `held2m` are skipped. */
export function parseMemorySignal(text: string): MemorySignalSample[] {
  const out: MemorySignalSample[] = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf("[memsig]");
    if (i < 0) continue;
    const at = Date.parse(line.slice(0, i).trim().split(/\s+/).pop() ?? "");
    const held = /\bheld2m=([0-9.]+)/.exec(line);
    if (!Number.isFinite(at) || !held) continue;
    const avail = /\bavail=([0-9.]+)/.exec(line);
    const inFlight = /\binFlight=(\d+)/.exec(line);
    out.push({ at, heldGB: Number(held[1]), availGB: avail ? Number(avail[1]) : null, inFlight: inFlight ? Number(inFlight[1]) : 0 });
  }
  return out;
}

/** How many cards the floor admits on one reading, each priced `priceGB`, the next one charged for the ones before. */
export function admittedCards(heldGB: number, priceGB: number, o: { cli?: boolean; max?: number } = {}): number {
  const max = o.max ?? 9;
  let n = 0;
  while (n < max) {
    const verdict = dispatchResourceVerdict(
      "/", () => null,
      () => ({ measurable: true, latestGB: heldGB, heldGB, coveredMs: 120_000 }),
      o.cli === true,
      { cardGB: priceGB, reservedGB: n * priceGB, reservedCards: n, spendingHere: n > 0, ourWorkRunning: n > 0 },
    );
    if (verdict.reason) break;
    n++;
  }
  return n;
}

export interface ReplayRow { priceGB: number; samples: number; mean: number; atLeastTwo: number }

/** The replay over the last `hours` of the samples (counted back from the newest one). */
export function replay(samples: readonly MemorySignalSample[], prices: readonly number[], o: {
  hours?: number; cli?: boolean; max?: number; addBackGB?: number;
} = {}): ReplayRow[] {
  const newest = samples.reduce((m, s) => Math.max(m, s.at), -Infinity);
  const since = newest - (o.hours ?? 72) * 3_600_000;
  const window = samples.filter((s) => s.at >= since);
  return prices.map((priceGB) => {
    const counts = window.map((s) => admittedCards(s.heldGB + s.inFlight * (o.addBackGB ?? 0), priceGB, o));
    const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    return { priceGB, samples: counts.length, mean, atLeastTwo: counts.length ? counts.filter((c) => c >= 2).length / counts.length : 0 };
  });
}

function main(argv: string[]): number {
  const flag = (name: string) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const num = (name: string, fallback: number) => { const v = flag(name).at(-1); return v === undefined ? fallback : Number(v); };
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("uso: bun scripts/card-weight-replay.ts <log...> [--price=GB]... [--hours=72] [--cli] [--max=9] [--add-back=GB] [--min-mean=N]");
    return 2;
  }
  const samples = parseMemorySignal(files.map((f) => readFileSync(f, "utf8")).join("\n")).sort((a, b) => a.at - b.at);
  const prices = flag("price").map(Number);
  const rows = replay(samples, prices.length ? prices : [4, 1, 0.5], {
    hours: num("hours", 72), cli: argv.includes("--cli"), max: num("max", 9), addBackGB: num("add-back", 0),
  });
  if (!rows[0] || rows[0].samples === 0) { console.error("nessuna riga [memsig] con held2m nella finestra"); return 2; }
  for (const r of rows) {
    console.log(`card da ${r.priceGB.toFixed(2)} GB: ${r.samples} minuti, media ${r.mean.toFixed(2)} card, almeno due il ${(r.atLeastTwo * 100).toFixed(1)}%`);
  }
  const minMean = flag("min-mean").at(-1);
  if (minMean !== undefined && rows[0].mean < Number(minMean)) {
    console.error(`media ${rows[0].mean.toFixed(2)} sotto ${minMean} con la card da ${rows[0].priceGB} GB`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
