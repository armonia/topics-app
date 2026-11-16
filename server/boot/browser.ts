/**
 * Browser wiring: presence, the per-context WebSocket fan-out, the DOM host mirror, the UI-state repairs, the AI provider and the browser service.
 */
import { configureApiCredentialRoot, readApiProviderKey } from "../services/api-provider-credentials";
import type { ServerWebSocket } from "bun";
import type { WSData } from "../types";
import { purgeOrphanTopicRefs } from "../services/ui-state-orphan-cleanup";
import { repairCanonicalPaneState } from "../services/ui-state-canonical-repair";
import { sweepArchivedTaskBrowserState } from "../services/task-tab-teardown";
import { runStayLocalSweep } from "../services/stay-local-sweep";
import { createBrowserService } from "../browser-service";
import { agentOwnerTest } from "../providers/agent-cli-priority";
import { clearBrowserCaches } from "../browser-tools-handler";
import { resetMoondreamCounter } from "../integrations/moondream-client";
import { type BrowserWsMessage } from "../../shared/browser-ws-messages";
import { nativeDelegateRegistry } from "../browser-native-delegate";
import { createDomHostRegistry } from "../lib/native-dom-host";
import { createHostMirror, type MirrorSocket } from "../browser-host-mirror";
import { createBrowserHostBootRace } from "../browser-host-boot-race";
import { createNativeHostLiveness } from "../browser-native-host-liveness";
import { createViewerActions } from "../browser-viewer-actions";
import { countSharedViewers, createViewerCountPublisher } from "../browser-viewer-count";
import { createViewportWiring } from "../browser-viewport-wiring";
import { buildPresenceSnapshot } from "../presence";
import { initProvider } from "../providers";
import { assertUiStateMigrationApplied } from "../routes/ui-state";
import { resolveAiProvider } from "../services/app-settings";
import type { AfterCore } from "./scope";

