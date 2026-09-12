import type { Database } from "bun:sqlite";
import type { NodeClient } from "./node-client";

export interface DelegatedRevocationRetry {
  tick(options?: { requestId?: string; force?: boolean }): Promise<{ attempted: number; pending: number }>;
}

interface PendingRevocationRow {
  id: string;
  direction: "origin" | "node";
  base_url: string | null;
  remote_request_id: string | null;
  claim_secret: string | null;
  capability_id: string | null;
  authorization_id: string | null;
}

export function createDelegatedRevocationRetry(input: {
  db: Database;
  nodeClient?: Pick<NodeClient, "revokeDelegatedRequest">;
  deleteBoardTask?: (projectId: string, taskId: string) => Promise<Response | null> | Response | null;
  now?: () => number;
  backoffMs?: number;
  log?: (message: string, error?: unknown) => void;
}): DelegatedRevocationRetry {
  const now = input.now ?? Date.now;
  const backoffMs = input.backoffMs ?? 10_000;
  let running: Promise<{ attempted: number; pending: number }> | null = null;

  async function run(options: { requestId?: string; force?: boolean } = {}) {
    const at = now();
    const clauses = ["revoke_pending=1"];
    const args: Array<string | number> = [];
    if (options.requestId) { clauses.push("id=?"); args.push(options.requestId); }
    if (!options.force) {
      clauses.push("(last_error IS NULL OR updated_at<=?)");
      args.push(at - backoffMs);
    }
    const rows = input.db.query(`SELECT * FROM delegated_node_requests WHERE ${clauses.join(" AND ")}`)
      .all(...args) as PendingRevocationRow[];
    let attempted = 0;
    for (const row of rows) {
      attempted += 1;
      if (row.direction === "origin") {
        if (!input.nodeClient || !row.base_url || !row.remote_request_id) continue;
        try {
          await input.nodeClient.revokeDelegatedRequest({
            baseUrl: row.base_url,
            requestId: row.remote_request_id,
            claim: row.claim_secret ?? undefined,
            capabilityId: row.capability_id ?? undefined,
          });
          input.db.query("UPDATE delegated_node_requests SET state='revoked',revoke_pending=0,last_error=NULL,updated_at=? WHERE id=? AND revoke_pending=1")
            .run(now(), row.id);
        } catch (error) {
          input.db.query("UPDATE delegated_node_requests SET last_error=?,updated_at=? WHERE id=? AND revoke_pending=1")
            .run(String(error), now(), row.id);
          input.log?.(`delegated origin revocation ${row.id} failed`, error);
        }
        continue;
      }
      if (row.direction !== "node" || !row.authorization_id || !input.deleteBoardTask) continue;
      const runs = input.db.query(`SELECT r.run_id,t.project_id
          FROM delegated_node_runs r LEFT JOIN tasks t ON t.id=r.run_id
         WHERE r.authorization_id=? AND r.cancel_confirmed_at IS NULL`)
        .all(row.authorization_id) as Array<{ run_id: string; project_id: string | null }>;
      let confirmed = true;
      for (const run of runs) {
        if (!run.project_id) {
          input.db.query("UPDATE delegated_node_runs SET cancel_confirmed_at=?,cancel_error=NULL WHERE run_id=?")
            .run(now(), run.run_id);
          continue;
        }
        try {
          const response = await input.deleteBoardTask(run.project_id, run.run_id);
          if (!response?.ok) throw new Error(`cancel returned ${response?.status ?? "no response"}`);
          input.db.query("UPDATE delegated_node_runs SET cancel_confirmed_at=?,cancel_error=NULL WHERE run_id=?")
            .run(now(), run.run_id);
        } catch (error) {
          confirmed = false;
          input.db.query("UPDATE delegated_node_runs SET cancel_error=? WHERE run_id=?")
            .run(String(error), run.run_id);
          input.log?.(`delegated node run ${run.run_id} cancellation failed`, error);
        }
      }
      if (confirmed) {
        input.db.query("UPDATE delegated_node_requests SET state='revoked',revoke_pending=0,last_error=NULL,updated_at=? WHERE id=? AND revoke_pending=1")
          .run(now(), row.id);
      } else {
        input.db.query("UPDATE delegated_node_requests SET last_error='delegated_cancel_unconfirmed',updated_at=? WHERE id=? AND revoke_pending=1")
          .run(now(), row.id);
      }
    }
    const pending = (input.db.query("SELECT COUNT(*) AS n FROM delegated_node_requests WHERE revoke_pending=1").get() as { n: number }).n;
    return { attempted, pending };
  }

  return {
    tick(options) {
      if (running) return running;
      running = run(options).finally(() => { running = null; });
      return running;
    },
  };
}
