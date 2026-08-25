import { describe, test, expect, beforeEach } from "bun:test";
import {
  hasReceivedServerHydrate,
  markServerHydrated,
  onServerHydrated,
  __resetServerHydratedForTests,
} from "./serverHydrated";

/** Lascia sfilare la coda delle micro-task. */
const flush = () => Promise.resolve().then(() => {});

describe("serverHydrated", () => {
  beforeEach(() => {
    __resetServerHydratedForTests();
  });

  test("hasReceivedServerHydrate is false before mark, true after", () => {
    expect(hasReceivedServerHydrate()).toBe(false);
    markServerHydrated();
    // Il FLAG è sincrono: `bootstrap.ts` e `syncServer.ts` lo leggono nello
    // stesso battito per decidere se il fallback GET / il PUT devono partire.
    // Solo la NOTIFICA è differita.
    expect(hasReceivedServerHydrate()).toBe(true);
  });

  test("markServerHydrated is idempotent", () => {
    markServerHydrated();
    markServerHydrated();
    expect(hasReceivedServerHydrate()).toBe(true);
  });

  test("onServerHydrated fires once when mark is called after subscribe", async () => {
    let fired = 0;
    onServerHydrated(() => { fired++; });
    expect(fired).toBe(0);
    markServerHydrated();
    await flush();
    expect(fired).toBe(1);
    // Idempotent mark must not re-fire the listener.
    markServerHydrated();
    await flush();
    expect(fired).toBe(1);
  });

  test("onServerHydrated fires asynchronously when already hydrated at subscribe time", async () => {
    markServerHydrated();
    let fired = 0;
    onServerHydrated(() => { fired++; });
    // Hot path: listener queued via queueMicrotask, NOT invoked synchronously.
    expect(fired).toBe(0);
    await flush();
    expect(fired).toBe(1);
  });

  /**
   * L'INVARIANTE, non un dettaglio di temporizzazione.
   *
   * I due chiamanti di `markServerHydrated()` marcano PRIMA di applicare lo
   * snapshot: `syncWS.ts` fa `markServerHydrated()` e poi, nella stessa
   * esecuzione sincrona, `dispatch(HYDRATE_FROM_SNAPSHOT)`; `bootstrap.ts` fa
   * lo stesso. Un listener chiamato sul posto girerebbe quindi in un mondo in
   * cui l'idratazione NON è ancora avvenuta — ed è precisamente la corsa da cui
   * chi si iscrive sta scappando (TABLINK-06: il permalink apre la tab prima
   * dell'hydrate, e l'hydrate se la riprende).
   *
   * Questo test riproduce quell'ordine: se la notifica tornasse sincrona,
   * `visto` sarebbe `[]`.
 *
 * @covers TAB-SYNC-01
   */
  test("il listener gira DOPO il lavoro sincrono che segue il mark (l'ordine di syncWS)", async () => {
    const applicato: string[] = [];
    const visto: string[] = [];
    onServerHydrated(() => { visto.push(...applicato); });

    // ── com'è fatto syncWS.ts ──
    markServerHydrated();
    applicato.push("HYDRATE_FROM_SNAPSHOT");
    // ──────────────────────────

    await flush();
    expect(visto).toEqual(["HYDRATE_FROM_SNAPSHOT"]);
  });

  test("multiple listeners all fire on first mark", async () => {
    const calls: string[] = [];
    onServerHydrated(() => calls.push("a"));
    onServerHydrated(() => calls.push("b"));
    onServerHydrated(() => calls.push("c"));
    markServerHydrated();
    await flush();
    expect(calls.sort()).toEqual(["a", "b", "c"]);
  });

  test("unsubscribe before mark prevents listener from firing", async () => {
    let fired = 0;
    const unsubscribe = onServerHydrated(() => { fired++; });
    unsubscribe();
    markServerHydrated();
    await flush();
    expect(fired).toBe(0);
  });

  test("listener exception does not block other listeners", async () => {
    let fired = 0;
    onServerHydrated(() => { throw new Error("boom"); });
    onServerHydrated(() => { fired++; });
    markServerHydrated();
    await flush();
    expect(fired).toBe(1);
  });

  test("un listener registrato DURANTE il fire non rientra nello stesso flush", async () => {
    // Il rischio è la ricorsione: se il set non fosse svuotato prima di
    // iterare, un listener che ne registra un altro si ri-innescherebbe a
    // catena. Qui si fissa che il nuovo arrivi DOPO (ramo «già idratato» di
    // `onServerHydrated`, che è sempre stato differito) e UNA volta sola.
    const ordine: string[] = [];
    let nestedFired = 0;
    onServerHydrated(() => {
      ordine.push("esterno:inizio");
      onServerHydrated(() => { nestedFired++; ordine.push("annidato"); });
      ordine.push("esterno:fine");
    });
    markServerHydrated();
    await flush();
    await flush();
    expect(nestedFired).toBe(1);
    expect(ordine).toEqual(["esterno:inizio", "esterno:fine", "annidato"]);
  });
});
