/**
 * @covers SIDECAR-01
 */
import { describe, test, expect, it } from "bun:test";
import {
  discoverChromiumEngines,
  pickChromiumEngine,
  createChromiumSidecar,
  type ChromiumEngine,
  type SidecarLauncher,
  cdpWaitFactor,
  CDP_WAIT_BASE_MS,
  candidateIdsFor,
} from "./browser-chromium-sidecar";

// ── Discovery ──────────────────────────────────────────────────────────────

test("discovers Chrome + Brave on macOS, first existing path per candidate", () => {
  const present = new Set([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ]);
  const engines = discoverChromiumEngines({
    platform: "darwin",
    exists: (p) => present.has(p),
  });
  expect(engines.map((e) => e.id)).toEqual(["chrome", "brave"]);
  expect(engines[0]!.executablePath).toContain("Google Chrome");
});

test("discovers Edge/Chrome on Windows via Program Files probing", () => {
  const engines = discoverChromiumEngines({
    platform: "win32",
    exists: (p) => p.toLowerCase().includes("msedge.exe"),
  });
  expect(engines.map((e) => e.id)).toEqual(["edge"]);
  expect(engines[0]!.executablePath.toLowerCase()).toContain("msedge.exe");
});

test("discovers chromium on Linux from common bin locations", () => {
  const engines = discoverChromiumEngines({
    platform: "linux",
    exists: (p) => p === "/usr/bin/google-chrome" || p === "/snap/bin/chromium",
  });
  expect(engines.map((e) => e.id).sort()).toEqual(["chrome", "chromium"]);
});

test("returns empty when nothing is installed", () => {
  expect(discoverChromiumEngines({ platform: "darwin", exists: () => false })).toEqual([]);
});

// ── Engine pick ────────────────────────────────────────────────────────────

const eng = (id: string): ChromiumEngine => ({ id, name: id, executablePath: `/x/${id}` });

test("pickChromiumEngine honours preferId, else first", () => {
  const list = [eng("chrome"), eng("brave")];
  expect(pickChromiumEngine(list, "brave")!.id).toBe("brave");
  expect(pickChromiumEngine(list, "missing")!.id).toBe("chrome");
  expect(pickChromiumEngine(list)!.id).toBe("chrome");
  expect(pickChromiumEngine([])).toBeNull();
});

// ── Sidecar lifecycle ──────────────────────────────────────────────────────

/** A fake launcher that records launches/kills and never touches a real browser. */
function fakeLauncher() {
  const events: string[] = [];
  let launches = 0;
  const launcher: SidecarLauncher = {
    async launch({ engine, port }) {
      launches++;
      events.push(`launch:${engine.id}:${port}`);
      return {
        cdpEndpoint: `ws://127.0.0.1:${port}/devtools/browser/${launches}`,
        kill: () => events.push("kill"),
      };
    },
  };
  return { launcher, events, get launches() { return launches; } };
}

