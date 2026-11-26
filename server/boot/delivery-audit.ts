/**
 * The landing audit and the sweep of lands left behind.
 */
import { onProviderHold, providerHold } from "../lib/provider-hold";
import { releaseCodexHoldIfLoginChanged } from "../lib/codex-login-watch";
import { getAccessToken } from "../providers/native/auth";
import { releaseHoldIfEngineFree, releaseHoldIfFreed } from "../providers/native/usage-window";
import { engineHasFreeAccount } from "../providers/native/base-url";
import { existsSync } from "fs";
import { projectIdForPath } from "../services/tasks";
import { mainPushGit, sweepUnpushedMains } from "../services/main-on-origin";
import { pruneDeliveryRefs, DELIVERY_REF_RETENTION_DAYS } from "../services/delivery-ref-keep";
import { readBranchLives, sweepFinishedBranchesOnOrigin } from "../services/finished-branches-on-origin";
import { runLandingAudit as runLandingAuditPass } from "../services/landing-audit-pass";
import type { AfterReattach } from "./scope";

export function bootDeliveryAudit(scope: AfterReattach) {
  const { HOLD_RECHECK_MS, auditWiring, broadcastToAll, ctx, dispatcherSvc, listSelectableProjectDirs, worktreeGc } = scope;
  function scheduleHoldRecheck(): void {
    const t = setTimeout(() => {
      void (async () => {
        try {
          // The account engine first: the usage endpoint reads one account,
          // and on 18/11 it answered 429 for hours while the hold sat on.
          if (providerHold() && await releaseHoldIfEngineFree(engineHasFreeAccount)) {
            console.log("[provider-hold] lifted: the account engine has an account that can serve");
          }
          if (providerHold()) {
            const token = await getAccessToken();
            if (token && await releaseHoldIfFreed(token)) {
              console.log("[provider-hold] lifted: the usage endpoint no longer marks any window spent (current credential)");
            }
          }
          if (releaseCodexHoldIfLoginChanged()) {
            console.log("[provider-hold] lifted: the Codex CLI is logged in as a different account");
          }
        } catch (err) {
          console.error("[provider-hold] recheck failed", err);
        } finally {
          scheduleHoldRecheck();
        }
      })();
    }, HOLD_RECHECK_MS);
    t.unref?.();
  }

  scheduleHoldRecheck();

  // A plan hold just set is asked to the account engine at once, not at the
  // next 90 s tick: a hold read off one spent account would otherwise stop
  // the dispatcher and the wakes for that long every time it comes back.
  let engineCheckQueued = false;
  onProviderHold((hold) => {
    if (!hold || hold.window === "api-down" || engineCheckQueued) return;
    engineCheckQueued = true;
    const t = setTimeout(() => {
      engineCheckQueued = false;
      void releaseHoldIfEngineFree(engineHasFreeAccount)
        .then((lifted) => { if (lifted) console.log("[provider-hold] lifted at once: the account engine has an account that can serve"); })
        .catch((err) => console.error("[provider-hold] engine check failed", err));
    }, 5_000);
    t.unref?.();
  });


  // ── Worktree GC — origin fix for worktree pile-up ──────────────────────────
  // La decisione sta in `server/services/worktree-gc.ts` (`sweepWorktrees`), il
  // cablaggio in `server/services/worktree-gc-runner.ts`. Qui resta solo l'AVVIO:
  // il primo giro dopo il boot e la scopa periodica. Il runner si costruisce piu'
  // in alto, prima dei tre punti che lo usano, cosi' non si regge piu'
  // sull'hoisting di una `function` dichiarata in fondo al file.
  const worktreeGcBoot = setTimeout(() => { void worktreeGc.runWorktreeGc(); }, worktreeGc.bootDelayMs);

  const worktreeGcTimer = setInterval(() => { void worktreeGc.runWorktreeGc(); }, worktreeGc.intervalMs);


  const LANDING_AUDIT_INTERVAL_MS = 30 * 60_000;

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


  /**
   * A FINISHED CARD'S BRANCH LEAVES ORIGIN (`finished-branches-on-origin.ts`).
   * Same pass as the audit and the ref broom, for the same reason: they walk
   * the same repositories.
   */
  async function sweepFinishedBranches(): Promise<void> {
    const readLives = () => readBranchLives(ctx.db);
    const seen = new Set<string>();
    for (const p of ctx.projectStore.list()) {
      const path = p.path;
      if (!path || seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      try {
        const done = await sweepFinishedBranchesOnOrigin(path, readLives);
        if (!done) continue;
        if (done.deleted.length) {
          console.log(`[origin-branches] ${done.deleted.length} rami di card chiuse tolti da origin, ${Object.keys(done.archived).length} tenuti come tag archive/ { repo: ${path} }`);
        }
        if (done.problems.length) console.warn(`[origin-branches] ${path}: ${done.problems.slice(0, 5).join("; ")}`);
      } catch (err) {
        console.warn("[origin-branches] spazzata fallita", err);
      }
    }
  }

  const runLandingAudit = async () => {
    await runLandingAuditPass(auditWiring);
    await pruneKeptDeliveries();
    await sweepFinishedBranches();
  };


  // Offset from the GC pass so the two git sweeps don't collide on the same repo.
  const landingAuditBoot = setTimeout(runLandingAudit, 180_000);

  const landingAuditTimer = setInterval(runLandingAudit, LANDING_AUDIT_INTERVAL_MS);


  // ── LANDS LEFT BEHIND GO BACK TO ORIGIN. The push after a land can fail
  // (network, port 22 timing out on 10/11): every 10 minutes each project repo
  // retries, fast-forward only, and once main is on origin its `unpushed` cards
  // turn `landed`. Every repo, not only those with marked cards: a land made by
  // a server without this fix is behind all the same, and that is the measured case.
  // The last refusal said per repo: a pre-push hook that refuses on purpose says the same
  // thing every 10 minutes, and the log only needs it when it starts, changes or ends.
  const lastRefusal = new Map<string, string>();
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
      for (const o of out) {
        const reason = o.result.ok ? "" : o.result.reason;
        if (reason && reason !== lastRefusal.get(o.repo)) console.warn(`[land-push] ${o.repo}: ${reason}`);
        if (reason) lastRefusal.set(o.repo, reason); else lastRefusal.delete(o.repo);
      }
    });
  };

  setTimeout(() => { void sweepUnpushedLands().catch((e) => console.warn("[land-push] spazzata fallita", e)); }, 240_000).unref?.();

  setInterval(() => { void sweepUnpushedLands().catch((e) => console.warn("[land-push] spazzata fallita", e)); }, 10 * 60_000).unref?.();

  return { landingAuditBoot, landingAuditTimer, worktreeGcBoot, worktreeGcTimer };
}
