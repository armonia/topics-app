/**
 * The heartbeat of a paired node: the PC behind the tunnel never calls this server, so the ticker
 * asks it. A node that answers stays «online» (or comes back), one that does not is left to the sweep.
 *
 * @covers KANBAN-76
 */
import { describe, it, expect } from "bun:test";
import type { Machine } from "../../shared/types";
import { NodeError, type NodeClient } from "./node-client";
import { createNodeProbe, PROBE_RUN_ID } from "./node-heartbeat";

function machine(over: Partial<Machine> & { id: string }): Machine {
  return {
    name: over.id, hostname: over.id, arch: "", platform: "", daemonVersion: "0.0.0", status: "online",
    lastHeartbeatAt: "2026-10-26T15:53:00.000Z", lastSeenAt: "2026-10-26T15:53:00.000Z", acknowledgedWarnings: {},
    baseUrl: `http://${over.id}.test`, createdAt: "2026-10-26T15:53:00.000Z", updatedAt: "2026-10-26T15:53:00.000Z",
    ...over,
  };
}

type Answer = "not_found" | "unreachable" | "unauthorized" | "server_error" | "ok" | "hang";

function setup(rows: Machine[], answers: Record<string, Answer>, tokens: Record<string, string | null> = {}) {
  const asked: string[] = [];
  const refreshed: string[] = [];
  const revived: string[] = [];
  const release: Array<() => void> = [];
  const client: Pick<NodeClient, "readRun"> = {
    readRun: async ({ baseUrl, runId }) => {
      expect(runId).toBe(PROBE_RUN_ID);
      asked.push(baseUrl);
      const host = rows.find((r) => r.baseUrl === baseUrl)!.id;
      const answer = answers[host] ?? "not_found";
      if (answer === "hang") await new Promise<void>((resolve) => release.push(resolve));
      if (answer === "ok") return { status: "todo" } as never;
      if (answer === "hang") throw new NodeError("unreachable", "timed out");
      throw new NodeError(answer === "not_found" ? "not_found" : answer, answer, answer === "not_found" ? 404 : null);
    },
  };
  const probe = createNodeProbe({
    list: () => rows,
    client,
    tokenOf: (id) => (id in tokens ? tokens[id]! : "tok"),
    refresh: (node) => { refreshed.push(node.id); return { ...node, status: "online" }; },
    onRevived: (m) => revived.push(m.id),
    isCloud: (baseUrl) => baseUrl === "claude-cloud://",
  });
  return { probe, asked, refreshed, revived, release };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("il battito di un nodo accoppiato", () => {
  it("un nodo che risponde «run non trovato» è vivo: il battito si scrive, e se era offline torna in lista", async () => {
    const s = setup([machine({ id: "pc", status: "offline" }), machine({ id: "mini", status: "online" })], {});
    s.probe();
    await settle();

    expect(s.refreshed.sort()).toEqual(["mini", "pc"]);
    expect(s.revived).toEqual(["pc"]); // only the one that was offline is announced
  });

  it("un nodo che non risponde, o che non riconosce più questo dispositivo, non prende il battito", async () => {
    const s = setup(
      [machine({ id: "giu" }), machine({ id: "revocato" }), machine({ id: "rotto" })],
      { giu: "unreachable", revocato: "unauthorized", rotto: "server_error" },
    );
    s.probe();
    await settle();

    expect(s.asked).toHaveLength(3);
    expect(s.refreshed).toEqual([]);
  });

  it("uno che non risponde non ferma gli altri", async () => {
    const s = setup([machine({ id: "giu" }), machine({ id: "pc" })], { giu: "unreachable" });
    s.probe();
    await settle();

    expect(s.refreshed).toEqual(["pc"]);
  });

  it("senza token, per il Mac, per il cloud e per le righe senza indirizzo non parte nessuna richiesta", async () => {
    const s = setup(
      [machine({ id: "senzatoken" }), machine({ id: "mac", baseUrl: null }), machine({ id: "cloud", baseUrl: "claude-cloud://" })],
      {},
      { senzatoken: null },
    );
    s.probe();
    await settle();

    expect(s.asked).toEqual([]);
    expect(s.refreshed).toEqual([]);
  });

  it("un giro che resta appeso non ne accumula un altro sopra: il successivo parte quando il primo ha finito", async () => {
    const s = setup([machine({ id: "pc" })], { pc: "hang" });
    s.probe();
    await settle();
    s.probe();
    s.probe();
    await settle();
    expect(s.asked).toHaveLength(1);

    s.release.forEach((r) => r());
    await settle();
    s.probe();
    await settle();
    expect(s.asked).toHaveLength(2);
  });
});
