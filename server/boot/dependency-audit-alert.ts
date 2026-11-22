/**
 * The daily dependency audit workflow only fails on GitHub; nothing in the
 * server read it. This round asks GitHub for the workflow's latest finished
 * run: red opens one card on the security alerts board, green closes it.
 * The card is tied to the run id, so a card closed by hand never comes back
 * for the same red run. The board is a setting and the repo is derived from
 * that project's git remote (or `DEPENDENCY_AUDIT_REPO`); without either,
 * no call is made.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { ALERT_KEY_PREFIX } from "../lib/machine-security-alerts";
import type { TaskService } from "../services/tasks-service-types";

export const DEPENDENCY_AUDIT_KEY = `${ALERT_KEY_PREFIX}dependency-audit`;
const EPISODE_SEP = "@";
const WORKFLOW_FILE = "dependency-audit.yml";
export const AUDIT_POLL_MS = 3_600_000;
/** Conclusions that say the audit itself did not run, not that it found something. */
const NOT_RUN = new Set(["timed_out", "startup_failure", "action_required", "neutral", "stale"]);

export interface AuditRun {
  id: number;
  /** `success`, `failure`, or one of the `NOT_RUN` conclusions. */
  conclusion: string;
  url: string;
}

export interface AuditSource {
  repo: string;
  workflow: string;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

/** `owner/name` out of a GitHub remote URL (ssh or https), or `null`. */
export function parseGithubRepo(url: string): string | null {
  return url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

/** Repo and workflow of the board's project: explicit env wins, else its git remote and its workflow file. */
export async function resolveAuditSource(projectPath: string | null): Promise<AuditSource | null> {
  const workflowOnDisk = projectPath && existsSync(join(projectPath, ".github", "workflows", WORKFLOW_FILE)) ? WORKFLOW_FILE : null;
  const workflow = process.env.DEPENDENCY_AUDIT_WORKFLOW || workflowOnDisk;
  if (!workflow) return null;
  const repo = process.env.DEPENDENCY_AUDIT_REPO
    || (projectPath ? parseGithubRepo((await run("git", ["-C", projectPath, "remote", "get-url", "origin"])) ?? "") : null);
  return repo ? { repo, workflow } : null;
}

async function githubToken(): Promise<string | null> {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (await run("gh", ["auth", "token"])) || null;
}

/** The latest finished run, or `null` when there is none or GitHub did not answer (the reason is logged). */
export async function fetchLatestAuditRun(source: AuditSource, log: (msg: string) => void = console.warn): Promise<AuditRun | null> {
  try {
    const token = await githubToken();
    const res = await fetch(
      `https://api.github.com/repos/${source.repo}/actions/workflows/${source.workflow}/runs?status=completed&per_page=1`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "topics", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      log(`[dependency-audit] GitHub answered ${res.status} for ${source.repo}${token ? "" : " (no token: set GITHUB_TOKEN or sign in with gh)"}`);
      return null;
    }
    const latest = ((await res.json()) as { workflow_runs?: Array<{ id: number; conclusion: string | null; html_url: string }> }).workflow_runs?.[0];
    if (!latest?.conclusion || latest.conclusion === "cancelled" || latest.conclusion === "skipped") return null;
    return { id: latest.id, conclusion: latest.conclusion, url: latest.html_url };
  } catch (err) {
    log(`[dependency-audit] could not read the audit run: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface AuditBoardDeps {
  db: AppContext["db"];
  svc: TaskService;
  broadcast: (event: { type: "task:updated"; projectId: string; task: unknown }) => void;
  /** The board that receives the cards; `null` = none. */
  projectId: () => string | null;
  latestRun: (projectId: string) => Promise<AuditRun | null>;
}

export function createDependencyAuditRound(deps: AuditBoardDeps) {
  return async (): Promise<void> => {
    const projectId = deps.projectId();
    if (!projectId) return;
    const run = await deps.latestRun(projectId);
    if (!run) return; // no reading is not a green reading
    const keyOf = (id: number | string) => `${DEPENDENCY_AUDIT_KEY}${EPISODE_SEP}${id}`;
    const open = deps.db
      .query("SELECT id FROM tasks WHERE project_id = ? AND claude_task_id LIKE ? AND archived = 0 AND status != 'done'")
      .get(projectId, `${DEPENDENCY_AUDIT_KEY}${EPISODE_SEP}%`) as { id: string } | null;

    if (run.conclusion !== "success") {
      if (open) return;
      // Closed by hand or by a fix: the same red run must not reopen it.
      const seen = deps.db.query("SELECT 1 FROM tasks WHERE project_id = ? AND claude_task_id = ?").get(projectId, keyOf(run.id));
      if (seen) return;
      const notRun = NOT_RUN.has(run.conclusion);
      const task = deps.svc.create({
        projectId, status: "todo", createdBy: "cron:dependency-audit", idempotencyKey: keyOf(run.id),
        text: notRun ? "Dependency audit did not run: the CI job did not start" : "Dependency audit is red: a new advisory",
        description: notRun
          ? `The daily dependency audit ended as ${run.conclusion} without checking anything: ${run.url}\n\nThe card closes by itself when the audit is green again.`
          : `The daily dependency audit failed; the run names the package and the advisory: ${run.url}\n\nThe card closes by itself when the audit is green again.`,
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
