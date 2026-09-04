import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync } from "fs";
import { readFileSync } from "fs";
import { readdir as readdirAsync, stat as statAsync } from "fs/promises";
import { timingSafeEqual } from "crypto";
import { join, resolve, extname } from "path";
import type { ServerWebSocket } from "bun";
import { clientReceivesTopicDelta } from "./lib/ws-topic-routing";
import { warnThrottled } from "./lib/warn-throttled";
import { isReusableHeadstone } from "./lib/empty-turn-headstone";
import type {
  WSData, GuestBroadcastFilter, StoredMessage, ReattachedPartial, ToolCall, Topic, TopicsData, UnreadData,
  ActiveStream, ErrorResponseOptions, AppContext, Project, ThreadLoadOpts, ContentBlock,
} from "./types";
import { initDatabase } from "./db";
import { isGuestSocketData } from "./lib/grants";
import {
  osservatoreDaDispositivo, envelopeProgettoPer,
  type Osservatore, type TipoFrameProgetto,
} from "./lib/project-visibility";
import { readMutedProjects } from "./lib/muted-projects";
import { resolveStateDir } from "./lib/data-dir";
import { decodeCol, encodeCol } from "../shared/message-blob";
import { knownProjectDirs, isInsideKnownProject } from "./services/known-project-dirs";
import { maybeSendPush, configurePushTriggers, isTopicSilenced } from "./push-triggers";
import { configureNotificationRegistry, recordAndAnnounce } from "./notification-registry";
import { createProjectStore } from "./services/project-store";
import { createWorktreeStore } from "./services/worktree-store";
import { createWorktreeManager, type WorktreeManagerGcDeps } from "./services/worktree-manager";
import { createMachineStore } from "./services/machine-store";
import { parseToolCallDetail, knownDetailTypes } from "../shared/tool-call-detail";
import { blocksForDisk, rowHasBlocks, toolCallsColumnForRow, toolCallsForDisk } from "../shared/lean-tool-call";
import { shouldCompressFrame } from "./lib/ws-compression";
import { isEmptyAssistantTurn } from "../shared/empty-turn";
import { validateOutbound } from "../shared/ws-outbound";
import { releaseHumanHold } from "./lib/human-hold";
import { isAwaitingHuman } from "../shared/types";
import type { OutboundMessage } from "../shared/ws-outbound";
import { imageShape } from "./services/image-shape";
import { httpLogLine } from "./lib/http-log";

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
    // eslint-disable-next-line no-console
    console.warn(`[WS:outbound] Malformed broadcast — ${result.error}`, message);
  }
}

/**
 * v3 foundations NORM-01 DB hydration: validate a tool call's `detail`
 * field against the canonical Zod schema. If the detail is missing,
 * returns the toolCall unchanged. If the detail is present and parses,
 * the validated copy is substituted. If the detail is present but
 * malformed, there are two different failures behind that word and they get
 * two different answers.
 *
 * A detail whose `type` the schema has never heard of is the CLI growing a
 * tool kind: the shape is intact, only the taxonomy is behind. Dropping it
 * threw away the only copy of the payload, because persistence removes
 * `result` once the same text lives inside `detail` (shared/lean-tool-call.ts)
 * -- that is how 2736 questions to the human reached the chat mute. Those are
 * kept as `{ type: 'unknown', raw }`: the row degrades to a generic JSON card
 * instead of disappearing.
 *
 * A detail with a KNOWN type and a broken shape is a corrupt row. That one is
 * still dropped, because the renderer re-derives a proper card from `args`,
 * which beats showing the broken object.
 *
 * Both log one throttled line at NORM-DB level so drift stays observable
 * without the 3653 identical lines the untrottled warn used to write.
 */
