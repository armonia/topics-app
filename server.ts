import { createLandingQueue } from "./server/services/landing-queue";
import { basename, join, resolve, sep } from "path";
import { finalizeOrphanTool } from "./server/lib/orphan-tool-sweep";
import { bonificaTurniMuti } from "./server/lib/verdetto-turno-interrotto";
import { riprendiTurniInterrotti } from "./server/lib/ripresa-boot";
import { providerHold, holdUntilLabel, onProviderHold } from "./server/lib/provider-hold";
import { spiegaTurnoTroncato } from "./server/lib/turno-troncato";
import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync, rmSync, readlinkSync, realpathSync } from "fs";
import { timingSafeEqual } from "crypto";
import type { ServerWebSocket } from "bun";
import type { WSData } from "./server/types";
import { createAppContext } from "./server/utils";
import { closeDatabase } from "./server/db";
import { shouldServeSpaFallback } from "./server/spa-fallback";
import { classifyStaticAsset } from "./server/static-assets";
import {
  acquireLock, releaseLock, writeState, readState,
  uptimeMsSince, LiveLockError, worktreeIsolationHome, worktreeIsolationEnv, topicsHome,
} from "./server/services/daemon-state";
import {
  startUiStateBackupTicker, snapshotUiStateNow,
} from "./server/services/ui-state-backup";
import { purgeOrphanTopicRefs } from "./server/services/ui-state-orphan-cleanup";
import {
  sweepArchivedTaskBrowserState,
  teardownArchivedTaskBrowserState,
} from "./server/services/task-tab-teardown";
import { createTopicsRouter, purgeTopicFromUiState } from "./server/routes/topics";
import { archiveTopicFully } from "./server/services/archive-topic";
import { applyPaneCascade, reconcile, recordRetirement, retiredIds, type ReconcileDeps } from "./server/services/retirement";
import { computeCascade } from "./server/services/pane-retirement-cascade";
import { createOpenRouter } from "./server/routes/open";
import { configureSessionParkingForTracker, parkTopicSession } from "./server/lib/session-parking";
import { setUploadRootsProvider } from "./server/browser-tool-dispatcher";
import { setLocalFileServing } from "./server/browser-local-file-url";
import { uploadAllowedRoots, parseExtraRoots } from "./server/lib/upload-allowlist";
import { servedFileHeaders } from "./server/lib/served-file-headers";
import { sweepStaleStreams, type SilenceMark } from "./server/lib/stale-stream-sweep";
import { timelineWithInterruptedVerdict } from "./server/lib/interrupted-turn-block";
import type { ContentBlock } from "./shared/types";
import { describeInFlight, unadoptableStreams, quiescenceVerdict, reloadHeldNotice } from "./server/lib/quiescence";
import { dispatchReconcileHeld } from "./server/lib/e2e-dispatch-hold";
import { chatsParkedOnQuestion } from "./server/lib/parked-asks";
import { touchReloadDeferred, clearReloadDeferred } from "./server/lib/reload-deferred";
import { sondaPorta, messaggioEsito, sondaRealeDeps } from "./server/lib/port-squatter";
import { giroIdleGc, IDLE_GC_EVERY_MS } from "./server/lib/idle-gc";
import { configureNativeHistorySource } from "./server/providers/native/history-rehydrate";
import { createVoiceRouter } from "./server/routes/voice";
import { createMediaRouter } from "./server/routes/media";
import { createBranchesRouter } from "./server/routes/branches";
import { createFilesRouter } from "./server/routes/files";
import { createBrowserRouter } from "./server/routes/browser";
import { createCronRouter } from "./server/routes/cron";
import { createContextRouter } from "./server/routes/context";
import { createOrphanCensusRunner } from "./server/services/orphan-census";
import { createTerminalRouter, handleTerminalWebSocket, disconnectBridge, getClaudeSessionsForDetection, getClaudeSessionPtyIdleMs, setTerminalBrowserCloser, countAttachedTerminalSessions, countBusyAgentTerminals, listTerminalSessionSnapshot, parkOrphanSessions, retireTerminalSession } from "./server/routes/terminal";
import { createStatusRouter } from "./server/routes/status";
import { createMemoryRouter } from "./server/routes/memory";
import { createMcpRouter } from "./server/routes/mcp";
import { createSessionEnvironmentRouter } from "./server/routes/session-environment";
import { initUsageStore, rebuildSummary } from "./server/usage/store";
import { createCheckpointsRouter } from "./server/routes/checkpoints";
import { createGoalsRouter } from "./server/routes/goals";
import { createOpenClawContextRouter } from "./server/routes/openclaw-context";
import { createContextPreviewRouter } from "./server/routes/context-preview";
import { createTaskService, projectIdForPath } from "./server/services/tasks";
import { createExternalSessionsService } from "./server/services/external-sessions";
import { resolveWorktreeBaseRef } from "./server/services/worktree-base-ref";
import { createExternalSessionsRouter } from "./server/routes/external-sessions";
import { createTaskDispatcher } from "./server/services/task-dispatcher";
import { refreshLiveJobQuotas } from "./server/services/agent-job-quota";
import { computeDispatchCapacity, dispatchResourceBlock } from "./server/services/dispatch-capacity";
import { fleetLoadSync, procFootprintKB } from "./server/lib/fleet-usage";
import { buildBranchInventory, summarizeInventory } from "./server/services/branch-inventory";
import { createTaskAutoMerge, worktreeDirtProbe, worktreeRealDirt } from "./server/services/task-automerge";
import { imageShape, isBlankLikeImage } from "./server/services/image-shape";
import { createPreviewManager, type PreviewManager, type PreviewProcess } from "./server/services/preview-manager";
import { makeSheetWriter } from "./server/services/delivery-sheet";
import { registerPreviewProcess, unregisterPreviewProcess, trackedScriptPidTrees, listOwnedScripts } from "./server/routes/processes";
import { killProcessTree } from "./server/lib/process-tree";
import { sweepWorktrees, type TaskStatus as GcTaskStatus } from "./server/services/worktree-gc";
import { formatMb, parseSlimSkip, slimWorktree } from "./server/services/worktree-slim";
import { branchExistsInRepo, branchStatusFromRepo, commitIsAncestor, commitStatusFromRepo, resolveCommit, worktreeDiffStat } from "./server/services/branch-status";
import { deliveryPointer } from "./server/services/own-commits";
import { resolveDeliveryBranch, type DeliveryBranchDeps } from "./server/services/delivery-branch-ref";
import { landedMergeRange } from "./server/services/task-diff-range";
import { abandonNoticeFromRepo } from "./server/services/worktree-abandon-notice";
import { createTaskAttemptStore } from "./server/services/task-attempts";
import { auditLandings, classifyLanding, classifyLandingEsito, type AuditTask, type LandingState } from "./server/services/landing-audit";
import { classifyBranchLanding, classifyCommitLanding, indiceRigheMain } from "./server/services/landing-verdict";
import { createTranscriptUsageReader } from "./server/services/transcript-usage";
import { createDispatchUsageReader } from "./server/services/dispatch-usage";
import { orphanChildSessions } from "./server/services/agent-census";
import { createDetachedTopic, DETACHED_TOPIC_AUTONOMY } from "./server/lib/session-control-core";
import { buildProjectCandidates, resolveProjectPath, isSelectableProjectDir } from "./server/services/project-path-resolver";
import { homedir } from "os";
import { createBrowserService } from "./server/browser-service";
import { createWebrtcBridge } from "./server/webrtc-bridge";
import { clearBrowserCaches } from "./server/browser-tools-handler";
import { resetMoondreamCounter } from "./server/integrations/moondream-client";
import { sendBrowserWsMessage, parseBrowserWsMessage, type BrowserWsMessage } from "./shared/browser-ws-messages";
import { applyEngineSwitch } from "./server/browser-engine-switch";
import { browserEngineRegistry, chromiumExtensionsCount, chromiumSidecar } from "./server/browser-engine-registry";
import { nativeDelegateRegistry, handleNativeDelegationFrame } from "./server/browser-native-delegate";
import { countSharedViewers, createViewerCountPublisher } from "./server/browser-viewer-count";
import { seedNativeFromShared } from "./server/browser-session-handoff";
import { parseChatWsInbound } from "./server/schemas/chat-ws-inbound";
import { buildPresenceSnapshot } from "./server/presence";
import { SERVER_VERSION, SERVER_PROTOCOL_VERSION, SERVER_CAPABILITIES } from "./server/ws-capabilities";
import { createActivityRouter } from "./server/routes/activity";
import { createDashboardRouter } from "./server/routes/dashboard";
import { createAuthRouter, noteDeviceConnected, noteDeviceDisconnected } from "./server/routes/auth";
import { evaluateIdentity, isIdentityExemptPath, readSessionCookie } from "./server/lib/device-auth";
import { isGuestAllowedPath, isGuestAllowedMethod, isGuestSafeFrameType, isGuestHandshakeFrame, isGuestSocketData, isGuestInboundFrameAllowed, frameResource } from "./server/lib/grants";
import { hasGrant, holdsGrantOnTaskPreview, deviceP } from "./server/lib/grants-query";
import { resolvePrincipals, principalsRev } from "./server/lib/principals";
import { resolveIdentity } from "./server/lib/identity";
import { creaRelayClient } from "./server/services/relay-client";
import { leggiRelayConfig, leggiInstallationId, leggiRelaySegreto } from "./server/services/relay-config";
import { creaServizioLicenza, creaInterruttoreLicenza, baseUrlConcesso } from "./server/lib/licenza";
import { createLicenseRouter } from "./server/routes/license";
import { createBillingRouter, isBillingWebhookPath } from "./server/routes/billing";
import { createAccountRouter } from "./server/routes/account";
import { createPeopleRouter } from "./server/routes/people";
import { getGatewayWS } from "./server/gateway-ws";
import { initProvider, recomputeDefault, getDefaultProviderName, stopAllProviders, getProvider, tryGetProvider, resolveTurnAlive, resolveSessionOwner, childAliveForSweep } from "./server/providers";
import { aiBridgeEnabled, ClaudeCodeProvider } from "./server/providers/claude-code";
import { cancelled, describeTurnEnd, type TurnEndInfo } from "./server/providers/stop-reason";
import type { AbortReason } from "./server/providers/types";
import { recordTurnEnd, takeTurnEnd, peekTurnEnd } from "./server/providers/turn-end-registry";
import { readNativeUsage } from "./server/providers/native-usage-registry";
import { getAiBridgeClient } from "./server/lib/ai-bridge-client";
import { pickTaskPlan } from "./server/services/task-model-picker";
import { FALLBACK_MODELS, newestOfFamily } from "./server/providers/claude-models";
import { createProcessesRouter, startProcessDetection } from "./server/routes/processes";
import { createTasksRouter, ownCommitFiles } from "./server/routes/tasks";
import { createDeliveryCapture, type DeliveryCapture } from "./server/services/task-delivery-capture";
import { createPushRouter } from "./server/routes/push";
import { createNotificationsRouter } from "./server/routes/notifications";
import { recordAndAnnounce } from "./server/notification-registry";
import { createUiStateRouter, loadAllUiState, assertUiStateMigrationApplied } from "./server/routes/ui-state";
import { createProvidersRouter } from "./server/routes/providers";
import { createAppSettingsRouter } from "./server/routes/app-settings";
import {
  resolveAiProvider,
  resolveClaudeModel,
  resolveOpenaiModel,
  getAppSettings,
  resolveOutputLanguage,
  resolveDiscordPresenceEnabled,
  resolveDiscordDetailLevel,
  resolveAgentRuntime,
} from "./server/services/app-settings";
import { createProfileRouter } from "./server/routes/profile";
import { createPublicProfileHandler } from "./server/routes/public-profile";
import { startDiscordPresence } from "./server/services/discord-presence";
import { computePresenceCounts } from "./server/services/profile-stats";
import { createClaudeHooksRouter } from "./server/routes/claude-hooks";
import { createE2eRouter } from "./server/routes/e2e";
import { createTabsRouter } from "./server/routes/tabs";
import { createClaudeSessionTracker } from "./server/lib/claude-session-tracker";
import { evaluateAuth, isAllowedHost, isLoopbackAddress, isOriginGatedPath, resolveAllowedOrigins } from "./server/lib/auth-gate";
import { markViaTunnel, isLocalTransport, clientIpOf, tunnelPort } from "./server/lib/tunnel";
import { compressJson } from "./server/lib/compress-json";
import { currentRouteFault, applyRouteFault } from "./server/lib/route-fault";
import { BUSY_SPINNER_PHASES } from "./server/lib/claude-session-state";
import { claudeTranscriptPath, isTranscriptOrphaned } from "./server/lib/claude-transcript-path";
import { createProjectsRouter } from "./server/routes/projects";
import { createWorktreeGcRunner } from "./server/services/worktree-gc-runner";
import { createWorktreesRouter } from "./server/routes/worktrees";
import { createMachinesRouter } from "./server/routes/machines";
import { initVapid } from "./server/push-service";
import { startDevBundleReload, readBundleRev, stampBundleRev } from "./server/lib/dev-bundle-reload";
import { startBundleProbe } from "./server/lib/bundle-probe";
// `pendingAskAgeMs`/`hasPendingAsk` non si importano più qui: chiedere della
// sola domanda era il difetto. Restano il verdetto e il TTL, che valgono per
// entrambi i silenzi.
import { pendingAskVerdict, cancelAsk, pendingAskKeys, ASK_TTL_MS } from "./server/lib/ask-user-bridge";
// The stale-stream rule, pure so it can be tested without a server: the
// finalize decision must never be reachable while the child process is alive.
import { staleStreamVerdict } from "./server/lib/stale-stream-verdict";
// La porta unica di «questo turno aspetta una PERSONA». Le due sorgenti di
// silenzio legittimo sono una domanda a schermo E una richiesta di permesso a
// schermo: qui dentro tre punti ne conoscevano solo la prima, che è esattamente
// la deriva che `human-hold.ts` è stato scritto per impedire — e che la sua
// docstring nomina, elencando «lo spazzino degli stream fermi» fra i sei posti.
import { isHumanHold, humanHoldAgeMs } from "./server/lib/human-hold";
// PASSIVE STALL DETECTOR: silence past `dispatchIdleMin` no longer cuts a turn
// by itself — it asks a cheap judge first, and only a "stuck" verdict recycles
// it (see server/lib/stall-detector.ts + stall-judge.ts). `dispatchTimeoutMin`
// is downgraded to a reporting-only comparison below.
import { armStallDetector } from "./server/lib/stall-detector";
import { judgeStall } from "./server/lib/stall-judge";
import { runBootPartialSweep } from "./server/lib/boot-partial-sweep";
import { backfillDeliveries as backfillDeliveriesPass } from "./server/services/delivery-backfill";
import { keepDeliveryCommit, pruneDeliveryRefs, DELIVERY_REF_RETENTION_DAYS } from "./server/services/delivery-ref-keep";
import { runLandingAudit as runLandingAuditPass, auditOneLanding as auditOneLandingPass, type AuditWiring } from "./server/services/landing-audit-pass";
import { decodeCol, encodeCol } from "./shared/message-blob";
import { TURN_ERROR_PREFIX } from "./shared/board";

// ─── Early signal handlers (registered BEFORE any await in init) ───────────
// The full gracefulShutdown is only wired at the very bottom of this file,
// AFTER init completes — init includes top-level awaits (TLS probe, broker
// list) that can take seconds. A SIGTERM landing in that window previously
// hit the default disposition and killed the process with code 143, skipping
// every shutdown path (observed with start-prod's hot-reload watcher firing a
// second batch onto a freshly relaunched server). During init nothing is
// owned yet (no provider children attached, no clients), so a clean exit(0)
// is the correct response; once init finishes, `onTermSignal` is repointed
// to gracefulShutdown below.
let onTermSignal: (signal: string) => void = (signal) => {
  console.log(`[Shutdown] ${signal} received during init — exiting cleanly (nothing owned yet)`);
  process.exit(0);
};
process.on("SIGTERM", () => onTermSignal("SIGTERM"));
process.on("SIGINT", () => onTermSignal("SIGINT"));

// Gateway token: .env takes priority, falls back to reading from ~/.openclaw/openclaw.json
if (!process.env.GATEWAY_TOKEN) {
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME || "", ".openclaw", "openclaw.json"), "utf-8"));
    if (config?.gateway?.auth?.token) {
      process.env.GATEWAY_TOKEN = config.gateway.auth.token;
      console.log("[Startup] GATEWAY_TOKEN loaded from ~/.openclaw/openclaw.json");
    }
  } catch {}
  if (!process.env.GATEWAY_TOKEN) {
    // The OpenClaw gateway is an OPTIONAL integration (the "openclaw" relay
    // provider). A standalone download has no OpenClaw config,
    // so a missing token must NOT be fatal: the app defaults to the Claude
    // provider and runs fine without the gateway. This previously process.exit(1)'d,
    // which crashed the bundled server before it could listen — the packaged app
    // then hung forever on "Launching the local engine" on every clean machine.
    console.warn("[Startup] GATEWAY_TOKEN not set — the OpenClaw gateway relay is disabled; continuing without it.");
  }
}

// Solid singleton: a server booted from a DISPATCH WORKTREE (e.g. an agent that
// ran `bun run server.ts` inside its isolation checkout under ~/.topics/worktrees)
// must NOT hijack production. Sharing the ~/.topics daemon lock + the prod port
// let a worktree server (with its own empty DB) win the race and starve the real
// server into a crash-loop — the "board vuota / kanban rotto" failure. Redirect
// such a server onto a worktree-local TOPICS_HOME + an ephemeral port BEFORE the
// context reads PORT and before acquireLock reads TOPICS_HOME. Opt out with
// TOPICS_ALLOW_WORKTREE_PROD=1 (deliberately running prod from a worktree).
if (!process.env.TOPICS_ALLOW_WORKTREE_PROD) {
  const isoHome = worktreeIsolationHome(import.meta.dir, homedir());
  if (isoHome) {
    // La decisione sta in `services/daemon-state.ts` (`worktreeIsolationEnv`),
    // dove un test la raggiunge: qui viveva dentro `server.ts` ed era rimasta
    // INCOMPLETA — spostava casa e porta principale e lasciava la porta del
    // tunnel, che ha preso giu' la produzione il 18/08.
    const patch = worktreeIsolationEnv(process.env, isoHome);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete process.env[k]; else process.env[k] = v;
    }
    console.log(
      `[Daemon] worktree server isolated → TOPICS_HOME=${process.env.TOPICS_HOME}, ` +
      `PORT=${process.env.PORT === "0" ? "ephemeral" : process.env.PORT}, ` +
      `tunnel ${process.env.TOPICS_TUNNEL_PORT ? process.env.TOPICS_TUNNEL_PORT : "off"} (won't touch production)`,
    );
  }
}

// Create app context (initializes SQLite database)
const ctx = createAppContext(import.meta.dir);

// Da dove `browser_upload` può leggere. Prima da nessun posto in particolare:
// prendeva il path della tool-call e apriva il file, punto — quindi una chiamata
// con un path sbagliato faceva leggere al server un file arbitrario dell'utente
// e lo caricava su una pagina raggiungibile.
//
// Le radici sono quelle che hanno un senso per un upload: dove gli agenti
// depositano i propri artefatti, la cartella uploads del server, e i progetti
// REGISTRATI (che sono cartelle dichiarate dall'utente — così il caso d'uso vero,
// caricare un documento del progetto su cui si lavora, continua a funzionare).
// `TOPICS_UPLOAD_ROOTS` (separate da `:`) è la valvola esplicita per il resto.
//
// Ricalcolate a ogni chiamata: registrare un progetto nuovo deve bastare, senza
// riavviare il server.
setUploadRootsProvider(() =>
  uploadAllowedRoots({
    mediaDirs: [
      join(homedir(), ".topics/media"),
      join(homedir(), ".topics/workspace"),
      join(ctx.OPENCLAW_DIR, "media"),
      join(ctx.OPENCLAW_DIR, "workspace"),
    ],
    uploadsDir: ctx.UPLOADS_DIR,
    projectPaths: ctx.projectStore.list().map((p) => p.path).filter(Boolean),
    extraRoots: parseExtraRoots(process.env.TOPICS_UPLOAD_ROOTS),
  }),
);
const { PORT, PUBLIC_DIR, wsClients, broadcastToAll, broadcastToTopic, broadcast,
  loadTopics, loadUnread, saveUnread,
  activeStreams, getMessageById, getMimeType, logRequest, db } = ctx;

/** Last index.html we served successfully, with the bundle rev it carried. The
 *  fallback for a request that lands while /public is being rewritten — see the
 *  `GET /` handler. */
let lastGoodShell: { html: string; rev: string } | null = null;

// Phase 30 BROWSER-CHAT-03 — registry of active /ws/browser/:contextId
// connections keyed by contextId. Multiple panels may watch the same context
// (UI plus E2E spies); the broadcast iterates the whole set. Populated by the
// websocket.open browser branch and cleaned by websocket.close.
const browserWsClients = new Map<string, Set<ServerWebSocket<WSData>>>();

// Make that registry observable on `/api/system/status`, next to `wsClients`.
// Two numbers, because they fail apart: `sockets` stuck above zero with every
// pane closed means a `close` handler did not run; `contexts` stuck with
// `sockets` at zero means the empty-Set delete did not. Cheap - the Map holds
// one entry per open pane, so this walk is a handful of iterations per poll.
ctx.browserWsCounts = () => {
  let sockets = 0;
  for (const set of browserWsClients.values()) sockets += set.size;
  return { contexts: browserWsClients.size, sockets };
};

// Cross-window presence: broadcast the FULL list of windows that have declared
// their presence (via `hello`/`presence:announce`) plus the topics each holds.
// A full-snapshot (not deltas) is trivially idempotent across reconnects; the
// list self-heals because a dead socket drops out of `wsClients` before its
// close handler re-broadcasts. Purely WS-ephemeral — nothing is persisted.
// The dedup/build logic is pure in server/presence.ts (unit-tested).
function broadcastPresence() {
  const windows = buildPresenceSnapshot(
    (function* () {
      // `alive`: un socket mezzo aperto (chiuso lato client senza che il close
      // handler sia scattato) restava una "finestra" per sempre — `wsClients`
      // lo ripulisce solo per quella via. Tutte le altre vie di broadcast qui
      // dentro filtrano già su readyState; questa era l'unica che non lo faceva.
      for (const client of wsClients) yield { ...client.data, alive: client.readyState === 1 };
    })(),
  );
  broadcastToAll({ type: 'presence:windows', windows });
}

