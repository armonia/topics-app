/**
 * The first batch of API routers (topics, files, browser, terminal, auth, billing, ...) and the guest/identity wiring they share.
 */
import { join } from "path";
import { announceTurnEnded } from "../lib/turn-ended";
import { cutTurnResumable, riprendiTurniInterrotti } from "../lib/ripresa-boot";
import { createResumeSweepClock } from "../lib/resume-sweep-clock";
import type { WSData } from "../types";
import { createTopicsRouter, purgeTopicFromUiState, reopenDepsFor } from "../routes/topics";
import { createOrchestratorSessionsRouter } from "../routes/orchestrator-sessions";
import { archiveTopicFully, reopenTopicFully } from "../services/archive-topic";
import { clearRetirement, recordRetirement, type ReconcileDeps } from "../services/retirement";
import { isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";
import { tabCloseArchives } from "../lib/tab-close-policy";
import { parkTopicSession } from "../lib/session-parking";
import { buildStreamCatchupFrame } from "../lib/stream-catchup-frame";
import { flushTurnBody } from "../lib/turn-body-flush";
import { createVoiceRouter } from "../routes/voice";
import { createMediaRouter } from "../routes/media";
import { createBranchesRouter } from "../routes/branches";
import { createFilesRouter } from "../routes/files";
import { createBrowserRouter } from "../routes/browser";
import { createCronRouter } from "../routes/cron";
import { createContextRouter } from "../routes/context";
import { createUsageRouter } from "../routes/usage";
import { createHubRouter, upstreamBase, HUB_DEFAULT_URL } from "../routes/hub";
import { createHubLive } from "../lib/hub-live";
import { isThisServerPrimary } from "../lib/primary-role";
import { createWaitingStore } from "../attention/waiting-items";
import { createTerminalRouter, setTerminalBrowserCloser, retireTerminalSession } from "../routes/terminal";
import { createStatusRouter } from "../routes/status";
import { createMemoryRouter } from "../routes/memory";
import { createMcpRouter } from "../routes/mcp";
import { createSessionEnvironmentRouter } from "../routes/session-environment";
import { createCheckpointsRouter } from "../routes/checkpoints";
import { createGoalsRouter } from "../routes/goals";
import { createPlanRouter } from "../routes/plan";
import { createContextPreviewRouter } from "../routes/context-preview";
import { listOwnedScripts, commandWakeState, createProcessesRouter, stopCommandWakesOf, stopTopicCommandProcesses } from "../routes/processes";
import { killProcessTree } from "../lib/process-tree";
import { buildProjectCandidates, isSelectableProjectDir } from "../services/project-path-resolver";
import { homedir } from "os";
import { createWebrtcBridge } from "../webrtc-bridge";
import { countSharedViewers, hasAttachedPane } from "../browser-viewer-count";
import { createDashboardRouter } from "../routes/dashboard";
import { createAuthRouter } from "../routes/auth";
import { refreshSocketPrincipal, socketMayReceiveFrame, socketMayReadTopic } from "../lib/socket-principals";
import { leggiInstallationId } from "../services/relay-config";
import { creaServizioLicenza } from "../lib/licenza";
import { createLicenseRouter } from "../routes/license";
import { createBillingRouter } from "../routes/billing";
import { createAccountRouter } from "../routes/account";
import { createPeopleRouter } from "../routes/people";
import { tryGetProvider } from "../providers";
import { sessionHasBackgroundWork } from "../providers/background-probes";
import { configureNativeSubagents } from "../lib/native-subagents";
import { defaultLifecycleHooks } from "../services/lifecycle-hooks";
import { setClosed } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import type { Complete } from "../services/voice-call/brain";
import { revokeRemoteDelegatedCapability } from "../routes/machines";
import type { AfterTracker } from "./scope";
import { late } from "./late";

export function bootRoutersFirst(scope: AfterTracker) {
  const { activeStreams, broadcastToAll, browserService, browserWsClients, claudeSessionTracker, ctx, domHosts, getMessageById, turnLedger, wsClients } = scope;
  // Shared-session WebRTC transport broker (spawns the Rust sidecar lazily on first
  // offer; no-op when its binary is missing → clients fall back to the JPEG stream).
  const webrtcBridge = createWebrtcBridge();


  // Create route handlers
  // "Is a pane attached to this contextId?" An open `/ws/browser/<ctx>` socket
  // is the closest the server gets to "the pane is mounted": the headless
  // context exists without any pane. A native pane's executor socket counts only
  // once it registered, because `open-pane` navigates right after this answers
  // yes (browser-viewer-count.ts, `hasAttachedPane`). `open-pane` also uses it to
  // arm the `browser:force-open` fallback and to answer `visible` truthfully.
  const paneAttachedTo = (contextId: string): boolean => hasAttachedPane(browserWsClients.get(contextId));

  const topicsRouter = createTopicsRouter(ctx, browserService, paneAttachedTo, {
    hooks: defaultLifecycleHooks(),
    exposeGoalLoop: (l) => { late.goalLoop = l; },
    exposeAnswerRelay: (r) => { late.answerRelay = r; },
    stopTopicProcesses: stopTopicCommandProcesses,
  });

  const orchestratorSessionsRouter = createOrchestratorSessionsRouter(ctx);

  const filesRouter = createFilesRouter(ctx);

  const voiceRouter = createVoiceRouter(ctx);

  const mediaRouter = createMediaRouter(ctx);

  const branchesRouter = createBranchesRouter(ctx);

  // Chi conta come spettatore sta in browser-viewer-count.ts (puro, con i suoi
  // test): esclude i delegati nativi e chi ha la pane fuori dallo schermo, e NON
  // guarda la pausa dello screencast — vedi lì il perché.
  const browserRouter = createBrowserRouter(
    ctx, browserService, (c) => countSharedViewers(browserWsClients.get(c)), domHosts,
  );

  const cronRouter = createCronRouter(ctx);

  const contextRouter = createContextRouter(ctx);

  const terminalRouter = createTerminalRouter(ctx, claudeSessionTracker);

  // `spawn_agent` children on the Topics engine (openspec/changes/subagent-nativi):
  // a chat of their own, whose turns go through the chat route in this process.
  configureNativeSubagents({
    route: topicsRouter,
    isBusy: (sk) => activeStreams.has(sk),
    getTopicBySessionKey: ctx.getTopicBySessionKey,
    saveTopic: (topic, created) => {
      ctx.saveSingleTopic(topic);
      ctx.broadcastToAll({ type: created ? "topic:created" : "topic:updated", topic });
      // An archived child also leaves the attention rows: no badge left on a chat nobody sees.
      setClosed(topicSubject(topic.id), { archived: !!topic.archived });
    },
    loadMessages: (sk) => ctx.loadLocalMessages(sk),
    engineReady: () => tryGetProvider("topics")?.connected === true,
    // The same door as every archive: unread, ui_state, parked session, open ask.
    archive: (topic) => retirementConsequences.archiveTopic(topic.id, "subagent-end"),
    // And the unarchive's door to come back: flag, ui_state markers, retirement fact.
    reopen: (topic) => { reopenTopicFully(reopenDepsFor(ctx, ctx.broadcastToAll), topic.id); },
    // Its own children are read by the module itself (`subagentWakeState`).
    backgroundWork: (sk) => commandWakeState(sk) !== "none" || sessionHasBackgroundWork(sk),
    stopBackgroundWork: (sk) => { stopCommandWakesOf(sk); },
    log: (m) => console.log(`[subagent-native] ${m}`),
    // The resume's own verdict (declared below, read only after the boot).
    cutTurnResumable: (sk) => cutTurnResumable(late.resumeCtx, sk),
  });

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

  // The same list the board index uses, so the Plan names projects the way the Kanban does.
  const planRouter = createPlanRouter(ctx, { listProjectDirs: () => listSelectableProjectDirs() });

  // Always-on: serves /api/topics/:id/context-preview and /context-snapshots.
  // Independent of which provider is the default — every provider benefits
  // from the canonical envelope inspector (change `topic-context-canonical`).
  const contextPreviewRouter = createContextPreviewRouter(ctx);

  const dashboardRouter = createDashboardRouter(ctx);


  // The usage hub's quotas, Mac and services, read by ONE reader while a window
  // is connected and pushed as `hub:live` (server/lib/hub-live.ts).
  const waiting = createWaitingStore({ file: join(ctx.APP_DATA_DIR, "waiting-items.json") });
  const hubLive = createHubLive({
    waiting,
    base: () => upstreamBase("TOPICS_HUB_URL", HUB_DEFAULT_URL),
    broadcast: (frame) => broadcastToAll(frame),
    // Only the primary reads the usage hub on its timer. Asked on every beat, not once at boot:
    // a node adopts a new primary's epoch while it runs.
    hasClients: () => wsClients.size > 0 && isThisServerPrimary(),
  });

  hubLive.start();

  const hubRouter = createHubRouter(ctx, { live: hubLive, waiting });
  const usageRouter = createUsageRouter(ctx, { waiting });

  const authRouter = createAuthRouter(ctx, {
    onCapabilityRevoked: async (capabilityId) => {
      const canceled = await late.taskDispatcher.revokeDelegatedCapability(capabilityId);
      await revokeRemoteDelegatedCapability(ctx, capabilityId);
      return canceled;
    },
  });


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
  /**
   * The brain of the phone calls: `complete()` of the provider named by
   * TOPICS_VOICE_BRAIN_PROVIDER, or of the default one. Resolved at each call,
   * so a provider that comes up later is used from the next call.
   */
  const voiceBrainDoor = (): Complete | null => {
    const p = tryGetProvider(process.env.TOPICS_VOICE_BRAIN_PROVIDER?.trim() || undefined);
    return p ? (messages, options) => p.complete(messages, options) : null;
  };


  const identityByRequest = new WeakMap<Request, {
    role: 'owner' | 'guest';
    deviceId: string | null;
    principal: NonNullable<WSData["principal"]> | null;
    delegatedAuthorizationId?: string;
    delegatedCapabilityId?: string;
  }>();

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
  /**
   * The `stream:catchup` frames of the turns in flight whose topic `wants`.
   *
   * Trust the DB's `partial` flag as single source of truth: if the assistant
   * message was already finalized, the stream is over even though
   * `activeStreams` still has a stale entry (an `endStream` path that skipped
   * cleanup, a broadcast lost before this client reconnected). A catch-up there
   * would wedge the client's `streaming` state on for up to 3 min until the
   * watchdog clears it: random ghost spinners on chat tabs.
   *
   * The row is WRITTEN before it is read. Its `blocks`, the timeline the bubble
   * draws, go through a throttle that can be 15 s behind the stream, while
   * `content` comes from memory: the newcomer drew a timeline without its last
   * chunks, the frames after it appended, and the bubble kept a hole for the
   * rest of the turn (card 423e016f). `flushTurnBody` is the writer's own flush.
   *
   * The shape of the payload lives in `buildStreamCatchupFrame`: the legacy
   * `toolCalls` bucket is dropped when the blocks carry the same calls, and the
   * calls that are OVER travel with their large text blanked. Why, and what
   * stays whole, is documented there; the budget is
   * tests/integration/catchup-payload-weight.test.ts.
   */
  function streamCatchupFrames(wants: (topicId: string | undefined) => boolean): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = [];
    for (const [sessionKey, stream] of activeStreams.entries()) {
      const topicId = ctx.getTopicBySessionKey(sessionKey)?.id;
      if (!wants(topicId)) continue;
      flushTurnBody(sessionKey);
      const partial = getMessageById(stream.messageId);
      if (!partial || partial.partial !== true) {
        activeStreams.delete(sessionKey);
        turnLedger.set(sessionKey, "route", false);
        announceTurnEnded(sessionKey);
        continue;
      }
      frames.push(buildStreamCatchupFrame({ sessionKey, topicId, stream, partial }));
    }
    return frames;
  }


  /**
   * May a guest device receive this frame? The rule of every fan-out, named so a
   * frame sent to ONE socket outside the fan-outs goes through the same door.
   */
  ctx.setGuestBroadcastFilter({
    refreshSocketPrincipal(data) { refreshSocketPrincipal(ctx.db, data); },
    mayReceiveFrame(data, message) { return socketMayReceiveFrame(ctx.db, data, message); },
    // Le fan-out per topic non portano l'entità NEL frame: ce l'hanno come
    // argomento. Qui quindi si guarda il topic che si sta per consegnare, non
    // quello che il frame dichiara — molti di quei frame non lo nominano affatto.
    mayReadTopic(data, topicId) { return socketMayReadTopic(ctx.db, data, topicId); },
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
  const DISPATCH_WORKSPACE_DIR = join(ctx.APP_DATA_DIR, "workspace");


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


  /**
   * The dirs that are actually SELECTABLE boards: the dispatcher's union minus
   * internal catch-all plumbing, the home dir, config dot-dirs and vanished paths.
   */
  function listSelectableProjectDirs(): string[] {
    return buildProjectCandidates({
      projectStore: ctx.projectStore,
      workspaceDir: DISPATCH_WORKSPACE_DIR,
      extraPaths: dispatchExtraPaths,
    })
      .map((c) => c.path)
      .filter((p) => isSelectableProjectDir(p, { workspaceDir: DISPATCH_WORKSPACE_DIR, homeDir: homedir() }));
  }


  /**
   * Le conseguenze di un ritiro, legate una volta sola.
   *
   * Le usano tre chiamanti — la potatura dei topic dei tentativi (dispatcher), la
   * cascata di una tab chiusa e il riconcilio al boot. Se ognuno se le ricablasse,
   * saremmo di nuovo dove il task e' cominciato: tre posti che dicono cosa
   * significa «chiuso», e nessuno d'accordo con gli altri due.
   */
  const retirementConsequences: ReconcileDeps = {
    archiveTopic: (topicId, reason = "system") => {
      // The singleton has a durable transcript and must survive closing its
      // ordinary ChatPanel. Keep the raw registry identity here: even a damaged
      // backing Topic must never fall back into generic cleanup/archival.
      if (isGlobalOrchestratorTopic(ctx.db, topicId)) {
        clearRetirement(ctx.db, "topic", topicId);
        return;
      }
      const res = archiveTopicFully({
        getTopicById: ctx.getTopicById,
        saveSingleTopic: ctx.saveSingleTopic,
        loadUnread: ctx.loadUnread,
        saveUnreadEntries: ctx.saveUnreadEntries,
        broadcastToAll: ctx.broadcastToAll,
        purgeFromUiState: (id) =>
          purgeTopicFromUiState(ctx.db, ctx.broadcastToAll, id, (c) => browserService.destroyContext(c)),
        parkClaudeSession: parkTopicSession,
        recordRetirement: (id, at) => recordRetirement(ctx.db, "topic", id, at, reason),
        stopProcesses: stopTopicCommandProcesses,
      }, topicId);
      // Nessuna risposta HTTP da restituire qui: la purge fallita si logga, non
      // può fermare il ritiro (il task è finito comunque).
      if (res.purgeError) {
        console.error(`[archive] purge di ui_state fallita per topicId=${topicId}:`, res.purgeError);
      }
    },
    shouldRetireTopic: (topicId) => !isGlobalOrchestratorTopic(ctx.db, topicId),
    tabCloseArchives: () => tabCloseArchives(ctx.db),
    restoreTopic: (topicId) => {
      if (!isGlobalOrchestratorTopic(ctx.db, topicId)) return;
      const topic = ctx.getTopicById(topicId);
      if (!topic) return;
      clearRetirement(ctx.db, "topic", topicId);
      if (!topic.archived) return;
      topic.archived = false;
      topic.updatedAt = new Date().toISOString();
      ctx.saveSingleTopic(topic);
      setClosed(topicSubject(topicId), { archived: false });
      ctx.broadcastToAll({ type: "topic:archived", topic });
      ctx.broadcastToAll({ type: "topic:updated", topic });
    },
    retireTerminal: (sessionId) => { retireTerminalSession(sessionId, 'closed', 'topic-retirement'); },
  };


  // The periodic sweep and the early one after a cut (lib/resume-sweep-clock.ts).
  const resumeSweepClock = createResumeSweepClock(() => riprendiTurniInterrotti(late.resumeCtx, topicsRouter));

  function nudgeResumeSweep(): void {
    resumeSweepClock.nudge();
  }

  return { DISPATCH_WORKSPACE_DIR, accountRouter, authRouter, billingRouter, branchesRouter, browserRouter, checkpointsRouter, contextPreviewRouter, contextRouter, cronRouter, dashboardRouter, dispatchExtraPaths, filesRouter, goalsRouter, hubRouter, identityByRequest, licenseRouter, licenzaSvc, listSelectableProjectDirs, mcpRouter, mediaRouter, memoryRouter, nudgeResumeSweep, orchestratorSessionsRouter, peopleRouter, planRouter, processesRouter, resumeSweepClock, retirementConsequences, sessionEnvironmentRouter, statusRouter, streamCatchupFrames, terminalRouter, topicsRouter, usageRouter, voiceBrainDoor, voiceRouter, webrtcBridge };
}