export function sanitizeToolCallDetail(tc: any): any {
  if (!tc || typeof tc !== 'object' || !tc.detail) return tc;
  const result = parseToolCallDetail(tc.detail);
  if (result.ok) {
    return tc.detail === result.data ? tc : { ...tc, detail: result.data };
  }
  const declaredType = typeof tc.detail?.type === 'string' ? tc.detail.type : undefined;
  if (declaredType && !knownDetailTypes.has(declaredType)) {
    warnThrottled(
      `NORM-DB:unknown-type:${declaredType}`,
      `[NORM-DB] Unknown detail type '${declaredType}' (${tc.name ?? '?'}): kept as raw`,
    );
    return { ...tc, detail: { type: 'unknown', raw: { args: tc.detail } } };
  }
  warnThrottled(
    `NORM-DB:malformed:${declaredType ?? '?'}`,
    `[NORM-DB] Dropping malformed detail for tool call ${tc.id ?? '?'} (${tc.name ?? '?'}): ${result.error}`,
  );
  // `_drop` non si usa PER COSTRUZIONE: destrutturare-e-scartare è il modo di
  // togliere una chiave da un oggetto senza mutarlo. Il valore che conta è `rest`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { detail: _drop, ...rest } = tc;
  return rest;
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

export function createAppContext(baseDir: string): AppContext {
  // CLI PORT override: BUN_PORT beats .env PORT (Bun auto-loads .env first)
  const PORT = parseInt(process.env.BUN_PORT || process.env.PORT || "3333");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:18789";
  let GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || readGatewayTokenFromConfig() || "";

  /** Read gateway token from ~/.openclaw/openclaw.json (auto-syncs when OpenClaw rotates) */
  function readGatewayTokenFromConfig(): string | null {
    try {
      const configPath = join(process.env.HOME || "", ".openclaw", "openclaw.json");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      return config?.gateway?.auth?.token || null;
    } catch { return null; }
  }

  /** Refresh token from openclaw.json — called on auth failure */
  function refreshGatewayToken(): string {
    const fresh = readGatewayTokenFromConfig();
    if (fresh && fresh !== GATEWAY_TOKEN) {
      console.log("[Gateway] Token refreshed from openclaw.json");
      GATEWAY_TOKEN = fresh;
    }
    return GATEWAY_TOKEN;
  }

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
  const CONTEXT_DIR = join(STATE_DIR, "context-files");
  const OPENCLAW_DIR = process.env.APP_DATA_DIR || process.env.OPENCLAW_DIR || `${process.env.HOME}/.openclaw`;
  const SESSIONS_DIR = process.env.SESSIONS_DIR || `${OPENCLAW_DIR}/agents/main/sessions`;
  const MESSAGES_DIR = join(STATE_DIR, "messages");

  mkdirSync(MESSAGES_DIR, { recursive: true });

  // Initialize SQLite (DB file under STATE_DIR/data; migrations read from baseDir)
  const db = initDatabase(baseDir, STATE_DIR);

  // State
  const activeStreams = new Map<string, ActiveStream>();
  const wsClients = new Set<ServerWebSocket<WSData>>();

  // --- Prepared statements (created once for performance) ---
  const stmts = {
    // Topics
    getAllTopics: db.prepare(`SELECT * FROM topics WHERE 1=1`),
    getTopicById: db.prepare(`SELECT * FROM topics WHERE id = ?`),
    getTopicLinks: db.prepare(`SELECT target_id FROM topic_links WHERE source_id = ?`),
    getTopicContextFiles: db.prepare(`SELECT file_path FROM topic_context_files WHERE topic_id = ?`),
    getTopicPinnedMessages: db.prepare(`SELECT message_id FROM topic_pinned_messages WHERE topic_id = ?`),
    getTopicDisabledSources: db.prepare(`SELECT source_id FROM topic_disabled_sources WHERE topic_id = ?`),
    // Batch variants used ONLY by loadTopics() to collapse the per-topic N+1
    // (1 table scan + 5 sub-queries × N topics) into 1 + 5 full scans grouped
    // in-memory. The per-id stmts above stay the path for single-topic reads
    // (getTopicById / getTopicBySessionKey), which must not pay a full scan.
    getAllTopicLinks: db.prepare(`SELECT source_id, target_id FROM topic_links`),
    getAllTopicContextFiles: db.prepare(`SELECT topic_id, file_path FROM topic_context_files`),
    getAllTopicPinnedMessages: db.prepare(`SELECT topic_id, message_id FROM topic_pinned_messages`),
    getAllTopicDisabledSources: db.prepare(`SELECT topic_id, source_id FROM topic_disabled_sources`),

    // True UPSERT, NOT `INSERT OR REPLACE`: in SQLite, REPLACE resolves the
    // conflict by DELETING the old row and inserting a new one, and with
    // PRAGMA foreign_keys=ON that hidden DELETE fires every ON DELETE action
    // pointing at topics. Every topic update (rename, PATCH model/effort,
    // archive toggle…) was silently CASCADE-wiping `claude_code_sessions`
    // (the `--resume` mapping — chat lost its CLI session and respawned
    // fresh) and `unread`, and SET NULL-ing children's
    // `parent_id`. ON CONFLICT DO UPDATE mutates the row in place — no
    // delete, no cascade. Guarded by utils-topic-save.test.ts.
    insertTopic: db.prepare(`
      INSERT INTO topics (id, name, slug, parent_id, session_key, color, icon, system_prompt, project_path, sort_order, autonomy_level, provider, model, effort, fast_mode, muted, worktree_id, initial_message, standalone, mcp_policy, browser_state, archived, created_at, updated_at)
      VALUES ($id, $name, $slug, $parent_id, $session_key, $color, $icon, $system_prompt, $project_path, $sort_order, $autonomy_level, $provider, $model, $effort, $fast_mode, $muted, $worktree_id, $initial_message, $standalone, $mcp_policy, $browser_state, $archived, $created_at, $updated_at)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        parent_id = excluded.parent_id,
        session_key = excluded.session_key,
        color = excluded.color,
        icon = excluded.icon,
        system_prompt = excluded.system_prompt,
        project_path = excluded.project_path,
        sort_order = excluded.sort_order,
        autonomy_level = excluded.autonomy_level,
        provider = excluded.provider,
        model = excluded.model,
        effort = excluded.effort,
        fast_mode = excluded.fast_mode,
        muted = excluded.muted,
        worktree_id = excluded.worktree_id,
        initial_message = excluded.initial_message,
        standalone = excluded.standalone,
        mcp_policy = excluded.mcp_policy,
        browser_state = excluded.browser_state,
        archived = excluded.archived,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `),
    // Topic relations
    deleteTopicLinks: db.prepare(`DELETE FROM topic_links WHERE source_id = ?`),
    insertTopicLink: db.prepare(`INSERT OR IGNORE INTO topic_links (source_id, target_id) VALUES (?, ?)`),
    deleteTopicContextFiles: db.prepare(`DELETE FROM topic_context_files WHERE topic_id = ?`),
    insertTopicContextFile: db.prepare(`INSERT OR IGNORE INTO topic_context_files (topic_id, file_path) VALUES (?, ?)`),
    deleteTopicPinnedMessages: db.prepare(`DELETE FROM topic_pinned_messages WHERE topic_id = ?`),
    insertTopicPinnedMessage: db.prepare(`INSERT OR IGNORE INTO topic_pinned_messages (topic_id, message_id) VALUES (?, ?)`),
    deleteTopicDisabledSources: db.prepare(`DELETE FROM topic_disabled_sources WHERE topic_id = ?`),
    insertTopicDisabledSource: db.prepare(`INSERT OR IGNORE INTO topic_disabled_sources (topic_id, source_id) VALUES (?, ?)`),
    // Unread
    getAllUnread: db.prepare(`SELECT topic_id, last_read_at, unread_count FROM unread`),
    upsertUnread: db.prepare(`INSERT OR REPLACE INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, ?)`),
    deleteUnread: db.prepare(`DELETE FROM unread WHERE topic_id = ?`),

    // Messages
    getMessages: db.prepare(`SELECT * FROM messages WHERE session_key = ? ORDER BY sort_order ASC`),
    /**
     * Like `getMessages`, minus the TWO fat columns: `blocks` and `tool_calls`.
     *
     * It exists for context assembly, which runs on EVERY turn of every agent
     * and reads only role/content/partial/id off the thread (the comment above
     * the call in `server/context/assemble.ts` says so). Those two columns are
     * 98% of the table: 353 MB and 220 MB against 13 MB of message text, on this
     * machine's database as of 2026-08-14.
     *
     * Measured on a copy of that database, topic 6b99e9cf, 118 rows (4.11 MB of
     * `tool_calls` and 7.17 MB of `blocks`), median of 7 runs:
     *
     *   SELECT *                                 6.1 ms
     *   SELECT * plus JSON.parse of tool_calls  14.5 ms   <- what was being paid
     *   SELECT without blocks/tool_calls         0.5 ms
     *
     * `withBlocks: false` on its own skipped the parse of `blocks` but not the
     * one of `tool_calls`, so half the cost stayed, and the bytes of both came
     * over from SQLite regardless. Here they never leave the table.
     */
    getMessagesLean: db.prepare(
      `SELECT id, session_key, role, content, thinking, media, partial, streamed_at,
              plan_status, timestamp, sort_order, parent_id, branch_index, latency_ms,
              usage_prompt_tokens, usage_completion_tokens, cost_cents, cache_read_tokens,
              cache_creation_tokens, cache_creation_1h_tokens, model, author_person_id,
              author_device_id
       FROM messages WHERE session_key = ? ORDER BY sort_order ASC`,
    ),
    getLastMessage: db.prepare(`SELECT * FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`),
    /**
     * Come `getLastMessage`, ma SENZA la colonna `blocks`.
     *
     * I due mutatori caldi dei tool call — `addToolCallToLastMessage` e
     * `updateToolCallResult` — leggono e riscrivono solo `tool_calls`: con
     * `SELECT *` il messaggio in corso viaggia dal DB con la timeline intera
     * appresso — su un turno lungo è ~1,3 MB per evento di tool, letti e
     * immediatamente scartati. Le colonne qui sono esattamente quelle che quei due
     * mutatori leggono o riscrivono.
     */
    getLastMessageForToolUpdate: db.prepare(
      `SELECT id, session_key, role, content, thinking, tool_calls, media, partial, streamed_at, plan_status, timestamp,
              CASE WHEN blocks IS NULL OR blocks IN ('', '[]', 'null') THEN 0 ELSE 1 END AS has_blocks,
              CASE WHEN tool_calls IS NULL OR tool_calls IN ('', '[]', 'null') THEN 0 ELSE 1 END AS has_tool_calls
       FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`,
    ),
    /**
     * La variante CON `blocks`, per il solo `updateToolCallFields`.
     *
     * `blocks` serve lì e solo lì: quando un messaggio ha blocchi, chi disegna
     * legge quelli e ignora `tool_calls`, quindi la patch deve toccare entrambe
     * le colonne. Senza questa SELECT la patch ai blocchi partirebbe su un
     * `undefined` e non scriverebbe niente — un aggiornamento che gira, non
     * fallisce, e non si vede (visto il 7 agosto: tre chiamate ferme in attesa
     * di un permesso, il piede della chat che lo diceva, e NESSUN pannello).
     *
     * È separata dalla statement qui sopra perché le frequenze non c'entrano
     * niente l'una con l'altra: `updateToolCallFields` gira quando un tool si
     * ferma a chiedere qualcosa a una persona (unità per turno, se va bene),
     * gli altri due a ogni start e a ogni risultato (decine). Far pagare a
     * questi ultimi la timeline intera era il grosso del costo per evento.
     */
    getLastMessageForToolFields: db.prepare(`SELECT id, session_key, role, content, thinking, tool_calls, blocks, media, partial, streamed_at, plan_status, timestamp FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`),
    /**
     * Per `updateLastMessage`: SOLO ciò che quella funzione riscrive.
     *
     * Né `blocks` né `tool_calls`. `updateLastMessage` non li legge mai — scrive
     * `tool_calls` unicamente quando il chiamante glielo passa, e `blocks` passa
     * per `metaParams(updates)`, cioè dal chiamante e basta — eppure con
     * `SELECT *` si portava dal DB le due colonne più pesanti della tabella a
     * ogni scrittura del corpo del turno.
     *
     * Al posto loro due sonde: la riga ha tool call? ha blocchi? Servono a
     * `discardIfEmptyTurn`, che deve poter distinguere un segnaposto vuoto da un
     * turno che ha prodotto SOLO tool o SOLO blocchi — cancellare quello sarebbe
     * perdita di dati. La domanda è booleana, e si risponde in SQL invece di
     * trascinare megabyte fin qui per farne un `length > 0`.
     *
     * `'[]'` e `'null'` contano come vuote, come in `hasItems`
     * (shared/empty-turn.ts). Una colonna con dentro qualcos'altro conta come
     * piena: nel dubbio si tiene la riga, non si cancella.
     */
    getLastMessageForBodyUpdate: db.prepare(
      `SELECT id, session_key, role, content, thinking, media, partial, streamed_at,
              plan_status, timestamp, parent_id, branch_index, latency_ms,
              usage_prompt_tokens, usage_completion_tokens, cost_cents, cache_read_tokens,
              cache_creation_tokens, cache_creation_1h_tokens, model, author_person_id,
              author_device_id,
              CASE WHEN blocks IS NULL OR blocks IN ('', '[]', 'null') THEN 0 ELSE 1 END AS has_blocks
       FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`,
    ),
    /** Le due sonde di `getLastMessageForBodyUpdate`, per id. Vedi `discardIfEmptyTurn`. */
    messageBodyPresence: db.prepare(
      `SELECT CASE WHEN tool_calls IS NULL OR tool_calls IN ('', '[]', 'null') THEN 0 ELSE 1 END AS has_tool_calls,
              CASE WHEN blocks     IS NULL OR blocks     IN ('', '[]', 'null') THEN 0 ELSE 1 END AS has_blocks
       FROM messages WHERE id = ?`,
    ),
    /** La sola colonna `blocks`, per id.
     *
     *  La legge `discardIfEmptyTurn` e nessun altro, su una riga che la sonda
     *  qui sopra ha già dichiarato senza tool: serve a distinguere «blocchi che
     *  sono LAVORO» da «blocchi che sono solo l'eco di un testo nullo». Una
     *  lettura mirata invece che l'intera riga, e su un cammino che si percorre
     *  quasi mai. */
    getMessageBlocks: db.prepare(`SELECT blocks FROM messages WHERE id = ?`),
    getLastAssistantMessage: db.prepare(`SELECT id, content FROM messages WHERE session_key = ? AND role = 'assistant' ORDER BY sort_order DESC LIMIT 1`),
    appendMessageContent: db.prepare(`UPDATE messages SET content = ? WHERE id = ?`),
    getMaxSortOrder: db.prepare(`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM messages WHERE session_key = ?`),
    insertMessage: db.prepare(`
      INSERT INTO messages (id, session_key, role, content, thinking, tool_calls, blocks, media, partial, streamed_at, plan_status, timestamp, sort_order, parent_id, branch_index, latency_ms, usage_prompt_tokens, usage_completion_tokens, cost_cents, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, model, author_person_id, author_device_id)
      VALUES ($id, $session_key, $role, $content, $thinking, $tool_calls, $blocks, $media, $partial, $streamed_at, $plan_status, $timestamp, $sort_order, $parent_id, $branch_index, $latency_ms, $usage_prompt_tokens, $usage_completion_tokens, $cost_cents, $cache_read_tokens, $cache_creation_tokens, $cache_creation_1h_tokens, $model, $author_person_id, $author_device_id)
    `),
    updateMessage: db.prepare(`
      UPDATE messages SET
        content = COALESCE($content, content),
        thinking = COALESCE($thinking, thinking),
        tool_calls = COALESCE($tool_calls, tool_calls),
        blocks = COALESCE($blocks, blocks),
        media = $media,
        partial = $partial, streamed_at = $streamed_at, plan_status = $plan_status,
        latency_ms = COALESCE($latency_ms, latency_ms),
        cache_read_tokens = COALESCE($cache_read_tokens, cache_read_tokens),
        cache_creation_tokens = COALESCE($cache_creation_tokens, cache_creation_tokens),
        cache_creation_1h_tokens = COALESCE($cache_creation_1h_tokens, cache_creation_1h_tokens),
        usage_prompt_tokens = COALESCE($usage_prompt_tokens, usage_prompt_tokens),
        usage_completion_tokens = COALESCE($usage_completion_tokens, usage_completion_tokens),
        cost_cents = COALESCE($cost_cents, cost_cents),
        model = COALESCE($model, model),
        author_person_id = COALESCE($author_person_id, author_person_id),
        author_device_id = COALESCE($author_device_id, author_device_id)
      WHERE id = $id
    `),
    deleteMessagesBySession: db.prepare(`DELETE FROM messages WHERE session_key = ?`),
    /** Quante righe ha la sessione INTERA, rami morti compresi. È ciò che la
     *  cancellazione colpisce davvero: il ramo attivo è un sottoinsieme. */
    countMessagesBySession: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_key = ?`),

    // Branching
    getMessageById: db.prepare(`SELECT * FROM messages WHERE id = ?`),
    getChildren: db.prepare(`SELECT * FROM messages WHERE parent_id = ? ORDER BY branch_index ASC`),
    getSiblings: db.prepare(`SELECT * FROM messages WHERE parent_id = ? ORDER BY branch_index ASC`),
    getMaxBranchIndex: db.prepare(`SELECT COALESCE(MAX(branch_index), -1) as max_idx FROM messages WHERE parent_id = ?`),
    getActiveBranch: db.prepare(`SELECT active_branch_index FROM active_branches WHERE parent_id = ? AND session_key = ?`),
    upsertActiveBranch: db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)`),
    getRootMessages: db.prepare(`SELECT * FROM messages WHERE session_key = ? AND parent_id IS NULL ORDER BY sort_order ASC`),
    deleteActiveBranchesBySession: db.prepare(`DELETE FROM active_branches WHERE session_key = ?`),
    // On the 15s `/api/topics/streaming` path of every client since it stopped
    // hydrating the whole table; it used to re-prepare on each call.
    getTopicBySessionKey: db.prepare(`SELECT * FROM topics WHERE session_key = ? LIMIT 1`),
  };

  // Pre-grouped topic relations, built once per loadTopics() call by
  // buildTopicRelations() and threaded into rowToTopic to avoid the N+1.
  type TopicRelations = {
    links: Map<string, string[]>;
    contextFiles: Map<string, string[]>;
    pinnedMessages: Map<string, string[]>;
    disabledSources: Map<string, string[]>;
  };
  function buildTopicRelations(): TopicRelations {
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
      const arr = m.get(k); if (arr) arr.push(v); else m.set(k, [v]);
    };
    const links = new Map<string, string[]>();
    for (const r of stmts.getAllTopicLinks.all() as any[]) push(links, r.source_id, r.target_id);
    const contextFiles = new Map<string, string[]>();
    for (const r of stmts.getAllTopicContextFiles.all() as any[]) push(contextFiles, r.topic_id, r.file_path);
    const pinnedMessages = new Map<string, string[]>();
    for (const r of stmts.getAllTopicPinnedMessages.all() as any[]) push(pinnedMessages, r.topic_id, r.message_id);
    const disabledSources = new Map<string, string[]>();
    for (const r of stmts.getAllTopicDisabledSources.all() as any[]) push(disabledSources, r.topic_id, r.source_id);
    return { links, contextFiles, pinnedMessages, disabledSources };
  }

  // --- Helper: Convert SQLite topic row to Topic object ---
  // `rels` (supplied by loadTopics) reads relations from pre-grouped maps;
  // without it each relation is a per-id sub-query (single-topic read path).
  function rowToTopic(row: any, rels?: TopicRelations): Topic {
    const topic: Topic = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      parentId: row.parent_id || null,
      links: rels ? (rels.links.get(row.id) ?? []) : (stmts.getTopicLinks.all(row.id) as any[]).map(r => r.target_id),
      sessionKey: row.session_key,
      color: row.color,
      icon: row.icon,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: !!row.archived,
    };
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

    const contextFiles = rels ? (rels.contextFiles.get(row.id) ?? []) : (stmts.getTopicContextFiles.all(row.id) as any[]).map(r => r.file_path);
    if (contextFiles.length > 0) topic.contextFiles = contextFiles;

    const pinnedMessages = rels ? (rels.pinnedMessages.get(row.id) ?? []) : (stmts.getTopicPinnedMessages.all(row.id) as any[]).map(r => r.message_id);
    if (pinnedMessages.length > 0) topic.pinnedMessages = pinnedMessages;

    const disabledSources = rels ? (rels.disabledSources.get(row.id) ?? []) : (stmts.getTopicDisabledSources.all(row.id) as any[]).map(r => r.source_id);
    if (disabledSources.length > 0) topic.disabledContextSources = disabledSources;

    return topic;
  }

  // --- Helper: Save a single topic and its relations to SQLite ---
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
        // initial_message (Phase C · migration 019). One-shot — the renderer
        // PATCHes back to null after dispatching it.
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
  }

  // --- Helper: Convert SQLite message row to StoredMessage ---
  /**
   * Riga → messaggio. `withBlocks: false` salta il parse della timeline.
   *
   * Serve ai mutatori dei tool call, che leggono e riscrivono SOLO `tool_calls`:
   * idratare anche `blocks` significa un `JSON.parse` di ~1,3 MB più un
   * `sanitizeToolCallDetail` per blocco, buttati via subito dopo. Su un turno
   * agentico lungo quel lavoro si paga a OGNI evento di tool — decine di volte per
   * turno, sul thread unico di Bun — e la chat si impunta a scatti proprio quando
   * l'agente sta lavorando di più.
   *
   * `withToolCalls: false` fa lo stesso per `tool_calls`. Finora quel parse era
   * INCONDIZIONATO: chi passava `withBlocks: false` — cioè chi ha dichiarato di
   * non voler nemmeno il grosso — si ritrovava comunque il secondo parse addosso,
   * e sui turni agentici `tool_calls` è la seconda colonna più pesante della
   * tabella. Ora la scelta è simmetrica, e chi legge dalle statement magre (che
   * la colonna non la chiedono nemmeno) non paga niente in ogni caso.
   *
   * Default `true` per entrambe: nessun altro chiamante cambia comportamento.
   */
  function rowToMessage(row: any, opts?: { withBlocks?: boolean; withToolCalls?: boolean }): StoredMessage {
    const msg: StoredMessage = {
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    };
    if (row.thinking) msg.thinking = row.thinking;
    if (row.tool_calls && opts?.withToolCalls !== false) {
      try {
        const parsed = JSON.parse(decodeCol(row.tool_calls) ?? "null");
        msg.toolCalls = Array.isArray(parsed)
          ? parsed.map(sanitizeToolCallDetail)
          : parsed;
      } catch (err) {
        // Corrupt tool_calls JSON → message hydrates without its tool calls
        // (recoverable, but silently lossy). Observe it.
        warnThrottled("rowToMessage:tool_calls", `[Store] Failed to parse tool_calls for message ${row.id}:`, err);
      }
    }
    if (row.blocks && opts?.withBlocks !== false) {
      try {
        const parsed = JSON.parse(decodeCol(row.blocks) ?? "null");
        if (Array.isArray(parsed)) {
          // v3 foundations NORM-01 DB hydration: each block of kind 'tool'
          // carries a toolCall whose `detail` may be a legacy / drifted
          // shape. Sanitize at the boundary so downstream consumers always
          // see a schema-conforming detail or none.
          msg.blocks = parsed.map((block: any) => {
            if (block && block.kind === 'tool' && block.toolCall) {
              return { ...block, toolCall: sanitizeToolCallDetail(block.toolCall) };
            }
            return block;
          });
        }
      } catch (err) {
        // Corrupt blocks JSON → message hydrates without its rich blocks.
        warnThrottled("rowToMessage:blocks", `[Store] Failed to parse blocks for message ${row.id}:`, err);
      }
    }
    // The `tool_calls` column is not written when the row has `blocks`
    // (`toolCallsColumnForRow`, shared/lean-tool-call.ts): the tool calls live
    // inside the timeline, and this is where they come back out. One single
    // point, so every reader keeps seeing them: `loadActiveThread`,
    // `/api/history`, `getMessageById`, and Regenerate, which reads
    // `msg.toolCalls` as the evidence of the turn it is replacing
    // (routes/edit.ts). No copy: the toolCall objects are the ones already
    // hydrated in the blocks, so the array costs one reference per tool.
    if (!msg.toolCalls?.length && msg.blocks?.length) {
      const fromBlocks = msg.blocks
        .filter((b: any) => b && b.kind === 'tool' && b.toolCall)
        .map((b: any) => b.toolCall);
      if (fromBlocks.length > 0) msg.toolCalls = fromBlocks;
    }
    if (row.media) {
      try { msg.media = JSON.parse(row.media); } catch (err) {
        // Corrupt media JSON → message hydrates without attachments.
        warnThrottled("rowToMessage:media", `[Store] Failed to parse media for message ${row.id}:`, err);
      }
    }
    if (row.partial) msg.partial = true;
    if (row.streamed_at) msg.streamedAt = row.streamed_at;
    if (row.plan_status) msg.planStatus = row.plan_status;
    if (row.parent_id !== undefined && row.parent_id !== null) msg.parentId = row.parent_id;
    if (row.branch_index !== undefined) msg.branchIndex = row.branch_index;
    if (row.latency_ms !== undefined && row.latency_ms !== null) msg.latencyMs = row.latency_ms;
    if (row.usage_prompt_tokens !== undefined && row.usage_prompt_tokens !== null) msg.usagePromptTokens = row.usage_prompt_tokens;
    if (row.usage_completion_tokens !== undefined && row.usage_completion_tokens !== null) msg.usageCompletionTokens = row.usage_completion_tokens;
    if (row.cost_cents !== undefined && row.cost_cents !== null) msg.costCents = row.cost_cents;
    // Il modello che ha prodotto il turno. Assente sulle righe anteriori alla
    // migration 076: non c'e' nessun posto da cui dedurlo, e inventarlo sarebbe
    // peggio del non saperlo.
    if (row.model !== undefined && row.model !== null) msg.model = row.model;
    // NULL resta undefined: "non lo sappiamo" e "misurato, nessuna cache" sono due
    // cose diverse e la UI le mostra diverse.
    if (row.cache_read_tokens !== undefined && row.cache_read_tokens !== null) msg.cacheReadTokens = row.cache_read_tokens;
    if (row.cache_creation_tokens !== undefined && row.cache_creation_tokens !== null) msg.cacheCreationTokens = row.cache_creation_tokens;
    if (row.cache_creation_1h_tokens !== undefined && row.cache_creation_1h_tokens !== null) msg.cacheCreation1hTokens = row.cache_creation_1h_tokens;
    // Idem: senza questa lettura il giro carica→salva perderebbe l'autore.
    if (row.author_person_id !== undefined && row.author_person_id !== null) msg.authorPersonId = row.author_person_id;
    if (row.author_device_id !== undefined && row.author_device_id !== null) msg.authorDeviceId = row.author_device_id;
    return msg;
  }

  // Build the meta param block for insertMessage/updateMessage. Mirrors the
  // schema in 014-message-meta.sql + 015-message-blocks.sql; passing null
  // means "leave existing value alone" because updateMessage uses COALESCE
  // on these fields.
  function metaParams(msg: Partial<StoredMessage>) {
    return {
      $latency_ms: msg.latencyMs ?? null,
      $usage_prompt_tokens: msg.usagePromptTokens ?? null,
      $usage_completion_tokens: msg.usageCompletionTokens ?? null,
      $cost_cents: msg.costCents ?? null,
      $cache_read_tokens: msg.cacheReadTokens ?? null,
      $cache_creation_tokens: msg.cacheCreationTokens ?? null,
      $cache_creation_1h_tokens: msg.cacheCreation1hTokens ?? null,
      $model: msg.model ?? null,
      // L'autore (095) passa di QUI e non da un parametro a parte perche'
      // `saveLocalMessages` RIMPIAZZA l'intera sessione: se questo blocco non lo
      // portasse, ogni salvataggio successivo — una troncatura, un import, una
      // riscrittura di ramo — cancellerebbe l'attribuzione di tutti i messaggi
      // gia' scritti, in silenzio. Su `updateMessage` il COALESCE lo tiene fermo.
      $author_person_id: msg.authorPersonId ?? null,
      $author_device_id: msg.authorDeviceId ?? null,
      // `blocksForDisk` e non `JSON.stringify`: dentro un tool block, `result`
      // e `detail` portano spesso la STESSA stringa byte per byte, e quella
      // copia e' il 30% del payload misurato (shared/lean-tool-call.ts). Qui si
      // scarta prima che tocchi il disco; quando la copia non c'e', il testo
      // passa intero.
      $blocks: blocksForDisk(msg.blocks),
    };
  }

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
      ws.send(payload, shouldCompressFrame({ type, bytes: payload.length, remote: ws.data.remote === true }));
    } catch (err) {
      console.error(`[WS] Send error to ${ws.data.id}:`, err);
    }
  }

  function broadcast(message: OutboundMessage, exclude?: ServerWebSocket<WSData>) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
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
        if (guests && isGuestSocket(ws) && !guests.mayReceiveFrame(ws.data.deviceId!, message)) continue;
        sendFrame(ws, payload, message.type);
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
  const isGuestSocket = (ws: ServerWebSocket<WSData>) => isGuestSocketData(ws.data);

  function broadcastToAll(message: OutboundMessage) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
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
    for (const ws of wsClients) {
      if (ws.readyState !== 1) continue;
      if (guests && isGuestSocket(ws) && !guests.mayReceiveFrame(ws.data.deviceId!, message)) continue;
      sendFrame(ws, payload, message.type);
    }
    // Trigger push notifications for meaningful events
    try { maybeSendPush(message as Record<string, any>); } catch (err) {
      // Push is best-effort, but a persistent throw here means notifications
      // are silently dead — surface it (throttled) instead of never knowing.
      warnThrottled("maybeSendPush", `[Push] maybeSendPush threw:`, err);
    }
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
   * Niente `maybeSendPush`: nessun `project:*` è fra i tipi che fanno partire una
   * notifica (`server/push-triggers.ts`), e chiamarlo qui vorrebbe dire che il
   * giorno in cui uno ci finisse la notifica uscirebbe senza passare da questo
   * filtro — cioè col nome del progetto sopra. Se serve, si aggiunge di qui
   * DOPO aver deciso a chi.
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
      if (guests && isGuestSocket(ws) && !guests.mayReceiveFrame(ws.data.deviceId!, message)) continue;
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
    for (const ws of wsClients) {
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
        if (guests && isGuestSocket(ws) && !guests.mayReadTopic(ws.data.deviceId!, topicId)) continue;
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
      // PRIMA del ripiego di `clientReceivesTopicDelta`, che è permissivo per
      // scelta: un client che non ha mai dichiarato il suo insieme riceve TUTTI
      // i delta. È la regola giusta fra le finestre del proprietario, ed era la
      // falla vera per un ospite — `stream:content_chunk` passa quasi sempre di
      // qui, non da `broadcastToAll`, quindi il testo di una chat non condivisa
      // gli scorreva addosso mentre l'allowlist dei frame guardava altrove.
      if (guests && isGuestSocket(ws) && !guests.mayReadTopic(ws.data.deviceId!, topicId)) continue;
      if (!clientReceivesTopicDelta(ws.data, topicId)) continue;
      sendFrame(ws, payload, message.type);
    }
  }

  // --- Project + Worktree domain (Phase A · migrations 016-018) ---
  // Stores are pure SQL helpers, instantiated against the singleton db.
  // The manager is the only stateful dependency: it closes over broadcastToAll
  // (declared above) so it can fire `worktree:updated` envelopes when the
  // async git materialise step transitions a row from `pending` → `ready|error`.
  const projectStore = createProjectStore(db);
  const worktreeStore = createWorktreeStore(db);
  // Le gcDeps sono closure deliberate: processes.ts nasce DOPO il manager,
  // e queste funzioni vengono lette ALLA CHIAMATA, non alla costruzione.
  // Lo stesso schema usato per previewManager in worktree-gc-runner.ts.
  const _worktreeGcDeps: WorktreeManagerGcDeps = {
    killTree: undefined,   // iniettato da server.ts dopo createProcessesRouter
    listOwnedScripts: undefined, // idem
    // A folder that survives the delete: the row stays, the human must know.
    notify: (input) => { recordAndAnnounce(input); },
  };
  const worktreeManager = createWorktreeManager(
    { broadcastToAll } as AppContext,
    { projectStore, worktreeStore },
    _worktreeGcDeps,
  );
  // Phase D — machines (heartbeat ticker is wired in server.ts).
  const machineStore = createMachineStore(db, baseDir);

  // --- Atomic write (kept for backward compat with non-DB file writes) ---
  function atomicWriteJSON(filepath: string, data: object): void {
    const tempPath = filepath + ".tmp." + process.pid + "." + Date.now();
    try {
      writeFileSync(tempPath, JSON.stringify(data, null, 2));
      renameSync(tempPath, filepath);
    } catch (err) {
      try { unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  // --- Topics (SQLite-backed) ---
  function loadTopics(): TopicsData {
    const rows = stmts.getAllTopics.all() as any[];
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
    const row = stmts.getTopicById.get(id) as any;
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

  // Il modulo push-triggers è puro; qui gli passiamo i dati che gli servono e
  // che vivono sul DB — il nome del topic per il titolo della push di fine
  // risposta, e la riga + le impostazioni su cui `isTopicSilenced` decide il
  // silenzio (archiviato, mutato, o dentro un progetto mutato). Un topic che
  // non esiste più conta come zittito: non c'è niente da nominare e nessuno da
  // svegliare.
  //
  // `mutedProjects` si LEGGE al momento della push, non si memorizza qui: muti
  // un progetto e un valore preso al bootstrap resterebbe quello di ore prima.
  // Una SELECT per chiave vale la freschezza, tanto più che le push di fine
  // risposta sono rare (una per turno di chat umana, già a valle di cinque gate).
  configurePushTriggers({
    getTopicName: (topicId) => getTopicById(topicId)?.name ?? null,
    isTopicSilenced: (topicId) => isTopicSilenced(getTopicById(topicId), readMutedProjects(db)),
    // Ogni push mandata lascia una riga nel registro (migration 102). La push è
    // la metà "ad app chiusa" della notifica: senza questo aggancio la
    // cronologia avrebbe un buco proprio dove serve di più — quando torni al
    // computer e vuoi sapere cosa è successo mentre non c'eri.
    recordNotification: (input) => { recordAndAnnounce(input); },
  });

  // Il registro delle notifiche: come sopra, i due dati che gli mancano — dove
  // annunciare la riga nuova, e se il topic bersaglio è archiviato.
  configureNotificationRegistry({
    announce: (row, unseen) => broadcastToAll({ type: "notification:new", row, unseen }),
    announceSeen: (unseen) => broadcastToAll({ type: "notification:seen", unseen }),
    isTopicArchived: (topicId) => !!getTopicById(topicId)?.archived,
  });

  /**
   * Load a single topic by sessionKey. Same constant-time read as
   * `getTopicById` but indexed on `session_key` (UNIQUE in migration 001).
   * Used by chat/abort, autoname, gateway hooks, and other code paths that
   * only know the session, not the topic id.
   */
  function getTopicBySessionKey(sessionKey: string): Topic | null {
    const row = stmts.getTopicBySessionKey.get(sessionKey) as any;
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
  function loadUnread(): UnreadData {
    const rows = stmts.getAllUnread.all() as any[];
    const result: UnreadData = {};
    for (const row of rows) {
      result[row.topic_id] = { lastReadAt: row.last_read_at, unreadCount: row.unread_count };
    }
    return result;
  }

  function saveUnread(data: UnreadData): void {
    db.transaction(() => {
      // Get current unread topic IDs
      const currentRows = stmts.getAllUnread.all() as any[];
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

  // --- Messages (SQLite-backed) ---
  function getMessagesPath(sessionKey: string): string {
    // Keep for backward compat (some code references this for file existence checks)
    const safe = sessionKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
    return join(MESSAGES_DIR, safe + ".json");
  }

  /**
   * Walk the message tree following active branch selections.
   * Returns a linear thread representing the currently active conversation path.
   */
  function loadActiveThread(sessionKey: string, opts?: ThreadLoadOpts): StoredMessage[] {
    // Get all messages for this session. A caller that wants neither the blocks
    // nor the tool calls gets the lean read: those two columns are never asked
    // of SQLite at all, instead of arriving only to be thrown away.
    const lean = opts?.withBlocks === false && opts?.withToolCalls === false;
    const allRows = (lean ? stmts.getMessagesLean : stmts.getMessages).all(sessionKey) as any[];
    if (allRows.length === 0) return [];

    // Build parent→children map
    const childrenMap = new Map<string | null, any[]>(); // parentId → child rows
    for (const row of allRows) {
      const pid = row.parent_id || null;
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid)!.push(row);
    }

    // Sort children by branch_index
    for (const children of childrenMap.values()) {
      children.sort((a: any, b: any) => (a.branch_index || 0) - (b.branch_index || 0));
    }

    // Walk from root(s) following active branches. Recursive descent (was an
    // iterative single-spine walk): at each level it follows the ONE active
    // branch, but if two+ siblings share that same branch_index it includes
    // ALL of them instead of silently keeping the first and dropping the rest.
    // That duplicate-index state is invalid — the real edit/regenerate flow
    // (createBranchMessage) always assigns a fresh MAX+1 index — but a raw DB
    // seed or a botched migration can produce it (e.g. two parent-less roots),
    // and the old walk rendered the thread TRUNCATED. Normal and edit-branch
    // data have exactly one child per active level, so their output is
    // byte-identical to before.
    const thread: StoredMessage[] = [];
    // Guard against a corrupt chain (cyclic or self-referential parent_id)
    // looping forever — skip the first time we'd revisit a node.
    const visited = new Set<string>();

    const walk = (currentParentId: string | null): void => {
      const children = childrenMap.get(currentParentId);
      if (!children || children.length === 0) return;

      // Determine which branch to follow
      let activeBranchIndex = 0;
      if (children.length > 1) {
        // For root messages (parent_id IS NULL), use '__root__' key
        const lookupKey = currentParentId === null ? '__root__' : currentParentId;
        const active = stmts.getActiveBranch.get(lookupKey, sessionKey) as any;
        if (active) activeBranchIndex = active.active_branch_index;
      }

      // Children on the active branch — normally exactly one. `children` is
      // sorted by branch_index (stable over the sort_order load order), so
      // any duplicates come out in chronological order. Fall back to the first
      // child if the active index matches nothing (stale active_branches row).
      let selected = children.filter((c: any) => (c.branch_index || 0) === activeBranchIndex);
      if (selected.length === 0) selected = [children[0]];
      if (selected.length > 1) {
        console.warn(`[loadActiveThread] ${sessionKey}: ${selected.length} siblings share branch_index ${activeBranchIndex} under ${currentParentId ?? '__root__'} — including all to avoid truncating the thread`);
      }

      for (const selectedChild of selected) {
        if (visited.has(selectedChild.id)) {
          console.warn(`[loadActiveThread] Cyclic message chain detected for ${sessionKey} at ${selectedChild.id} — truncating thread`);
          continue;
        }
        visited.add(selectedChild.id);
        const msg = rowToMessage(selectedChild, opts);

        // Annotate with sibling info for the client
        msg.siblingCount = children.length;
        msg.activeBranchIndex = selectedChild.branch_index || 0;

        thread.push(msg);
        walk(selectedChild.id);
      }
    };

    walk(null);

    return thread;
  }

  /**
   * `opts.withBlocks: false` loads the active branch WITHOUT hydrating the
   * `blocks` timeline: a `JSON.parse` of roughly 1.3 MB per agentic message,
   * thrown away by consumers that read only role/content/partial/id (context
   * assembly, the agent's last sentence). Defaults to `true`, because whoever
   * renders the chat does need the blocks.
   *
   * `opts.withToolCalls: false` does the same for `tool_calls`, and it is the
   * half that was missing: a caller that skips the blocks almost never reads the
   * tool calls, yet paid for them anyway. On the heaviest topic of this machine
   * that is 4.11 MB of JSON parsed and discarded on every turn. With BOTH set to
   * `false` the two columns are not even requested from SQLite
   * (`getMessagesLean`), and 14.5 ms become 0.5.
   */
  function loadLocalMessages(sessionKey: string, opts?: ThreadLoadOpts): StoredMessage[] {
    return loadActiveThread(sessionKey, opts);
  }

  /**
   * Quante righe ha la sessione INTERA — rami abbandonati compresi.
   *
   * Serve a chi deve DECIDERE su una cancellazione: `loadLocalMessages` dà il
   * ramo attivo, ma `saveLocalMessages(sk, [])` cancella tutta la session_key.
   * Decidere sul sottoinsieme e distruggere l'insieme è come contare le stanze
   * di un piano e demolire il palazzo.
   */
  function countMessagesBySession(sessionKey: string): number {
    const row = stmts.countMessagesBySession.get(sessionKey) as { n?: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * RIMPIAZZA l'intera sessione con `msgs`: cancella ogni messaggio e ogni
   * scelta di ramo, poi reinserisce quello che gli si passa.
   *
   * Va bene per chi vuole davvero questo (svuotare una topic, importare una
   * conversazione da fuori). NON va usata per TAGLIARE: `loadLocalMessages`
   * restituisce solo il ramo attivo, quindi il giro
   * `saveLocalMessages(loadLocalMessages().slice(0, n))` butta via ogni
   * versione alternativa della sessione — comprese quelle nate molto prima del
   * punto di taglio. Per troncare c'è `truncateSessionAfter`
   * (server/db/message-tree.ts), che cancella solo il sottoalbero appeso
   * all'ultimo messaggio tenuto.
   */
  function saveLocalMessages(sessionKey: string, msgs: StoredMessage[]): void {
    db.transaction(() => {
      stmts.deleteMessagesBySession.run(sessionKey);
      stmts.deleteActiveBranchesBySession.run(sessionKey);
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        stmts.insertMessage.run({
          $id: msg.id,
          $session_key: sessionKey,
          $role: msg.role,
          $content: msg.content || '',
          $thinking: msg.thinking || null,
          $tool_calls: toolCallsColumnForRow(msg.toolCalls, rowHasBlocks(msg.blocks)),
          $media: msg.media ? JSON.stringify(msg.media) : null,
          $partial: msg.partial ? 1 : 0,
          $streamed_at: msg.streamedAt || null,
          $plan_status: msg.planStatus || null,
          $timestamp: msg.timestamp,
          $sort_order: i,
          $parent_id: msg.parentId || null,
          $branch_index: msg.branchIndex || 0,
          ...metaParams(msg),
        });
      }
    })();
  }

  function appendLocalMessage(
    sessionKey: string,
    role: "user" | "assistant",
    content: string,
    /** Chi l'ha scritto (migration 095). Assente = non lo sappiamo, e resta NULL:
     *  è il caso dei turni importati da un transcript e di ogni risposta. */
    autore?: { authorPersonId?: string | null; authorDeviceId?: string | null },
    /**
     * Blocks to write ON the row, for the rare rows that are not just text.
     * Today one caller: the goal auto-continuation, whose `user` row carries a
     * `goal-nudge` block so the client draws a system line instead of a bubble
     * the human never typed (`services/goal-loop.ts`).
     */
    blocks?: ContentBlock[],
  ): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    // Find the last message in the active thread to set as parent.
    // Serve UN id, quindi si legge magro: senza queste due opzioni la chiamata
    // idratava tutto il ramo attivo con `blocks` e `tool_calls` riparsati da
    // JSON — e la paga OGNI riga scritta, cioè ogni prompt umano e ogni
    // segnaposto assistente aperto a inizio turno.
    const activeThread = loadActiveThread(sessionKey, { withBlocks: false, withToolCalls: false });
    const lastMsg = activeThread.length > 0 ? activeThread[activeThread.length - 1] : null;
    const parentId = lastMsg?.id || null;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString(), parentId, branchIndex: 0,
      authorPersonId: autore?.authorPersonId ?? null,
      authorDeviceId: autore?.authorDeviceId ?? null,
      ...(blocks && blocks.length ? { blocks } : {}),
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: content,
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: 0,
      ...metaParams(stored),
    });
    return stored;
  }

  /**
   * APPENDE un blocco di messaggi già formati (id/parentId/branchIndex/toolCalls
   * decisi dal chiamante) in coda alla sessione, senza toccare quelli esistenti.
   *
   * È il complemento di `saveLocalMessages` (che RIMPIAZZA tutto): serve
   * all'import incrementale di una sessione adottata, che a ogni sweep aggiunge i
   * turni nuovi letti dal transcript conservando i tool call e il thinking. I
   * `sort_order` proseguono dal massimo attuale; i `parentId` li ha già cablati
   * il parser delta (il primo punta all'ultima riga salvata). Transazionale: o
   * entrano tutti, o nessuno.
   */
  function appendImportedMessages(sessionKey: string, msgs: StoredMessage[]): void {
    if (msgs.length === 0) return;
    db.transaction(() => {
      const base = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order as number;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        stmts.insertMessage.run({
          $id: msg.id,
          $session_key: sessionKey,
          $role: msg.role,
          $content: msg.content || '',
          $thinking: msg.thinking || null,
          $tool_calls: toolCallsColumnForRow(msg.toolCalls, rowHasBlocks(msg.blocks)),
          $media: msg.media ? JSON.stringify(msg.media) : null,
          $partial: 0,
          $streamed_at: null,
          $plan_status: msg.planStatus || null,
          $timestamp: msg.timestamp,
          $sort_order: base + 1 + i,
          $parent_id: msg.parentId || null,
          $branch_index: msg.branchIndex || 0,
          ...metaParams(msg),
        });
      }
    })();
  }

  function createPartialMessage(sessionKey: string, role: "user" | "assistant"): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    // Find the last message in the active thread to set as parent.
    // Serve UN id, quindi si legge magro: senza queste due opzioni la chiamata
    // idratava tutto il ramo attivo con `blocks` e `tool_calls` riparsati da
    // JSON — e la paga OGNI riga scritta, cioè ogni prompt umano e ogni
    // segnaposto assistente aperto a inizio turno.
    const activeThread = loadActiveThread(sessionKey, { withBlocks: false, withToolCalls: false });
    const lastMsg = activeThread.length > 0 ? activeThread[activeThread.length - 1] : null;
    const parentId = lastMsg?.id || null;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role, content: "", timestamp: new Date().toISOString(),
      partial: true, streamedAt: new Date().toISOString(), parentId, branchIndex: 0,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: '',
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 1,
      $streamed_at: stored.streamedAt!,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: 0,
      ...metaParams({}),
    });
    return stored;
  }

  /** Reattach after a server restart: REUSE the surviving partial assistant row
   *  for this session (the exact bubble the client was watching before the
   *  restart) so the JSONL replay rebuilds it IN PLACE — no duplicate turn, no
   *  ghost spinner, and the client's `stream:catchup` targets the same
   *  messageId so the bubble updates seamlessly. Falls back to a fresh partial
   *  row when nothing survived. Only used on the reattach boot path.
   *
   *  IL CORPO NON SI TOCCA. Prima si svuotava qui (`content=''`, tool e blocchi
   *  a NULL) contando sul replay per riscriverlo, e la copia di quel che si
   *  cancellava viveva solo in RAM, dentro la richiesta di riadozione. Ma la
   *  riadozione ha tre uscite e due non ri-emettono niente, e la richiesta può
   *  morire prima di rimettere a posto: un secondo riavvio del watcher, il
   *  provider giù, un timeout. Quando succede la cancellazione è definitiva.
   *  Misurato su topic:dc2b90d0 il 10 agosto: riga nata alle 15:46:22.678,
   *  `streamed_at` 15:47:29.751 (l'ora del riattacco), corpo vuoto e
   *  `latency_ms` NULL — il finalize non è mai arrivato. A schermo restava il
   *  messaggio dell'utente e una bolla vuota, per sempre.
   *
   *  Adesso l'adozione è una scrittura sola: `streamed_at` riparte (la riga è
   *  di nuovo viva, e lo spazzino degli stream fermi la deve misurare da
   *  adesso). Chi ricostruisce ci scrive SOPRA — le scritture del turno sono
   *  assolute, e i tool si fondono per id — e chi muore non lascia il vuoto.
   *  Ad azzerarsi è la VISTA, non il record: `stream:start` porta
   *  `reattached`, e il client svuota la bolla prima di riempirla col replay. */
  function reuseOrCreatePartialForReattach(sessionKey: string): ReattachedPartial {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (row && row.role === "assistant" && (row.partial === 1 || row.partial === true)) {
      const now = new Date().toISOString();
      db.run("UPDATE messages SET streamed_at = ?, partial = 1 WHERE id = ?", [now, String(row.id)]);
      return {
        id: String(row.id), role: "assistant", content: String(row.content ?? ""), timestamp: String(row.timestamp),
        partial: true, streamedAt: now, parentId: row.parent_id ?? null, branchIndex: row.branch_index ?? 0,
        reusedBody: true,
      };
    }
    return { ...createPartialMessage(sessionKey, "assistant"), reusedBody: false };
  }

  /**
   * A SPONTANEOUS TURN PICKS UP THE HEADSTONE BEFORE IT, when there is one.
   *
   * A task notification delivered by the CLI opens a turn of its own, and its
   * empty `result` closes the row of a send that has just started, stamping it
   * with the «no answer» notice. The real prompt arrives right after and gets
   * adopted as a spontaneous turn: without this, the answer is born in a NEW
   * row and the notice stays above it saying it never came. When a row IS that
   * headstone — and the trace of the failure — lives in
   * `lib/empty-turn-headstone.ts`; only the write is here.
   *
   * The body really is emptied, unlike the post-restart reattach: there the
   * body is history to be rebuilt, here it is a notice we know to be false.
   * `streamed_at` restarts because the row is alive again.
   */
  function reuseHeadstoneOrCreate(sessionKey: string): StoredMessage {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    const riusabile = isReusableHeadstone(
      row
        ? {
            role: String(row.role ?? ""),
            content: String(row.content ?? ""),
            toolCallsJson: row.tool_calls == null ? null : String(row.tool_calls),
            blocksJson: row.blocks == null ? null : String(row.blocks),
            timestamp: String(row.timestamp ?? ""),
            partial: row.partial === 1 || row.partial === true,
          }
        : null,
      Date.now(),
    );
    if (!riusabile) return createPartialMessage(sessionKey, "assistant");
    const now = new Date().toISOString();
    db.run(
      "UPDATE messages SET content = '', blocks = NULL, tool_calls = NULL, streamed_at = ?, partial = 1, latency_ms = NULL WHERE id = ?",
      [now, String(row.id)],
    );
    return {
      id: String(row.id), role: "assistant", content: "", timestamp: String(row.timestamp),
      partial: true, streamedAt: now, parentId: row.parent_id ?? null, branchIndex: row.branch_index ?? 0,
    } as StoredMessage;
  }

  function updateLastMessage(sessionKey: string, updates: Partial<StoredMessage>): StoredMessage | null {
    // Lettura magra: `blocks` e `tool_calls` non arrivano nemmeno da SQLite.
    // Questa funzione non li legge — riscrive `tool_calls` solo se glielo passa
    // il chiamante, e `blocks` passa da `metaParams(updates)`, cioè sempre dal
    // chiamante — ma con `SELECT *` se li portava dietro comunque, a ogni
    // salvataggio periodico e a ogni finalizzazione. Sul DB vero sono decine di
    // KB per riga, e su un turno agentico lungo arrivano ai megabyte.
    //
    // Il valore di ritorno finisce in `discardIfEmptyTurn`, che senza quelle due
    // colonne prenderebbe per vuoto un turno fatto di SOLI tool o SOLI blocchi e
    // lo cancellerebbe. Le colonne non gli servono: gli serve sapere se ci sono,
    // e quello se lo chiede lui con `messageBodyPresence`.
    const row = stmts.getLastMessageForBodyUpdate.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false, withToolCalls: false });
    Object.assign(msg, updates);
    // Only overwrite the body fields the caller actually passed. Fields absent
    // from `updates` go in as null so the COALESCE in updateMessage keeps the
    // existing column — a partial update (e.g. flipping `partial` on timeout)
    // must never re-persist a stale content/thinking/tool snapshot over
    // concurrent writes, which is how turns were being blanked.
    stmts.updateMessage.run({
      $id: msg.id,
      $content: 'content' in updates ? (msg.content || '') : null,
      $thinking: 'thinking' in updates ? (msg.thinking || null) : null,
      $tool_calls: 'toolCalls' in updates
        ? toolCallsColumnForRow(msg.toolCalls, rowHasBlocks(updates.blocks) || row.has_blocks === 1)
        : null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      // Only the partial-msg fields landing in `updates` should overwrite —
      // the SQL's COALESCE keeps existing values when these are null.
      ...metaParams(updates),
    });
    return msg;
  }

  function appendToLastMessage(sessionKey: string, contentDelta: string, thinkingDelta?: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row);
    if (contentDelta) msg.content += contentDelta;
    if (thinkingDelta) msg.thinking = (msg.thinking || "") + thinkingDelta;
    stmts.updateMessage.run({
      $id: msg.id,
      // Owns content/thinking. tool_calls is null so COALESCE keeps them — a
      // content delta must never overwrite tool state written concurrently.
      $content: msg.content,
      $thinking: msg.thinking || null,
      $tool_calls: null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  function finalizeLastMessage(sessionKey: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row);
    delete msg.partial;
    delete msg.streamedAt;
    stmts.updateMessage.run({
      $id: msg.id,
      // Flips the partial/streamed_at control flags only. All body fields are
      // null so COALESCE preserves whatever streamed — finalizing a turn must
      // never blank its content, thinking, or tools.
      $content: null,
      $thinking: null,
      $tool_calls: null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  /**
   * THE ROW HAS `blocks`: the tool call is already persisted there, so this
   * column has nothing to add and the UPDATE has nothing to do.
   *
   * Skipping it is not a micro optimisation. `updateMessage` rewrites the
   * ROW, and COALESCE keeping a column does not make it free: SQLite copies
   * the whole record, overflow pages included, so a write here re-copies the
   * `blocks` blob too. On the live database one message reached 3.65 MB of
   * blocks and 3.65 MB of tool_calls over 127 blocks: ~250 rewrites of ~1.8 MB
   * average, hundreds of MB of JSON and of WAL pages, for ONE message, on the
   * event loop, while the turn is alive and needs it for tokens, WS frames and
   * PTY.
   *
   * `hadToolCalls` is the one exception: a row that already carries the copy
   * (an older row, or the first tool of a turn announced before the first
   * block was persisted) gets ONE write to clear it, and then no more.
   */
  function toolColumnWriteMode(row: { has_blocks?: number; has_tool_calls?: number }): 'skip' | 'clear' | 'write' {
    if (row.has_blocks !== 1) return 'write';
    return row.has_tool_calls === 1 ? 'clear' : 'skip';
  }

  function addToolCallToLastMessage(sessionKey: string, toolCall: ToolCall): StoredMessage | null {
    const row = stmts.getLastMessageForToolUpdate.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false });
    if (!msg.toolCalls) msg.toolCalls = [];
    // Defensive dedup: providers that emit cumulative tool snapshots (the
    // Claude CLI is one) call this multiple times for the same id. Without
    // this guard we'd accumulate duplicate entries; updateToolCallResult
    // only patches the FIRST match, so the duplicates would stay forever
    // in `running` and the spinner would never clear in the UI. The
    // upstream provider is meant to dedup too — this is belt-and-braces.
    const existingIdx = msg.toolCalls.findIndex(t => t.id === toolCall.id);
    if (existingIdx >= 0) {
      // Update in place so a re-announcement with newer args doesn't lose
      // the work tracked under the same id.
      msg.toolCalls[existingIdx] = { ...msg.toolCalls[existingIdx], ...toolCall };
    } else {
      msg.toolCalls.push(toolCall);
    }
    const mode = toolColumnWriteMode(row);
    if (mode === 'skip') return msg;
    stmts.updateMessage.run({
      $id: msg.id,
      // Owns tool_calls only — see updateToolCallResult.
      $content: null,
      $thinking: null,
      $tool_calls: mode === 'clear' ? '[]' : toolCallsForDisk(msg.toolCalls),
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  function updateToolCallResult(sessionKey: string, toolCallId: string, result: string, error?: string, extra?: Partial<ToolCall>): StoredMessage | null {
    const row = stmts.getLastMessageForToolUpdate.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false });
    const mode = toolColumnWriteMode(row);
    // Same rule as `addToolCallToLastMessage`: with blocks on the row the
    // result is written there (routes/chat.ts `updateBlockTool`), and this
    // column is either already empty or cleared once.
    if (mode === 'skip') return msg;
    if (mode === 'clear') {
      stmts.updateMessage.run({
        $id: msg.id,
        $content: null,
        $thinking: null,
        $tool_calls: '[]',
        $media: msg.media ? JSON.stringify(msg.media) : null,
        $partial: msg.partial ? 1 : 0,
        $streamed_at: msg.streamedAt || null,
        $plan_status: msg.planStatus || null,
        ...metaParams({}),
      });
      return msg;
    }
    const tc = msg.toolCalls?.find(t => t.id === toolCallId);
    if (tc) {
      tc.result = result;
      tc.error = error;
      tc.status = error ? 'error' : 'success';
      // Terminal-time extras (endedAt timestamp, etc.) ride the same write
      // instead of paying a second parse→serialize cycle per tool.
      if (extra) Object.assign(tc, extra);
      stmts.updateMessage.run({
        $id: msg.id,
        // Owns tool_calls only. content/thinking are null so COALESCE keeps the
        // streamed body — a late tool_result (e.g. a killed process draining its
        // buffer) must never overwrite the assistant's text.
        $content: null,
        $thinking: null,
        $tool_calls: toolCallsForDisk(msg.toolCalls),
        $media: msg.media ? JSON.stringify(msg.media) : null,
        $partial: msg.partial ? 1 : 0,
        $streamed_at: msg.streamedAt || null,
        $plan_status: msg.planStatus || null,
        ...metaParams({}),
      });
    }
    return msg;
  }

  /**
   * Generic patch for a single ToolCall on the last assistant message.
   * Used for non-terminal mutations that `updateToolCallResult` doesn't
   * cover — currently `status: 'waiting_for_input'` + `userInputSchema`
   * on the way in, and `userResponse` on the way out when the user
   * answers a paused tool. `status` patching here goes through the same
   * SQLite row so a reload renders the pending form correctly.
   */
  function updateToolCallFields(sessionKey: string, toolCallId: string, patch: Partial<ToolCall>): StoredMessage | null {
    // L'UNICA statement che porta `blocks`: qui servono davvero (vedi sotto), e
    // questa via si percorre quando un tool si ferma a chiedere qualcosa a una
    // persona, non a ogni evento di tool.
    const row = stmts.getLastMessageForToolFields.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: true });
    const tc = msg.toolCalls?.find(t => t.id === toolCallId);
    if (!tc) return msg;
    Object.assign(tc, patch);
    // ANCHE i blocchi, e non «anche» per scrupolo: quando un messaggio ha
    // `blocks`, chi disegna legge QUELLI e ignora `tool_calls`
    // (client/src/state/pendingAsk.ts, <MessageBubble>). Scrivere solo
    // `tool_calls` da fuori dallo stream produce una riga che nel DB dice
    // «aspetta una risposta» e a schermo continua a girare.
    //
    // Visto il 7 agosto sul primo permesso vero: tre chiamate a kiwi ferme da
    // tre minuti, il piede della chat che diceva «in attesa della tua
    // risposta», e NESSUN pannello — perché il pannello viveva in una colonna
    // che nessuno legge.
    //
    // Dentro lo stream i blocchi hanno un altro proprietario (l'array in
    // memoria di `routes/chat.ts`, che li riscrive con `persistBlocks`), quindi
    // questa scrittura può essere sovrascritta da un evento successivo. È
    // accettabile perché chi dipinge un pannello lo RIDIPINGE finché serve
    // (vedi la rotta `…/permission`): un colpo perso si recupera alla gamba
    // dopo, invece di restare perso per sempre.
    const nextBlocks = msg.blocks?.map(b =>
      b.kind === "tool" && b.toolCall.id === toolCallId
        ? { kind: "tool" as const, toolCall: { ...b.toolCall, ...patch } }
        : b,
    );
    stmts.updateMessage.run({
      $id: msg.id,
      $content: null,
      $thinking: null,
      $tool_calls: toolCallsColumnForRow(msg.toolCalls, rowHasBlocks(nextBlocks ?? msg.blocks)),
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
      $blocks: blocksForDisk(nextBlocks),
    });
    return msg;
  }

  // --- Streams (in-memory, unchanged) ---
  function startStream(sessionKey: string, messageId: string, abortController?: AbortController, survivesRestart = false) {
    activeStreams.set(sessionKey, { sessionKey, startedAt: new Date().toISOString(), isThinking: false, lastActivity: new Date().toISOString(), content: "", thinking: "", messageId, abortController, survivesRestart });
  }

  function updateStreamActivity(sessionKey: string, isThinking?: boolean) {
    const stream = activeStreams.get(sessionKey);
    if (stream) {
      stream.lastActivity = new Date().toISOString();
      if (isThinking !== undefined) stream.isThinking = isThinking;
    }
  }

  function updateStreamContent(sessionKey: string, content: string, thinking: string) {
    const stream = activeStreams.get(sessionKey);
    if (stream) {
      stream.content = content;
      stream.thinking = thinking;
      stream.lastActivity = new Date().toISOString();
    }
  }

  function getStreamContent(sessionKey: string): { content: string; thinking: string; messageId: string } | null {
    const stream = activeStreams.get(sessionKey);
    if (!stream) return null;
    return { content: stream.content, thinking: stream.thinking, messageId: stream.messageId };
  }

  /**
   * Ends a stream. Marks any tool call left `running` as interrupted so the
   * client stops showing a spinner that ticks forever (observed: a tool
   * "running" for 2h+ after the turn already died). Stamps `endedAt` so the
   * duration freezes, and RETURNS the interrupted calls so the caller can
   * broadcast `stream:tool_result` to live clients (the DB write alone only
   * fixes a later reload). Parse → map → serialize (never a substring REPLACE,
   * which would clobber a literal `"status":"running"` inside args/result).
   *
   * `waiting_for_input` counts as interrupted too, and it's the nastier case:
   * a tool left in that state renders a CLICKABLE question panel. If the turn
   * is over, there is nobody left to receive the click — the panel promises
   * something the process can no longer honour. Observed on topic:ed2070df: a
   * panel still inviting an answer 22 minutes after its turn had been closed,
   * with a Retry banner right underneath. The ask is cancelled here for the
   * same reason: whoever is blocked on it must fail, not hang.
   *
   * `keepAwaiting` is the ONE exception, and it exists because one ask is not
   * a leftover: the plan approval is posted BY the end of the turn, and its
   * answer starts a new turn instead of unblocking this one. Cancelling it
   * here would kill the panel a few lines after installing it. Anything not
   * named in this list keeps the rule above.
   */
  function endStream(sessionKey: string, opts?: { keepAwaiting?: readonly string[] }): ToolCall[] {
    const keepAwaiting = new Set(opts?.keepAwaiting ?? []);
    const stream = activeStreams.get(sessionKey);
    const interrupted: ToolCall[] = [];
    if (stream?.messageId) {
      try {
        const row = db.prepare(`SELECT tool_calls, blocks FROM messages WHERE id = ?`).get(stream.messageId) as any;
        const endedAt = Date.now();
        const fix = (tc: any): boolean => {
          if (tc && (tc.status === 'running' || tc.status === 'pending')) {
            tc.status = 'error';
            if (tc.endedAt == null) tc.endedAt = endedAt;
            if (!tc.error) tc.error = 'Interrotto: il turno è terminato senza risultato';
            return true;
          }
          // Un pannello a schermo su un turno finito è la variante peggiore:
          // invita un click che non raggiungerà più nessuno. Vale per la
          // domanda E per il permesso — sono stati diversi, ma qui contano per
          // lo stesso motivo, quindi la condizione è il predicato condiviso e
          // non due `if` che possono divergere.
          if (tc && isAwaitingHuman(tc.status)) {
            // An ask that outlives the turn on purpose: leave it exactly as it
            // is, panel included.
            if (keepAwaiting.has(tc.id)) return false;
            const eraPermesso = tc.status === 'awaiting_permission';
            tc.status = 'error';
            if (tc.endedAt == null) tc.endedAt = endedAt;
            if (!tc.error) {
              tc.error = eraPermesso
                ? 'Interrotto: il turno è finito mentre il permesso era ancora a schermo. La decisione non avrebbe più raggiunto nessuno.'
                : 'Interrotto: il turno è finito mentre la domanda era ancora a schermo. La risposta non avrebbe più raggiunto nessuno.';
            }
            releaseHumanHold(sessionKey, 'il turno è terminato mentre il pannello era a schermo');
            return true;
          }
          return false;
        };
        let tcStr: string | Uint8Array | null = row?.tool_calls ?? null;
        let blStr: string | Uint8Array | null = row?.blocks ?? null;
        let changed = false;
        if (row?.tool_calls) {
          const toolCallsDecoded = decodeCol(row.tool_calls);
          const toolCalls = JSON.parse(toolCallsDecoded ?? "null") as ToolCall[];
          let c = false;
          for (const tc of toolCalls) if (fix(tc)) { c = true; interrupted.push(tc); }
          // `toolCallsForDisk` anche qui: questa riga la scrive di nuovo
          // INTERA, quindi e' una scrittura come le altre. Le tool call che
          // arrivano fin qui sono gia' magre (le ha scritte questo stesso
          // percorso), ma una riga vecchia riaperta da un riavvio no.
          if (c) { tcStr = encodeCol(toolCallsForDisk(toolCalls) ?? "null") ?? null; changed = true; }
        }
        // The client renders tool state from `blocks` (the timeline) when
        // present, so finalize the block copy too or the spinner keeps ticking.
        if (row?.blocks) {
          const blocksDecoded = decodeCol(row.blocks);
          const bl = JSON.parse(blocksDecoded ?? "null") as any[];
          let c = false;
          for (const b of bl) if (b?.kind === 'tool' && fix(b.toolCall)) c = true;
          if (c) { blStr = encodeCol(blocksForDisk(bl) ?? "null") ?? null; changed = true; }
        }
        // The row carries both copies: this write is the last one of the turn,
        // so it is also where the duplicate goes. What the column held is
        // inside `blocks`, and `rowToMessage` reads it back from there.
        if (row?.blocks && row?.tool_calls) { tcStr = '[]'; changed = true; }
        if (changed) {
          db.prepare(`UPDATE messages SET tool_calls = ?, blocks = ? WHERE id = ?`).run(tcStr, blStr, stream.messageId);
        }
      } catch {}
    }
    activeStreams.delete(sessionKey);
    return interrupted;
  }

  function isStreaming(sessionKey: string): ActiveStream | undefined {
    const stream = activeStreams.get(sessionKey);
    if (!stream) return undefined;
    const lastActivity = new Date(stream.lastActivity).getTime();
    const STREAM_TIMEOUT_MS = 3 * 60 * 1000;
    if (Date.now() - lastActivity > STREAM_TIMEOUT_MS) {
      // Stale: report "not streaming" but do NOT delete the entry here. Deleting
      // it would steal the entry from the authoritative sweeper (server.ts
      // `staleStreamTimer`), which is the only path that finalizes the partial
      // DB row (partial=0) and broadcasts stream:end. A bare delete left the
      // message stuck partial=1 forever (perpetual "streaming" in history until
      // a server restart). Leave it for the 30s sweeper to clean up properly.
      return undefined;
    }
    return stream;
  }

  // NOTE: the periodic stale-active-stream sweeper lives in server.ts
  // (`staleStreamTimer`, 30s). It is the authoritative one — it finalizes the
  // partial DB row and broadcasts stream:end with topicId+reason, and it is
  // cleared in gracefulShutdown. A second sweeper used to run here too, but it
  // duplicated/raced the server.ts logic with weaker side effects AND its
  // interval handle was never stored, so it leaked one live 60s timer per
  // `bun --watch` hot reload. Removed — don't reintroduce a sweeper here.

  // --- Request helpers (unchanged) ---
  async function readJSON(req: Request): Promise<any> {
    try { return await req.json(); } catch { return null; }
  }

  function json(data: any, status = 200): Response {
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
  const ALLOWED_FILE_BASES = [OPENCLAW_DIR, process.env.HOME ? join(process.env.HOME, ".openclaw") : null].filter(Boolean) as string[];

  function resolveSafePath(inputPath: string, allowedBases: string[] = ALLOWED_FILE_BASES): string | null {
    if (!inputPath) return null;
    let expanded = inputPath;
    if (inputPath.startsWith("~")) {
      const home = process.env.HOME;
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    const resolved = resolve(expanded);
    const isAllowed = allowedBases.some(base => {
      const normalizedBase = resolve(base);
      return resolved === normalizedBase || resolved.startsWith(normalizedBase + "/");
    });
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
  let knownDirsCache: { at: number; dirs: Set<string> } | null = null;
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
      const home = process.env.HOME;
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    const resolved = resolve(expanded);
    // Il confronto è sul path REALE: senza `realpath` un symlink dentro un
    // progetto noto è una porta verso qualunque punto del disco.
    let real = resolved;
    try { real = realpathSync(resolved); } catch { /* non esiste ancora: creazione file/dir */ }
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
  // Base media di Topics: ~/.topics (nuova, preferita) + ~/.openclaw (legacy
  // e root CONDIVISA dell'ecosistema Jarvis — resta leggibile per i path già
  // salvati e per i media prodotti da altri tool). NON migrare la root intera:
  // credenziali/gateway/cron/router vivono in ~/.openclaw e non sono di Topics.
  const TOPICS_DIR = `${process.env.HOME}/.topics`;
  const ALLOWED_MEDIA_BASES = [
    `${TOPICS_DIR}/media/`,
    `${TOPICS_DIR}/workspace/`,
    `${OPENCLAW_DIR}/media/`,
    `${OPENCLAW_DIR}/workspace/`,
  ];

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
    if (resolved.startsWith(resolve(UPLOADS_DIR) + "/")) return true;
    if (resolved.startsWith(resolve(CONTEXT_DIR) + "/")) return true;
    return ALLOWED_MEDIA_BASES.some((base) => resolved.startsWith(base));
  }

  const MEDIA_SCAN_DIRS = [
    join(process.env.HOME || "", ".topics/media/browser"),
    join(process.env.HOME || "", ".topics/media"),
    join(process.env.HOME || "", ".openclaw/media/browser"),
    join(process.env.HOME || "", ".openclaw/media"),
  ];
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
          try { const stat = await statAsync(fullPath); if (stat.mtimeMs >= sinceMs) results.push(fullPath); } catch {}
        }
      } catch {} // dir missing or unreadable — skip
    }
    return results;
  }

  function updateLastMessageWithMedia(sessionKey: string, mediaPaths: string[]): void {
    // Targeted lookup — the previous version fetched the WHOLE session just to
    // walk backwards to the newest assistant row.
    const row = stmts.getLastAssistantMessage.get(sessionKey) as any;
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
  function searchTranscripts(query: string, limit = 50): any[] {
    const results: any[] = [];
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
        .all(like, limit) as any[];
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
          role: row.role,
          content: row.content,
          timestamp: row.timestamp,
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
        for (const [key, entry] of Object.entries(store) as any[]) {
          if (!entry?.sessionId) continue;
          // Guard against path traversal — sessionId becomes a filename below.
          if (typeof entry.sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.sessionId)) continue;
          if (!key.startsWith("topic:")) continue;
          if (!sessionToTopic[key]) continue;
          const jsonlPath = join(SESSIONS_DIR, entry.sessionId + ".jsonl");
          if (!existsSync(jsonlPath)) continue;
          const topic = sessionToTopic[key];
          try {
            const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                if (d.type === "message" && d.message) {
                  const msg = d.message;
                  if (msg.role === "user" || msg.role === "assistant") {
                    let text = "";
                    if (typeof msg.content === "string") text = msg.content;
                    else if (Array.isArray(msg.content)) text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
                    if (text.toLowerCase().includes(lowerQuery)) {
                      results.push({ messageId: null, sessionKey: key, topicId: topic?.id || null, topicName: topic?.name || key, topicIcon: topic?.icon || "MessageSquare", role: msg.role, content: text, timestamp: d.timestamp || null });
                      if (results.length >= limit) return results;
                    }
                  }
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
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

  // --- Branching helpers ---
  function getMessageById(id: string): StoredMessage | null {
    const row = stmts.getMessageById.get(id) as any;
    return row ? rowToMessage(row) : null;
  }

  function getMessageSessionKey(id: string): string | null {
    const row = stmts.getMessageById.get(id) as any;
    return row?.session_key || null;
  }

  function createBranchMessage(
    sessionKey: string,
    parentId: string,
    role: "user" | "assistant",
    content: string,
    /** Chi l'ha scritto (095). Un prompt CORRETTO è un prompt: senza questo, chi
     *  riscrive una domanda invece di ribatterla sparisce dai conteggi. */
    autore?: { authorPersonId?: string | null; authorDeviceId?: string | null },
  ): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    const maxBranch = (stmts.getMaxBranchIndex.get(parentId) as any).max_idx;
    const branchIndex = maxBranch + 1;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString(), parentId, branchIndex,
      authorPersonId: autore?.authorPersonId ?? null,
      authorDeviceId: autore?.authorDeviceId ?? null,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: content,
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: branchIndex,
      ...metaParams(stored),
    });
    // Set this new branch as active
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
    return stored;
  }

  function createBranchPartialMessage(sessionKey: string, parentId: string): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    // Allocate the next branch index under the parent, like createBranchMessage.
    // This used to hardcode 0 — correct on the EDIT path (the parent is a
    // brand-new user message with no children) but colliding on REGENERATE,
    // where the anchor user message already has the original assistant reply
    // at index 0: two children with the same branch_index break both
    // loadActiveThread's selection and the sibling arrows.
    const maxBranch = (stmts.getMaxBranchIndex.get(parentId) as any).max_idx;
    const branchIndex = maxBranch + 1;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role: "assistant", content: "", timestamp: new Date().toISOString(),
      partial: true, streamedAt: new Date().toISOString(), parentId, branchIndex,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: "assistant",
      $content: '',
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 1,
      $streamed_at: stored.streamedAt!,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: branchIndex,
      ...metaParams({}),
    });
    // The fresh branch is what the user asked for — make it the active one
    // (no-op semantics when it's the parent's only child, index 0).
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
    return stored;
  }

  /**
   * Cancella un messaggio E tutto il sottoalbero che gli pende sotto, riparando
   * la contabilità dei rami:
   *  · i fratelli superstiti vengono rinumerati DENSI (le frecce fanno ±1 sul
   *    valore letterale di `branch_index`: un buco le lascerebbe a vuoto);
   *  · il puntatore attivo del padre atterra su un fratello vivo, o sparisce
   *    quando restano 0/1 figli (indice 0 per default);
   *  · le righe di `active_branches` che puntano a un id cancellato se ne vanno.
   *
   * Stava inline dentro `DELETE /api/messages/:id`. Ora lo chiama anche lo
   * scarto del segnaposto vuoto sull'abort: due copie della stessa transazione
   * vorrebbero dire due modi diversi di riparare i rami, e uno dei due sbagliato.
   * Ritorna `false` se il messaggio non esiste.
   */
  function deleteMessageSubtree(sessionKey: string, messageId: string): boolean {
    const msg = getMessageById(messageId);
    if (!msg) return false;
    const deletedIndex = msg.branchIndex ?? 0;
    const parentKey = msg.parentId ?? "__root__";
    db.transaction(() => {
      // Ids del sottoalbero (se stesso incluso) via CTE ricorsiva, per sessione.
      const subtree = db
        .prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM messages WHERE id = ? AND session_key = ?
             UNION ALL
             SELECT m.id FROM messages m JOIN sub ON m.parent_id = sub.id
           ) SELECT id FROM sub`,
        )
        .all(messageId, sessionKey) as Array<{ id: string }>;
      const ids = subtree.map(r => r.id);
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM active_branches WHERE session_key = ? AND parent_id IN (${placeholders})`)
        .run(sessionKey, ...ids);

      // Riferimenti che restavano appesi nel vuoto: nessuna di queste tabelle ha
      // una FK verso `messages`, quindi cancellare un sottoalbero lasciava pin e
      // menzioni che puntavano a righe inesistenti (due se ne contavano nel DB
      // vivo il 30/07). Il marcatore di compattazione invece non si butta: dice
      // "la compattazione sta DOPO questo messaggio", e ereditando il padre del
      // sottoalbero resta nello stesso punto del thread (`NULL` = in testa).
      db.prepare(`DELETE FROM topic_pinned_messages WHERE message_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM mentions WHERE message_id IN (${placeholders})`).run(...ids);
      db.prepare(
        `UPDATE compaction_markers SET after_message_id = ? WHERE after_message_id IN (${placeholders})`,
      ).run(msg.parentId ?? null, ...ids);

      // Rinumera densi i fratelli superstiti, conservandone l'ordine.
      const siblings = db
        .prepare(
          msg.parentId
            ? `SELECT id, branch_index FROM messages WHERE session_key = ? AND parent_id = ? ORDER BY branch_index ASC`
            : `SELECT id, branch_index FROM messages WHERE session_key = ? AND parent_id IS NULL ORDER BY branch_index ASC`,
        )
        .all(...(msg.parentId ? [sessionKey, msg.parentId] : [sessionKey])) as Array<{ id: string; branch_index: number }>;
      const renumber = db.prepare(`UPDATE messages SET branch_index = ? WHERE id = ?`);
      siblings.forEach((s, i) => { if (s.branch_index !== i) renumber.run(i, s.id); });

      if (siblings.length <= 1) {
        db.prepare(`DELETE FROM active_branches WHERE session_key = ? AND parent_id = ?`).run(sessionKey, parentKey);
      } else {
        // Atterra sul fratello che ha preso il posto del ramo cancellato (o
        // sull'ultimo, quando il cancellato era l'indice più alto).
        const nextActive = Math.min(deletedIndex, siblings.length - 1);
        db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)`)
          .run(parentKey, sessionKey, nextActive);
      }
    })();
    return true;
  }

  /**
   * "Un turno che non ha prodotto niente non lascia niente."
   *
   * Da chiamare DOPO aver finalizzato un turno interrotto: se la riga
   * dell'assistente è rimasta completamente vuota (niente testo, niente
   * ragionamento, nessuna tool call, nessun blocco, nessun media) il segnaposto
   * viene cancellato invece di restare in chat. Al modello non arrivava comunque
   * (la history verso il provider scarta i turni vuoti, `empty-after-strip` in
   * server/context/assemble.ts): il danno era nel thread salvato e in pagina.
   * Ritorna l'id scartato, o `null` se il turno aveva prodotto qualcosa (allora
   * si tiene: è lavoro fatto).
   */
  function discardIfEmptyTurn(sessionKey: string, msg: StoredMessage | null): string | null {
    if (!msg || !isEmptyAssistantTurn(msg)) return null;
    // Il predicato ha detto «vuoto» su ciò che il chiamante gli ha messo in mano,
    // e chi arriva da `updateLastMessage` legge magro: `blocks` e `tool_calls`
    // NON sono su `msg`, quindi «assenti» qui vuol dire «non li ho guardati»,
    // non «non ci sono». Prima di cancellare una riga si guardano — è una
    // domanda booleana, e la risponde SQLite senza portare qui le due colonne
    // più pesanti della tabella. Senza questo controllo un turno fatto di soli
    // tool, o di soli blocchi, verrebbe scartato come segnaposto vuoto: lavoro
    // fatto, cancellato in silenzio.
    const presence = stmts.messageBodyPresence.get(msg.id) as
      { has_tool_calls?: number; has_blocks?: number } | undefined;
    if (presence?.has_tool_calls) return null;
    // I BLOCCHI non bastano a salvare una riga, se sono solo l'eco del testo.
    //
    // La sonda SQL risponde «ci sono blocchi», e per un turno di soli tool è la
    // risposta giusta — quello è lavoro. Ma il testo diventa anch'esso un
    // blocco, quindi una riga il cui unico contenuto è una SENTINELLA della CLI
    // («No response requested.») arriverebbe qui con un blocco `text` e si
    // salverebbe, mentre il predicato l'ha appena dichiarata vuota: due letture
    // della stessa riga che si contraddicono.
    //
    // Il giudizio su COSA c'è dentro sta in un posto solo — `isEmptyAssistantTurn`
    // in shared/empty-turn.ts — quindi qui si va a prendere la colonna e gliela
    // si dà. Costa una lettura mirata, e solo su una riga già dichiarata vuota.
    if (presence?.has_blocks) {
      const row = stmts.getMessageBlocks.get(msg.id) as { blocks?: string | null } | undefined;
      if (!isEmptyAssistantTurn({ role: "assistant", blocks: row?.blocks ?? null })) return null;
    }
    return deleteMessageSubtree(sessionKey, msg.id) ? msg.id : null;
  }

  function switchActiveBranch(sessionKey: string, parentId: string, branchIndex: number): void {
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
  }

  function getSiblingMessages(parentId: string): StoredMessage[] {
    const rows = stmts.getSiblings.all(parentId) as any[];
    return rows.map((row) => rowToMessage(row));
  }

  return {
    db,
    projectStore, worktreeStore, worktreeManager,
    /** Iniettato da server.ts dopo createProcessesRouter (lazy closure). */
    worktreeGcDeps: _worktreeGcDeps,
    machineStore,
    PORT, GATEWAY_URL,
    get GATEWAY_TOKEN() { return GATEWAY_TOKEN; },
    refreshGatewayToken,
    TOPICS_FILE, UNREAD_FILE, PUBLIC_DIR, UPLOADS_DIR, CONTEXT_DIR,
    OPENCLAW_DIR, SESSIONS_DIR, MESSAGES_DIR, BASE_DIR: baseDir, STATE_DIR,
    activeStreams, wsClients,
    broadcast, broadcastToAll, broadcastProject, broadcastToTopic, broadcastToTopicSubscribers, sendToDevice, closeDeviceSockets, setGuestBroadcastFilter,
    loadTopics, saveTopics, saveSingleTopic,
    getTopicById, getTopicBySessionKey, setTopicBrowserState, touchTopicActivity,
    loadUnread, saveUnread,
    loadLocalMessages, countMessagesBySession, saveLocalMessages, appendLocalMessage, appendImportedMessages,
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
