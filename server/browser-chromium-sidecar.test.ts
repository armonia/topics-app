/**
 * @covers SIDECAR-01
 */
import { test, expect } from "bun:test";
import {
  discoverChromiumEngines,
  pickChromiumEngine,
  createChromiumSidecar,
  type ChromiumEngine,
  type SidecarLauncher,
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
