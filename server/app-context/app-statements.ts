/** The prepared SQLite statements of the app context, created once at boot. */
import type { Database } from "bun:sqlite";
import { NOT_STEERED_ROW } from "../lib/steered-row";

/** A `messages` row as the lean read gives it: the object `rowToMessage` expects, without `blocks` and `tool_calls`. */
export type LeanMessageRow = { id: string } & Record<string, unknown>;
/** A raw SQLite row: the columns read in this file are typed, any other stays unknown. */
export interface DbRow {
  id: string;
  session_key: string;
  topic_id: string;
  parent_id: string | null;
  branch_index: number | null;
  active_branch_index: number;
  tool_calls: string | Uint8Array | null;
  blocks: string | Uint8Array | null;
  content: string | null;
  has_blocks?: number;
  has_tool_calls?: number;
  [column: string]: unknown;
}

/** The `messages` columns without `blocks` and `tool_calls`: the lean read (see `getMessagesLean`). */
export const LEAN_MESSAGE_COLUMNS = `id, session_key, role, content, thinking, media, partial, streamed_at,
              plan_status, timestamp, sort_order, parent_id, branch_index, latency_ms,
              usage_prompt_tokens, usage_completion_tokens, cost_cents, cache_read_tokens,
              cache_creation_tokens, cache_creation_1h_tokens, model, author_person_id,
              author_device_id, end_reason, client_message_id`;

