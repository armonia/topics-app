/**
 * The unit suite split into shards: balanced by measured duration, covering the
 * same roots as the serial `test:unit`, with a verdict that is the aggregate of
 * every shard. See `test-unit-shards.ts` for the measurements.
 *
 * @covers GATE-12
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  SUITE_ROOTS,
  SERIAL_GLOBS,
  enumerateTestFiles,
  partitionTiers,
  planShards,
  parseJunitDurations,
  aggregateVerdict,
} from "./test-unit-shards.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("planShards (LPT)", () => {
  test("mette il file più lento nel secchio più leggero e bilancia", () => {
    const files = ["a", "b", "c", "d"];
    const durations = { a: 10, b: 7, c: 2, d: 1 };
    const buckets = planShards(files, durations, 2);
    // LPT: a(10)->s0, b(7)->s1, c(2)->s1(=9), d(1)->s0(=11)... or the mirror image.
    const totals = buckets.map((x) => x.seconds).sort((x, y) => x - y);
    // Smallest gap: 10+1=11 vs 7+2=9 -> max 11. It does not pile everything into one.
    expect(Math.max(...totals)).toBeLessThan(20 * 0.75);
    // every file shows up exactly once, overall
    const all = buckets.flatMap((b) => b.files).sort();
    expect(all).toEqual([...files].sort());
  });

  test("un file senza durata nota prende la mediana, non zero", () => {
    const files = ["known1", "known2", "known3", "novo"];
    const durations = { known1: 4, known2: 6, known3: 8 };
    const buckets = planShards(files, durations, 1);
    // un solo secchio: somma = 4+6+8 + mediana(6) = 24
    expect(buckets[0].seconds).toBe(24);
  });

  test("copre tutti i file anche con più secchi che file", () => {
    const files = ["a", "b"];
    const buckets = planShards(files, {}, 5);
    const all = buckets.flatMap((b) => b.files).sort();
    expect(all).toEqual(["a", "b"]);
  });

  test("nessun file perso né duplicato su input grande", () => {
    const files = Array.from({ length: 200 }, (_, i) => `f${i}`);
    const durations = Object.fromEntries(files.map((f, i) => [f, (i % 13) + 0.1]));
    const buckets = planShards(files, durations, 6);
    const all = buckets.flatMap((b) => b.files);
    expect(new Set(all).size).toBe(200);
    expect(all.length).toBe(200);
  });
});

describe("parseJunitDurations", () => {
  test("somma il time dei testcase per file, attributi in qualunque ordine", () => {
    const xml = `<?xml version="1.0"?>
      <testsuites>
        <testsuite file="a.test.ts" time="0">
          <testcase name="x" time="0.5" file="a.test.ts" line="1" />
          <testcase name="y" time="1.5" file="a.test.ts" line="2" />
        </testsuite>
        <testsuite name="b" file="b.test.ts" time="0">
          <testcase file="b.test.ts" time="2" name="z" />
        </testsuite>
      </testsuites>`;
    const d = parseJunitDurations(xml);
    expect(d["a.test.ts"]).toBeCloseTo(2.0, 5);
    expect(d["b.test.ts"]).toBeCloseTo(2.0, 5);
  });

  test("ignora testcase senza file o senza time valido", () => {
    const xml = `<testcase name="x" time="1" />
      <testcase name="y" file="c.test.ts" />
      <testcase name="z" file="c.test.ts" time="3" />`;
    const d = parseJunitDurations(xml);
    expect(d["c.test.ts"]).toBe(3);
    expect(Object.keys(d)).toEqual(["c.test.ts"]);
  });

  test("xml vuoto → nessuna durata", () => {
    expect(parseJunitDurations("")).toEqual({});
  });
});

describe("aggregateVerdict", () => {
  test("tutti 0 → 0", () => {
    expect(aggregateVerdict([0, 0, 0])).toBe(0);
  });
  test("un rosso → il primo codice non-zero", () => {
    expect(aggregateVerdict([0, 1, 0])).toBe(1);
    expect(aggregateVerdict([0, 0, 3])).toBe(3);
  });
  test("nessuno shard → 0", () => {
    expect(aggregateVerdict([])).toBe(0);
  });
});

describe("enumerateTestFiles (parità con bun test)", () => {
  test("trova i file di test reali e sono tutti *.test.ts(x) sotto le radici", () => {
    const files = enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
    expect(files.length).toBeGreaterThan(500);
    expect(files.every((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))).toBe(true);
    expect(files.every((f) => SUITE_ROOTS.some((r) => f.startsWith(r + "/")))).toBe(true);
    // includes itself (scripts/ is a root) and holds no duplicate
    expect(files).toContain("scripts/test-unit-shards.test.ts");
    expect(new Set(files).size).toBe(files.length);
  });

  test("SUITE_ROOTS coincide con le radici di `test:unit` in package.json", () => {
    // The sharded gate (`test:unit:shards`) and the serial one (`test:unit`,
    // authoritative in CI) must cover THE SAME files: a root added to only one
    // of the two makes the pre-review more permissive than CI without anybody
    // noticing. The serial roots are the `./x` tokens of the script.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
    const script: string = pkg.scripts["test:unit"];
    const serialRoots = [...script.matchAll(/\.\/([\w./-]+?)\/?(?=[\s'])/g)].map((m) => m[1]);
    expect(serialRoots.length).toBeGreaterThan(0);
    expect([...serialRoots].sort()).toEqual([...SUITE_ROOTS].sort());
  });

  test("ogni voce di SERIAL_GLOBS corrisponde a un file reale", () => {
    // Un racer rinominato uscirebbe in silenzio dalla fase seriale e finirebbe
    // in uno shard concorrente, dove le sue asserzioni di tempistica cedono.
    const files = enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
    const { serial } = partitionTiers(files);
    for (const glob of SERIAL_GLOBS) {
      const hit = serial.some((f) => f === glob || f.startsWith(glob.replace(/\*\*$/, "")));
      expect(hit, `SERIAL_GLOBS: «${glob}» non corrisponde a nessun file`).toBe(true);
    }
  });
});
