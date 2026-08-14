import { basename, join, resolve, sep } from "path";
import { finalizeOrphanTool } from "./server/lib/orphan-tool-sweep";
import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync, readlinkSync, realpathSync } from "fs";
import { timingSafeEqual } from "crypto";
import type { ServerWebSocket } from "bun";
import type { WSData } from "./server/types";
import { createAppContext } from "./server/utils";
import { closeDatabase } from "./server/db";
import { shouldServeSpaFallback } from "./server/spa-fallback";
import { classifyStaticAsset } from "./server/static-assets";
import {
  acquireLock, releaseLock, writeState, readState,
  uptimeMsSince, LiveLockError, worktreeIsolationHome,
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
import { createVoiceRouter } from "./server/routes/voice";
import { createMediaRouter } from "./server/routes/media";
import { createBranchesRouter } from "./server/routes/branches";
import { createFilesRouter } from "./server/routes/files";
import { createBrowserRouter } from "./server/routes/browser";
import { createCronRouter } from "./server/routes/cron";
import { createContextRouter } from "./server/routes/context";
import { createOrphanCensusRunner } from "./server/services/orphan-census";
import { createTerminalRouter, handleTerminalWebSocket, disconnectBridge, getClaudeSessionsForDetection, getClaudeSessionPtyIdleMs, setTerminalBrowserCloser, countAttachedTerminalSessions, listTerminalSessionSnapshot, parkOrphanSessions, retireTerminalSession } from "./server/routes/terminal";
import { createStatusRouter } from "./server/routes/status";
import { createMemoryRouter } from "./server/routes/memory";
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
import { fleetLoadSync } from "./server/lib/fleet-usage";
import { buildBranchInventory, summarizeInventory } from "./server/services/branch-inventory";
import { createTaskAutoMerge, worktreeRealDirt } from "./server/services/task-automerge";
import { createPreviewManager, type PreviewManager, type PreviewProcess } from "./server/services/preview-manager";
import { registerPreviewProcess, unregisterPreviewProcess } from "./server/routes/processes";
import { sweepWorktrees, type TaskStatus as GcTaskStatus } from "./server/services/worktree-gc";
import { formatMb, parseSlimSkip, slimWorktree } from "./server/services/worktree-slim";
import { branchExistsInRepo, branchStatusFromRepo, commitIsAncestor, commitStatusFromRepo, resolveCommit, worktreeDiffStat } from "./server/services/branch-status";
import { deliveryPointer } from "./server/services/own-commits";
import { abandonNoticeFromRepo } from "./server/services/worktree-abandon-notice";
import { createTaskAttemptStore } from "./server/services/task-attempts";
import { auditLandings, classifyLanding, classifyLandingEsito, type AuditTask, type LandingState } from "./server/services/landing-audit";
import { classifyBranchLanding, classifyCommitLanding, indiceRigheMain } from "./server/services/landing-verdict";
import { createTranscriptUsageReader } from "./server/services/transcript-usage";
import { createDispatchUsageReader } from "./server/services/dispatch-usage";
import { orphanBoardChildSessions } from "./server/services/agent-census";
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
import { countSharedViewers } from "./server/browser-viewer-count";
import { seedNativeFromShared } from "./server/browser-session-handoff";
import { parseChatWsInbound } from "./server/schemas/chat-ws-inbound";
import { buildPresenceSnapshot } from "./server/presence";
import { SERVER_VERSION, SERVER_PROTOCOL_VERSION, SERVER_CAPABILITIES } from "./server/ws-capabilities";
import { createActivityRouter } from "./server/routes/activity";
import { createDashboardRouter } from "./server/routes/dashboard";
import { createAuthRouter, noteDeviceConnected, noteDeviceDisconnected } from "./server/routes/auth";
import { evaluateIdentity, isIdentityExemptPath, readSessionCookie } from "./server/lib/device-auth";
import { isGuestAllowedPath, isGuestAllowedMethod, isGuestSafeFrameType, isGuestHandshakeFrame, isGuestSocketData, frameResource } from "./server/lib/grants";
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
import { initProvider, recomputeDefault, getDefaultProviderName, stopAllProviders, getProvider } from "./server/providers";
import { aiBridgeEnabled } from "./server/providers/claude-code";
import { cancelled, describeTurnEnd, type TurnEndInfo } from "./server/providers/stop-reason";
import { recordTurnEnd, takeTurnEnd } from "./server/providers/turn-end-registry";
import { getAiBridgeClient } from "./server/lib/ai-bridge-client";
import { pickTaskPlan } from "./server/services/task-model-picker";
import { FALLBACK_MODELS, newestOfFamily } from "./server/providers/claude-models";
import { createProcessesRouter, startProcessDetection } from "./server/routes/processes";
import { createTasksRouter } from "./server/routes/tasks";
import { createPushRouter } from "./server/routes/push";
import { createNotificationsRouter } from "./server/routes/notifications";
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
} from "./server/services/app-settings";
import { createProfileRouter } from "./server/routes/profile";
import { startDiscordPresence } from "./server/services/discord-presence";
import { computePresenceCounts } from "./server/services/profile-stats";
import { createClaudeHooksRouter } from "./server/routes/claude-hooks";
import { createE2eRouter } from "./server/routes/e2e";
import { createTabsRouter } from "./server/routes/tabs";
import { createClaudeSessionTracker } from "./server/lib/claude-session-tracker";
import { evaluateAuth, isLoopbackAddress, isOriginGatedPath, resolveAllowedOrigins } from "./server/lib/auth-gate";
import { markViaTunnel, isLocalTransport, clientIpOf, tunnelPort } from "./server/lib/tunnel";
import { comprimiJson } from "./server/lib/compress-json";
import { ROUTE_FAULT, applyRouteFault } from "./server/lib/route-fault";
import { BUSY_SPINNER_PHASES } from "./server/lib/claude-session-state";
import { claudeTranscriptPath, isTranscriptOrphaned } from "./server/lib/claude-transcript-path";
import { createProjectsRouter } from "./server/routes/projects";
import { createWorktreeGcRunner } from "./server/services/worktree-gc-runner";
import { createWorktreesRouter } from "./server/routes/worktrees";
import { createMachinesRouter } from "./server/routes/machines";
import { initVapid } from "./server/push-service";
import { startDevBundleReload, readBundleRev, stampBundleRev } from "./server/lib/dev-bundle-reload";
// `pendingAskAgeMs`/`hasPendingAsk` non si importano più qui: chiedere della
// sola domanda era il difetto. Restano il verdetto e il TTL, che valgono per
// entrambi i silenzi.
import { pendingAskVerdict, cancelAsk, ASK_TTL_MS } from "./server/lib/ask-user-bridge";
// La porta unica di «questo turno aspetta una PERSONA». Le due sorgenti di
// silenzio legittimo sono una domanda a schermo E una richiesta di permesso a
// schermo: qui dentro tre punti ne conoscevano solo la prima, che è esattamente
// la deriva che `human-hold.ts` è stato scritto per impedire — e che la sua
// docstring nomina, elencando «lo spazzino degli stream fermi» fra i sei posti.
import { isHumanHold, humanHoldAgeMs } from "./server/lib/human-hold";
// Il tetto a orologio dei turni guidati da qui non conta il tempo in cui la
// palla è dell'umano: con una domanda a schermo si riarma invece di tagliare.
import { armTurnDeadline } from "./server/lib/turn-deadline";

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
    if (!process.env.TOPICS_HOME) process.env.TOPICS_HOME = isoHome;
    if (!process.env.PORT && !process.env.BUN_PORT) process.env.PORT = "0";
    console.log(
      `[Daemon] worktree server isolated → TOPICS_HOME=${process.env.TOPICS_HOME}, ` +
      `PORT=${process.env.PORT === "0" ? "ephemeral" : process.env.PORT} (won't touch production)`,
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

function broadcastToBrowserWs(contextId: string, msg: BrowserWsMessage): void {
  const set = browserWsClients.get(contextId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const ws of set) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(payload);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[broadcastToBrowserWs] send failed for ${contextId}:`, m);
    }
  }
}

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
rebuildSummary();

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
      const p = getProvider("claude-code") as unknown as { isTurnProcessAlive?: (s: string) => boolean };
      return !!p?.isTurnProcessAlive?.(sk);
    } catch { return false; }
  },
});

// La porta unica del parcheggio (lib/session-parking.ts): archiviare un topic
// deve anche mettere a riposo la sua sessione, o la fase resta viva per sempre
// su una chat che non ha più né riga né tab. Configurata qui perché il tracker
// nasce DOPO il contesto; i tre percorsi di archiviazione la chiamano.
configureSessionParkingForTracker(claudeSessionTracker);

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
// ─── Task auto-dispatch (Kanban "drag → agent in a tab") ───────────────────
// The dispatcher is the ONLY place that starts a headless agent turn from a
// board gesture. All its host-specific wiring — the in-process turn runtime,
// worktree creation, project-path resolution — is assembled here and injected,
// keeping server/services/task-dispatcher.ts host-agnostic and unit-tested.
const dispatcherSvc = createTaskService(ctx.db);
const DISPATCH_WORKSPACE_DIR = join(ctx.OPENCLAW_DIR, "workspace");

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

async function runHeadlessTurn(
  sessionKey: string,
  content: string,
  opts: { timeoutMs: number; contextMode?: "full" | "lean" },
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
  // The turn self-drives server-side (consumeGateway) whether or not we read the
  // SSE mirror; we drain it only to learn when the turn ENDS (the reconciliation
  // signal). A wall-clock backstop aborts a runaway turn.
  const reader = resp.body.getReader();
  let timedOut = false;
  const deadline = armTurnDeadline({
    ms: opts.timeoutMs,
    isWaitingForHuman: () => isHumanHold(sessionKey),
    onRearm: () => console.log(`[turn] tetto a orologio riarmato su ${sessionKey}: una persona è in mezzo (domanda o permesso), il tempo dell'umano non conta`),
    onExpired: () => {
      timedOut = true;
      abortHeadlessTurn(sessionKey).catch(() => {});
      reader.cancel().catch(() => {});
    },
  });
  try { while (true) { const { done } = await reader.read(); if (done) break; } }
  finally { deadline.clear(); try { reader.releaseLock(); } catch { /* already released */ } }
  // Il tetto a orologio è NOSTRO: vince su qualunque fine la route abbia
  // depositato nel frattempo (l'abort che manda arriva dopo).
  if (timedOut) {
    takeTurnEnd(sessionKey);
    return cancelled("wall-clock", `timeout after ${opts.timeoutMs}ms`);
  }
  // La route ha depositato il PERCHÉ finalizzando; il drain finisce con `[DONE]`,
  // che la finalizzazione scrive dopo. Se manca, il turno è comunque finito.
  return takeTurnEnd(sessionKey) ?? { end: "end_turn" };
}

