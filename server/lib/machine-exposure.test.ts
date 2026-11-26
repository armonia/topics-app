/**
 * @covers MACHINE-05
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { applyExposure, isPublicIpv4, LAST_MEASURE_MAX_AGE_MS, measureOpenPorts, poolIpOf, tcpPortProbe, type PortProbe } from "./machine-exposure";
import { composeAccess } from "./machine-security";
import type { AccessFacts, MachineSecurityReport } from "../../shared/machine-health";

// What a provider-firewalled node sent: `ufw` off and eight ports listening.
const HETZNER_FACTS: AccessFacts = {
  ssh: { kind: "on", password: false },
  ports: [3333, 3334, 3335, 8080, 9100, 9101, 9102, 9103],
  firewall: false,
  linuxServer: true,
};

function reportOf(facts: AccessFacts): MachineSecurityReport {
  const access = composeAccess(facts);
  return {
    checked_at: 1_700_000_000,
    status: access.status === "info" ? "unknown" : access.status,
    checks: [{ key: "updates", status: "ok", detail: "Aggiornato" }, access],
    access_facts: facts,
  };
}

/** A probe that answers only for the listed ports (a firewall that drops the rest). */
const answering = (open: number[]): PortProbe => async (_host, port) => open.includes(port);

describe("porte viste da fuori", () => {
  let memory: NonNullable<Parameters<typeof applyExposure>[4]>;
  beforeEach(() => { memory = new Map(); });

  test("senza la misura, ufw spento e otto porte sono un avviso", () => {
    const c = composeAccess(HETZNER_FACTS);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("8 porte aperte");
  });

  test("firewall del provider: risponde solo la 22 e la misura vince su ufw", async () => {
    const out = await applyExposure(reportOf(HETZNER_FACTS), "203.0.113.10", answering([22]), Date.now(), memory);
    const access = out.checks.find((c) => c.key === "access")!;
    expect(access.status).toBe("ok");
    expect(access.detail).toBe("Solo chiave SSH, firewall del provider: aperta solo la 22");
    expect(out.status).toBe("ok");
  });

  test("se una porta rischiosa risponde da fuori resta un avviso", async () => {
    const facts: AccessFacts = { ...HETZNER_FACTS, ports: [5432, 9100] };
    const out = await applyExposure(reportOf(facts), "203.0.113.10", answering([22, 5432]), Date.now(), memory);
    const access = out.checks.find((c) => c.key === "access")!;
    expect(access.status).toBe("warn");
    expect(access.detail).toContain("Porta 5432 aperta alla rete");
  });

  test("se la 22 non risponde la misura non prova nulla: il rapporto resta quello del nodo", async () => {
    const original = reportOf(HETZNER_FACTS);
    expect(await measureOpenPorts("203.0.113.10", HETZNER_FACTS.ports!, answering([]))).toBeNull();
    expect(await applyExposure(original, "203.0.113.10", answering([]), Date.now(), memory)).toBe(original);
    expect(original.status).toBe("warn");
  });

  test("a silent 22 after a good round keeps the last measure, until it is too old", async () => {
    const t0 = 1_000_000;
    await applyExposure(reportOf(HETZNER_FACTS), "203.0.113.20", answering([22]), t0, memory);
    const soon = await applyExposure(reportOf(HETZNER_FACTS), "203.0.113.20", answering([]), t0 + 60_000, memory);
    expect(soon.checks.find((c) => c.key === "access")!.detail).toBe("Solo chiave SSH, firewall del provider: aperta solo la 22");
    const stale = reportOf(HETZNER_FACTS);
    expect(await applyExposure(stale, "203.0.113.20", answering([]), t0 + LAST_MEASURE_MAX_AGE_MS + 1, memory)).toBe(stale);
    expect(await applyExposure(stale, "203.0.113.20", answering([]), t0, new Map())).toBe(stale);
  });

  test("the control port gets three tries: 22 answering only on the third still counts", async () => {
    let tries22 = 0;
    const slow22: PortProbe = async (_h, port) => (port === 22 ? ++tries22 >= 3 : false);
    expect(await measureOpenPorts("203.0.113.10", [3333], slow22)).toEqual([]);
    expect(tries22).toBe(3);
  });

  test("senza indirizzo pubblico, o senza le porte dichiarate, non si misura nulla", async () => {
    const original = reportOf(HETZNER_FACTS);
    const never: PortProbe = async () => { throw new Error("must not connect"); };
    expect(await applyExposure(original, null, never)).toBe(original);
    const noPorts = reportOf({ ...HETZNER_FACTS, ports: null });
    expect(await applyExposure(noPorts, "203.0.113.10", never)).toBe(noPorts);
  });

  test("a lost first packet on 22 or on a port does not change the outcome", async () => {
    const seen = new Map<number, number>();
    const dropsFirst: PortProbe = async (_h, port) => {
      const n = (seen.get(port) ?? 0) + 1;
      seen.set(port, n);
      return n >= 2;
    };
    const first = await measureOpenPorts("203.0.113.10", [3333], dropsFirst);
    expect(first).toEqual([3333]);
  });

  test("una connessione che esplode conta come porta chiusa", async () => {
    const flaky: PortProbe = async (_h, port) => { if (port === 22) return true; throw new Error("boom"); };
    expect(await measureOpenPorts("203.0.113.10", [3333], flaky)).toEqual([]);
  });

  test("connessione TCP vera: una porta in ascolto risponde, una chiusa no", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    try {
      expect(await tcpPortProbe("127.0.0.1", server.port, 1000)).toBe(true);
      const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const closedPort = free.port;
      free.stop(true);
      expect(await tcpPortProbe("127.0.0.1", closedPort, 1000)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("indirizzo del nodo", () => {
  test("pubblico sì; privato, loopback, Tailscale e link-local no", () => {
    expect(isPublicIpv4("203.0.113.10")).toBe(true);
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.20.0.2", "100.100.1.1", "169.254.1.1", "999.1.1.1", "not-an-ip"]) {
      expect(isPublicIpv4(ip)).toBe(false);
    }
  });

  test("lo prende dal registro del pool per id della macchina", () => {
    const state = JSON.stringify({ slots: { "1": { machine_id: "m1", ip: "203.0.113.10" }, "2": { machine_id: "m2" }, "3": { machine_id: "m3", ip: "10.0.0.4" } } });
    expect(poolIpOf(state, "m1")).toBe("203.0.113.10");
    expect(poolIpOf(state, "m2")).toBeNull();
    expect(poolIpOf(state, "m3")).toBeNull();
    expect(poolIpOf("{ rotto", "m1")).toBeNull();
  });
});