function broadcastToBrowserWs(contextId: string, msg: BrowserWsMessage, except?: { data: unknown } | null): void {
  const set = browserWsClients.get(contextId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const ws of set) {
    if (ws.readyState !== 1 || (except && ws === except)) continue;
    try {
      ws.send(payload);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[broadcastToBrowserWs] send failed for ${contextId}:`, m);
    }
  }
}

// The viewer count is PUSHED to the panes of a context when it changes, on the
// same socket that carries the frames. It used to be polled: every auto-mode
// pane asked `GET /api/browsers/:id/viewers` every 2s, and on the live log that
// one route was 44% of all API requests for a value that only moves on the
// events wired below (open, close, set_watching, register_native_executor,
// heartbeat reap). The publisher remembers what each context was last told and
// sends only on a change (server/browser-viewer-count.ts).
const viewerCountPublisher = createViewerCountPublisher(
  (c) => countSharedViewers(browserWsClients.get(c)),
  (c, count, except) => broadcastToBrowserWs(c, { type: 'viewers', count }, except),
);

// Boot-time invariant (Bug #7): ui_state.payload_version/server_seq must exist
// (migration 012). Without this, every GET/PUT would silently degrade. Fail loud.
try {
  assertUiStateMigrationApplied(db);
  console.log("[Startup] ui_state migration 012 applied — payload_version + server_seq columns present");
} catch (err: any) {
  console.error(`[Startup] ${err?.message ?? err}`);
  process.exit(1);
}

// Boot-time orphan cleanup (post-mortem from May-3 sidebar-flash incident).
// A topic UUID with `project_path` set must render as a project pane, not a
// standalone topic-pane. If any such UUID remains in `ui_state` (pane-store-v2,
// project-layout-*, openChatTopicIds, …) the renderer's `usePanelLifecycle`
// Effect 7 will refuse to keep it open while the WS hydrate keeps re-applying
// it from the server — a ~750 Hz ping-pong that visually flashes the sidebar
// tree.  The renderer-side fix (PURGE_ORPHAN_PANE dispatch) is the *primary*
// defence; this is the boot-time backstop that auto-corrects any DB left in a
// corrupt state by an older renderer build.  Idempotent — no-op when clean.
try {
  const report = purgeOrphanTopicRefs(db);
  if (report.rowsAffected > 0) {
    console.log(
      `[Startup] ui_state orphan cleanup: rewrote ${report.rowsAffected} row(s), stripped ${report.refsRemoved} orphan ref(s)`,
      report.perKey,
    );
  } else {
    console.log("[Startup] ui_state orphan cleanup: clean (no orphans found)");
  }
} catch (err) {
  // Non-fatal: log loudly but don't abort boot — the runtime guard in
  // PURGE_ORPHAN_PANE will still catch any orphan that slips through.
  console.error("[Startup] ui_state orphan cleanup failed:", err);
}

// Ripasso al boot delle tab dei task ARCHIVIATI (`services/task-tab-teardown.ts`).
// L'aggancio vero sta sull'archiviazione; questo è il backstop che ripara il
// pregresso — i record lasciati prima che quel codice esistesse — e qualunque
// chiave risuscitata da un client che era disconnesso mentre il task veniva
// archiviato. Niente broadcast e niente `destroyContext`: qui non c'è ancora
// nessun client collegato né nessun contesto browser vivo.
try {
  const swept = sweepArchivedTaskBrowserState({ db });
  if (swept.keysDeleted.length > 0) {
    console.log(
      `[Startup] tab dei task archiviati: ${swept.keysDeleted.length} chiave/i ui_state via ` +
        `(${swept.bytesFreed} byte, ${swept.taskIds.length} task)`,
    );
  } else {
    console.log("[Startup] tab dei task archiviati: pulito");
  }
} catch (err) {
  // Non-fatale come sopra: al massimo lo snapshot resta grasso un boot in più.
  console.error("[Startup] tab dei task archiviati: ripasso fallito:", err);
}

// Init AI provider — pick the boot default:
//   1. AI_PROVIDER env override (explicit, always wins)
//   2. claude (Anthropic SDK) if ANTHROPIC_API_KEY → stateless, sub-friendly,
//      autonomous: history is rebuilt from the local SQLite messages table on
//      every turn, so it survives `bun --watch` restarts and gateway outages.
//   3. openai if OPENAI_API_KEY
//   4. openclaw only if GATEWAY_URL is set (explicit opt-in to the gateway —
//      conversation memory there lives on the gateway and was lost on restart)
//   5. graceful fallback to "claude" so the picker UI still has a target;
//      initProviders() below auto-registers anything else available.
const providerType =
  (resolveAiProvider() as any) ||
  (process.env.ANTHROPIC_API_KEY ? 'claude' :
   process.env.OPENAI_API_KEY ? 'openai' :
   process.env.GATEWAY_URL ? 'openclaw' :
   'claude');

const aiProvider = initProvider({
  type: providerType,
  ...(providerType === 'openclaw' ? {
    gatewayUrl: ctx.GATEWAY_URL,
    token: ctx.GATEWAY_TOKEN,
    refreshToken: () => ctx.refreshGatewayToken(),
  } : providerType === 'openai' ? {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: resolveOpenaiModel(),
  } : {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: resolveClaudeModel(),
  }),
} as any);

// Wire provider events to broadcast system + recompute default on
// connectivity changes. Without recompute, openclaw would stay as default
// after the gateway goes down, and every chat would silently fail until
// the user manually picked another provider.
if (aiProvider.onConnect) {
  aiProvider.onConnect(() => {
    console.log("[Server] AI provider connected");
    ctx.broadcastToAll({ type: "gateway:status", connected: true });
    if (recomputeDefault()) {
      console.log(`[Server] Default provider re-picked: ${getDefaultProviderName()}`);
    }
  });
}
if (aiProvider.onDisconnect) {
  aiProvider.onDisconnect((reason) => {
    console.log(`[Server] AI provider disconnected: ${reason}`);
    ctx.broadcastToAll({ type: "gateway:status", connected: false });
    if (recomputeDefault()) {
      console.log(`[Server] Default provider re-picked: ${getDefaultProviderName()}`);
    }
  });
}

// Keep ctx.gatewayWS for backward compatibility
if (aiProvider.name === 'openclaw') {
  ctx.gatewayWS = getGatewayWS() ?? undefined;
}

console.log(`[Server] AI provider: ${aiProvider.name} (capabilities: ${[...aiProvider.capabilities].join(', ')})`);

// Init browser service (lazy — Chromium launched on first use)
const browserService = await createBrowserService({
  // Questa è l'unica accensione della spazzata degli orfani: il posto dove il
  // processo è davvero un server che sta partendo, e non un test che costruisce
  // un servizio. Vedi il commento sull'opzione in server/browser-service.ts.
  sweepOrphansAtBoot: true,
  onNavigate: (contextId, url, viewport) => {
    // Find the topic whose first 8 chars of id match contextId (matches
    // the convention at server/routes/topics.ts:1650). Topics are created with
    // `sessionKey = "topic:" + id.slice(0,8)`, so the indexed session_key lookup
    // resolves the common case in O(1) instead of a full loadTopics() table-scan
    // + 5 joins on every browser navigation. Fall back to the scan only if that
    // misses or returns a topic whose id prefix doesn't actually match (a topic
    // with a non-standard sessionKey), preserving the original behaviour exactly.
    try {
      let topic = ctx.getTopicBySessionKey("topic:" + contextId);
      if (!topic || topic.id.slice(0, 8) !== contextId) {
        // Chat panes resolve their contextId via resolveContextIdForTopic ->
        // `topic.browserState?.contextId ?? topic.id`, i.e. the FULL topic id —
        // NOT the 8-char sessionKey prefix. Match both the full id and the
        // prefix, else onNavigate silently never resolves a normal chat pane and
        // browserState is never populated (which is exactly why it read as dead).
        const topics = Object.values(ctx.loadTopics().topics);
        topic = topics.find(t => t.id === contextId)
          ?? topics.find(t => t.browserState?.contextId === contextId)
          ?? topics.find(t => t.id.slice(0, 8) === contextId)
          ?? null;
      }
      if (!topic) return;  // contextId may be temp/standalone — ignore
      // Scrittura MIRATA sulla sola colonna `browser_state` (migration 075).
      //
      // Non `saveSingleTopic`: questo hook scatta a OGNI navigazione, e un
      // upsert dell'intera riga a quel ritmo riscrive venti colonne più le
      // relazioni per aggiornarne una — e corre con qualunque altra scrittura
      // sullo stesso topic (rinomina, archiviazione, cambio modello), che è il
      // lost-update per cui questo file preferisce le scritture per colonna.
      //
      // Fino alla 075 la colonna non c'era: `saveSingleTopic` salvava tutto
      // TRANNE questo campo, e la lettura successiva lo ritrovava `undefined`.
      // È il motivo per cui `browserState` sembrava scritto e non arrivava mai a
      // nessun client — e per cui `restoreAllContexts`, che lo cercava, ha
      // riportato «0 restored» per 962 boot.
      ctx.setTopicBrowserState(topic.id, {
        url,
        contextId,
        lastActiveAt: Date.now(),
        viewport,
      });
    } catch (err: any) {
      console.warn(`[server] onNavigate persist failed for ${contextId}:`, err.message);
    }
  },
  // Flush the per-context browser caches (observe elements + ref snapshot) and
  // the vision budget counter when a context is torn down, so a recreated
  // same-id context can't act on stale refs/bboxes and per-context maps don't
  // grow unbounded across many topics.
  onDestroy: (contextId) => { clearBrowserCaches(contextId); resetMoondreamCounter(contextId); },
  // Phase 30 BROWSER-CHAT-03 — wire agent_active broadcast through the
  // /ws/browser/:contextId registry maintained in this module.
  broadcastToBrowserWs,
});

// Init usage tracking (still uses JSON files — will be migrated in a future phase)
initUsageStore(ctx.STATE_DIR);
// @covers BOOT-NONFATAL-01
// `summary.json` è un file di COMODO: si ricostruisce dai giornalieri a ogni
// avvio, e chi lo legge ha già la sua ricaduta. Farlo cadere qui significa che
// un file cosmetico decide se l'app parte — ed è successo il 25/08: un ENOENT
// sul rename di un temporaneo ha ucciso il server al boot, e 253 test di uno
// shard non sono mai partiti. Si logga e si va avanti: il riassunto si
// ricostruisce al giro dopo.
try { rebuildSummary(); }
catch (e) { console.error("[usage] rebuildSummary failed at boot (non-fatal):", e); }

// Claude Code session tracker — canonical lifecycle state for every Claude
// CLI session spawned via Topics (topic chats persist in the DB; topic-less
// terminal sessions are tracked in-memory). Created before the terminal router
// so the latter can register its sessions with it. See
// openspec/changes/claude-session-tracker.
const claudeSessionTracker = createClaudeSessionTracker({
  db: ctx.db,
  broadcast: ctx.broadcastToAll,
  ptyIdleMs: getClaudeSessionPtyIdleMs,
  // Message-import sink for ADOPTED sessions: the sweep reads the transcript
  // tail and appends the terminal's new turns into the topic's chat.
  importSink: {
    getLastMessageId: (sk) => {
      const thread = ctx.loadLocalMessages(sk, { withBlocks: false });
      return thread.length ? thread[thread.length - 1]!.id : null;
    },
    appendMessages: (sk, msgs) => ctx.appendImportedMessages(sk, msgs),
    resolveToolResult: (sk, toolUseId, result, isError) =>
      ctx.updateToolCallResult(sk, toolUseId, isError ? "" : result, isError ? result : undefined),
    topicIdForSessionKey: (sk) => ctx.getTopicBySessionKey(sk)?.id ?? null,
  },
  // Double-import guard: while Topics owns a live claude child for the session,
  // the chat provider streams + persists those turns itself.
  isSessionLocallyDriven: (sk) => {
    try {
      const p = tryGetProvider("claude-code") as unknown as { isTurnProcessAlive?: (s: string) => boolean } | undefined;
      return !!p?.isTurnProcessAlive?.(sk);
    } catch { return false; }
  },
});

// La porta unica del parcheggio (lib/session-parking.ts): archiviare un topic
// deve anche mettere a riposo la sua sessione, o la fase resta viva per sempre
// su una chat che non ha più né riga né tab. Configurata qui perché il tracker
// nasce DOPO il contesto; i tre percorsi di archiviazione la chiamano.
configureSessionParkingForTracker(claudeSessionTracker);

// Il runtime nativo tiene le conversazioni in una Map di processo e dichiara
// alla rotta «la storia me la ricordo io» (`contextStrategy: inline-system`).
// Vero finché il processo vive — e qui il processo si riavvia a ogni
// salvataggio in `server/`. Da qui in poi, quando una sua sessione nasce, se la
// va a riprendere dal DB: `loadActiveThread` è la stessa lettura che alimenta la
// chat, quindi il modello riparte esattamente da ciò che l'utente ha davanti.
// The tool calls travel too: without them the rebuilt history was prose only,
// and an agent resumed after a restart no longer knew which files it had read
// or edited, so it explored or redid the work. The `blocks` column is skipped
// on purpose: it is the fat one (7 MB on the heaviest topic) and nothing here
// reads it, while `tool_calls` is exactly what is needed.
configureNativeHistorySource((sessionKey) =>
  ctx.loadActiveThread(sessionKey, { withBlocks: false }).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    partial: (m as { partial?: number | boolean | null }).partial ?? null,
    toolCalls: m.toolCalls ?? null,
  })),
);

// Shared-session WebRTC transport broker (spawns the Rust sidecar lazily on first
// offer; no-op when its binary is missing → clients fall back to the JPEG stream).
const webrtcBridge = createWebrtcBridge();

// Create route handlers
// «Qualcuno sta VEDENDO questo contextId?» — un socket `/ws/browser/<ctx>`
// aperto e vivo. Lo apre sia la pane nativa (che poi si registra come delegato)
// sia quella web (che guarda lo screencast), quindi è il segnale più vicino a
// «la pane è montata» che il server abbia: il contesto headless, da solo, esiste
// anche quando nessuna pane si è montata. `open-pane` lo usa per armare il
// ripiego `browser:force-open` e per rispondere la verità (`visible`).
const paneAttachedTo = (contextId: string): boolean => {
  const set = browserWsClients.get(contextId);
  if (!set) return false;
  for (const w of set) if (w.readyState === 1) return true;
  return false;
};
const topicsRouter = createTopicsRouter(ctx, browserService, paneAttachedTo);
const filesRouter = createFilesRouter(ctx);
const voiceRouter = createVoiceRouter(ctx);
const mediaRouter = createMediaRouter(ctx);
const branchesRouter = createBranchesRouter(ctx);
// Chi conta come spettatore sta in browser-viewer-count.ts (puro, con i suoi
// test): esclude i delegati nativi e chi ha la pane fuori dallo schermo, e NON
// guarda la pausa dello screencast — vedi lì il perché.
const browserRouter = createBrowserRouter(ctx, browserService, (c) =>
  countSharedViewers(browserWsClients.get(c)),
);
const cronRouter = createCronRouter(ctx);
const contextRouter = createContextRouter(ctx);
const terminalRouter = createTerminalRouter(ctx, claudeSessionTracker);
// Deleting a terminal session closes any browser it opened (contextId
// `term-<id>`): broadcast the pane close for every client + destroy the
// server-side headless context. Best-effort — a native-only pane has no
// headless context and destroyContext simply no-ops.
setTerminalBrowserCloser((contextId) => {
  ctx.broadcastToAll({ type: "browser:close-pane", contextId });
  browserService.destroyContext(contextId).catch(() => {});
});
const statusRouter = createStatusRouter(ctx);
const memoryRouter = createMemoryRouter(ctx);
const mcpRouter = createMcpRouter(ctx);
// Read-only: what the current session inherited from the user's setting sources.
const sessionEnvironmentRouter = createSessionEnvironmentRouter(ctx);
const checkpointsRouter = createCheckpointsRouter(ctx);
const goalsRouter = createGoalsRouter(ctx);
const openclawContextRouter = aiProvider.name === 'openclaw' ? createOpenClawContextRouter(ctx) : null;
// Always-on: serves /api/topics/:id/context-preview and /context-snapshots.
// Independent of which provider is the default — every provider benefits
// from the canonical envelope inspector (change `topic-context-canonical`).
const contextPreviewRouter = createContextPreviewRouter(ctx);
const dashboardRouter = createDashboardRouter(ctx);
const authRouter = createAuthRouter(ctx);

// ── LA LICENZA: cosa è concesso su QUESTA installazione.
//
// Nasce presto e senza rete: il gettone è firmato e si verifica con la sola
// chiave pubblica, quindi non c'è nessun momento dell'avvio in cui la macchina
// aspetta una risposta da fuori per sapere cosa può fare. Senza gettone —
// il caso normale — è il piano gratuito pieno, e nessuna riga di qui in poi
// può renderlo meno di così (`server/lib/licenza.ts`).
const licenzaSvc = creaServizioLicenza({
  stateDir: ctx.STATE_DIR,
  env: process.env,
  installationId: leggiInstallationId(ctx.STATE_DIR),
});
ctx.licenza = () => licenzaSvc;
const licenseRouter = createLicenseRouter(ctx);
// L'account: agganciare un'identità remota alla persona che è già qui. Nasce
// SPENTO — senza `TOPICS_ACCOUNT_URL` la rotta risponde «non configurato» e
// l'interfaccia non offre nulla — e non è un cancello: nessun ramo di
// `server/routes/account.ts` può togliere una capacità locale (ORG-08).
const accountRouter = createAccountRouter(ctx);
const peopleRouter = createPeopleRouter(ctx);
// Il pagamento, che NON è ciò che è concesso: `server/routes/billing.ts` può
// solo passare un gettone a `licenzaSvc.installa`, che lo riverifica con la
// chiave pubblica. Nasce SPENTO — senza `STRIPE_SECRET_KEY` la rotta risponde
// «non configurato» — e nessun suo ramo può togliere una capacità locale.
const billingRouter = createBillingRouter(ctx);

/**
 * L'identita' risolta per una richiesta, deposta dal gate e letta dalle rotte.
 *
 * WeakMap e non un campo sulla Request: la Request non e' estendibile, e passare
 * l'identita' come argomento vorrebbe dire cambiare la firma di ogni router. La
 * chiave e' l'oggetto stesso, quindi la voce muore col ciclo di vita della
 * richiesta senza che nessuno debba ripulirla.
 *
 * Il punto e' che l'identita' si calcola UNA volta. Ricalcolarla nelle rotte
 * significherebbe due query e — peggio — due verita' possibili sullo stesso giro.
 */
const identityByRequest = new WeakMap<Request, { role: 'owner' | 'guest'; deviceId: string | null }>();
ctx.requestIdentity = (req: Request) => identityByRequest.get(req) ?? null;

/**
 * Il filtro dei broadcast verso un OSPITE: prima il TIPO, poi l'ENTITÀ.
 *
 * Ripara ciò che era stato chiuso a forza. Per confinare un ospite avevo tolto
 * `/ws`, e il prezzo era che tutto ciò che gli condividi diventava una
 * fotografia da ricaricare a mano. Il socket torna, ma ciò che ci passa dentro è
 * nominato: i cinque frame delle schede e i cinque delle chat, e solo per le
 * risorse che quell'ospite ha davvero.
 *
 * Il verso in cui si sbaglia è deliberato: un frame nuovo non raggiunge gli
 * ospiti finché qualcuno non lo aggiunge all'allowlist. Un aggiornamento che
 * manca si nota e si corregge; una fuga no.
 */
/**
 * I principali di un dispositivo, memorizzati finché il mondo non cambia.
 *
 * Questo predicato gira nel ciclo dei broadcast — per OGNI socket e per OGNI
 * frame — quindi risolvere ogni volta significherebbe due query in più a frame.
 * La memoria si invalida da sola sul contatore `principals_rev`, che i trigger
 * SQL muovono quando cambia un'appartenenza, una revoca o l'attribuzione di un
 * dispositivo: non è una scadenza a tempo, è il fatto che il dato è cambiato.
 * Una cache a scadenza qui vorrebbe dire una finestra in cui una revoca non ha
 * ancora effetto, ed è esattamente la cosa da non avere.
 */
const memoPrincipali = new Map<string, { rev: number; list: ReturnType<typeof deviceP> }>();
function principaliDi(deviceId: string) {
  const rev = principalsRev(ctx.db);
  const cache = memoPrincipali.get(deviceId);
  if (cache && cache.rev === rev) return cache.list;
  const list = resolvePrincipals(ctx.db, deviceId).list;
  memoPrincipali.set(deviceId, { rev, list });
  return list;
}

ctx.setGuestBroadcastFilter({
  mayReceiveFrame(deviceId, message) {
    const tipo = (message as { type?: unknown }).type;
    if (typeof tipo !== "string" || !isGuestSafeFrameType(tipo)) return false;
    const risorsa = frameResource(message);
    if (!risorsa) return false;
    return hasGrant(ctx.db, principaliDi(deviceId), risorsa.type, risorsa.id);
  },
  // Le fan-out per topic non portano l'entità NEL frame: ce l'hanno come
  // argomento. Qui quindi si guarda il topic che si sta per consegnare, non
  // quello che il frame dichiara — molti di quei frame non lo nominano affatto.
  mayReadTopic(deviceId, topicId) {
    return hasGrant(ctx.db, principaliDi(deviceId), "topic", topicId);
  },
});
const processesRouter = createProcessesRouter(ctx);
// PUNTO 1 (task e3240a22): inietta le closure nel manager DOPO che processes.ts
// e' pronto. La closure viene letta solo alla chiamata, non alla costruzione.
ctx.worktreeGcDeps.killTree = (pid, graceMs) => killProcessTree(pid, graceMs);
ctx.worktreeGcDeps.listOwnedScripts = listOwnedScripts;
// ─── Task auto-dispatch (Kanban "drag → agent in a tab") ───────────────────
// The dispatcher is the ONLY place that starts a headless agent turn from a
// board gesture. All its host-specific wiring — the in-process turn runtime,
// worktree creation, project-path resolution — is assembled here and injected,
// keeping server/services/task-dispatcher.ts host-agnostic and unit-tested.
const DISPATCH_WORKSPACE_DIR = join(ctx.OPENCLAW_DIR, "workspace");
// The repository a delivery report is checked against: the agent's worktree
// (a cited file may exist only on the delivery branch), else the repository
// the topic worked in, else the board's project. Until 2026-09-04 every report
// was checked against THIS checkout, so a dancerooms commit was "in no ref"
// and a new file on a branch "not tracked". One resolver, handed to BOTH task
// services: the dispatcher's and the router's, which is the one an agent's
// update_task(status="review") actually reaches.
const repoRootForCard = ({ projectId, assignedTopicId }: { taskId: string; projectId: string | undefined; assignedTopicId: string | null }): string | null => {
    try {
      if (assignedTopicId) {
        const row = ctx.db.prepare("SELECT worktree_id, project_path FROM topics WHERE id = ?").get(assignedTopicId) as { worktree_id?: string | null; project_path?: string | null } | undefined;
        const wt = row?.worktree_id ? ctx.worktreeStore.get(row.worktree_id) : null;
        if (wt?.absPath && existsSync(wt.absPath)) return wt.absPath;
        // The worktree may already be reaped (a land, a restart): the topic
        // still knows which repository it worked in.
        if (row?.project_path && existsSync(row.project_path)) return row.project_path;
      }
    } catch { /* fall through to the project */ }
    if (!projectId) return null;
    try {
      const c = resolveProjectPath(projectId, buildProjectCandidates({ projectStore: ctx.projectStore, workspaceDir: DISPATCH_WORKSPACE_DIR, extraPaths: dispatchExtraPaths }));
      return c?.path && existsSync(c.path) ? c.path : null;
    } catch { return null; }
  };
const dispatcherSvc = createTaskService(ctx.db, {
  writeDeliverySheet: makeSheetWriter(ctx.OPENCLAW_DIR),
  repoRootFor: repoRootForCard,
});

async function abortHeadlessTurn(sessionKey: string): Promise<void> {
  const url = new URL("http://localhost/api/chat/abort");
  try {
    await topicsRouter(
      new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionKey }) }),
      url, "/api/chat/abort", "POST",
    );
  } catch { /* best-effort */ }
}

/**
 * Una risposta di ERRORE della route ha comunque un corpo — JSON, non SSE. Il
 * controllo `!resp.body` non la vede, quindi il drain qui sotto la mangiava
 * tutta senza incontrare `[DONE]`, e il `takeTurnEnd(…) ?? { end: "end_turn" }`
 * finale la dichiarava una fine normale: un turno mai partito, riportato al
 * dispatcher come consegnato.
 *
 * Non è teorico. `runHeadlessReattach` manda `messages: []` e la route lo
 * respingeva con 400 «messages array required» (verificato: `curl` su
 * :3333 → HTTP 400): l'adozione dei turni sopravvissuti a un riavvio non è mai
 * partita, e a nessuno risultava perché tornava `end_turn`. Da oggi c'è anche
 * il 409 «turno già in volo», che qui vuol dire la stessa cosa: non abbiamo
 * guidato niente.
 */
function rejectedTurn(resp: Response, what: string): TurnEndInfo | null {
  if (resp.ok) return null;
  // Il 409 NON è un guasto: la sessione sta già rispondendo, e i tre consumatori
  // dello stesso status devono dire la stessa cosa (il client riaccoda, l'MCP
  // risponde «riprova quando ha finito»). Appiattirlo su `provider-error`
  // bruciava un tentativo al dispatcher e finiva in park FAILED — un task
  // dichiarato fallito solo perché è arrivato mentre l'agente parlava.
  if (resp.status === 409) {
    return {
      end: "cancelled",
      cause: "turn-in-flight",
      detail: `POST ${what} → HTTP 409 (stream già in volo)`,
    };
  }
  // Il corpo si consuma senza rimorsi: da qui si torna indietro comunque.
  return {
    end: "error",
    cause: "provider-error",
    detail: `POST ${what} → HTTP ${resp.status}`,
  };
}

// Fallback when a caller doesn't pass `idleMs` (e.g. the boot sweep's
// mid-turn reattach, which isn't a board task and has no `dispatchIdleMin`
// setting to read) — matches `BoardSettings.dispatchIdleMin`'s own default.
const DEFAULT_STALL_IDLE_MS = 5 * 60_000;
/** After the route has deposited the end, how long a silent SSE body is still trusted to close on its own. */
const HEADLESS_END_GRACE_MS = 20_000;

/**
 * The transcript TAIL the stall judge reads: the last few local messages,
 * newest last, capped so the judge call stays cheap. `null` when there is
 * nothing to read — the caller treats that as "alive" (never recycle blind).
 */
function stallTranscriptTail(sessionKey: string): string | null {
  try {
    const msgs = ctx.loadLocalMessages(sessionKey, { withBlocks: false });
    if (msgs.length === 0) return null;
    const tail = msgs.slice(-6).map((m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      return `${m.role}: ${text.length > 1500 ? text.slice(-1500) : text}`;
    });
    return tail.join("\n---\n").slice(-6000) || null;
  } catch { return null; }
}

/** One cheap haiku call, in the shape `judgeStall` expects. */
async function stallJudgeComplete(prompt: string): Promise<string> {
  const provider = getProvider("claude-code");
  const res = await provider.complete([{ role: "user", content: prompt }], { model: "claude-haiku-4-5" });
  return res.content ?? "";
}

/**
 * ONE WATCHER FOR BOTH HEADLESS ENTRIES (fresh turn and reattach): the stall
 * judge, the drain, the end-deposit race. It used to live twice, and the two
 * copies drifted by a word each; `tag` is the only thing that differed.
 *
 * The turn self-drives server-side (consumeGateway) whether or not we read the
 * SSE mirror; we drain it only to learn when the turn ENDS (the reconciliation
 * signal). No wall-clock kill: a PASSIVE stall detector watches for silence
 * past `idleMs` and asks a cheap judge before ever touching the turn.
 *
 * EVERY CHUNK THAT ARRIVES IS A SIGN OF LIFE, and the cap has to know it. This
 * drain existed only to learn WHEN the turn ends; it also says THAT it is still
 * going, and nobody was looking. Without it the cap was a wall clock and it cut
 * healthy turns: 60 times, the last on 2026-08-21 at 00:37.
 *
 * THE END IS THE DEPOSIT, NOT THE CLOSE OF THE BODY. On 2026-09-04 (c8039b35)
 * the route finalized the turn - row written, end deposited, `[Media]` line
 * out - and this reader kept waiting on a body that never closed: the run
 * stayed "in flight", the card's continuation parked behind it, and
 * `restart-when-idle` waited an hour for a turn that did not exist. Once the
 * end is deposited and the body has been silent for the grace, the turn is
 * over for us too.
 */
async function watchHeadlessBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionKey: string,
  opts: { timeoutMs: number; idleMs?: number },
  tag: "" | " (reattach)",
): Promise<TurnEndInfo> {
  let stalled = false;
  const t0 = Date.now();
  const detector = armStallDetector({
    idleMs: opts.idleMs ?? DEFAULT_STALL_IDLE_MS,
    isWaitingForHuman: () => isHumanHold(sessionKey),
    isWaitingForChecks: () => isChecksHold(sessionKey),
    getTail: () => stallTranscriptTail(sessionKey),
    judge: (tail) => judgeStall({ complete: stallJudgeComplete }, tail),
    onRearm: (reason) => console.log(
      reason === "human"
        ? `[turn] stall watch rearmed on ${sessionKey}: a person is in the loop (question or permission), their time doesn't count`
        : reason === "checks"
          ? `[turn] stall watch rearmed on ${sessionKey}: our pre-review checks are running for its card, that wait is ours`
          : `[turn] stall watch rearmed on ${sessionKey}: judge says alive, still watching`,
    ),
    onStuck: () => {
      stalled = true;
      console.warn(`[turn] stall detector recycling ${sessionKey}${tag}: judge found it stuck`);
      abortHeadlessTurn(sessionKey).catch(() => {});
      reader.cancel().catch(() => {});
    },
  });
  try {
    while (true) {
      const { done } = await Promise.race([
        reader.read(),
        (async () => {
          while (true) {
            await Bun.sleep(HEADLESS_END_GRACE_MS);
            if (peekTurnEnd(sessionKey)) return { done: true as const };
          }
        })(),
      ]);
      if (done) {
        if (peekTurnEnd(sessionKey)) reader.cancel().catch(() => {});
        break;
      }
      detector.noteActivity();
    }
  }
  finally {
    detector.clear();
    try { reader.releaseLock(); } catch { /* already released */ }
    // `dispatchTimeoutMin` DECLASSED TO REPORTING ONLY: no cut, just a log.
    if (opts.timeoutMs && Date.now() - t0 > opts.timeoutMs) {
      console.warn(`[turn] ${sessionKey}${tag}: over dispatchTimeoutMin (${Math.round(opts.timeoutMs / 60_000)}min) - reporting only, no cut (${Math.round((Date.now() - t0) / 60_000)}min elapsed)`);
    }
  }
  // The stall verdict is OURS: it outranks whatever end the route deposited in
  // the meantime (the abort we sent lands after it).
  if (stalled) {
    takeTurnEnd(sessionKey);
    return cancelled("stall", `idle stall detector${tag}: judge found the session stuck (idle ${opts.idleMs ?? DEFAULT_STALL_IDLE_MS}ms)`);
  }
  // The route deposited the WHY while finalizing; the drain ends on `[DONE]`,
  // which finalization writes afterwards. If it is missing, the turn is over anyway.
  return takeTurnEnd(sessionKey) ?? { end: "end_turn" };
}

async function runHeadlessTurn(
  sessionKey: string,
  content: string,
  opts: { timeoutMs: number; idleMs?: number; contextMode?: "full" | "lean" },
): Promise<TurnEndInfo> {
  const url = new URL("http://localhost/api/chat");
  // Butta via un eventuale residuo: una fine depositata e mai ritirata è di un
  // turno vecchio, e attribuirla a questo sarebbe la bugia che 0.4 elimina.
  takeTurnEnd(sessionKey);
  // contextMode "lean" (resume/continuation): the chat route skips re-injecting
  // the heavy context envelope (CLAUDE.md/README/memory/…) since the persistent
  // CLI session already has it — see assembleTopicContext(leanContext).
  // `dispatched`: è un turno d'AGENTE guidato dalla board, non una chat umana.
  // La route lo rimanda sul `stream:end` di completamento così la push di fine
  // risposta lo esclude (decine di turni d'agente = spam).
  const body = JSON.stringify({ sessionKey, messages: [{ role: "user", content }], contextMode: opts.contextMode ?? "full", dispatched: true });
  const resp = await topicsRouter(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
    url, "/api/chat", "POST",
  );
  // Nessuno stream = la route non ha nemmeno iniziato il turno: è un guasto,
  // non una fine normale (dirla `end_turn` sarebbe la solita bugia).
  if (!resp || !resp.body) return { end: "error", cause: "provider-error", detail: "no stream from /api/chat" };
  const rejected = rejectedTurn(resp, "/api/chat");
  if (rejected) return rejected;
  return watchHeadlessBody(resp.body.getReader(), sessionKey, opts, "");
}

// Reattach variant: POST /api/chat with mode:"reattach" and NO user message —
// the route calls provider.reattach (adopt the surviving broker turn) instead of
// sendChat. Same SSE drain to learn when the turn ends. Used by the dispatcher's
// reconcile REATTACH branch after a server restart.
async function runHeadlessReattach(sessionKey: string, opts: { timeoutMs: number; idleMs?: number }): Promise<TurnEndInfo> {
  const url = new URL("http://localhost/api/chat");
  // Il provider si DICHIARA, non si lascia indovinare alla rotta.
  //
  // `resolveProvider` risponde «con chi vorrebbe parlare questa topic», e senza
  // un `provider` nel corpo cade sul default della macchina. Ma un riattacco
  // non sceglie: adotta un turno che sta già girando, e qui il proprietario è
  // `claude-code` per COSTRUZIONE — entrambi i chiamanti lo sanno già.
  // `hasLiveSession` (poco sopra) interroga esplicitamente `claude-code`, e il
  // setaccio di boot `reattachSurvivingChatTurns` enumera lo store del broker
  // ai-bridge, che è del provider claude-code e di nessun altro.
  //
  // Senza questa riga, su una macchina il cui default è il runtime nativo
  // (`topics`, che non ha `reattach`), ogni riadozione finiva su `sendChat` con
  // un messaggio VUOTO: un turno fabbricato che rispondeva «Ciao! Come posso
  // aiutarti?» e si sedeva in chat al posto della risposta vera. Nove volte in
  // quindici minuti su topic:9fe7a291 il 2026-08-18, una per riavvio del
  // server. La rotta adesso rifiuta quel caso (501 `reattach_unsupported`),
  // ma la cura sta qui: chi conosce il proprietario lo scrive.
  const body = JSON.stringify({ sessionKey, messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
  // Stesso patto di runHeadlessTurn: residuo via prima di iniziare.
  takeTurnEnd(sessionKey);
  const resp = await topicsRouter(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
    url, "/api/chat", "POST",
  );
  // Nessuno stream = il turno adottato non c'era più: non è una fine normale.
  if (!resp || !resp.body) return { end: "error", cause: "provider-error", detail: "no stream from /api/chat (reattach)" };
  const rejected = rejectedTurn(resp, "/api/chat (reattach)");
  if (rejected) return rejected;
  return watchHeadlessBody(resp.body.getReader(), sessionKey, opts, " (reattach)");
}

/**
 * Il gemello di `runHeadlessReattach` per il turno che la CLI apre DA SOLA
 * (`Monitor` che consegna). Stessa route, stesso drenaggio SSE, stessa lettura
 * della fine: cambia solo il `mode`, perché cambia solo COME ci si attacca —
 * il provider ha già gli eventi in mano, non c'è nessuno store da rileggere.
 *
 * Nessun tetto a orologio come negli altri due: quel tetto è la promessa fatta
 * al DISPATCHER, che aspetta un verdetto per una card. Qui non aspetta nessuno —
 * è una risposta che arriva in chat mentre l'utente fa altro — e imporre una
 * scadenza vorrebbe dire troncare la risposta di un Monitor che si è messo a
 * lavorare sul serio. Il turno finisce quando finisce; le reti che lo chiudono
 * comunque (watchdog d'inattività del provider, sweeper StaleStream) sono le
 * stesse di ogni altro turno di chat.
 */
async function runHeadlessWoken(sessionKey: string, label?: string): Promise<TurnEndInfo> {
  const url = new URL("http://localhost/api/chat");
  // Il provider si DICHIARA, per la stessa ragione del riattacco: senza, si
  // cade sul default della macchina e la sveglia di claude-code finirebbe a
  // bussare a un provider che non possiede quel figlio.
  // `wokenLabel`: COSA stava sorvegliando il Monitor. Viaggia fino alla riga in
  // chat, che senza di essa mostrerebbe una risposta senza provenienza.
  const body = JSON.stringify({ sessionKey, messages: [], mode: "woken", provider: "claude-code", ...(label ? { wokenLabel: label } : {}) });
  // Stesso patto degli altri due: residuo via prima di iniziare.
  takeTurnEnd(sessionKey);
  const resp = await topicsRouter(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
    url, "/api/chat", "POST",
  );
  if (!resp || !resp.body) return { end: "error", cause: "provider-error", detail: "no stream from /api/chat (woken)" };
  const rejected = rejectedTurn(resp, "/api/chat (woken)");
  if (rejected) return rejected;
  const reader = resp.body.getReader();
  try { while (true) { const { done } = await reader.read(); if (done) break; } }
  finally { try { reader.releaseLock(); } catch { /* already released */ } }
  return takeTurnEnd(sessionKey) ?? { end: "end_turn" };
}

// Ad-hoc dirs the server already references: topic projectPaths + terminal
// cwds. Most boards belong to projects opened this way (folder picker, Claude
// terminals) that were never registered in the ProjectStore — without these
// the dispatcher can't map their board id back to a directory. Same union
// rationale as the icon-allowlist gate in routes/projects.ts.
function dispatchExtraPaths(): string[] {
  const paths: string[] = [];
  try {
    for (const t of Object.values(ctx.loadTopics().topics)) {
      const p = (t as { projectPath?: string }).projectPath;
      if (p) paths.push(p);
    }
  } catch { /* best-effort source */ }
  try {
    for (const row of ctx.db.query("SELECT DISTINCT cwd FROM terminal_sessions").all() as Array<{ cwd?: string }>) {
      if (row.cwd) paths.push(row.cwd);
    }
  } catch { /* best-effort source */ }
  return paths;
}

// Incremental, dedup-by-message-id usage accounting over Claude Code
// transcripts (see transcript-usage.ts). One instance: it caches per-path
// byte offsets so the dispatcher's 4s live ticker stays O(appended bytes).
const transcriptUsageReader = createTranscriptUsageReader();

// Lo stesso lettore, ma per una sessione DI TASK: somma le sessioni figlie che
// il coordinatore ha lanciato, così `tasks.agent_tokens` porta il costo del
// lavoro e non quello del solo coordinamento (vedi dispatch-usage.ts). Una
// istanza sola: dentro c'è il ledger che tiene i token delle figlie gia' morte.
const dispatchUsageReader = createDispatchUsageReader({
  db: ctx.db,
  read: (p) => transcriptUsageReader.read(p),
});

// Assigned just below (after worktreeOfTask is defined); the dispatcher only
// calls it lazily at review-time, so the late binding is safe.
let previewManager: PreviewManager | undefined;

// Census of the Claude sessions Topics did NOT start (bare `claude` in a
// terminal). Two consumers: the board badge ("questo progetto è vivo anche
// senza card") and the dispatcher guard below, which refuses to drop an agent
// into a directory somebody is already working in. The tracker roster is the
// ownership signal — anything it knows is ours, by definition.
const externalSessions = createExternalSessionsService({
  knownSessionIds: () => claudeSessionTracker.listSessions().map((s) => s.claudeSessionId),
  candidatePaths: () =>
    buildProjectCandidates({
      projectStore: ctx.projectStore,
      workspaceDir: DISPATCH_WORKSPACE_DIR,
      extraPaths: dispatchExtraPaths,
    }).map((c) => c.path),
  projectIdFor: projectIdForPath,
  broadcast: ctx.broadcastToAll,
});

/**
 * L'autonomia con cui nasce la chat di un agente DISPACCIATO dalla board.
 *
 * Scritta qui, esplicita, e non lasciata al default della colonna — che è la
 * trappola segnata nero su bianco in
 * `openspec/changes/autonomy-level-needs-permission-channel/proposal.md`: «i
 * topic dispatchati dalla board non possono chiedere niente a nessuno; se il
 * mapping si accende con il default di colonna, OGNI dispatch si blocca».
 *
 * Da oggi il canale di permesso esiste, quindi una modalità che chiede non nega
 * più in silenzio: apre un pannello in chat e aspetta. Ottimo per una chat che
 * hai davanti — inservibile per un agente di board, la cui chat nasce chiusa
 * (`background: true`) e che nessuno sta guardando: il pannello resterebbe a
 * schermo in una conversazione mai aperta e il task fermo senza un motivo
 * leggibile sulla board.
 *
 * `yolo` e non `auto-apply`, cioè `bypassPermissions`: un agente di board lavora
 * dentro un worktree isolato e il suo mestiere è ESEGUIRE (protocollo di
 * consegna, CLAUDE.md). Non è un allargamento mascherato: è la stessa cosa che
 * faceva finora — con la differenza che finora funzionava per SBAGLIO, perché a
 * tenere vivi i suoi tool MCP era una riga in un `.claude/settings.local.json`
 * gitignorato del repo, e nelle chat fuori da quel repo gli stessi strumenti
 * morivano muti.
 */
// Il tier di nascita di un agente dispacciato ha UNA fonte sola, ed è dentro
// `createDetachedTopic` (DETACHED_TOPIC_AUTONOMY): lì vale anche per un
// chiamante che se ne dimentichi. Qui resta l'alias storico, non un secondo
// valore che può divergere da quello.
const DISPATCH_AUTONOMY = DETACHED_TOPIC_AUTONOMY;

/**
 * Le conseguenze di un ritiro, legate una volta sola.
 *
 * Le usano tre chiamanti — la potatura dei topic dei tentativi (dispatcher), la
 * cascata di una tab chiusa e il riconcilio al boot. Se ognuno se le ricablasse,
 * saremmo di nuovo dove il task e' cominciato: tre posti che dicono cosa
 * significa «chiuso», e nessuno d'accordo con gli altri due.
 */
const retirementConsequences: ReconcileDeps = {
  archiveTopic: (topicId) => {
    const res = archiveTopicFully({
      getTopicById: ctx.getTopicById,
      saveSingleTopic: ctx.saveSingleTopic,
      loadUnread: ctx.loadUnread,
      saveUnread: ctx.saveUnread,
      broadcastToAll: ctx.broadcastToAll,
      purgeFromUiState: (id) => purgeTopicFromUiState(ctx.db, ctx.broadcastToAll, id),
      parkClaudeSession: parkTopicSession,
      recordRetirement: (id, at) => recordRetirement(ctx.db, "topic", id, at, "archive"),
    }, topicId);
    // Nessuna risposta HTTP da restituire qui: la purge fallita si logga, non
    // può fermare il ritiro (il task è finito comunque).
    if (res.purgeError) {
      console.error(`[archive] purge di ui_state fallita per topicId=${topicId}:`, res.purgeError);
    }
  },
  retireTerminal: (sessionId) => { retireTerminalSession(sessionId); },
};

/**
 * Turni in volo adesso, per chi deve leggerli DENTRO le dipendenze del
 * dispatcher (che a quel punto non esiste ancora). Zero finché non esiste: un
 * conteggio assente vale «nessuno», mai un'eccezione dentro un tick.
 */
const turniInVolo = (): number => {
  try { return taskDispatcher.busyCount(); } catch { return 0; }
};

/**
 * Il lavoro consegnato da una card è già dentro main?
 *
 * Si guarda per CONTENUTO (`commitStatusFromRepo` + `classifyLanding`, gli stessi
 * dell'audit degli atterraggi) e non per sola discendenza, perché il land RICOPIA
 * i commit della card (`cherry-pick -C <sha>`) invece di fonderli: dopo un land
 * riuscito il commit di consegna NON è antenato di main, e una risposta basata
 * sull'ancestry direbbe «non atterrato» sul caso normale.
 *
 * `unverifiable` esce `null`, che non è `false`: non aver potuto guardare non è
 * una prova di fallimento, e i due chiamanti ne fanno usi che non perdonano la
 * confusione — uno scioglie un worktree, l'altro CHIUDE una card.
 *
 * Una funzione sola perché le due risposte non possono divergere: se l'audit
 * dice «atterrato» e il dispatcher dice «no», il dispatcher rimanda un agente su
 * lavoro che la board mostra come finito.
 */
async function deliveryIsOnMain(repoPath: string, commit: string): Promise<boolean | null> {
  const state = classifyLanding(await commitStatusFromRepo(repoPath, commit));
  return state === "unverifiable" ? null : state === "landed";
}

/**
 * Assegnata piu' in basso, dov'e' possibile costruirla (servono gli sguardi sul
 * worktree). Il dispatcher nasce prima e la chiama solo a turno finito, quindi
 * il riferimento in avanti e' sicuro: prima di allora non c'e' nessun turno.
 */
let capturaConsegna: DeliveryCapture | null = null;
/**
 * I file lasciati nel worktree e mai committati, per la consegna forzata.
 *
 * Tardiva come `capturaConsegna` e per la stessa ragione: `worktreeOfTask`
 * nasce piu' in basso di queste deps. La usa il dispatcher SOLO quando la
 * storia di git e' vuota, per non far dire alla card «nessun file toccato»
 * mentre il lavoro sta sul disco.
 */
let sondaLavoroNonCommittato: ((taskId: string) => Promise<string[] | null>) | null = null;

/**
 * Quante corse di check pre-review stanno girando adesso.
 *
 * Il dispatcher viene costruito PRIMA della rotta dei task (che e' la closure
 * che tiene il `checksGate`). Il riferimento in avanti e' sicuro per lo stesso
 * motivo di `capturaConsegna`: il dispatcher chiama `checksRunning` solo dentro
 * il tick o il resume, che sono entrambi dopo la costruzione della rotta. Zero
 * finche' non esiste: un conteggio assente vale «nessuno», mai un'eccezione
 * dentro un tick.
 *
 * Questo e' il collegamento che chiude il freno: prima mancava, e sei card che
 * consegnavano nello stesso quarto d'ora lanciavano sei barre di check in
 * parallelo. Con `test:unit` da solo a 322s e piu' core, il loadavg andava a
 * 78,83 su 12 core.
 */
let checksGateRunningCount: (() => number) | null = null;
/** `checksGate.isRunning(taskId)`: running OR queued behind another card's run. */
let checksGateIsRunning: ((taskId: string) => boolean) | null = null;
/**
 * Is the task this session works on waiting on OUR pre-review checks? The
 * stall detector must not judge that silence: the agent asked for review, the
 * gate said 202 and is grinding typecheck/lint/test:unit, and the agent is
 * waiting on us. `checks_state='running'` covers the run; the gate covers the
 * queue behind another card (one run at a time, minutes each).
 */
function isChecksHold(sessionKey: string): boolean {
  const topicPrefix = sessionKey.startsWith("topic:") ? sessionKey.slice("topic:".length) : sessionKey;
  if (!topicPrefix) return false;
  try {
    const row = db.prepare(
      `SELECT id, checks_state FROM tasks WHERE status = 'in_progress' AND assigned_topic_id LIKE ? LIMIT 1`,
    ).get(topicPrefix + "%") as { id: string; checks_state: string | null } | null;
    if (!row) return false;
    return row.checks_state === "running" || (checksGateIsRunning?.(row.id) ?? false);
  } catch {
    return false;
  }
}

const taskAttemptStore = createTaskAttemptStore(ctx.db);
const taskDispatcher = createTaskDispatcher({
  captureDelivery: (taskId) => capturaConsegna ? capturaConsegna(taskId) : Promise.resolve(false),
  uncommittedInWorktree: (taskId) =>
    sondaLavoroNonCommittato ? sondaLavoroNonCommittato(taskId) : Promise.resolve(null),
  svc: dispatcherSvc,
  // Self-heal dead bindings: a todo task linked to a topic that was reaped
  // (agent tab deleted after a prior run) would never dispatch. tick() clears
  // the dead link so the task runs again.
  topicExists: (id) => !!ctx.getTopicById(id),
  // Il cancello contro il lavoro rifatto: se il commit della consegna è già
  // dentro main, la card si chiude invece di far ripartire un agente sopra
  // codice che c'è già. Stessa risposta che legge l'audit degli atterraggi.
  deliveryLanded: (repoPath, commit) => deliveryIsOnMain(repoPath, commit),
  // Must match the catch-all dir tasks.ts scaffolds (join(workspaceDir,
  // "generale")): a session resolved here renders standalone, not as a project.
  catchAllProjectPath: join(DISPATCH_WORKSPACE_DIR, "generale"),
  // Private per-task cwd for a catch-all task: a unique dir under the workspace
  // so the task's topic gets a unique projectPath (→ its own splittable
  // workspace claims the agent's browser panes). Non-git, like the shared
  // catch-all dir, so the worktree guard behaves identically.
  catchAllTaskDir: (taskId) => {
    const dir = join(DISPATCH_WORKSPACE_DIR, "tasks", taskId.slice(0, 8));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  // "modello auto" → a fast haiku one-shot classifies the task and picks the
  // tier before the agent spawns. Standard is OPUS-first: unsure/unavailable/
  // empty-snapshot all resolve to opus (the human's default), never a silent
  // downgrade — the picker itself never throws (see task-model-picker.ts).
  pickAutoModel: async (task) => {
    // L'Opus di ripiego non si scrive a mano: un id fisso qui è come si finisce
    // a dispatchare agenti su una generazione vecchia per settimane senza che
    // niente lo segnali. `FALLBACK_MODELS` è la lista che il resto del codice
    // già mantiene, e serve solo quando lo snapshot non c'è. `preferLong`: la
    // finestra da un milione dove l'host la serve, non i 200k di un id nudo.
    const staticOpus = newestOfFamily("opus", FALLBACK_MODELS, { preferLong: true }) ?? FALLBACK_MODELS[0]!;
    try {
      const provider = getProvider("claude-code");
      const { getSnapshotManager } = await import("./server/providers/snapshot-manager");
      const snap = getSnapshotManager().getSnapshot();
      const cc = snap?.providers?.find((p) => p.name === "claude-code");
      const availableModels = cc?.models ?? [];
      // No snapshot yet → can't classify, but opus-first means we still hand the
      // agent opus (the human's default + this host's primary), never a downgrade.
      // Entrambi i null dicono «non lo so», e nessuno dei due viene inventato
      // qui: l'effort ricade sulla board, il peso vale leggero — cioè lo
      // scheduler si comporta come prima che il peso esistesse. Un giudice che
      // non può parlare non deve poter fermare la coda della board.
      if (availableModels.length === 0) return { model: staticOpus, effort: null, weight: null };
      const plan = await pickTaskPlan(task, {
        // Force the cheapest tier for the classification itself.
        complete: (prompt) =>
          provider.complete([{ role: "user", content: prompt }], { model: "claude-haiku-4-5" }).then((r) => r.content ?? ""),
        availableModels,
        fallback: newestOfFamily("opus", availableModels, { preferLong: true }) ?? staticOpus,
        log: (m) => console.log(`[dispatcher] ${m}`),
      });
      return plan;
    } catch {
      // any failure → opus-first, never a silent downgrade; effort e peso null
      // per la stessa ragione: la board decide l'uno, l'altro vale leggero.
      return { model: staticOpus, effort: null, weight: null };
    }
  },
  // Auto concurrency cap: live machine capacity for boards on `maxAgentsAuto`.
  //
  // I turni in volo vanno passati: il freno vivo è un credito (budget di CPU
  // della flotta meno quello che gli agenti vivi già bruciano), e senza sapere
  // quanti sono si sottrarrebbe il loro costo dal tetto TOTALE invece che dai
  // posti residui. Letto dentro la closure, non alla costruzione: il dispatcher
  // esiste solo dopo questa chiamata.
  recommendedCap: () => computeDispatchCapacity(turniInVolo()).recommended,
  // Corse di check pre-review in volo: ogni barra vale uno slot nel freno.
  // Letto dalla closure: il checksGate nasce dentro `createTasksRouter`, che e'
  // dopo questa chiamata, ma prima del primo tick o resume. Zero finche' non
  // esiste: stesso pattern di `capturaConsegna`.
  checksRunning: () => checksGateRunningCount?.() ?? 0,
  // Don't drop an agent into a repo somebody is already working by hand.
  externalSessionsAt: (path) =>
    externalSessions.activeAt(path).map((s) => ({ cwd: s.cwd, branch: s.branch })),
  resolveProject: (projectId) => {
    const c = resolveProjectPath(
      projectId,
      buildProjectCandidates({
        projectStore: ctx.projectStore,
        workspaceDir: DISPATCH_WORKSPACE_DIR,
        extraPaths: dispatchExtraPaths,
      }),
    );
    if (!c) return null;
    // Worktrees require a ProjectStore row. Ad-hoc projects (path-only
    // candidates) that are git repos get registered on demand, so the default
    // "isola in un worktree" board setting actually works for them instead of
    // parking every task with "progetto non registrato".
    let storeId = c.projectStoreId;
    if (!storeId && existsSync(join(c.path, ".git"))) {
      try {
        const existing = ctx.projectStore.getByPath(c.path);
        if (existing) {
          storeId = existing.id;
        } else {
          const name = basename(c.path);
          let slug = ctx.projectStore.slugify(name);
          // Slug is UNIQUE; a same-named project at another path gets a suffix.
          if (ctx.projectStore.getBySlug(slug)) slug = `${slug}-${Date.now().toString(36)}`.slice(0, 64);
          storeId = ctx.projectStore.create({ name, slug, path: c.path }).id;
          console.log(`[dispatcher] auto-registered project "${name}" (${c.path}) for worktree dispatch`);
        }
      } catch (err) {
        console.error(`[dispatcher] project auto-register failed for ${c.path}`, err);
      }
    }
    return { path: c.path, projectStoreId: storeId };
  },
  createTopic: (o) => {
    // A card whose model is "codex" (or "codex:<model>", or a gpt-* id) runs
    // on the OpenAI CLI provider: the board can spread mechanical work over a
    // second quota. Plain "codex" passes no --model (ChatGPT-account auth
    // rejects a forced model, see server/providers/codex.ts).
    const codexModel = o.model === "codex" ? "" : o.model?.startsWith("codex:") ? o.model.slice("codex:".length) : o.model?.startsWith("gpt-") ? o.model : null;
    const provider = codexModel !== null ? "codex" : undefined;
    const model = codexModel !== null ? (codexModel || undefined) : o.model;
    const { topic } = createDetachedTopic(
      // background: an agent session never pops a tab — it lives in the
      // sidebar; the task drawer's "apri tab" un-archives it on demand.
      { name: o.name, projectPath: o.projectPath, worktreeId: o.worktreeId, systemPrompt: o.systemPrompt, effort: o.effort, model, provider, background: true, standalone: o.standalone, mcpPolicy: o.mcpPolicy, autonomyLevel: o.autonomyLevel ?? DISPATCH_AUTONOMY },
      {
        getTopicById: ctx.getTopicById,
        loadTopics: ctx.loadTopics,
        saveSingleTopic: ctx.saveSingleTopic,
        slugify: ctx.slugify,
        broadcastToAll: ctx.broadcastToAll,
      },
    );
    return { topicId: topic.id, sessionKey: topic.sessionKey };
  },
  // ── Fan-out (dispatchFanOut > 1) ─────────────────────────────────────────
  // Le quattro dipendenze che trasformano "un agente" in "N tentativi": dove si
  // scrivono le righe, come si misura cosa ha prodotto ognuno, come si chiama il
  // suo branch, e come si spegne la chat di un perdente. Assenti ⇒ il dispatcher
  // resta al path storico, un agente per task.
  attempts: taskAttemptStore,
  attemptStats: async (worktreeId) => {
    const wt = ctx.worktreeStore.get(worktreeId);
    if (!wt || wt.mode !== "branch" || !wt.absPath || !existsSync(wt.absPath)) return null;
    // Il branch va DETTO: è la chiave con cui si separa il lavoro del tentativo
    // da quello che ha soltanto ereditato dal checkout condiviso.
    return worktreeDiffStat(wt.absPath, { branch: wt.branchName ?? undefined });
  },
  worktreeBranch: (worktreeId) => ctx.worktreeStore.get(worktreeId)?.branchName ?? null,
  // Potatura dei topic dei tentativi a fine task. Passa dal servizio condiviso,
  // non da una terza implementazione: qui si archiviava e basta, e ogni task
  // dispacciato lasciava dietro un badge di non letti su una conversazione non
  // più apribile e un id fantasma in `ui_state` che risuscitava al reload.
  archiveTopic: retirementConsequences.archiveTopic,
  // Il pavimento sulle risorse, misurato sul volume che ospita davvero le
  // worktree. Serve da quando il tetto sugli agenti si può togliere: senza,
  // «nessun limite» vuol dire che la coda si ferma a disco pieno, cioè quando
  // le scritture del DB cominciano a fallire.
  // Il pavimento di RAM dipende da COSA costa un agente, e questa è l'unica
  // riga che lo sa: `cli` significa un processo Node per sessione (240-420 MB,
  // margine 12 GB), il runtime nativo significa un array di messaggi dentro
  // questo stesso server (2,3 MB misurati, margine 2 GB). Tenere il margine
  // delle CLI per agenti che non sono processi ferma la coda su una macchina
  // che sta benissimo — osservato il 2026-08-16 con 8,7 GB liberi.
  //
  // Si rilegge a ogni tick invece di fissarlo al boot: chi cambia runtime in
  // Impostazioni si aspetta che valga da subito, e questa lettura costa una
  // riga di SQLite già in cache.
  resourceBlock: () =>
    dispatchResourceBlock(
      ctx.worktreeManager.worktreesDir(),
      undefined,
      undefined,
      resolveAgentRuntime() === "cli",
    ),
  createWorktree: async (projectStoreId) => {
    // Il ramo di una card nasce da MAIN, non dall'HEAD del checkout condiviso:
    // con `HEAD` il worktree ereditava il ramo di chi stava lavorando qui, e da
    // lì arrivavano collisioni di migration, consegne su commit mai landati e
    // land che pubblicavano lavoro di terzi. Il perché per esteso, e il ripiego
    // su HEAD quando `main` non c'è, stanno in `worktree-base-ref.ts`.
    const base = await resolveWorktreeBaseRef(ctx.projectStore.get(projectStoreId)?.path);
    if (base.fallback) console.warn(`[dispatch] ${base.reason}: il worktree parte da HEAD`);
    const wt = await ctx.worktreeManager.create({ projectId: projectStoreId, mode: "branch", baseRef: base.baseRef });
    const ready = await ctx.worktreeManager.awaitMaterialisation(wt.id, WORKTREE_READY_MS);
    if (ready.status !== "ready") {
      throw new Error(`worktree ${wt.id}: ${ready.status}${ready.errorMessage ? " " + ready.errorMessage : ""}`);
    }
    return ready.id;
  },
  deleteWorktree: async (worktreeId) => { await ctx.worktreeManager.delete(worktreeId); },
  // C'e' qualcosa da perdere in questo worktree? Serve al dispatcher per NON
  // cancellare il branch di un tentativo rimesso in coda che pero' aveva gia'
  // committato (turno troncato dall'infrastruttura dopo il commit: il task
  // torna in `todo`/`backlog` e il cleanup portava via anche i commit).
  //
  // Due domande, entrambe: commit non su main (letti per CONTENUTO, quindi
  // reggono anche a un land in squash) e sporco reale nell'albero (junk
  // escluso). In caso di dubbio si risponde SI': non sapere non autorizza a
  // distruggere.
  // Carico vivo per la modalità notturna. Stessa fonte del tetto "Auto", così
  // le due decisioni non possono divergere leggendo due misure diverse.
  capacity: () => {
    const c = computeDispatchCapacity(turniInVolo(), undefined, resolveAgentRuntime() === "cli");
    return { load1: c.load1, cores: c.cores, reason: c.reason };
  },
  // Il carico che è NOSTRO, per il freno dei task pesanti. Non è un'altra
  // lettura di `capacity()`: quello è il load average della macchina intera, e
  // la notte del 12/08 su questo host valeva fra 37 e 48 mentre i nostri agenti
  // usavano 0,75% su 1200% di CPU. Il carico erano le app dell'umano, e il freno
  // le addebitava a noi tenendo ferma la board per ore.
  ownLoad: () => {
    try { return fleetLoadSync(); } catch { return null; }
  },
  // Sessioni di terminale con un client ATTACCATO: è il segnale «c'è qualcuno».
  // Una sessione viva ma senza nessuno che la guarda non conta come presenza —
  // altrimenti un agente dimenticato terrebbe il turno notturno bloccato.
  humanSessionsLive: () => {
    try { return countAttachedTerminalSessions(); } catch { return 0; }
  },
  worktreeHasWork: async (worktreeId) => {
    const wt = ctx.worktreeStore.get(worktreeId);
    if (!wt) return false;               // riga sparita: non c'e' nulla da tutelare
    if (wt.mode !== "branch") return false; // niente branch proprio, niente commit da perdere
    try {
      if (wt.absPath && existsSync(wt.absPath)) {
        const dirt = await worktreeRealDirt(wt.absPath);
        if (dirt.length > 0) return true;
      }
      if (!wt.branchName) return false;
      const repoPath = ctx.projectStore.get(wt.projectId)?.path;
      if (!repoPath) return true;        // non so leggere il repo -> tutelo
      return (await branchStatusFromRepo(repoPath, wt.branchName)) === "unmerged";
    } catch {
      return true;
    }
  },
  runTurn: runHeadlessTurn,
  // ai-bridge restart recovery: the provider answers whether a turn survived in
  // the broker (returns false when the flag is off / provider lacks it), and
  // runHeadlessReattach drives the adopted turn. Both are safe no-ops off-broker.
  hasLiveSession: (sessionKey) => {
    const p = tryGetProvider("claude-code") as unknown as { hasLiveSession?: (sk: string) => Promise<boolean> } | undefined;
    return typeof p?.hasLiveSession === "function" ? p.hasLiveSession(sessionKey) : Promise.resolve(false);
  },
  reattach: (sessionKey, opts) => runHeadlessReattach(sessionKey, opts),
  // Liveness net: is the agent CHILD of this session still there? Same probe the
  // stream watchdog uses to tell a thinking-but-mute turn from a dead one (it
  // covers direct AND broker mode — the daemon's `exit` frame flips pp.alive).
  // A provider that doesn't own the session answers null = "can't tell", and the
  // dispatcher never buries a turn on ignorance.
  //
  // Si chiede al provider che POSSIEDE la sessione, non sempre a claude-code.
  // Chiedere a lui di una sessione altrui otteneva `false` — «l'ho guardato ed
  // è morto» invece di «non è roba mia» — e sul `false` il dispatcher
  // seppellisce dopo due sweep. Finché ogni agente dispacciato era claude-code
  // i due casi coincidevano; col runtime `jcode` di default ogni sessione
  // dispacciata è di un altro provider, quindi la confusione passa da
  // impossibile a sistematica. Vedi `resolveTurnAlive`.
  isTurnAlive: (sessionKey) => resolveTurnAlive(sessionKey),
  // Usage consumed by the dispatched session so far, from its Claude Code
  // transcript (jsonl_path is kept fresh by the session tracker). The reader
  // (transcript-usage.ts) is incremental (per-path byte offset — the live
  // ticker polls every 4s) and DEDUPLICATES usage rows by message.id (Claude
  // Code writes one per content block; the old inline sum overcounted ~2.4x).
  // Best-effort — a missing/unparsable transcript reads as zeros, and the
  // dispatcher only books per-turn deltas.
  //
  // LE FIGLIE SONO DENTRO. Il coordinatore delega il lavoro a sessioni proprie,
  // e il loro consumo è consumo DI QUESTA CARD: senza sommarlo, la card che
  // spende di più risulterebbe la più economica. Vedi dispatch-usage.ts, che
  // tiene anche il ledger delle figlie ormai chiuse (una somma sulle sole vive
  // scenderebbe, e un calo il dispatcher lo appiattisce a zero).
  // IL NATIVO PRIMA, IL TRANSCRIPT COME RIPIEGO — e l'ordine e' il punto.
  // `dispatchUsageReader` legge i JSONL di Claude Code; il runtime nativo gira
  // in processo e non ne scrive nessuno, quindi per lui quel lettore rispondeva
  // sempre zero. Misurato il 18/08: 43 card con turni registrati e costo zero,
  // cioe' tutte quelle lavorate dal nativo. `readNativeUsage` torna `null` (non
  // zero) quando il nativo non ha mai girato su quella sessione: e' cio' che
  // lascia intatto il ripiego per le sessioni CLI.
  getSessionUsage: (sessionKey: string) => readNativeUsage(sessionKey) ?? dispatchUsageReader.read(sessionKey),
  // What the session is running RIGHT NOW, for the card's «Bash · bun run
  // test:unit · 3m» line. The tracker learns it from the CLI hooks (PreToolUse
  // sets `lastTool`, PostToolUse clears it); a runtime that posts no hooks
  // reads as `null`, and the card simply draws no line.
  sessionActivity: (sessionKey: string) => {
    const s = claudeSessionTracker.getSessionByKey(sessionKey);
    return s?.lastTool ? { name: s.lastTool.name, input: s.lastTool.input, since: s.lastTool.startedAt } : null;
  },
  // Last assistant prose in the session — the dispatcher mirrors it into a task
  // comment at delivery when the agent forgot comment_task, so a review always
  // carries the agent's own summary. Reads the local message store (sync).
  getLastAgentText: (sessionKey: string) => {
    try {
      const msgs = ctx.loadLocalMessages(sessionKey, { withBlocks: false });
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "assistant" || typeof m.content !== "string") continue;
        const testo = m.content.trim();
        if (!testo) continue;
        // UN CARTELLO NON SONO LE PAROLE DELL'AGENTE.
        //
        // Questo recupero esiste per una ragione precisa: quando un turno
        // muore prima che l'agente possa commentare, il dispatcher rispecchia
        // la sua ultima prosa nel thread della card, cosi' chi rivede legge
        // "cosa ho fatto" invece di una nota di sistema. Ma prendeva l'ultimo
        // messaggio assistente QUALUNQUE FOSSE — e quando il turno muore, il
        // messaggio piu' recente e' proprio il cartello che ne annuncia la
        // morte: «⚠️ Turno interrotto da un riavvio del server…».
        //
        // Misurato sulla card 235afe11 (20/08): sotto quel cartello c'erano le
        // parole vere dell'agente, ma il recupero si fermava alla prima riga e
        // portava il cartello — cioe' rispecchiava sulla card l'annuncio del
        // guasto al posto del lavoro. La card e' arrivata in review muta con il
        // testo buono a due righe di distanza.
        //
        // I cartelli sono quelli che il client riconosce col prefisso ⚠️
        // (`turnError.ts`): li si SALTA e si continua a scendere, perche' sotto
        // c'e' quasi sempre la prosa che stiamo cercando.
        if (testo.startsWith(TURN_ERROR_PREFIX)) continue;
        return m.content;
      }
    } catch { /* best-effort — no mirror on failure */ }
    return null;
  },
  // Review-ready previews: on delivery to review, boot a live preview server
  // from the task's worktree and point output_url at the local deep-link (never
  // prod). Lazy — reads `previewManager` when a turn actually reaches review.
  preparePreview: (taskId) => previewManager?.prepareForReview(taskId) ?? Promise.resolve(),
  teardownPreview: (taskId) => previewManager?.teardown(taskId) ?? Promise.resolve(),
  // Consegnata la card, il suo worktree smette di pesare per le dipendenze: via
  // `node_modules` e le cache di build, restano cartella, branch e commit. È il
  // momento giusto perché la maggior parte delle card NON landa subito, e sono
  // proprio i giorni di attesa in review a costare ~260 MB l'una.
  slimWorktree: (taskId) => worktreeGc.slimWorktreeOfTask(taskId),
  broadcast: ctx.broadcastToAll,
});

// Opt-in auto-merge on approve (board setting `dispatchAutoMerge`). Resolves a
// task → its dispatch topic → worktree → project's main checkout, then merges the
// branch there. Only `branch`-mode worktrees on a ready project have something to
// land; everything else resolves to null (skip). Default branch is `main`.
const worktreeOfTask = (taskId: string) => {
  // Percorso primario: task → assigned_topic_id → topic.worktree_id → worktree.
  // Funziona finché il dispatcher tiene il legame vivo.
  const topicId = dispatcherSvc.get(taskId)?.task.assignedTopicId;
  if (topicId) {
    const worktreeId = ctx.getTopicById(topicId)?.worktreeId;
    if (worktreeId) return ctx.worktreeStore.get(worktreeId) ?? null;
  }
  // Percorso di ripiego: dopo un `release()` il dispatcher azzera
  // `assigned_topic_id`, ma il record del tentativo corrente conserva
  // `worktree_id`. Cerchiamo l'ultimo tentativo in stato `running` (o
  // comunque con un worktree collegato) per questo task.
  //
  // Incidente 18/08: card `171b787d` in review con 279 righe non committate
  // e `deliveryFilesChanged: 0` perche' `worktreeOfTask` tornava null dopo
  // che il dispatcher aveva rilasciato la card — e la sonda `taskWorktreeDirt`
  // leggeva null come «pulito» invece che come «non so».
  try {
    const row = ctx.db.prepare(
      `SELECT worktree_id FROM task_attempts
        WHERE task_id = ? AND worktree_id IS NOT NULL
        ORDER BY idx DESC LIMIT 1`,
    ).get(taskId) as { worktree_id: string } | undefined;
    if (row?.worktree_id) return ctx.worktreeStore.get(row.worktree_id) ?? null;
  } catch { /* fallback is best-effort */ }
  return null;
};

// ── Review-ready previews ──────────────────────────────────────────────────
// One preview server per task, booted from its branch worktree at review-time.
// `previewManager` owns the lifecycle; the host wires HOW to start/probe/shoot.
// La cartella dell'anteprima deve stare DENTRO l'allowlist che poi la serve
// (`isPathAllowed` → `${OPENCLAW_DIR}/media/`). Scritta con `homedir()` le due
// coincidevano solo finché `APP_DATA_DIR`/`OPENCLAW_DIR` restavano al default:
// spostata la cartella dati, il file veniva scritto dove nessuno può leggerlo e
// la card mostrava un'immagine rotta.
const PREVIEW_MEDIA_DIR = join(ctx.OPENCLAW_DIR, "media", "task-previews");
const PREVIEW_SCRIPT_CANDIDATES = ["preview", "dev", "start"];

/** `lsof` per le domande d'identità sulla porta (macOS non lo ha sempre nel PATH). */
function lsofBin(): string { return Bun.which("lsof") ?? "/usr/sbin/lsof"; }

/** stdout di un comando breve, "" se fallisce o sfora `ms`. Best-effort by design. */
async function previewCmdOutput(cmd: string[], ms = 2000): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const t = setTimeout(() => { try { proc.kill(); } catch { /* già uscito */ } }, ms);
    try { return await new Response(proc.stdout).text(); } finally { clearTimeout(t); }
  } catch { return ""; }
}

