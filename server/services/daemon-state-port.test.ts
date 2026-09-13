/**
 * Port-identity + fallback — the daemon-side half of the squatter-recovery
 * fix. The daemon is the single owner of the machine's Topics data; it must
 * come UP even when the preferred port (default 3333) is held by an unrelated
 * process. This file proves:
 *
 *   * `isTopicsPresenceBody` — recognises OUR response shape and rejects HTML,
 *     JSON of other servers, wrong types, and empty bodies.
 *   * `probeTopicsOnPort` — classifies "our server / squatter / nobody" from
 *     an injected fetch, and treats a network error as "nobody" (conservative:
 *     safe to try binding).
 *   * `chooseListenPort` — keeps the configured port when it's ours or empty,
 *     and returns 0 (ephemeral) when a squatter holds it; returns 0 when
 *     configured is 0.
 *   * `pickEphemeralPort` — returns a real, non-privileged, actually-free port.
 *   * `portIsHeld` — true for a port we're holding, false for a free one.
 *
 * No network in the pure tests: `fetchFn` is injected. The real-fetch tests
 * spin up a local Bun server so the classification is exercised end-to-end.
 *
 * @covers RUNTIME-16
 */
import { describe, it, expect, afterAll } from "bun:test";
import {
  isTopicsPresenceBody,
  probeTopicsOnPort,
  chooseListenPort,
  pickEphemeralPort,
  portIsHeld,
  PROBE_ROUTE,
  type PortProbeResult,
} from "./daemon-state";

const NOSTRA = JSON.stringify({
  openSessions: 19,
  workingSessions: 3,
  activeTasks: 0,
  focusProject: "topics-app",
});
const HTML = "<!doctype html><html lang=\"en\"><head><title>Van Damme-o-Matic</title></head><body></body></html>";
const OTHER_JSON = '{"status":"ok","openSessions":19}'; // one field, wrong second

// ── isTopicsPresenceBody ─────────────────────────────────────────────────────
describe("isTopicsPresenceBody", () => {
  it("riconosce la nostra forma", () => {
    expect(isTopicsPresenceBody(NOSTRA)).toBe(true);
  });

  it("rifiuta l'HTML di un altro progetto", () => {
    expect(isTopicsPresenceBody(HTML)).toBe(false);
  });

  it("rifiuta JSON di un altro server", () => {
    expect(isTopicsPresenceBody(OTHER_JSON)).toBe(false);
    expect(isTopicsPresenceBody('{"status":"ok"}')).toBe(false);
  });

  it("rifiuta tipi sbagliati", () => {
    expect(isTopicsPresenceBody('{"openSessions":"tre","workingSessions":1}')).toBe(false);
    expect(isTopicsPresenceBody('{"openSessions":19}')).toBe(false); // un solo campo
  });

  it("rifiuta il vuoto e il non-JSON", () => {
    expect(isTopicsPresenceBody("")).toBe(false);
    expect(isTopicsPresenceBody("non-JSON")).toBe(false);
  });

  it("rifiuta null e un oggetto nullo", () => {
    expect(isTopicsPresenceBody("null")).toBe(false);
    expect(isTopicsPresenceBody("{}")).toBe(false);
  });
});

// ── probeTopicsOnPort ────────────────────────────────────────────────────────
describe("probeTopicsOnPort (fetch iniettato)", () => {
  const fake = (body: string | null, err?: Error, status = 200) =>
    (async () => {
      if (err) throw err;
      if (body === null) return null;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      };
    }) as unknown as typeof fetch;

  it("classifica 'nostro' quando la forma e' la nostra", async () => {
    const r = await probeTopicsOnPort(3333, fake(NOSTRA));
    expect(r).toEqual<PortProbeResult>({ ourServer: true, squatted: false, nobody: false });
  });

  it("classifica 'estraneo' quando risponde 200 ma con HTML", async () => {
    // E' ESATTAMENTE il caso Van Damme-o-Matic: 200 + text/html per ogni path.
    const r = await probeTopicsOnPort(3333, fake(HTML));
    expect(r).toEqual<PortProbeResult>({ ourServer: false, squatted: true, nobody: false });
  });

  it("classifica 'estraneo' anche con 404 (c'è qualcuno, non siamo noi)", async () => {
    const r = await probeTopicsOnPort(3333, fake("Not Found", undefined, 404));
    expect(r).toEqual<PortProbeResult>({ ourServer: false, squatted: true, nobody: false });
  });

  it("classifica 'nessuno' quando la fetch rifiuta", async () => {
    const r = await probeTopicsOnPort(3333, fake(null));
    expect(r).toEqual<PortProbeResult>({ ourServer: false, squatted: false, nobody: true });
  });

  it("classifica 'nessuno' quando la fetch ESPLODE (ECONNREFUSED)", async () => {
    const r = await probeTopicsOnPort(3333, fake(null, new Error("ECONNREFUSED")));
    expect(r).toEqual<PortProbeResult>({ ourServer: false, squatted: false, nobody: true });
  });

  it("usa la rotta della forma (ROTTA_SONDA) e 127.0.0.1, in HTTP semplice", async () => {
    const visti: string[] = [];
    await probeTopicsOnPort(4567, (async (u: string) => {
      visti.push(u);
      return { ok: true, status: 200, text: async () => NOSTRA };
    }) as unknown as typeof fetch);
    expect(visti).toEqual([`http://127.0.0.1:4567${PROBE_ROUTE}`]);
  });
});

