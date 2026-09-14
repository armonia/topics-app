/**
 * Binding the port when somebody else may hold it — the daemon-side half of
 * the squatter fix (card `1e078aee`).
 *
 * WHAT THIS PROVES, and why each case is here:
 *
 *   * nobody holds the port  → we bind the CONFIGURED port and never probe.
 *     This is the common case, and the earlier version got it wrong by asking
 *     first: on a TLS build a plain-HTTP probe times out and the daemon walked
 *     away from 3333 while nothing was wrong with it.
 *   * a stranger answers     → ephemeral port, so the daemon always comes up.
 *   * TOPICS answers, over TLS → we EXIT. A second daemon on the same data
 *     directory is exactly what `reusePort: false` defends against, and
 *     quietly moving to another port would defeat it.
 *   * the probe cannot tell  → we EXIT. Guessing produces a second, empty
 *     universe while the real data lives elsewhere.
 *   * the bind failed for another reason → the error propagates untouched.
 *
 * @covers RUNTIME-16
 */
import { describe, it, expect } from "bun:test";
import {
  isAddressInUse,
  listenWithSquatterFallback,
  portTakenMessage,
  PortTakenError,
} from "./daemon-state";
import { probePort, realProbeDeps, type PortVerdict, type ProbePortDeps } from "../lib/port-squatter";

const OURS = JSON.stringify({
  openSessions: 19,
  workingSessions: 3,
  activeTasks: 0,
  focusProject: "topics-app",
});
const HTML = "<!doctype html><html lang=\"en\"><head><title>account switcher</title></head><body></body></html>";

const inUse = () => Object.assign(new Error("Failed to start server. Is port 3333 in use?"), {});

/** A bind that fails on the configured port and succeeds on 0, recording calls. */
function bindThatRefuses(port: number, tried: number[]) {
  return (p: number) => {
    tried.push(p);
    if (p === port) throw inUse();
    return { port: 51234 } as const;
  };
}

const probeSaying = (outcome: PortVerdict) => async () => outcome;

// A probe built on the REAL probePort, with only the two I/O dependencies
// faked: it is the production code path that decides who answers, including
// the HTTPS-then-HTTP order.
function probeOverFakeNetwork(answers: Record<string, string | null>) {
  const deps: ProbePortDeps = {
    chiedi: async (url) => {
      const scheme = url.startsWith("https") ? "https" : "http";
      const body = answers[scheme];
      return body === null || body === undefined ? null : { ok: true, corpo: body };
    },
    chiOccupa: () => ({ pid: 4242, comando: "dashboard.mjs" }),
    pidNostro: 1,
  };
  return (port: number) => probePort(port, deps);
}

describe("isAddressInUse", () => {
  it("recognises the Bun wording and the POSIX code", () => {
    expect(isAddressInUse(inUse())).toBe(true);
    expect(isAddressInUse(Object.assign(new Error("listen failed"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isAddressInUse(new Error("address already in use"))).toBe(true);
  });

  it("does not swallow an unrelated failure", () => {
    expect(isAddressInUse(new Error("tls: certificate file not found"))).toBe(false);
    expect(isAddressInUse(null)).toBe(false);
  });
});

describe("listenWithSquatterFallback", () => {
  it("binds the configured port and never probes when it is free", async () => {
    const tried: number[] = [];
    let probed = false;
    const out = await listenWithSquatterFallback(
      3333,
      (p) => { tried.push(p); return { port: p } as const; },
      async () => { probed = true; return { stato: "silenzio" }; },
    );
    expect(tried).toEqual([3333]);
    expect(probed).toBe(false);
    expect(out.movedToEphemeral).toBe(false);
    expect(out.listener.port).toBe(3333);
  });

  it("falls back to an ephemeral port when a confirmed stranger answers", async () => {
    const tried: number[] = [];
    const out = await listenWithSquatterFallback(
      3333,
      bindThatRefuses(3333, tried),
      probeSaying({ stato: "estraneo", pid: 4242, comando: "dashboard.mjs" }),
    );
    expect(tried).toEqual([3333, 0]);
    expect(out.movedToEphemeral).toBe(true);
    expect(out.probed?.stato).toBe("estraneo");
  });

  it("refuses to start when another Topics answers, even over TLS only", async () => {
    const tried: number[] = [];
    // The stranger case of production on this machine reversed: HTTPS answers
    // with our presence shape, plain HTTP never gets a turn.
    const probe = probeOverFakeNetwork({ https: OURS, http: null });
    await expect(
      listenWithSquatterFallback(3333, bindThatRefuses(3333, tried), probe),
    ).rejects.toThrow(PortTakenError);
    expect(tried).toEqual([3333]); // never bound anything else
  });

  it("falls back when the HTML of a foreign dashboard answers over plain HTTP", async () => {
    const tried: number[] = [];
    const probe = probeOverFakeNetwork({ https: null, http: HTML });
    const out = await listenWithSquatterFallback(3333, bindThatRefuses(3333, tried), probe);
    expect(tried).toEqual([3333, 0]);
    expect(out.movedToEphemeral).toBe(true);
  });

  it("refuses to start when the probe cannot tell who is there", async () => {
    for (const outcome of [
      { stato: "silenzio" } as const,
      { stato: "ignoto", perche: "timeout" } as const,
      { stato: "nostro" } as const,
    ]) {
      const tried: number[] = [];
      await expect(
        listenWithSquatterFallback(3333, bindThatRefuses(3333, tried), probeSaying(outcome)),
      ).rejects.toThrow(PortTakenError);
      expect(tried).toEqual([3333]);
    }
  });

  it("lets an unrelated bind failure through untouched", async () => {
    const boom = new Error("tls: certificate file not found");
    await expect(
      listenWithSquatterFallback(3333, () => { throw boom; }, probeSaying({ stato: "estraneo", pid: 1, comando: null })),
    ).rejects.toThrow("certificate file not found");
  });

  it("treats a non-positive configured port as already ephemeral", async () => {
    const tried: number[] = [];
    const out = await listenWithSquatterFallback(0, (p) => { tried.push(p); return { port: 40000 } as const; });
    expect(tried).toEqual([0]);
    expect(out.movedToEphemeral).toBe(false);
  });

  it("survives a real foreign server on a real port", async () => {
    const squatter = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
    });
    try {
      const held = squatter.port;
      if (!held) throw new Error("the test squatter did not bind a port");
      const tried: number[] = [];
      // The probe is the real one (real fetch, real `lsof`); only "our pid" is
      // faked, because here the foreign server runs inside the test process
      // and would otherwise be recognised as ourselves.
      const out = await listenWithSquatterFallback(
        held,
        bindThatRefuses(held, tried),
        (port) => probePort(port, realProbeDeps(-1)),
      );
      expect(tried).toEqual([held, 0]);
      expect(out.movedToEphemeral).toBe(true);
    } finally {
      squatter.stop(true);
    }
  });
});

describe("portTakenMessage", () => {
  it("names the real reason for each outcome", () => {
    expect(portTakenMessage(3333, { stato: "nostro" })).toContain("another Topics daemon");
    expect(portTakenMessage(3333, { stato: "silenzio" })).toContain("nobody answers");
    expect(portTakenMessage(3333, { stato: "ignoto", perche: "timeout" })).toContain("timeout");
  });
});
