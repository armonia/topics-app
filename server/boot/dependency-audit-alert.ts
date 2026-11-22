/**
 * The daily dependency audit (`.github/workflows/dependency-audit.yml`) only
 * fails on GitHub; nothing in the server read it. This round asks GitHub for
 * the workflow's latest finished run: red opens one card on the security
 * alerts board, green closes it. The open card is the state: while one exists
 * a red run opens nothing more. The board is a setting; without one, nothing
 * happens.
 */
import type { AppContext } from "../types";
import { ALERT_KEY_PREFIX } from "../lib/machine-security-alerts";
import type { TaskService } from "../services/tasks-service-types";

export const DEPENDENCY_AUDIT_KEY = `${ALERT_KEY_PREFIX}dependency-audit`;
const EPISODE_SEP = "@";
const DEFAULT_REPO = "armonia/topics-app";
const WORKFLOW_FILE = "dependency-audit.yml";
export const AUDIT_POLL_MS = 3_600_000;

export interface AuditRun {
  /** `success` or `failure` (anything else counts as red except the neutral ones skipped by the fetcher). */
  conclusion: string;
  url: string;
}

/** The latest finished run on main, or `null` when there is none or GitHub did not answer. */
export async function fetchLatestAuditRun(repo: string = process.env.DEPENDENCY_AUDIT_REPO || DEFAULT_REPO): Promise<AuditRun | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&status=completed&per_page=1`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "topics" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;
    const run = ((await res.json()) as { workflow_runs?: Array<{ conclusion: string | null; html_url: string }> }).workflow_runs?.[0];
    if (!run?.conclusion || run.conclusion === "cancelled" || run.conclusion === "skipped") return null;
    return { conclusion: run.conclusion, url: run.html_url };
  } catch {
    return null;
  }
}

export interface AuditBoardDeps {
  db: AppContext["db"];
  svc: TaskService;
  broadcast: (event: { type: "task:updated"; projectId: string; task: unknown }) => void;
  /** The board that receives the cards; `null` = none. */
  projectId: () => string | null;
  latestRun: () => Promise<AuditRun | null>;
  now: () => number;
}

export function createDependencyAuditRound(deps: AuditBoardDeps) {
  return async (): Promise<void> => {
    const projectId = deps.projectId();
    if (!projectId) return;
    const run = await deps.latestRun();
    if (!run) return; // no reading is not a green reading
    const open = deps.db
      .query("SELECT id FROM tasks WHERE project_id = ? AND claude_task_id LIKE ? AND archived = 0 AND status != 'done'")
      .get(projectId, `${DEPENDENCY_AUDIT_KEY}${EPISODE_SEP}%`) as { id: string } | null;

    if (run.conclusion !== "success") {
      if (open) return;
      const task = deps.svc.create({
        projectId, text: "Dependency audit is red: a new advisory", status: "todo", createdBy: "cron:dependency-audit",
        idempotencyKey: `${DEPENDENCY_AUDIT_KEY}${EPISODE_SEP}${deps.now()}`,
        description: `The daily dependency audit failed; the run names the package and the advisory: ${run.url}\n\nThe card closes by itself when the audit is green again.`,
        bar: "The next daily dependency audit run is green.",
      });
      deps.broadcast({ type: "task:updated", projectId, task });
    } else if (open) {
      deps.svc.addComment({ taskId: open.id, author: "system", kind: "service", content: `Back to green: ${run.url}`, projectId });
      const task = deps.svc.update({ taskId: open.id, actor: "human", by: "system", projectId, patch: { status: "done" } });
      deps.broadcast({ type: "task:updated", projectId, task });
    }
  };
}