// ── chooseListenPort ─────────────────────────────────────────────────────────
describe("chooseListenPort", () => {
  const ourFetch = (async () => ({ ok: true, status: 200, text: async () => NOSTRA })) as unknown as typeof fetch;
  const squatterFetch = (async () => ({ ok: true, status: 200, text: async () => HTML })) as unknown as typeof fetch;
  const nobodyFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

  it("tiene la porta quando e' la nostra (idempotenza del riavvio)", async () => {
    expect(await chooseListenPort(3333, ourFetch)).toBe(3333);
  });

  it("cade su 0 (effimera) quando la porta e' di un estraneo", async () => {
    expect(await chooseListenPort(3333, squatterFetch)).toBe(0);
  });

  it("tiene la porta quando non risponde nessuno", async () => {
    expect(await chooseListenPort(3333, nobodyFetch)).toBe(3333);
  });

  it("restituisce 0 se la configurata e' gia' 0 (isolamento worktree)", async () => {
    expect(await chooseListenPort(0, ourFetch)).toBe(0);
    expect(await chooseListenPort(0, squatterFetch)).toBe(0);
  });

  it("tratta 0/valori non positivi come 'già effimera'", async () => {
    expect(await chooseListenPort(-1, ourFetch)).toBe(0);
  });
});

// ── pickEphemeralPort + portIsHeld (rete locale reale) ────────────────────────
describe("pickEphemeralPort + portIsHeld (rete locale reale)", () => {
  it("restituisce una porta non-privilegiata, libera e riutilizzabile", async () => {
    const p = pickEphemeralPort();
    expect(p).toBeGreaterThanOrEqual(1024);
    expect(p).toBeLessThanOrEqual(65535);
    // La porta che abbiamo appena rilasciato DEVE essere di nuovo libera.
    expect(await portIsHeld(p, 800)).toBe(false);
  });

  it("portIsHeld dice 'sì' quando qualcuno ascolta, 'no' quando no", async () => {
    const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const held = s.port;
    expect(held).toBeGreaterThan(0);
    try {
      expect(await portIsHeld(held, 800)).toBe(true);
    } finally {
      s.stop(true);
    }
  });

  it("portIsHeld rifiuta porte non positive", async () => {
    expect(await portIsHeld(0, 800)).toBe(false);
    expect(await portIsHeld(-5, 800)).toBe(false);
  });
});

// ── end-to-end: un server locale che NON e' Topics viene rilevato ─────────────
describe("end-to-end contro un server locale reale", () => {
  // Un "squatter" minimale: risponde 200 con HTML a ogni path, proprio come
  // Van Damme-o-Matic.
  const squatter = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
  });
  afterAll(() => { squatter.stop(true); });

  it("rileva l'estraneo e decide di cadere su una porta effimera", async () => {
    const p = squatter.port;
    if (!p) throw new Error("squatter did not bind a port");
    expect(p).toBeGreaterThan(0);
    expect(await portIsHeld(p, 800)).toBe(true);

    const r = await probeTopicsOnPort(p); // fetch reale, nessuna iniezione
    expect(r).toEqual<PortProbeResult>({ ourServer: false, squatted: true, nobody: false });

    // E la decisione finale: 0 = "legati su una porta effimera".
    expect(await chooseListenPort(p)).toBe(0);
  });

  it("non confonde un server che NON parla presenza con Topics", async () => {
    // Un server che risponde 200 con JSON ma senza i due campi numerici.
    const s2 = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    try {
      const p = s2.port;
      if (!p) throw new Error("test server did not bind a port");
      const r = await probeTopicsOnPort(p);
      expect(r.ourServer).toBe(false);
      expect(r.squatted).toBe(true);
      expect(await chooseListenPort(p)).toBe(0);
    } finally {
      s2.stop(true);
    }
  });
});
