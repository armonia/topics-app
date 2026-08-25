/**
 * @covers KANBAN-60
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { probeUrl, __clearProbeCacheForTests, type ProbeFetch } from "./url-probe-cache";

/** Sonda finta che risponde con un codice fisso. */
function fakeFetch(status: number): ProbeFetch {
  return async (_url, _timeoutMs) => ({
    ok: status >= 200 && status < 400,
    status,
  });
}

/** Sonda finta che non risponde mai (simula timeout/000). */
function deadFetch(): ProbeFetch {
  return async (_url, _timeoutMs) => ({ ok: false, status: 0 });
}

beforeEach(() => {
  __clearProbeCacheForTests();
});

describe("probeUrl", () => {
  it("sonda 200 -> stato live", async () => {
    const result = await probeUrl("http://localhost:3401/", fakeFetch(200));
    expect(result.status).toBe("live");
    expect(result.checkedAt).toBeTruthy();
  });

  it("sonda 5xx -> stato dead", async () => {
    const result = await probeUrl("http://localhost:3401/", fakeFetch(503));
    expect(result.status).toBe("dead");
  });

  it("sonda 000 (timeout/no risposta) -> stato dead", async () => {
    const result = await probeUrl("http://localhost:3401/", deadFetch());
    expect(result.status).toBe("dead");
  });

  it("sonda 4xx -> stato dead", async () => {
    const result = await probeUrl("http://localhost:3401/", fakeFetch(404));
    expect(result.status).toBe("dead");
  });

  it("usa la cache per URL identici nella stessa finestra TTL", async () => {
    let calls = 0;
    const countingFetch: ProbeFetch = async (_url, _timeoutMs) => {
      calls++;
      return { ok: true, status: 200 };
    };
    await probeUrl("http://localhost:3401/", countingFetch);
    await probeUrl("http://localhost:3401/", countingFetch);
    // Seconda chiamata deve usare la cache, non rifetch.
    expect(calls).toBe(1);
  });

  it("URL diversi vengono sondati separatamente", async () => {
    const r1 = await probeUrl("http://localhost:3401/", fakeFetch(200));
    const r2 = await probeUrl("http://localhost:3402/", fakeFetch(503));
    expect(r1.status).toBe("live");
    expect(r2.status).toBe("dead");
  });
});

describe("stati distinti: live / dead / unknown", () => {
  /**
   * Questo test verifica il contratto principale della feature:
   * - sonda 200 -> link si disegna (stato `live`)
   * - sonda 000/5xx -> link NON si disegna (stato `dead`)
   * - mai provata -> silenzio (stato `unknown` dal DB, non testato qui perche'
   *   il DB lo gestisce con DEFAULT NULL, e mapRow lo mappa a `null`)
   *
   * La LOGICA CLIENT (mostrare/nascondere il link) e' testata qui a livello
   * di stato della sonda: il componente React viene coperto dai test E2E.
   */
  it("200 -> live (il link si vede)", async () => {
    const r = await probeUrl("http://example.com/", fakeFetch(200));
    expect(r.status).toBe("live");
  });

  it("503 -> dead (il link NON si vede)", async () => {
    const r = await probeUrl("http://dead.localhost/", fakeFetch(503));
    expect(r.status).toBe("dead");
  });

  it("000 -> dead (il link NON si vede)", async () => {
    const r = await probeUrl("http://dead.localhost/", deadFetch());
    expect(r.status).toBe("dead");
  });

  it("URL mai sondata -> la cache e' vuota, il prossimo probeUrl la valuta", async () => {
    // Non c'e' nulla in cache per un URL mai visto: la sonda viene eseguita.
    let called = false;
    const oneFetch: ProbeFetch = async () => { called = true; return { ok: true, status: 200 }; };
    await probeUrl("http://new.localhost/", oneFetch);
    expect(called).toBe(true);
  });
});
