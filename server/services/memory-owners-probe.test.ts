/**
 * The one `/bin/ps` a minute behind the "who is holding the memory" sentence:
 * how often it runs, what it does when `ps` is mute, and when its answer is too
 * old to name an app.
 *
 * @covers KANBAN-75
 */
import { describe, expect, test } from "bun:test";
import { createMemoryOwnersReader, OWNERS_STALE_MS } from "./memory-owners-probe";

const TABLE = [
  " 2779     1 245728 /Applications/Dia.app/Contents/MacOS/Dia",
  " 3554  2779 876544 /Applications/Dia.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper (Renderer).app/Contents/MacOS/Browser Helper (Renderer)",
  " 5629   981 889968 /Users/zorahrel/.bun/bin/bun run /Users/zorahrel/Projects/topics-app/server.ts",
].join("\n");

const reader = (over: Partial<Parameters<typeof createMemoryOwnersReader>[0]> = {}) => {
  let clock = 1_000_000;
  let reads = 0;
  let answer: string | null = TABLE;
  const r = createMemoryOwnersReader({
    selfPid: 5629,
    ourMarkers: () => ["/Users/zorahrel/Projects/topics-app"],
    now: () => clock,
    ownerOf: () => null,
    // The FFI is not asked about pids that do not exist on the machine running
    // the test: what it would answer is R5's subject, not R1's.
    footprintOf: () => null,
    measurable: true,
    read: async () => { reads += 1; return answer; },
    ...over,
  });
  return {
    r,
    reads: () => reads,
    advance: (ms: number) => { clock += ms; },
    mute: () => { answer = null; },
    speak: () => { answer = TABLE; },
  };
};

describe("createMemoryOwnersReader", () => {
  test("R1: one read gives the families, and ours is never one of them", async () => {
    const w = reader();
    expect(w.r.latest()).toEqual([]);
    await w.r.sample();
    expect(w.reads()).toBe(1);
    expect(w.r.latest()).toEqual([{ name: "Dia", gb: expect.closeTo(1.12, 2), procs: 2 }]);
  });

  test("R5: the family is summed on `phys_footprint`, with resident size only where the kernel is silent", async () => {
    // Live on 16/09/2026 the Claude family read 7.01 GB resident and 10.88 GB of
    // footprint over the same 33 pids: `ps` alone would name a number 35% under
    // what Activity Monitor shows the owner, and `rss` reads small exactly while
    // a tree thrashes - the only moment this sentence is printed at all.
    const w = reader({ footprintOf: (pid) => (pid === 3554 ? 1_400_000 : null) });
    await w.r.sample();
    // 1.4 GB of footprint for the renderer, 0.245 GB of rss for the pid the
    // kernel would not answer for.
    expect(w.r.latest()).toEqual([{ name: "Dia", gb: expect.closeTo(1.646, 3), procs: 2 }]);
  });

  test("R2: a mute `ps` keeps the last answer instead of inventing an empty one", async () => {
    const w = reader();
    await w.r.sample();
    w.mute();
    w.advance(60_000);
    await w.r.sample();
    // Under thrash a fork times out, and that is not "nobody is holding memory".
    expect(w.r.latest().map((f) => f.name)).toEqual(["Dia"]);
  });

  test("R3: past the staleness the list is dropped - it would name an app already quit", async () => {
    const w = reader();
    await w.r.sample();
    w.advance(OWNERS_STALE_MS - 1);
    expect(w.r.latest().length).toBe(1);
    w.advance(2);
    expect(w.r.latest()).toEqual([]);
  });

  test("R4: single-flight - a beat that arrives while `ps` is still out does not fork a second one", async () => {
    let release: (v: string | null) => void = () => {};
    let forks = 0;
    const w = reader({ read: () => { forks += 1; return new Promise<string | null>((res) => { release = res; }); } });
    const first = w.r.sample();
    const second = w.r.sample();
    // A fork takes seconds on the machine that is short of memory: stacking a
    // second one costs exactly the thing being measured.
    expect(forks).toBe(1);
    release(TABLE);
    await Promise.all([first, second]);
    expect(w.r.latest().map((f) => f.name)).toEqual(["Dia"]);
  });

  test("R5: off macOS nothing is read and nothing is claimed", async () => {
    const w = reader({ measurable: false });
    await w.r.sample();
    expect(w.reads()).toBe(0);
    expect(w.r.latest()).toEqual([]);
  });
});
