import { existsSync, mkdirSync, readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { readTranscriptJsonl } from "./lib/transcript-retention";
import { writeFileAtomic } from "./lib/atomic-write";
import { readdir as readdirAsync, stat as statAsync } from "fs/promises";
import { timingSafeEqual } from "crypto";
import { join, resolve, extname } from "path";
import type { ServerWebSocket } from "bun";
import { clientReceivesTopicDelta } from "./lib/ws-topic-routing";
import { OUTBOUND_FRAME_CLASSES } from "../shared/ws-outbound";
import { createStreamActionFeed } from "./lib/stream-action-feed";
import type {
  WSData, GuestBroadcastFilter, Topic, TopicsData, TopicsFilter, UnreadData,
  ActiveStream, ErrorResponseOptions, AppContext, Project,
} from "./types";
import { initDatabase } from "./db";
import { isGuestSocketData } from "./lib/grants";
import {
  osservatoreDaDispositivo, envelopeProgettoPer, vedeProgetto,
  type Osservatore, type TipoFrameProgetto,
} from "./lib/project-visibility";
import { readMutedProjects } from "./lib/muted-projects";
import { appDataRoots, resolveAppDataDir, resolveStateDir } from "./lib/data-dir";
import { CONTEXT_FILES, instanceEntryPath } from "./lib/instance-files";
import { observeCardFrame, type CardFrame } from "./services/card-outcome-wake";
import { knownProjectDirs, isInsideKnownProject } from "./services/known-project-dirs";
import { isInsideDir } from "./lib/path-containment";
import { realPathForNewEntry } from "./lib/real-path";
import { isTopicsSecretPath } from "./lib/topics-secret-path";
import { homeDir } from "./lib/broad-cwd";
import { isTopicSilenced } from "./push-triggers";
import { configureAttentionStore } from "./attention/store";
import { isSubagentEngaged, markSubagentEngaged } from "./lib/subagent-store";
import { configureAttentionWire } from "./attention/wire";
import { recordSystemNotice } from "./attention/system-notices";
import { terminalIdOfSubject, topicIdOfSubject, topicSubject } from "../shared/attention";
import { configureNotificationRegistry } from "./notification-registry";
import { createProjectStore } from "./services/project-store";
import { createWorktreeStore } from "./services/worktree-store";
import { createWorktreeManager, type WorktreeManagerGcDeps } from "./services/worktree-manager";
import { defaultLifecycleHooks } from "./services/lifecycle-hooks";
import { createMachineStore } from "./services/machine-store";
import { sendWsFrame } from "./lib/ws-send";
import { validateOutbound } from "../shared/ws-outbound";
import { createTurnLedger } from "./lib/turn-ledger";
import type { OutboundMessage } from "../shared/ws-outbound";
import { imageShape } from "./services/image-shape";
import { withMediaSizes } from "./lib/media-size";
import { httpLogLine } from "./lib/http-log";
import {
  listGlobalOrchestratorTopicIds,
  presentGlobalOrchestratorTopic,
} from "./services/global-orchestrator-session";
import { createAppStatements, type DbRow } from "./app-context/app-statements";
import { createMessageThreadReads } from "./app-context/message-thread-reads";
import { createMessageThreadWrites } from "./app-context/message-thread-writes";
import { createMessageBranches } from "./app-context/message-branches";
import { createStreamRegistry } from "./app-context/stream-registry";

interface TranscriptHit {
  messageId: string | null; sessionKey: string; topicId: string | null; topicName: string;
  topicIcon: string; role: string; content: string; timestamp: string | null;
}

/**
 * v3 foundations WS-01 outbound validation hook. Runs in DEV mode only —
 * zero overhead in production. Catches server-side bugs that emit malformed
 * payloads at the source instead of letting clients discover them.
 *
 * For types not registered in `OUTBOUND_SCHEMAS`, this is a no-op.
 * Migration is incremental: add schemas as types stabilize.
 */
function devValidateOutbound(message: object): void {
  if (process.env.NODE_ENV === 'production') return;
  const result = validateOutbound(message);
  if (!result.ok) {
    // La console È la funzione: questo ramo esiste solo fuori produzione
    // (guardia sopra) e il suo unico scopo è far vedere allo sviluppatore il
    // broadcast malformato mentre lo scrive. Passarlo al logger strutturato lo
    // seppellirebbe dove nessuno lo guarda durante lo sviluppo, che è l'unico
    // momento in cui serve.
    console.warn(`[WS:outbound] Malformed broadcast — ${result.error}`, message);
  }
}


/**
 * Constant-time string compare for secrets (gateway tokens). Avoids leaking the
 * token length/prefix via early-exit timing on `===`. Returns false on any
 * length mismatch (timingSafeEqual throws on unequal-length buffers).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}


// Re-exported so the routes and tests that import these from "./utils" keep
// their import lines: they moved with the message row codec.
export { restoreToolCallsFromBlocks } from "./app-context/message-thread-reads";

export function createAppContext(baseDir: string): AppContext {
  // CLI PORT override: BUN_PORT beats .env PORT (Bun auto-loads .env first)
  const PORT = parseInt(process.env.BUN_PORT || process.env.PORT || "3333");

  // Mutable state lives under a WRITABLE root. In dev / under the prod
  // LaunchAgent STATE_DIR === baseDir (the writable repo), so this is
  // byte-identical to the historical layout. In a DOWNLOADED packaged app the
  // Electron launcher sets TOPICS_DATA_DIR to a writable per-user dir, because
  // baseDir (= Resources/server INSIDE the read-only .app bundle) cannot be
  // written — and a write there crashes the server before it can listen, which
  // is what hangs the app forever on "Launching the local engine".
  const STATE_DIR = resolveStateDir(baseDir);
  const TOPICS_FILE = join(STATE_DIR, "topics.json");
  const UNREAD_FILE = join(STATE_DIR, "unread.json");
  // Bundle del client. È un asset READ-ONLY e resta dentro il bundle.
  //
  // Sovrascrivibile perché la suite E2E deve servire una FOTOGRAFIA di
  // `public/`, non la cartella viva: `vite build --watch` la riscrive (svuota e
  // ricrea `index.html`) mentre i test girano, e in quella finestra il server
  // risponde "no such file or directory" — l'app non si carica e falliscono
  // test che non c'entrano nulla, ogni volta uno diverso. Vedi
  // `tests/e2e/global-setup.ts` (snapshotBundle) e `helpers/test-server.ts`.
  const PUBLIC_DIR = process.env.TOPICS_PUBLIC_DIR || join(baseDir, "public");
  const UPLOADS_DIR = join(STATE_DIR, "uploads");
  const CONTEXT_DIR = instanceEntryPath(CONTEXT_FILES, { stateDir: STATE_DIR });
  // The app data root (media/, workspace/, the agents' homes). One rule, in
  // lib/data-dir.ts: an explicit variable, else the Topics home.
  const APP_DATA_DIR = resolveAppDataDir();
  // Transcript JSONL delle sessioni scritte prima di SQLite: li leggono ancora
  // la ricerca e la storia di ripiego.
  const SESSIONS_DIR = process.env.SESSIONS_DIR || `${APP_DATA_DIR}/agents/main/sessions`;
  const MESSAGES_DIR = join(STATE_DIR, "messages");

  mkdirSync(MESSAGES_DIR, { recursive: true });

  // Initialize SQLite (DB file under STATE_DIR/data; migrations read from baseDir)
  const db = initDatabase(baseDir, STATE_DIR);

  // A topic whose parent is gone goes back to the root. ONCE, here at boot,
  // not inside `GET /api/topics`: there it was a JavaScript walk of every row
  // on every boot and every WS reconnect, for a condition the schema itself
  // prevents since `parent_id … ON DELETE SET NULL` runs under
  // `PRAGMA foreign_keys = ON` (db.ts). What is left to repair is a row written
  // before that rule, and one statement on `idx_topics_parent` finds it.
  // Gate: tests/integration/topics-list-weight.test.ts.
  {
    const t0 = performance.now();
    const fixed = db.prepare(
      `UPDATE topics SET parent_id = NULL
        WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM topics)`,
    ).run().changes;
    if (fixed > 0) {
      console.log(`[Orphan Fix] ${fixed} topic(s) had a parentId that no longer exists — moved to root (${(performance.now() - t0).toFixed(1)} ms)`);
    }
  }

  // State
  const activeStreams = new Map<string, ActiveStream>();
  // Whether a turn is open, from every source (`lib/turn-ledger.ts`); each change goes to every window.
  const turnLedger = createTurnLedger({ onChange: (state) => broadcastToAll({ type: "turn:state", ...state }) });
  const wsClients = new Set<ServerWebSocket<WSData>>();
  // What each topic's agent is doing, said once to EVERY window when it changes (`lib/stream-action-feed.ts`).
  // The stream frames that carry it are topic-class; every one of them, from every provider, ends in
  // `broadcastToAll` or `broadcastToTopicSubscribers` below, which is where the feed watches them.
  const streamActionFeed = createStreamActionFeed((payload) => broadcastToAll({ type: "stream:action", ...payload }));
  const observeStreamAction = (message: OutboundMessage, topicId: string | undefined): void => {
    if (!message.type.startsWith("stream:")) return;
    const frame = message as OutboundMessage & { topicId?: unknown; sessionKey?: unknown };
    const sessionKey = typeof frame.sessionKey === "string" ? frame.sessionKey : undefined;
    const id = topicId ?? (typeof frame.topicId === "string" ? frame.topicId : sessionKey ? getTopicBySessionKey(sessionKey)?.id : undefined);
    // A side-effect of watching must never break a broadcast.
    try {
      const { late, toolCall } = message as { late?: boolean; toolCall?: { name?: string; args?: unknown } };
      streamActionFeed.observe({ type: message.type, late, toolCall, topicId: id, sessionKey });
    } catch { /* the frame already went out */ }
  };
  // Revocation covers all transports; broadcast registries remain separate.
  const deviceSockets = new Set<ServerWebSocket<WSData>>();

  const { stmts } = createAppStatements({ db });

  // `subagents` arrives with a later migration than `topics`: a DB that has not
  // run it yet (or a test schema without it) just has no native sub-agents.
  function attemptSubagentParents(sql: string, ...params: unknown[]): unknown[] {
    try { return db.query(sql).all(...(params as [])); } catch { return []; }
  }

  type ChatForkSql = { session_key: string; parent_name: string; fork_point_message_id: string; parent_id: string | null };
  // Pre-grouped topic relations, built once per loadTopics() call by
  // buildTopicRelations() and threaded into rowToTopic to avoid the N+1.
  type TopicRelations = {
    links: Map<string, string[]>;
    contextFiles: Map<string, string[]>;
    pinnedMessages: Map<string, string[]>;
    disabledSources: Map<string, string[]>;
    forks: Map<string, ChatForkSql>;
    /** One batched role lookup for the client-facing full Topic snapshot. */
    globalOrchestratorTopicIds: ReadonlySet<string>;
    /** Native sub-agent chat session key → the session key of its parent. */
    subagentParents: ReadonlyMap<string, string>;
  };
  function buildTopicRelations(): TopicRelations {
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
      const arr = m.get(k); if (arr) arr.push(v); else m.set(k, [v]);
    };
    const links = new Map<string, string[]>();
    for (const r of stmts.getAllTopicLinks.all() as { source_id: string; target_id: string }[]) push(links, r.source_id, r.target_id);
    const contextFiles = new Map<string, string[]>();
    for (const r of stmts.getAllTopicContextFiles.all() as { topic_id: string; file_path: string }[]) push(contextFiles, r.topic_id, r.file_path);
    const pinnedMessages = new Map<string, string[]>();
    for (const r of stmts.getAllTopicPinnedMessages.all() as { topic_id: string; message_id: string }[]) push(pinnedMessages, r.topic_id, r.message_id);
    const disabledSources = new Map<string, string[]>();
    for (const r of stmts.getAllTopicDisabledSources.all() as { topic_id: string; source_id: string }[]) push(disabledSources, r.topic_id, r.source_id);
    return {
      links,
      contextFiles,
      pinnedMessages,
      disabledSources,
      forks: new Map((stmts.getAllChatForks.all() as ChatForkSql[]).map((r) => [r.session_key, r])),
      globalOrchestratorTopicIds: listGlobalOrchestratorTopicIds(db),
      subagentParents: new Map(
        (attemptSubagentParents(`SELECT session_key, parent_session_key FROM subagents WHERE runtime = 'topics' AND session_key IS NOT NULL`) as Array<{ session_key: string; parent_session_key: string }>)
          .map((r) => [r.session_key, r.parent_session_key]),
      ),
    };
  }

  // --- Helper: Convert SQLite topic row to Topic object ---
  // `rels` (supplied by loadTopics) reads relations from pre-grouped maps;
  // without it each relation is a per-id sub-query (single-topic read path).
  // `any`: a full topics-table row; typing its ~20 nullable columns would force casts that hide drift.
  function rowToTopic(row: any, rels?: TopicRelations): Topic {
    const topic: Topic = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      parentId: row.parent_id || null,
      links: rels ? (rels.links.get(row.id) ?? []) : (stmts.getTopicLinks.all(row.id) as { target_id: string }[]).map(r => r.target_id),
      sessionKey: row.session_key,
      color: row.color,
      icon: row.icon,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: !!row.archived,
    };
    // This is a server-projected UI capability marker, not Topic persistence.
    // `loadTopics()` supplies the complete registry set in one query, avoiding
    // a role lookup for every one of the hundreds of hydrated rows.
    if (rels?.globalOrchestratorTopicIds.has(row.id)) topic.isGlobalOrchestrator = true;
    // Same kind of projection: who spawned this chat, from `subagents`.
    const subagentOf = rels
      ? rels.subagentParents.get(row.session_key)
      : (attemptSubagentParents(`SELECT parent_session_key FROM subagents WHERE runtime = 'topics' AND session_key = ? LIMIT 1`, row.session_key)[0] as { parent_session_key?: string } | undefined)?.parent_session_key;
    if (subagentOf) topic.subagentOf = subagentOf;
    if (row.system_prompt) topic.systemPrompt = row.system_prompt;
    if (row.project_path) topic.projectPath = row.project_path;
    if (row.sort_order !== undefined) topic.sortOrder = row.sort_order;
    // `ask` NON si omette più. Veniva trattato come «il default», quindi non
    // usciva nella risposta — e finché il livello non faceva niente era
    // innocuo. Da quando decide `--permission-mode` (autonomy-mode.ts) è una
    // SCELTA con un effetto: ometterla farebbe mostrare all'interfaccia il
    // livello sbagliato, cioè chi ha scelto «chiede prima» si vedrebbe
    // evidenziato «fa tutto».
    if (row.autonomy_level) topic.autonomyLevel = row.autonomy_level;
    if (row.provider) topic.provider = row.provider;
    if (row.model) topic.model = row.model;
    // topics_routing (AICTRL-01, migration 20260922180000). NULL omitted:
    // the reader falls back to the legacy topics:<model> prefix.
    if (row.topics_routing !== undefined && row.topics_routing !== null) topic.topicsRouting = !!row.topics_routing;
    // effort (migration 033). Per-topic reasoning-tier override; NULL omitted so
    // legacy rows fall back to the global env-resolved default at spawn time.
    if (row.effort) topic.effort = row.effort;
    // fast_mode (migration 024). 1 = enabled, 0/NULL = disabled (default).
    // Only attached when truthy so legacy rows (pre-migration, before backfill)
    // round-trip through inspector serializers unchanged.
    if (row.fast_mode) topic.fastMode = true;
    // muted (migration 073). Only attached when truthy so legacy/normal rows
    // round-trip unchanged through inspector serializers.
    if (row.muted) topic.muted = true;
    // worktree_id (Phase A · migration 018). Optional FK; legacy rows are NULL.
    if (row.worktree_id) topic.worktreeId = row.worktree_id;
    // Phase C · TOPIC-IM-01. Surfaced when present; legacy NULL omitted.
    if (row.initial_message) topic.initialMessage = row.initial_message;
    // standalone (migration 044). Only attached when truthy so legacy/normal
    // rows round-trip unchanged through inspector serializers.
    if (row.standalone) topic.standalone = true;
    // mcp_policy (migration 049). NULL omitted: inherit-the-fleet default.
    if (row.mcp_policy) topic.mcpPolicy = row.mcp_policy;
    // browser_state (migration 075). Prima non aveva colonna: l'hook onNavigate
    // scriveva `topic.browserState` su un oggetto che rowToTopic aveva appena
    // costruito e che nessuno salvava, quindi la lettura successiva lo trovava
    // di nuovo `undefined` — una scrittura morta, invisibile perche' il valore
    // c'era per il resto della richiesta. JSON malformato si ignora: e' un
    // ausilio (ultimo url mostrato), non un dato su cui vale la pena fallire.
    if (row.browser_state) {
      try { topic.browserState = JSON.parse(row.browser_state); } catch { /* ignora */ }
    }

    const contextFiles = rels ? (rels.contextFiles.get(row.id) ?? []) : (stmts.getTopicContextFiles.all(row.id) as { file_path: string }[]).map(r => r.file_path);
    if (contextFiles.length > 0) topic.contextFiles = contextFiles;

    const pinnedMessages = rels ? (rels.pinnedMessages.get(row.id) ?? []) : (stmts.getTopicPinnedMessages.all(row.id) as { message_id: string }[]).map(r => r.message_id);
    if (pinnedMessages.length > 0) topic.pinnedMessages = pinnedMessages;

    const disabledSources = rels ? (rels.disabledSources.get(row.id) ?? []) : (stmts.getTopicDisabledSources.all(row.id) as { source_id: string }[]).map(r => r.source_id);
    if (disabledSources.length > 0) topic.disabledContextSources = disabledSources;

    const fork = rels ? rels.forks.get(row.session_key) : stmts.getChatFork.get(row.session_key) as ChatForkSql | null;
    if (fork) topic.forkedFrom = { topicId: fork.parent_id ?? null, name: fork.parent_name, atMessageId: fork.fork_point_message_id };

    return topic;
  }

  // --- Helper: Save a single topic and its relations to SQLite ---
  /**
   * The project allowlist cache of `allowedProjectDirs` (five seconds, see
   * there). Declared here because saving a topic empties it: `topic.projectPath`
   * is one of its sources, and a chat just created in a new folder was refused
   * as "no project directory" until the five seconds ran out. The deny refresh
   * of `allowedProjectDirsFresh` did not save it when another refusal had
   * used it up in the half second before (chat-live-work, red on the first
   * try in every CI run).
   */
  let knownDirsCache: { at: number; dirs: Set<string> } | null = null;

  /**
   * Upsert a topic plus its 4 child relation tables atomically. Wrapped in
   * one transaction so a concurrent reader (e.g. another request running
   * `getTopicById`) never sees the half-state where links/contextFiles/etc.
   * have been DELETEd but not yet re-INSERTed.
   *
   * Without the transaction, the 9 statements below were a write fence —
   * any reader landing between `deleteTopicLinks` and the matching insert
   * loop would observe the topic with `links: []` for a few microseconds.
   * SQLite's WAL mode masks most of this, but Bun's `await` yields make
   * the gap large enough to matter under load.
   */
  function saveSingleTopic(topic: Topic): void {
    db.transaction(() => {
      stmts.insertTopic.run({
        $id: topic.id,
        $name: topic.name,
        $slug: topic.slug,
        $parent_id: topic.parentId || null,
        $session_key: topic.sessionKey,
        $color: topic.color,
        $icon: topic.icon,
        $system_prompt: topic.systemPrompt || null,
        $project_path: topic.projectPath || null,
        $sort_order: topic.sortOrder ?? 0,
        // Di base la chat AGISCE. Con `|| 'ask'` un topic senza scelta veniva
        // scritto come se avesse scelto di proporre e basta — e da quando
        // quell'etichetta decide `--permission-mode` significava plan mode, cioè
        // una sessione che non può né agire né consegnare il piano. Vedi la
        // migration 081 e l'invariante dichiarata in lib/autonomy-mode.ts.
        $autonomy_level: topic.autonomyLevel || 'auto-apply',
        $provider: topic.provider || null,
        $model: topic.model || null,
        // topics_routing (AICTRL-01, migration 20260922180000). null preserves
        // "never set explicitly" (legacy topics:<model> fallback); the switch
        // never coerces to 0/1 the way fast_mode/muted booleans do below.
        $topics_routing: topic.topicsRouting == null ? null : (topic.topicsRouting ? 1 : 0),
        // effort column (migration 033). NULL = no per-topic override → global
        // default resolved at spawn time. Stored as-is (low/medium/high/xhigh/max).
        $effort: topic.effort || null,
        // fast_mode column gets 0/1 — SQLite has no native boolean. Coerce
        // here so callers can pass `undefined` (legacy topics) and still get
        // the schema's NOT NULL DEFAULT 0 guarantee.
        $fast_mode: topic.fastMode ? 1 : 0,
        // muted column (migration 073). 0/1 — per-topic notification mute.
        // Same 0/1 coercion as fast_mode so a legacy `undefined` maps to the
        // schema's NOT NULL DEFAULT 0 (not muted).
        $muted: topic.muted ? 1 : 0,
        // worktree_id (Phase A · migration 018). NULL = no binding; FK
        // ON DELETE SET NULL on the column ensures graceful degrade.
        $worktree_id: topic.worktreeId || null,
        // initial_message (Phase C · migration 019). Only PATCH writes it: a new
        // chat's first message is sent at creation (POST /api/topics), never stored.
        $initial_message: topic.initialMessage || null,
        // standalone (migration 044). 1 = keep project_path (cwd) but present as
        // a standalone task workspace / loose tab, never a project node.
        $standalone: topic.standalone ? 1 : 0,
        // mcp_policy (migration 049). NULL = inherit fleet; 'bridge-only' =
        // dispatch-scoped session (topics bridge only, reduced tool profile).
        $mcp_policy: topic.mcpPolicy || null,
        // browser_state (migration 075): JSON del campo, o NULL. Vedi rowToTopic.
        $browser_state: topic.browserState ? JSON.stringify(topic.browserState) : null,
        $archived: topic.archived ? 1 : 0,
        $created_at: topic.createdAt,
        $updated_at: topic.updatedAt,
      });

      // Links
      stmts.deleteTopicLinks.run(topic.id);
      if (topic.links?.length) {
        for (const targetId of topic.links) stmts.insertTopicLink.run(topic.id, targetId);
      }

      // Context files
      stmts.deleteTopicContextFiles.run(topic.id);
      if (topic.contextFiles?.length) {
        for (const fp of topic.contextFiles) stmts.insertTopicContextFile.run(topic.id, fp);
      }

      // Pinned messages
      stmts.deleteTopicPinnedMessages.run(topic.id);
      if (topic.pinnedMessages?.length) {
        for (const msgId of topic.pinnedMessages) stmts.insertTopicPinnedMessage.run(topic.id, msgId);
      }

      // Disabled sources
      stmts.deleteTopicDisabledSources.run(topic.id);
      if (topic.disabledContextSources?.length) {
        for (const src of topic.disabledContextSources) stmts.insertTopicDisabledSource.run(topic.id, src);
      }
    })();
    // Only a folder the cache does not hold yet empties it: topics are saved
    // often, and a recompute costs two queries plus a realpath per entry.
    if (topic.projectPath && knownDirsCache && !knownDirsCache.dirs.has(topic.projectPath)) knownDirsCache = null;
  }

  const {
    parseBlocksCol, rowToMessage, metaParams, writeMessage, getMessagesPath, loadActiveThread, loadLocalMessages, loadThreadSkeleton, loadThreadRows, loadThreadWindow, hydrateMessageBodies, messageBodyHydrator, countMessagesBySession,
  } = createMessageThreadReads({ MESSAGES_DIR, db, stmts });






  // --- Broadcast helpers ---
  /**
   * One frame out on one socket, compressed only when it is worth it.
   *
   * Every fan-out below used to call `ws.send(payload)` inside its own
   * try/catch, six copies of the same three lines. They are one function now
   * because the compression decision has to be made in ONE place: six copies of
   * a rule are five chances for it to drift, and the one that drifts is always
   * the least used path.
   *
   * The decision itself lives in `server/lib/ws-compression.ts`, with the
   * measurements behind it. In short: compress toward a peer with a network in
   * between, leave everything under one MTU alone (which is what keeps every
   * keystroke of a terminal off the compressor), and never touch a screencast
   * frame, which is base64 of an already compressed JPEG.
   */
  function sendFrame(ws: ServerWebSocket<WSData>, payload: string, type: string): void {
    try {
      sendWsFrame(ws, payload, type);
    } catch (err) {
      console.error(`[WS] Send error to ${ws.data.id}:`, err);
    }
  }

  function presentTopicInOutboundMessage(message: OutboundMessage): OutboundMessage {
    // Only Topic lifecycle frames have a normal Topic payload today, but keep
    // this structural so a future Topic-bearing frame cannot accidentally
    // bypass the UI's server-owned capability marker.  The projection queries
    // the singleton registry by id; it never trusts the frame's title/provider.
    const candidate = message as OutboundMessage & { topic?: unknown };
    const topic = candidate.topic;
    if (!topic || typeof topic !== "object" || typeof (topic as Topic).id !== "string") return message;
    const presented = presentGlobalOrchestratorTopic(db, topic as Topic);
    return presented === topic ? message : { ...candidate, topic: presented } as OutboundMessage;
  }

  function broadcast(message: OutboundMessage, exclude?: ServerWebSocket<WSData>) {
    const presentedMessage = presentTopicInOutboundMessage(message);
    devValidateOutbound(presentedMessage);
    const payload = JSON.stringify(presentedMessage);
    // Era l'UNICA fan-out senza filtro degli ospiti, e portava roba d'oro:
    // `auth:pair-requested` con il `requestId` e il codice di chi sta entrando,
    // `auth:pair-resolved`, `auth:device-revoked`. Un ospite con un permesso di
    // lettura su una scheda leggeva il riferimento di un appaiamento altrui e
    // poi ne ritirava il gettone da `/api/auth/pair/status` — cioè diventava il
    // dispositivo appena approvato. Provato in `guest-confinement.spec.ts`
    // (GUEST-05), non dedotto.
    //
    // Il filtro è lo stesso di `broadcastToAll`, chiamato dallo stesso posto:
    // nessuno dei tipi che passano di qui è nell'allowlist, quindi per un
    // ospite cadono tutti — che è la risposta giusta.
    const guests = guestSocketFilter();
    for (const ws of wsClients) {
      if (ws !== exclude && ws.readyState === 1) {
        if (guests && isGuestSocket(ws) && !guests.mayReceiveFrame(ws.data, presentedMessage)) continue;
        sendFrame(ws, payload, presentedMessage.type);
      }
    }
  }

  /**
   * Il filtro che decide se un frame può raggiungere un dispositivo OSPITE.
   * Iniettato da `server.ts` (serve il DB) e `null` finché non lo è: `null`
   * significa «nessun ospite da filtrare», cioè il comportamento precedente.
   */
  let guestFilter: GuestBroadcastFilter | null = null;
  function setGuestBroadcastFilter(f: GuestBroadcastFilter | null): void { guestFilter = f; }
  function guestSocketFilter() { return guestFilter; }

  /** La regola sta in `lib/grants.ts` con le altre del confinamento, e ha un
   *  test: scritta a mano dentro tre cicli sarebbe tre regole che divergono. */
  const isGuestSocket = (ws: ServerWebSocket<WSData>) => { guestSocketFilter()?.refreshSocketPrincipal?.(ws.data); return isGuestSocketData(ws.data); };

  // A row that reaches the windows live carries the size of each picture it
  // draws, like a history page does (`lib/media-size.ts`): the box is there
  // before the bytes. Only the two frames that bring a message's pictures.
  function withFrameMediaSizes(message: OutboundMessage): OutboundMessage {
    if (message.type !== "message:new" && message.type !== "message:media") return message;
    return withMediaSizes(message, { uploadsDir: UPLOADS_DIR, isPathAllowed });
  }

  /** A GUEST gets the frame without `mediaSizes`: each key is a picture served by `/uploads/` or `/api/media`, both
   *  closed to guests, so a size would only tell it what sits on the owner's disk (V3, D2). Not filtered key by key:
   *  the keys are disk paths too, and a disk path under `/media/` would pass the rule written for the `/media/` route. */
  function guestPayloadOf(message: OutboundMessage, payload: string): string {
    if (!("mediaSizes" in message)) return payload;
    const { mediaSizes: _ownerOnly, ...rest } = message as OutboundMessage & { mediaSizes?: unknown };
    return JSON.stringify(rest);
  }

  function broadcastToAll(message: OutboundMessage) {
    const presentedMessage = presentTopicInOutboundMessage(withFrameMediaSizes(message));
    devValidateOutbound(presentedMessage);
    // The chat that opened a card hears its outcome (`card-outcome-wake`).
    if (typeof message.type === "string" && message.type.startsWith("task:")) {
      const card = (message as { task?: unknown }).task as CardFrame | undefined;
      if (card && typeof card.id === "string" && typeof card.status === "string") {
        try { observeCardFrame(card); } catch { /* a wake must never break a broadcast */ }
      }
    }
    const frame = presentedMessage as OutboundMessage & { topicId?: unknown; sessionKey?: unknown };
    // A topic frame reaches only the windows holding that topic. It goes through the same loop as
    // every other frame, so the guest rules below still decide what a guest receives.
    const topicId = OUTBOUND_FRAME_CLASSES[frame.type as keyof typeof OUTBOUND_FRAME_CLASSES] !== "topic"
      ? undefined
      : typeof frame.topicId === "string"
        ? frame.topicId
        : typeof frame.sessionKey === "string" ? getTopicBySessionKey(frame.sessionKey)?.id : undefined;
    const payload = JSON.stringify(presentedMessage);
    // Un OSPITE non riceve tutto. Il gate controlla le RICHIESTE, e un broadcast
    // non è una richiesta: senza questo filtro un ospite col socket aperto
    // vedrebbe passare stato dei progetti, git, presenza, capacità di dispatch —
    // cioè esattamente ciò che non gli abbiamo condiviso.
    //
    // Il filtro è per TIPO (allowlist) e poi per ENTITÀ. Per tipo perché dei ~91
    // frame del registro solo 39 portano un id: affidarsi all'id lascerebbe
    // passare gli altri 52. Per entità perché un tipo ammesso non basta —
    // `task:updated` di un task non condiviso resta roba d'altri.
    const guests = guestSocketFilter();
    let guestPayload: string | undefined;
    for (const ws of wsClients) {
      if (ws.readyState !== 1) continue;
      if (topicId && !clientReceivesTopicDelta(ws.data, topicId)) continue;
      const guest = guests && isGuestSocket(ws);
      if (guest && !guests.mayReceiveFrame(ws.data, presentedMessage)) continue;
      // Built once per fan-out, and only when a guest is reached.
      sendFrame(ws, guest ? (guestPayload ??= guestPayloadOf(presentedMessage, payload)) : payload, presentedMessage.type);
    }
    observeStreamAction(message, undefined);
    // No push from here any more (notifications-redesign, design section
    // 10.1): a frame is not a fact. The push and the history row of a new
    // epoch are decided by the attention store, which hands its own frame to
    // this function like every other writer.
  }

  /**
   * I frame che portano una RIGA di `projects`, uno per socket.
   *
   * `broadcastToAll` manda a tutti lo stesso payload, e per questi tre frame
   * quel payload è nome + path del progetto: con la 092 `GET /api/projects`
   * filtra per organizzazione e incognito, ma il broadcast subito dopo la stessa
   * mutazione rimetteva in chiaro a OGNI socket connessa ciò che l'elenco aveva
   * appena nascosto. Un filtro che vale su una porta e non sull'altra non è un
   * filtro.
   *
   * Qui la decisione è PER SOCKET, e non può essere altrimenti: `vedeProgetto`
   * dipende dalla persona, e la persona sta sulla socket (`ws.data.deviceId`,
   * timbrato all'upgrade), non nel frame.
   *
   * Chi non vede riceve la RITRATTA, non il silenzio — il perché sta su
   * `envelopeProgettoPer`, insieme alla regola.
   *
   * L'ordine con gli ospiti: il filtro degli ospiti resta il PRIMO. `project:*`
   * non è fra i tipi ammessi, quindi a un ospite non parte né la riga né la
   * ritratta, esattamente come prima che questa fan-out esistesse.
   *
   * No push from here: a push is the attention store's, for a new epoch of a
   * subject (`server/attention/store.ts`), never a reaction to a frame.
   */
  function broadcastProject(type: TipoFrameProgetto, project: Project): void {
    const guests = guestSocketFilter();
    // Un osservatore per DISPOSITIVO e non per socket: risolverlo costa due
    // query, e più finestre dello stesso dispositivo sono la norma, non il caso
    // limite. La cache dura questa sola fan-out: fuori di qui un'appartenenza
    // può cambiare, e una cache più lunga sarebbe una revoca che non arriva.
    const osservatori = new Map<string, Osservatore>();
    // Le forme possibili sono due — la riga e la ritratta — quindi si validano e
    // si serializzano una volta ciascuna, non una per socket.
    const serializzati = new Map<string, string>();
    for (const ws of wsClients) {
      if (ws.readyState !== 1) continue;
      const deviceId = ws.data.deviceId ?? null;
      // La stringa vuota non è un id di dispositivo valido: qui è il loopback,
      // cioè la macchina stessa.
      const chiave = deviceId ?? "";
      let chi = osservatori.get(chiave);
      if (!chi) {
        chi = osservatoreDaDispositivo(db, deviceId);
        osservatori.set(chiave, chi);
      }
      const message = envelopeProgettoPer(chi, type, project);
      if (guests && isGuestSocket(ws) && !guests.mayReceiveFrame(ws.data, message)) continue;
      let payload = serializzati.get(message.type);
      if (payload === undefined) {
        devValidateOutbound(message);
        payload = JSON.stringify(message);
        serializzati.set(message.type, payload);
      }
      sendFrame(ws, payload, message.type);
    }
  }

  /**
   * A frame ABOUT a project (it names its path) that only the sockets seeing
   * that project may receive; the others get nothing.
   *
   * Not `broadcastProject`: that one carries a row and owes a retraction to
   * whoever stops seeing it. A frame like `project:icon` carries no row to
   * retract, so silence is the whole answer, and sending it to every socket
   * would hand an incognito project's path to an org mate.
   *
   * Same order as `broadcastProject`: the guest filter first, then the
   * visibility rule, with one observer per device for this fan-out only.
   */
  function broadcastToProjectViewers(message: OutboundMessage, project: Parameters<typeof vedeProgetto>[1]): void {
    const guests = guestSocketFilter();
    const sees = new Map<string, boolean>();
    let payload: string | null = null;
    for (const ws of wsClients) {
      if (ws.readyState !== 1) continue;
      if (guests && isGuestSocket(ws) && !guests.mayReceiveFrame(ws.data, message)) continue;
      const deviceId = ws.data.deviceId ?? null;
      // The empty string is not a device id: here it is loopback, the machine.
      const key = deviceId ?? "";
      let visible = sees.get(key);
      if (visible === undefined) {
        visible = vedeProgetto(osservatoreDaDispositivo(db, deviceId), project);
        sees.set(key, visible);
      }
      if (!visible) continue;
      if (payload === null) {
        devValidateOutbound(message);
        payload = JSON.stringify(message);
      }
      sendFrame(ws, payload, message.type);
    }
  }

  /**
   * A UN dispositivo soltanto, tutte le sue socket.
   *
   * Non è un broadcast con un filtro: è l'opposto. Serve per dire a un ospite
   * che le sue concessioni sono cambiate — e su una REVOCA la concessione non
   * esiste più, quindi qualunque filtro per entità scarterebbe esattamente il
   * frame che conta. Mirare al destinatario risolve il problema invece di
   * aggirarlo, e fa arrivare il frame solo a chi ha motivo di riceverlo.
   */
  function sendToDevice(deviceId: string, message: OutboundMessage): void {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws.readyState !== 1 || ws.data.deviceId !== deviceId) continue;
      sendFrame(ws, payload, message.type);
    }
  }

  /**
   * Chiude tutte le socket di un dispositivo.
   *
   * Serve perché l'identità di una socket è timbrata all'upgrade e non si
   * rilegge: dopo, un WebSocket è solo un tubo. Quindi una connessione già
   * aperta sopravviveva alla revoca del proprio dispositivo — il gate HTTP
   * rifiutava le richieste, e intanto i frame continuavano ad arrivare.
   * «Revocato» deve voler dire subito, su tutti i canali, non solo su quello
   * che ricontrolla.
   */
  function closeDeviceSockets(deviceId: string): number {
    let chiuse = 0;
    for (const ws of deviceSockets) {
      if (ws.data.deviceId !== deviceId) continue;
      try { ws.close(4003, "device revoked"); chiuse++; } catch { /* già andata */ }
    }
    return chiuse;
  }

  function broadcastToTopic(topicId: string, message: OutboundMessage, exclude?: ServerWebSocket<WSData>) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
    const guests = guestSocketFilter();
    for (const ws of wsClients) {
      if (ws !== exclude && ws.data.focusedTopicId === topicId && ws.readyState === 1) {
        // Il confinamento vale su OGNI fan-out, non solo su `broadcastToAll`.
        // Qui l'entità è l'argomento, non un campo del frame: si chiede il
        // permesso sul TOPIC, che è la cosa che si sta per consegnare.
        if (guests && isGuestSocket(ws) && !guests.mayReadTopic(ws.data, topicId)) continue;
        sendFrame(ws, payload, message.type);
      }
    }
  }

  /**
   * P6: send to every client that currently has `topicId` open (declared via a
   * `subscribe` frame), plus any client that hasn't declared an open-set yet.
   * Preserves multi-window/background streaming while skipping clients that
   * aren't showing the topic — unlike broadcastToTopic (focused-only) which
   * drops background-tab deltas. Routing rule is the pure `clientReceivesTopicDelta`.
   */
  function broadcastToTopicSubscribers(topicId: string, message: OutboundMessage, exclude?: ServerWebSocket<WSData>) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
    const guests = guestSocketFilter();
    for (const ws of wsClients) {
      if (ws === exclude || ws.readyState !== 1) continue;
      // A client showing something else can be skipped before touching SQL.
      // Interest never grants access: legacy clients (no declared open-set)
      // and focused-topic fallbacks still pass the guest check before send.
      if (!clientReceivesTopicDelta(ws.data, topicId)) continue;
      if (guests && isGuestSocket(ws) && !guests.mayReadTopic(ws.data, topicId)) continue;
      sendFrame(ws, payload, message.type);
    }
    observeStreamAction(message, topicId);
  }

  // --- Project + Worktree domain (Phase A · migrations 016-018) ---
  // Stores are pure SQL helpers, instantiated against the singleton db.
  // The manager is the only stateful dependency: it closes over broadcastToAll
  // (declared above) so it can fire `worktree:updated` envelopes when the
  // async git materialise step transitions a row from `pending` → `ready|error`.
  const projectStore = createProjectStore(db);
  const createProjectRow = projectStore.create;
  projectStore.create = (input) => {
    const project = createProjectRow(input);
    knownDirsCache = null;
    return project;
  };
  const worktreeStore = createWorktreeStore(db);
  // Le gcDeps sono closure deliberate: processes.ts nasce DOPO il manager,
  // e queste funzioni vengono lette ALLA CHIAMATA, non alla costruzione.
  // Lo stesso schema usato per previewManager in worktree-gc-runner.ts.
  const _worktreeGcDeps: WorktreeManagerGcDeps = {
    killTree: undefined,   // iniettato da server.ts dopo createProcessesRouter
    listOwnedScripts: undefined, // idem
    // A folder that survives the delete: the row stays, the human must know.
    // A fact about the machine, not a chat's: a `system` row of its own (ATTN-10).
    notify: (input) => { recordSystemNotice({ key: "worktree-gc", cycle: input.dedupeKey, title: input.title, body: input.body }); },
  };
  const worktreeManager = createWorktreeManager(
    { broadcastToAll } as AppContext,
    { projectStore, worktreeStore, hooks: defaultLifecycleHooks() },
    _worktreeGcDeps,
  );
  // Phase D — machines (heartbeat ticker is wired in server.ts).
  const machineStore = createMachineStore(db, baseDir);

  // --- Atomic write (kept for backward compat with non-DB file writes) ---
  function atomicWriteJSON(filepath: string, data: object): void {
    writeFileAtomic(filepath, JSON.stringify(data, null, 2));
  }

  // --- Topics (SQLite-backed) ---
  /**
   * Every topic, or one half of them. `{ archived: false }` is the boot list
   * (`GET /api/topics`), `{ archived: true }` the archive the client asks for
   * later; without a filter, all of them, for the callers that walk the table
   * (bulk archive, context assembly, the CLI).
   */
  function loadTopics(filter?: TopicsFilter): TopicsData {
    const statement = filter?.archived === undefined
      ? stmts.getAllTopics
      : filter.archived ? stmts.getArchivedTopics : stmts.getLiveTopics;
    const rows = statement.all() as DbRow[];
    // Batch-load every relation once (1 + 5 scans) instead of 5 sub-queries per
    // topic — GET /api/topics is the hot UI-hydration path, hit on every load /
    // reconnect, and this DB carries ~hundreds of topics.
    const rels = buildTopicRelations();
    const topics: Record<string, Topic> = {};
    for (const row of rows) {
      topics[row.id] = rowToTopic(row, rels);
    }
    return { topics };
  }

  /**
   * Load a single topic by id without paying for a full table scan + Topic
   * reconstruction for every row. Returns null if missing. Use this in
   * mutation paths that touch one topic — pairs with `saveSingleTopic` to
   * avoid the lost-update race that the load-all/save-all pattern carries
   * across concurrent requests.
   */
  function getTopicById(id: string): Topic | null {
    const row = stmts.getTopicById.get(id) as DbRow;
    if (!row) return null;
    return rowToTopic(row);
  }

  /**
   * Scrive SOLO `browser_state` (migration 075) per un topic.
   *
   * Scrittura mirata, non un `saveSingleTopic`: l'hook `onNavigate` scatta a
   * OGNI navigazione del browser, e un upsert dell'intera riga a quel ritmo
   * riscriverebbe venti colonne per aggiornarne una — e soprattutto correrebbe
   * con qualunque altra scrittura sullo stesso topic (nome, archiviazione,
   * modello), che è esattamente il lost-update che ha portato a preferire le
   * scritture per colonna in questo file.
   *
   * `null` cancella la voce (contesto distrutto). Il topic inesistente è un
   * no-op silenzioso: il contextId può appartenere a una pane temporanea o a un
   * terminale (`term-<id>`), che non ha una riga qui.
   */
  function setTopicBrowserState(topicId: string, state: Topic['browserState'] | null): void {
    try {
      db.prepare("UPDATE topics SET browser_state = ? WHERE id = ?").run(
        state ? JSON.stringify(state) : null,
        topicId,
      );
    } catch (err) {
      console.warn(`[topics] setTopicBrowserState(${topicId}) fallita:`, (err as Error).message);
    }
  }

  /**
   * Scrive SOLO `updated_at` per un topic, e restituisce la riga RILETTA.
   *
   * Il bump di attività chiude il turno di chat, cioè arriva MINUTI dopo che
   * la richiesta ha letto il topic. Farlo con `saveSingleTopic(topic)` significa
   * riscrivere venti colonne dall'oggetto letto all'inizio del turno: tutto ciò
   * che il turno stesso ha cambiato nel frattempo — `project_path` scritto da
   * `open_project`, il nome, il provider — torna al valore vecchio. È così che
   * una chat spostata in un progetto a metà risposta si ritrovava slegata a fine
   * risposta, senza un errore da nessuna parte.
   *
   * Ritorna `null` se il topic non esiste più (cancellato mentre il turno era in
   * corso): il chiamante salta il broadcast invece di annunciare un fantasma.
   */
  function touchTopicActivity(topicId: string, updatedAt: string): Topic | null {
    try {
      db.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(updatedAt, topicId);
    } catch (err) {
      console.warn(`[topics] touchTopicActivity(${topicId}) fallita:`, (err as Error).message);
    }
    return getTopicById(topicId);
  }

  // THE ATTENTION STORE (notifications-redesign): the one writer of a
  // subject's state, its epoch, its history row and its push. Here it gets the
  // data it needs that live in the DB: where to announce, a chat's unread, and
  // the words of an announce: the name of the chat or the card, the mute
  // (`isTopicSilenced`: archived, muted, or inside a muted project, read at the
  // moment of the announce, never cached), and a card's pending question.
  configureAttentionStore({
    db: () => db,
    broadcast: (frame) => broadcastToAll(frame),
    unreadOf: (topicId) => (stmts.getUnreadOne.get(topicId) as { unread_count?: number } | null)?.unread_count ?? 0,
    resetUnread: (topicId) => {
      const current = (stmts.getUnreadOne.get(topicId) as { unread_count?: number } | null)?.unread_count ?? 0;
      if (current <= 0) return;
      // The seen door's own frame carries the zero (`attention:updated.row.unread`).
      saveUnreadEntries({ [topicId]: { lastReadAt: new Date().toISOString(), unreadCount: 0 } });
    },
    describe: (subject) => {
      const topicId = topicIdOfSubject(subject);
      if (topicId) {
        const topic = getTopicById(topicId);
        return { name: topic?.name ?? null, silenced: isTopicSilenced(topic, readMutedProjects(db)) };
      }
      // A card's words travel with its state (`setCard`, from the task service).
      return null;
    },
    // A sub-agent's subject carries its agent id: `topic:<id>` (native child)
    // or `terminal:<id>` (CLI child). Its result already reaches the parent.
    isSubagent: (subject) => {
      const id = topicIdOfSubject(subject) ?? terminalIdOfSubject(subject);
      return !!id && attemptSubagentParents(`SELECT 1 FROM subagents WHERE id = ? LIMIT 1`, id).length > 0;
    },
    engageSubagent: (subject) => {
      const id = topicIdOfSubject(subject) ?? terminalIdOfSubject(subject);
      if (id) markSubagentEngaged(db, id);
    },
    subagentEngaged: (subject) => {
      const id = topicIdOfSubject(subject) ?? terminalIdOfSubject(subject);
      return !!id && isSubagentEngaged(db, id);
    },
  }, { fresh: true });
  // The chat behind a session key, for the waits and the background work that
  // know only the session.
  configureAttentionWire({
    subjectForSessionKey: (sessionKey) => {
      const topic = getTopicBySessionKey(sessionKey);
      return topic ? topicSubject(topic.id) : null;
    },
  });

  // The notification log, as above: the one fact it lacks, whether the target
  // topic is archived. A new row reaches the windows in the attention store's
  // frame, never from the log.
  configureNotificationRegistry({
    isTopicArchived: (topicId) => !!getTopicById(topicId)?.archived,
  });

  /**
   * Load a single topic by sessionKey. Same constant-time read as
   * `getTopicById` but indexed on `session_key` (UNIQUE in migration 001).
   * Used by chat/abort, autoname, gateway hooks, and other code paths that
   * only know the session, not the topic id.
   */
  function getTopicBySessionKey(sessionKey: string): Topic | null {
    const row = stmts.getTopicBySessionKey.get(sessionKey) as DbRow;
    if (!row) return null;
    return rowToTopic(row);
  }

  /**
   * @deprecated Bulk-save every topic in `data`. All in-tree callers were
   * migrated to `saveSingleTopic` / `getTopicById` / targeted column writes
   * because the old "load-all → mutate one → save-all" pattern carried a
   * lost-update race: two concurrent requests would each load a snapshot,
   * mutate disjoint fields, and save — the second save would overwrite the
   * first's mutation with stale values. This function is kept ONLY for
   * out-of-tree consumers (CLI tooling, tests) and now upserts without
   * deleting absent topics. Topics are never hard-deleted (archive-only
   * state model — see project memory `topic-state-model`).
   */
  function saveTopics(data: TopicsData): void {
    db.transaction(() => {
      for (const topic of Object.values(data.topics)) {
        saveSingleTopic(topic);
      }
    })();
  }

  // --- Unread (SQLite-backed) ---
  function unreadFromRows(rows: DbRow[]): UnreadData {
    const result: UnreadData = {};
    for (const row of rows) result[row.topic_id] = { lastReadAt: row.last_read_at as string, unreadCount: row.unread_count as number };
    return result;
  }
  function loadUnread(): UnreadData { return unreadFromRows(stmts.getAllUnread.all() as DbRow[]); }

  function saveUnread(data: UnreadData): void {
    db.transaction(() => {
      // Get current unread topic IDs
      const currentRows = stmts.getAllUnread.all() as DbRow[];
      const currentIds = new Set(currentRows.map(r => r.topic_id));
      const newIds = new Set(Object.keys(data));

      // Delete entries not in new data
      for (const id of currentIds) {
        if (!newIds.has(id)) stmts.deleteUnread.run(id);
      }
      // Upsert all entries
      for (const [topicId, entry] of Object.entries(data)) {
        stmts.upsertUnread.run(topicId, entry.lastReadAt, entry.unreadCount);
      }
    })();
  }

  /** +1 on one row, returns the new count: `saveUnread` rewrote all 1,146 rows (3 ms, 161 KB of WAL). */
  function bumpUnread(topicId: string): number {
    const row = stmts.bumpUnread.get(topicId, new Date().toISOString()) as { unread_count: number };
    return row.unread_count;
  }

  /** Writes only these rows, in one transaction; every other row is left alone. */
  function saveUnreadEntries(entries: UnreadData): void {
    db.transaction(() => {
      for (const [topicId, entry] of Object.entries(entries)) {
        stmts.setUnreadEntry.run(topicId, entry.lastReadAt, entry.unreadCount);
      }
    })();
  }










  const {
    saveLocalMessages, appendLocalMessage, appendImportedMessages, createPartialMessage, reuseOrCreatePartialForReattach, reuseHeadstoneOrCreate, updateLastMessage, appendToLastMessage, finalizeLastMessage, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields,
  } = createMessageThreadWrites({ db, stmts, parseBlocksCol, rowToMessage, metaParams, writeMessage, loadActiveThread });














  const {
    startStream, updateStreamActivity, updateStreamContent, getStreamContent, endStream, isStreaming,
  } = createStreamRegistry({ db, activeStreams, turnLedger });






  // --- Request helpers (unchanged) ---
  async function readJSON(req: Request): Promise<unknown> {
    try { return await req.json(); } catch { return null; }
  }

  function json(data: unknown, status = 200): Response {
    // no-store: API payloads (tasks, topics, chat history…) are live state.
    // Without an explicit Cache-Control a WKWebView/URLSession is allowed to
    // heuristically cache 200 GETs — the board or a chat thread would then
    // reopen on YESTERDAY's data until a hard reload. Static assets keep their
    // own policy in server.ts (index.html no-cache, hashed assets immutable).
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
    const patternParts = pattern.split("/");
    const pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }
    return params;
  }

  function errorResponse(status: number, message: string, options: ErrorResponseOptions = {}): Response {
    const { log = true, details } = options;
    if (log && status >= 500) console.error(`[Error ${status}] ${message}`, details || "");
    else if (log && status >= 400) console.warn(`[Warn ${status}] ${message}`);
    const body: { error: string; details?: unknown } = { error: message };
    if (details !== undefined) body.details = details;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function slugify(name: string): string {
    return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // --- Path resolution (unchanged) ---
  // Both roots, whichever one is live: a path saved under the legacy root must
  // stay readable on an install that resolves to `~/.topics`.
  const ALLOWED_FILE_BASES = appDataRoots();

  function resolveSafePath(inputPath: string, allowedBases: string[] = ALLOWED_FILE_BASES): string | null {
    if (!inputPath) return null;
    let expanded = inputPath;
    if (inputPath.startsWith("~")) {
      // `homeDir()` and not `process.env.HOME`: on Windows that variable is
      // usually unset, and a `~` path resolved to nothing every time.
      const home = homeDir();
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    const resolved = resolve(expanded);
    if (isTopicsSecretPath(resolved)) return null;
    const real = realPathForNewEntry(resolved);
    if (real === null || isTopicsSecretPath(real)) return null;
    const isAllowed = allowedBases.some(base => isInsideDir(resolved, base));
    if (!isAllowed) {
      console.warn(`[Security] Path access denied: ${inputPath} -> ${resolved}`);
      return null;
    }
    return resolved;
  }

  /**
   * L'allowlist dei progetti, con una finestra di validità.
   *
   * Ricalcolarla a ogni chiamata costerebbe due query SQL e un `realpath` per
   * voce, e `resolveProjectPath` ha 47 chiamanti — alcuni nel percorso caldo
   * dell'albero dei file. Cinque secondi bastano: una cartella appena aperta
   * col picker entra nell'allowlist entro un battito, e nel frattempo il
   * client non ha ancora niente da chiederle.
   */
  // `knownDirsCache` is declared above `saveSingleTopic`, which empties it.
  const KNOWN_DIRS_TTL_MS = 5_000;
  function allowedProjectDirs(): Set<string> {
    const now = Date.now();
    if (knownDirsCache && now - knownDirsCache.at < KNOWN_DIRS_TTL_MS) return knownDirsCache.dirs;
    const dirs = knownProjectDirs({ db, loadTopics, worktreeStore, projectStore });
    knownDirsCache = { at: now, dirs };
    return dirs;
  }

  /**
   * Quanto spesso si può ricalcolare l'allowlist per SMENTIRE un diniego.
   *
   * La cache da 5 secondi è un'ottimizzazione, non una regola: una cartella
   * appena aperta è già un progetto legittimo prima che il timer scada, e nel
   * frattempo ogni chiamata su di lei prendeva un 400. Il pannello git se ne
   * riprende da solo (ripolla), ma un'azione one-shot — cancella questo file,
   * metti in stage questo blocco — falliva e basta, con un messaggio che non
   * spiegava niente.
   *
   * Quindi prima di negare si ricalcola. Il ricalcolo costa due query e un
   * `realpath` per voce, e sta solo sul percorso del DINIEGO, che è raro: ma
   * «raro» non vale se qualcuno bussa apposta su path negati, quindi al più
   * uno ogni mezzo secondo. Oltre quello il diniego resta.
   */
  const DENY_REFRESH_MIN_MS = 500;
  let lastDenyRefresh = 0;
  function allowedProjectDirsFresh(): Set<string> | null {
    const now = Date.now();
    if (now - lastDenyRefresh < DENY_REFRESH_MIN_MS) return null;
    lastDenyRefresh = now;
    knownDirsCache = null;
    return allowedProjectDirs();
  }

  /**
   * Risolve un path DI PROGETTO arrivato dal client, dentro il confine.
   *
   * Fino al 2026-08-06 questa funzione faceva `resolve()` e basta — nessun
   * contenimento — mentre il suo gemello `resolveSafePath`, dodici righe sopra,
   * la allowlist ce l'ha da sempre e logga persino il diniego. Ci passano 47
   * chiamanti in `routes/files.ts`, e non sono solo letture: rename, move,
   * delete e write prendono il path dal body. Sopra c'era l'unico cancello del
   * server, che è per ORIGINE e non per trasporto (`server/lib/auth-gate.ts`:
   * ogni GET su `/api/` passa senza condizioni, e una richiesta senza header
   * `Origin` — cioè `curl` — passa comunque). Il CORS è una regola del browser,
   * non un controllo d'accesso: un peer sulla rete non ha un'origine da negare.
   * Misurato: `GET /api/files/search?q=localhost&path=/private/etc` rispondeva
   * 200 con 58 righe da `ssh/`, `postfix/`, `cups/`.
   *
   * Il confine è l'UNIONE delle dir che il server già conosce
   * (`services/known-project-dirs.ts`) — la stessa lista che `/api/projects/icon`
   * usa da due mesi, estratta invece di riscritta. Nessuna delle sue cinque
   * sorgenti è alimentabile chiamando queste rotte, quindi è un confine vero.
   * Source 4 (terminal cwds) was the exception: a paired device could POST
   * any `cwd` to `/api/terminal/sessions` and read it back from here. Since
   * 2026-09-03 that route accepts from a device only a cwd that passes THIS
   * function (or the broad default, which `knownProjectDirs` drops).
   *
   * Il fix sta QUI e non sui 47 chiamanti: metterlo lì significherebbe
   * dimenticarne uno, e quello dimenticato sarebbe il buco.
   */
  function resolveProjectPath(inputPath: string): string | null {
    if (!inputPath) return null;
    let expanded = inputPath;
    if (inputPath.startsWith("~")) {
      // `homeDir()` and not `process.env.HOME`: on Windows that variable is
      // usually unset, and a `~` path resolved to nothing every time.
      const home = homeDir();
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    const resolved = resolve(expanded);
    if (isTopicsSecretPath(resolved)) return null;
    // Il confronto è sul path REALE: senza `realpath` un symlink dentro un
    // progetto noto è una porta verso qualunque punto del disco.
    const real = realPathForNewEntry(resolved);
    if (real === null || isTopicsSecretPath(real)) return null;
    if (!isInsideKnownProject(real, allowedProjectDirs())) {
      // Prima di negare, si guarda una volta se la lista è solo VECCHIA — vedi
      // `allowedProjectDirsFresh`. Il confine non cambia: cambia solo che non
      // si nega per un ritardo di cinque secondi.
      const fresche = allowedProjectDirsFresh();
      if (!fresche || !isInsideKnownProject(real, fresche)) {
        console.warn(`[Security] Project path denied: ${inputPath} -> ${real}`);
        return null;
      }
    }
    return resolved;
  }

  /**
   * Resolve the working directory for a topic — Phase A · TOPIC-WT-01 §4.
   *
   * Precedence:
   *   1. If topic is bound to a Worktree (worktreeId NOT NULL) AND that
   *      worktree exists AND its status is `ready`, return the worktree's
   *      absPath. This is what slash commands, browser preview, and
   *      template loading scope to when the topic is worktree-bound.
   *   2. Otherwise fall back to `resolveProjectPath(topic.projectPath)` —
   *      identical to the pre-Phase-A behaviour for unbound (legacy) topics.
   *   3. If neither is set, return null (caller decides what to do).
   *
   * Pending or errored worktrees fall through to the projectPath fallback
   * so the user is never blocked from chatting while git is still working.
   */
  function resolveTopicCwd(topic: Topic | null | undefined): string | null {
    if (!topic) return null;
    if (topic.worktreeId) {
      const wt = worktreeStore.get(topic.worktreeId);
      if (wt && wt.status === "ready") return wt.absPath;
      // pending / error / missing → fall through to projectPath
    }
    return topic.projectPath ? resolveProjectPath(topic.projectPath) : null;
  }

  // --- Media helpers (unchanged) ---
  // Media bases: EVERY app data root, not just the live one. A path recorded in
  // the DB belongs to the root that was live when it was written, and the two
  // populations coexist on the same machine — an install that predates card
  // 211605ee keeps writing under the legacy root, a fresh one writes under
  // `~/.topics`, and browser screenshots have gone to `~/.topics/media` all
  // along. The legacy root also stays readable because it is a SHARED root of
  // the surrounding tooling; the root itself is never migrated here.
  const ALLOWED_MEDIA_BASES = appDataRoots().flatMap((root) => [join(root, "media"), join(root, "workspace")]);

  function getMimeType(filepath: string): string {
    const ext = extname(filepath).toLowerCase().replace(".", "");
    const types: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
      aac: "audio/aac", opus: "audio/opus", pdf: "application/pdf",
      json: "application/json", txt: "text/plain", md: "text/markdown",
      csv: "text/csv", html: "text/html", css: "text/css", js: "application/javascript",
      zip: "application/zip", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    return types[ext] || "application/octet-stream";
  }

  function isPathAllowed(filepath: string): boolean {
    const resolved = resolve(filepath);
    if (isTopicsSecretPath(resolved)) return false;
    const allowed = isInsideDir(resolved, UPLOADS_DIR)
      || isInsideDir(resolved, CONTEXT_DIR)
      || ALLOWED_MEDIA_BASES.some((base) => isInsideDir(resolved, base));
    if (!allowed) return false;
    const real = realPathForNewEntry(resolved);
    return real !== null && !isTopicsSecretPath(real);
  }

  // Same two roots as the allowlist: the media a turn produced can land in
  // either, depending on which one this install resolved to.
  const MEDIA_SCAN_DIRS = appDataRoots().flatMap((root) => [join(root, "media/browser"), join(root, "media")]);
  const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "ogg", "m4a", "aac", "opus", "webm", "mp4", "pdf"]);

  // Runs 1s after EVERY completed stream (chat.ts), over media dirs that are
  // never pruned — async fs so the growing scan never blocks the event loop.
  async function findNewMediaFiles(sinceMs: number): Promise<string[]> {
    const results: string[] = [];
    const seen = new Set<string>();
    for (const dir of MEDIA_SCAN_DIRS) {
      try {
        const entries = await readdirAsync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) continue;
          const ext = extname(entry.name).toLowerCase().replace(".", "");
          if (!MEDIA_EXTENSIONS.has(ext)) continue;
          const fullPath = join(dir, entry.name);
          if (seen.has(fullPath)) continue;
          seen.add(fullPath);
          try { const stat = await statAsync(fullPath); if (stat.mtimeMs >= sinceMs) results.push(fullPath); } catch { /* file vanished or unreadable: skip it */ }
        }
      } catch { /* dir missing or unreadable: skip it */ }
    }
    return results;
  }

  function updateLastMessageWithMedia(sessionKey: string, mediaPaths: string[], opts?: { rowId?: string }): void {
    // Targeted lookup — the previous version fetched the WHOLE session just to
    // walk backwards to the newest assistant row.
    const row = (opts?.rowId
      ? stmts.getAssistantMessageById.get(opts.rowId, sessionKey)
      : stmts.getLastAssistantMessage.get(sessionKey)) as DbRow;
    if (!row) return;
    const mediaLines = mediaPaths.map((p: string) => `\nMEDIA:${p}`).join("");
    stmts.appendMessageContent.run((row.content || '') + mediaLines, row.id);
  }

  // The completion line of an API request (called once per request, from the
  // fetch wrapper in server.ts). Format and the quiet-route rule live in
  // lib/http-log.ts, where they are tested.
  function logRequest(method: string, path: string, status: number, startTime: number): void {
    const now = Date.now();
    const line = httpLogLine(new Date(now), method, path, status, now - startTime);
    if (line) console.log(line);
  }

  // --- Search (hybrid: SQLite local + gateway JSONL) ---
  function searchTranscripts(query: string, limit = 50): TranscriptHit[] {
    const results: TranscriptHit[] = [];
    const lowerQuery = query.toLowerCase();
    const topicsData = loadTopics();
    const sessionToTopic: Record<string, Topic> = {};
    for (const topic of Object.values(topicsData.topics)) { sessionToTopic[topic.sessionKey] = topic; }

    // 1) SQLite `messages` — the store the chat actually WRITES. Despite the
    // "hybrid" label above, this half was never implemented: the function only
    // scanned the legacy gateway JSONL transcripts below, so every message of a
    // current chat topic was unfindable from ⌘K (the palette's "Messaggi"
    // section stayed empty for fresh content). LIKE is case-insensitive for
    // ASCII, matching the JSONL path's lowercase comparison; user-typed
    // wildcards are escaped so they match literally.
    try {
      const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = db
        .prepare(
          `SELECT id, session_key, role, content, timestamp FROM messages
           WHERE content LIKE ? ESCAPE '\\'
           ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(like, limit) as DbRow[];
      for (const row of rows) {
        const topic = sessionToTopic[row.session_key];
        if (!topic) continue; // orphaned session — nothing to open from the palette
        results.push({
          // messageId lets the palette scroll the opened topic to the hit;
          // legacy JSONL results below have no stable id (null → open only).
          messageId: row.id,
          sessionKey: row.session_key,
          topicId: topic.id,
          topicName: topic.name,
          topicIcon: topic.icon || "MessageSquare",
          role: row.role as string,
          content: row.content as string,
          timestamp: row.timestamp as string | null,
        });
        if (results.length >= limit) return results;
      }
    } catch (err) {
      console.warn("[Search] messages table query failed:", err);
    }

    // 2) Legacy gateway JSONL transcripts (pre-SQLite sessions).
    const sessionsStorePath = join(SESSIONS_DIR, "sessions.json");
    if (existsSync(sessionsStorePath)) {
      try {
        const store = JSON.parse(readFileSync(sessionsStorePath, "utf-8"));
        for (const [key, entry] of Object.entries(store) as [string, { sessionId?: unknown } | null][]) {
          if (!entry?.sessionId) continue;
          // Guard against path traversal — sessionId becomes a filename below.
          if (typeof entry.sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.sessionId)) continue;
          if (!key.startsWith("topic:")) continue;
          if (!sessionToTopic[key]) continue;
          const jsonlPath = join(SESSIONS_DIR, entry.sessionId + ".jsonl");
          const jsonlContent = readTranscriptJsonl(jsonlPath, { existsSync, readFileSync, gunzipSync });
          if (jsonlContent === null) continue;
          const topic = sessionToTopic[key];
          try {
            const lines = jsonlContent.split("\n").filter(Boolean);
            for (const line of lines) {
              let d: unknown;
              try {
                d = JSON.parse(line);
              } catch {
                continue;
              }
              // Skip non-object rows (e.g. a bare `null` line) before touching
              // .type/.message below — otherwise a single malformed row throws
              // outside any try and aborts the whole session's scan.
              if (!d || typeof d !== "object") continue;
              const entryRecord = d as { type?: string; message?: unknown; timestamp?: string | null };
              if (entryRecord.type === "message" && entryRecord.message && typeof entryRecord.message === "object") {
                const msg = entryRecord.message as { role?: string; content?: unknown };
                if (msg.role === "user" || msg.role === "assistant") {
                  let text = "";
                  if (typeof msg.content === "string") text = msg.content;
                  else if (Array.isArray(msg.content)) text = (msg.content as { type?: string; text?: string }[]).filter((c) => c && typeof c === "object" && c.type === "text").map((c) => c.text).join("\n");
                  if (text.toLowerCase().includes(lowerQuery)) {
                    results.push({ messageId: null, sessionKey: key, topicId: topic?.id || null, topicName: topic?.name || key, topicIcon: topic?.icon || "MessageSquare", role: msg.role, content: text, timestamp: entryRecord.timestamp || null });
                    if (results.length >= limit) return results;
                  }
                }
              }
            }
          } catch (err) {
            console.warn(`[Search] legacy transcript scan failed for ${entry.sessionId}:`, err);
          }
        }
      } catch (err) {
        // sessions.json is unreadable or malformed: legacy JSONL transcripts are
        // skipped for this search, but the SQLite `messages` hits above still apply.
        console.warn("[Search] legacy sessions.json scan failed:", err);
      }
    }

    return results;
  }

  const ALLOWED_UPLOAD_MIMES = new Set([
    "text/plain", "text/markdown", "text/csv", "text/html", "text/css", "text/javascript",
    "application/json", "application/xml", "application/pdf", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm",
    // Review clips (Playwright / spec-flow recordings) as first-class evidence.
    "video/webm", "video/mp4", "video/quicktime",
  ]);

  const {
    getMessageById, getMessageSessionKey, createBranchMessage, createBranchPartialMessage, deleteMessageSubtree, discardIfEmptyTurn, switchActiveBranch, getSiblingMessages,
  } = createMessageBranches({ db, stmts, rowToMessage, metaParams });








  return {
    db,
    projectStore, worktreeStore, worktreeManager,
    /** Iniettato da server.ts dopo createProcessesRouter (lazy closure). */
    worktreeGcDeps: _worktreeGcDeps,
    machineStore,
    PORT,
    TOPICS_FILE, UNREAD_FILE, PUBLIC_DIR, UPLOADS_DIR, CONTEXT_DIR,
    APP_DATA_DIR, SESSIONS_DIR, MESSAGES_DIR, BASE_DIR: baseDir, STATE_DIR,
    activeStreams, turnLedger, currentStreamActions: () => streamActionFeed.current(), wsClients, deviceSockets,
    broadcast, broadcastToAll, broadcastProject, broadcastToProjectViewers, broadcastToTopic, broadcastToTopicSubscribers, sendToDevice, closeDeviceSockets, setGuestBroadcastFilter,
    loadTopics, saveTopics, saveSingleTopic,
    getTopicById, getTopicBySessionKey, setTopicBrowserState, touchTopicActivity,
    loadUnread, saveUnread, bumpUnread, saveUnreadEntries,
    loadLocalMessages, loadThreadSkeleton, loadThreadRows, loadThreadWindow, hydrateMessageBodies, messageBodyHydrator, countMessagesBySession, saveLocalMessages, appendLocalMessage, appendImportedMessages,
    createPartialMessage, reuseOrCreatePartialForReattach, reuseHeadstoneOrCreate, updateLastMessage, appendToLastMessage,
    finalizeLastMessage, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields,
    startStream, updateStreamActivity, updateStreamContent, getStreamContent, endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    resolveSafePath, resolveProjectPath, resolveTopicCwd, getMimeType, isPathAllowed,
    // La FORMA di un'immagine, per il cancello dell'anteprima: vedi `acceptPreview`.
    imageShapeOf: imageShape,
    // Delegato al contesto per permettere ai test di iniettare uno stub.
    fileExistsSync: existsSync,
    findNewMediaFiles, updateLastMessageWithMedia, atomicWriteJSON, logRequest,
    searchTranscripts, getMessagesPath,
    ALLOWED_UPLOAD_MIMES,
    // Branching
    getMessageById,
    getMessageSessionKey,
    createBranchMessage,
    createBranchPartialMessage,
    deleteMessageSubtree,
    discardIfEmptyTurn,
    switchActiveBranch,
    getSiblingMessages,
    loadActiveThread,
  };
}