previewManager = createPreviewManager({
  worktreeOf: (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt) return null;
    return { id: wt.id, absPath: wt.absPath, branchName: wt.branchName, projectId: wt.projectId, mode: wt.mode };
  },
  // Env override (TOPICS_PREVIEW_CMD / TOPICS_PREVIEW_PATH) wins; otherwise pick
  // the first present of preview/dev/start in the worktree's package.json. The
  // server honours PORT (injected by the manager) so the pool port sticks.
  resolveCommand: (_taskId, wt) => {
    const deepLinkPath = process.env.TOPICS_PREVIEW_PATH?.trim() || "/";
    const override = process.env.TOPICS_PREVIEW_CMD?.trim();
    if (override) return { cmd: override.split(/\s+/), deepLinkPath };
    try {
      const pkgPath = join(wt.absPath, "package.json");
      if (!existsSync(pkgPath)) return null;
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf-8"))?.scripts ?? {}) as Record<string, string>;
      const script = PREVIEW_SCRIPT_CANDIDATES.find((s) => typeof scripts[s] === "string" && scripts[s].trim());
      if (!script) return null;
      return { cmd: ["bun", "run", script], deepLinkPath };
    } catch { return null; }
  },
  spawn: (cmd, opts): PreviewProcess => {
    const child = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    return {
      get pid() { return child.pid ?? null; },
      alive() { return child.exitCode === null && !child.killed; },
      kill() { try { child.kill(); } catch { /* already gone */ } },
    };
  },
  probe: async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try { await fetch(url, { signal: ctrl.signal, redirect: "manual" }); return true; }
      finally { clearTimeout(t); }
    } catch { return false; }
  },
  // Cancello d'IDENTITÀ. `probe` dice solo che la porta parla; queste due dicono
  // CHI parla. Il listener è quasi sempre un discendente del figlio che
  // spawniamo (`bun run dev` → server), quindi il pid da solo non basta: il cwd
  // ereditato (= worktree del task) è ciò che lo riconosce.
  listenerPid: async (port) => {
    const out = await previewCmdOutput([lsofBin(), "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = out.split(/\s+/).map(Number).find((n) => Number.isFinite(n) && n > 0);
    return pid ?? null;
  },
  processCwd: async (pid) => {
    if (process.platform === "linux") {
      try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* lsof fallback */ }
    }
    const out = await previewCmdOutput([lsofBin(), "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = out.split("\n").find((l) => l.startsWith("n/"));
    return line ? line.slice(1) : null;
  },
  // `lsof` risponde col path REALE, il worktree porta quello con cui è nato: su
  // macOS `/tmp` è un link a `/private/tmp`, e senza risolverli il cancello
  // d'identità legge due nomi della stessa cartella come due cartelle diverse.
  realPath: async (p) => { try { return realpathSync(p); } catch { return null; } },
  // Cancello sul CONTENUTO: la pagina si LEGGE prima di fotografarla, così un
  // 503 «Bundle not built yet» non finisce sulla card come evidenza del lavoro.
  // Una foto riuscita puo' essere una pagina bianca: si guarda la densita' del
  // file, che per un PNG dice se e' stato disegnato qualcosa. Il pavimento e'
  // misurato, non scelto (vedi image-shape.ts).
  blankShot: (path) => {
    try {
      const forma = imageShape(path);
      if (!forma) return false;
      return isBlankLikeImage({ bytes: statSync(path).size, width: forma.width, height: forma.height });
    } catch { return false; }
  },
  fetchPage: async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
        return { status: res.status, body: (await res.text()).slice(0, 200_000) };
      } finally { clearTimeout(t); }
    } catch { return null; }
  },
  // Reuse the already-running headless Chromium (no extra launch) via a throwaway
  // context, sized to 1440px. Best-effort → boolean.
  screenshot: async (url, outPath, opts) => {
    let port = "0"; try { port = new URL(url).port || "0"; } catch { /* keep */ }
    const id = `preview-shot:${port}`;
    try {
      // Viewport, non full-page: la card disegna l'anteprima in `object-cover`
      // e un'immagine più alta di `PREVIEW_CARD_MAX_RATIO` (0.70) volte la
      // larghezza la TAGLIA invece di rimpicciolirla — 1440×760 = 0.528 sta
      // dentro con margine, una full-page no.
      await browserService.createContext(id, { viewport: { width: opts.width, height: 760 } });
      const nav = await browserService.navigate(id, url);
      if (nav.error) return false;
      await new Promise((r) => setTimeout(r, 1500)); // let the first paint settle
      const buf = await browserService.screenshot(id, { format: "png", fullPage: false });
      writeFileSync(outPath, buf);
      return true;
    } catch (err) {
      console.error("[preview] screenshot", err);
      return false;
    } finally {
      try { await browserService.destroyContext(id); } catch { /* ignore */ }
    }
  },
  currentOutputUrl: (taskId) => dispatcherSvc.get(taskId)?.task.outputUrl ?? null,
  setOutputUrl: (taskId, url) => {
    const projectId = dispatcherSvc.get(taskId)?.task.projectId;
    if (!projectId) return;
    try {
      const t = dispatcherSvc.update({ taskId, actor: "agent", by: "verifier", patch: { outputUrl: url }, projectId });
      ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch (err) { console.error("[preview] setOutputUrl", err); }
  },
  setPreviewImage: (taskId, absPath) => {
    const projectId = dispatcherSvc.get(taskId)?.task.projectId;
    if (!projectId) return;
    try {
      const t = dispatcherSvc.update({ taskId, actor: "agent", by: "verifier", patch: { previewImage: absPath }, projectId });
      ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch (err) { console.error("[preview] setPreviewImage", err); }
  },
  // THE RETIREMENT WAS NEVER WIRED. `retirePreview` is optional in
  // `PreviewManagerDeps` and was not passed: both content gates (placeholder or
  // error, and blank page) fell through to `setPreviewImage(taskId, "")`, which
  // by contract turns no state on. Measured on 2026-08-23: four cards in review
  // carrying the "Anteprima: ritirata" note in the thread, all with
  // `preview_retired_at` NULL and the rejected shot still on them.
  retirePreview: (taskId, reason) => {
    const projectId = dispatcherSvc.get(taskId)?.task.projectId;
    if (!projectId) return;
    try {
      const t = dispatcherSvc.retirePreview({ taskId, reason });
      ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch (err) { console.error("[preview] retirePreview", err); }
  },
  addReviewNote: (taskId, { content, media, kind, replaces }) => {
    const projectId = dispatcherSvc.get(taskId)?.task.projectId;
    try {
      dispatcherSvc.addComment({ taskId, author: "verifier", content, media, projectId, kind: kind ?? "review-note", replaces });
      const t = dispatcherSvc.get(taskId)?.task;
      if (t) ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch (err) { console.error("[preview] addReviewNote", err); }
  },
  registerProcess: (entry) => registerPreviewProcess(entry),
  unregisterProcess: (taskId) => unregisterPreviewProcess(taskId),
  // Chi ASCOLTA sulla porta e' un DISCENDENTE di `bun run dev`, non il figlio
  // che spawniamo: senza l'albero il teardown lasciava il server vivo con la
  // porta occupata. Stessa primitiva del bottone Stop del pannello.
  killTree: (pid) => killProcessTree(pid),
  // I worktree che questa macchina conosce: e' il riconoscimento della spazzata
  // d'avvio ("chi tiene questa porta del pool e' una nostra anteprima?").
  knownWorktreePaths: () => ctx.worktreeStore.list().map((w) => w.absPath).filter(Boolean),
  // Chi il pannello Processi rivendica non e' un residuo: il dev server che un
  // agente ha acceso col `run_script` nel SUO worktree ascolta su una porta e
  // sta in una cartella conosciuta, cioe' e' identico a un'anteprima orfana per
  // tutto cio' che la spazzata sa guardare.
  protectedPids: () => trackedScriptPidTrees(),
  mediaDir: PREVIEW_MEDIA_DIR,
  ensureMediaDir: () => { try { mkdirSync(PREVIEW_MEDIA_DIR, { recursive: true }); } catch { /* ignore */ } },
  log: (msg, err) => console.error(msg, err ?? ""),
});

// SPAZZATA D'AVVIO delle anteprime rimaste in piedi. Il registro delle anteprime
// vive sta in MEMORIA: un server morto (o ricaricato) mentre una era su lascia il
// suo albero acceso e la porta del pool occupata PER SEMPRE, e nessun altro le
// raccoglie — il rilevatore del pannello attribuisce per albero di una PTY
// claude, e un'anteprima non e' figlia di nessuna PTY. Con 51 porte bastano
// poche morti per lasciare una card in review senza evidenza. Differita e
// best-effort: un `lsof` per porta non deve stare sulla strada del boot.
// SPAZZATA D'AVVIO delle card in review rimaste senza anteprima: la scheda di
// consegna nasce sulla transizione verso review, e le card gia' ferme li' non
// ne attraversano piu' nessuna. Senza questa passata resterebbero cieche per
// sempre (erano 9 su 16 il 20/08). Differita e best-effort come la spazzata
// delle anteprime vive qui sotto.
setTimeout(() => {
  try {
    const n = dispatcherSvc.sweepReviewPreviews();
    if (n) console.log(`[preview] spazzata d'avvio: ${n} card in review hanno di nuovo un'anteprima`);
  } catch (err) { console.error("[preview] spazzata delle anteprime in review fallita", err); }
}, 8_000).unref?.();

setTimeout(() => {
  previewManager?.sweepOrphans()
    .then((ports) => { if (ports.length) console.log(`[preview] spazzata d'avvio: liberate le porte ${ports.join(", ")}`); })
    .catch((err) => console.error("[preview] spazzata d'avvio fallita", err));
}, 10_000).unref?.();

const taskAutoMerge = createTaskAutoMerge({
  resolveTaskMerge: (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch" || !wt.branchName) return null;
    const repoPath = ctx.projectStore.get(wt.projectId)?.path;
    if (!repoPath) return null;
    return { repoPath, branch: wt.branchName, defaultBranch: "main" };
  },
  // Il ripiego che NON passa dall'agente. `worktreeOfTask` risolve attraverso
  // `assigned_topic_id`, che si svuota ogni volta che l'agente viene rilasciato
  // — cosa di routine — e da lì in poi una consegna col ramo intatto diventava
  // non-landabile. La card però il ramo lo dichiara da sé (`delivery_branch`,
  // registrato quando è entrata in review), e il checkout del suo progetto si
  // ricava dal board id come fa l'audit: invertendo l'hash del percorso.
  ownBranches: (taskId) => taskAttemptStore.list(taskId).map((a) => a.branch).filter((b): b is string => typeof b === "string" && b.length > 0),
  declaredDelivery: (taskId) => {
    const task = dispatcherSvc.get(taskId)?.task;
    if (!task) return null;
    const branch = task.deliveryBranch ?? null;
    if (!branch) return null;
    let repoPath: string | null = null;
    try {
      repoPath = resolveProjectPath(
        task.projectId,
        buildProjectCandidates({
          projectStore: ctx.projectStore,
          workspaceDir: DISPATCH_WORKSPACE_DIR,
          extraPaths: dispatchExtraPaths,
        }),
      )?.path ?? null;
    } catch (err) { console.warn("[land] checkout non risolto per", taskId, err); }
    return { repoPath, branch };
  },
  log: (msg, err) => console.error(msg, err ?? ""),
});

// ── La potatura dei worktree: il cablaggio ─────────────────────────────────
// Costruita QUI, cioe' dopo `taskAutoMerge` e prima che qualcuno la chiami: e'
// il punto in cui tutte le sue dipendenze esistono davvero. I tre chiamatori
// stanno piu' in alto e la leggono dentro una closure, quindi la risolvono al
// momento della chiamata: e' la stessa proprieta' che prima veniva
// dall'hoisting di una `function` dichiarata in fondo al file, ottenuta senza
// dipendere dall'ordine di valutazione.
const worktreeGc = createWorktreeGcRunner({
  db: ctx.db,
  worktreeStore: ctx.worktreeStore,
  worktreeManager: ctx.worktreeManager,
  projectStore: ctx.projectStore,
  getTopicBySessionKey: (sessionKey) => ctx.getTopicBySessionKey(sessionKey),
  resolveTopicCwd: (topic) => ctx.resolveTopicCwd(topic),
  svc: dispatcherSvc,
  // La potatura scrive sulle card da un timer: senza questo filo la board
  // resterebbe ferma sulla versione di prima fino a un ricaricamento.
  broadcast: (msg) => ctx.broadcastToAll(msg as Parameters<typeof ctx.broadcastToAll>[0]),
  isInFlight: (taskId) => taskDispatcher.isInFlight(taskId),
  worktreeOfTask: (taskId) => worktreeOfTask(taskId),
  projectIdForPath: (path) => projectIdForPath(path),
  deliveryIsOnMain: (repoPath, commit) => deliveryIsOnMain(repoPath, commit),
  tryMerge: (taskId, text, delivery) => taskAutoMerge.tryMerge(taskId, text, delivery),
  previewList: () => previewManager?.list() ?? [],
  previewTeardown: (taskId) => previewManager?.teardown(taskId) ?? Promise.resolve(),
  // PUNTO 3 (task e3240a22): lista degli script vivi per rimandare lo slim.
  listOwnedScripts: () => listOwnedScripts(),
});


/**
 * I DUE SGUARDI SUL WORKTREE DI UNA CARD, estratti dall'oggetto della rotta
 * perche' adesso li usa anche il DISPATCHER.
 *
 * `taskDeliveryRef` e `taskCheckoutRef` vivevano dentro le opzioni di
 * `createTasksRouter`, quindi solo la rotta poteva fotografare una consegna. La
 * consegna forzata dal sistema — che passa dal dispatcher — leggeva percio'
 * colonne che nessuno aveva scritto e concludeva sempre «nessun ramo e nessun
 * file toccato», anche su card che avevano committato (misurato il 18/08 su
 * `cf15dea6`, ramo con commit `af248dcf9`).
 */
/**
 * DOVE e SU QUALE RAMO chiedere della consegna di una card, in un posto solo.
 *
 * Il worktree quando c'è, il ramo scritto sulla card quando non c'è più. Il
 * perché sta in `services/delivery-branch-ref.ts`: la catena
 * `task → assignedTopicId → topic.worktreeId → worktrees` si spezza da sola per
 * strada, e da lì in poi la consegna non si poteva più fotografare.
 *
 * È lo stesso ripiego che il land già si era costruito per sé
 * (`declaredDelivery`, più in alto): quello serve a decidere se c'è qualcosa da
 * pubblicare, questo a registrare cosa è stato consegnato. La risposta alla
 * domanda «quale ramo» ora è una sola.
 *
 * `candidati` si passa da chi CICLA: costruirli scandisce la cartella di lavoro,
 * e il backfill ne farebbe una scansione per card.
 */
const deliveryBranchDeps = (candidati?: ReturnType<typeof buildProjectCandidates>): DeliveryBranchDeps => ({
  worktreeOfTask: (id) => worktreeOfTask(id),
  storeRepoPath: (projectId) => ctx.projectStore.get(projectId)?.path ?? null,
  recordedDelivery: (id) => {
    const t = dispatcherSvc.get(id)?.task;
    return t ? { projectId: t.projectId, deliveryBranch: t.deliveryBranch ?? null } : null;
  },
  boardRepoPath: (boardProjectId) => {
    try {
      const lista = candidati ?? buildProjectCandidates({
        projectStore: ctx.projectStore,
        workspaceDir: DISPATCH_WORKSPACE_DIR,
        extraPaths: dispatchExtraPaths,
      });
      return resolveProjectPath(boardProjectId, lista)?.path ?? null;
    } catch { return null; }
  },
  branchExists: (repoPath, branch) => branchExistsInRepo(repoPath, branch),
});

const taskDeliveryRef = async (taskId: string) => {
    const ref = await resolveDeliveryBranch(deliveryBranchDeps(), taskId).catch(() => null);
    if (!ref) return null;
    // NON la punta del ramo: l'ultimo commit SUO. Un ramo che eredita il lavoro
    // di chi stava sul checkout condiviso ha una punta che non è della card, e
    // chi rivede finirebbe a leggere il diff di un altro (misurato il 10/08).
    // `deliveryPointer` è la stessa domanda che si fa l'automerge: una fonte sola.
    //
    // E `commit: null` NON si ripiega sulla punta. È la tentazione ovvia quando
    // si vede una colonna vuota, ed è il difetto stesso: `own = []` vuol dire
    // «verificato, questa card non ha prodotto niente di suo», e sovrascriverlo
    // con `HEAD` intesta a lei il lavoro di un altro. Misurato il 18/08 sulla
    // card `5bfd7356` (worktree `mossy-marble`, zero commit propri): la sua
    // punta è `27d9ebca4`, «Le missioni: compiti a preset…», di un'altra card e
    // già su main da una settimana. Registrarla avrebbe fatto leggere al
    // reviewer il diff sbagliato e all'audit un «atterrato» falso, che è
    // esattamente il guasto per cui l'audit esiste.
    const pointer = await deliveryPointer(ref.repoPath, ref.branch).catch(() => null);
    if (!pointer) return null;
    // QUANTO lavoro c'è dentro, misurato QUI e non a ogni render della board.
    //
    // La colonna review chiedeva «Approva» senza dire cosa si approvasse: il
    // diff esisteva solo dietro l'apertura del drawer, una card alla volta.
    // Calcolarlo nel feed sarebbe stato tre comandi git per card a ogni push
    // WebSocket; calcolarlo alla consegna è una volta sola, quando il fatto
    // accade. `worktreeDiffStat` misura dal PADRE del commit più vecchio SUO,
    // cioè lo stesso perimetro di `deliveryPointer`: non eredita il lavoro di
    // chi stava parcheggiato sul checkout condiviso.
    //
    // Senza cartella si misura dal checkout del progetto: la domanda è tutta sui
    // ref, che i worktree di un repo condividono, e l'albero di lavoro non entra
    // nella risposta (`worktreeDiffStat` confronta due commit).
    //
    // Best-effort come tutto il resto di questa funzione: se git inciampa la
    // consegna passa lo stesso, senza misura (NULL, che non è zero).
    const stat = await worktreeDiffStat(ref.worktreePath ?? ref.repoPath, { branch: ref.branch }).catch(() => null);
    // `repoPath` travels with the snapshot because the capture plants
    // `refs/consegne/<taskId>` on the delivered sha before writing the column
    // (`services/delivery-ref-keep.ts`): the land squashes and then deletes the
    // branch, and without that ref the commit is reachable from nowhere.
    return stat
      ? { ...pointer, repoPath: ref.repoPath, filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions }
      : { ...pointer, repoPath: ref.repoPath };
};

const taskCheckoutRef = async (taskId: string) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch") return null;
    const commit = await resolveCommit(wt.absPath, "HEAD");
    return { cwd: wt.absPath, commit };
};

/**
 * La fotografia di consegna, UNA implementazione per tre chiamanti (rotta,
 * scelta del fan-out, dispatcher). Vedi `services/task-delivery-capture.ts`.
 */
capturaConsegna = createDeliveryCapture({
  svc: dispatcherSvc,
  taskDeliveryRef,
  taskCheckoutRef,
  ownCommitFiles,
  keepDeliveryCommit,
});

// Stessa sonda che il pannello delle modifiche usa gia' (`taskWorktreeDirt`):
// il junk e' gia' escluso li' dentro, quindi la card non nomina un
// `node_modules`. `null` = non misurabile, ed e' diverso da «pulito».
sondaLavoroNonCommittato = async (taskId: string) => {
  const wt = worktreeOfTask(taskId);
  if (!wt || wt.mode !== "branch") return null;
  try { return await worktreeRealDirt(wt.absPath); } catch { return null; }
};

// Owned here so the quiescence wait can see lands still queued or running.
const landingQueue = createLandingQueue({ log: (m) => console.warn(m) });
const tasksRouter = createTasksRouter(ctx, taskDispatcher, {
  landings: landingQueue,
  repoRootFor: repoRootForCard,
  workspaceDir: DISPATCH_WORKSPACE_DIR,
  // Il titolo leggibile di una card dettata (`services/task-title.ts`). Si
  // risolve al momento della chiamata e non all'avvio: il default della
  // macchina si ricalcola a ogni boot, e una funzione lo rilegge sempre fresco.
  // `null` in caso di guasto: senza modello la card tiene il titolo del
  // composer, che e' come si e' sempre comportata.
  namingProvider: () => tryGetProvider() ?? null,
  autoMerge: taskAutoMerge,
  // Structural review gate: real uncommitted changes in the task's branch
  // worktree (junk excluded); null = no worktree, gate skipped.
  // Il progetto di questa board puo' avere un worktree isolato? Stessa
  // risoluzione che usa il dispatch, cosi' il pannello non puo' dire una cosa e
  // il dispatch farne un'altra.
  worktreeReady: (projectId) => {
    try {
      const c = resolveProjectPath(
        projectId,
        buildProjectCandidates({
          projectStore: ctx.projectStore,
          workspaceDir: DISPATCH_WORKSPACE_DIR,
          extraPaths: dispatchExtraPaths,
        }),
      );
      if (!c) return false;
      return !!c.projectStoreId || existsSync(join(c.path, ".git"));
    } catch { return true; } // in dubbio non si accusa il progetto
  },
  taskWorktreeDirt: async (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch") return null;
    return worktreeRealDirt(wt.absPath);
  },
  // Come sopra, ma dice anche SE ha potuto leggere: la usa chi CANCELLA
  // (`reapAfterLand`), dove un `git status` muto non vale «pulito».
  taskWorktreeDirtProbe: async (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch") return null;
    return worktreeDirtProbe(wt.absPath);
  },
  // Il task ha (o ha avuto) un tentativo con worktree di ramo registrato?
  // Usato dal cancello `review_needs_commit` per distinguere «non ho trovato
  // il worktree» da «questo task non ha mai avuto un ramo»: un task senza
  // ramo (in-place) non deve essere bloccato quando la sonda torna null.
  taskHasBranchAttempt: (taskId) => {
    try {
      const row = ctx.db.prepare(
        `SELECT 1 FROM task_attempts WHERE task_id = ? AND worktree_id IS NOT NULL LIMIT 1`,
      ).get(taskId);
      return !!row;
    } catch { return false; }
  },
  // Post-landing reap guard: the branch's state relative to main read by
  // CONTENT (survives squash-landing). null = no branch worktree to protect.
  taskBranchStatus: async (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch" || !wt.branchName) return null;
    const repoPath = ctx.projectStore.get(wt.projectId)?.path;
    if (!repoPath) return null;
    return branchStatusFromRepo(repoPath, wt.branchName);
  },
  // Delivery snapshot, taken when the task enters review: the branch plus the
  // most recent commit that is the task's OWN. The branch dies with the reap,
  // the commit survives (gc.pruneExpire=90d), so the landing audit holds it.
  //
  // NON la punta del ramo: un branch nato dall'HEAD del checkout condiviso
  // eredita i commit di chi ci stava sopra, e la punta è di un altro — il 10/08
  // `dd2aa40d` registrava `987cd8ae`, commit di un'altra card e già su main.
  // `null` = domanda senza risposta ⇒ nessuna fotografia (meglio del ritratto
  // sbagliato); `commit: null` = verificato, non ha prodotto codice.
  taskDeliveryRef,
  // Dove far girare i checks pre-review: la cartella del worktree del task e il
  // commit su cui sta. Solo worktree di branch — un task in-place girerebbe i
  // comandi nel checkout principale, cioè su codice che non è il suo.
  taskCheckoutRef,
  // Main dentro il ramo PRIMA dei check, come fa il land prima di fondere: il
  // cancello misura l'albero che atterra, non una base invecchiata.
  realignForChecks: (taskId) => taskAutoMerge.realign(taskId),
  // L'esito di atterraggio della card, timbrato SUBITO dopo un land: un verdetto
  // concreto è ciò che il land ha visto e vale come fatto (`witnessed`), `"ask"`
  // è il caso in cui non sa e si chiede al repo (`auditOneLanding`, più in basso).
  stampLanding: async (taskId, verdict) => {
    if (verdict === "ask") { await auditOneLanding(taskId); return; }
    try {
      dispatcherSvc.recordLandingState({
        taskId, state: verdict, checkedAt: new Date().toISOString(), witnessed: true,
      });
    } catch (err) { console.warn("[landing-audit] timbro del land fallito", err); }
  },
  // Il land è stato CHIESTO ma non è ancora avvenuto. La card è già `done` (la
  // rotta approva e risponde subito) e la fusione arriva dopo: senza questo
  // timbro, in quella finestra una card chiusa è indistinguibile da una
  // atterrata — ed è così che l'11/08 sedici card sono rimaste in Done col
  // codice sul loro ramo, in silenzio. `witnessed: false` di proposito: è il
  // vero di ADESSO, e la passata periodica resta libera di correggerlo se il
  // land è morto a metà dopo aver mergiato davvero.
  // La PROVA che il land è avvenuto: il commit di fusione dev'essere dentro
  // `main` di quel checkout, riletto da git dopo il merge. `defaultBranch` è
  // "main" ovunque qui (vedi `resolveTaskMerge` sopra), quindi la domanda è
  // esattamente quella che il land ha provato a rendere vera.
  confirmLandedOnMain: (repoPath, commit) => commitIsAncestor(repoPath, commit, "main"),
  markLandPending: (taskId) => {
    try {
      dispatcherSvc.recordLandingState({
        taskId, state: "unlanded", checkedAt: new Date().toISOString(),
      });
    } catch (err) { console.warn("[landing-audit] timbro di attesa fallito", err); }
  },
  // Post-landing reap: merged (or empty) worktrees have no remaining value —
  // the manager path removes worktree + branch + row, serialized per project.
  deleteTaskWorktree: async (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt) return false;
    return ctx.worktreeManager.delete(wt.id);
  },
  // Reap the task's live preview server on land / approve / close.
  teardownPreview: (taskId) => previewManager?.teardown(taskId) ?? Promise.resolve(),
  // Archiviare un task porta via anche le sue tab: le due chiavi `ui_state` e i
  // contesti browser dietro di esse. `browserService` è il servizio vivo, quindi
  // la chiusura headless è reale; il broadcast chiude la pane su ogni device.
  teardownTaskBrowserState: (taskId) =>
    teardownArchivedTaskBrowserState(
      {
        db,
        broadcastToAll: ctx.broadcastToAll,
        destroyContext: (contextId) => browserService.destroyContext(contextId),
      },
      taskId,
    ),
  // Due chiamanti, stessa porta: il fan-out (l'anteprima parte quando l'umano
  // sceglie il vincitore, perché solo allora il worktree del task è quello
  // giusto da mostrare) e «Ricattura evidenza» su una card già in review, che
  // passa `explain: true` per farsi motivare anche il no.
  preparePreview: (taskId, o) => previewManager?.prepareForReview(taskId, o) ?? Promise.resolve(),
  // NOTE: the server no longer SELF-RESTARTS when an approve lands server code
  // (removed 2026-07-18, Attilio: "l'auto-riavvio sporca tutto"). A landed
  // server change goes live either via the opt-in graceful hot-reload watch
  // (TOPICS_SERVER_WATCH=1 in start-prod.sh) or a deliberate manual restart —
  // never an autonomous restart triggered by task approval. tasks.ts just posts
  // an informational note on a server-touching landing.
  // Human "stop" on a dispatched task cuts the running turn (same abort path
  // as the dispatcher's wall-clock timeout).
  abortTurn: abortHeadlessTurn,
  // Collega il gate dei check al freno del dispatcher: appena il gate esiste,
  // `checksGateRunningCount` punta al suo `runningCount()` e il dispatcher
  // lo usa in ogni tick e resume per sapere quante barre sono in volo.
  onChecksGate: (gate) => {
    checksGateRunningCount = () => gate.runningCount();
    checksGateIsRunning = (taskId) => gate.isRunning(taskId);
  },
  // Same union the dispatcher resolves against — but trimmed to the dirs that
  // are actually SELECTABLE boards. Internal catch-all plumbing (the shared
  // `generale` dir, the per-task `tasks/<id8>` cwds), the home dir, config
  // dot-dirs and vanished paths are dropped so the picker/sidebar stay clean;
  // the resolver above keeps the FULL union so those hashes still invert.
  listProjectDirs: () =>
    buildProjectCandidates({
      projectStore: ctx.projectStore,
      workspaceDir: DISPATCH_WORKSPACE_DIR,
      extraPaths: dispatchExtraPaths,
    })
      .map((c) => c.path)
      .filter((p) => isSelectableProjectDir(p, { workspaceDir: DISPATCH_WORKSPACE_DIR, homeDir: homedir() })),
});
// Auto-register servers Claude starts inside its PTY sessions (bare `bun run dev`
// etc.) into the Processes panel, attributing listening ports by PTY process tree.
startProcessDetection(ctx, getClaudeSessionsForDetection);

