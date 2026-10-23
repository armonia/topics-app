/**
 * Unit tests for the one-process-per-file runner: load plan, ordering
 * (longest-first and seeded shuffle), red-test extraction and the per-file
 * environment. Pure function tests only; the CLI behaviour with a fake `bun`
 * lives in `test-unit-shards.cli.test.ts`.
 *
 * @covers GATE-12
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import {
  SUITE_ROOTS,
  SERIAL_GLOBS,
  enumerateTestFiles,
  partitionTiers,
  orderByDuration,
  shuffleSeeded,
  shuffleSeedOf,
  redTestNames,
  fileEnv,
  planUnderLoad,
  defaultShards,
  aggregateVerdict,
  snapshotEntries,
  newEntries,
} from "./test-unit-shards.ts";

describe("planUnderLoad", () => {
  test("a quiet machine keeps the plan as it is", () => {
    const p = planUnderLoad({ load: 6, cores: 12, shards: 4, timeoutMs: 30000 });
    expect(p).toEqual({ shards: 4, timeoutMs: 30000, pressure: 0.5, slowdown: 1, note: null });
  });

  test("halving the shards is declared as a 2x slowdown, so an outside cap can follow it", () => {
    const p = planUnderLoad({ load: 24, cores: 12, shards: 4, timeoutMs: 30000 });
    expect(p.shards).toBe(2);
    expect(p.slowdown).toBe(2);
  });

  test("an explicit shard count changes nothing, so it declares no slowdown", () => {
    const p = planUnderLoad({ load: 46, cores: 12, shards: 4, timeoutMs: 30000, shardsExplicit: true });
    expect(p.shards).toBe(4);
    expect(p.slowdown).toBe(1);
  });

  test("load 46 on 12 cores: the default two workers become one with the serial timeout", () => {
    const p = planUnderLoad({ load: 46, cores: 12, shards: 2, timeoutMs: 30000 });
    expect(p.shards).toBe(1);
    expect(p.timeoutMs).toBe(30000);
    expect(p.slowdown).toBe(2);
    expect(p.note).toContain("46.0 su 12 core");
  });

  test("the timeout never grows, whatever the load", () => {
    const p = planUnderLoad({ load: 120, cores: 12, shards: 4, timeoutMs: 30000 });
    expect(p.timeoutMs).toBe(30000);
    expect(p.shards).toBe(1);
  });

  test("moderate pressure: the shards shrink in proportion, the timeout is unchanged", () => {
    const p = planUnderLoad({ load: 24, cores: 12, shards: 4, timeoutMs: 30000 });
    expect(p.shards).toBe(2);
    expect(p.timeoutMs).toBe(30000);
  });

  test("explicit env choices are respected", () => {
    const p = planUnderLoad({ load: 46, cores: 12, shards: 8, timeoutMs: 10000, shardsExplicit: true });
    expect(p.shards).toBe(8);
    expect(p.timeoutMs).toBe(10000);
    expect(p.note).toBeNull();
  });
});

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("orderByDuration", () => {
  test("orders slowest first, so long files start while a short tail fills the gaps", () => {
    expect(orderByDuration(["a", "b", "c"], { a: 10, b: 1, c: 5 })).toEqual(["a", "c", "b"]);
  });

  test("a file without duration weighs the median, not zero", () => {
    // Known 4, 6, 8: the median is 6, so the unknown lands between the 6 and
    // the 4 (ties break alphabetically: "known2" < "novo").
    const files = ["known1", "known2", "known3", "novo"];
    expect(orderByDuration(files, { known1: 4, known2: 6, known3: 8 })).toEqual([
      "known3",
      "known2",
      "novo",
      "known1",
    ]);
  });

  test("ties break alphabetically, so the order is stable without durations", () => {
    expect(orderByDuration(["b", "c", "a"], {})).toEqual(["a", "b", "c"]);
  });

  test("keeps every file exactly once on a large input", () => {
    const files = Array.from({ length: 200 }, (_, i) => `f${i}`);
    const durations = Object.fromEntries(files.map((f, i) => [f, (i % 13) + 0.1]));
    const ordered = orderByDuration(files, durations);
    expect(ordered.length).toBe(200);
    expect(new Set(ordered).size).toBe(200);
    expect([...ordered].sort()).toEqual([...files].sort());
  });
});

describe("shuffleSeeded", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `f${i}`);

  test("the same seed gives the same order", () => {
    expect(shuffleSeeded(fifty, 7)).toEqual(shuffleSeeded(fifty, 7));
  });

  test("different seeds give different orders on 50 items", () => {
    expect(shuffleSeeded(fifty, 1)).not.toEqual(shuffleSeeded(fifty, 2));
  });

  test("the result is a permutation: same items, no loss, no duplicate", () => {
    const shuffled = shuffleSeeded(fifty, 3);
    expect(shuffled.length).toBe(50);
    expect([...shuffled].sort()).toEqual([...fifty].sort());
  });

  test("does not mutate the input", () => {
    const frozen = Object.freeze([...fifty]);
    const before = [...frozen];
    shuffleSeeded(frozen, 9);
    expect([...frozen]).toEqual(before);
  });
});

describe("shuffleSeedOf", () => {
  test("--shuffle=7 gives 7", () => {
    expect(shuffleSeedOf(["--shuffle=7"])).toBe(7);
  });

  test("no flag gives null: the run stays longest-first", () => {
    expect(shuffleSeedOf([])).toBeNull();
    expect(shuffleSeedOf(["--record", "--list"])).toBeNull();
  });

  test("a bare --shuffle gives a random non-negative integer", () => {
    const seed = shuffleSeedOf(["--shuffle"]);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed!).toBeGreaterThanOrEqual(0);
  });

  test("--shuffle=abc falls back to a random integer, never NaN", () => {
    const seed = shuffleSeedOf(["--shuffle=abc"]);
    expect(Number.isInteger(seed)).toBe(true);
    expect(Number.isNaN(seed)).toBe(false);
  });
});

describe("redTestNames", () => {
  test("extracts the names from (fail) lines and drops the timing, ignoring (pass)", () => {
    const output = [
      "(pass) suite > ok [1.00ms]",
      "(fail) suite > broken [12.00ms]",
      "(fail) other [3ms]",
      "(pass) other > fine",
    ].join("\n");
    expect(redTestNames(output)).toEqual(["suite > broken", "other"]);
  });

  test("no fail line gives an empty list, so the report can blame a hook or a crash", () => {
    expect(redTestNames("(pass) suite > ok [1.00ms]\n")).toEqual([]);
    expect(redTestNames("")).toEqual([]);
  });
});

describe("fileEnv", () => {
  test("removes the live-state keys, keeps the rest and adds the git isolation", () => {
    const base = {
      PATH: "/bin",
      FOO: "bar",
      DATA_DIR: "/live/data",
      TOPICS_DATA_DIR: "/live/topics",
      TOPICS_HOME: "/live/home",
      OPENCLAW_CONFIG_PATH: "/live/config.json",
    };
    const env = fileEnv(base);
    expect(env.FOO).toBe("bar");
    expect(env.PATH).toBe("/bin");
    for (const key of ["DATA_DIR", "TOPICS_DATA_DIR", "TOPICS_HOME", "OPENCLAW_CONFIG_PATH"]) {
      expect(key in env).toBe(false);
    }
    expect(env.TOPICS_GIT_ISOLATED).toBe("1");
  });

  test("does not set TMPDIR: the scratch directory is added per file, not per run", () => {
    expect("TMPDIR" in fileEnv({ PATH: "/bin" })).toBe(false);
  });

  test("does not mutate its input", () => {
    const base = { PATH: "/bin", DATA_DIR: "/live/data" };
    fileEnv(base);
    expect(base).toEqual({ PATH: "/bin", DATA_DIR: "/live/data" });
  });
});

describe("aggregateVerdict", () => {
  test("all green → 0", () => {
    expect(aggregateVerdict([0, 0, 0])).toBe(0);
  });
  test("one red file → the first non-zero code", () => {
    expect(aggregateVerdict([0, 1, 0])).toBe(1);
    expect(aggregateVerdict([0, 0, 3])).toBe(3);
  });
  test("no file at all → 0", () => {
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

  test("package.json runs the suite through the slot into test-unit-shards.ts, and every root exists", () => {
    // The old serial runner (`scripts/test-unit-serial.ts`) is gone: `test:unit`
    // is the sharded run, entered through the gate slot. If a root or the entry
    // point drifts, the bar covers less than the suite without anybody noticing.
    expect(existsSync(join(REPO_ROOT, "scripts/test-unit-serial.ts"))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    for (const name of ["test:unit", "test:unit:shuffle"]) {
      expect(pkg.scripts[name]).toContain("scripts/slot.ts test:unit");
      expect(pkg.scripts[name]).toContain("scripts/test-unit-shards.ts");
    }
    expect(pkg.scripts["test:unit:shuffle"]).toContain("--shuffle");
    expect(pkg.scripts["test:unit:durations"]).toContain("scripts/test-unit-shards.ts");
    expect(pkg.scripts["test:unit:durations"]).toContain("--record");
    for (const root of SUITE_ROOTS) {
      expect(statSync(join(REPO_ROOT, root)).isDirectory(), `SUITE_ROOTS: «${root}» is not a directory`).toBe(true);
    }
  });

  test("ogni voce di SERIAL_GLOBS corrisponde a un file reale", () => {
    // A renamed racer would quietly drop out of the serial phase and land in a
    // concurrent shard, where its timing assertions give way.
    const files = enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
    const { serial } = partitionTiers(files);
    for (const glob of SERIAL_GLOBS) {
      const hit = serial.some((f) => f === glob || f.startsWith(glob.replace(/\*\*$/, "")));
      expect(hit, `SERIAL_GLOBS: «${glob}» non corrisponde a nessun file`).toBe(true);
    }
  });
});

describe("defaultShards", () => {
  test("one per core, never fewer than two nor more than four", () => {
    expect([1, 2, 3, 4, 8, 12].map(defaultShards)).toEqual([2, 2, 3, 4, 4, 4]);
  });

  test("a 4-vCPU machine gets four shards, the value the bar was written for", () => {
    expect(defaultShards(4)).toBe(4);
  });
});

describe("newEntries", () => {
  test("names what appeared after the snapshot, sorted, and not what was already there", () => {
    const dir = mkdtempSync(join(tmpdir(), "new-entries-"));
    try {
      mkdirSync(join(dir, "was-here"));
      const before = snapshotEntries(dir);
      mkdirSync(join(dir, "b-appeared"));
      mkdirSync(join(dir, "a-appeared"));
      expect(newEntries(before, dir)).toEqual(["a-appeared", "b-appeared"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a folder that cannot be read is empty, not an error", () => {
    expect([...snapshotEntries(join(tmpdir(), "does-not-exist-" + process.pid))]).toEqual([]);
  });
});