export function createAppStatements({ db }: { db: Database }) {
  // --- Prepared statements (created once for performance) ---
  const stmts = {
    // Topics
    getAllTopics: db.prepare(`SELECT * FROM topics WHERE 1=1`),
    // The two halves of the list, each on `idx_topics_archived`. The boot
    // payload asks for the live half only: on this machine 19 of 1,554 topics.
    getLiveTopics: db.prepare(`SELECT * FROM topics WHERE archived = 0`),
    getArchivedTopics: db.prepare(`SELECT * FROM topics WHERE archived = 1`),
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
    // CHAT-FORK-05: where a branch came from. `parent_id` NULL = the original is gone.
    getAllChatForks: db.prepare(`SELECT f.session_key, f.parent_name, f.fork_point_message_id, p.id AS parent_id FROM chat_forks f LEFT JOIN topics p ON p.id = f.parent_topic_id`),
    getChatFork: db.prepare(`SELECT f.session_key, f.parent_name, f.fork_point_message_id, p.id AS parent_id FROM chat_forks f LEFT JOIN topics p ON p.id = f.parent_topic_id WHERE f.session_key = ?`),

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
      INSERT INTO topics (id, name, slug, parent_id, session_key, color, icon, system_prompt, project_path, sort_order, autonomy_level, provider, model, topics_routing, effort, fast_mode, muted, worktree_id, initial_message, standalone, mcp_policy, browser_state, archived, created_at, updated_at)
      VALUES ($id, $name, $slug, $parent_id, $session_key, $color, $icon, $system_prompt, $project_path, $sort_order, $autonomy_level, $provider, $model, $topics_routing, $effort, $fast_mode, $muted, $worktree_id, $initial_message, $standalone, $mcp_policy, $browser_state, $archived, $created_at, $updated_at)
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
        topics_routing = excluded.topics_routing,
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
    getUnreadOne: db.prepare(`SELECT unread_count FROM unread WHERE topic_id = ?`),
    upsertUnread: db.prepare(`INSERT OR REPLACE INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, ?)`),
    deleteUnread: db.prepare(`DELETE FROM unread WHERE topic_id = ?`),
    // A new row starts at 1 stamped now; an existing one keeps `last_read_at`.
    bumpUnread: db.prepare(`INSERT INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, 1)
      ON CONFLICT(topic_id) DO UPDATE SET unread_count = unread_count + 1 RETURNING unread_count`),
    setUnreadEntry: db.prepare(`INSERT INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET last_read_at = excluded.last_read_at, unread_count = excluded.unread_count`),

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
      `SELECT ${LEAN_MESSAGE_COLUMNS}
       FROM messages WHERE session_key = ? ORDER BY sort_order ASC`,
    ),
    /**
     * The skeleton of the thread: four columns, no text. Picking WHICH messages
     * go out of a window does not need the content of all of them
     * (`loadThreadSkeleton`): on the route bench, 1.5 ms against the 5.8 of the
     * lean read of 3000 rows. The variant with `role` is for whoever numbers the
     * prompts of the whole thread (`/api/history`); the gateway's context
     * envelopes, which are not prompts, are told by a separate query
     * (`getContextEnvelopeIds`) that costs less than carrying them in every row.
     */
    getMessageSkeleton: db.prepare(
      `SELECT id, parent_id, branch_index, partial FROM messages WHERE session_key = ? ORDER BY sort_order ASC`,
    ),
    getMessageSkeletonWithRole: db.prepare(
      `SELECT id, parent_id, branch_index, partial, role FROM messages WHERE session_key = ? ORDER BY sort_order ASC`,
    ),
    getContextEnvelopeIds: db.prepare(
      `SELECT id FROM messages WHERE session_key = ?1 AND role = 'user' AND substr(content, 1, length(?2)) = ?2`,
    ),
    /** The partial rows of a session only, for the "empty partial" filter. */
    getPartialContents: db.prepare(`SELECT id, content FROM messages WHERE session_key = ? AND partial = 1`),
    getLastMessage: db.prepare(`SELECT * FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`),
    /**
     * The last row after the person's last message that a turn wrote: still
     * open, or closed any way but written whole (`done` with no latency: a
     * report, a notice, a regenerated reply). A turn that stopped, failed or
     * was cut is one: skipping it handed the reattach an older row closed
     * from outside, and a later wake's replay was poured over that row, in the
     * middle of the thread. Rows written before `end_reason` are left to the
     * caller's fallback. See `reuseOrCreatePartialForReattach`.
     */
    getTurnRow: db.prepare(
      `SELECT * FROM messages WHERE session_key = $sk AND role = 'assistant'
         AND (partial = 1 OR (end_reason IS NOT NULL AND (end_reason <> 'done' OR latency_ms IS NOT NULL)))
         AND sort_order > COALESCE((SELECT MAX(sort_order) FROM messages WHERE session_key = $sk AND role = 'user' AND ${NOT_STEERED_ROW}), -1)
       ORDER BY sort_order DESC LIMIT 1`,
    ),
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
              author_device_id
       FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`,
    ),
    /**
     * THE SAME THREE READS, BY ROW ID. The "last row of the session" is the
     * right target only while nothing was written after the turn, and a turn
     * does not control that: the resume sweep writes its notices, a boot writes
     * its own, a woken turn opens a row. A turn that wrote on the last row
     * wrote on THOSE (card 1046df0b, 24/09 on chat 3019832f). The chat route
     * knows its row from the start and passes it as `rowId`; the session key
     * stays in the WHERE so an id can never reach another conversation.
     */
    getMessageForBodyUpdateById: db.prepare(
      `SELECT id, session_key, role, content, thinking, media, partial, streamed_at,
              plan_status, timestamp, parent_id, branch_index, latency_ms,
              usage_prompt_tokens, usage_completion_tokens, cost_cents, cache_read_tokens,
              cache_creation_tokens, cache_creation_1h_tokens, model, author_person_id,
              author_device_id
       FROM messages WHERE id = ? AND session_key = ?`,
    ),
    getMessageForToolUpdateById: db.prepare(
      `SELECT id, session_key, role, content, thinking, tool_calls, media, partial, streamed_at, plan_status, timestamp,
              CASE WHEN blocks IS NULL OR blocks IN ('', '[]', 'null') THEN 0 ELSE 1 END AS has_blocks,
              CASE WHEN tool_calls IS NULL OR tool_calls IN ('', '[]', 'null') THEN 0 ELSE 1 END AS has_tool_calls
       FROM messages WHERE id = ? AND session_key = ?`,
    ),
    getMessageForToolFieldsById: db.prepare(`SELECT id, session_key, role, content, thinking, tool_calls, blocks, media, partial, streamed_at, plan_status, timestamp FROM messages WHERE id = ? AND session_key = ?`),
    getAssistantMessageById: db.prepare(`SELECT id, content FROM messages WHERE id = ? AND session_key = ? AND role = 'assistant'`),
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
    /** Whether any row hangs from this one. Read by `discardIfEmptyTurn` only. */
    messageHasChildren: db.prepare(`SELECT 1 FROM messages WHERE session_key = ? AND parent_id = ? LIMIT 1`),
    getLastAssistantMessage: db.prepare(`SELECT id, content FROM messages WHERE session_key = ? AND role = 'assistant' ORDER BY sort_order DESC LIMIT 1`),
    appendMessageContent: db.prepare(`UPDATE messages SET content = ? WHERE id = ?`),
    getMaxSortOrder: db.prepare(`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM messages WHERE session_key = ?`),
    insertMessage: db.prepare(`
      INSERT INTO messages (id, session_key, role, content, thinking, tool_calls, blocks, media, partial, streamed_at, plan_status, timestamp, sort_order, parent_id, branch_index, latency_ms, usage_prompt_tokens, usage_completion_tokens, cost_cents, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, model, author_person_id, author_device_id, end_reason, client_message_id)
      VALUES ($id, $session_key, $role, $content, $thinking, $tool_calls, $blocks, $media, $partial, $streamed_at, $plan_status, $timestamp, $sort_order, $parent_id, $branch_index, $latency_ms, $usage_prompt_tokens, $usage_completion_tokens, $cost_cents, $cache_read_tokens, $cache_creation_tokens, $cache_creation_1h_tokens, $model, $author_person_id, $author_device_id, $end_reason, $client_message_id)
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
        author_device_id = COALESCE($author_device_id, author_device_id),
        end_reason = COALESCE($end_reason, end_reason)
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

  return { stmts };
}

export type AppStatements = ReturnType<typeof createAppStatements>["stmts"];
