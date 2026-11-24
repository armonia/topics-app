/**
 * Hooks the security alerts (`lib/machine-security-alerts.ts`) to the board:
 * after each machines-health round, a red check opens one card and a check
 * that is green again closes it. The board is a setting; without one, nothing
 * happens.
 */
import { readFile } from "node:fs/promises";
import type { AppContext } from "../types";
import type { MachineSecurity } from "../../shared/machine-health";
import { writeJsonAtomic } from "../lib/machine-health";
import { ALERT_KEY_PREFIX, securityAlerts, type TrackedChecks } from "../lib/machine-security-alerts";
import type { TaskService } from "../services/tasks-service-types";

/** A card's idempotency key is `<alert key>@<time>`: one episode per key, so a check that goes red again after a close opens a new card. */
const EPISODE_SEP = "@";

/**
 * The alert key of a card, cut at the LAST separator: an ssh server's machine
 * id carries an `@` of its own (`ssh:root@host`), and a cut at the first one
 * lost the card, so every round opened a new one (22 cards in two hours).
 */
function alertKeyOf(idempotencyKey: string): string {
  const at = idempotencyKey.lastIndexOf(EPISODE_SEP);
  return at < 0 ? idempotencyKey : idempotencyKey.slice(0, at);
}

export interface AlertBoardDeps {
  db: AppContext["db"];
  svc: TaskService;
  broadcast: (event: { type: "task:updated"; projectId: string; task: unknown }) => void;
  /** The board that receives the cards; `null` = none. */
  projectId: () => string | null;
  statePath: string;
  now: () => number;
}

export function createSecurityAlertsRound(deps: AlertBoardDeps) {
  return async (machines: Record<string, { name: string; security: MachineSecurity }>): Promise<void> => {
    const projectId = deps.projectId();
    if (!projectId) return;
    let prev: TrackedChecks = {};
    try { prev = JSON.parse(await readFile(deps.statePath, "utf8")) as TrackedChecks; } catch { /* first round */ }

    const rows = deps.db
      .query("SELECT id, claude_task_id FROM tasks WHERE project_id = ? AND claude_task_id LIKE ? AND archived = 0 AND status != 'done'")
      .all(projectId, `${ALERT_KEY_PREFIX}%`) as Array<{ id: string; claude_task_id: string }>;
    const idByKey = new Map(rows.map((r) => [alertKeyOf(r.claude_task_id), r.id]));

    const plan = securityAlerts(prev, machines, new Set(idByKey.keys()), deps.now());
    for (const a of plan.open) {
      const task = deps.svc.create({
        projectId, text: a.title, status: "todo", createdBy: "cron:machine-security",
        idempotencyKey: `${a.key}${EPISODE_SEP}${deps.now()}`,
        description: `A security check reported: ${a.detail}\n\nThe card closes by itself when the check is green again.`,
        bar: "The check is back to ok in the next security round.",
        // The hub measured this machine, so the hub is where it can be reached
        // (itself, or its ssh keys for a server). On a free node slot the agent
        // would see neither: card 07936f60 went to a cloud node for the hub's
        // own pending update.
        stayLocal: true,
        stayLocalReason: "security check: only the hub that measured the machine can reach it",
      });
      deps.broadcast({ type: "task:updated", projectId, task });
    }
    for (const c of plan.close) {
      const taskId = idByKey.get(c.key);
      if (!taskId) continue;
      deps.svc.addComment({ taskId, author: "system", kind: "service", content: `Back to ok: ${c.outcome}`, projectId });
      const task = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { status: "done" } });
      deps.broadcast({ type: "task:updated", projectId, task });
    }
    await writeJsonAtomic(deps.statePath, plan.tracked);
  };
}
