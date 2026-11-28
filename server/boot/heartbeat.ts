/**
 * Node heartbeat, UI-state backup and the dev bundle watchers.
 */
import { startUiStateBackupTicker, snapshotUiStateNow } from "../services/ui-state-backup";
import { reconcile } from "../services/retirement";
import { SERVER_VERSION } from "../ws-capabilities";
import { createActivityRouter } from "../routes/activity";
import { hostname as osHostname } from "node:os";
import { createNodeClient, readNodeToken } from "../services/node-client";
import { createNodeProbe } from "../services/node-heartbeat";
import { releaseBootHold } from "../lib/primary-role";
import { CLOUD_NODE_BASE_URL, CLOUD_NODE_HOST, isCloudBaseUrl } from "../providers/claude-cloud/node";
import { initVapid } from "../push-service";
import { execFile } from "node:child_process";
import { projectIdForPath } from "../services/tasks";
import {
  findProjectDirForRepo,
  readPrReviewConfig,
  createPrReviewDeps,
  startPrReviewTick,
} from "../services/revisione-pr";
import { startDevBundleReload } from "../lib/dev-bundle-reload";
import { startBundleProbe } from "../lib/bundle-probe";
import type { AfterRouters2 } from "./scope";

export async function bootHeartbeat(scope: AfterRouters2) {
  const { PUBLIC_DIR, broadcastToAll, cloudEnabled, cloudNode, ctx, dispatcherSvc, listSelectableProjectDirs, retirementConsequences } = scope;
  // Phase D — heartbeat ticker. Upserts the local machine row every 30 s
  // and flips other machines that haven't checked in for 5 minutes to
  // `offline`. Cheap (one indexed UPDATE + one indexed SELECT per tick).
  const HEARTBEAT_INTERVAL_MS = 30_000;

  const STALE_THRESHOLD_MS = 5 * 60_000;

  // A paired node (the PC) never calls us, so the ticker asks it (`node-heartbeat.ts`). The probe has
  // its own client: a short deadline, because a hung tunnel must not hold a round for ever.
  const probeNodes = createNodeProbe({
    list: () => ctx.machineStore.list(),
    client: createNodeClient({
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }),
      now: () => Date.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      version: SERVER_VERSION,
      hostname: osHostname(),
    }),
    tokenOf: (machineId) => readNodeToken(ctx.STATE_DIR, machineId),
    touch: (machineId) => ctx.machineStore.touchNode(machineId),
    onRefreshed: (machine) => ctx.broadcastToAll({ type: "machine:upserted", machine, payload_version: 1 }),
    recordReported: (machineId, input) => ctx.machineStore.recordReported(machineId, input),
    recordWorktreeReport: (machineId, report) => ctx.machineStore.recordWorktreeReport(machineId, report),
    isCloud: isCloudBaseUrl,
    log: (message, err) => console.warn(`[Heartbeat] ${message}`, err),
  });

  let lastCloudOffline: string | null = null;
  function tickHeartbeat() {
    try {
      const local = ctx.machineStore.upsertLocal();
      ctx.broadcastToAll({ type: "machine:upserted", machine: local, payload_version: 1 });
      // La macchina cloud non manda heartbeat: è viva finché c'è la sua riga, quindi la
      // rinfreschiamo noi, o dopo 5 minuti la card direbbe «non risponde» su un servizio vivo.
      // Solo se il cloud è acceso QUI: una riga rimasta da un avvio di prima, a cloud spento,
      // deve diventare «non risponde» col giro normale invece di restare in linea.
      // And only while the account has an active cloud environment: without one the node
      // answers but can start nothing (30/10: the Keychain login moved to an account with no
      // environments), and "online" sent cards there. Asked from here, at most every 5 minutes.
      const cloud = cloudEnabled ? ctx.machineStore.getByHostname(CLOUD_NODE_HOST) : null;
      if (cloud && isCloudBaseUrl(cloud.baseUrl)) {
        void cloudNode.probeEnvironment();
        const env = cloudNode.environmentReady();
        if (env && !env.ok) {
          const off = ctx.machineStore.markNodeOffline(cloud.id);
          if (off) {
            // Once per cause: the same refusal is not written again on every beat.
            if (lastCloudOffline !== env.reason) console.warn(`[claude-cloud] offline: ${env.reason}`);
            lastCloudOffline = env.reason;
            ctx.broadcastToAll({ type: "machine:updated", machine: off, payload_version: 1 });
          }
        } else {
          lastCloudOffline = null;
          ctx.machineStore.upsertNode({ hostname: CLOUD_NODE_HOST, name: cloud.name, baseUrl: CLOUD_NODE_BASE_URL });
        }
      }
      probeNodes();
      const flipped = ctx.machineStore.markStaleOffline(STALE_THRESHOLD_MS);
      for (const m of flipped) {
        ctx.broadcastToAll({ type: "machine:updated", machine: m, payload_version: 1 });
      }
    } catch (err) {
      console.warn("[Heartbeat] tick failed:", err);
    }
  }

  tickHeartbeat();
  // The first round of node calls is what tells a primary back from a trip whether a node claimed
  // its place meanwhile: its own writers wait for it (`holdInternalWritesUntilNodesAnswer`, track T9).
  void probeNodes().finally(releaseBootHold);

  const heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Automatic review of PRs opened after boot; off until REVIEW_PR_REPO and REVIEW_PR_WORKFLOW are set.
  // Confirmed defects become a card in review on the board of the project whose `origin` is that repo.
  const originOf = (dir: string) =>
    new Promise<string | null>((resolve) => {
      execFile("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
    });
  const projectDirOf = (repo: string) => findProjectDirForRepo(repo, listSelectableProjectDirs(), originOf);
  startPrReviewTick(
    readPrReviewConfig(process.env, ctx.APP_DATA_DIR),
    createPrReviewDeps({
      hasBoard: async (repo) => (await projectDirOf(repo)) !== null,
      openCard: async (card) => {
        const dir = await projectDirOf(card.repo);
        if (!dir) throw new Error(`no project owns ${card.repo}`);
        const projectId = projectIdForPath(dir);
        const task = dispatcherSvc.create({
          projectId,
          text: card.title,
          description: card.description,
          status: "review",
          createdBy: "cron:revisione-pr",
          idempotencyKey: card.idempotencyKey,
        });
        broadcastToAll({ type: "task:updated", projectId, task });
      },
    }),
  );


  // I registri d'accordo col fatto, a ogni avvio.
  //
  // È questo passo che rende vera la verifica del task: chiudi una tab, riavvia,
  // riapri — niente ricompare, niente processo resta. Una chiusura le cui
  // conseguenze si erano perse (la fetch morta col `pagehide`, l'altro
  // dispositivo) viene onorata qui, in ritardo ma una volta sola.
  //
  // Prima del ripristino del roster dei terminali: una sessione che il fatto sa
  // ritirata non va nemmeno rianimata, e a riga già cancellata `restoreSessions`
  // non ha niente da ricreare. Convergente — su uno stato pulito non scrive.
  try {
    const rec = reconcile(ctx.db, retirementConsequences);
    if (rec.examined > 0) {
      console.log(
        `[retirement] riconcilio: ${rec.examined} divergenze → ` +
        `${rec.topicsArchived} chat chiuse, ${rec.terminalsRetired} sessioni ritirate, ${rec.topicsStamped} timbrate`,
      );
    }
  } catch (err) {
    console.warn("[retirement] riconcilio al boot fallito:", err);
  }


  // Periodic ui_state backup — defence-in-depth against accidental wipes.
  // Snapshot once at startup so any pre-restart state is preserved on disk
  // before any client PUT can overwrite it; then the ticker takes over.
  try {
    snapshotUiStateNow(ctx.db);
    console.log(`[UiStateBackup] initial snapshot written → ~/.topics/ui-state-backups/`);
  } catch (err) {
    console.warn("[UiStateBackup] initial snapshot failed:", err);
  }

  const stopUiStateBackup = startUiStateBackupTicker(ctx.db);


  // Wire snapshot manager → WS broadcast. Single 100ms debounce coalesces
  // the multiple "loading → ready" transitions a single refresh fires.
  {
    // Lazy require to keep this block the only load site (avoid stale singletons in --watch mode).
    const { getSnapshotManager } = await import("../providers/snapshot-manager");
    const snapMgr = getSnapshotManager();
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const SNAPSHOT_BROADCAST_DEBOUNCE_MS = 100;
    snapMgr.on("change", () => {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        broadcastToAll({ type: "providers:snapshot", snapshot: snapMgr.getSnapshot() });
      }, SNAPSHOT_BROADCAST_DEBOUNCE_MS);
    });
    // Trigger an initial warm-up so clients connecting at startup get fresh data.
    void snapMgr.refresh();
  }


  // Initialize VAPID keys on startup, in the state folder the primary switch collects.
  initVapid(ctx.STATE_DIR);

  // Dev bundle hot-delivery: rebuilt /public → open windows self-reload.
  // Inert unless STATE_DIR/topics-dev.json exists (never in standalone installs).
  // getRev() also feeds the WS open handler: every (re)connecting window gets
  // the current bundle rev and self-reloads if stale — covers deploys that
  // landed while the watcher was off or the window was disconnected.
  const devBundleReload = startDevBundleReload({
    publicDir: PUBLIC_DIR,
    stateDir: ctx.STATE_DIR,
    broadcastToAll,
  });


  // The bundle probe: `public/` gone while the server is up is an alarm, not a
  // detail. It is the only thing that measures what people actually load - the
  // gates look at the code, the land looked at the branch. Its verdict is also
  // on `/__daemon/healthz`, so a script can ask.
  const bundleProbe = startBundleProbe({ publicDir: PUBLIC_DIR });


  // NOTE: the session attention monitor is NOT auto-started. It runs only when
  // the user enables it from Topics (POST /api/master/monitor) — nothing runs
  // "a caso". Default OFF on every server start. See session-monitor.ts.

  // Activity LOG (audit trail) — the live gateway-log feed is gone.
  const activityRouter = createActivityRouter(ctx);

  return { activityRouter, bundleProbe, devBundleReload, heartbeatTimer, stopUiStateBackup };
}
