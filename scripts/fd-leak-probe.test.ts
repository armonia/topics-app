import { describe, expect, it } from "bun:test";
import { countFds, DEFAULT_TOLERANCE, judge, parseListenerPid } from "./fd-leak-probe";

describe("parseListenerPid", () => {
  it("prende il pid dalla seconda colonna saltando l'intestazione", () => {
    const out = [
      "COMMAND   PID      USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "bun     99652 someuser   28u  IPv6 0x1f2a3b4c5d6e7f80      0t0  TCP *:3333 (LISTEN)",
    ].join("\n");
    expect(parseListenerPid(out)).toBe(99652);
  });

  it("torna null quando nessuno ascolta", () => {
    expect(parseListenerPid("")).toBeNull();
    expect(parseListenerPid("COMMAND   PID      USER   FD   TYPE")).toBeNull();
  });
});

describe("countFds", () => {
  const header = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME";

  it("non conta l'intestazione fra i descrittori", () => {
    const out = [header, "bun 1 u 1u REG 0x1 0t0 1 /tmp/a", "bun 1 u 2u REG 0x1 0t0 2 /tmp/b"].join("\n");
    expect(countFds(out).total).toBe(2);
  });

  it("separa CLOSED e CLOSE_WAIT, che sono gli stati della perdita", () => {
    const out = [
      header,
      "bun 1 u 3u IPv6 0x1 0t0 TCP [::1]:3333->[::1]:5001 (CLOSED)",
      "bun 1 u 4u IPv6 0x1 0t0 TCP [::1]:3333->[::1]:5002 (CLOSED)",
      "bun 1 u 5u IPv6 0x1 0t0 TCP [::1]:3333->[::1]:5003 (CLOSE_WAIT)",
      "bun 1 u 6u IPv6 0x1 0t0 TCP [::1]:3333->[::1]:5004 (ESTABLISHED)",
    ].join("\n");
    const got = countFds(out);
    expect(got.total).toBe(4);
    expect(got.closed).toBe(2);
    expect(got.closeWait).toBe(1);
  });

  it("regge l'output vuoto senza esplodere", () => {
    expect(countFds("")).toEqual({ total: 0, closed: 0, closeWait: 0 });
  });
});

describe("judge", () => {
  it("promuove la misura quando i descrittori tornano dov'erano", () => {
    const v = judge(287, 287, 0, 0);
    expect(v.delta).toBe(0);
    expect(v.ok).toBe(true);
  });

  it("promuove il respiro naturale di un server vivo", () => {
    // Fra le due misure possono nascere connessioni vere: sotto la tolleranza
    // non e' una perdita.
    expect(judge(50, 50 + DEFAULT_TOLERANCE, 0, 0).ok).toBe(true);
  });

  it("boccia la crescita misurata il 19/08: centinaia di descrittori in piu'", () => {
    const v = judge(132, 287, 133, 22);
    expect(v.delta).toBe(155);
    expect(v.ok).toBe(false);
  });

  it("boccia appena si supera la tolleranza", () => {
    expect(judge(50, 50 + DEFAULT_TOLERANCE + 1, 0, 0).ok).toBe(false);
  });

  it("un calo di descrittori non e' una perdita", () => {
    expect(judge(100, 80, 0, 0).ok).toBe(true);
  });
});