export async function bootBrowser(scope: AfterCore) {
  const { broadcastToAll, browserWsClients, ctx, db, wsClients } = scope;
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


  // The Mac's native pane as the source of a context's DOM mirror: every viewer
  // mirrors THAT page and the server's Chromium stays off (browser-host-mirror.ts).
  const domHosts = createDomHostRegistry();

  let notifyHostReady = (_contextId: string): void => {};

  const hostMirror = createHostMirror({
    hosts: domHosts,
    sockets: (c) => browserWsClients.get(c) ?? [],
    browser: { enableDomMode: (c) => browserService.enableDomMode(c), destroyContext: (c) => browserService.destroyContext(c), navigate: (c, u) => browserService.navigate(c, u), getUrl: (c) => browserService.getUrl(c) },
    askViewport: (c) => {
      const driver = viewportWiring.driverDevice(c);
      if (driver) viewportWiring.askViewportOf(c, driver);
    },
    onHostReady: (c) => notifyHostReady(c),
  });


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


  // Who owns the viewport of a shared context: the DEVICE of the last input, or
  // the first one that showed up while nobody has touched the page. The rule
  // lives in server/browser-viewport-arbiter.ts and the translation from socket
  // to claimant in server/browser-viewport-wiring.ts; here the wiring is only
  // called on the five events that move it (open, native registration, input,
  // resize, close).
  const viewportWiring = createViewportWiring({
    socketsOf: (contextId) => browserWsClients.get(contextId),
    // THE ONLY DOOR to the viewport of a shared page, and the question that
    // guards it is INSIDE `onFrame`, not next to it. It used to be here, as
    // `if (!onResize(...)) return;` followed by the call: two reviews found that
    // dropping the `if` or freezing the claim to `false` brought the original bug
    // back with every unit test still green, because nothing but a real Chromium
    // ever read those two lines.
    resize: (contextId, width, height, deviceScaleFactor) => {
      browserService.resize(contextId, width, height, deviceScaleFactor).catch((err) =>
        console.warn(`[WS][browser] resize failed for ${contextId}:`, err.message),
      );
    },
  });


  /** A viewer's size reaches the shared page through the wiring only: from its
   *  socket, or replayed when its wait for the host ends (NATIVE-HOST-06). */
  const resizeFromViewer = (contextId: string, data: MirrorSocket["data"], frame: Extract<BrowserWsMessage, { type: "resize" }>): void => {
    viewportWiring.onFrame(contextId, { ...data, id: data.id ?? "" }, frame);
  };

  const viewerActions = createViewerActions({
    browser: { navigate: (c, u) => browserService.navigate(c, u), setDomEmit: (c, on) => browserService.setDomEmit(c, on) },
    socketsOf: (c) => browserWsClients.get(c),
  });

  const hostBootRace = createBrowserHostBootRace<MirrorSocket>({
    hasSeenHost: (contextId) => hostMirror.hasSeenHost(contextId),
    isHosting: (contextId) => hostMirror.isHosting(contextId),
    apply: (socket, contextId, frame) => {
      if (hostMirror.routeViewer(socket, contextId, frame)) return;
      if (frame.type === "set_render" && frame.mode === "dom") hostMirror.enableChromiumDom(socket, contextId);
      else if (frame.type === "set_render") viewerActions.toVideo(socket, contextId);
      else if (frame.type === "resize") resizeFromViewer(contextId, socket.data, frame);
      else if (frame.type === "nav" && frame.phase === "request") viewerActions.navigate(socket, contextId, frame.url);
    },
  });


  notifyHostReady = (contextId) => hostBootRace.hostReady(contextId);

  const nativeHostLiveness = createNativeHostLiveness<MirrorSocket>({
    onLost: (contextId, socket) => {
      console.warn(`[WS][browser] native host for ${contextId} stopped answering application pings`);
      nativeDelegateRegistry.unregister(contextId, socket);
      browserWsClients.get(contextId)?.delete(socket as never);
      hostMirror.onClose(socket, contextId);
      try { (socket as unknown as ServerWebSocket<WSData>).close(1001, "Native host unresponsive"); } catch { /* handle may already be closed */ }
    },
  });


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


  // Boot-time repair of project panes saved with a raw (symlinked) path: the
  // pane store and its per-project rows move under the canonical path, so the
  // window they open finds the chats the topics are filed under
  // (`services/ui-state-canonical-repair.ts`). Idempotent: no-op when clean.
  try {
    const canonical = repairCanonicalPaneState(db);
    if (canonical.pairs.length > 0) {
      console.log(
        `[Startup] ui_state canonical repair: ${canonical.pairs.length} project pane(s) resolved, ` +
          `${canonical.renamed.length} per-project row(s) renamed, ${canonical.dropped.length} dropped`,
        canonical.pairs,
      );
    } else {
      console.log("[Startup] ui_state canonical repair: clean (every project pane already canonical)");
    }
  } catch (err) {
    // Non-fatal: the read path in routes/ui-state.ts still serves the value canonical.
    console.error("[Startup] ui_state canonical repair failed:", err);
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


  // The permanent "this Mac only" pins, decided once (`services/stay-local-sweep.ts`).
  // A pin with no expiry is never lifted by anything else, so a card whose text
  // names nothing mac-only stays stuck here for good. The sweep clears those and
  // says why on the thread; a card it already decided is left alone, so a person
  // who pins it again keeps the pin.
  try {
    const sweep = runStayLocalSweep(db);
    console.log(
      `[Startup] stay-local sweep: scanned ${sweep.scanned}, cleared ${sweep.cleared}, ` +
        `kept ${sweep.kept}, already decided ${sweep.skipped}`,
    );
  } catch (err) {
    // Non-fatal: a pin that outlives its reason costs a card its mobility, not the boot.
    console.error("[Startup] stay-local sweep failed:", err);
  }


  // Init AI provider — pick the boot default:
  //   1. AI_PROVIDER env override (explicit, always wins)
  //   2. claude (Anthropic SDK) if ANTHROPIC_API_KEY → stateless, sub-friendly,
  //      autonomous: history is rebuilt from the local SQLite messages table on
  //      every turn, so it survives `bun --watch` restarts.
  //   3. openai if OPENAI_API_KEY
  //   4. graceful fallback to "claude" so the picker UI still has a target;
  //      initProviders() below auto-registers anything else available.
  configureApiCredentialRoot(ctx.STATE_DIR);

  const savedClaudeApiKey = readApiProviderKey("claude", ctx.STATE_DIR);

  const savedOpenaiApiKey = readApiProviderKey("openai", ctx.STATE_DIR);

  const requestedProviderType =
    resolveAiProvider() ||
    (savedClaudeApiKey ? 'claude' :
     savedOpenaiApiKey ? 'openai' :
     'claude');


  // Registry IDs are not constructor types. ACP agents are discovered by
  // initProviders below; their saved default wins once registered. Boot must
  // remain possible even when an optional runtime is no longer installed.
  const providerType = requestedProviderType === 'topics' ? 'native'
    : ['openai', 'claude', 'claude-code', 'codex', 'native'].includes(requestedProviderType)
      ? requestedProviderType : 'claude';


  const aiProvider = initProvider({
    type: providerType,
    ...(providerType === 'openai' ? {
      apiKey: savedOpenaiApiKey || '',
    } : {
      apiKey: savedClaudeApiKey || '',
    }),
  } as any);


  console.log(`[Server] AI provider: ${aiProvider.name} (capabilities: ${[...aiProvider.capabilities].join(', ')})`);


  // ── Whose browser context is this? (card 7f4d8f32) ────────────────────────────
  // The one headless Chromium is shared by the agents and by the browser panes
  // of whoever uses the app, so its scheduling band is decided per context: a
  // context of a dispatched card (or of a session working in an agent worktree)
  // is an agent's, anything else - including a context nobody here can name - is
  // treated as a person's. `watchers` is read live: a pane streaming frames is
  // somebody looking at the screen right now.
  const browserOwnerCache = new Map<string, { sessionKey?: string; workspace?: string }>();

  function resolveBrowserContextOwner(contextId: string): { sessionKey?: string; workspace?: string; watchers: number } {
    let known = browserOwnerCache.get(contextId);
    if (!known) {
      known = {};
      try {
        // Same resolution chain as onNavigate below: the indexed session-key
        // lookup first, the scan only when it misses.
        let topic = ctx.getTopicBySessionKey("topic:" + contextId);
        if (!topic || topic.id.slice(0, 8) !== contextId) {
          const topics = Object.values(ctx.loadTopics().topics);
          topic = topics.find(t => t.id === contextId)
            ?? topics.find(t => t.browserState?.contextId === contextId)
            ?? topics.find(t => t.id.slice(0, 8) === contextId)
            ?? null;
        }
        if (topic) known = { sessionKey: topic.sessionKey, workspace: topic.projectPath };
      } catch { /* an owner we cannot read is an owner we do not claim */ }
      // Only a resolved owner is remembered: a context created before its topic
      // row exists must be asked again, not written off as anonymous forever.
      if (known.sessionKey) browserOwnerCache.set(contextId, known);
    }
    return { ...known, watchers: browserWsClients.get(contextId)?.size ?? 0 };
  }


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
    onDestroy: (contextId) => { clearBrowserCaches(contextId); resetMoondreamCounter(contextId); browserOwnerCache.delete(contextId); },
    // Phase 30 BROWSER-CHAT-03 — wire agent_active broadcast through the
    // /ws/browser/:contextId registry maintained in this module.
    broadcastToBrowserWs,
    // QoS band of the shared Chromium (card 7f4d8f32): the service knows its
    // contexts, only this module can say whose they are.
    resolveContextOwner: resolveBrowserContextOwner,
    agentOwnerTest: agentOwnerTest(),
  });

  return { broadcastPresence, broadcastToBrowserWs, browserService, domHosts, hostBootRace, hostMirror, nativeHostLiveness, resizeFromViewer, viewerActions, viewerCountPublisher, viewportWiring };
}