/** Manual timer control so idle-reap is deterministic. */
function manualTimers() {
  const pending: Array<{ id: number; fn: () => void }> = [];
  let seq = 1;
  return {
    setTimeoutFn: ((fn: () => void) => {
      const id = seq++;
      pending.push({ id, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as any,
    clearTimeoutFn: ((t: unknown) => {
      const i = pending.findIndex((p) => p.id === (t as number));
      if (i >= 0) pending.splice(i, 1);
    }) as any,
    flush() {
      const runnable = pending.splice(0);
      for (const p of runnable) p.fn();
    },
    get count() { return pending.length; },
  };
}

test("acquire launches once and is shared (single-flight), release reaps after grace", async () => {
  const f = fakeLauncher();
  const timers = manualTimers();
  const sidecar = createChromiumSidecar({
    discover: () => [eng("chrome")],
    launcher: f.launcher,
    idleGraceMs: 100,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  const [a, b] = await Promise.all([sidecar.acquire(), sidecar.acquire()]);
  expect(f.launches).toBe(1); // coalesced cold start
  expect(a.cdpEndpoint).toBe(b.cdpEndpoint);
  expect(sidecar.status()).toMatchObject({ running: true, refCount: 2 });

  sidecar.release();
  expect(sidecar.status().running).toBe(true); // one ref still alive → not reaped
  expect(timers.count).toBe(0);

  sidecar.release();
  expect(timers.count).toBe(1); // idle reap scheduled at refCount 0
  timers.flush();
  expect(f.events).toContain("kill");
  expect(sidecar.status()).toMatchObject({ running: false, refCount: 0 });
});

test("re-acquire before the grace window cancels the reap", async () => {
  const f = fakeLauncher();
  const timers = manualTimers();
  const sidecar = createChromiumSidecar({
    discover: () => [eng("chrome")],
    launcher: f.launcher,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  await sidecar.acquire();
  sidecar.release();
  expect(timers.count).toBe(1); // reap pending
  await sidecar.acquire(); // comes back in time
  expect(timers.count).toBe(0); // reap cancelled
  expect(f.launches).toBe(1); // same process reused, not relaunched
  expect(sidecar.status().running).toBe(true);
});

test("acquire with no browser installed rejects and leaves no phantom ref", async () => {
  const sidecar = createChromiumSidecar({ discover: () => [] });
  await expect(sidecar.acquire()).rejects.toThrow(/No Chromium-family browser/);
  expect(sidecar.status()).toMatchObject({ running: false, refCount: 0 });
});

test("dispose reaps immediately regardless of refCount", async () => {
  const f = fakeLauncher();
  const sidecar = createChromiumSidecar({ discover: () => [eng("chrome")], launcher: f.launcher });
  await sidecar.acquire();
  await sidecar.acquire();
  sidecar.dispose();
  expect(f.events).toContain("kill");
  expect(sidecar.status()).toMatchObject({ running: false, refCount: 0 });
});

test("loadExtensions thunk is evaluated at LAUNCH (not construction) and passed to the launcher", async () => {
  let thunkCalls = 0;
  // Collected into an array rather than a `let … | null`: tsc narrows such a
  // binding to its `null` initializer at the assertion, because the only write
  // lives in a callback it can't prove ran. The array records the same thing —
  // what the launcher actually received — and reads honestly.
  const captured: (string[] | undefined)[] = [];
  const launcher: SidecarLauncher = {
    async launch({ port, loadExtensions }) {
      captured.push(loadExtensions);
      return { cdpEndpoint: `ws://127.0.0.1:${port}/x`, kill: () => {} };
    },
  };
  const sidecar = createChromiumSidecar({
    discover: () => [eng("chrome")],
    launcher,
    loadExtensions: () => { thunkCalls++; return ["/ext/a", "/ext/b"]; },
  });
  expect(thunkCalls).toBe(0); // NOT evaluated at construction
  await sidecar.acquire();
  expect(thunkCalls).toBe(1); // evaluated once, at launch
  expect(captured).toEqual([["/ext/a", "/ext/b"]]);
  sidecar.dispose();
});

test("a static loadExtensions array still works (back-compat)", async () => {
  // Same collector shape as the thunk test above, for the same narrowing reason.
  const captured: (string[] | undefined)[] = [];
  const launcher: SidecarLauncher = {
    async launch({ port, loadExtensions }) {
      captured.push(loadExtensions);
      return { cdpEndpoint: `ws://127.0.0.1:${port}/x`, kill: () => {} };
    },
  };
  const sidecar = createChromiumSidecar({ discover: () => [eng("chrome")], launcher, loadExtensions: ["/only/one"] });
  await sidecar.acquire();
  expect(captured).toEqual([["/only/one"]]);
  sidecar.dispose();
});

describe("cdpWaitFactor: the wait grows with the load, but stays a wait", () => {
  // THE DEFECT THIS CLOSES. The ceiling was a flat 10 s. Measured on
  // 19/09/2026 with zero extensions, three launches back to back on the same
  // machine: 13.1 s / 21.2 s / 3.6 s, at loadavg 12.5 (Xcode compiling). Two
  // launches out of three failed, and a failed launch is not free: it takes
  // the branch that kills the tree.
  it("quiet machine: no widening at all", () => {
    expect(cdpWaitFactor(0, 10)).toBe(1);
    expect(cdpWaitFactor(5, 10)).toBe(1); // half a job per core is idle
  });

  it("the slowest launch ever measured fits inside the wait", () => {
    // THE NUMBER TO BEAT IS 28.0 s: a cold start with two extensions on
    // 20/09, at loadavg 9.9 on 12 cores. Warm starts right after were 4.1 and
    // 3.9 s, so the slow case is the first launch on a fresh profile - which
    // is exactly the one a user waits for.
    //
    // The base is checked here too, not just the factor: with the old 10 s
    // base this very load scaled to 18.3 s and that launch would still have
    // failed. A test on the factor alone would have stayed green through it.
    expect(CDP_WAIT_BASE_MS * cdpWaitFactor(9.9, 12)).toBeGreaterThan(28_000);
    expect(CDP_WAIT_BASE_MS * cdpWaitFactor(12.5, 10)).toBeGreaterThan(28_000);
  });

  it("covers every slow launch actually measured, not just the worst one", () => {
    // The table, so a future change to base or factor has to answer to all of
    // them at once instead of to the single number somebody remembered.
    // Seconds to CDP, and the loadavg the box was at, all on 12 cores:
    const measured: [number, number][] = [
      [28.0, 9.9],   // cold start, 2 extensions, 20/09
      [38.0, 18.0],  // cold start, ZERO extensions - so it is the box, not the extensions
      [21.2, 12.5],  // 19/09, zero extensions
      [13.1, 12.5],
      [12.8, 12.0],
    ];
    for (const [seconds, load] of measured) {
      expect(CDP_WAIT_BASE_MS * cdpWaitFactor(load, 12)).toBeGreaterThan(seconds * 1000);
    }
  });

  it("a quiet machine already gets more than the slowest launch", () => {
    // The base alone has to cover it: on an idle box the factor is 1, and a
    // cold first start there is still a cold first start.
    expect(CDP_WAIT_BASE_MS).toBeGreaterThan(28_000);
  });

  it("still a CEILING: it does not grow without bound", () => {
    // A wait that grows without limit is not a ceiling, and the point of
    // having one is refusing a browser that is never coming.
    expect(cdpWaitFactor(1000, 10)).toBe(cdpWaitFactor(10_000, 10));
    // And the ceiling stays a ceiling in absolute terms: a browser silent for
    // a minute is not late, it is not coming.
    expect(CDP_WAIT_BASE_MS * cdpWaitFactor(1000, 10)).toBeLessThanOrEqual(60_000);
  });

  it("an unreadable load does not zero the wait", () => {
    // `loadavg()` returns 0 on some platforms, and a NaN propagating through
    // would become a wait of NaN ms, i.e. no wait at all: the launch would
    // ALWAYS fail instead of waiting.
    expect(cdpWaitFactor(NaN, 10)).toBe(1);
    expect(cdpWaitFactor(5, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("the candidate list: the sidecar must not drive a person's own browser", () => {
  it("Helium comes before Dia, and not as a matter of taste", () => {
    // THE RISK THIS ORDER REMOVES. `pickChromiumEngine` takes the first
    // candidate that exists on disk. On this machine, of the seven historical
    // candidates, the only one installed was Dia: the user's own browser,
    // with their tabs, their cookies, their sessions. Verified on 20/09
    // before the change: `SCELTO: dia`.
    //
    // Helium is ungoogled-chromium (plain CDP, no Google services) and is not
    // a browser somebody lives in, so it gets looked at first.
    const ids = candidateIdsFor("darwin");
    expect(ids).toContain("helium");
    expect(ids.indexOf("helium")).toBeLessThan(ids.indexOf("dia"));
    expect(ids.indexOf("helium")).toBe(0);
  });

  it("Helium is present on all three platforms", () => {
    // A candidate added only on the Mac leaves the risk in place on Windows
    // and Linux, and nobody notices until somebody works there.
    expect(candidateIdsFor("darwin")).toContain("helium");
    expect(candidateIdsFor("win32")).toContain("helium");
    expect(candidateIdsFor("linux")).toContain("helium");
  });
});

describe("un browser morto non si aspetta come uno lento", () => {
  test("a binary that does not exist fails in well under a second", async () => {
    // MEASURED, and it is why this exists: before the `error`/`exit` listeners
    // a path that does not exist took SIXTY SECONDS to fail, because the wait
    // only ever ended on the clock. The ceiling is there for a browser that is
    // still coming; one that is already gone is not coming late.
    //
    // The port is a throwaway one on purpose: the sidecar's real port is FIXED
    // (19333), so a leftover browser holding it would answer DevTools and this
    // test would pass for the wrong reason. Found exactly that way while
    // measuring - a live Helium on 19333 made `acquire` succeed on a binary
    // that does not exist.
    const sidecar = createChromiumSidecar({
      discover: () => [{ id: "x", name: "X", executablePath: "/non/esiste/mai" }],
      loadExtensions: () => [],
      port: 45931,
    });
    const t0 = Date.now();
    let message = "";
    try {
      await sidecar.acquire();
    } catch (err) {
      message = String((err as Error).message ?? err);
    }
    const elapsed = Date.now() - t0;
    // Either signal is a correct answer, and WHICH one depends on how the
    // browser dies: a path that does not exist never starts (`error`,
    // ENOENT), a browser that refuses its profile starts and returns
    // (`exit`). The test pins "it said why", not which of the two.
    expect(message).toMatch(/cannot start|exited before exposing CDP/);
    // Generous by a lot: the measurement says 0.4-0.7 s, and the point is that
    // it is not the ceiling (30 s and up).
    expect(elapsed).toBeLessThan(5_000);
  });
});