// Lo stato pubblicato su Discord, se l'interruttore è acceso (default: spento,
// migration 102). Il servizio parte SEMPRE — è lui a rileggere le impostazioni
// a ogni giro e a non aprire nessun filo finché non gli viene detto di sì —
// così accendere non richiede un riavvio.
//
// Sostituisce il daemon launchd `claude-discord-presence`, che contava i
// processi `claude` con `ps`: i numeri che passano di qui sono conteggi esatti
// del server (`activeStreams` = i turni che stiamo trasmettendo ADESSO, non una
// soglia sulla CPU di un processo).
// Da quando questa installazione è in piedi: diventa il cronometro sotto la
// card di Discord. È l'avvio del SERVER e non l'avvio della sessione, perché è
// quello che «da quanto stai lavorando» significa per chi guarda.
const SERVER_STARTED_AT = Date.now();
startDiscordPresence({
  getSnapshot: () => ({
    ...computePresenceCounts(
      ctx.db,
      ctx.activeStreams.size + countBusyAgentTerminals(),
      ctx.externalSessionsCount?.() ?? 0,
      ctx.externalSessionsWorking?.() ?? 0,
    ),
    since: SERVER_STARTED_AT,
  }),
  getSettings: () => {
    const s = getAppSettings();
    return {
      enabled: resolveDiscordPresenceEnabled(s),
      level: resolveDiscordDetailLevel(s),
      language: resolveOutputLanguage(s),
    };
  },
});

const pushRouter = createPushRouter(ctx);
// La CRONOLOGIA delle notifiche: leggerla, scriverci (il banner del client
// registra qui la sua riga), segnarla vista. Vedi migration 101.
const notificationsRouter = createNotificationsRouter(ctx);
// Chiudere una tab E' il ritiro di cio' che contiene, deciso lato server.
//
// Il client gia' archivia la chat e chiude la sessione quando e' LUI a chiudere.
// Questa e' la strada per tutte le volte in cui quelle chiamate non partono o
// non arrivano — la tab chiusa su un altro dispositivo, la `keepalive` persa in
// un `pagehide`, la finestra chiusa con la fetch in volo. Il tombstone, che e'
// sincronizzato, arriva comunque: da qui in poi arrivano anche le conseguenze.
// Vedi `services/pane-retirement-cascade.ts` per perche' il segnale e' il
// tombstone e non «la pane non c'e' piu'».
const uiStateRouter = createUiStateRouter(ctx, {
  onPaneSnapshot: (prev, next) => {
    const decision = computeCascade({ prev, next, alreadyRetired: retiredIds(ctx.db, "pane") });
    if (decision.retire.length === 0 && decision.reopen.length === 0) return;
    const applied = applyPaneCascade(ctx.db, retirementConsequences, decision);
    if (applied.topics > 0 || applied.terminals > 0) {
      console.log(`[retirement] tab chiuse: ${applied.panes} → ${applied.topics} chat archiviate, ${applied.terminals} sessioni ritirate`);
    }
  },
});
// `GET /api/open` — la query sola su «cosa è aperto». Sola lettura.
const openRouter = createOpenRouter(ctx);
const providersRouter = createProvidersRouter(ctx);
const appSettingsRouter = createAppSettingsRouter(ctx);
const profileRouter = createProfileRouter(ctx);
// Pagina pubblica del profilo — senza autenticazione, prima del gate.
const publicProfileHandler = createPublicProfileHandler(ctx);
// Risoluzione dei permalink alle tab (`/tab/…`) — SOLA LETTURA.
const tabsRouter = createTabsRouter(ctx, browserService);
// Reset della suite E2E. Si auto-disarma (risponde 404) se TOPICS_E2E ≠ "1",
// che è il caso di ogni server non di test — vedi server/routes/e2e.ts.
const e2eRouter = createE2eRouter(ctx);

const claudeHooksRouter = createClaudeHooksRouter(ctx, claudeSessionTracker);
// Replay JSONL tails for any session whose state was lost on the previous
// shutdown, then start the reaper and the LIVE transcript tail. All three are
// fire-and-forget — they advance state independently of the live hook stream.
// The live tail is what tracks turns no hook announces (a Monitor firing, a
// background task completing, a teammate message waking a parked session).
claudeSessionTracker.recoverFromJsonl().catch((err) => {
  console.error("[claude-session-tracker] Boot recovery failed", err);
});
claudeSessionTracker.startReaper();
claudeSessionTracker.startJsonlTail();
// Import sweep: pull terminal turns of ADOPTED sessions into their chat, so an
// adopted conversation no longer freezes at the adoption snapshot.
claudeSessionTracker.startImportSweep();
const projectsRouter = createProjectsRouter(ctx);
const worktreesRouter = createWorktreesRouter(ctx, {
  // I rami locali non su main, col task a cui appartengono. Due letture: git
  // per QUALI rami e quanti commit, il DB per DI CHI sono.
  branchInventory: async (projectPath) => {
    const proc = Bun.spawn(
      ["git", "for-each-ref", "--format=%(refname:short)", "--no-merged=main", "refs/heads"],
      { cwd: projectPath, stdout: "pipe", stderr: "pipe" },
    );
    const outText = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error(`git: ${projectPath} non e' un repo, o main non esiste`);
    const names = outText.split("\n").map((l) => l.trim()).filter(Boolean);
    const branches = await Promise.all(names.map(async (name) => {
      const c = Bun.spawn(["git", "rev-list", "--count", `main..${name}`], { cwd: projectPath, stdout: "pipe", stderr: "pipe" });
      const n = Number((await new Response(c.stdout).text()).trim());
      await c.exited;
      return { name, ahead: Number.isFinite(n) ? n : 0 };
    }));
    // I task del board di QUESTO percorso: e' l'unico insieme che puo'
    // reclamare quei rami.
    const boardId = projectIdForPath(projectPath);
    const rows = ctx.db.prepare(
      `SELECT t.id AS taskId, t.text AS taskText, t.status AS taskStatus,
              t.delivery_branch AS deliveryBranch, w.branch_name AS worktreeBranch
         FROM tasks t
    LEFT JOIN topics tp ON tp.id = t.assigned_topic_id
    LEFT JOIN worktrees w ON w.id = tp.worktree_id
        WHERE t.project_id = ? AND t.archived = 0`,
    ).all(boardId) as Array<{ taskId: string; taskText: string; taskStatus: string; deliveryBranch: string | null; worktreeBranch: string | null }>;
    const entries = buildBranchInventory(branches, rows);
    return { entries, summary: summarizeInventory(entries) };
  },
  // `worktreeGc` è costruito più sotto (dopo `taskAutoMerge`): questa closure
  // quindi la closure è valida anche se il router nasce prima.
  runGc: () => worktreeGc.runWorktreeGc(),
});
const machinesRouter = createMachinesRouter(ctx);

// Phase D — heartbeat ticker. Upserts the local machine row every 30 s
// and flips other machines that haven't checked in for 5 minutes to
// `offline`. Cheap (one indexed UPDATE + one indexed SELECT per tick).
// QUANTO SI ASPETTA CHE UN WORKTREE SIA PRONTO, E PERCHE' NON SONO DUE MINUTI.
//
// Un worktree diventa `ready` solo DOPO l'install delle dipendenze (la fine di
// `installDeps`, in `worktree-manager.ts`). Due minuti bastano a un repo
// piccolo e non bastano a uno grosso: misurato il 19/08 su dancerooms,
// 242 secondi. Il risultato non era «parte lento», era «NON PARTE»: chi
// aspettava mollava a 120s, il dispatch falliva, e la card restava ferma senza
// che niente dicesse che il ritardo era di `pnpm install`.
//
// Dieci minuti sono un tetto contro un install BLOCCATO (rete morta, lock di
// un registry), non una stima del caso normale: quando l'install va, si torna
// appena finisce. Regolabile per chi ha un repo piu' lento di dancerooms.
const WORKTREE_READY_MS = Math.max(60_000, Number(process.env.TOPICS_WORKTREE_READY_MS) || 600_000);

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 5 * 60_000;
function tickHeartbeat() {
  try {
    const local = ctx.machineStore.upsertLocal();
    ctx.broadcastToAll({ type: "machine:upserted", machine: local, payload_version: 1 });
    const flipped = ctx.machineStore.markStaleOffline(STALE_THRESHOLD_MS);
    for (const m of flipped) {
      ctx.broadcastToAll({ type: "machine:updated", machine: m, payload_version: 1 });
    }
  } catch (err) {
    console.warn("[Heartbeat] tick failed:", err);
  }
}
tickHeartbeat();
const heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_INTERVAL_MS);

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
  const { getSnapshotManager } = await import("./server/providers/snapshot-manager");
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

// Initialize VAPID keys on startup
initVapid();
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

// Activity LOG (audit trail) — the live OpenClaw-log feed is gone.
const activityRouter = createActivityRouter(ctx);

// External-session census: poll + broadcast so a `claude` started in iTerm
// surfaces on the board within ~20s without any client polling.
// Le sessioni fuori da Topics, per la barra e per la presence: quante sono e
// quante stanno LAVORANDO adesso. Il secondo numero e' quello che mancava —
// dire «4 fuori da Topics» mentre una di quelle sta macinando, e non dirlo,
// fa sembrare fermo un lavoro in corso.
//
// Si contano su `list()`, NON su `byProject()`: il secondo raggruppa per
// progetto della board e quindi lascia fuori chi non e' attribuibile.
//
// NOTA su come ci sono arrivato, perche' la prima spiegazione era sbagliata.
// Il 23/08 la presence diceva «0 al lavoro» avendone quattro, e avevo
// incolpato questa riga. Rimettendo `byProject()` sul server vivo il numero
// tornava CORRETTO: la vera causa era che lo scanner jcode non attribuiva
// nessuna sessione a nessun progetto (`projectPath: null` fisso), quindi il
// rollup era vuoto. Corretto li'.
//
// La formula su `list()` resta comunque quella giusta, per una ragione di
// significato e non di sintomo: «quante stanno lavorando» non deve dipendere
// dal fatto che la board conosca quella cartella. Chi lavora fuori da Topics
// puo' benissimo lavorare fuori dai progetti di Topics, e in quel caso il
// numero deve dirlo lo stesso. Stessa cache (TTL 10s), nessuna scansione in
// piu'.
ctx.externalSessionsCount = () => externalSessions.list().length;
ctx.externalSessionsWorking = () =>
  externalSessions.list().filter((s) => s.state === "active").length;
const externalSessionsRouter = createExternalSessionsRouter(ctx, externalSessions);
externalSessions.start();


const WS_HEARTBEAT_INTERVAL_MS = 30000;
const WS_TIMEOUT_MS = 90000;

// WebSocket heartbeat
const wsHeartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const ws of wsClients) {
    if (now - ws.data.lastPong > WS_TIMEOUT_MS) {
      console.log(`[WS] Removing stale client ${ws.data.id} (no pong for ${Math.round((now - ws.data.lastPong) / 1000)}s)`);
      wsClients.delete(ws);
      try { ws.close(1001, "Connection timeout"); } catch {}
      continue;
    }
    if (ws.readyState === 1) { try { ws.ping(); } catch {} }
  }
  // Browser screencast sockets are kept OUT of wsClients, so reap them here too.
  // Without this, a half-open TCP break (laptop sleep / network drop) never
  // fires `close`, so _browserCleanup never runs and the CDP screencast keeps
  // streaming JPEG frames into a dead socket — this watchdog is the only thing
  // that releases the CDP session. _browserCleanup is idempotent, so calling it
  // here and again in the close handler is safe.
  for (const [ctxId, set] of browserWsClients) {
    for (const ws of set) {
      if (now - ws.data.lastPong > WS_TIMEOUT_MS) {
        console.log(`[WS][browser] Reaping stale browser client for ctx ${ctxId} (no pong for ${Math.round((now - ws.data.lastPong) / 1000)}s)`);
        // De-register the native executor explicitly (idempotent): a server-side
        // close on an already-half-dead socket may not fire the `close` handler,
        // which would otherwise leave a Tauri pane's delegation pointing at a dead
        // socket so isDelegated() keeps routing agent ops into the void.
        // Owner-scoped: if the pane already re-registered on a NEWER socket
        // (reconnect after sleep), reaping this stale one must not drop the
        // fresh registration.
        nativeDelegateRegistry.unregister(ctxId, ws);
        void ws.data._browserCleanup?.();
        set.delete(ws);
        try { ws.close(1001, "Connection timeout"); } catch {}
        continue;
      }
      if (ws.readyState === 1) { try { ws.ping(); } catch {} }
    }
    if (set.size === 0) {
      browserWsClients.delete(ctxId);
      viewerCountPublisher.forget(ctxId);
    } else {
      // A reaped viewer changes the count for the panes that stay; a tick
      // that reaped nobody sends nothing (the publisher compares first).
      viewerCountPublisher.publish(ctxId);
    }
  }
}, WS_HEARTBEAT_INTERVAL_MS);

// Startup cleanup: remove orphaned unread entries
{
  const topicsData = loadTopics();
  const unreadData = loadUnread();
  let cleaned = false;
  for (const topicId of Object.keys(unreadData)) {
    if (!topicsData.topics[topicId]) { delete unreadData[topicId]; cleaned = true; }
  }
  if (cleaned) { saveUnread(unreadData); console.log("[Startup] Cleaned orphaned unread entries"); }
}

// Startup: reset stale partial messages (via SQLite). BEFORE clearing,
// capture which sessions were mid-turn: the chat-reattach boot sweep below
// uses this set to tell a SURVIVING broker turn (detached by the previous
// server's graceful shutdown — adopt it) from an idle child (reap it).
// Reading partial=1 after this block would always see zero rows.
//
// Sessions whose child is still ALIVE in the detached ai-bridge daemon are
// NOT stale — the turn survived the restart — so their partial rows are left
// untouched. This keeps the mid-turn signal intact across RAPID successive
// reloads: a boot that adopts and then dies before its adopted turn rewrote
// the partial row must not blind the NEXT boot's sweep (observed live: the
// sweep reaped a mid-turn child after a double reload). The adopted turn's
// leftovers are cleared by the sweep when the turn ends.
const midTurnAtBoot = new Set<string>();
/** Le sessioni di chat il cui figlio è ANCORA VIVO nel broker a questo boot.
 *  Serve oltre al setaccio dei parziali: un figlio vivo può ancora consegnare
 *  il tool che ha in corso, quindi quel tool non è un orfano da bollare come
 *  interrotto (vedi finalizeOrphanedRunningTools). */
const liveBrokerChatSessions = new Set<string>();
{
  console.log("[Startup] Checking for stale partial messages...");
  // `listConfirmed` = we got an AUTHORITATIVE alive-set from the broker. This is
  // the load-bearing invariant of reload-survival: resetting a partial row to
  // partial=0 is what later mints the "interrotto" marker, so we only do it for
  // a session the broker CONFIRMS is dead. If we cannot get a confirmed list
  // (daemon not yet connected during the boot race, a transient error), we
  // treat every mid-turn row as "possibly alive" and KEEP partial=1 — the
  // reattach sweep below (which lists again) reconciles survivors, and a
  // genuinely-dead one is cleaned by its .finally / the next boot. Never orphan
  // a possibly-live turn on an unconfirmed read.
  let listConfirmed = false;
  if (aiBridgeEnabled()) {
    for (let attempt = 0; attempt < 4 && !listConfirmed; attempt++) {
      try {
        await getAiBridgeClient().ensureConnected();
        const sessions = await getAiBridgeClient().list();
        liveBrokerChatSessions.clear();
        for (const s of sessions) if (s.alive && s.id.startsWith("topic:")) liveBrokerChatSessions.add(s.id);
        listConfirmed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 250)); // daemon still coming up — retry
      }
    }
    if (!listConfirmed) {
      console.warn("[Startup] ai-bridge list() unavailable after retries — keeping ALL partial rows intact (reattach will reconcile); refusing to orphan possibly-live turns");
    }
  } else {
    listConfirmed = true; // bridge disabled → no detached survivors possible → safe to reset
  }
  // Popola midTurnAtBoot prima del sweep (il set serve al reattach successivo).
  for (const { sk } of db.query("SELECT DISTINCT session_key AS sk FROM messages WHERE partial = 1").all() as Array<{ sk: string }>) {
    midTurnAtBoot.add(sk);
  }
  let cleared = 0, kept = 0;
  try {
    // La logica kept/reset e l'inserimento della notifica sono in
    // boot-partial-sweep.ts (testabile in isolamento con un db in-memory).
    ({ cleared, kept } = runBootPartialSweep(db, {
      listConfirmed,
      liveSessions: liveBrokerChatSessions,
    }));
  } catch { /* capture is best-effort; the sweep degrades to reaping */ }
  console.log(`[Startup] partial sweep: reset ${cleared}, kept ${kept} (mid-turn ${midTurnAtBoot.size}, broker-alive ${liveBrokerChatSessions.size}, listConfirmed=${listConfirmed})`);
}

const tlsCert = join(import.meta.dir, "certs", "fullchain.pem");
const tlsKey = join(import.meta.dir, "certs", "key.pem");
const useTls = !process.env.NO_TLS && await Bun.file(tlsCert).exists() && await Bun.file(tlsKey).exists();

// ─── Phase B · Daemon lifecycle (DAEMON-01) ────────────────────────────────
// Acquire singleton lock + write state file BEFORE Bun.serve so
// concurrent boots see the live lock and exit fast. The state file is
// finalised after Bun.serve returns the actual port (in case PORT=0).
try {
  acquireLock();
} catch (err) {
  if (err instanceof LiveLockError) {
    console.error(`[Daemon] ${err.message}`);
    console.error(`[Daemon] If the other process is dead, delete ~/.topics/daemon-process.lock manually.`);
    process.exit(1);
  }
  throw err;
}

