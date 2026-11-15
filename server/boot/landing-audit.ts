import { existsSync } from "fs";
import { projectIdForPath } from "../services/tasks";
import { mainPushGit, sweepUnpushedMains } from "../services/main-on-origin";
import { worktreeDiffStat } from "../services/branch-status";
import { deliveryPointer } from "../services/own-commits";
import { resolveDeliveryBranch } from "../services/delivery-branch-ref";
import { buildProjectCandidates } from "../services/project-path-resolver";
import { backfillDeliveries as backfillDeliveriesPass } from "../services/delivery-backfill";
import { keepDeliveryCommit, pruneDeliveryRefs, DELIVERY_REF_RETENTION_DAYS } from "../services/delivery-ref-keep";
import { runLandingAudit as runLandingAuditPass, auditOneLanding as auditOneLandingPass, type AuditWiring } from "../services/landing-audit-pass";
import type { BootScope } from "../../server";

export function createLandingAudit(d: {
  broadcastToAll: BootScope["broadcastToAll"];
  ctx: BootScope["ctx"];
  DISPATCH_WORKSPACE_DIR: BootScope["DISPATCH_WORKSPACE_DIR"];
  dispatcherSvc: BootScope["dispatcherSvc"];
  dispatchExtraPaths: BootScope["dispatchExtraPaths"];
  listSelectableProjectDirs: BootScope["listSelectableProjectDirs"];
  deliveryBranchDeps: BootScope["deliveryBranchDeps"];
}) {
  const { broadcastToAll, ctx, DISPATCH_WORKSPACE_DIR, dispatcherSvc, dispatchExtraPaths, listSelectableProjectDirs, deliveryBranchDeps } = d;

  // ── Landing audit: "done" must mean "è nel prodotto" ───────────────────────
  // The GC above decides what is safe to DESTROY; this decides what has actually
  // ARRIVED. They are different questions, and the 19/07 loss lived in the gap:
  // the task said done, the branch was gone, the code was nowhere.
  //
  // Two steps per pass:
  //  1. BACKFILL — any review/done task with a live branch worktree but no
  //     recorded delivery gets its own most recent commit recorded now. Covers the
  //     paths that bypass the route PATCH (system-delivery from the dispatcher) and
  //     every task that predates the delivery snapshot.
  //  2. AUDIT — compare each recorded commit against main by CONTENT and stamp
  //     the verdict; the edge into `unlanded` posts a comment on the task.
  /**
   * Il cablaggio della passata di backfill: il COSA sta in
   * `services/delivery-backfill.ts`, qui restano solo le dipendenze vere.
   */
  function backfillDeliveries(): Promise<void> {
    return backfillDeliveriesPass({
      db: ctx.db,
      projectStore: ctx.projectStore,
      svc: dispatcherSvc,
      workspaceDir: DISPATCH_WORKSPACE_DIR,
      extraPaths: dispatchExtraPaths,
      buildProjectCandidates,
      deliveryBranchDeps,
      resolveDeliveryBranch,
      deliveryPointer,
      worktreeDiffStat,
      keepDeliveryCommit,
    });
  }

  const LANDING_AUDIT_INTERVAL_MS = 30 * 60_000;

  /**
   * Il cablaggio dell'audit: il COSA sta in `services/landing-audit-pass.ts`, qui
   * restano i cinque riferimenti che vivono davvero in questo file.
   */
  const auditWiring: AuditWiring = {
    projectStore: ctx.projectStore,
    workspaceDir: DISPATCH_WORKSPACE_DIR,
    extraPaths: dispatchExtraPaths,
    svc: dispatcherSvc as unknown as AuditWiring["svc"],
    broadcast: (msg) => broadcastToAll(msg as Parameters<typeof broadcastToAll>[0]),
    backfill: backfillDeliveries,
  };
  /**
   * THE BROOM OVER THE DELIVERY REFS, on the same pass as the audit and never on
   * a timer of its own: both walk the repositories, and two sweeps on the same
   * git are one collision waiting for the night nobody is watching.
   *
   * `TOPICS_DELIVERY_REF_RETENTION_DAYS=0` keeps every delivery reachable for
   * ever, which is a legitimate choice on a small board: a ref is 41 bytes, what
   * it pins is an object graph that then never shrinks.
   */
  const DELIVERY_REF_RETENTION = Number(
    process.env.TOPICS_DELIVERY_REF_RETENTION_DAYS ?? DELIVERY_REF_RETENTION_DAYS,
  );
  async function pruneKeptDeliveries(): Promise<void> {
    if (!Number.isFinite(DELIVERY_REF_RETENTION) || DELIVERY_REF_RETENTION <= 0) return;
    const vita = ctx.db.prepare("SELECT status, completed_at AS completedAt FROM tasks WHERE id = ?");
    const visti = new Set<string>();
    for (const p of ctx.projectStore.list()) {
      const path = p.path;
      if (!path || visti.has(path) || !existsSync(path)) continue;
      visti.add(path);
      try {
        const summary = await pruneDeliveryRefs({
          repoPath: path,
          retentionDays: DELIVERY_REF_RETENTION,
          // A card the database does not know is KEPT, not dropped: see the
          // decision in `delivery-ref-keep.ts`. One repository can carry the
          // deliveries of more than one board.
          lifeOf: (taskId) => {
            const row = vita.get(taskId) as { status?: string; completedAt?: string | null } | undefined;
            return { status: row?.status ?? null, completedAt: row?.completedAt ?? null };
          },
        });
        if (summary && summary.dropped.length > 0) {
          console.log(`[delivery-refs] ${summary.dropped.length} ref lasciati cadere, ${summary.kept} tenuti { repo: ${path} }`);
        }
      } catch (err) {
        console.warn("[delivery-refs] potatura fallita", err);
      }
    }
  }

  const runLandingAudit = async () => {
    await runLandingAuditPass(auditWiring);
    await pruneKeptDeliveries();
  };
  const auditOneLanding = (taskId: string) => auditOneLandingPass(auditWiring, taskId);

  // Offset from the GC pass so the two git sweeps don't collide on the same repo.
  const landingAuditBoot = setTimeout(runLandingAudit, 180_000);
  const landingAuditTimer = setInterval(runLandingAudit, LANDING_AUDIT_INTERVAL_MS);

  // ── LANDS LEFT BEHIND GO BACK TO ORIGIN. The push after a land can fail
  // (network, port 22 timing out on 10/11): every 10 minutes each project repo
  // retries, fast-forward only, and once main is on origin its `unpushed` cards
  // turn `landed`. Every repo, not only those with marked cards: a land made by
  // a server without this fix is behind all the same, and that is the measured case.
  const sweepUnpushedLands = async () => {
    const repos = new Set<string>();
    try { for (const d of listSelectableProjectDirs()) repos.add(d); } catch { /* best-effort */ }
    const pending = ctx.db.prepare(
      "SELECT id, project_id FROM tasks WHERE landing_state = 'unpushed' AND archived = 0",
    ).all() as Array<{ id: string; project_id: string }>;
    await sweepUnpushedMains([...repos], (repo, n) => {
      const pid = projectIdForPath(repo);
      if (n > 0) console.log(`[land-push] ${n} commit di main portati su origin { repo: ${repo} }`);
      for (const t of pending.filter((p) => p.project_id === pid)) {
        dispatcherSvc.recordLandingState({ taskId: t.id, state: "landed", checkedAt: new Date().toISOString(), witnessed: true });
        try {
          dispatcherSvc.addComment({ taskId: t.id, author: "system", kind: "service", content: "Main portato su origin: il land ora è anche su GitHub." });
        } catch { /* the line is a courtesy */ }
        const cur = dispatcherSvc.get(t.id)?.task;
        if (cur) broadcastToAll({ type: "task:updated", projectId: pid, task: cur } as Parameters<typeof broadcastToAll>[0]);
      }
    }, mainPushGit).then((out) => {
      for (const o of out) if (!o.result.ok) console.warn(`[land-push] ${o.repo}: ${o.result.reason}`);
    });
  };
  setTimeout(() => { void sweepUnpushedLands().catch((e) => console.warn("[land-push] spazzata fallita", e)); }, 240_000).unref?.();
  setInterval(() => { void sweepUnpushedLands().catch((e) => console.warn("[land-push] spazzata fallita", e)); }, 10 * 60_000).unref?.();

  return { auditOneLanding, landingAuditBoot, landingAuditTimer };
}
