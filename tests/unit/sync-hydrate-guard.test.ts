/**
 * Regression test for the post-Phase-A→H "tab reset" bug.
 *
 * Symptom: after a `git merge` that touched 30 files in client/src/, fswatch
 * triggered 30 sequential vite builds → 30 Electron reloads. On each reload
 * the pane store remounted with default (`openChatTopicIds: []`) and the
 * sync middleware fired a PUT before the WS init had hydrated us — wiping
 * the user's open tabs server-side.
 *
 * Fix: `syncServer.ts` skips the PUT until `hasReceivedServerHydrate()` is
 * true. This test verifies that contract holds in isolation.
 *
 * Why test the function directly and not the full middleware: the
 * middleware subscribes to `usePaneStore`, which depends on Zustand at
 * runtime. Pulling that into bun:test requires DOM shims. The guard is a
 * single boolean check, so we test it via the exported `serverHydrated`
 * lifecycle module.
 *
 * @covers TAB-SYNC-01
 */
import { describe, expect, test, beforeEach } from "bun:test";

const MODULE = "../../client/src/state/pane/middleware/serverHydrated";

beforeEach(async () => {
  // Each test imports fresh by clearing the module cache via dynamic import.
  // bun's import cache is per-call, but for safety we reset the flag.
  const mod = await import(MODULE);
  mod.__resetServerHydratedForTests();
});

describe("server-hydrated guard (post-mortem fix)", () => {

  test("hasReceivedServerHydrate() is false at boot", async () => {
    const { hasReceivedServerHydrate } = await import(MODULE);
    expect(hasReceivedServerHydrate()).toBe(false);
  });

  test("flips true after markServerHydrated() and stays true", async () => {
    const { hasReceivedServerHydrate, markServerHydrated } = await import(MODULE);
    expect(hasReceivedServerHydrate()).toBe(false);
    markServerHydrated();
    expect(hasReceivedServerHydrate()).toBe(true);
    // Idempotent — calling twice doesn't toggle.
    markServerHydrated();
    expect(hasReceivedServerHydrate()).toBe(true);
  });

  test("onServerHydrated fires its listener exactly once", async () => {
    const { onServerHydrated, markServerHydrated } = await import(MODULE);
    let calls = 0;
    onServerHydrated(() => { calls++; });
    expect(calls).toBe(0);
    markServerHydrated();
    // La NOTIFICA è differita di una micro-task (il FLAG no, vedi il test
    // sopra). Non è un dettaglio: `syncWS.ts` marca e POI dispatcha
    // `HYDRATE_FROM_SNAPSHOT` nella stessa esecuzione sincrona, quindi un
    // listener chiamato sul posto girerebbe prima che l'idratazione esista.
    // Vedi client/src/state/pane/middleware/serverHydrated.test.ts.
    await Promise.resolve();
    expect(calls).toBe(1);
    // Subsequent marks must NOT re-fire (the set is cleared after first flush).
    markServerHydrated();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  test("onServerHydrated subscribed AFTER hydrate fires on a microtask", async () => {
    const { onServerHydrated, markServerHydrated } = await import(MODULE);
    markServerHydrated();
    let fired = false;
    onServerHydrated(() => { fired = true; });
    // Synchronous: the queueMicrotask hasn't drained yet.
    expect(fired).toBe(false);
    await Promise.resolve();
    expect(fired).toBe(true);
  });

  test("__resetServerHydratedForTests restores boot state", async () => {
    const {
      hasReceivedServerHydrate,
      markServerHydrated,
      __resetServerHydratedForTests,
    } = await import(MODULE);
    markServerHydrated();
    expect(hasReceivedServerHydrate()).toBe(true);
    __resetServerHydratedForTests();
    expect(hasReceivedServerHydrate()).toBe(false);
  });

  test("listener errors don't poison hydration", async () => {
    const { onServerHydrated, markServerHydrated, hasReceivedServerHydrate } = await import(MODULE);
    onServerHydrated(() => { throw new Error("intentional"); });
    let secondFired = false;
    onServerHydrated(() => { secondFired = true; });
    markServerHydrated();
    // Il flag è sincrono, la notifica no (vedi sopra).
    expect(hasReceivedServerHydrate()).toBe(true);
    await Promise.resolve();
    // The throwing listener is caught; the second still fires.
    expect(secondFired).toBe(true);
  });
});
