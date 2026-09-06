/**
 * MachineStore — Phase D · machines table CRUD + local heartbeat upsert.
 *
 * The local machine is identified by hostname (UNIQUE in the schema).
 * upsertLocal() is idempotent: it creates a new row on first run, then
 * just refreshes `last_heartbeat_at` / `last_seen_at` / `status` on
 * subsequent calls.
 */
import type { Database } from "bun:sqlite";
import { hostname, arch, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// La riga `machines` è servita al client tale e quale: la dichiarazione sta in
// `shared/types.ts` così non ce n'è una seconda copia in client/src/types.
export type { Machine } from "../../shared/types";
import type { Machine } from "../../shared/types";

export class MachineInUseError extends Error {
  constructor(
    public readonly topicCount: number,
    public readonly taskCount: number = 0,
  ) {
    super(
      `Machine has ${topicCount} topic(s) and ${taskCount} task(s). Clear or reassign them first.`,
    );
    this.name = "MachineInUseError";
  }
}

export interface MachineStore {
  /** Insert-or-refresh the local machine row. Returns the canonical row. */
  upsertLocal(): Machine;
  /** Mark every other machine whose heartbeat is older than `staleMs` as offline. Returns the rows that flipped. */
  markStaleOffline(staleMs: number): Machine[];
  get(id: string): Machine | null;
  getByHostname(host: string): Machine | null;
  list(): Machine[];
  rename(id: string, name: string): Machine | null;
  /**
   * Insert-or-refresh a PAIRED node row, keyed by hostname like the local one.
   * `baseUrl` is where it answers; the device token never comes through here.
   */
  upsertNode(input: { hostname: string; name: string; baseUrl: string }): Machine;
  /** How many tasks still name this machine. Feeds the MACHINE-01 conflict. */
  countTasks(id: string): number;
  delete(id: string): boolean;
}

function readDaemonVersion(baseDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createMachineStore(db: Database, baseDir: string): MachineStore {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO machines
        (id, name, hostname, arch, platform, daemon_version, status,
         last_heartbeat_at, last_seen_at, acknowledged_warnings,
         created_at, updated_at)
      VALUES
        ($id, $name, $hostname, $arch, $platform, $daemon_version, 'online',
         $now, $now, NULL,
         $now, $now)
    `),
    getById: db.prepare(`SELECT * FROM machines WHERE id = ?`),
    getByHostname: db.prepare(`SELECT * FROM machines WHERE hostname = ?`),
    list: db.prepare(`SELECT * FROM machines ORDER BY last_heartbeat_at DESC`),
    refresh: db.prepare(`
      UPDATE machines SET
        daemon_version = $daemon_version,
        status = 'online',
        last_heartbeat_at = $now,
        last_seen_at = $now,
        updated_at = $now
      WHERE id = $id
    `),
    markOffline: db.prepare(`
      UPDATE machines SET status = 'offline', updated_at = $now
      WHERE last_heartbeat_at < $threshold AND status = 'online' AND id != $localId
    `),
    listSinceFlip: db.prepare(`
      SELECT * FROM machines WHERE updated_at = $now AND status = 'offline' AND id != $localId
    `),
    rename: db.prepare(`UPDATE machines SET name = ?, updated_at = ? WHERE id = ?`),
    insertNode: db.prepare(`
      INSERT INTO machines
        (id, name, hostname, arch, platform, daemon_version, status,
         last_heartbeat_at, last_seen_at, acknowledged_warnings, base_url,
         created_at, updated_at)
      VALUES
        ($id, $name, $hostname, '', '', '0.0.0', 'online',
         $now, $now, NULL, $base_url,
         $now, $now)
    `),
    refreshNode: db.prepare(`
      UPDATE machines SET
        name = $name, base_url = $base_url, status = 'online',
        last_heartbeat_at = $now, last_seen_at = $now, updated_at = $now
      WHERE id = $id
    `),
    countTopics: db.prepare(`SELECT COUNT(*) as n FROM topics WHERE machine_id = ?`),
    countTasks: db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE machine_id = ?`),
    delete: db.prepare(`DELETE FROM machines WHERE id = ?`),
  };

  function rowToMachine(row: any): Machine {
    let warnings: Record<string, string> = {};
    if (row.acknowledged_warnings) {
      try { warnings = JSON.parse(row.acknowledged_warnings); } catch {}
    }
    return {
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      arch: row.arch,
      platform: row.platform,
      daemonVersion: row.daemon_version,
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastSeenAt: row.last_seen_at,
      acknowledgedWarnings: warnings,
      baseUrl: row.base_url ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function upsertLocal(): Machine {
    const host = hostname();
    const now = new Date().toISOString();
    const existing = stmts.getByHostname.get(host) as any;
    if (existing) {
      stmts.refresh.run({
        $id: existing.id,
        $daemon_version: readDaemonVersion(baseDir),
        $now: now,
      });
      const refreshed = stmts.getById.get(existing.id);
      if (!refreshed) throw new Error("upsertLocal: refreshed row vanished");
      return rowToMachine(refreshed);
    }
    const id = randomUUID();
    stmts.insert.run({
      $id: id,
      $name: host,
      $hostname: host,
      $arch: arch(),
      $platform: platform(),
      $daemon_version: readDaemonVersion(baseDir),
      $now: now,
    });
    const row = stmts.getById.get(id);
    if (!row) throw new Error("upsertLocal: insert succeeded but row missing");
    return rowToMachine(row);
  }

  function markStaleOffline(staleMs: number): Machine[] {
    const now = new Date().toISOString();
    const threshold = new Date(Date.now() - staleMs).toISOString();
    const local = stmts.getByHostname.get(hostname()) as any;
    const localId = local?.id ?? "";
    stmts.markOffline.run({ $now: now, $threshold: threshold, $localId: localId });
    const rows = stmts.listSinceFlip.all({ $now: now, $localId: localId }) as any[];
    return rows.map(rowToMachine);
  }

  return {
    upsertLocal,
    markStaleOffline,
    get(id) {
      const row = stmts.getById.get(id);
      return row ? rowToMachine(row) : null;
    },
    getByHostname(host) {
      const row = stmts.getByHostname.get(host);
      return row ? rowToMachine(row) : null;
    },
    list() {
      return (stmts.list.all() as any[]).map(rowToMachine);
    },
    upsertNode({ hostname: host, name, baseUrl }) {
      const now = new Date().toISOString();
      const existing = stmts.getByHostname.get(host) as { id: string } | null;
      const id = existing?.id ?? randomUUID();
      if (existing) {
        stmts.refreshNode.run({ $id: id, $name: name, $base_url: baseUrl, $now: now });
      } else {
        stmts.insertNode.run({
          $id: id, $name: name, $hostname: host, $base_url: baseUrl, $now: now,
        });
      }
      const row = stmts.getById.get(id);
      if (!row) throw new Error("upsertNode: row missing after write");
      return rowToMachine(row);
    },
    countTasks(id) {
      return (stmts.countTasks.get(id) as { n: number } | null)?.n ?? 0;
    },
    rename(id, name) {
      stmts.rename.run(name, new Date().toISOString(), id);
      const row = stmts.getById.get(id);
      return row ? rowToMachine(row) : null;
    },
    delete(id) {
      const topics = (stmts.countTopics.get(id) as { n: number } | null)?.n ?? 0;
      const tasks = (stmts.countTasks.get(id) as { n: number } | null)?.n ?? 0;
      if (topics > 0 || tasks > 0) throw new MachineInUseError(topics, tasks);
      const result = stmts.delete.run(id);
      return result.changes > 0;
    },
  };
}
