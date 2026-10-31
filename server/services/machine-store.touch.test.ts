/**
 * `touchNode` is the heartbeat of a paired node and nothing else: a probe that answers a few
 * seconds after it read the list must not put back the name or the address the row had then.
 *
 * @covers KANBAN-76
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createMachineStore } from "./machine-store";

function store() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const m of EMBEDDED_MIGRATIONS) db.run(m.sql);
  return { db, machines: createMachineStore(db, process.cwd()) };
}

describe("touchNode", () => {
  it("rimette online e data il battito, e non tocca né il nome né l'indirizzo cambiati nel frattempo", () => {
    const { db, machines } = store();
    const node = machines.upsertNode({ hostname: "pc:3393", name: "PC Windows", baseUrl: "http://127.0.0.1:3393" });
    db.run("UPDATE machines SET status = 'offline', last_heartbeat_at = '2026-10-26T15:53:00.000Z' WHERE id = ?", [node.id]);
    machines.rename(node.id, "PC di Attilio");
    db.run("UPDATE machines SET base_url = 'http://127.0.0.1:4444' WHERE id = ?", [node.id]);

    const touched = machines.touchNode(node.id)!;

    expect(touched.status).toBe("online");
    expect(touched.lastHeartbeatAt > "2026-10-26T15:53:00.000Z").toBe(true);
    expect(touched.name).toBe("PC di Attilio");
    expect(touched.baseUrl).toBe("http://127.0.0.1:4444");
  });

  it("una riga sparita nel frattempo non resuscita: null", () => {
    const { machines } = store();
    expect(machines.touchNode("non-esiste")).toBeNull();
  });
});

describe("markNodeOffline", () => {
  it("spegne subito un nodo in linea, qualunque sia il suo ultimo battito; una seconda volta non cambia niente", () => {
    const { machines } = store();
    const cloud = machines.upsertNode({ hostname: "claude-cloud", name: "Cloud Claude", baseUrl: "claude-cloud://" });
    expect(cloud.status).toBe("online");
    expect(machines.markNodeOffline(cloud.id)!.status).toBe("offline");
    expect(machines.get(cloud.id)!.status).toBe("offline");
    expect(machines.markNodeOffline(cloud.id)).toBeNull();
    expect(machines.markNodeOffline("non-esiste")).toBeNull();
  });
});