// PORTING-PLAN.md Tier 1 — CORS for the Tauri desktop shell, which serves the UI
// locally (tauri://localhost) and calls this server cross-origin for /api + /ws.
// Provably a no-op for the existing web/Electron clients: their Origin is never a
// tauri/desktop origin, so corsAllowOrigin() returns "" and nothing is added.
function corsAllowOrigin(req: Request): string {
  const origin = req.headers.get("origin") || "";
  // macOS WKWebView → tauri://localhost; Windows WebView2 → http(s)://tauri.localhost
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") {
    return origin;
  }
  return "";
}
function applyDesktopCors(req: Request, resp: Response): void {
  const origin = corsAllowOrigin(req);
  if (!origin) return;
  resp.headers.set("Access-Control-Allow-Origin", origin);
  resp.headers.set("Vary", "Origin");
}
function corsPreflightHeaders(req: Request, origin: string): Record<string, string> {
  // Reflect whatever headers the request wants to send: origin is already
  // gated to the desktop-shell origins, and a fixed list rots — it silently
  // blocked every PUT carrying X-Client-Id (pane/layout sync), so the desktop
  // never persisted state except via the header-less sendBeacon teardown path.
  const requested = req.headers.get("access-control-request-headers");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requested || "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}

/**
 * Confronto a tempo costante fra due stringhe già validate come esadecimali di
 * lunghezza fissa. `timingSafeEqual` lancia se i buffer hanno lunghezze diverse,
 * quindi la disuguaglianza di lunghezza si tratta prima e senza chiamarlo. Usato
 * solo dal ramo `/__daemon/*`: dopo la change `lan-open-same-origin` è l'unico
 * segreto che il server confronta.
 */
function timingSafeEqualStr(presented: string, expected: string | null | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Le opzioni del server, estratte perché servono a DUE ascoltatori.
 *
 * Il secondo è quello del tunnel, e non è una copia del primo con un numero
 * diverso: è la stessa identica macchina raggiunta da un'altra porta. Deve
 * esserlo, o le due strade divergerebbero — e quella che diverge in silenzio è
 * sempre la meno usata, cioè proprio il tunnel.
 *
 * Delegare invece di condividere non funziona, ed è stato misurato: passando le
 * richieste al primo server con `server.fetch(req)`, il gestore riceve
 * `undefined` al posto dell'istanza e `server.upgrade` esplode. In un'app che
 * vive sul WebSocket sarebbe stato metà prodotto.
 */
/**
 * Is there a network between us and whoever is asking?
 *
 * The one question both compression paths ask, HTTP and WebSocket alike, so it
 * is written once. Deliberately NOT `isLocalTransport`: that one asks who we
 * trust, and for it the tunnel is remote even with the peer at 127.0.0.1. Here
 * the tunnel is local, because the socket on its other end belongs to
 * `relay-client.ts` on this very machine, which inflates whatever we compress
 * before passing it on. See `server/lib/compress-json.ts`.
 */
function isRemotePeer(req: Request, srv: { requestIP(req: Request): { address: string } | null }): boolean {
  return !isLoopbackAddress(srv.requestIP(req)?.address ?? null);
}

const opzioniServer = {
  port: PORT,
  // Bind host. Default "::" dual-stack: with net.inet6.ip6.v6only=0 (macOS
  // default) it owns BOTH the IPv6 and the IPv4-mapped families on PORT, so
  // Topics occupies localhost on every resolution path — important on a DEV box
  // where a stray server could otherwise squat ::1:PORT and clients using
  // `localhost` (resolved to ::1 first) land on it ("connecting forever").
  //
  // BUT on some Bun/macOS combos a "::" bind is effectively IPv6-only, so a
  // client connecting to 127.0.0.1 (which the packaged Electron app and its
  // readiness probe deliberately use) cannot reach it → the app hangs on the
  // splash and a relaunch hits EADDRINUSE against the still-running instance.
  // The packaged launcher therefore sets SERVER_HOST="0.0.0.0" (all IPv4 incl.
  // 127.0.0.1 and the LAN address for mobile/PWA access); IPv6 ::1 is unused by
  // the app. Override via SERVER_HOST; default stays "::" so dev is unchanged.
  hostname: process.env.SERVER_HOST || "::",
  // Exclusive ownership for the singleton. With reusePort:true a SECOND Topics
  // server on the same port doesn't fail — the OS lets both bind and round-robins
  // connections between them, so a live prod server and a stray one (e.g. a
  // worktree server with an empty DB) take turns answering and the board flickers
  // full/empty. false → the second bind fails fast with EADDRINUSE. The daemon
  // lock (acquired before Bun.serve) is the primary guard; this is defense in
  // depth for any server that bypasses it via a custom TOPICS_HOME.
  reusePort: false,
  idleTimeout: 255,
  ...(useTls ? {
    tls: {
      cert: Bun.file(tlsCert),
      key: Bun.file(tlsKey),
    },
  } : {}),

  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;
    const isApiRequest = pathname.startsWith("/api/");

    // Guasto SINTETICO su una rotta: e' cio' che permette di vedere ROSSO il
    // cancello sulle latenze (`bun run check:rotte`) senza barare sulla soglia.
    // Spento ovunque tranne che nel server di prova, e solo se glielo si chiede
    // (vedi `server/lib/route-fault.ts`: vuole TOPICS_E2E=1 *e* un ritardo).
    // Qui, da spento, e' il confronto con `null` di una variabile di modulo.
    const routeFault = currentRouteFault();
    if (routeFault && isApiRequest) await applyRouteFault(pathname, routeFault);

    // Phase B · DAEMON-02: token-authed LOOPBACK control endpoints.
    // We read the state file fresh on every call so a state-file rewrite
    // (e.g. token rotation in a future phase) takes effect immediately.
    //
    // LAN-OPEN-02: il "loopback" del commento non era nel codice — si guardava solo
    // il token. Finché ogni peer remoto doveva comunque presentarne uno per l'API
    // il divario restava teorico; da quando la LAN è aperta (change
    // `lan-open-same-origin`) non lo è più, perché il token del daemon è leggibile
    // da chiunque sia sulla rete via `/preview/…/.topics/daemon-state.json`. Il
    // peer va quindi respinto PRIMA di guardare il token, e il confronto è a tempo
    // costante. Costo zero per chi lo usa davvero: `cli/topics.ts`, la sonda del
    // guscio Tauri e la procedura di reload chiamano tutte da 127.0.0.1.
    if (pathname.startsWith("/__daemon/")) {
      // L'ASSE HOST, per primo, come in `evaluateAuth`. Loopback + token non
      // bastano contro il DNS rebinding: una pagina su un dominio che l'attaccante
      // fa risolvere a 127.0.0.1 arriva qui DA loopback, e il token del daemon e'
      // leggibile da chi e' sulla LAN (`/preview/…/.topics/daemon-state.json`).
      // Un `Host` assente passa per contratto: la CLI, i tool MCP e gli hook non
      // lo mandano, e sono gia' sulla macchina. Vedi `isAllowedHost`.
      if (!isAllowedHost(req.headers.get("host"), resolveAllowedOrigins())) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      // Attraverso il tunnel il peer e' 127.0.0.1: senza questa domanda,
      // gli endpoint del daemon sarebbero aperti a Internet.
      if (!isLocalTransport(req, server.requestIP(req)?.address ?? null, isLoopbackAddress)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      const fresh = readState();
      const auth = req.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+([0-9a-f]{64})$/i);
      const token = match?.[1] ?? "";
      if (!fresh || token.length !== 64 || !timingSafeEqualStr(token, fresh.token)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && pathname === "/__daemon/healthz") {
        const bundle = bundleProbe.check();
        return new Response(JSON.stringify({
          pid: fresh.pid,
          startedAt: fresh.startedAt,
          uptime_ms: uptimeMsSince(fresh.startedAt),
          // What the browser would get right now: `ok:false` means the app
          // serves nothing, whatever the rest of this object says.
          bundle: { ok: bundle.ok, missing: bundle.reason, since: bundle.since },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && pathname === "/__daemon/shutdown") {
        // Reply first so the caller sees 202; SIGTERM ourselves a tick
        // later so the existing graceful-shutdown handler runs.
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
        return new Response(JSON.stringify({ ok: true }), {
          status: 202, headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && pathname === "/__daemon/restart-when-idle") {
        // Graceful restart that WAITS for agent turns to finish first — the
        // safe way to apply a server fix without cutting a working agent
        // (use this instead of `kickstart -k`, which SIGKILLs mid-turn).
        // Reply 202 now; wait for quiescence, then SIGTERM ourselves so
        // gracefulShutdown runs and launchd/start-prod.sh relaunches.
        const busy = taskDispatcher.busyCount();
        void waitForDispatcherQuiescent("restart-when-idle").then(() => {
          process.kill(process.pid, "SIGTERM");
        });
        return new Response(JSON.stringify({ ok: true, inFlight: busy }), {
          status: 202, headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && pathname === "/__daemon/worktree-gc") {
        // Run the worktree GC sweep on demand (the periodic one runs every 30m).
        // Reaps only what's provably safe; lands a closed task's clean unmerged
        // commits first. Returns the summary.
        const summary = await worktreeGc.runWorktreeGc();
        return new Response(JSON.stringify({ ok: true, summary }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    // ── Pagina pubblica del profilo — senza autenticazione.
    // Risponde prima del gate: l'URL e' pensato per essere condiviso con chi
    // non ha un account Topics. Raggiungibile via LAN e via relay.
    {
      const r = publicProfileHandler(pathname, method);
      if (r) return r;
    }

    // ── Origin gate — guards /api, /ws, /preview, /media, /uploads.
    // Una sola decisione, e riguarda l'ORIGINE: viene bloccata una richiesta
    // MUTANTE o un upgrade WS la cui `Origin` non è lo stesso sito dell'`Host`
    // (né una origine ammessa esplicitamente). È la difesa contro un sito che
    // l'utente visita e che da lì guida questo server.
    //
    // NON c'è più un asse di TRASPORTO: nessun token, nessun controllo
    // sull'indirizzo del peer. Chi può raggiungere la porta lo decide la rete —
    // vedi `server/lib/auth-gate.ts` per il modello intero e per il perché le
    // richieste non mutanti non passano di qui (le protegge l'assenza di
    // `Access-Control-Allow-Origin` in `corsAllowOrigin`).
    //
    // Il preflight OPTIONS è esente (gli si risponde sotto). Botola di recupero:
    // TOPICS_AUTH_OFF=1 + kickstart.
    if (method !== "OPTIONS" && isOriginGatedPath(pathname)) {
      // ── Asse IDENTITA', risolto qui perche' serve il DB (il gate resta puro).
      // Le due sole esenzioni sono i percorsi che SERVONO a ottenere l'identita':
      // esentarne uno di troppo e' un buco, uno di meno un vicolo cieco in cui
      // non ci si puo' appaiare.
      const peerIp = server.requestIP(req)?.address ?? null;
      // Il webhook di Stripe non ha — e non può avere — un'identità di
      // dispositivo: arriva da un server, non da un browser appaiato. Si
      // autentica da sé, con un HMAC sul corpo ESATTO (`server/lib/stripe.ts`),
      // che è una prova più forte di un cookie. Sta scritto QUI e non dentro
      // `isIdentityExemptPath` perché quella elenca i percorsi che servono a
      // OTTENERE un'identità: mescolarci un'autenticazione di altra natura
      // renderebbe più difficile accorgersi della prossima esenzione di troppo.
      const identity = (isIdentityExemptPath(pathname) || isBillingWebhookPath(pathname))
        ? undefined
        : (() => {
            const loopback = isLocalTransport(req, peerIp, isLoopbackAddress);
            // UNA sola traduzione cookie→identità, condivisa con l'upgrade del
            // WebSocket e con `/api/auth/session`. Erano tre query diverse, e
            // divergevano: la strada dimenticata è sempre la meno percorsa,
            // cioè quella dove il difetto vive di più prima che si veda.
            const io = resolveIdentity(ctx.db, req.headers.get("cookie"), loopback);
            const device = io.device;
            const sessionToken = loopback ? null : readSessionCookie(req.headers.get("cookie"));
            const r = evaluateIdentity({
              transport: loopback ? "loopback" : "remote",
              sessionToken,
              device,
              bearerToken: loopback ? null : req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null,
              expectedDaemonToken: loopback ? null : readState()?.token ?? null,
              now: Date.now(),
            });
            // `last_seen_at` con parsimonia: sono ~94 chiamate per boot, e una
            // scrittura per ognuna trasformerebbe l'elenco dispositivi in una
            // sorgente di I/O. Un'ora di granularita' basta a dire «visto
            // l'ultima volta…».
            if (r.ok && r.as === "device" && device && (Date.now() - (device.lastSeenAt ?? 0)) > 3_600_000) {
              ctx.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), device.id);
            }
            if (r.ok) {
              // I PRINCIPALI di questo dispositivo: sé stesso, la sua persona,
              // le sue organizzazioni. Da qui in poi le concessioni si
              // confrontano con TUTTI, quindi una condivisione fatta a una
              // persona o a un team ha effetto senza che nessuna riga venga
              // riscritta a ogni pairing.
              const princ = r.deviceId ? io : null;
              // Il confinamento resta deciso da `devices.role`, e la nuova
              // regola gli sta accanto SENZA decidere: se divergono lo si
              // scopre da un log, non da un accesso sbagliato. È il passo che
              // separa «il modello nuovo esiste» da «il modello nuovo comanda».
              if (princ && princ.confined !== (r.role === "guest")) {
                console.warn(
                  `[principals] divergenza su ${r.deviceId}: ruolo=${r.role} confinato=${princ.confined}`,
                );
              }
              identityByRequest.set(req, { role: r.role, deviceId: r.deviceId });
              // ── L'OSPITE è confinato QUI, non nei singoli router.
              // Metterlo nei router significa dimenticarne uno: provato sulla
              // mia pelle mentre costruivo questo — col filtro nel solo router
              // dei task, un ospite leggeva `/api/topics` per intero.
              if (r.role === "guest") {
                if (!isGuestAllowedPath(pathname)) {
                  return { ok: false as const, status: 403, reason: "non disponibile per un ospite", code: "guest_forbidden" };
                }
                // Il METODO, che è il terzo asse e mancava. L'allowlist apre la
                // strada, il controllo sotto dice quale stanza, e questo dice
                // cosa ci si può fare: senza, `level='read'` era una parola
                // nello schema che nessuno faceva valere, e un ospite poteva
                // modificare o cancellare la scheda che gli avevi condiviso.
                if (!isGuestAllowedMethod(pathname, method)) {
                  return { ok: false as const, status: 403, reason: "sola lettura", code: "guest_read_only" };
                }
                // L'allowlist apre la STRADA; qui si controlla la STANZA. Un
                // percorso concesso con dentro l'id di una risorsa NON concessa
                // è il modo in cui un'allowlist di percorsi diventa inutile.
                if (r.deviceId) {
                  // Tutti i principali, non il solo dispositivo: è qui che
                  // «condiviso con una persona» smette di essere una riga
                  // inerte e diventa un accesso.
                  const principali = princ?.principals ?? deviceP(r.deviceId);
                  const concessa = (tipo: "task" | "topic", id: string): boolean =>
                    hasGrant(ctx.db, principali, tipo, id);

                  const idTask = pathname.match(/^\/api\/tasks\/([^/]+)/)?.[1];
                  if (idTask && !concessa("task", decodeURIComponent(idTask))) {
                    return { ok: false as const, status: 403, reason: "non condiviso", code: "not_shared" };
                  }
                  const idTopic = pathname.match(/^\/api\/(?:topics|messages)\/([^/]+)/)?.[1];
                  if (idTopic && !concessa("topic", decodeURIComponent(idTopic))) {
                    return { ok: false as const, status: 403, reason: "non condiviso", code: "not_shared" };
                  }
                  // `/media/` è aperto come percorso, non come contenuto: passa
                  // solo il file che è l'anteprima di un task concesso.
                  if (pathname.startsWith("/media/")) {
                    const richiesto = decodeURIComponent(pathname.slice("/media".length));
                    // I metacaratteri del LIKE vanno neutralizzati: un `%` in un
                    // nome di file trasformerebbe «questa anteprima» in «una
                    // qualunque anteprima», cioè in un passe-partout.
                    const ok = holdsGrantOnTaskPreview(ctx.db, principali, richiesto);
                    if (!ok) {
                      return { ok: false as const, status: 403, reason: "anteprima non condivisa", code: "guest_forbidden" };
                    }
                  }
                }
              }
              return { ok: true as const };
            }
            return { ok: false as const, status: r.status, reason: r.reason, code: r.code };
          })();

      const decision = evaluateAuth({
        origin: req.headers.get("origin"),
        method,
        pathname,
        host: req.headers.get("host"),
        authOff: process.env.TOPICS_AUTH_OFF === "1",
        allowedOrigins: resolveAllowedOrigins(),
        identity,
      });
      if (!decision.allow) {
        // The REFUSED value, not just the axis. "host not allowed" without
        // saying WHICH host sends you to read the code and guess: it happened
        // on 2026-08-21 on a pairing from the phone, with an allowlist that
        // looked right in the log and a phone sending a name that was not in it.
        if (isApiRequest) {
          const dettaglio = decision.reason === "host not allowed"
            ? ` (host="${req.headers.get("host") ?? ""}")`
            : decision.reason?.includes("origin")
              ? ` (origin="${req.headers.get("origin") ?? ""}")`
              : "";
          console.log(`[HTTP] ✗ ${method} ${pathname} — ${decision.status}: ${decision.reason}${dettaglio}`);
        }
        const o = corsAllowOrigin(req);
        // Il `code` distingue «non sei appaiato» da «origine forestiera»: e' su
        // quello che il client decide se aprire la schermata di appaiamento o
        // limitarsi a segnalare. Un 401 muto era il difetto per cui il pairing
        // precedente non e' mai servito a nessuno.
        // The host axis gets its OWN code. With `forbidden` the phrase the
        // phone shows is the generic one, and the reason — the address it is
        // calling from — stays in the prose of `error`, which the interface
        // does not translate. See `shared/auth-codes.ts`.
        const codiceRifiuto = decision.code
          ?? (decision.reason === "host not allowed" ? "host_not_allowed" : "forbidden");
        return new Response(JSON.stringify({ error: decision.reason, code: codiceRifiuto }), {
          status: decision.status,
          headers: { "content-type": "application/json", ...(o ? { "Access-Control-Allow-Origin": o, Vary: "Origin" } : {}) },
        });
      }
    }

    // WebSocket upgrade - terminal
    if (pathname.startsWith("/ws/terminal/")) {
      const termId = pathname.split("/ws/terminal/")[1];
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now(), terminalId: termId, remote: isRemotePeer(req, server) } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Phase 30 BROWSER-CHAT-02 — WebSocket upgrade for browser streaming.
    // Path: /ws/browser/:contextId — bidirectional. server -> client carries
    // 'frame' (CDP screencast JPEG base64) and 'agent_active'/'console'/'nav'
    // events; client -> server carries 'input' actions (click/type/scroll/etc).
    // The per-WS lifecycle (startScreencast on open, stopScreencast on close,
    // input dispatch on message) lives in the websocket.{open,message,close}
    // handlers below.
    if (pathname.startsWith("/ws/browser/")) {
      const browserContextId = decodeURIComponent(pathname.split("/ws/browser/")[1] || "");
      if (!browserContextId) {
        return new Response("Missing contextId", { status: 400 });
      }
      const upgraded = server.upgrade(req, {
        data: {
          id: crypto.randomUUID(),
          focusedTopicId: null,
          lastPong: Date.now(),
          browserContextId,
          remote: isRemotePeer(req, server),
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade
    if (pathname === "/ws") {
      // Il dispositivo si timbra QUI: e' l'ultimo momento in cui gli header —
      // e quindi il cookie di sessione — sono leggibili. Dopo l'upgrade un
      // WebSocket e' solo un tubo, e chiedersi «di chi e' questa socket»
      // sarebbe troppo tardi.
      // Id E RUOLO nello stesso giro. Il ruolo serve perché il filtro degli
      // ospiti si applica a chi È un ospite, non a chi ha un id: l'upgrade
      // timbra l'id di ogni dispositivo appaiato, proprietari compresi, e
      // confondere le due cose faceva cadere ogni frame sul telefono del
      // proprietario — che non ha concessioni perché non gliene servono.
      const wsDevice = (() => {
        const locale = isLocalTransport(req, server.requestIP(req)?.address ?? null, isLoopbackAddress);
        // La STESSA traduzione del cancello HTTP. Prima qui c'era una query a
        // parte che filtrava `revoked_at` in SQL e non calcolava persona né
        // organizzazione: era la strada su cui una novità restava indietro in
        // silenzio, perché nessuno guarda un WebSocket.
        const io = resolveIdentity(ctx.db, req.headers.get("cookie"), locale);
        if (!io.device || io.device.revokedAt !== null) return { id: null, role: null };
        return { id: io.device.id, role: io.confined ? "guest" as const : "owner" as const };
      })();
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now(), deviceId: wsDevice.id, deviceRole: wsDevice.role, remote: isRemotePeer(req, server) } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // LETTURA = GET **o HEAD**. Ogni ramo statico qui sotto era gated sul solo
    // `method === "GET"`, così un HEAD scivolava fino in fondo e prendeva 404:
    // misurato l'11/08 sul server vivo, `GET /assets/index-<hash>.js` → 200 e
    // `HEAD` sullo stesso path → 404, `HEAD /` → 404. HEAD è il verbo di cache,
    // proxy, link checker e sonde di salute — chi chiede «esiste? è cambiato?»
    // si sentiva rispondere «non esiste» e agiva di conseguenza (invalida,
    // riscarica, segnala un link morto). RFC 9110 §9.3.2: la risposta a HEAD è
    // identica a quella di GET **senza il corpo**, header compresi.
    // Il corpo non va tolto a mano: Bun.serve svuota da sé la risposta a un HEAD
    // e conserva `Content-Length` (verificato con Bun.file e con una stringa) —
    // quello che mancava era solo il montaggio del verbo.
    const isRead = method === "GET" || method === "HEAD";
    // La parità degli HEADER, non solo dello status. Quando il corpo è un
    // `Bun.file` grande (misurato: 290 KB sì, 3 KB no — è il ramo sendfile) Bun
    // aggiunge da sé un `Content-Disposition: filename="index-<hash>.js"`, che
    // sull'HEAD non c'è: due risposte che dovrebbero essere identiche
    // differivano di un header, e quello sul GET è pure malformato (RFC 6266
    // vuole un tipo, `inline`/`attachment`, non un `filename` nudo). Dichiararlo
    // NOI vince sull'iniezione e riallinea i due verbi.
    // Solo per il bundle, che è roba NOSTRA e va renderizzata: gli allegati e i
    // media restano senza dichiarazione, e i download del browser hanno già il
    // loro `attachment` esplicito qualche riga più sotto.
    // Dev mode proxy: ?dev=true proxies to Topics Vite dev server on :3332
    const isDevMode = url.searchParams.get("dev") === "true" || req.headers.get("cookie")?.includes("topics-dev=true");
    if (isDevMode && isRead && !pathname.startsWith("/api/") && !pathname.startsWith("/ws")) {
      try {
        const viteUrl = `https://localhost:3332${pathname}${url.search}`;
        // `method` e non "GET" implicito: un HEAD proxato come GET tirerebbe giù
        // da Vite l'intero modulo per poi buttarlo via.
        const viteResp = await fetch(viteUrl, { method, headers: req.headers, tls: { rejectUnauthorized: false } } as any);
        if (viteResp.ok) {
          const respHeaders = new Headers(viteResp.headers);
          if (url.searchParams.get("dev") === "true") {
            respHeaders.set("Set-Cookie", "topics-dev=true; Path=/; SameSite=Lax");
          }
          return new Response(viteResp.body, { status: viteResp.status, headers: respHeaders });
        }
      } catch {
        // Vite not running, fall through to static files
      }
    }
    // Exit dev mode: ?dev=false clears cookie
    if (url.searchParams.get("dev") === "false") {
      return new Response(null, { status: 302, headers: { "Location": "/", "Set-Cookie": "topics-dev=; Path=/; Max-Age=0" } });
    }

    // Static files
    const isDevPort = PORT === 3330;
    if (isRead && (pathname === "/" || pathname === "/index.html")) {
      // Last-known-good shell. /public is rewritten while the server serves it:
      // it was the build-watch agent (off since 2026-08-04, and staying off:
      // docs/build-watch-decision.md), and it is now the one-shot
      // `bun run build:client`, which EMPTIES public/ first. So a page load
      // that lands mid rebuild used to read a missing index.html, throw, and
      // answer 500 — the app "doesn't open", for a window that has nothing to
      // do with the app.
      // Serving the previous shell instead turns a rebuild into something the
      // user never sees. The rev is cached WITH the html: re-deriving it from
      // a half-written /public would stamp an empty rev and trip the client's
      // "new version available" detector.
      let html: string;
      let rev: string;
      try {
        const fresh = await Bun.file(join(PUBLIC_DIR, "index.html")).text();
        if (!fresh.trim()) throw new Error("index.html is empty");
        html = fresh;
        rev = readBundleRev(PUBLIC_DIR);
        lastGoodShell = { html: fresh, rev };
      } catch (err) {
        if (!lastGoodShell) {
          console.error(`[Static] index.html unreadable and no cached shell:`, err);
          return new Response("Bundle not built yet — run `cd client && bun run build`.", { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        console.warn(`[Static] index.html unreadable (build in flight?) — serving the last good shell`);
        ({ html, rev } = lastGoodShell);
      }
      if (isDevPort) {
        html = html
          .replace(/\/icons\/icon-180\.png/g, '/icons/icon-180-dev.png')
          .replace(/\/icons\/icon-192\.png/g, '/icons/icon-192-dev.png')
          .replace('href="/manifest.json"', 'href="/manifest-dev.json"');
      }
      // Stamp the rev this HTML represents so the client never has to re-derive
      // it from its own DOM (which drifts as Vite injects lazy-chunk preloads —
      // the phantom "nuova versione disponibile" loop).
      html = stampBundleRev(html, rev);
      // no-STORE, not no-cache: the app shell must never sit in a cache. With
      // `no-cache` WKWebView still served a stale index.html after a deploy
      // (revalidation didn't fire reliably), so the desktop kept booting the
      // old bundle. `no-store` forces a fresh fetch every launch; the hashed
      // /assets/* stay immutable, so this costs one tiny HTML fetch, not the JS.
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (isRead && pathname.endsWith(".html")) {
      const file = Bun.file(join(PUBLIC_DIR, pathname));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": "inline" } });
    }
    // Asset del bundle. La decisione (quali file, con che cache) sta in
    // `classifyStaticAsset` (server/static-assets.ts) così è unit-testata —
    // stesso trattamento di `shouldServeSpaFallback`. Qui c'era un elenco di
    // nomi a mano in cui `/boot.js` mancava: la shell web caricava uno script
    // che rispondeva 404, e con lui perdeva tema pre-paint e service worker.
    if (isRead) {
      const asset = classifyStaticAsset(pathname, PUBLIC_DIR);
      if (asset) {
        const file = Bun.file(asset.filePath);
        if (await file.exists()) {
          return new Response(file, { headers: { "Content-Type": getMimeType(asset.filePath), "Cache-Control": asset.cacheControl, "Content-Disposition": "inline" } });
        }
      }
    }

    // Serve uploaded files (screenshots, attachments)
    if (isRead && pathname.startsWith("/uploads/")) {
      const filePath = join(ctx.UPLOADS_DIR, pathname.slice("/uploads/".length));
      // Lo stesso cancello di `/media/`: il confronto e' su una CARTELLA, con il
      // separatore in coda, cosi' un fratello tipo `…/uploads-evil` non passa.
      const resolvedUpload = resolve(filePath);
      const resolvedUploads = resolve(ctx.UPLOADS_DIR);
      if (resolvedUpload !== resolvedUploads && !resolvedUpload.startsWith(resolvedUploads + sep)) {
        return new Response("Forbidden", { status: 403 });
      }
      const file = Bun.file(filePath);
      if (await file.exists()) {
        // UN UPLOAD E' CONTENUTO DI QUALCUN ALTRO servito sull'origine della app.
        // Senza `nosniff` un browser puo' indovinare il tipo e rendere un .svg o
        // un .html come pagina: XSS memorizzata, stessa origine, sessione inclusa.
        // Le immagini/video/audio/pdf restano `inline` perche' e' cosi' che si
        // guardano in chat; tutto il resto scende come allegato, come gia' fanno
        // i download del browser pane qui sotto.
        // `image/svg+xml` PASSAVA il test `^image/`, ed e' esattamente il buco
        // che quel commento diceva di chiudere: un .svg navigato direttamente
        // esegue il suo `<script>` sull'origine della app, con la sessione
        // dentro. La decisione sta in `served-file-headers` perche' era gia'
        // scritta due volte — qui e nei download del browser pane 40 righe piu'
        // sotto — e le due copie erano divergenti.
        return new Response(file, {
          headers: servedFileHeaders({
            mime: getMimeType(filePath),
            filename: pathname.split("/").pop() || "file",
            cacheControl: "public, max-age=3600",
          }),
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    // Serve OpenClaw media files (browser screenshots, etc.)
    // Handles paths like /media/browser/uuid.jpg → ~/.openclaw/media/browser/uuid.jpg
    if (isRead && pathname.startsWith("/media/") && !pathname.includes("..")) {
      const mediaBase = join(process.env.HOME || "/tmp", ".openclaw", "media");
      const filePath = join(mediaBase, pathname.slice("/media/".length));
      // Security: ensure resolved path stays within media directory (match on a
      // trailing separator so a sibling like `…/media-evil` can't sneak through,
      // while still allowing the base dir itself).
      const resolvedFile = resolve(filePath);
      const resolvedBase = resolve(mediaBase);
      if (resolvedFile === resolvedBase || resolvedFile.startsWith(resolvedBase + sep)) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          // Browser-pane DOWNLOADS are UNTRUSTED content (whatever a headless
          // page downloaded) served same-origin. Force an attachment + no sniff
          // + CSP sandbox so an .html/.svg payload can NEVER inline-render as
          // stored XSS on the app origin — the link only ever downloads the file.
          if (pathname.startsWith("/media/browser/downloads/")) {
            const name = (pathname.split("/").pop() || "download").replace(/["\\\r\n]/g, "_");
            return new Response(file, {
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": `attachment; filename="${name}"`,
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox",
                "Cache-Control": "private, no-store",
              },
            });
          }
          return new Response(file, { headers: { "Content-Type": getMimeType(filePath), "Cache-Control": "public, max-age=86400" } });
        }
      }
      return new Response("Not Found", { status: 404 });
    }

    // Preview endpoint: serve local files for browser panel
    if (isRead && pathname.startsWith("/preview/")) {
      let filePath = decodeURIComponent(pathname.slice("/preview".length));
      if (!filePath.startsWith("/")) filePath = "/" + filePath;
      const resolved = resolve(filePath);
      if (resolved !== filePath || filePath.includes("..")) return new Response("Forbidden", { status: 403 });
      // CONFINE. Fino al 2026-08-06 qui non ce n'era nessuno: l'unico controllo
      // era «il path è canonico», quindi QUALUNQUE file del disco usciva da qui.
      // Misurato: `GET /preview/etc/hosts` → 200 col contenuto, e da una seconda
      // rete presente sulla macchina. `~/.ssh/id_rsa` stava dietro la stessa
      // porta, e con lui `~/.topics/daemon-state.json`, cioè il token del daemon.
      //
      // L'identità (change `device-auth`) chiude la porta a chi non è appaiato,
      // ma non rende sicuro un file server per chi è dentro: un dispositivo
      // autorizzato non ha ragione di leggere `/etc`. Il confine è quello che il
      // resto del server usa già — l'unione delle dir di progetto note
      // (`resolveProjectPath`, che confronta il path REALE così un symlink dentro
      // un progetto non diventa una porta) più le radici dei media e degli
      // allegati. Non è una lista nuova da mantenere: è la stessa, riusata.
      const dentroProgetto = ctx.resolveProjectPath(resolved) !== null;
      if (!dentroProgetto && !ctx.isPathAllowed(resolved)) {
        console.warn(`[Security] Preview path denied: ${resolved}`);
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const file = Bun.file(resolved);
        if (await file.exists()) {
          return new Response(file, { headers: { "Content-Type": getMimeType(resolved), "Cache-Control": "no-cache" } });
        }
      } catch {}
      return new Response("Not Found", { status: 404 });
    }

    // Desktop shell (Tauri) CORS preflight — no-op for non-desktop origins.
    if (isApiRequest && method === "OPTIONS") {
      const o = corsAllowOrigin(req);
      if (o) return new Response(null, { status: 204, headers: corsPreflightHeaders(req, o) });
    }

    // Route through handlers
    if (isApiRequest) {
      const response = await topicsRouter(req, url, pathname, method)
        || await voiceRouter(req, url, pathname, method)
        || await mediaRouter(req, url, pathname, method)
        || await branchesRouter(req, url, pathname, method)
        || await projectsRouter(req, url, pathname, method)
        || await worktreesRouter(req, url, pathname, method)
        || await machinesRouter(req, url, pathname, method)
        || await filesRouter(req, url, pathname, method)
        || await browserRouter(req, url, pathname, method)
        || await cronRouter(req, url, pathname, method)
        || await contextRouter(req, url, pathname, method)
        || await terminalRouter(req, url, pathname, method)
        || await statusRouter(req, url, pathname, method)
        || await memoryRouter(req, url, pathname, method)
        || await mcpRouter(req, url, pathname, method)
        || await sessionEnvironmentRouter(req, url, pathname, method)
        || await activityRouter(req, url, pathname, method)
        || await externalSessionsRouter(req, url, pathname, method)
        || await checkpointsRouter(req, url, pathname, method)
        || await goalsRouter(req, url, pathname, method)
        || await openRouter(req, url, pathname, method)
        || (openclawContextRouter && await openclawContextRouter(req, url, pathname, method))
        || await contextPreviewRouter(req, url, pathname, method)
        || await authRouter(req, url, pathname, method)
        || await accountRouter(req, url, pathname, method)
        || await peopleRouter(req, url, pathname, method)
        || await licenseRouter(req, url, pathname, method)
        || await billingRouter(req, url, pathname, method)
        || await dashboardRouter(req, url, pathname, method)
        || await profileRouter(req, url, pathname, method)
        || await processesRouter(req, url, pathname, method)
        || await tasksRouter(req, url, pathname, method)
        || await pushRouter(req, url, pathname, method)
        || await notificationsRouter(req, url, pathname, method)
        || await uiStateRouter(req, url, pathname, method)
        || await providersRouter(req, url, pathname, method)
        || await appSettingsRouter(req, url, pathname, method)
        || await tabsRouter(req, url, pathname, method)
        || await claudeHooksRouter(req, url, pathname, method)
        || await e2eRouter(req, url, pathname, method)
;

      if (response) {
        applyDesktopCors(req, response);
        return response;
      }
      return new Response("Not Found", { status: 404 });
    }

    // SPA navigation fallback. Client-side routes like `/task/<uuid>` have no
    // file on disk; a full-page load (refresh / pasted link) must still boot the
    // app so openTaskLink can read the path. Serve the app shell for GET HTML
    // navigations only. This sits AFTER all api/asset routing on purpose: a
    // missing asset (`/assets/foo.js`) or unknown `/api/*` route already returned
    // its real 404 above — never masked by index.html. The decision lives in
    // `shouldServeSpaFallback` (server/spa-fallback.ts) so it's unit-tested.
    // Same no-store headers as the "/" branch.
    if (shouldServeSpaFallback({ method, pathname, accept: req.headers.get("accept") })) {
      let html = await Bun.file(join(PUBLIC_DIR, "index.html")).text();
      if (isDevPort) {
        html = html
          .replace(/\/icons\/icon-180\.png/g, '/icons/icon-180-dev.png')
          .replace(/\/icons\/icon-192\.png/g, '/icons/icon-192-dev.png')
          .replace('href="/manifest.json"', 'href="/manifest-dev.json"');
      }
      html = stampBundleRev(html, readBundleRev(PUBLIC_DIR));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    maxPayloadLength: 1024 * 1024,
    /**
     * Negotiates permessage-deflate. It does NOT compress anything on its own:
     * measured on Bun 1.3.8 with a byte counting proxy, `ws.send(x)` still went
     * out at 44,667 B for a 44,395 B payload, and only `ws.send(x, true)`
     * brought it to 5,423 B. The option opens the door, the per send flag walks
     * through it, and who decides is `shouldCompressFrame`
     * (`server/lib/ws-compression.ts`).
     *
     * Worth opening because the first screen comes off this socket:
     * `ui-state:init` is 86,222 B and gzips to 20,872 (4.13x), `unread:init` is
     * 81,713 and gzips to 24,936 (3.28x), for about 1.5 ms of CPU in total.
     */
    perMessageDeflate: true,
    open(ws) {
      ws.data.lastPong = Date.now();
      if (ws.data.deviceId) noteDeviceConnected(ws.data.deviceId);

      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      // Started BEFORE the terminal branch since both use ws.data fields,
      // but the browser branch is the more specific check.
      if (ws.data.browserContextId) {
        const ctxId = ws.data.browserContextId;
        console.log(`[WS][browser] Open: ${ws.data.id} -> ctx ${ctxId}`);
        // Phase 30 BROWSER-CHAT-03 — register this WS in the broadcast set
        // so broadcastToBrowserWs(ctxId, msg) reaches it.
        let bset = browserWsClients.get(ctxId);
        if (!bset) {
          bset = new Set();
          browserWsClients.set(ctxId, bset);
        }
        bset.add(ws);
        // Tell the newcomer where the count stands, then the others that it
        // moved. The direct send covers the one case the broadcast cannot: a
        // socket joining a context whose count did not change.
        // The newcomer is never in its own number: undeclared, it would count
        // itself and a native pane would flip to shared on its own reflection
        // (the two-second register/destroy loop of 2026-09-03).
        sendBrowserWsMessage(ws, { type: 'viewers', count: countSharedViewers(bset, ws) });
        viewerCountPublisher.publish(ctxId, ws);
        // This WS's own frame consumer. Hoisted to a const so we pass the SAME
        // identity to stopScreencast — with fan-out, that removes only THIS
        // viewer and leaves the shared CDP screencast running for the others
        // (the old stopScreencast(ctxId) detached the session, blacking out
        // every other client viewing the same browser).
        const onFrame = (data: string, metadata: { timestamp: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number }) => {
          // Backpressure: if the WS isn't OPEN (1), drop the frame.
          if (ws.readyState !== 1) return;
          // Backpressure #2 — congested link: the CDP screencast keeps producing at
          // full local rate and its frame ACK fires on receipt (decoupled from this
          // send), so a slow viewer (mobile PWA on a bad link) would otherwise pile
          // frames unbounded in the server-side WS send buffer. DROP instead of
          // queue: for a LIVE view the freshest frame once the buffer drains is what
          // matters, not a stale backlog. ~1MB ≈ tens of q70 JPEG frames of slack.
          if (ws.getBufferedAmount() > 1_000_000) return;
          sendBrowserWsMessage(ws, {
            type: 'frame',
            data,
            metadata: {
              timestamp: metadata.timestamp,
              pageScaleFactor: metadata.pageScaleFactor,
              deviceWidth: metadata.deviceWidth,
              deviceHeight: metadata.deviceHeight,
            },
          });
        };
        // Deferred + race-safe screencast start. A Tauri native pane's FIRST
        // frame is `register_native_executor`, which arrives a few ms after
        // open — but startScreencast's getOrCreate would already be launching a
        // headless Chromium for a context that must NOT exist server-side
        // (delegated panes run ops natively). The old code started eagerly and
        // the 'registered' cleanup raced it: stopScreencast found no session
        // yet (idempotent no-op), the start then completed seconds later, and
        // the screencast streamed JPEGs forever into a pane that ignores them —
        // with the phantom context pinning Chromium past the reaper's
        // contexts.size===0 gate. The grace window lets the register frame
        // cancel the start before anything launches; if the start already
        // began, cleanup AWAITS it before stopping so the stop can't lose.
        const SCREENCAST_START_GRACE_MS = 250;
        let screencastCancelled = false;
        let screencastStart: Promise<void> | null = null;
        // Task 052f53ef — the desired stream state for THIS viewer. The web pane
        // flips it to false while it shows a native <iframe> (T2) so the headless
        // Chromium stops rendering frames nobody watches, and back to true when it
        // returns to the stream. Distinct from screencastCancelled (WS teardown).
        let streamActive = true;
        const startScreencastForViewer = () => {
          screencastStart = browserService.startScreencast(ctxId, onFrame).catch(err => {
            console.warn(`[WS][browser] startScreencast failed for ${ctxId}:`, err.message);
            try {
              ws.send(JSON.stringify({ type: 'error', message: `Screencast start failed: ${err.message}` }));
            } catch {}
          });
        };
        const screencastTimer = setTimeout(() => {
          // Skip the deferred start if a native executor cancelled it OR the pane
          // already paused the stream (iframe-mode) during the grace window.
          if (screencastCancelled || !streamActive) return;
          startScreencastForViewer();
        }, SCREENCAST_START_GRACE_MS);
        ws.data._browserSetStream = (active: boolean) => {
          if (screencastCancelled || active === streamActive) return;
          streamActive = active;
          if (active) {
            // Resume: re-attach this viewer to the (shared) screencast.
            startScreencastForViewer();
          } else {
            // Pause: detach this viewer. When it was the last viewer the shared
            // CDP session tears down and the headless page stops rendering; the
            // context stays alive (WS open) so agent_active still reaches the pane.
            browserService.stopScreencast(ctxId, onFrame).catch(err =>
              console.warn(`[WS][browser] pause stopScreencast failed for ${ctxId}:`, err.message)
            );
          }
        };
        ws.data._browserCleanup = async () => {
          screencastCancelled = true;
          clearTimeout(screencastTimer);
          if (screencastStart) await screencastStart;
          await browserService.stopScreencast(ctxId, onFrame).catch(err =>
            console.warn(`[WS][browser] stopScreencast failed for ${ctxId}:`, err.message)
          );
        };
        return;
      }

      const termId = ws.data.terminalId;
      if (termId) {
        // Terminal WebSocket
        const handler = handleTerminalWebSocket(ws, termId);
        if (handler) ws.data._termHandler = handler;
        return;
      }
      wsClients.add(ws);
      console.log(`[WS] Client connected: ${ws.data.id} (total: ${wsClients.size})`);

      /**
       * LA PORTA UNICA della raffica di apertura.
       *
       * Serve perché questi `send` non passano da `broadcastToAll`: sono
       * diretti alla socket appena aperta, e per questo scavalcavano il filtro
       * degli ospiti per intero. Il buco non era teorico — un ospite riceveva
       * `ui-state:init` (il pane-store del PROPRIETARIO, con i titoli e gli id
       * di ogni chat), `unread:init` (i non-letti di tutte), e dal catch-up il
       * CONTENUTO vivo di qualunque stream in corso. L'API era perfetta e la
       * roba passava sul filo.
       *
       * La regola è la stessa dei broadcast, e non una seconda scritta a mano:
       * stretta di mano sempre, per un ospite tipo ammesso più entità
       * concessa, altrimenti si tace. Un frame nuovo aggiunto qui domani cade
       * dalla parte giusta senza che nessuno se ne ricordi.
       */
      const ospiteWS = isGuestSocketData(ws.data);
      const inviaIniziale = (frame: Record<string, unknown>): void => {
        const tipo = String(frame.type ?? "");
        if (!isGuestHandshakeFrame(tipo) && ospiteWS) {
          if (!isGuestSafeFrameType(tipo)) return;
          const risorsa = frameResource(frame);
          if (!risorsa || !hasGrant(ctx.db, principaliDi(ws.data.deviceId!), risorsa.type, risorsa.id)) return;
        }
        try { ws.send(JSON.stringify(frame)); } catch { /* socket già chiusa */ }
      };

      inviaIniziale({ type: "connected", clientId: ws.data.id });
      // A hold in force is the first thing a reconnecting client must know:
      // without it the banner would appear only at the NEXT change.
      const holdInForce = providerHold();
      if (holdInForce) {
        inviaIniziale({ type: "provider:hold", untilMs: holdInForce.untilMs, window: holdInForce.window, reason: holdInForce.reason, sinceMs: holdInForce.sinceMs });
      }
      // v3 foundations WS-02 — handshake welcome (additive; old clients ignore unknown types).
      inviaIniziale({
        type: "welcome",
        serverVersion: SERVER_VERSION,
        protocolVersion: SERVER_PROTOCOL_VERSION,
        capabilities: SERVER_CAPABILITIES,
        serverTime: Date.now(),
        clientId: ws.data.id,
      });
      // Dev-only freshness check: a window that missed the deploy-time
      // broadcast reloads itself on reconnect (null when the flag is off —
      // standalone installs never see this frame).
      { const __rev = devBundleReload.getRev(); if (__rev) inviaIniziale({ type: "ui:bundle-rev", rev: __rev }); }
      // I non-letti si RESTRINGONO invece di sparire: il pallino sulla chat che
      // gli hai condiviso è suo, quelli delle altre no. Scartare tutto sarebbe
      // sicuro e sbagliato — un ospite senza pallini non sa mai che è arrivato
      // qualcosa.
      {
        const tutti = loadUnread() as Record<string, unknown>;
        const suoi = ospiteWS
          ? Object.fromEntries(Object.entries(tutti).filter(([topicId]) =>
              hasGrant(ctx.db, principaliDi(ws.data.deviceId!), "topic", topicId)))
          : tutti;
        inviaIniziale({ type: "unread:init", data: suoi });
      }
      // `ui-state:init` e `providers:snapshot` NON hanno una versione ristretta,
      // e non devono averla: il primo è l'area di lavoro del proprietario — le
      // sue finestre, il suo layout — e il secondo la configurazione della
      // macchina. Non sono dati di cui esista una fetta che spetti a un ospite,
      // quindi cadono dal filtro come qualunque altro frame non ammesso.
      { const __ui = loadAllUiState(db); inviaIniziale({ type: "ui-state:init", data: __ui.data, meta: __ui.meta }); }
      // Initial provider snapshot — keeps the picker / settings page in sync without an extra HTTP fetch.
      try {
        const { getSnapshotManager } = require("./server/providers/snapshot-manager") as typeof import("./server/providers/snapshot-manager");
        inviaIniziale({ type: "providers:snapshot", snapshot: getSnapshotManager().getSnapshot() });
      } catch {
        // Snapshot manager not loaded yet — initial bootstrap will broadcast once it warms up.
      }

      // Send catch-up for any active streams so new clients can join mid-stream.
      //
      // The catchup MUST include `toolCalls` and `blocks` from the partial
      // message in DB, not just `content` + `thinking`. Without them, a fresh
      // WS connect (browser refresh, second window, network reconnect) sees
      // only the cumulative text and loses any tool calls that already
      // executed in the stream — the user perceives "response arrived all
      // at once with no tools visible". With them, the chronological timeline
      // is preserved and future stream:* deltas continue appending live.
      // The common case is zero active streams (idle app): skip the work
      // entirely rather than paying a full loadTopics() table-scan+joins on
      // every WS connect. When streams do exist, resolve each one's topicId
      // via the indexed single-row lookup instead of scanning all topics.
      for (const [sessionKey, stream] of activeStreams.entries()) {
        // Trust the DB's `partial` flag as single source of truth: if the
        // assistant message was already finalized, the stream is over even
        // though `activeStreams` still has a stale entry (can happen when an
        // `endStream` path skipped cleanup, or when a broadcast was lost
        // before this client reconnected). Emitting catchup here would
        // wedge the client's `streaming` state on for up to 3 min until the
        // watchdog clears it — which the user perceives as random ghost
        // spinners on chat tabs.
        const partial = getMessageById(stream.messageId);
        if (!partial || partial.partial !== true) {
          activeStreams.delete(sessionKey);
          continue;
        }
        const topicId = ctx.getTopicBySessionKey(sessionKey)?.id;
        // Dalla stessa porta della raffica: questo frame porta il TESTO di un
        // turno a metà, ed è quello che un ospite non deve vedere per una chat
        // che non è sua.
        inviaIniziale({
          type: "stream:catchup",
          sessionKey,
          topicId,
          messageId: stream.messageId,
          content: stream.content,
          thinking: stream.thinking,
          isThinking: stream.isThinking,
          toolCalls: partial.toolCalls,
          blocks: partial.blocks,
          // The wait the turn is in, if any: `stream:retry` / `stream:slow`
          // were broadcast before this client existed (`ActiveStream.retry`).
          ...(stream.retry ? { retry: stream.retry } : {}),
          ...(stream.slow ? { slow: true } : {}),
        });
      }
    },
    message(ws, message) {
      ws.data.lastPong = Date.now();

      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      if (ws.data.browserContextId) {
        const ctxId = ws.data.browserContextId;
        try {
          const raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
          // Tauri native-pane delegation — raw types OUTSIDE the strict browser-ws
          // Zod envelope (kept out of it on purpose so the schema stays the
          // streaming protocol). Classified by the shared helper (unit-tested);
          // handled before parseBrowserWsMessage.
          const delegated = handleNativeDelegationFrame(
            raw, ctxId,
            (m) => { try { ws.send(JSON.stringify(m)); } catch {} },
            nativeDelegateRegistry,
            ws, // owner — lets unregister() skip stale-socket cleanups after a re-register
            // Liveness del proprietario corrente: e' cio' che distingue una
            // RICONNESSIONE (socket vecchio gia' chiuso -> subentro lecito) da un
            // DIROTTAMENTO (un secondo processo locale che si registra sul
            // contextId di una pane ancora servita, e ne intercetterebbe le
            // tool-call, browser_load_state compreso).
            () => ws.readyState === 1 /* OPEN */,
          );
          if (delegated === 'rejected') {
            // Un esecutore vivo serve gia' questo contextId. Dirlo al socket e
            // chiuderlo: un client che si crede registrato e non lo e' resterebbe
            // in attesa di tool-call che non arriveranno mai, e la diagnosi
            // sarebbe "il browser non risponde" invece di "sei il secondo".
            try {
              ws.send(JSON.stringify({
                type: "register_native_executor_rejected",
                contextId: ctxId,
                reason: "un esecutore nativo vivo serve gia' questo contextId",
              }));
            } catch { /* socket gia' andato */ }
            try { ws.close(1008, "native executor already registered"); } catch {}
            return;
          }
          if (delegated === 'registered') {
            // A native pane runs ops itself — it never views server frames, so tear
            // down the screencast the open handler auto-started (no wasted headless
            // Chromium / bandwidth for a context that isn't streaming).
            //
            // FERMARE LO SCREENCAST NON BASTA. Il commento sulla grazia dei
            // 250 ms (SCREENCAST_START_GRACE_MS) dice che per una pane nativa
            // il contesto server «must NOT exist», e che un fantasma «pinning
            // Chromium past the reaper's contexts.size===0 gate». Ma la grazia
            // PERDE regolarmente: nel log di produzione il registro nativo
            // arriva DOPO che il timer ha gia' fatto `Context created` +
            // `Screencast started`, e da li' in poi si vede solo
            // `Screencast stopped` — mai `Context destroyed`. Il contesto
            // resta, si ri-naviga da solo all'ultima URL salvata (quindi
            // ricarica pagine e login che nessuno guarda) e tiene acceso
            // l'intero processo Chromium, che non puo' morire finche' esiste
            // un contesto. Il 2026-07-30 ne sono sopravvissuti quattro
            // insieme, raccolti solo dal reaper d'inattivita' a 30 minuti.
            //
            // Si aspetta la cleanup (che e' async: senza await lo stop puo'
            // perdere la corsa con la start in volo) e poi si distrugge il
            // contesto — ma SOLO se non esisteva prima di questo socket.
            // Cosi' muore il fantasma nato dalla partenza differita, e mai un
            // contesto legittimo che qualcun altro sta usando.
            const cleanup = ws.data._browserCleanup;
            ws.data._browserCleanup = undefined;
            // Mark it so the viewer count excludes it: a native pane is NOT a viewer
            // of the shared session, and counting its own delegate socket made an
            // 'auto' pane flap native↔shared every poll (browser reset every ~2s).
            // Va marcato PRIMA del controllo qui sotto, o questo stesso socket si
            // conterebbe come spettatore e il contesto non morirebbe mai.
            ws.data._nativeDelegate = true;
            // The delegate just left the count: the panes of this context (this
            // one included) hear the new value now, not on the next poll.
            viewerCountPublisher.publish(ctxId);
            // Il `message` handler non e' async: si sequenzia in una IIFE, che
            // e' comunque l'ordine che serve (prima lo stop, poi la distruzione).
            void (async () => {
              try { await cleanup?.(); } catch {}
              // La condizione NON e' «l'ho creato io» ma «lo sta guardando
              // qualcun altro?».
              //
              // La prima versione si fidava di `_browserCtxExistedBefore`,
              // fotografato in `open()`. Copriva solo il contesto nato dalla
              // partenza differita di QUESTO socket: alla RICONNESSIONE il
              // contesto esiste gia', quindi il controllo passava e il fantasma
              // sopravviveva. Misurato dopo quel fix: due contesti vivi, nove
              // processi Chromium, 664 MB — con zero pane browser aperte.
              //
              // Il contratto (vedi SCREENCAST_START_GRACE_MS) dice che per una
              // pane NATIVA il contesto server «must NOT exist». Non «non deve
              // essere creato da questo socket»: non deve esistere. Quindi si
              // guarda chi resta attaccato: se non c'e' nessun socket che NON
              // sia un delegato nativo, quel contesto non lo guarda nessuno e
              // se ne va. Una sessione condivisa (co-browse, il telefono che
              // guarda lo stream) tiene il suo socket non-delegato e sopravvive.
              //
              // Di proposito NON si riusa il contatore dei viewer di
              // `createBrowserRouter`: quello esclude anche chi ha la pane fuori
              // dallo schermo (`_watching === false`), che per il flapping
              // native↔shared e' giusto ma qui sarebbe un disastro — uno
              // spettatore in secondo piano e' comunque uno spettatore, e
              // distruggergli il contesto sotto lo lascerebbe a mani vuote
              // quando torna a guardare.
              const watchers = [...(browserWsClients.get(ctxId) ?? [])]
                .filter((w) => !w.data._nativeDelegate).length;
              if (watchers === 0) {
                try {
                  await browserService.destroyContext(ctxId);
                  console.log(`[WS][browser] destroyed phantom context ${ctxId} (native pane delegates ops, 0 viewers)`);
                } catch (err) {
                  console.warn(`[WS][browser] destroyContext(${ctxId}) failed:`, (err as Error).message);
                }
              }
              // IL VERSO OPPOSTO DEL CASSETTO COOKIE. Questa e' l'unica volta in
              // cui una WKWebView nativa si annuncia viva su un contesto: se la
              // sessione condivisa di quello stesso contesto ha un login (il
              // telefono si e' loggato mentre il Mac era via), qui lo si versa
              // nel suo barattolo. Senza, «mi loggo dal telefono e sul Mac sono
              // ancora fuori» non aveva nessun codice che lo risolvesse.
              //
              // Il flush prima serve quando il contesto e' ancora VIVO (qualcuno
              // guarda): l'autosave e' a 30s, e leggere il file cosi' com'e'
              // vorrebbe dire perdersi il login appena fatto. Se il contesto e'
              // stato appena distrutto, e' gia' stato salvato e il flush e' un
              // no-op. Nessuna delle due puo' lanciare: sta davanti al primo
              // fotogramma della pane nativa.
              await browserService.flushStorageState(ctxId).catch(() => false);
              const back = await seedNativeFromShared(ctxId);
              if (back.ok) {
                console.log(`[WS][browser] cookie della sessione condivisa passati alla pane nativa ${ctxId} (${back.cookies} cookie)`);
              } else if (back.skipped !== "empty" && back.skipped !== "unchanged" && back.skipped !== "no-native-pane") {
                console.warn(`[WS][browser] passaggio cookie condivisa→nativa saltato per ${ctxId}: ${back.skipped}${back.error ? ` (${back.error})` : ""}`);
              }
            })();
            console.log(`[WS][browser] native executor registered for ctx ${ctxId}`);
            return;
          }
          if (delegated === 'result') return;
          const result = parseBrowserWsMessage(raw);
          if (!result.ok) {
            console.warn(`[WS][browser] Invalid message from ${ws.data.id}: ${result.error}`);
            return;
          }
          const parsed = result.data;
          if (parsed.type === 'input') {
            const relayed = browserService.dispatchInput(ctxId, parsed.action, parsed.payload).catch(err => {
              console.warn(`[WS][browser] dispatchInput failed for ${ctxId}:`, err.message);
              return 'failed' as const;
            });
            // DOPO IL CLICK, CHI HA PRESO IL FUOCO.
            //
            // Il pane deve vestire il proprio campo di cattura come il campo
            // remoto, o dal telefono esce sempre la stessa tastiera (quella di
            // testo) qualunque cosa si tocchi. Sul co-browse DOM la risposta è
            // in casa, nel mirror; sul ramo video il pane vede pixel e la
            // risposta può darla solo la pagina vera, qui.
            //
            // Va SOLO a chi ha cliccato: in una sessione condivisa gli altri non
            // hanno toccato niente, e non devono ritrovarsi una tastiera aperta.
            if (parsed.action === 'click') {
              void relayed.then(async (outcome) => {
                if (outcome === 'failed') return;
                const field = await browserService.describeFocusedField(ctxId).catch(() => null);
                try {
                  sendBrowserWsMessage(ws, { type: 'focus_field', ...(field ? { field } : {}) });
                } catch { /* socket gone — the keyboard question died with it */ }
              });
            }
          } else if (parsed.type === 'focus_query') {
            // LA STESSA RISPOSTA DEL CLICK, CHIESTA A VOCE.
            //
            // Sul ramo video il click non passa più di qui: da quando l'input
            // viaggia sul DataChannel va dal pane al sidecar a CDP, e il ramo
            // qui sopra — che è quello che nomina il campo a fuoco — non si
            // sveglia mai. Il pane allora chiede, subito dopo aver spinto il
            // click sul canale, e paga il round trip solo per la tastiera.
            //
            // Deliberatamente identico nel corpo al ramo del click, non
            // fattorizzato: sono due domande diverse (una segue un click che
            // abbiamo eseguito noi, l'altra un click che non abbiamo visto) e
            // l'unica cosa che condividono è la risposta.
            void (async () => {
              const field = await browserService.describeFocusedField(ctxId).catch(() => null);
              try {
                sendBrowserWsMessage(ws, { type: 'focus_field', ...(field ? { field } : {}) });
              } catch { /* socket gone — the keyboard question died with it */ }
            })();
          } else if (parsed.type === 'nav' && parsed.phase === 'request') {
            browserService.navigate(ctxId, parsed.url).then((r) => {
              // goto failures resolve with `error` (page stayed on the old
              // URL); launch failures reject below. Both must reach the pane
              // as phase 'error' — a bare 'response' here made every failed
              // navigation invisible (BRW-REL-02).
              if (r.error) {
                sendBrowserWsMessage(ws, { type: 'nav', url: parsed.url, phase: 'error', error: r.error });
              } else {
                sendBrowserWsMessage(ws, { type: 'nav', url: parsed.url, phase: 'response' });
              }
            }).catch(err => {
              const msg = err instanceof Error ? (err.message.split('\n')[0] || 'Browser failed to start') : String(err);
              console.warn(`[WS][browser] navigate failed for ${ctxId}:`, msg);
              try {
                sendBrowserWsMessage(ws, { type: 'nav', url: parsed.url, phase: 'error', error: msg });
              } catch { /* socket gone — nothing to surface to */ }
            });
          } else if (parsed.type === 'take_control') {
            // Phase 30 BROWSER-CHAT-04 — user reclaimed control. Force-release the
            // lock with an eager agent_active=false broadcast. The agent's in-flight
            // tool will complete naturally (Playwright actions are quick), and its
            // withLock finally block will broadcast agent_active=false a second
            // time. The double-broadcast is idempotent on the client. Aborting the
            // tool mid-action is a future enhancement (would require an
            // AbortController plumbed through BrowserService dispatchInput / handlers).
            console.log(`[WS][browser] take_control received for ctx ${ctxId}`);
            browserService.broadcastAgentActive(ctxId, false);
          } else if (parsed.type === 'resize') {
            // Match the server viewport (+HiDPI) to the pane's real size so the
            // page reflows responsively and renders sharp — no fixed-1280 letterbox.
            browserService.resize(ctxId, parsed.width, parsed.height, parsed.deviceScaleFactor).catch(err =>
              console.warn(`[WS][browser] resize failed for ${ctxId}:`, err.message)
            );
          } else if (parsed.type === 'set_engine') {
            // Engine switch (task 54601eeb). Non più dietro un flag: la
            // capacità la decide la presenza di un Chromium sulla macchina, e il
            // bottone lato client è già nascosto quando non c'è. Se lo switch
            // fallisce comunque (Chromium sparito, sidecar che non parte) si
            // torna a 'native': la pane resta dov'era invece di restare a metà.
            applyEngineSwitch(
              { registry: browserEngineRegistry, service: browserService, extensionsCount: chromiumExtensionsCount },
              ctxId,
              parsed.engine,
            ).then((msg) => {
              broadcastToBrowserWs(ctxId, msg);
            }).catch((err) => {
              console.warn(`[WS][browser] set_engine failed for ${ctxId}:`, err?.message || err);
              try { sendBrowserWsMessage(ws, { type: 'engine', engine: 'native' }); } catch { /* socket gone */ }
            });
          } else if (parsed.type === 'set_stream') {
            // Task 052f53ef — pause/resume this viewer's screencast when the pane
            // enters/leaves native iframe-mode (kills the wasted headless render).
            ws.data._browserSetStream?.(parsed.active);
          } else if (parsed.type === 'set_watching') {
            // «La mia pane è sullo schermo». È l'UNICO ingresso del conteggio
            // spettatori (browser-viewer-count.ts) e sta apposta fuori da
            // set_stream: quello è il transport, e il WebRTC lo mette in pausa
            // mentre guarda eccome.
            ws.data._watching = parsed.active;
            viewerCountPublisher.publish(ctxId);
          } else if (parsed.type === 'set_render') {
            // T1 DOM co-browse — switch THIS viewer between the pixel stream
            // ('video', default) and a native rrweb DOM reconstruction ('dom').
            // DOM mode injects rrweb into the SHARED headless page, streams tiny
            // DOM events, and pauses this viewer's wasted screencast; input keeps
            // flowing over the existing `input` messages (same page-CSS coords).
            if (parsed.mode === 'dom') {
              browserService.enableDomMode(ctxId).then((bootstrap) => {
                if (!bootstrap) {
                  // Unsupported (no page / injection failed) — force back to video.
                  sendBrowserWsMessage(ws, { type: 'render_mode', mode: 'video' });
                  return;
                }
                ws.data._domRender = true;
                sendBrowserWsMessage(ws, { type: 'render_mode', mode: 'dom' });
                // Bootstrap this viewer so it reconstructs without a reload.
                for (const event of bootstrap) sendBrowserWsMessage(ws, { type: 'dom_event', event });
                // Stop paying for JPEG frames this viewer no longer renders.
                ws.data._browserSetStream?.(false);
              }).catch((err) => {
                console.warn(`[WS][browser] enableDomMode failed for ${ctxId}:`, err?.message || err);
                try { sendBrowserWsMessage(ws, { type: 'render_mode', mode: 'video' }); } catch { /* socket gone */ }
              });
            } else {
              // Back to pixels: resume screencast, ack, and stop DOM emission once
              // NO viewer of this context is in DOM mode anymore.
              ws.data._domRender = false;
              ws.data._browserSetStream?.(true);
              sendBrowserWsMessage(ws, { type: 'render_mode', mode: 'video' });
              const anyDom = [...(browserWsClients.get(ctxId) ?? [])].some((w) => w.data._domRender);
              if (!anyDom) browserService.setDomEmit(ctxId, false);
            }
          } else if (parsed.type === 'webrtc_offer') {
            // Shared-session WebRTC transport — relay the viewer's offer to the Rust
            // sidecar, which attaches to THIS pane's CDP target and streams it as an
            // H.264 track. If the sidecar is unavailable the client gets no answer and
            // transparently keeps its JPEG stream (no regression).
            if (webrtcBridge.available()) {
              const streamId = parsed.stream ?? 'default';
              const peerId = `${ws.data.id}:${streamId}`;
              (ws.data._webrtcPeers ??= new Set()).add(peerId);
              const offeredSdp = parsed.sdp;
              // The pane's CDP target is created asynchronously from the `nav` that
              // precedes the offer; the first offer can arrive before it exists. Poll
              // briefly (rather than dropping the offer and forcing the client through
              // its multi-second retry watchdog) so a fresh pane connects on the first try.
              (async () => {
                let targetId: string | null = null;
                for (let i = 0; i < 12; i++) {
                  targetId = await browserService.getTargetId(ctxId);
                  if (targetId) break;
                  if (!ws.data._webrtcPeers?.has(peerId)) return; // peer torn down while waiting
                  await new Promise((r) => setTimeout(r, 250));
                }
                if (!targetId) {
                  console.warn(`[WS][browser] webrtc: no CDP target for ${ctxId} after wait (pane not streaming?)`);
                  return; // client retries with a fresh offer
                }
                webrtcBridge.offer(peerId, targetId, offeredSdp, {
                  onAnswer: (sdp) => { try { sendBrowserWsMessage(ws, { type: 'webrtc_answer', sdp, stream: streamId }); } catch { /* socket gone */ } },
                  onIce: (candidate, sdpMid, sdpMLineIndex) => { try { sendBrowserWsMessage(ws, { type: 'webrtc_ice', candidate, sdpMid, sdpMLineIndex, stream: streamId }); } catch { /* socket gone */ } },
                  onError: (m) => console.warn(`[WS][browser] webrtc offer failed for ${ctxId}: ${m}`),
                });
              })().catch((err) => console.warn(`[WS][browser] webrtc getTargetId failed for ${ctxId}:`, err?.message || err));
            }
          } else if (parsed.type === 'webrtc_ice') {
            // Trickle ICE from the viewer → sidecar (belt-and-suspenders on LAN).
            const streamId = parsed.stream ?? 'default';
            webrtcBridge.ice(`${ws.data.id}:${streamId}`, parsed.candidate, parsed.sdpMid ?? null, parsed.sdpMLineIndex ?? null);
          }
          // Ignore other message types from client (frame/agent_active/console/download/engine are server -> client only).
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[WS][browser] Failed to parse message from ${ws.data.id}:`, msg);
        }
        return;
      }

      const handler = ws.data._termHandler;
      if (handler) { handler.message(message); return; }
      try {
        const raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        const result = parseChatWsInbound(raw);
        if (!result.ok) {
          // Backward-compat: silently drop unknown/malformed messages instead
          // of crashing. The previous handler did the same (unmatched types
          // hit none of the `if` branches). Log in dev for observability.
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[WS] Invalid inbound message from ${ws.data.id}: ${result.error}`);
          }
          return;
        }
        const data = result.data;
        // A guest socket is read-only in BOTH directions. The outbound filter
        // (`isGuestSafeFrameType`, in the fan-out helpers) is what keeps the
        // owner's content off the wire; this is what keeps the guest's frames
        // off the owner's windows: typing text into any chat by topicId,
        // drag frames that close panels in a window whose id they name,
        // presence announcements that fill the roster. One rule, in
        // `lib/grants.ts` like the other three, not a check per case.
        const guestSocket = isGuestSocketData(ws.data);
        if (guestSocket && !isGuestInboundFrameAllowed(data.type)) {
          console.warn(`[WS] guest socket ${ws.data.id} sent '${data.type}': dropped`);
          return;
        }
        switch (data.type) {
          case 'focus':
            ws.data.focusedTopicId = data.topicId;
            break;
          case 'subscribe':
            // P6: the set of topics this connection currently has open, used to
            // route streaming deltas only to clients showing that topic.
            ws.data.openTopicIds = new Set(data.topicIds);
            break;
          case 'typing':
            broadcastToTopic(data.topicId, { type: 'typing', topicId: data.topicId, clientId: ws.data.id, text: data.text || '' }, ws);
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'drag:start':
            broadcast({ type: 'drag:start', topicId: data.topicId, sourceWindowId: data.windowId }, ws);
            break;
          case 'drag:end':
            broadcast({ type: 'drag:end', topicId: data.topicId, sourceWindowId: data.windowId }, ws);
            break;
          case 'drag:drop':
            broadcastToAll({ type: 'drag:accepted', topicId: data.topicId, targetWindowId: data.windowId, sourceWindowId: data.sourceWindowId });
            break;
          case 'hello':
            // v3 foundations WS-02 handshake — log client version + capabilities
            // for observability. Future protocol versions may use this to emit
            // an `upgrade-required` frame when clientProtocolVersion < SERVER_PROTOCOL_VERSION.
            console.log(`[WS][handshake] hello from ${ws.data.id}: client v${data.clientVersion} (proto ${data.protocolVersion}), caps=[${data.capabilities.join(', ')}]`);
            // Presence: a window may carry its identity + open topics on hello
            // (reconnect-safe — the client re-sends hello on every WS 'open').
            // Not for a guest: the handshake is protocol and passes, but the
            // presence fields would put its window into the owner's roster,
            // which is the same pollution `presence:announce` is refused for.
            if (data.windowId && !guestSocket) {
              ws.data.windowId = data.windowId;
              ws.data.windowLabel = data.windowLabel;
              ws.data.detached = data.detached;
              ws.data.presenceSpaceId = data.spaceId;
              ws.data.presenceTopicIds = data.topicIds ?? [];
              ws.data.presenceFocusedTopicId = data.focusedTopicId;
              ws.data.presenceTabs = data.tabs;
              broadcastPresence();
            }
            break;
          case 'presence:announce':
            // Presence update after hello (tab opened/closed/focused inside the
            // window, or detach state changed). Restamp this socket + re-snapshot.
            ws.data.windowId = data.windowId;
            ws.data.windowLabel = data.windowLabel;
            ws.data.detached = data.detached;
            ws.data.presenceSpaceId = data.spaceId;
            ws.data.presenceTopicIds = data.topicIds;
            ws.data.presenceFocusedTopicId = data.focusedTopicId;
            ws.data.presenceTabs = data.tabs;
            broadcastPresence();
            break;
        }
      } catch (err) { console.warn(`[WS] Failed to parse message from ${ws.data.id}:`, err); }
    },
    pong(ws) { ws.data.lastPong = Date.now(); },
    close(ws) {
      if (ws.data.deviceId) noteDeviceDisconnected(ws.data.deviceId);
      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      if (ws.data.browserContextId) {
        console.log(`[WS][browser] Close: ${ws.data.id} -> ctx ${ws.data.browserContextId}`);
        // Phase 30 BROWSER-CHAT-03 — remove from broadcast set BEFORE invoking
        // cleanup so any concurrent broadcast no longer targets this socket.
        const bset = browserWsClients.get(ws.data.browserContextId);
        if (bset) {
          bset.delete(ws);
          if (bset.size === 0) {
            browserWsClients.delete(ws.data.browserContextId);
            viewerCountPublisher.forget(ws.data.browserContextId);
          } else {
            viewerCountPublisher.publish(ws.data.browserContextId);
          }
        }
        // T1 DOM co-browse — if this was the last DOM-mode viewer, stop emission
        // (the page keeps recording cheaply; no wasted `dom_event` fan-out).
        if (ws.data._domRender) {
          const anyDom = [...(bset ?? [])].some((w) => w.data._domRender);
          if (!anyDom) browserService.setDomEmit(ws.data.browserContextId, false);
        }
        // Drop any native-executor registration for this pane + fail its in-flight
        // ops (Tauri delegation) — no-op if this context never registered, and
        // owner-scoped so a late `close` from an OLD socket can't kill a fresh
        // re-registration made by the pane's reconnect (see unregister()).
        nativeDelegateRegistry.unregister(ws.data.browserContextId, ws);
        // Tear down any WebRTC peers this pane opened on the sidecar.
        if (ws.data._webrtcPeers) {
          for (const peerId of ws.data._webrtcPeers) webrtcBridge.close(peerId);
          ws.data._webrtcPeers.clear();
        }
        ws.data._browserCleanup?.().catch(err =>
          console.warn(`[WS][browser] cleanup failed:`, err.message)
        );
        return;
      }

      const handler = ws.data._termHandler;
      if (handler) { handler.close(); return; }
      // Remove from client set FIRST so concurrent focus-based routing
      // (broadcastToTopic iterates wsClients by focusedTopicId) doesn't see this
      // ws at all. Clear focusedTopicId after as defense-in-depth in case any ref
      // to this ws object lingers elsewhere.
      wsClients.delete(ws);
      ws.data.focusedTopicId = null;
      console.log(`[WS] Client disconnected: ${ws.data.id} (total: ${wsClients.size})`);
      // Presence self-heal: if this socket had declared a window, re-broadcast
      // so peers drop its "open elsewhere" markers the instant it dies. Removed
      // from wsClients first, so the fresh snapshot no longer includes it.
      if (ws.data.windowId) broadcastPresence();
    },
  },
  // `satisfies` e non un'annotazione: tiene la tipizzazione contestuale dei
  // gestori (che senza il generico di `Bun.serve` si perde, e `req`, `ws`,
  // `message` tornano `any`) SENZA allargare il tipo del valore, che serve
  // intatto per lo spread nell'ascoltatore del tunnel.
} satisfies Parameters<typeof Bun.serve<WSData>>[0];

/**
 * JSON responses leave compressed toward whoever is NOT local.
 *
 * The real handler is left alone: it is wrapped once, here, where every response
 * of both listeners goes through. The reasoning for the rule, and for why
 * loopback stays raw, lives in `server/lib/compress-json.ts`. In short:
 * `/api/history` for a working topic weighs 5.17 MB and 1.39 MB compressed, but
 * the 60 ms of CPU that buys only buys a second and a half when there is a
 * network in between.
 */
function withJsonCompression(
  handler: typeof opzioniServer.fetch,
): typeof opzioniServer.fetch {
  return async function (this: unknown, req, srv) {
    const res = await handler.call(this as never, req, srv);
    // `undefined` means the WebSocket upgrade succeeded: there is no HTTP
    // response to compress.
    if (!res) return res;
    return compressJson(req, res, isRemotePeer(req, srv));
  } as typeof opzioniServer.fetch;
}

/**
 * One line per completed `/api/*` request: timestamp, status, duration.
 *
 * Before this the log had a start line for every API request (`[HTTP] -> GET
 * /x`, no time, no outcome) and a completion line ONLY for 404s: under load you
 * could not tell which route was slow or whether a request ever finished, and
 * the file was mostly the 2s viewer poll. The outcome is what a log is for, so
 * the start line is gone and the completion line is here, outside every
 * handler, where every response of both listeners passes. `logRequest`
 * (server/utils.ts, server/lib/http-log.ts) owns the format and keeps the
 * chatty routes quiet unless they fail or are slow.
 *
 * `undefined` is a WebSocket upgrade: no response, nothing to log.
 */
function withHttpLog(
  handler: typeof opzioniServer.fetch,
): typeof opzioniServer.fetch {
  return async function (this: unknown, req, srv) {
    const t0 = Date.now();
    const res = await handler.call(this as never, req, srv);
    if (res) {
      const pathname = new URL(req.url).pathname;
      if (pathname.startsWith("/api/")) logRequest(req.method, pathname, res.status, t0);
    }
    return res;
  } as typeof opzioniServer.fetch;
}

const fetchCompresso = withHttpLog(withJsonCompression(opzioniServer.fetch));

const server = Bun.serve<WSData>({ ...opzioniServer, fetch: fetchCompresso });

// Da qui in poi un file locale si può MOSTRARE senza che nessuno navighi su
// `file://`: l'agente chiede il file, la pane va su `/api/media` di questo
// server (browser-local-file-url.ts). Cablato DOPO Bun.serve perché la porta va
// chiesta al server — con `PORT=0` quella in configurazione non esiste, e un
// URL con la porta sbagliata sarebbe di nuovo una pane bianca, solo più
// difficile da capire. Il permesso non è nuovo: è quello di `/api/media`.
// Senza una porta vera non si cabla niente: meglio il rifiuto di prima che un
// URL con la porta sbagliata, che sarebbe di nuovo una pane bianca.
if (typeof server.port === "number") {
  setLocalFileServing({
    isPathAllowed: (p: string) => ctx.isPathAllowed(p),
    resolveProjectPath: (p: string) => ctx.resolveProjectPath(p),
    exists: (p: string) => existsSync(p),
    // Lo schema segue `useTls`: qui il server è in TLS, e un `http://` verso
    // 3333 non risponde affatto (ERR_EMPTY_RESPONSE, cioè pane bianca).
    origin: `${useTls ? "https" : "http"}://127.0.0.1:${server.port}`,
  });
}

/**
 * L'ascoltatore del TUNNEL, se configurato.
 *
 * Legato a `127.0.0.1` perché il tunnel gira su questa macchina: non aggiunge
 * superficie di rete, aggiunge una PORTA con meno fiducia. Ciò che arriva qui
 * non è locale per definizione — anche se il peer è loopback — e questo chiude
 * il rovesciamento per cui un tunnel farebbe entrare Internet come proprietario.
 *
 * Il gestore è lo stesso: si marca la richiesta e si passa la palla, senza un
 * secondo percorso da tenere allineato.
 */
const portaTunnel = tunnelPort(process.env);
const serverTunnel = portaTunnel
  ? Bun.serve<WSData>({
      ...opzioniServer,
      port: portaTunnel,
      hostname: "127.0.0.1",
      fetch(req: Request, srv: typeof server) {
        markViaTunnel(req);
        // `.call(srv, …)`: il gestore dichiara `this: Server`, e chiamarlo come
        // metodo dell'oggetto opzioni glielo legherebbe all'oggetto sbagliato.
        // Il gestore avvolto, non quello nudo: chi entra da qui è remoto per
        // definizione, ed è proprio chi la compressione la deve avere.
        return fetchCompresso.call(srv, req, srv);
      },
    })
  : null;
if (serverTunnel) {
  console.log(`[Tunnel] porta dedicata su 127.0.0.1:${portaTunnel} — chi entra da qui NON e' locale`);
}

// Boot cleanup: a FINALIZED message (partial=0) must never carry a tool still
// marked 'running' — the client renders it as a spinner whose timer ticks
// forever (observed: a Shell tool "running" for 2h+ at session end). These are
// orphans from turns that died without finalizing their tools (a server restart
// clears the in-memory activeStreams, so the stale-stream sweeper can no longer
// reach them). Mark them interrupted and stamp endedAt so the duration freezes.
// Scoped to partial=0 so a mid-turn message being adopted (partial=1) is never
// touched. Idempotent — a clean boot finds nothing to fix.
function finalizeOrphanedRunningTools() {
  try {
    // Finestra temporale, non tutta la storia. Senza il `timestamp >=` questa
    // gira al boot come SCAN di una tabella da ~128 MB con quattro LIKE su
    // colonne JSON — 215 ms misurati a caldo — e su questo DB restituiva 17
    // righe che erano TUTTE falsi positivi: le stringhe `"status":"running"`
    // comparivano dentro l'OUTPUT di un tool (un log, un pezzo di JSON citato),
    // non in uno stato vero. Verificato incrociando con json_each su
    // `$.status` e `$.toolCall.status`: zero tool davvero in corso.
    //
    // 30 giorni perché è una bonifica di orfani da un riavvio: un tool rimasto
    // 'running' più vecchio di un mese non è un turno che qualcuno riprenderà,
    // e il suo timer non lo sta guardando nessuno. L'indice
    // idx_messages_timestamp (migration 074) rende il filtro una SEARCH.
    // WHERE usa solo l'indice timestamp (migration 074): LIKE su BLOB compresso
    // non funzionerebbe comunque. Il filtro sullo stato si fa in JS dopo decodeCol.
    // SI SCORRE, NON SI CARICA — ed è la differenza fra 148 MB e 2,6 GB.
    //
    // Questa `.all()` materializzava OGNI riga di trenta giorni prima di
    // guardarne una: misurato su questo DB, 8.354 righe per **706 MB** di
    // `content` + `tool_calls` + `blocks`, che `decodeCol` poi raddoppia
    // decomprimendo ognuna in una stringa UTF-16. Il footprint del server
    // saliva a **2,6 GB in diciotto secondi di boot** e ricadeva a 148 MB —
    // cioè il picco non era l'esercizio, era questa riga. Ed è il picco che
    // lascia dietro di sé le pagine swappate che il footprint non restituisce
    // più (vedi `server/lib/idle-gc.ts`): il costo non finisce col boot.
    //
    // `iterate()` tiene in RAM una riga per volta, e delle 8.354 ne sopravvive
    // una manciata — quelle che hanno davvero un tool in corso. Il picco
    // diventa proporzionale ai TROVATI, non al DB.
    //
    // Il filtro resta in JS, e non è una svista: la regex non buca il JSON
    // compresso con zstd (`shared/message-blob.ts`), quindi un `LIKE` in SQL su
    // quelle colonne non troverebbe niente. Ciò che cambia è dove si paga la
    // decompressione: una riga alla volta, e subito buttata.
    const rowIter = db.prepare(
      `SELECT id, session_key, content, tool_calls, blocks FROM messages
       WHERE timestamp >= date('now', '-30 days') AND partial = 0
         AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)`
    ).iterate() as Iterable<{ id: string; session_key: string | null; content: string | null; tool_calls: unknown; blocks: unknown }>;
    const RUNNING_RE = /"status":"(running|pending|waiting_for_input|awaiting_permission)"/;
    const rows: Array<{ id: string; session_key: string | null; content: string | null; tool_calls: unknown; blocks: unknown }> = [];
    for (const r of rowIter) {
      const tc = decodeCol(r.tool_calls) ?? "";
      const bl = decodeCol(r.blocks) ?? "";
      // Si trattiene SOLO ciò che verrà riscritto: le altre righe escono di
      // scope qui e il collettore se le riprende.
      if (RUNNING_RE.test(tc + bl)) rows.push(r);
    }
    if (rows.length === 0) return;
    const upd = db.prepare(`UPDATE messages SET content = ?, tool_calls = ?, blocks = ? WHERE id = ?`);
    const INTERRUPTED_MARKER = "⚠️ Turno interrotto prima di una risposta finale: la sessione si è chiusa mentre un tool era ancora in corso (probabile comando che non è terminato). Il tool interessato risulta in errore qui sotto — puoi rilanciarlo o riprendere da qui.";
    const now = Date.now();
    let msgs = 0, tools = 0;
    let spared = 0;
    for (const r of rows) {
      // Il figlio di questa sessione è ancora VIVO nel broker: quel tool può
      // ancora consegnare, e una DOMANDA a schermo può ancora essere risposta.
      // Bollarlo «interrotto» qui era il modo in cui una domanda viva diventava
      // un ⚠️ con il bottone Retry al primo hot-reload che perdeva il flag
      // `partial` (topic:ed2070df, 3 agosto). Chi è davvero morto lo dirà il
      // prossimo boot, quando il broker non lo elencherà più.
      const alive = !!r.session_key && liveBrokerChatSessions.has(r.session_key);
      if (alive) spared++;
      let changed = false;
      const tcDecoded = decodeCol(r.tool_calls);
      const blDecoded = decodeCol(r.blocks);
      let tcStr: string | Uint8Array | null = r.tool_calls as string | null;
      let blStr: string | Uint8Array | null = r.blocks as string | null;
      // The client renders tool state from `blocks` (the chronological timeline)
      // when present — so BOTH columns must be finalized, or the spinner keeps
      // ticking off the stale block copy even though tool_calls is fixed.
      try {
        if (tcDecoded) {
          const tcs = JSON.parse(tcDecoded) as Array<Record<string, unknown>>;
          let c = false; for (const tc of tcs) if (finalizeOrphanTool(tc, { childAlive: alive, now })) { c = true; tools++; }
          if (c) { tcStr = encodeCol(JSON.stringify(tcs)) ?? null; changed = true; }
        }
      } catch { /* skip malformed tool_calls */ }
      try {
        if (blDecoded) {
          const bl = JSON.parse(blDecoded) as Array<Record<string, unknown>>;
          let c = false;
          for (const b of bl) if (b && b.kind === "tool" && finalizeOrphanTool(b.toolCall as Record<string, unknown>, { childAlive: alive, now })) { c = true; tools++; }
          if (c) { blStr = encodeCol(JSON.stringify(bl)) ?? null; changed = true; }
        }
      } catch { /* skip malformed blocks */ }
      if (changed) {
        // If the interrupted turn produced no final prose, add an explanation
        // so the user sees a reason instead of a bare unexplained error X.
        const hasProse = typeof r.content === "string" && r.content.trim().length > 0;
        // Il cartello «turno interrotto» NON va su una sessione viva: lì
        // abbiamo chiuso solo un pannello di permesso, non il turno.
        const content = hasProse || alive ? r.content : INTERRUPTED_MARKER;
        upd.run(content, tcStr, blStr, r.id); msgs++;
      }
    }
    if (msgs > 0) console.log(`[boot] finalized ${tools} orphaned running tool(s) across ${msgs} message(s)`);
    if (spared > 0) console.log(`[boot] ${spared} message(s) with a live broker child: chiusi solo i permessi, il resto lasciato stare`);
    // Second pass: an assistant turn already finalized as interrupted (its tool
    // carries the "Interrotto" marker) but with no final prose renders as a bare
    // unexplained error X. Give it the explanation. Idempotent — once content is
    // set the row no longer matches. Uses decoded text — LIKE on compressed blobs
    // would not match.
    // Stessa forma, stesso rimedio: questa scorre le sole righe SENZA prosa,
    // che sono molte meno, ma legge comunque due colonne pesanti per ognuna.
    // Scorrerla costa quanto la riga più grande, non quanto la loro somma.
    const explainIter = db.prepare(
      `SELECT id, tool_calls, blocks FROM messages WHERE role = 'assistant'
         AND (content IS NULL OR trim(content) = '')
         AND timestamp >= date('now', '-30 days') AND partial = 0
         AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)`
    ).iterate() as Iterable<{ id: string; tool_calls: unknown; blocks: unknown }>;
    const INTERROTTO_RE = /Interrotto/;
    let explainCount = 0;
    const explainUpd = db.prepare(`UPDATE messages SET content = ? WHERE id = ?`);
    // Gli id da riscrivere si raccolgono PRIMA di scrivere: aggiornare la
    // stessa tabella che si sta scorrendo è un comportamento che SQLite non
    // definisce, e qui l'`UPDATE` tocca proprio la colonna del `WHERE`.
    const daSpiegare: string[] = [];
    for (const row of explainIter) {
      const tc = decodeCol(row.tool_calls) ?? "";
      const bl = decodeCol(row.blocks) ?? "";
      if (INTERROTTO_RE.test(tc + bl)) daSpiegare.push(row.id);
    }
    for (const id of daSpiegare) { explainUpd.run(INTERRUPTED_MARKER, id); explainCount++; }
    if (explainCount > 0) console.log(`[boot] added interruption explanation to ${explainCount} message(s)`);

    // TERZA PASSATA: I MUTI CON LA PROSA, che sono la maggioranza. Le due
    // sopra spiegano solo chi non aveva scritto NIENTE, e un turno d'agente
    // quasi sempre qualcosa lo scrive. Il giro e la sua ragione stanno in
    // `lib/verdetto-turno-interrotto.ts`, provati a parte.
    bonificaTurniMuti(db, INTERRUPTED_MARKER.replace(/^⚠️\s*/, ""));
  } catch (e) {
    console.warn(`[boot] finalizeOrphanedRunningTools failed:`, e);
  }
}
finalizeOrphanedRunningTools();

// Stale stream cleanup
const STALE_STREAM_CHECK_INTERVAL_MS = 30_000;
const STALE_STREAM_TIMEOUT_MS = 3 * 60 * 1000;
// One RESYNC per silent stream, not one reprieve. The sweeper's 3-min silence
// has two causes: a dead turn, and a turn we stopped HEARING (a broker
// attachment lost to a socket reconnect / a spawn acked without an attach — the
// child keeps working and the store keeps filling, we just get nothing).
// Declaring the second one dead is how a live turn ended as "nessuna attività
// per 3 minuti" while it was still running. So when the provider vouches the
// child is ALIVE we spend one round asking it to re-attach.
// This set records only that the ATTEMPT was spent. It is NOT a countdown to
// finalization: while `isTurnProcessAlive` keeps saying yes the sweeper keeps
// extending (see `staleStreamVerdict`). Bounding the reprieve is what killed
// 12-min builds and auto-compacts. The entry is dropped as soon as the stream
// leaves the map.
const staleStreamRescued = new Set<string>();
const staleStreamSilence = new Map<string, SilenceMark>();
const staleStreamTimer = setInterval(() => {
  // IL GIRO STA IN `stale-stream-sweep.ts`. Il verdetto puro era gia' uscito da
  // qui per essere provabile, ma il cablaggio no: il caso che conta — un figlio
  // VIVO al secondo tick muto, cioe' il turno che NON va finalizzato — vive
  // tutto nel cablaggio, e un test ci arrivava solo aspettando sette minuti
  // contro un server vero. Con le dipendenze iniettate due tick costano un
  // millisecondo.
  // THE PROBE GOES TO WHOEVER OWNS THE SESSION, not to claude-code.
  //
  // `tryGetProvider("claude-code")` stood here, and it is the defect that on
  // 2026-08-28 killed a live turn (topic:0299ac2d, inside a three-minute bash).
  // For a NATIVE session that provider reads its own `processes` map, does not
  // find it, and answers `false` instead of staying quiet: `staleStreamVerdict`
  // discards anything that is not `true`, so for every native turn "rescue" and
  // "extend" were unreachable and three minutes of silence were enough to close
  // it. The dispatcher had already been fixed with `resolveTurnAlive` (see
  // above); the sweeper, ten lines further down, had not.
  sweepStaleStreams({
    now: () => Date.now(),
    timeoutMs: STALE_STREAM_TIMEOUT_MS,
    askTtlMs: ASK_TTL_MS,
    activeStreams,
    rescued: staleStreamRescued,
    silence: staleStreamSilence,
    getMessageById,
    humanHoldAgeMs,
    childAlive: (sk) => childAliveForSweep(sk),
    // The delivery's own wait: the same predicate the stall detector reads, so
    // `update_task(status='review')` queued behind the checks is never "hung".
    waitingOnOurChecks: (sk) => isChecksHold(sk),
    resyncStream: (sk) => {
      // The rescue went to claude-code too: for somebody else's turn it was a
      // mute no-op, a recovery attempt that attempted nothing.
      const owner = resolveSessionOwner(sk) as
        | { resyncStream?: (sk: string) => Promise<boolean> }
        | null;
      owner?.resyncStream?.(sk)
        ?.catch((err) => console.warn(`[StaleStream] resync failed for ${sk}:`, err));
    },
    cancelAsk,
    updateStreamActivity: (sk) => ctx.updateStreamActivity(sk),
    getTopicId: (sk) => ctx.getTopicBySessionKey(sk)?.id,
    // The same door as the two watchdogs in routes/chat.ts, and to the OWNER
    // of the session: for a native turn `abort` is the only thing that reaches
    // the loop running inside this process.
    abortProvider: (sk) => {
      const owner = resolveSessionOwner(sk) as
        | { abort?: (sk: string, runId: string | undefined, reason: AbortReason) => Promise<void>; unregisterStreamHandler?: (sk: string) => void }
        | null;
      owner?.abort?.(sk, undefined, "watchdog")
        ?.catch((err) => console.warn(`[StaleStream] provider abort failed for ${sk}:`, err));
      owner?.unregisterStreamHandler?.(sk);
    },
    endStream: (sk) => ctx.endStream(sk),
    broadcast: (msg) => broadcastToAll(msg as Parameters<typeof broadcastToAll>[0]),
    finalizeMessage: ({ messageId, marker, interruption }) => {
      if (marker === null) db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE id = ?", [messageId]);
      else db.run("UPDATE messages SET partial = 0, streamed_at = NULL, content = ? WHERE id = ?", [marker, messageId]);
      // WHY the turn ended, on the row, in the shape the composer's banner
      // reads. Without it the reaper closed a turn cut mid-answer leaving the
      // reason in the server log only: the 2026-09-03 report, "stuck with no
      // feedback at all". `timelineWithInterruptedVerdict` refuses the rows
      // that must not be touched (empty timeline, already explained).
      try {
        const row = db.query("SELECT blocks FROM messages WHERE id = ?").get(messageId) as { blocks?: unknown } | undefined;
        const raw = decodeCol(row?.blocks);
        const parsed = raw ? (JSON.parse(raw) as ContentBlock[]) : null;
        const timeline = timelineWithInterruptedVerdict(parsed, interruption);
        if (timeline) db.run("UPDATE messages SET blocks = ? WHERE id = ?", [encodeCol(JSON.stringify(timeline)) ?? null, messageId]);
      } catch (err) {
        // A row we cannot read is a row we leave alone: the marker above
        // already said something, and rewriting a timeline we failed to parse
        // would throw away the turn for not understanding it.
        console.warn(`[StaleStream] verdetto non scritto su ${messageId}:`, err);
      }
    },
    recordTurnEnd: (sk) => recordTurnEnd(sk, cancelled("watchdog", "stale stream sweep")),
    warn: (msg) => console.warn(msg),
    info: (msg) => console.log(msg),
  });
}, STALE_STREAM_CHECK_INTERVAL_MS);

// Task auto-dispatch reconciliation: on boot, requeue any in-progress task whose
// agent turn died with the previous process; then poll to fill free slots on
// boards with auto_dispatch on (also the safety net if a →todo hook is missed).
// Con auto_dispatch OFF è il TICK a essere un no-op, non l'intera reconcile: il
// recupero degli orfani gira comunque, ed è voluto — una board spenta non
// reclama, ma deve poter liberare le sue card ferme (la riga qui diceva
// "reconcile() is a no-op", e ha mandato a caccia nel posto sbagliato chi
// cercava perché sette fantasmi `queued` non venissero mai recuperati).
const DISPATCH_POLL_MS = 10_000;
taskDispatcher.reconcile({ reason: "boot" }).catch((err) => console.error("[dispatcher] boot reconcile failed", err));
const dispatchTimer = setInterval(() => {
  // THE E2E BENCH CAN HOLD THIS ONE STEP, and nothing else can: the only writer
  // is a route mounted on a test server. See `lib/e2e-dispatch-hold.ts` for the
  // race it closes — a staged fake agent recovered mid-gesture.
  if (!dispatchReconcileHeld()) {
    taskDispatcher.reconcile({ reason: "poll" }).catch((err) => console.error("[dispatcher] poll reconcile failed", err));
  }
  // LA QUOTA DI CORE SI RILEGGE QUI, sullo stesso giro che fa nascere e morire
  // gli agenti — cioè l'unico momento in cui il denominatore («quanti stanno
  // compilando accanto a me») può essere cambiato. L'ambiente di un processo si
  // scrive una volta sola, allo spawn: senza questa riga un agente rimasto solo
  // su dodici core continuerebbe a compilare con la fetta di quando erano in
  // quattro, e il prezzo del recinto lo pagherebbe per niente.
  // Sta in server.ts e non dentro `reconcile()` per la stessa ragione di tutto
  // il resto del cablaggio: il dispatcher resta host-agnostico e testabile.
  try { refreshLiveJobQuotas(ctx.db); }
  catch (err) { console.error("[job-quota] rilettura viva fallita", err); }
  // LE FIGLIE MUOIONO COL PADRE, e qui è dove si scopre che è morto. La cascata
  // del bridge copre solo un padre TERMINALE; la sessione di un task è una chat,
  // e nessun frame `exit` la riguarda. Una spazzata sullo stesso giro che fa
  // nascere e morire gli agenti risponde alla domanda giusta — «il task ha
  // ancora un agente vivo?» — su OGNI strada di uscita, invece che su quelle
  // che ci siamo ricordati di agganciare.
  // Il padre però non è sempre un task: un sotto-agente aperto da una chat
  // qualunque non aveva NESSUNO addosso — non la cascata (che vuole un padre
  // terminale), non il parcheggio (`tryParkSession` rifiuta chi ha un
  // `parentSessionKey`), non questa spazzata (che faceva JOIN su `tasks`). Il
  // suo PTY sopravviveva all'archiviazione della chat per sempre.
  // `orphanChildSessions` chiede la stessa domanda alle due forme di padre.
  try {
    for (const id of orphanChildSessions(ctx.db)) retireTerminalSession(id);
  } catch (err) { console.error("[board] reap delle sessioni figlie fallito", err); }
}, DISPATCH_POLL_MS);

// Chat reload-resilience: adopt broker-surviving CHAT turns after a restart.
// A graceful shutdown/hot-reload DETACHES chat children into the ai-bridge
// daemon instead of killing them (claude-code stop()); this sweep re-adopts
// any that were MID-TURN (a partial assistant message exists) so the turn
// streams on as if nothing happened. Everything else alive in the daemon is
// REAPED: an idle child costs RAM forever and loses nothing when killed —
// the next sendChat respawns it with --resume on the same claude_session_id.
// Without the reap, detach-on-shutdown would leak one orphan child per chat
// per lifetime (observed: dispatch children from July 18-19 still alive).
// The dispatcher's reconcile above already REATTACHes the turns of
// in_progress board tasks — those sessionKeys are left strictly alone so two
// handlers never race over one child.
async function reattachSurvivingChatTurns(): Promise<void> {
  if (!aiBridgeEnabled()) return;
  const client = getAiBridgeClient();
  let sessions: Awaited<ReturnType<typeof client.list>>;
  try { sessions = await client.list(); } catch { return; } // no daemon → nothing survived
  const live = sessions.filter((s) => s.alive && s.id.startsWith("topic:"));
  if (live.length === 0) return;
  const dispatcherClaimed = new Set<string>();
  try {
    const rows = ctx.db.query(
      "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
    ).all() as Array<{ t: string }>;
    for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
  } catch (err) {
    console.warn("[chat-reattach] dispatcher claim query failed (skipping reap for safety):", err);
    return;
  }
  // Mid-turn signal captured BEFORE the startup partial-reset above wiped it.
  for (const s of live) {
    if (dispatcherClaimed.has(s.id)) continue; // the dispatcher's reconcile owns it
    const topic = ctx.getTopicBySessionKey(s.id);
    const adoptable = !!topic && !topic.archived;
    // Il DB dice «nessun turno»? Non basta per uccidere. `partial` è l'OMBRA
    // del turno, non il turno: si perde in tutti i modi (finalizzazioni,
    // riattacchi, la route della storia), e quando si perde su una sessione
    // ferma su una DOMANDA il reap ammazza la domanda — pannello vivo che
    // diventa un bottone Retry, osservato su topic:ed2070df. Lo store del
    // broker sa la verità: prima di uccidere, gliela si chiede.
    let brokerSays: "open" | "idle" | "unknown" = "unknown";
    if (adoptable && !midTurnAtBoot.has(s.id)) {
      try {
        const prov = tryGetProvider("claude-code") as { brokerTurnState?: (sk: string, opts?: { park?: boolean }) => Promise<"open" | "idle" | "unknown"> } | undefined;
        // `park: true` è la promessa che qui sotto manteniamo davvero: se la
        // risposta è «open» si riadotta, nella riga dopo. Senza, ogni sessione
        // si faceva spedire l'intero store DUE volte al boot — una per questa
        // sonda e una per la fase 1 della riadozione, tutte sull'unico socket
        // del ponte e tutte prima che l'utente veda qualcosa.
        brokerSays = (await prov?.brokerTurnState?.(s.id, { park: true })) ?? "unknown";
      } catch (err) {
        console.warn(`[chat-reattach] broker turn probe failed for ${s.id} (skipping reap for safety):`, err);
        brokerSays = "unknown";
      }
      if (brokerSays === "unknown") {
        // Nessuna prova di inattività: si lascia stare. Costa un figlio vivo
        // fino al prossimo boot, che è incomparabilmente meno di un turno vivo
        // ucciso per un dubbio.
        console.warn(`[chat-reattach] leaving ${s.id} alone: the broker could not tell whether a turn is in flight`);
        continue;
      }
    }
    if (adoptable && (midTurnAtBoot.has(s.id) || brokerSays === "open")) {
      const why = midTurnAtBoot.has(s.id) ? "partial in DB" : "store del broker aperto";
      console.log(`[chat-reattach] adopting surviving mid-turn broker session ${s.id} (${why})`);
      runHeadlessReattach(s.id, { timeoutMs: 30 * 60_000 })
        // Il turno adottato finisce comunque: se non è finito bene, il log dice
        // PERCHÉ invece di tacere (0.4).
        .then((end) => {
          if (end.end !== "end_turn") console.warn(`[chat-reattach] ${s.id}: ${describeTurnEnd(end)}`);
        })
        .catch((err) => console.warn(`[chat-reattach] ${s.id} failed:`, err?.message ?? err))
        .finally(async () => {
          // La gamba di riadozione è finita — ma il TURNO può non esserlo: un
          // figlio fermo su `ask_user_question` resta aperto per ore, e il
          // replay muto che ci riattacca dura un attimo. Azzerare `partial`
          // qui dentro chiudeva la riga di un turno vivo, e al riavvio dopo
          // `reuseOrCreatePartialForReattach` non aveva più niente da
          // riutilizzare: ne apriva una NUOVA. Su topic:ed2070df sono uscite
          // cinque copie dello stesso messaggio, una per ricarica del server,
          // ognuna con una durata da 100ms che non misurava niente.
          //
          // Quindi si richiede al broker: se il turno è ancora aperto la riga
          // resta com'è, ed è la stessa che il prossimo riattacco riprende.
          try {
            const prov = tryGetProvider("claude-code") as { brokerTurnState?: (sk: string) => Promise<"open" | "idle" | "unknown"> } | undefined;
            const state = await prov?.brokerTurnState?.(s.id).catch(() => "unknown" as const);
            if (state === "open") {
              // «Resta viva» va SCRITTA, non solo non-disfatta.
              //
              // Saltare la pulizia qui sotto non bastava: la riga era già stata
              // chiusa a monte. `finalizeStream` passa `partial: undefined` e la
              // UPDATE di `updateMessage` (server/utils.ts:330) scrive
              // `partial = $partial` SENZA COALESCE — quindi ogni gamba di
              // riadozione, anche quella che finisce su un turno ancora aperto,
              // lascia `partial` spento. E `reuseOrCreatePartialForReattach`
              // (utils.ts:1347) riusa la riga SOLO se è assistant con
              // `partial = 1`: al riavvio successivo non trovava niente da
              // riprendere e ne apriva una NUOVA. È il conto esatto del
              // 2026-08-18 su topic:9fe7a291 — dieci riadozioni, 1 riusata
              // («partial in DB») + 8 nuove («store del broker aperto») = nove
              // righe dove doveva essercene una. Lo stesso sintomo delle cinque
              // copie su topic:ed2070df che il commento qui sopra dice curato:
              // la guardia c'era, ma disarmava un flag che qualcun altro aveva
              // già spento.
              //
              // Il broker ha appena detto `open`: la riga è di un turno vivo, e
              // il flag si RIACCENDE. Solo l'ultima della sessione, che è quella
              // che il prossimo riattacco riprenderà.
              try {
                ctx.db.run(
                  "UPDATE messages SET partial = 1 WHERE id = (SELECT id FROM messages WHERE session_key = ? AND role = 'assistant' ORDER BY sort_order DESC LIMIT 1)",
                  [s.id],
                );
              } catch { /* al peggio il prossimo riattacco apre una riga nuova, com'era prima */ }
              console.log(`[chat-reattach] ${s.id}: la gamba è finita ma il turno è ancora aperto (domanda a schermo) — la riga resta viva`);
              return;
            }
          } catch { /* nessuna risposta dal broker: si pulisce, come prima */ }
          // IL TURNO È FINITO — MA SE È FINITO MALE VA DETTO.
          //
          // Questa riga spegneva `partial` in SILENZIO. Un turno completato non
          // ha niente da spiegare, ma qui ci arriva anche chi è MORTO col
          // riavvio: la riga si chiudeva a metà frase, senza cartello e senza
          // niente che la distinguesse da una risposta finita bene. Le due chat
          // segnalate il 20/08 («penso abbiano interrotto involontariamente»)
          // erano esattamente questo: nel log `reaping idle broker session`,
          // in chat nulla.
          //
          // Il cartello lo scrive `spiegaTurnoTroncato`, che riconosce da sé
          // chi ha davvero bisogno di una spiegazione — e non ne scrive due.
          try {
            const chiuse = ctx.db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1", [s.id]).changes;
            if (chiuse > 0) spiegaTurnoTroncato(ctx.db, s.id);
          } catch { /* next boot's reset catches it */ }
        });
      continue;
    }
    // Idle / archived / deleted-topic session: reap. Guard against a send
    // that raced in during boot and already owns the child.
    try {
      const prov = tryGetProvider("claude-code") as { isTurnProcessAlive?: (sk: string) => boolean } | undefined;
      if (prov?.isTurnProcessAlive?.(s.id)) continue; // adopted by a live turn — hands off
    } catch { /* provider not up yet — reap anyway, a turn can't be running */ }
    // Il motivo va scritto con le PROVE che l'hanno deciso: quando questo reap
    // si rivelerà di nuovo sbagliato, il log deve dire da quale delle due fonti
    // è arrivata la bugia, non solo che qualcuno è stato ucciso.
    const why = topic
      ? (topic.archived ? "archived topic" : `no in-flight turn (DB partial=no, broker=${brokerSays})`)
      : "topic gone";
    console.log(`[chat-reattach] reaping idle broker session ${s.id} (${why})`);
    try { client.kill(s.id); } catch { /* daemon hiccup — next boot retries */ }
  }
}
// Boot reconcile of ORPHANED "working" phases — the keystone of "no chat sits
// stuck spinning for an hour". A hard outage (a launchd bootout, a crash) kills
// the ai-bridge child MID-TURN; `claude_code_sessions.phase` stays frozen on a
// busy-spinner phase (starting/running/tool-running) that never returns to
// terminal, so the loading dots spin forever. The reaper DOES clear it — but a
// chat session has no PTY idle signal, so the running→dormant demote only fires
// after `abandonedTimeoutMs` (~60 min of frozen updatedAt): exactly the "fermo
// 1h55m" the user saw. This closes that window to ~0 by demoting, at boot, every
// busy-phase topic session the broker CONFIRMS has no live child.
//
// Load-bearing safety (mirrors the partial-sweep invariant above): we ONLY act
// on a CONFIRMED alive-set. If the broker list is unavailable after retries we
// do NOTHING — a genuinely long turn (a live child the daemon just hasn't
// answered for yet) must never be wrongly demoted; the 60-min reaper stays as
// the backstop. Dispatcher-claimed sessions (in_progress board tasks) are left
// to the dispatcher's own reconcile so the two never race over one session.
async function reconcileOrphanedBusyPhases(): Promise<void> {
  // 1) Authoritative alive-set (same retry/confirm contract as the partial sweep).
  let aliveSet = new Set<string>();
  let listConfirmed = false;
  if (aiBridgeEnabled()) {
    const client = getAiBridgeClient();
    for (let attempt = 0; attempt < 4 && !listConfirmed; attempt++) {
      try {
        await client.ensureConnected();
        const sessions = await client.list();
        aliveSet = new Set(sessions.filter((s) => s.alive && s.id.startsWith("topic:")).map((s) => s.id));
        listConfirmed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!listConfirmed) {
      console.warn("[busy-reconcile] broker list unavailable after retries — skipping (60-min reaper remains the backstop); refusing to demote possibly-live turns");
      return;
    }
  } else {
    listConfirmed = true; // no daemon → no live child possible → every busy phase is orphaned
  }

  // 2) Dispatcher-claimed sessions are owned by taskDispatcher.reconcile() — hands off.
  const dispatcherClaimed = new Set<string>();
  try {
    const rows = ctx.db.query(
      "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
    ).all() as Array<{ t: string }>;
    for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
  } catch (err) {
    console.warn("[busy-reconcile] dispatcher claim query failed — skipping for safety:", err);
    return;
  }

  // 3) Every non-archived topic session pinned on a busy-spinner phase.
  const placeholders = BUSY_SPINNER_PHASES.map(() => "?").join(",");
  let busyRows: Array<{ sk: string; csid: string | null; phase: string }> = [];
  try {
    busyRows = ctx.db.query(
      `SELECT s.session_key AS sk, s.claude_session_id AS csid, s.phase AS phase
       FROM claude_code_sessions s
       JOIN topics t ON t.session_key = s.session_key
       WHERE s.phase IN (${placeholders}) AND (t.archived IS NULL OR t.archived = 0)`,
    ).all(...BUSY_SPINNER_PHASES) as Array<{ sk: string; csid: string | null; phase: string }>;
  } catch (err) {
    console.warn("[busy-reconcile] busy-phase query failed:", err);
    return;
  }

  let demoted = 0;
  for (const row of busyRows) {
    if (aliveSet.has(row.sk)) continue;            // live child → real turn, leave it
    if (dispatcherClaimed.has(row.sk)) continue;   // dispatcher owns it
    if (!row.csid) continue;                       // can't address the tracker without a claude_session_id
    // Provably orphaned: demote phase→dormant (persists + broadcasts session:state,
    // stopping the spinner on every live client without a reload).
    const changed = claudeSessionTracker.noteDormant(row.csid);
    if (!changed) continue;
    demoted++;
    console.log(`[busy-reconcile] demoted orphaned ${row.phase} session ${row.sk} (csid ${row.csid.slice(0, 8)}) → dormant`);
    // Nudge any client still holding a local stream view (the server has no
    // in-RAM stream after a restart, so this is idempotent/harmless).
    const topicId = ctx.getTopicBySessionKey(row.sk)?.id;
    broadcastToAll({ type: "stream:end", sessionKey: row.sk, topicId, reason: "server_restart_reconcile" });
  }
  if (busyRows.length > 0) {
    console.log(`[busy-reconcile] scanned ${busyRows.length} busy-phase session(s), demoted ${demoted} orphaned (aliveSet ${aliveSet.size}, listConfirmed=${listConfirmed})`);
  }
}

// ── Orphaned-transcript reconcile — un-stick topics whose session can't resume ──
// A topic runs its Claude session in a cwd (its project, or a bound worktree);
// Claude stores the transcript under ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
// When a bound worktree is later reaped the topic degrades to its base project
// path (the FK nulls worktree_id) but its claude_code_sessions row still points
// at a claude_session_id whose transcript lived under the *worktree* dir — gone
// with the checkout. `--resume` in the base cwd then looks where the transcript
// ISN'T and fails; the topic sits frozen on its last turn (the "quadra" freeze).
// worktree-store.delete now forgets those sessions at reap time, but topics
// orphaned BEFORE that fix — or by any other path that moves a cwd out from under
// a session — still carry a doomed pointer. This boot sweep forgets any topic
// session whose transcript is missing at the cwd the provider will actually use,
// so its next turn spawns fresh in the base project (seeded with the DB history
// recap). Visible chat + any on-disk transcript are untouched.
const ORPHAN_TRANSCRIPT_GRACE_MS = 5 * 60 * 1000;
function reconcileOrphanedTranscripts(): void {
  // Never disturb a session a dispatched task is actively running.
  const dispatcherClaimed = new Set<string>();
  try {
    const rows = ctx.db
      .query(
        "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
      )
      .all() as Array<{ t: string }>;
    for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
  } catch (err) {
    console.warn("[orphan-transcript] dispatcher claim query failed — skipping for safety:", err);
    return;
  }

  let rows: Array<{ sk: string; csid: string | null; updated_at: string | null }> = [];
  try {
    rows = ctx.db
      .query(
        `SELECT s.session_key AS sk, s.claude_session_id AS csid, s.updated_at AS updated_at
         FROM claude_code_sessions s
         JOIN topics t ON t.session_key = s.session_key
         WHERE s.claude_session_id IS NOT NULL AND (t.archived IS NULL OR t.archived = 0)`,
      )
      .all() as Array<{ sk: string; csid: string | null; updated_at: string | null }>;
  } catch (err) {
    console.warn("[orphan-transcript] query failed:", err);
    return;
  }

  const now = Date.now();
  let forgotten = 0;
  for (const row of rows) {
    if (!row.csid) continue;
    if (dispatcherClaimed.has(row.sk)) continue;
    const topic = ctx.getTopicBySessionKey(row.sk);
    const cwd = ctx.resolveTopicCwd(topic);
    if (
      !isTranscriptOrphaned({
        cwd,
        claudeSessionId: row.csid,
        updatedAtMs: row.updated_at ? Date.parse(row.updated_at) : 0,
        nowMs: now,
        graceMs: ORPHAN_TRANSCRIPT_GRACE_MS,
        transcriptExists: existsSync,
      })
    )
      continue;
    // Provably unresumable: the transcript isn't where `--resume` will look.
    // Broadcast a terminal `session:state` (dormant) BEFORE deleting the row —
    // noteDormant reads the row from the DB, so it must run while it still
    // exists. This is what clears the PHANTOM in a long-lived client: `stream:end`
    // only quiets the in-chat streaming spinner (signals.ts); the sidebar/tab
    // phase (running / "your turn" fill) lives in the session-state map and is
    // cleared only by a fresh `session:state` or a re-bootstrap. Without this a
    // client that missed the terminating frame shows the topic "stuck working"
    // until it happens to reload — exactly the quadra symptom. dormant renders as
    // no-fill/no-spinner (idle), and the row is deleted right after so the next
    // bootstrap drops the session entirely and the next turn spawns fresh.
    claudeSessionTracker.noteDormant(row.csid);
    try {
      ctx.db.run("DELETE FROM claude_code_sessions WHERE session_key = ?", [row.sk]);
    } catch (err) {
      console.warn(`[orphan-transcript] failed to forget ${row.sk}:`, err);
      continue;
    }
    claudeSessionTracker.dropTerminalSession(row.csid); // drop the in-mem cache copy
    forgotten++;
    console.log(
      `[orphan-transcript] forgot unresumable session ${row.sk} (csid ${row.csid.slice(0, 8)}) — transcript gone at ${cwd}; next turn spawns fresh`,
    );
    // Nudge any client still holding a spinner/stream view (idempotent).
    broadcastToAll({ type: "stream:end", sessionKey: row.sk, topicId: topic?.id, reason: "orphan_transcript_reconcile" });
  }
  if (rows.length > 0) {
    console.log(`[orphan-transcript] scanned ${rows.length} topic session(s), forgot ${forgotten} unresumable`);
  }
}

// ── Archived-topic reconcile — le fasi che nessuna superficie può spegnere ──
// Il gemello di riparazione di `parkTopicSession` (lib/session-parking.ts): il
// parcheggio all'archiviazione tiene pulito da qui in avanti, ma le sessioni
// GIÀ trapelate non le ri-archivierà nessuno. Al 2026-08-09 erano 28 — 20 ferme
// su `awaiting-user`, ultima attività a metà luglio — servite dentro le 206 di
// `/api/claude-sessions` a ogni bootstrap del client.
//
// Diversamente dai due sweep qui sopra, questo NON consulta il broker: una fase
// viva su un topic archiviato è sbagliata comunque, anche se un figlio fosse
// vivo (nessuna superficie la mostra, nessun gesto la spegne). Resta però la
// stessa cortesia verso il dispatcher: un task in corso possiede la sua
// sessione, e un topic dei tentativi archiviato mentre il task lavora non va
// toccato sotto i piedi. `noteDormant` è soft — non uccide niente, e il primo
// hook o riga di transcript rianima.
function reconcileArchivedTopicSessions(): void {
  const dispatcherClaimed = new Set<string>();
  try {
    const rows = ctx.db.query(
      "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
    ).all() as Array<{ t: string }>;
    for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
  } catch (err) {
    console.warn("[archived-sessions] dispatcher claim query failed — skipping for safety:", err);
    return;
  }

  let rows: Array<{ sk: string; csid: string | null; phase: string }> = [];
  try {
    rows = ctx.db.query(
      `SELECT s.session_key AS sk, s.claude_session_id AS csid, s.phase AS phase
       FROM claude_code_sessions s
       JOIN topics t ON t.session_key = s.session_key
       WHERE t.archived = 1 AND s.phase NOT IN ('dormant', 'completed', 'error')`,
    ).all() as Array<{ sk: string; csid: string | null; phase: string }>;
  } catch (err) {
    console.warn("[archived-sessions] query failed:", err);
    return;
  }

  let parked = 0;
  for (const row of rows) {
    if (!row.csid) continue;
    if (dispatcherClaimed.has(row.sk)) continue;
    if (claudeSessionTracker.noteDormant(row.csid)) parked += 1;
  }
  if (rows.length > 0) {
    console.log(`[archived-sessions] ${rows.length} sessione/i viva/e su topic archiviati, ${parked} parcheggiata/e → dormant`);
  }
}

// ── IL TURNO CHE NASCE DA SOLO ────────────────────────────────────────────
//
// Un `Monitor` armato dall'agente («avvisami quando il build finisce») consegna
// il suo evento aprendo un TURNO NUOVO: la CLI risveglia il figlio da sola e
// produce una risposta vera, senza che nessuno abbia scritto niente. Misurato il
// 20/08/2026 (CLI 2.1.237, stessa argv di Topics) — la traccia sta accanto a
// `onWokenTurn` in providers/claude-code.ts.
//
// Fino a qui quella risposta si perdeva: nasce dopo un `result`, e dopo un
// `result` nessuno ascolta più quella sessione. Il tool funzionava, la sua
// risposta era invisibile — ed è per questo che il Monitor sembrava «perso».
//
// La cura riusa la macchina che già esiste. Un turno risvegliato è, per tutto
// ciò che viene dopo, identico a uno riadottato dopo un riavvio: nessun
// messaggio da mandare, una riga da riempire, uno stream da finalizzare. Quindi
// si passa dalla STESSA route, con `mode: "woken"`, e non da una seconda copia
// della finalizzazione.
//
// Fire-and-forget con la sua rete: se l'adozione fallisce (il turno è finito
// mentre aprivamo la riga, o l'utente ha scritto e ha vinto lui) il log lo dice
// e la sessione resta esattamente com'era.
function adottaTurniRisvegliati(): void {
  // Si arma sulla CLASSE, non su un'istanza. Al boot `claude-code` non è ancora
  // registrato — `initProvider` lancia `initProviders()` fire-and-forget, ed è
  // quella a sondare il PATH e a registrarlo — quindi un `tryGetProvider` qui
  // troverebbe `undefined` e uscirebbe zitto: la sveglia sarebbe cablata e mai
  // collegata. Vedi `ClaudeCodeProvider.observeWokenTurns`.
  ClaudeCodeProvider.observeWokenTurns((sessionKey, label) => {
    const topic = ctx.getTopicBySessionKey(sessionKey);
    if (!topic || topic.archived) {
      // Nessuna chat dove metterlo: adottarlo vorrebbe dire scrivere una riga
      // in un posto che l'utente non ha. Si lascia cadere, come prima.
      console.log(`[woken] ${sessionKey}: turno spontaneo su una topic assente o archiviata — lasciato cadere`);
      return;
    }
    console.log(`[woken] ${sessionKey}: la CLI ha aperto un turno da sola (Monitor o simile) — lo adotto`);
    // L'ATTESA È FINITA, e va detto PRIMA di guidare il turno.
    //
    // `monitorArmed` è ciò che tiene la sessione in `watching` attraverso lo
    // `Stop` di fine turno (vedi `applyHook`): serviva a non far sembrare
    // inattiva una chat che stava sorvegliando un build. Adesso il Monitor ha
    // consegnato, quindi la sorveglianza è chiusa — e se il flag restasse
    // acceso, lo `Stop` di QUESTO turno rimetterebbe la chat in `watching` con
    // nessuno che guarda più niente: una spia accesa per sempre, che è peggio
    // di una spia che non si accende mai.
    try { claudeSessionTracker.noteWatchDelivered(sessionKey); }
    catch (err) { console.warn(`[woken] ${sessionKey}: attesa non disarmata:`, err); }
    void runHeadlessWoken(sessionKey, label)
      .then((end) => {
        if (end.end !== "end_turn") console.warn(`[woken] ${sessionKey}: ${describeTurnEnd(end)}`);
      })
      .catch((err) => console.warn(`[woken] ${sessionKey} non adottato:`, err?.message ?? err));
  });
}
adottaTurniRisvegliati();

// Chain reconcile AFTER reattach: reattach adopts survivors (keeps their broker
// child alive → they stay in the alive-set → reconcile skips them) and reaps
// idle children (so reconcile's fresh list sees them dead → demotes their
// phantom phase). Running it after avoids a race where a just-reaped session is
// still listed alive. The orphaned-transcript sweep runs last: reattach has by
// then re-homed every survivor, so a missing transcript is proof of a dead cwd.
// In coda `riprendiTurniInterrotti`: rimanda i turni uccisi dal riavvio che
// nessuno riadotterà (`lib/ripresa-boot.ts`).
reattachSurvivingChatTurns()
  .then(() => reconcileOrphanedBusyPhases())
  .then(() => reconcileOrphanedTranscripts())
  .then(() => reconcileArchivedTopicSessions())
  .then(() => riprendiTurniInterrotti(ctx, topicsRouter))
  .catch((err) => console.error("[chat-reattach] boot sweep failed", err))
  .finally(() => scheduleResumeSweep());

// NOT ONLY AT BOOT. A turn cut by the watchdog, a stall or a provider error
// while the server keeps running was never resumed until the next boot: on
// 2026-09-04 the person had to write "riprendi" by hand. The same sweep runs
// every five minutes; a resumed row carries its `ripreso` marker and a new
// answer after it, so a sweep never resends twice. Chained, not on an
// interval: one sweep can wait up to fifteen minutes on a stream.
const RESUME_SWEEP_MS = 5 * 60_000;
function scheduleResumeSweep(): void {
  const t = setTimeout(() => {
    // The plan's usage window is spent: a resend now would end on the same
    // 429 and spend one of the chain's attempts for nothing. The sweep after
    // the reset picks the same rows up.
    const hold = providerHold();
    if (hold) {
      console.log(`[ripresa] sweep rinviato: ${hold.reason}, riparte alle ${holdUntilLabel(hold)}`);
      scheduleResumeSweep();
      return;
    }
    riprendiTurniInterrotti(ctx, topicsRouter)
      .catch((err) => console.error("[ripresa] periodic sweep failed", err))
      .finally(() => scheduleResumeSweep());
  }, RESUME_SWEEP_MS);
  t.unref?.();
}

// The hold is news for every open chat: the banner says why nothing moves and
// until when, instead of a spinner and 27 silent retries.
onProviderHold((hold) => {
  broadcastToAll(hold
    ? { type: "provider:hold", untilMs: hold.untilMs, window: hold.window, reason: hold.reason, sinceMs: hold.sinceMs }
    : { type: "provider:hold", untilMs: null, window: null, reason: null, sinceMs: null });
});

// ── Worktree GC — origin fix for worktree pile-up ──────────────────────────
// La decisione sta in `server/services/worktree-gc.ts` (`sweepWorktrees`), il
// cablaggio in `server/services/worktree-gc-runner.ts`. Qui resta solo l'AVVIO:
// il primo giro dopo il boot e la scopa periodica. Il runner si costruisce piu'
// in alto, prima dei tre punti che lo usano, cosi' non si regge piu'
// sull'hoisting di una `function` dichiarata in fondo al file.
const worktreeGcBoot = setTimeout(() => { void worktreeGc.runWorktreeGc(); }, worktreeGc.bootDelayMs);
const worktreeGcTimer = setInterval(() => { void worktreeGc.runWorktreeGc(); }, worktreeGc.intervalMs);

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

// `requestIP` vive sull'istanza del server, che nasce dopo il contesto: si
// aggancia qui, cosi' le rotte che devono distinguere loopback da remoto
// (l'appaiamento) non ricevono il server intero.
// L'indirizzo VERO di chi chiede. Attraverso il tunnel il peer e' sempre
// loopback, quindi il tetto per-indirizzo sull'appaiamento diventerebbe un
// tetto per l'intero Internet: tre richieste in tutto.
// ── Il RELAY: questa macchina chiama fuori, e nessuno chiama lei.
//
// Spento per default. Con `TOPICS_RELAY_URL` si collega in uscita e resta in
// ascolto di ospiti arrivati da un link; senza, non succede niente e l'app
// locale e' identica a prima — il relay e' un di piu', mai la strada del
// lavoro.
//
// Il link e' una CAPACITA' su una cosa sola: qui non si proietta nessuna
// sessione e nessun ruolo. Chi arriva non diventa nessuno.
//
// ── E IL RELAY È LA COSA CHE SI PAGA ────────────────────────────────────────
// Il confine del listino è quello di ORG-08: gratis tutto il locale e tutta la
// rete di casa, per sempre e senza account; si paga l'essere trovati da
// un'ALTRA rete. Quindi il cancello sta QUI e in nessun altro punto — la
// domanda «questa installazione ha un relay?» ha già un solo lettore, e
// `/api/auth/relay` e la POST che conia i link passano entrambe di lì. Metterne
// una seconda copia nelle rotte vorrebbe dire due risposte alla stessa
// domanda, che è il modo in cui un interruttore finisce per nascondere un
// gesto senza toglierlo.
//
// Cade verso il locale per costruzione: senza licenza `baseUrl` è `null`, cioè
// esattamente lo stato «relay non configurato» che l'app sa già gestire da
// sempre, e non uno stato d'errore nuovo.
const relayCfg = await leggiRelayConfig(process.env, ctx.STATE_DIR);
const relay = creaRelayClient({
  baseUrl: relayCfg.baseUrl,
  // Il NOME del punto d'incontro, che è il digest del segreto qui sotto. Non è
  // `installationId`: quello resta legato alla licenza e non compare in nessun
  // link. Vedi `shared/relay-identita.ts` per il motivo per cui erano lo stesso
  // valore e non potevano restarlo.
  relayId: relayCfg.relayId,
  segreto: leggiRelaySegreto(ctx.STATE_DIR),
  // Dove si rigioca ciò che arriva dal relay. `null` — cioè
  // `TOPICS_TUNNEL_PORT` non impostata, che è il caso di default — fa rifiutare
  // in modo dichiarato: senza l'ascoltatore dedicato l'unica porta a cui
  // rigiocare sarebbe quella principale, dove ogni richiesta è LOCALE, cioè
  // proprietaria senza credenziali.
  portaTunnel: portaTunnel,
  // L'ascoltatore del tunnel spande `opzioniServer`: se il server principale
  // ha i certificati, anche quella porta parla TLS.
  tunnelTls: useTls,
  // Il certificato su loopback è AUTOFIRMATO, e `fetch` lo rifiuterebbe. Qui
  // saltare la verifica non toglie niente: il capo dall'altra parte è questo
  // stesso processo su `127.0.0.1`, il traffico non lascia il kernel, e ciò
  // contro cui la verifica protegge — qualcuno in mezzo — su loopback non
  // esiste. Sta cablato QUI, sul solo salto locale, invece che dentro il
  // proxy: una deroga scritta accanto alla ragione non diventa un'abitudine
  // che poi qualcuno ricopia dove conta.
  ...(useTls ? {
    fetchLocale: ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input as never, { ...init, tls: { rejectUnauthorized: false } } as never)) as typeof fetch,
  } : {}),
  trovaLink: (ref) => {
    try {
      const r = ctx.db.query(
        "SELECT ref, key, resource_type, resource_id, expires_at, revoked_at FROM share_links WHERE ref = ?",
      ).get(ref) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        ref: String(r.ref), key: String(r.key),
        resourceType: r.resource_type === "topic" ? "topic" : "task",
        resourceId: String(r.resource_id),
        expiresAt: Number(r.expires_at),
        revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
      };
    } catch { return null; }
  },
  serviRisorsa: async (l) => {
    // La stessa strada dei dati locali: qui non si duplica nessuna regola.
    const riga = l.resourceType === "task"
      ? ctx.db.query("SELECT id, text, status, project_id FROM tasks WHERE id = ?").get(l.resourceId)
      : ctx.db.query("SELECT id, name, updated_at FROM topics WHERE id = ?").get(l.resourceId);
    if (!riga) return { status: 404, body: { error: "non disponibile" } };
    return { status: 200, body: riga };
  },
  segnaApertura: (ref) => {
    try {
      ctx.db.query("UPDATE share_links SET opened_count = opened_count + 1, last_opened_at = ? WHERE ref = ?")
        .run(Date.now(), ref);
    } catch { /* non deve mai far fallire una consegna */ }
  },
  log: (m) => console.log(m),
});
ctx.relayConfig = () => ({
  baseUrl: baseUrlConcesso(relayCfg.baseUrl, licenzaSvc.stato()),
  installationId: relayCfg.installationId,
  relayId: relayCfg.relayId,
});
ctx.relayConnected = () => relay.collegato();

// Si accende e si spegne da solo: la logica delle transizioni sta in
// `creaInterruttoreLicenza`, dove è provata. Sessanta secondi sono la
// granularità giusta per le due cose che accadono senza che nessuno chiami
// niente — una licenza installata mentre il server è su, e una che scade.
const interruttoreRelay = creaInterruttoreLicenza({
  disponibile: () => !!relayCfg.baseUrl,
  stato: () => licenzaSvc.stato(),
  richiesta: { tipo: "accesso_remoto" },
  avvia: () => relay.avvia(),
  ferma: () => relay.ferma(),
});
interruttoreRelay.riconcilia();
const relayLicenzaTimer = setInterval(() => interruttoreRelay.riconcilia(), 60_000);

ctx.requestIp = (req: Request) =>
  clientIpOf(req, (serverTunnel?.requestIP(req) ?? server.requestIP(req))?.address ?? null);

const proto = useTls ? "https" : "http";
const wsProto = useTls ? "wss" : "ws";
console.log(`🚀 Topics App running at ${proto}://localhost:${PORT}`);
console.log(`📡 WebSocket available at ${wsProto}://localhost:${PORT}/ws`);
if (useTls) console.log(`🔒 TLS enabled (cert: ${tlsCert})`);
console.log(`🌐 BrowserService available (lazy Chromium, WebSocket at /ws/browser/:id)`);

// Phase B · DAEMON-01: finalise state file once Bun.serve owns a port.
// `server.port` reflects the *actual* port (Bun resolves 0 → ephemeral).
const daemonState = writeState(server.port ?? PORT);
console.log(`[Daemon] state written → pid=${daemonState.pid} port=${daemonState.port}`);

// CHI RISPONDE DAVVERO SULLA NOSTRA PORTA.
//
// Il 2026-08-20 un server di un altro progetto, avviato a mano con PORT=3333,
// si era legato a `127.0.0.1:3333` mentre noi ascoltiamo su `*:3333` (IPv6).
// Il kernel consegna al binding piu' SPECIFICO, quindi ogni connessione
// dell'app finiva a lui: la porta rispondeva 200 con l'HTML di un altro
// progetto e in HTTPS moriva con `tlsv1 alert protocol version`. Per NOVE ORE,
// e il sintomo a schermo era «ci mette un sacco a connettersi» piu' una
// finestra che non si aggiornava piu'.
//
// Il lock singleton non poteva prenderlo: protegge da un secondo TOPICS, e
// quel processo non era Topics. `reusePort: false` nemmeno: non c'era
// collisione da rifiutare, perche' i due binding sono legittimi e coesistono.
//
// La sonda chiede alla propria porta se chi risponde siamo noi, e se non lo
// siamo lo DICE col pid e col comando. Non uccide niente: quel processo e' di
// qualcun altro. Vedi `server/lib/port-squatter.ts`.
setTimeout(() => {
  const porta = server.port ?? PORT;
  void sondaPorta(porta, sondaRealeDeps(process.pid))
    .then((esito) => { const msg = messaggioEsito(porta, esito); if (msg) console.warn(msg); })
    .catch(() => { /* una sonda che fallisce non deve disturbare il boot */ });
}, 2000).unref?.();

// Phase 30 BROWSER-CHAT-01 — restore browser contexts in background.
// Fire-and-forget: never blocks server startup. Errors are logged but
// never thrown (matches restoreAllContexts contract).
browserService.restoreAllContexts(Object.values(ctx.loadTopics().topics))
  .then(r => console.log(`[server] browser restore: ${r.restored} restored, ${r.failed} failed`))
  .catch(err => console.warn(`[server] browser restore failed (non-fatal):`, err.message));

// Sessioni orfane: censimento e PARCHEGGIO (task `90762124`).
//
// Esistono sessioni claude-code vive che nessuna struttura di `ui_state`
// referenzia — né il pane store, né un layout di progetto, né le pane di
// progetto, né una tab standalone. Nessuna finestra le mostra, quindi non
// esiste un gesto umano per chiuderle: restano finché non le si cancella a mano
// o non si riavvia il server, e nel frattempo consumano.
//
// Il censimento ha girato in SOLA LETTURA prima di poter agire, ed era il punto:
// «non referenziata» attraversa quattro strutture, e un falso positivo spegne
// una sessione che qualcuno stava usando. Sessantotto giri fra il 04/08 e il
// 10/08 non hanno mai nominato una sessione. Prova pulita, ma sottile: il roster
// non ha mai avuto più di UNA sessione viva alla volta, quindi la scarsità dei
// falsi positivi dice poco. Per questo l'azione non si fida di un censimento
// solo — vedi `lib/orphan-park-policy.ts`, che pretende DUE avvistamenti
// consecutivi e si rifiuta di agire se `ui_state` non ha restituito righe.
//
// E l'azione è il PARCHEGGIO, non la cancellazione: muore la PTY, la riga resta
// `dormant`, `--resume` la riporta dov'era con lo scrollback. Un falso positivo
// su un parcheggio costa un click, su una `DELETE` costa una conversazione.
// `parkOrphanSessions` passa poi dagli stessi cancelli del giro di inattività
// (`decidePark`): «orfana» non sa niente di un turno in corso.
//
// Il ritardo serve, e 90 secondi NON bastavano: le sessioni di terminale non
// vengono ripristinate all'avvio, ma quando un client si attacca. Misurato il
// 04/08 sul server vivo, il primo giro riportava «0 sessioni esaminate» — vero
// e inutile. A quindici minuti l'app ha attaccato le sue pane e il censimento
// guarda qualcosa. Poi ogni sei ore: è anche la distanza fra i due avvistamenti
// che servono per parcheggiare, cioè un'orfana vera muore dopo mezza giornata di
// conferme e una pane appena creata non rischia niente.
const ORPHAN_CENSUS_DELAY_MS = 15 * 60_000;
const ORPHAN_CENSUS_EVERY_MS = 6 * 60 * 60_000;
// Quanto dev'essere muta la PTY. Non è ridondante con «nessuna interfaccia la
// mostra»: il registro delle pane non sa se la sessione sta scrivendo ADESSO.
const ORPHAN_PARK_IDLE_MS = 30 * 60_000;
// Acceso di serie, spegnibile con `TOPICS_ORPHAN_PARK=0`. Al contrario del
// parcheggio per inattività — spento di default perché una sessione parcheggiata
// mostra «Sessione scaduta» finché la sua pane non la rianima — qui quella
// ragione non esiste: un'orfana non ha una pane che possa mostrare alcunché.
const ORPHAN_PARK_ENABLED = (process.env.TOPICS_ORPHAN_PARK ?? "1").trim() !== "0";
// La catena vive in `services/orphan-census.ts` (dove un test la monta identica
// a questa); qui restano solo le dipendenze vere e i timer.
const orphanCensusRunner = createOrphanCensusRunner({
  listSessions: () => listTerminalSessionSnapshot(),
  listUiStateValues: () =>
    (ctx.db.query("SELECT value FROM ui_state").all() as Array<{ value?: string }>)
      .map((row) => row.value ?? "")
      .filter(Boolean),
  park: (ids) => { parkOrphanSessions(ids, ORPHAN_PARK_IDLE_MS); },
  enabled: ORPHAN_PARK_ENABLED,
});
function runOrphanCensus(): void {
  try {
    orphanCensusRunner();
  } catch (err) {
    // Un censimento che non riesce non deve mai essere un problema del server:
    // non serve a farlo funzionare, serve a farci sapere una cosa. E un giro
    // fallito non lascia conferme: la memoria del giro precedente resta com'era,
    // quindi mezza lettura non può diventare un permesso.
    console.warn("[orphan-census] salto questo giro:", (err as Error).message);
  }
}
setTimeout(() => {
  runOrphanCensus();
  setInterval(runOrphanCensus, ORPHAN_CENSUS_EVERY_MS).unref?.();
}, ORPHAN_CENSUS_DELAY_MS).unref?.();

// Quiescence gate: a PLANNED restart (approve self-restart, or an explicit
// restart-when-idle request) must not cut an agent mid-turn. Poll the
// dispatcher's in-flight count until it drains, capped so a stuck/very long
// turn can't wedge the restart forever — past the cap we proceed and the
// reload-resilience path resumes whatever was still running. Only for
// CONTROLLED restarts; raw SIGTERM/SIGINT (OS shutdown) stay fast.
//
// IL TETTO STA SOPRA LA DURATA DI UN TURNO, NON SOTTO.
//
// Un turno d'agente ha gia' un limite suo — `dispatchTimeoutMin`, 20 minuti di
// default (`tasks.ts`) — oltre il quale e' il dispatcher a chiuderlo. Questo cap
// serve SOLO contro un turno che ha sfondato anche quello, quindi deve stargli
// sopra. A cinque minuti stava sotto, e il cancello scritto per non tagliare i
// turni li tagliava quasi sempre: misurato il 19/08, salvato un file di
// `server/` con quattro agenti `working`, cinque minuti dopo tutti e quattro
// «Il server e' ripartito mentre l'agent lavorava: task rimesso in coda».
//
// Il tentativo non si perde (viene fatto il rollback) e nemmeno il lavoro gia'
// committato sul ramo. Si perde il turno: quello che l'agente stava scrivendo,
// e il tempo. Con venticinque minuti un turno sano arriva in fondo da solo, che
// e' l'unico esito in cui questo cancello ha fatto il suo mestiere.
//
// La stessa variabile la legge `scripts/start-prod.sh` per la propria finestra
// d'attesa: erano due numeri in due file che dovevano dire la stessa cosa.
/** L'attesa quando a lavorare e' solo una CHAT (nessuna card in volo). Corta di
 *  proposito: una chat la reload-resilience la riadotta, e con l'attesa lunga il
 *  hot-reload non scatterebbe mai mentre si sviluppa. */
const QUIESCENCE_CHAT_CAP_MS = Math.max(10_000, Number(process.env.TOPICS_QUIESCENCE_CHAT_CAP_MS) || 60_000);

const QUIESCENCE_CAP_MS = Math.max(60_000, Number(process.env.TOPICS_QUIESCENCE_CAP_MS) || 25 * 60_000);
/** Il broker si interroga a questa cadenza, non a ogni giro da 500ms: la sonda
 *  legge la coda dello store di OGNI sessione viva, e a 2Hz sarebbe un costo
 *  pagato per un'informazione che cambia di rado. */
const QUIESCENCE_BROKER_PROBE_MS = 5_000;

/**
 * Le sessioni di chat il cui TURNO è ancora aperto secondo il broker.
 *
 * È l'unico oracolo che vede un turno ADOTTATO. Dopo un riavvio la gamba di
 * riadozione (`runHeadlessReattach`) dura un attimo — è un replay muto — e
 * quando si chiude `endStream` toglie la voce da `activeStreams`. Da quel
 * momento, in QUESTO processo, non esiste più niente che rappresenti il figlio
 * CLI che sta ancora lavorando: `busyCount()` e `activeStreams` dicono «fermo»,
 * e lo dicono con verità. Solo lo store del broker sa che il figlio è vivo.
 *
 * Direzione del fallimento: se il broker non risponde si torna una lista VUOTA,
 * cioè non si trattiene il riavvio. È il verso opposto a quello del reap in
 * `reattachSurvivingChatTurns` — là il dubbio salvava un turno dall'essere
 * ucciso, qui il dubbio costerebbe un cancello che si inchioda su ogni riavvio
 * per un ponte rotto. Un SIGTERM, a differenza di un kill, il turno non lo
 * ammazza: il figlio sopravvive e viene riadottato.
 */
async function openBrokerChatTurns(): Promise<string[]> {
  if (!aiBridgeEnabled()) return [];
  try {
    const sessions = await getAiBridgeClient().list();
    const live = sessions.filter((s) => s.alive && s.id.startsWith("topic:"));
    if (live.length === 0) return [];
    const prov = tryGetProvider("claude-code") as
      { brokerTurnState?: (sk: string) => Promise<"open" | "idle" | "unknown"> } | undefined;
    if (typeof prov?.brokerTurnState !== "function") return [];
    const open: string[] = [];
    for (const s of live) {
      // Niente `park: true`: quel flag è la promessa di riadottare subito, e qui
      // stiamo solo guardando.
      try { if (await prov.brokerTurnState(s.id) === "open") open.push(s.id); }
      catch { /* una sessione che non risponde non trattiene il riavvio */ }
    }
    return open;
  } catch { return []; }
}

let brokerProbeCache: { at: number; open: string[] } = { at: 0, open: [] };

let askProbeCache: { at: number; parked: string[] } = { at: 0, parked: [] };

/**
 * Che cosa sta ancora lavorando — e perché il riavvio aspetta. `null` = niente.
 *
 * Il cancello guardava UN contatore solo: `taskDispatcher.busyCount()`, cioè
 * `inFlight.size`, una mappa chiavata sul taskId e scritta solo da `beginRun`
 * sul cammino di dispatch di una CARD. Una chat umana non è una card: non può
 * entrarci per costruzione, e infatti non ci entrava. Il 2026-08-18 il server
 * si è riavviato ~1,4 volte al minuto sopra un turno di chat vivo da quattordici
 * minuti senza che una sola riga `[quiescence]` comparisse nel log — il predicato
 * non era mai nemmeno entrato nel `while`. Il nome della rotta prometteva
 * «quando i turni finiscono»; manteneva «quando finiscono i turni della board».
 *
 * Ora le fonti sono tre, in ordine di costo: le card (contatore in RAM), le chat
 * che stanno streammando in QUESTO processo (`activeStreams`), e i turni
 * adottati che vivono solo nel broker. Le prime due sono gratis e si guardano a
 * ogni giro; la terza si paga, e si guarda ogni QUIESCENCE_BROKER_PROBE_MS.
 */
async function whatIsStillWorking(): Promise<{ busy: string | null; cards: number; unadoptable: number; parkedAsks: number; holder: string | null; holderKind: "turn" | "question" }> {
  // A land in flight is a card turn for this purpose: it rewrites main and
  // the card, and a restart in the middle of it forgets the delivery branch.
  const cards = taskDispatcher.busyCount() + landingQueue.inFlight();
  const streamKeys = [...activeStreams.keys()];
  // La sonda del broker si paga, e si paga solo quando serve: se una fonte più
  // economica ha già detto «occupato», la risposta non cambia.
  let brokerOpen = brokerProbeCache.open;
  if (cards === 0 && streamKeys.length === 0) {
    const now = Date.now();
    if (now - brokerProbeCache.at >= QUIESCENCE_BROKER_PROBE_MS) {
      brokerProbeCache = { at: now, open: await openBrokerChatTurns() };
    }
    brokerOpen = brokerProbeCache.open;
  }
  // QUALI DI QUESTE CHAT NON TORNANO PIÙ, se le tagliamo adesso.
  //
  // L'attesa corta riservata alle chat vale una promessa: «la reload-resilience
  // la riadotta». Quella promessa la mantiene solo un provider il cui turno vive
  // in un processo FIGLIO, che il SIGTERM non tocca e il broker ritrova. Il
  // runtime nativo `topics` esegue il turno dentro questo processo: quando muore,
  // muore il turno.
  //
  // La risposta è già sulla voce dello stream (`survivesRestart`, decisa quando
  // il turno è nato): qui si conta e basta, senza toccare il DB né il registro
  // dei provider — questo giro batte due volte al secondo.
  // CHI trattiene, non solo QUANTI. Serve per nominare la chat nella notifica
  // che il cancello manda oltre il tetto: un avviso che dice «una chat» manda a
  // cercare, uno che dice quale porta dove si decide (il click apre il topic).
  // Le non riadottabili per prime: sono quelle il cui lavoro non torna.
  const unadoptableKeys = unadoptableStreams(activeStreams.values());
  const unadoptable = unadoptableKeys.length;
  // THE FOURTH SOURCE: whoever is waiting for a PERSON. The three above answer
  // "who is WORKING", and a chat parked on a question is not working, so it
  // held nothing and the restart cut it (why it deserves the deferral most:
  // see `parked-asks.ts`). Same economy as the broker probe: it reads rows, so
  // it is paid at the probe cadence, and not at all when a card is in flight
  // - there the verdict is already a deferral, and a STALE list must not
  // decide, since a question answered meanwhile would defer for nobody.
  let parked: string[] = [];
  if (cards === 0) {
    const now = Date.now();
    if (now - askProbeCache.at >= QUIESCENCE_BROKER_PROBE_MS) {
      askProbeCache = { at: now, parked: chatsParkedOnQuestion(ctx.db, decodeCol, { now, ttlMs: ASK_TTL_MS, fastPathKeys: pendingAskKeys() }) };
    }
    parked = askProbeCache.parked;
  }
  return {
    busy: describeInFlight({ cards, streamKeys, brokerOpenKeys: brokerOpen, askOpenKeys: parked }),
    cards,
    unadoptable,
    parkedAsks: parked.length,
    // STESSA PRIORITA' di `describeInFlight`, o la notifica nomina un soggetto
    // che non e' quello che trattiene: quando a trattenere e' una card la frase
    // parla di card, e qui non c'e' un topic da nominare — meglio `null` e il
    // ripiego su `busy` che il nome della prima chat che passa. Fra gli stream
    // vince la NON riadottabile: e' quella il cui lavoro non torna.
    holder: cards > 0 ? null : (unadoptableKeys[0] ?? streamKeys[0] ?? brokerOpen[0] ?? parked[0] ?? null),
    // WHICH GESTURE UNBLOCKS IT. The holder falls through to the parked list
    // only when the three "working" sources are empty, and that holder is a
    // chat waiting for a PERSON: the notice must ask for an answer, not for a
    // stop, or whoever reads it kills the turn the gate was protecting.
    holderKind: (cards === 0 && unadoptableKeys.length === 0 && streamKeys.length === 0 && brokerOpen.length === 0 && parked.length > 0)
      ? "question"
      : "turn",
  };
}

async function waitForDispatcherQuiescent(label: string, capMs = QUIESCENCE_CAP_MS): Promise<void> {
  // FIRST CLOSE THE DOOR. Every caller of this wait is a restart, and a wait
  // that lets the dispatcher keep starting turns behind a full cap never ends:
  // on 2026-09-04 `restart-when-idle` was still deferred after 18,482 s, three
  // card turns at a time, one starting as soon as one finished. From here on
  // no new card turn starts; the ones in flight finish, the queued ones keep
  // their sessions and the next process resumes them at boot.
  taskDispatcher.drain(label);
  // DUE SCADENZE, E TUTTE E DUE SONO TETTI VERI — contate dall'INIZIO
  // dell'attesa, non da «l'ultima volta che ho visto del lavoro».
  //
  // Prima la scadenza si RINNOVAVA a ogni giro con del lavoro in volo
  // (`deadline = max(deadline, now + capMs)`), e con una card sempre presente
  // non scadeva mai: simulato, dopo 2000 s la scadenza era ancora 1500 s più in
  // là. Non era un tetto, era una promessa infinita.
  //
  // COSA COSTAVA, misurato sul task 235afe11 il 20/08. Il server aspettava
  // senza fine; `start-prod.sh`, che di suo conta 1530 s DALL'INIZIO, arrivava
  // alla propria scadenza e sparava il SIGTERM su un turno vivo:
  //
  //     17:55:39  tentativo #1 parte
  //     18:22:46  il server riparte  (+27m)   → worktree buttato, task in coda
  //     18:23:12  tentativo #2 parte
  //     18:50:35  il server riparte  (+27m)   → di nuovo
  //     18:51:20  tentativo #3 parte
  //     19:18:07  SIGTERM            (+27m)   → «restart-when-idle accettato,
  //                                             ma il server è ancora vivo
  //                                             dopo 1530s — SIGTERM»
  //
  // Tre volte lo stesso task, a ventisette minuti esatti: la firma di un
  // orologio, non della sfortuna. E il cancello scritto per non tagliare i
  // turni non ha mai loggato una sola scadenza — perché non poteva scadere.
  //
  // Due orologi che si contraddicono sono peggio di un orologio solo troppo
  // stretto: quello che promette di aspettare non ferma il SIGTERM di quello
  // che ha smesso, e il turno muore comunque — ma senza che nessuno dei due
  // lo sappia. Ora il tetto è vero e il server esce DA SÉ, con `gracefulShutdown`
  // che gira per intero, prima che lo script perda la pazienza.
  const inizio = Date.now();
  let logged = false;
  let ultimoRinvioLoggatoS = -60;
  // Una sola chiamata per attesa: oltre il tetto il cancello avvisa una persona
  // invece di tagliare (vedi `reloadHeldNotice`). Ripeterlo ogni minuto sarebbe
  // rumore, e il log gia' lo fa per chi lo legge.
  let avvisato = false;
  for (;;) {
    const { busy, cards, unadoptable, parkedAsks, holder, holderKind } = await whatIsStillWorking();
    if (!busy) break;
    // La REGOLA sta in `lib/quiescence.ts`, pura e provata: qui si applica.
    // Viveva dentro questo loop, e li' dentro nessun test poteva raggiungerla
    // senza avviare un server — che e' il motivo per cui il difetto del
    // rinnovo infinito e' sopravvissuto tanto a lungo.
    const verdetto = quiescenceVerdict({
      busy, unrecoverable: cards + unadoptable,
      now: Date.now(), startedAt: inizio,
      capMs, chatCapMs: QUIESCENCE_CHAT_CAP_MS,
      parkedAsks,
    });
    // DUE ATTESE, PERCHE' SONO DUE DANNI DIVERSI.
    //
    // Un turno di CARD tagliato a meta' e' lavoro perso: l'agente stava
    // scrivendo file, e il turno non torna. Merita l'attesa lunga.
    //
    // Una CHAT che sta streammando no: la reload-resilience la riadotta, chi
    // guarda vede una pausa. Aspettarla quanto una card significa che il
    // hot-reload MUORE per chiunque abbia una conversazione aperta — cioe'
    // sempre, mentre si sviluppa. Misurato il 19/08 alzando il cap a 25
    // minuti: `restart-when-idle` rispondeva 202 e il server non usciva piu',
    // perche' a non drenare era la chat di chi stava lavorando.
    //
    // …SALVO QUANDO LA RIADOZIONE NON ESISTE. Quel «la riadotta» vale per un
    // turno che gira in un processo FIGLIO (claude-code): il SIGTERM non lo
    // tocca, il broker lo tiene, al riavvio torna. Un turno del runtime nativo
    // `topics` gira DENTRO questo processo, e quando il processo muore non c'e'
    // nessun figlio da riadottare: tagliarlo e' esattamente lo stesso danno di
    // una card tagliata, lavoro perso senza ritorno. Il 20/08, su
    // topic:9f9e9629, il cancello ha aspettato il suo minuto, ha concluso «la
    // riprendono» e ha ucciso una risposta a meta' frase che nessuno ha
    // ripreso. Quindi una chat NON riadottabile alza la scadenza come una card.
    //
    // IL PREZZO, MISURATO invece che stimato (94 blocchi di attivita' nativa
    // continua sul db vivo, 18-20/08):
    //
    //     cap      turni che arrivano in fondo    attesa media del reload
    //     1 min          19/94  (20%)                   0.8 min
    //     15 min         81/94  (86%)                   6.3 min
    //     25 min         84/94  (89%)                   7.6 min
    //
    // Col minuto di prima, QUATTRO TURNI NATIVI SU CINQUE venivano tagliati:
    // non era un caso sfortunato, era la norma. Si riusa `capMs` — lo stesso
    // numero delle card — invece di introdurre una terza soglia: fra 15 e 25
    // minuti ballano tre punti di turni salvati contro 1,3 minuti di attesa in
    // piu', una differenza che non vale un secondo numero da tenere allineato
    // a mano (e' la stessa ragione per cui `start-prod.sh` deriva la sua
    // finestra da qui invece di riscriverla).
    //
    // E CHI SFONDA ANCHE QUELLO NON VIENE TAGLIATO. Qui c'era scritto che
    // «prende comunque il cartello», e non e' vero: per un turno che non torna
    // `quiescenceVerdict` non restituisce MAI "scaduto" — e' l'invariante del
    // 28/08, con un test che la fissa fino a `CAP * 10_000`. Il commento
    // sbagliato e' costato un'ora di indagine il 30/08, quando il codice
    // sembrava rotto perche' contraddiceva la riga sopra di se'.
    //
    // Quello che il tetto fa davvero, adesso: smette di tacere. Oltre la
    // scadenza il cancello manda UNA notifica che nomina la chat che trattiene
    // (`reloadHeldNotice`), e la decisione resta a una persona. Il 30/08 un
    // riavvio e' rimasto in attesa 4599 secondi con la sola traccia in un log
    // che nessuno guardava; saputolo, l'utente l'ha sbloccato in cinque
    // secondi. Un'attesa senza fine e' accettabile, un'attesa MUTA no.
    //
    // La scadenza NON si rinnova più a ogni giro: si sceglie fra due tetti
    // fissi, calcolati all'inizio dell'attesa (vedi in cima alla funzione). Il
    // rinnovo sembrava generoso — «una card che parte mentre aspetto ha diritto
    // all'attesa lunga» — ma era la ragione per cui questo cancello non è mai
    // scaduto una sola volta, e per cui a decidere finiva il SIGTERM dello
    // script. Una card che parte mentre stiamo già uscendo prende il tempo che
    // resta e poi, se non basta, muore DICENDOLO: è meglio di un'attesa che non
    // finisce e di un taglio che nessuno annuncia.
    if (verdetto === "rinvia") {
      // NON SI TAGLIA CHI NON TORNA. Si rinvia, e lo si dichiara: allo script,
      // con un battito su file, perche' altrimenti manda il SIGTERM al posto
      // nostro; e nel log, una riga al minuto, perche' un riavvio che non
      // arriva senza spiegazione e' peggio di uno che taglia.
      touchReloadDeferred();
      // OLTRE IL TETTO SI CHIAMA UNA PERSONA. Non si taglia — l'invariante
      // «un orologio non uccide lavoro che non torna» resta intera — ma
      // nemmeno si tace: il 30/08 un riavvio e' rimasto in attesa 4599s con la
      // sola traccia in un file che nessuno guardava, e l'utente l'ha sbloccato
      // in cinque secondi appena l'ha saputo. Best-effort: un registro che non
      // scrive non deve fermare l'attesa.
      if (!avvisato) {
        const avviso = reloadHeldNotice({
          waitedMs: Date.now() - inizio,
          capMs,
          busy,
          holderName: holder ? (ctx.getTopicBySessionKey(holder)?.name ?? null) : null,
          holderKind,
          waitId: `${label}:${inizio}`,
        });
        if (avviso) {
          avvisato = true;
          try {
            const topicId = holder ? (ctx.getTopicBySessionKey(holder)?.id ?? null) : null;
            recordAndAnnounce({
              kind: "session",
              title: avviso.title,
              body: avviso.body,
              targetKind: topicId ? "topic" : null,
              targetId: topicId,
              dedupeKey: avviso.dedupeKey,
              source: "push",
            });
          } catch (err) {
            console.warn("[quiescence] avviso di riavvio trattenuto non registrato:", err);
          }
        }
      }
      const attesaS = Math.round((Date.now() - inizio) / 1000);
      if (attesaS - ultimoRinvioLoggatoS >= 60) {
        ultimoRinvioLoggatoS = attesaS;
        console.warn(
          `[quiescence] ${label}: riavvio RINVIATO da ${attesaS}s — ${busy} non tornerebbe se lo tagliassi. ` +
          `Riparto appena finisce; per forzare adesso: launchctl kickstart -k gui/$(id -u)/com.armonia.topics-server`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (verdetto === "scaduto") {
      // LA FRASE DICE LA VERITA' SU CHI SI STA TAGLIANDO, e sono tre sorti
      // diverse — non una.
      //
      // «la reload-resilience li riprende» era scritto per un turno che vive in
      // un processo FIGLIO: quello torna davvero. Ma qui ci passano anche le
      // CARD, e una card non viene riadottata: il dispatcher la rimette in coda
      // e il suo turno riparte DA CAPO (il worktree sopravvive, il turno no).
      // Dirle «ti riprendo» e' la stessa specie di bugia di «stream aborted by
      // user» su uno spegnimento — chi legge il log cerca dalla parte
      // sbagliata. Sul task 235afe11 e' successo tre volte in un'ora, e ogni
      // riga di quel giro raccontava una ripresa che non c'e' stata.
      const sorti: string[] = [];
      if (cards > 0) sorti.push(`${cards} card: turno perso, rimessa in coda (riparte da capo, il worktree resta)`);
      if (unadoptable > 0) sorti.push(`${unadoptable} chat NON riadottabile/i: quel lavoro non torna, in chat resta il cartello`);
      if (!sorti.length) sorti.push("la reload-resilience li riprende");
      console.warn(`[quiescence] ${label}: ${busy} — ancora in volo alla scadenza dopo ${Math.round((Date.now() - inizio) / 1000)}s, si procede lo stesso (${sorti.join("; ")})`);
      return;
    }
    if (!logged) {
      // NAME THE HOLDERS. "4 card turns" told nobody that three of them were
      // orphan recoveries stuck since boot (2026-09-04): a count cannot be
      // checked against the board, a list of ids can.
      const holders = cards > 0 ? ` [${taskDispatcher.busyIds().map((id) => id.slice(0, 8)).join(", ")}]` : "";
      console.log(`[quiescence] ${label}: aspetto prima di riavviare — ${busy}${holders}${unadoptable > 0 ? ` (${unadoptable} non riadottabile/i: attesa lunga)` : ""}`);
      logged = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  clearReloadDeferred();
  if (logged) console.log(`[quiescence] ${label}: tutto finito — si procede col riavvio`);
}


/**
 * IL GC DI RIPOSO — restituire al sistema la memoria dei picchi passati.
 *
 * Misurato il 2026-08-19 sul server di produzione dell'utente, dopo cinque ore
 * di uptime: `phys_footprint` 936 MB e picco 2,4 GB, contro una heap JS di
 * 52 MB e un RSS di 110 MB. Gli 826 MB in mezzo erano pagine toccate durante i
 * turni degli agenti, poi swappate dal sistema, e mai restituite — swap
 * occupato che `phys_footprint` continua ad attribuire all'app, cioè
 * ESATTAMENTE il numero che la barra di stato e Monitoraggio Attività mostrano
 * (ed è il numero che ha prodotto la segnalazione «1,8 GB»).
 *
 * Il perché sta in `server/lib/idle-gc.ts`, con la misura che dimostra che
 * `Bun.gc(true)` scioglie anche le pagine già in swap — la parte non ovvia,
 * perché il footprint da solo non scende MAI, nemmeno dopo che il sistema ha
 * swappato tutto.
 *
 * COSA LO TRATTIENE, e perché non tutto ciò che trattiene un riavvio. La prima
 * versione riusava il predicato di `restart-when-idle` per intero, e sarebbe
 * stata inutile: su questa macchina `activeStreams` ha due chat aperte quasi
 * sempre, quindi il gc non sarebbe partito una sola volta in dieci minuti. La
 * pausa che giustificava quella prudenza, misurata, è **1-15 ms** (caso
 * peggiore 8 ms su 18.845 oggetti vivi) — meno di un frame. Restano fuori le
 * card della board e i turni adottati dal broker: là un agente scrive file e
 * la sua latenza è l'unica cosa che ha. La decisione, con i numeri, sta in
 * `server/lib/idle-gc.ts`.
 */
const idleGcTimer = setInterval(() => {
  void giroIdleGc({
    sorgenti: async () => {
      const cards = taskDispatcher.busyCount();
      const streamKeys = [...activeStreams.keys()];
      // Stessa economia di `whatIsStillWorking`: la sonda del broker si paga,
      // e non si paga quando una fonte gratuita ha già detto «occupato».
      if (cards > 0 || streamKeys.length > 0) return { cards, streamKeys, brokerOpenKeys: [] };
      return { cards, streamKeys, brokerOpenKeys: await openBrokerChatTurns() };
    },
    footprintMB: () => {
      const kb = procFootprintKB(process.pid);
      return kb === null ? null : Math.round(kb / 1024);
    },
    raccogli: () => { Bun.gc(true); },
    log: (m) => console.log(m),
  });
}, IDLE_GC_EVERY_MS);
idleGcTimer.unref?.();

// Graceful shutdown
let shutdownInProgress = false;
async function gracefulShutdown(signal: string) {
  // Re-entrancy guard: a second signal during shutdown (hot-reload watcher
  // double-batch) must not run the teardown twice.
  if (shutdownInProgress) {
    console.log(`[Shutdown] ${signal} received while already shutting down — ignored`);
    return;
  }
  shutdownInProgress = true;
  console.log(`\n[Shutdown] Received ${signal}, closing browser service...`);
  clearInterval(heartbeatTimer);
  clearInterval(wsHeartbeatTimer);
  clearInterval(staleStreamTimer);
  clearInterval(dispatchTimer);
  clearTimeout(worktreeGcBoot);
  clearInterval(worktreeGcTimer);
  clearTimeout(landingAuditBoot);
  clearInterval(landingAuditTimer);
  clearInterval(relayLicenzaTimer);
  clearInterval(idleGcTimer);
  // Prima di spegnere il dispatcher, non dopo: `shutdown()` svuota `inFlight`,
  // e quella mappa e' l'unica fotografia di chi stava lavorando in questo
  // istante. Senza questa riga lo stato «interrotto» non veniva deciso, veniva
  // INDOVINATO dal boot successivo guardando il chip rimasto sulla card.
  try { taskDispatcher.markInterrupted(signal); }
  catch { /* uno spegnimento non fallisce per una nota */ }
  taskDispatcher.shutdown();
  void previewManager?.teardownAll(); // kill any live preview servers
  stopUiStateBackup();
  disconnectBridge(); // Disconnect from bridge — bridge daemon stays alive, PTY sessions persist
  await webrtcBridge.shutdown();
  await browserService.close();
  // Il sidecar Chromium NON è di browserService: il suo processo appartiene al
  // registry degli engine, che lo tiene a conteggio di riferimenti. close() qui
  // sopra chiude solo i client CDP, quindi finché mancava questa riga l'uscita
  // PULITA lasciava comunque in piedi un Chromium sulla 19333, reparentato a
  // launchd. È il gemello del leak da SIGKILL, ma sul cammino buono.
  chromiumSidecar.dispose();
  // Stop all AI providers BEFORE closing the DB. claude-code's stop() sends
  // SIGTERM to the spawned `claude` CLI children so they flush session state
  // to ~/.claude/sessions/ — without this, `bun --watch` hot reloads left
  // children orphaned and the next spawn started a fresh conversation. The
  // grace window inside stopAllProviders matches each provider's internal
  // SIGTERM→SIGKILL window so process.exit() doesn't truncate the flush.
  //
  // QUELLA FINESTRA ORA REGGE ANCHE IL CARTELLO IN CHAT, e va detto perché
  // nessuno la accorci senza saperlo. `stop()` del runtime nativo annulla i
  // turni vivi con causa `server-shutdown`; il cartello che spiega la caduta
  // all'utente lo scrive il `catch` di `sendChat` → `onAborted` →
  // `finalizeStream` → `updateLastMessage`. Fra l'`abort()` e quella scrittura
  // c'è un giro di microtask (la promise del turno rigetta, il catch gira
  // dopo): sincrono no, ma nemmeno lontanamente vicino ai 3500 ms. Se un domani
  // questa finestra scendesse a zero, il turno morirebbe di nuovo senza una
  // parola — con la differenza che stavolta il codice per parlare c'è, e
  // sarebbe `closeDatabase()` a impedirglielo.
  await stopAllProviders();
  closeDatabase();
  releaseLock();
  process.exit(0);
}

// Init is complete: repoint the early-registered signal listeners (top of
// file) from the exit-clean stub to the real teardown.
onTermSignal = (signal) => { void gracefulShutdown(signal); };
