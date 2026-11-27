import type { Database } from "bun:sqlite";
import type { NodeClient } from "./node-client";
import { recordNotificationRow } from "../notification-registry";
import type { NotificationRecordInput } from "../../shared/notification-log";

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
  last_error: string | null;
}

// A `blocks_live_dependent` 409 from the board is not a transient failure: the
// cancel will keep failing until a human (or another automated change)
// resolves the dependent, not after a short network-style backoff. Tagging
// the error "blocked:" lets the retry pick a much longer wait for it, instead
// of busy-looping on a condition that will not clear itself tick after tick.
const BLOCKED_ERROR_PREFIX = "blocked:";

// A `blocks_live_dependent` 409 is not just slow to clear, it is DEFINITIVE:
// nothing this retry does will ever change it, only a human (or another
// agent) finishing or archiving the dependent will. Review feedback 26/11,
// point 3: the generic "blocked:" backoff above kept retrying it forever,
// tick after tick and boot after boot, with nobody told. This specific tag
// stops the retry (`revoke_pending=0`) and raises one notification instead.
const BLOCKS_LIVE_DEPENDENT_TAG = `${BLOCKED_ERROR_PREFIX}blocks_live_dependent`;

// Distinguishes a `blocks_live_dependent` 409 (the board refusing a cancel on
// a card that still blocks a live dependent) from any other failure, so the
// caller can give it the much longer backoff above instead of hammering it.
async function blockedErrorMessage(response: Response | null | undefined): Promise<string> {
  if (response?.status !== 409) return `cancel returned ${response?.status ?? "no response"}`;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    if (typeof body?.code === "string" && body.code) return `${BLOCKED_ERROR_PREFIX}${body.code}`;
  } catch { /* body not readable as JSON, fall through to the generic tag */ }
  return `${BLOCKED_ERROR_PREFIX}409`;
}

export function createDelegatedRevocationRetry(input: {
  db: Database;
  nodeClient?: Pick<NodeClient, "revokeDelegatedRequest">;
  deleteBoardTask?: (projectId: string, taskId: string) => Promise<Response | null> | Response | null;
  now?: () => number;
  backoffMs?: number;
  log?: (message: string, error?: unknown) => void;
  notify?: (input: NotificationRecordInput) => void;
}): DelegatedRevocationRetry {
  const now = input.now ?? Date.now;
  const notify = input.notify ?? recordNotificationRow;
  const backoffMs = input.backoffMs ?? 10_000;
  // A blocked cancel waits a lot longer than a plain transient failure: there is
  // no point hammering a 409 that only a dependent finishing or archiving can clear.
  const blockedBackoffMs = backoffMs * 60;
  let running: Promise<{ attempted: number; pending: number }> | null = null;

  async function run(options: { requestId?: string; force?: boolean } = {}) {
    const at = now();
    const clauses = ["revoke_pending=1"];
    const args: Array<string | number> = [];
    if (options.requestId) { clauses.push("id=?"); args.push(options.requestId); }
    if (!options.force) {
      clauses.push(
        `(last_error IS NULL
          OR (last_error NOT LIKE '${BLOCKED_ERROR_PREFIX}%' AND updated_at<=?)
          OR (last_error LIKE '${BLOCKED_ERROR_PREFIX}%' AND updated_at<=?))`,
      );
      args.push(at - backoffMs, at - blockedBackoffMs);
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
      let blockedMessage: string | null = null;
      let liveDependentRunId: string | null = null;
      for (const run of runs) {
        if (!run.project_id) {
          input.db.query("UPDATE delegated_node_runs SET cancel_confirmed_at=?,cancel_error=NULL WHERE run_id=?")
            .run(now(), run.run_id);
          continue;
        }
        try {
          const response = await input.deleteBoardTask(run.project_id, run.run_id);
          if (!response?.ok) {
            const message = await blockedErrorMessage(response);
            if (message.startsWith(BLOCKED_ERROR_PREFIX)) blockedMessage = message;
            if (message === BLOCKS_LIVE_DEPENDENT_TAG) liveDependentRunId = run.run_id;
            throw new Error(message);
          }
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
      } else if (liveDependentRunId) {
        // Terminal: stop retrying (`revoke_pending=0`) and tell a person once.
        // The state stays whatever it was (not "revoked" — the cancel never
        // happened), `last_error` keeps saying why for whoever opens the row.
        input.db.query("UPDATE delegated_node_requests SET revoke_pending=0,last_error=?,updated_at=? WHERE id=? AND revoke_pending=1")
          .run(BLOCKS_LIVE_DEPENDENT_TAG, now(), row.id);
        notify({
          kind: "task-parked",
          title: "Una revoca delegata e' bloccata da un dipendente vivo",
          body: `La card ${liveDependentRunId} blocca ancora un dipendente: la revoca non riprovera' da sola, serve finire o archiviare quel dipendente.`,
          targetKind: "task",
          targetId: liveDependentRunId,
          dedupeKey: `delegated-revocation-blocked:${row.id}`,
          source: "push",
        });
      } else {
        input.db.query("UPDATE delegated_node_requests SET last_error=?,updated_at=? WHERE id=? AND revoke_pending=1")
          .run(blockedMessage ?? "delegated_cancel_unconfirmed", now(), row.id);
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