// Reattach variant: POST /api/chat with mode:"reattach" and NO user message —
// the route calls provider.reattach (adopt the surviving broker turn) instead of
// sendChat. Same SSE drain to learn when the turn ends. Used by the dispatcher's
// reconcile REATTACH branch after a server restart.
async function runHeadlessReattach(sessionKey: string, opts: { timeoutMs: number }): Promise<TurnEndInfo> {
  const url = new URL("http://localhost/api/chat");
  const body = JSON.stringify({ sessionKey, messages: [], mode: "reattach", dispatched: true });
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
  const reader = resp.body.getReader();
  let timedOut = false;
  const deadline = armTurnDeadline({
    ms: opts.timeoutMs,
    isWaitingForHuman: () => isHumanHold(sessionKey),
    onRearm: () => console.log(`[turn] tetto a orologio riarmato su ${sessionKey}: una persona è in mezzo (domanda o permesso), il tempo dell'umano non conta`),
    onExpired: () => {
      timedOut = true;
      abortHeadlessTurn(sessionKey).catch(() => {});
      reader.cancel().catch(() => {});
    },
  });
  try { while (true) { const { done } = await reader.read(); if (done) break; } }
  finally { deadline.clear(); try { reader.releaseLock(); } catch { /* already released */ } }
  // Il tetto a orologio è NOSTRO e vince: prima lanciava un errore generico che
  // il dispatcher classificava come guasto del provider — era la stessa bugia.
  if (timedOut) {
    takeTurnEnd(sessionKey);
    return cancelled("wall-clock", `reattach timeout after ${opts.timeoutMs}ms`);
  }
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

const taskDispatcher = createTaskDispatcher({
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
    const { topic } = createDetachedTopic(
      // background: an agent session never pops a tab — it lives in the
      // sidebar; the task drawer's "apri tab" un-archives it on demand.
      { name: o.name, projectPath: o.projectPath, worktreeId: o.worktreeId, systemPrompt: o.systemPrompt, effort: o.effort, model: o.model, background: true, standalone: o.standalone, mcpPolicy: o.mcpPolicy, autonomyLevel: o.autonomyLevel ?? DISPATCH_AUTONOMY },
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
  attempts: createTaskAttemptStore(ctx.db),
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
  resourceBlock: () => dispatchResourceBlock(ctx.worktreeManager.worktreesDir()),
  createWorktree: async (projectStoreId) => {
    // Il ramo di una card nasce da MAIN, non dall'HEAD del checkout condiviso:
    // con `HEAD` il worktree ereditava il ramo di chi stava lavorando qui, e da
    // lì arrivavano collisioni di migration, consegne su commit mai landati e
    // land che pubblicavano lavoro di terzi. Il perché per esteso, e il ripiego
    // su HEAD quando `main` non c'è, stanno in `worktree-base-ref.ts`.
    const base = await resolveWorktreeBaseRef(ctx.projectStore.get(projectStoreId)?.path);
    if (base.fallback) console.warn(`[dispatch] ${base.reason}: il worktree parte da HEAD`);
    const wt = await ctx.worktreeManager.create({ projectId: projectStoreId, mode: "branch", baseRef: base.baseRef });
    const ready = await ctx.worktreeManager.awaitMaterialisation(wt.id, 120_000);
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
    const c = computeDispatchCapacity(turniInVolo());
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
    const p = getProvider("claude-code") as unknown as { hasLiveSession?: (sk: string) => Promise<boolean> };
    return typeof p?.hasLiveSession === "function" ? p.hasLiveSession(sessionKey) : Promise.resolve(false);
  },
  reattach: (sessionKey, opts) => runHeadlessReattach(sessionKey, opts),
  // Liveness net: is the agent CHILD of this session still there? Same probe the
  // stream watchdog uses to tell a thinking-but-mute turn from a dead one (it
  // covers direct AND broker mode — the daemon's `exit` frame flips pp.alive).
  // A provider without the probe answers null = "can't tell", and the dispatcher
  // never buries a turn on ignorance.
  isTurnAlive: (sessionKey) => {
    const p = getProvider("claude-code") as unknown as { isTurnProcessAlive?: (sk: string) => boolean };
    if (typeof p?.isTurnProcessAlive !== "function") return null;
    try { return p.isTurnProcessAlive(sessionKey); } catch { return null; }
  },
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
  getSessionUsage: (sessionKey: string) => dispatchUsageReader.read(sessionKey),
  // Last assistant prose in the session — the dispatcher mirrors it into a task
  // comment at delivery when the agent forgot comment_task, so a review always
  // carries the agent's own summary. Reads the local message store (sync).
  getLastAgentText: (sessionKey: string) => {
    try {
      const msgs = ctx.loadLocalMessages(sessionKey, { withBlocks: false });
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
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
  const topicId = dispatcherSvc.get(taskId)?.task.assignedTopicId;
  if (!topicId) return null;
  const worktreeId = ctx.getTopicById(topicId)?.worktreeId;
  if (!worktreeId) return null;
  return ctx.worktreeStore.get(worktreeId) ?? null;
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
  addReviewNote: (taskId, { content, media }) => {
    const projectId = dispatcherSvc.get(taskId)?.task.projectId;
    try {
      dispatcherSvc.addComment({ taskId, author: "verifier", content, media, projectId, kind: "review-note" });
      const t = dispatcherSvc.get(taskId)?.task;
      if (t) ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch (err) { console.error("[preview] addReviewNote", err); }
  },
  registerProcess: (entry) => registerPreviewProcess(entry),
  unregisterProcess: (taskId) => unregisterPreviewProcess(taskId),
  mediaDir: PREVIEW_MEDIA_DIR,
  ensureMediaDir: () => { try { mkdirSync(PREVIEW_MEDIA_DIR, { recursive: true }); } catch { /* ignore */ } },
  log: (msg, err) => console.error(msg, err ?? ""),
});

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
  isInFlight: (taskId) => taskDispatcher.isInFlight(taskId),
  worktreeOfTask: (taskId) => worktreeOfTask(taskId),
  projectIdForPath: (path) => projectIdForPath(path),
  deliveryIsOnMain: (repoPath, commit) => deliveryIsOnMain(repoPath, commit),
  tryMerge: (taskId, text, delivery) => taskAutoMerge.tryMerge(taskId, text, delivery),
  previewList: () => previewManager?.list() ?? [],
  previewTeardown: (taskId) => previewManager?.teardown(taskId) ?? Promise.resolve(),
});


const tasksRouter = createTasksRouter(ctx, taskDispatcher, {
  workspaceDir: DISPATCH_WORKSPACE_DIR,
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
  taskDeliveryRef: async (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch" || !wt.branchName) return null;
    const repoPath = ctx.projectStore.get(wt.projectId)?.path;
    if (!repoPath) return null;
    // NON la punta del ramo: l'ultimo commit SUO. Un ramo che eredita il lavoro
    // di chi stava sul checkout condiviso ha una punta che non è della card, e
    // chi rivede finirebbe a leggere il diff di un altro (misurato il 10/08).
    // `deliveryPointer` è la stessa domanda che si fa l'automerge: una fonte sola.
    return deliveryPointer(repoPath, wt.branchName).catch(() => null);
  },
  // Dove far girare i checks pre-review: la cartella del worktree del task e il
  // commit su cui sta. Solo worktree di branch — un task in-place girerebbe i
  // comandi nel checkout principale, cioè su codice che non è il suo.
  taskCheckoutRef: async (taskId) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch") return null;
    const commit = await resolveCommit(wt.absPath, "HEAD");
    return { cwd: wt.absPath, commit };
  },
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
    ...computePresenceCounts(ctx.db, ctx.activeStreams.size),
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

// NOTE: the session attention monitor is NOT auto-started. It runs only when
// the user enables it from Topics (POST /api/master/monitor) — nothing runs
// "a caso". Default OFF on every server start. See session-monitor.ts.

// Activity LOG (audit trail) — the live OpenClaw-log feed is gone.
const activityRouter = createActivityRouter(ctx);

// External-session census: poll + broadcast so a `claude` started in iTerm
// surfaces on the board within ~20s without any client polling.
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
    if (set.size === 0) browserWsClients.delete(ctxId);
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
  let cleared = 0, kept = 0;
  try {
    const rows = db.query("SELECT DISTINCT session_key AS sk FROM messages WHERE partial = 1").all() as Array<{ sk: string }>;
    for (const row of rows) {
      midTurnAtBoot.add(row.sk);
      // Keep the mid-turn signal when the child survived OR when we could not
      // confirm it's dead (fail-safe — an unconfirmed read must never orphan a
      // live turn, the bug that surfaced as "la sessione si è chiusa mentre un
      // tool era ancora in corso").
      if (!listConfirmed || liveBrokerChatSessions.has(row.sk)) { kept++; continue; }
      cleared += db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1", [row.sk]).changes;
    }
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
    const startTime = Date.now();
    const isApiRequest = pathname.startsWith("/api/");
    if (isApiRequest) console.log(`[HTTP] → ${method} ${pathname}`);

    // Guasto SINTETICO su una rotta: e' cio' che permette di vedere ROSSO il
    // cancello sulle latenze (`bun run check:rotte`) senza barare sulla soglia.
    // Spento ovunque tranne che nel server di prova, e solo se glielo si chiede
    // (vedi `server/lib/route-fault.ts`: vuole TOPICS_E2E=1 *e* un ritardo).
    // Qui, da spento, e' il confronto con `null` di una costante di modulo.
    if (ROUTE_FAULT && isApiRequest) await applyRouteFault(pathname);

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
        return new Response(JSON.stringify({
          pid: fresh.pid,
          startedAt: fresh.startedAt,
          uptime_ms: uptimeMsSince(fresh.startedAt),
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
        if (isApiRequest) console.log(`[HTTP] ✗ ${method} ${pathname} — ${decision.status}: ${decision.reason}`);
        const o = corsAllowOrigin(req);
        // Il `code` distingue «non sei appaiato» da «origine forestiera»: e' su
        // quello che il client decide se aprire la schermata di appaiamento o
        // limitarsi a segnalare. Un 401 muto era il difetto per cui il pairing
        // precedente non e' mai servito a nessuno.
        return new Response(JSON.stringify({ error: decision.reason, code: decision.code ?? "forbidden" }), {
          status: decision.status,
          headers: { "content-type": "application/json", ...(o ? { "Access-Control-Allow-Origin": o, Vary: "Origin" } : {}) },
        });
      }
    }

    // WebSocket upgrade - terminal
    if (pathname.startsWith("/ws/terminal/")) {
      const termId = pathname.split("/ws/terminal/")[1];
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now(), terminalId: termId } });
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
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now(), deviceId: wsDevice.id, deviceRole: wsDevice.role } });
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
      // Last-known-good shell. /public is rewritten in place by the build-watch
      // agent (com.armonia.topics-build-watch), so a page load that lands mid
      // rebuild used to read a missing index.html, throw, and answer 500 — the
      // app "doesn't open", for a window that has nothing to do with the app.
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
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": getMimeType(filePath), "Cache-Control": "public, max-age=3600" } });
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
      logRequest(method, pathname, 404, startTime);
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
            if (data.windowId) {
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
          if (bset.size === 0) browserWsClients.delete(ws.data.browserContextId);
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
 * Le risposte JSON escono compresse verso chi NON è locale.
 *
 * Il gestore vero non si tocca: si avvolge una volta sola, qui, dove passa
 * ogni risposta di entrambi gli ascoltatori. Il perché della regola — e perché
 * loopback resta crudo — sta in `server/lib/compress-json.ts`. In due parole:
 * `/api/history` di una topic di lavoro pesa 5,17 MB e ne pesa 1,39 compressa,
 * ma i 60 ms di CPU che costa comprarli comprano un secondo e mezzo solo se in
 * mezzo c'è una rete.
 */
function conCompressione(
  handler: typeof opzioniServer.fetch,
): typeof opzioniServer.fetch {
  return async function (this: unknown, req, srv) {
    const res = await handler.call(this as never, req, srv);
    // `undefined` = upgrade a WebSocket riuscito: non c'è nessuna risposta HTTP.
    if (!res) return res;
    // Loopback nudo, NON `isLocalTransport`. Le due domande si somigliano ma
    // rispondono a cose diverse: `isLocalTransport` chiede «di chi mi fido», e
    // per quella il tunnel è remoto anche se il peer è 127.0.0.1. Qui la domanda
    // è «c'è una rete in mezzo», e sul tunnel non c'è: dall'altra parte del
    // socket sta `relay-client.ts` su questa stessa macchina, che rigioca la
    // richiesta con `fetch` e la SCOMPATTA subito (misurato: Bun scompatta da
    // sé, e `intestazioniRisposta` toglie `content-encoding` proprio perché il
    // corpo che riparte è già testo). Comprimere lì sarebbe pagare due volte
    // per consegnare gli stessi byte.
    const remoto = !isLoopbackAddress(srv.requestIP(req)?.address ?? null);
    return comprimiJson(req, res, remoto);
  } as typeof opzioniServer.fetch;
}

const fetchCompresso = conCompressione(opzioniServer.fetch);

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
    const rows = db.prepare(
      `SELECT id, session_key, content, tool_calls, blocks FROM messages
       WHERE timestamp >= date('now', '-30 days') AND partial = 0 AND (
         tool_calls LIKE '%"status":"running"%' OR tool_calls LIKE '%"status":"pending"%'
         OR tool_calls LIKE '%"status":"waiting_for_input"%'
         OR tool_calls LIKE '%"status":"awaiting_permission"%'
         OR blocks LIKE '%"status":"running"%' OR blocks LIKE '%"status":"pending"%'
         OR blocks LIKE '%"status":"waiting_for_input"%'
         OR blocks LIKE '%"status":"awaiting_permission"%')`
    ).all() as Array<{ id: string; session_key: string | null; content: string | null; tool_calls: string | null; blocks: string | null }>;
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
      let tcStr = r.tool_calls, blStr = r.blocks;
      // The client renders tool state from `blocks` (the chronological timeline)
      // when present — so BOTH columns must be finalized, or the spinner keeps
      // ticking off the stale block copy even though tool_calls is fixed.
      try {
        if (r.tool_calls) {
          const tcs = JSON.parse(r.tool_calls) as Array<Record<string, unknown>>;
          let c = false; for (const tc of tcs) if (finalizeOrphanTool(tc, { childAlive: alive, now })) { c = true; tools++; }
          if (c) { tcStr = JSON.stringify(tcs); changed = true; }
        }
      } catch { /* skip malformed tool_calls */ }
      try {
        if (r.blocks) {
          const bl = JSON.parse(r.blocks) as Array<Record<string, unknown>>;
          let c = false;
          for (const b of bl) if (b && b.kind === "tool" && finalizeOrphanTool(b.toolCall as Record<string, unknown>, { childAlive: alive, now })) { c = true; tools++; }
          if (c) { blStr = JSON.stringify(bl); changed = true; }
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
    // set the row no longer matches.
    const explained = db.prepare(
      `UPDATE messages SET content = ? WHERE role = 'assistant' AND (content IS NULL OR trim(content) = '')
         AND (tool_calls LIKE '%Interrotto%' OR blocks LIKE '%Interrotto%')`
    ).run(INTERRUPTED_MARKER);
    if (explained.changes > 0) console.log(`[boot] added interruption explanation to ${explained.changes} message(s)`);
  } catch (e) {
    console.warn(`[boot] finalizeOrphanedRunningTools failed:`, e);
  }
}
finalizeOrphanedRunningTools();

// Stale stream cleanup
const STALE_STREAM_CHECK_INTERVAL_MS = 30_000;
const STALE_STREAM_TIMEOUT_MS = 3 * 60 * 1000;
// One rescue round per silent stream: the sweeper's 3-min silence has two
// causes, a dead turn and a turn we stopped HEARING (a broker attachment lost
// to a socket reconnect / a spawn acked without an attach — the child keeps
// working and the store keeps filling, we just get nothing). Declaring the
// second one dead is how a live turn ended as "nessuna attività per 3 minuti"
// while it was still running. So when the provider vouches the child is ALIVE
// we spend one round asking it to re-attach; if the next tick is still silent
// we finalize as before. Bounded (one extra 3-min round), and the entry is
// dropped as soon as the stream leaves the map.
const staleStreamRescued = new Set<string>();
const staleStreamTimer = setInterval(() => {
  const now = Date.now();
  for (const key of staleStreamRescued) if (!activeStreams.has(key)) staleStreamRescued.delete(key);
  for (const [sessionKey, stream] of activeStreams.entries()) {
    if (!activeStreams.has(sessionKey)) continue;
    // Fast path — DB says the partial assistant message is already finalized
    // but the in-memory entry lingered (lost cleanup in some endStream path).
    // Drop it silently: nobody is mid-stream to notify, and leaving it would
    // cause ghost `stream:catchup` events on future WS reconnects.
    const partial = getMessageById(stream.messageId);
    if (!partial || partial.partial !== true) {
      activeStreams.delete(sessionKey);
      continue;
    }
    // Un turno fermo su una domanda all'umano è silenzioso PER DESIGN: il
    // figlio è bloccato sulla risposta JSON-RPC del bridge e non produce un
    // byte finché nessuno clicca. Questo sweeper contava quel silenzio come
    // morte e a 3 minuti chiudeva il turno con "nessuna attività per 3 minuti"
    // — lasciando però il pannello cliccabile, perché `endStream` finalizza i
    // tool 'running' e non i `waiting_for_input`. Risultato osservato su
    // topic:ed2070df: una domanda a schermo da 22 minuti accanto a un bottone
    // Retry, cioè un pannello vivo su un turno che non esisteva più.
    //
    // Il watchdog del provider (claude-code.ts, 30 min) ha già esattamente
    // questa esenzione; qui mancava. L'esenzione è a tempo — l'età della
    // domanda, non un "per sempre" — e vale solo finché il provider giura che
    // il figlio è VIVO: se muore mentre il pannello è su, nessuna gamba di
    // poll arriva più e niente, dentro il bridge, se ne accorgerebbe.
    // `humanHoldAgeMs`, non `pendingAskAgeMs`: i silenzi legittimi sono DUE —
    // una domanda a schermo e una richiesta di PERMESSO a schermo — e questo
    // spazzino conosceva solo il primo. È il difetto che ha ucciso il turno
    // dell'8 agosto sotto un pannello di permesso aperto, ed è nominato per
    // nome nella docstring di `human-hold.ts`, che elenca proprio «lo spazzino
    // degli stream fermi» fra i sei posti che devono interrogare UNA cosa sola.
    // Il tetto resta a tempo e resta condizionato al «figlio VIVO»: un pannello
    // su una sessione morta non deve disarmare niente.
    const askAge = humanHoldAgeMs(sessionKey);
    if (askAge !== null) {
      const askProv = getProvider("claude-code") as { isTurnProcessAlive?: (sk: string) => boolean } | undefined;
      const verdict = pendingAskVerdict({
        askAgeMs: askAge,
        askTtlMs: ASK_TTL_MS,
        childAlive: askProv?.isTurnProcessAlive?.(sessionKey),
      });
      if (verdict === "defer") {
        ctx.updateStreamActivity(sessionKey);
        continue;
      }
      // La domanda non è più onorabile (figlio morto sotto il pannello, o TTL
      // scaduto): chiudila — così chi è bloccato fallisce pulito — e lascia
      // che il turno venga finalizzato qui sotto come ogni altro stream morto.
      console.warn(`[StaleStream] ${sessionKey} aveva una domanda a schermo non più onorabile — chiudo l'ask e finalizzo`);
      cancelAsk(sessionKey, "il processo del turno è morto mentre la domanda era a schermo");
    }
    const lastActivity = new Date(stream.lastActivity).getTime();
    if (now - lastActivity > STALE_STREAM_TIMEOUT_MS) {
      if (!staleStreamRescued.has(sessionKey)) {
        const prov = getProvider("claude-code") as {
          isTurnProcessAlive?: (sk: string) => boolean;
          resyncStream?: (sk: string) => Promise<boolean>;
        } | undefined;
        if (prov?.isTurnProcessAlive?.(sessionKey)) {
          staleStreamRescued.add(sessionKey);
          console.warn(`[StaleStream] ${sessionKey} silent for 3 min but its child is ALIVE — re-attaching the stream and granting one more round before finalizing`);
          prov.resyncStream?.(sessionKey)
            .catch((err) => console.warn(`[StaleStream] resync failed for ${sessionKey}:`, err));
          // Push lastActivity forward so the rescue gets a full round to land;
          // real output re-bumps it and the stream leaves this path entirely.
          ctx.updateStreamActivity(sessionKey);
          continue;
        }
      }
      console.log(`[StaleStream] Auto-clearing stale stream for ${sessionKey}`);
      staleStreamRescued.delete(sessionKey);
      const topicId = ctx.getTopicBySessionKey(sessionKey)?.id;
      // Finalize any tool call left 'running'. Previously the sweeper did a bare
      // `activeStreams.delete`, bypassing endStream — so a hung tool kept its
      // spinner ticking forever (observed: a tool "running" for 2h+ at session
      // end). endStream marks them interrupted + stamps endedAt (and deletes the
      // in-memory entry); we broadcast so LIVE clients stop the spinner without a
      // reload.
      const interrupted = ctx.endStream(sessionKey);
      for (const tc of interrupted) {
        broadcastToAll({ type: "stream:tool_result", sessionKey, topicId, toolCallId: tc.id, status: "error", result: "", error: tc.error, endedAt: tc.endedAt });
      }
      // Non-destructive content finalize. A genuinely stale partial means the turn
      // died without a clean `result` (detached/orphaned/wedged process). Do NOT
      // just flip `partial = 0` — a turn that streamed only tool calls (no final
      // prose) would be left as a blank bubble that the client then hides, which
      // is the "message streams then disappears" bug. If no prose was streamed,
      // drop in an explicit interrupted marker so the user sees WHAT happened;
      // any tool blocks are untouched and still render below it.
      const hadProse = typeof partial.content === "string" && partial.content.trim().length > 0;
      if (hadProse) {
        db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE id = ?", [stream.messageId]);
      } else {
        const marker = "⚠️ Risposta interrotta: nessuna attività per 3 minuti (il processo potrebbe essersi bloccato o disconnesso). Riprova.";
        db.run("UPDATE messages SET partial = 0, streamed_at = NULL, content = ? WHERE id = ?", [marker, stream.messageId]);
      }
      // Il turno è morto senza un `result` pulito: chi lo sta guidando (il
      // dispatcher) deve leggere "fermato dal watchdog", non la fine di default.
      recordTurnEnd(sessionKey, cancelled("watchdog", "stale stream sweep"));
      broadcastToAll({ type: "stream:end", sessionKey, topicId, reason: "stale_timeout", stopReason: "cancelled", stopCause: "watchdog" });
      // Sveglia il client HTTP. Il broadcast sopra parla ai soli spettatori WS:
      // chi ha MANDATO il messaggio sta leggendo la risposta SSE, e quel canale
      // scarta per contratto gli eventi WS della propria sessione. Senza questo
      // abort la sua richiesta resta aperta su un turno che qui abbiamo appena
      // dichiarato morto — la chat continua a mostrare i puntini finché non
      // ricarica la pagina. La route ci ha lasciato l'AbortController apposta.
      try { stream.abortController?.abort(); } catch (err) { console.warn(`[StaleStream] abort SSE fallito per ${sessionKey}:`, err); }
    }
  }
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
taskDispatcher.reconcile().catch((err) => console.error("[dispatcher] boot reconcile failed", err));
const dispatchTimer = setInterval(() => {
  taskDispatcher.reconcile().catch((err) => console.error("[dispatcher] poll reconcile failed", err));
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
  try {
    for (const id of orphanBoardChildSessions(ctx.db)) retireTerminalSession(id);
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
        const prov = getProvider("claude-code") as { brokerTurnState?: (sk: string, opts?: { park?: boolean }) => Promise<"open" | "idle" | "unknown"> } | undefined;
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
            const prov = getProvider("claude-code") as { brokerTurnState?: (sk: string) => Promise<"open" | "idle" | "unknown"> } | undefined;
            const state = await prov?.brokerTurnState?.(s.id).catch(() => "unknown" as const);
            if (state === "open") {
              console.log(`[chat-reattach] ${s.id}: la gamba è finita ma il turno è ancora aperto (domanda a schermo) — la riga resta viva`);
              return;
            }
          } catch { /* nessuna risposta dal broker: si pulisce, come prima */ }
          // The turn is over (completed, died, or timed out): clear any
          // partial leftovers for the session — including the pre-reload row
          // the startup reset deliberately skipped while the child was alive.
          try { ctx.db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1", [s.id]); } catch { /* next boot's reset catches it */ }
        });
      continue;
    }
    // Idle / archived / deleted-topic session: reap. Guard against a send
    // that raced in during boot and already owns the child.
    try {
      const prov = getProvider("claude-code") as { isTurnProcessAlive?: (sk: string) => boolean } | undefined;
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

// Chain reconcile AFTER reattach: reattach adopts survivors (keeps their broker
// child alive → they stay in the alive-set → reconcile skips them) and reaps
// idle children (so reconcile's fresh list sees them dead → demotes their
// phantom phase). Running it after avoids a race where a just-reaped session is
// still listed alive. The orphaned-transcript sweep runs last: reattach has by
// then re-homed every survivor, so a missing transcript is proof of a dead cwd,
// not of an unfinished adopt.
reattachSurvivingChatTurns()
  .then(() => reconcileOrphanedBusyPhases())
  .then(() => reconcileOrphanedTranscripts())
  .then(() => reconcileArchivedTopicSessions())
  .catch((err) => console.error("[chat-reattach] boot sweep failed", err));

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
async function backfillDeliveries(): Promise<void> {
  const rows = ctx.db.prepare(
    `SELECT id FROM tasks
      WHERE archived = 0 AND delivery_commit IS NULL AND status IN ('review', 'done')`,
  ).all() as Array<{ id: string }>;
  for (const row of rows) {
    const wt = worktreeOfTask(row.id);
    if (!wt || wt.mode !== "branch" || !wt.branchName) continue;
    const repoPath = ctx.projectStore.get(wt.projectId)?.path;
    if (!repoPath) continue;
    // Stessa domanda della cattura in review: il commit PROPRIO più recente, non
    // la punta del ramo — altrimenti questo giro riscriverebbe ogni 30 minuti il
    // lavoro di un'altra sessione sopra le card senza consegna.
    // Awaited: the audit right below must see what we just recorded, otherwise
    // a backfilled task waits a full interval for its first verdict.
    const ptr = await deliveryPointer(repoPath, wt.branchName).catch(() => null);
    // Niente commit propri (o domanda senza risposta): non si scrive niente e si
    // riprova al giro dopo — se intanto l'altro branch landa o sparisce, la
    // stessa domanda cambia risposta da sola.
    if (ptr?.commit) dispatcherSvc.recordDelivery({ taskId: row.id, branch: ptr.branch, commit: ptr.commit });
  }
}

const LANDING_AUDIT_INTERVAL_MS = 30 * 60_000;

/**
 * Le dipendenze dell'audit, meno la lista di chi guardare — così la passata
 * periodica e il timbro su UNA card fanno lo stesso conto. Se divergessero, il
 * verdetto istantaneo dopo un land e quello del giro dopo potrebbero
 * contraddirsi, e il semaforo tornerebbe a non voler dire niente.
 *
 * `announce` è l'unica differenza legittima: la passata deve DIRE sulla card
 * che una consegna non è su main (una riga, datata); il timbro post-land no —
 * lì il thread ha appena scritto perché il land non è riuscito, e ripeterlo
 * sarebbe il commento numero due sullo stesso fatto.
 */
function landingAuditDeps(listCandidates: () => AuditTask[], announce: boolean) {
  // `tasks.project_id` is the BOARD id — `projectIdForPath(path)`, a one-way
  // hash — not a ProjectStore UUID. Asking the store for it returns undefined
  // for every real board, and the audit reads a missing repo as "can't tell":
  // wired that way the counter sat on `unverifiable` forever and could never
  // catch the failure it exists for. Invert the hash the way the dispatcher
  // does (resolveProject), building the candidate list ONCE per sweep — it
  // scans the workspace dir, and re-scanning it per task buys nothing.
  const candidates = buildProjectCandidates({
    projectStore: ctx.projectStore,
    workspaceDir: DISPATCH_WORKSPACE_DIR,
    extraPaths: dispatchExtraPaths,
  });
  // L'indice delle righe di main costa una `git grep` dell'intero albero, e la
  // paga UNA volta per repo per passata: le card di una board stanno tutte nello
  // stesso checkout, e senza cache l'avrebbero pagata una a testa.
  const indici = new Map<string, ReadonlySet<string>>();
  const indiceDi = async (repoPath: string): Promise<ReadonlySet<string>> => {
    const gia = indici.get(repoPath);
    if (gia) return gia;
    const nuovo = await indiceRigheMain(repoPath);
    indici.set(repoPath, nuovo);
    return nuovo;
  };
  return {
    listCandidates,
    repoPath: (projectId: string) => resolveProjectPath(projectId, candidates)?.path ?? null,
    commitStatus: (repoPath: string, commit: string) => commitStatusFromRepo(repoPath, commit),
    // La seconda domanda, solo su chi la prima ha già dato per fuori: è lo
    // STESSO conto di `report:landed`, che è il modo in cui la misura a mano e la
    // pastiglia sulla card non possono più dire due cose diverse.
    debtVerdict: async (task: AuditTask, repoPath: string): Promise<LandingState> => {
      const indiceMain = await indiceDi(repoPath);
      // Col ramo ancora vivo si può chiedere tutto (patch inversa, conflitto,
      // supersessione); potato il ramo resta la sola domanda sul contenuto.
      const verdetto = task.deliveryBranch && (await branchExistsInRepo(repoPath, task.deliveryBranch))
        ? await classifyBranchLanding(repoPath, task.deliveryBranch, { indiceMain })
        : await classifyCommitLanding(repoPath, task.deliveryCommit ?? "", { indiceMain });
      return classifyLandingEsito(verdetto.esito);
    },
    record: (taskId: string, state: LandingState, checkedAt: string) =>
      dispatcherSvc.recordLandingState({ taskId, state, checkedAt }),
    previousState: (taskId: string) => dispatcherSvc.get(taskId)?.task.landingState ?? null,
    // The whole point: a delivery that never reached main must SAY so, on the
    // task, once — not sit silently in a column for 8 days.
    onNewlyUnlanded: announce
      ? (task: AuditTask) => {
          try {
            dispatcherSvc.addComment({
              taskId: task.id, author: "system",
              // Una riga, non un paragrafo: lo STATO ha già una banda in cima al
              // drawer e un badge sulla card (`landingState`), e questo commento
              // serve solo a datare il momento in cui è successo. Ripeterci sopra
              // l'intera spiegazione, a ogni oscillazione, era la parte brutta —
              // 128 commenti su 97 card, uno lungo tre righe.
              content: `Non è su main: \`${task.deliveryCommit?.slice(0, 8)}\`${task.deliveryBranch ? ` (${task.deliveryBranch})` : ""} — landa il ramo prima che venga potato.`,
            });
            const fresh = dispatcherSvc.get(task.id)?.task;
            if (fresh) broadcastToAll({ type: "task:updated", projectId: task.projectId, task: fresh });
          } catch (err) { console.warn("[landing-audit] comment failed", err); }
        }
      : undefined,
    now: () => new Date().toISOString(),
    log: (msg: string) => console.log(msg),
  };
}

async function runLandingAudit() {
  await backfillDeliveries().catch((err) => console.warn("[landing-audit] backfill failed", err));
  return auditLandings(
    landingAuditDeps(() => dispatcherSvc.listLandingAuditCandidates(), /*announce*/ true),
  ).catch((err) => { console.error("[landing-audit] sweep failed", err); return null; });
}

/**
 * Il verdetto DEDOTTO per UNA card, subito. Lo chiama il land (`stampLanding`)
 * quando l'esito non l'ha visto lui — nessun ramo da guardare, o «non c'era
 * niente da portare». Dove invece l'ha visto scrive il fatto e non passa di
 * qui: una deduzione sopra una testimonianza è un declassamento.
 */
async function auditOneLanding(taskId: string): Promise<void> {
  const t = dispatcherSvc.get(taskId)?.task;
  if (!t?.deliveryCommit) return; // niente fotografia della consegna: niente da verificare
  const one: AuditTask = {
    id: t.id, projectId: t.projectId,
    deliveryBranch: t.deliveryBranch ?? null, deliveryCommit: t.deliveryCommit,
  };
  await auditLandings(landingAuditDeps(() => [one], /*announce*/ false))
    .catch((err) => { console.warn("[landing-audit] verdetto singolo fallito", err); return null; });
}
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
const QUIESCENCE_CAP_MS = 5 * 60_000;
async function waitForDispatcherQuiescent(label: string, capMs = QUIESCENCE_CAP_MS): Promise<void> {
  const deadline = Date.now() + capMs;
  let logged = false;
  while (taskDispatcher.busyCount() > 0) {
    if (Date.now() >= deadline) {
      console.warn(`[quiescence] ${label}: ${taskDispatcher.busyCount()} turn(s) still in flight after ${Math.round(capMs / 1000)}s — proceeding anyway (reload-resilience will resume them)`);
      return;
    }
    if (!logged) {
      console.log(`[quiescence] ${label}: waiting for ${taskDispatcher.busyCount()} in-flight turn(s) to finish before restart`);
      logged = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (logged) console.log(`[quiescence] ${label}: all turns finished — proceeding with restart`);
}

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
  await stopAllProviders();
  closeDatabase();
  releaseLock();
  process.exit(0);
}

// Init is complete: repoint the early-registered signal listeners (top of
// file) from the exit-clean stub to the real teardown.
onTermSignal = (signal) => { void gracefulShutdown(signal); };
