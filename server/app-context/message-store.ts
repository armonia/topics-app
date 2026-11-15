import { join } from "path";
import { warnThrottled } from "../lib/warn-throttled";
import { isReusableHeadstone } from "../lib/empty-turn-headstone";
import type { StoredMessage, ReattachedPartial, ToolCall, ThreadLoadOpts, ContentBlock, ThreadSkeletonNode } from "../types";
import { decodeCol } from "../../shared/message-blob";
import { walkActiveThread, type SkeletonRow } from "../lib/thread-skeleton";
import { CONTEXT_PREFIX, hasMachineMark } from "../../shared/prompt-number";
import { toolCallsColumnForRow, toolCallsForDisk } from "../../shared/lean-tool-call";
import { blocksColumn, restoreFromStore, writeSplitRow, type BlocksColumn } from "../lib/tool-output-store";
import { isEmptyAssistantTurn } from "../../shared/empty-turn";
import { keepFirstTimes } from "../lib/tool-call-times";
import type { Database } from "bun:sqlite";
import { restoreToolCallsFromBlocks, sanitizeToolCallDetail } from "../utils";
import type { buildStatements } from "./statements";

/** A `messages` row as the lean read gives it: the object `rowToMessage` expects, without `blocks` and `tool_calls`. */
type LeanMessageRow = { id: string } & Record<string, unknown>;
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

export function createMessageStore(d: {
  stmts: ReturnType<typeof buildStatements>["stmts"];
  MESSAGES_DIR: string;
  db: Database;
}) {
  const { stmts, MESSAGES_DIR, db } = d;
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
  /** The `tool_calls` column, parsed and sanitized. `undefined` when unusable. */
  function parseToolCallsCol(raw: unknown, messageId: string): StoredMessage["toolCalls"] {
    try {
      const parsed: unknown = JSON.parse(decodeCol(raw) ?? "null");
      // A non-array survives untouched, as it always has: a corrupt shape is
      // reported by whoever reads it, not silently turned into an empty list.
      return Array.isArray(parsed)
        ? parsed.map(sanitizeToolCallDetail)
        : (parsed as StoredMessage["toolCalls"]);
    } catch (err) {
      // Corrupt tool_calls JSON → message hydrates without its tool calls
      // (recoverable, but silently lossy). Observe it.
      warnThrottled("rowToMessage:tool_calls", `[Store] Failed to parse tool_calls for message ${messageId}:`, err);
      return undefined;
    }
  }

  /**
   * The `blocks` column, parsed and sanitized. `undefined` when unusable.
   *
   * `outputs`: `'full'` puts back the tool output stored in
   * `message_tool_outputs` BEFORE the detail is sanitized, so the row reads
   * exactly as it was written whole; `'stub'` leaves the `''` and the mark,
   * for the history page and for readers that only look at kinds and marks.
   */
  function parseBlocksCol(raw: unknown, messageId: string, outputs: "full" | "stub" = "full"): ContentBlock[] | undefined {
    try {
      const parsed: unknown = JSON.parse(decodeCol(raw) ?? "null");
      if (!Array.isArray(parsed)) return undefined;
      if (outputs === "full") restoreFromStore(db, messageId, parsed);
      // v3 foundations NORM-01 DB hydration: each block of kind 'tool'
      // carries a toolCall whose `detail` may be a legacy / drifted
      // shape. Sanitize at the boundary so downstream consumers always
      // see a schema-conforming detail or none.
      return parsed.map((block: ContentBlock) => {
        const tool = block as { kind?: string; toolCall?: unknown };
        if (tool && tool.kind === 'tool' && tool.toolCall) {
          return { ...block, toolCall: sanitizeToolCallDetail(tool.toolCall as ToolCall) };
        }
        return block;
      });
    } catch (err) {
      // Corrupt blocks JSON → message hydrates without its rich blocks.
      warnThrottled("rowToMessage:blocks", `[Store] Failed to parse blocks for message ${messageId}:`, err);
      return undefined;
    }
  }

  /** Whether a read puts the stored tool output back: always, unless the caller
   *  opted out, and always for a partial row, which the wire ships whole. */
  function outputsMode(opts: Pick<ThreadLoadOpts, "withToolOutputs"> | undefined, partial: unknown): "full" | "stub" {
    return opts?.withToolOutputs === false && !partial ? "stub" : "full";
  }

  // `any`: a full messages-table row; typing its ~25 nullable columns would force casts that hide drift.
  function rowToMessage(row: any, opts?: ThreadLoadOpts): StoredMessage {
    const msg: StoredMessage = {
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    };
    if (row.thinking) msg.thinking = row.thinking;
    if (row.tool_calls && opts?.withToolCalls !== false) {
      const parsed = parseToolCallsCol(row.tool_calls, row.id);
      if (parsed !== undefined) msg.toolCalls = parsed;
    }
    if (row.blocks && opts?.withBlocks !== false) {
      const parsed = parseBlocksCol(row.blocks, row.id, outputsMode(opts, row.partial));
      if (parsed !== undefined) msg.blocks = parsed;
    }
    // The `tool_calls` column is not written when the row has `blocks`
    // (`toolCallsColumnForRow`, shared/lean-tool-call.ts): the tool calls live
    // inside the timeline, and this is where they come back out. One single
    // point, so every reader keeps seeing them: `loadActiveThread`,
    // `/api/history`, `getMessageById`, and Regenerate, which reads
    // `msg.toolCalls` as the evidence of the turn it is replacing
    // (routes/edit.ts). No copy: the toolCall objects are the ones already
    // hydrated in the blocks, so the array costs one reference per tool.
    restoreToolCallsFromBlocks(msg);
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
    if (row.end_reason) msg.endReason = row.end_reason;
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
    // The send's key: how the window that sent this row recognises it in a history read.
    if (row.client_message_id) msg.clientMessageId = row.client_message_id;
    return msg;
  }

  // Build the meta param block for insertMessage/updateMessage. Mirrors the
  // schema in 014-message-meta.sql + 015-message-blocks.sql; passing null
  // means "leave existing value alone" because updateMessage uses COALESCE
  // on these fields.
  function metaParams(msg: Partial<StoredMessage>, col?: BlocksColumn) {
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
      $end_reason: msg.endReason ?? null,
      // Insert only (`updateMessage` has no such parameter): a session rewritten
      // whole keeps the keys its rows were sent with, like their author.
      $client_message_id: msg.clientMessageId ?? null,
      // `blocksForDisk` e non `JSON.stringify`: dentro un tool block, `result`
      // e `detail` portano spesso la STESSA stringa byte per byte, e quella
      // copia e' il 30% del payload misurato (shared/lean-tool-call.ts). Qui si
      // scarta prima che tocchi il disco; quando la copia non c'e', il testo
      // passa intero.
      //
      // Then `encodeCol`: above 512 bytes the timeline goes to disk as zstd,
      // which is what every reader already expects (`decodeCol` in
      // `parseBlocksCol` and friends). The codec was written for this column
      // but never sat on the writer, so only the 2026-08-20 backfill had ever
      // compressed anything and the table went back to growing in plaintext at
      // ~13 MB a day. Under a streaming turn `persistBlocks` rewrites this row
      // dozens of times, so the saving is on the WAL too, not just on the file.
      //
      // `col`: the writer already built the column, splitting the tool output
      // of a closed row out to `message_tool_outputs` (`blocksColumn`,
      // server/lib/tool-output-store.ts). Without it, the timeline goes whole.
      $blocks: col ? col.value : blocksColumn(msg.blocks, false).value,
    };
  }

  /**
   * One row write whose `blocks` may shed its tool output: `run` receives the
   * column value to write, and the output is stored in the same transaction
   * (see `writeSplitRow`). `final` = the row is closed after this write.
   */
  function writeMessage(messageId: string, blocks: ContentBlock[] | null | undefined, final: boolean, run: (col: BlocksColumn) => void): void {
    const col = blocksColumn(blocks, final);
    writeSplitRow(db, messageId, col, (value) => run({ ...col, value }));
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
    const allRows = (lean ? stmts.getMessagesLean : stmts.getMessages).all(sessionKey) as DbRow[];
    if (allRows.length === 0) return [];

    // Build parent→children map
    const childrenMap = new Map<string | null, DbRow[]>(); // parentId → child rows
    for (const row of allRows) {
      const pid = row.parent_id || null;
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid)!.push(row);
    }

    // Sort children by branch_index
    for (const children of childrenMap.values()) {
      children.sort((a, b) => (a.branch_index || 0) - (b.branch_index || 0));
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
        const active = stmts.getActiveBranch.get(lookupKey, sessionKey) as DbRow;
        if (active) activeBranchIndex = active.active_branch_index;
      }

      // Children on the active branch — normally exactly one. `children` is
      // sorted by branch_index (stable over the sort_order load order), so
      // any duplicates come out in chronological order. Fall back to the first
      // child if the active index matches nothing (stale active_branches row).
      let selected = children.filter((c) => (c.branch_index || 0) === activeBranchIndex);
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
   * The active thread of a session WITHOUT the text: for each message who it is,
   * whether it is a partial and the two branch annotations. Same walk as
   * `loadActiveThread` (`lib/thread-skeleton.ts`), one query of a few columns
   * instead of reading them all. The real rows of the messages that matter are
   * read afterwards, with `loadThreadRows`.
   *
   * `forPrompts: true` adds `role` and `ctxPrefix` (gateway context envelope) to
   * every node: enough for `promptNumbers` and for the last-message check,
   * without anybody's text.
   */
  function loadThreadSkeleton(sessionKey: string, opts?: { forPrompts?: boolean }): ThreadSkeletonNode[] {
    const forPrompts = opts?.forPrompts === true;
    const rows = (forPrompts ? stmts.getMessageSkeletonWithRole : stmts.getMessageSkeleton).all(sessionKey) as Array<SkeletonRow & { role?: "user" | "assistant" }>;
    if (rows.length === 0) return [];
    const envelopes = forPrompts
      ? new Set((stmts.getContextEnvelopeIds.all(sessionKey, CONTEXT_PREFIX) as Array<{ id: string }>).map((r) => r.id))
      : null;
    return walkActiveThread(
      rows,
      (key) => (stmts.getActiveBranch.get(key, sessionKey) as { active_branch_index?: number } | undefined)?.active_branch_index,
      (msg) => console.warn(`[loadThreadSkeleton] ${sessionKey}: ${msg}`),
    ).map((n) => {
      const node: ThreadSkeletonNode = {
        id: n.row.id,
        partial: !!n.row.partial,
        siblingCount: n.siblingCount,
        activeBranchIndex: n.activeBranchIndex,
      };
      if (forPrompts) {
        node.role = n.row.role;
        node.ctxPrefix = envelopes!.has(n.row.id);
      }
      return node;
    });
  }

  /**
   * The real rows (lean: no `blocks` or `tool_calls`) of the given messages, IN
   * the order given and with the branch annotations `loadActiveThread` adds. An
   * id that is gone is skipped. The body is put back by `hydrateMessageBodies`.
   */
  function loadThreadRows(nodes: ReadonlyArray<{ id: string; siblingCount?: number; activeBranchIndex?: number }>): StoredMessage[] {
    const rowsById = new Map<string, LeanMessageRow>();
    const CHUNK = 500; // SQLite refuses more than 999 bound parameters
    for (let i = 0; i < nodes.length; i += CHUNK) {
      const ids = nodes.slice(i, i + CHUNK).map((n) => n.id);
      const rows = db
        .query(`SELECT ${LEAN_MESSAGE_COLUMNS} FROM messages WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as LeanMessageRow[];
      for (const row of rows) rowsById.set(row.id, row);
    }
    const messages: StoredMessage[] = [];
    for (const node of nodes) {
      const row = rowsById.get(node.id);
      if (!row) continue;
      const msg = rowToMessage(row, { withBlocks: false, withToolCalls: false });
      if (node.siblingCount !== undefined) msg.siblingCount = node.siblingCount;
      if (node.activeBranchIndex !== undefined) msg.activeBranchIndex = node.activeBranchIndex;
      messages.push(msg);
    }
    return messages;
  }

  /**
   * A lean WINDOW of the active thread: the last `limit` messages after dropping
   * the last `offset`, and the thread `total` without empty partials. Same answer
   * as `loadLocalMessages` + filter + `slice(-limit)`, but the whole session is
   * read as a skeleton and the real rows only for the messages that go out. The
   * body (`blocks`, `tool_calls`) is put back by `hydrateMessageBodies`, as for
   * the lean read. `limit` and `offset` are passed as they come from the client:
   * the semantics of `slice(-limit)` (0 or NaN = everything) is the old one.
   */
  function loadThreadWindow(sessionKey: string, limit: number, offset: number): { messages: StoredMessage[]; total: number } {
    const thread = loadThreadSkeleton(sessionKey);
    if (thread.length === 0) return { messages: [], total: 0 };
    // A partial without text is not a message: decided on the content, which the skeleton does not have.
    const emptyPartial = new Set<string>();
    if (thread.some((n) => n.partial)) {
      for (const r of stmts.getPartialContents.all(sessionKey) as Array<{ id: string; content: string | null }>) {
        if (!(r.content && r.content.trim())) emptyPartial.add(r.id);
      }
    }
    const complete = emptyPartial.size > 0 ? thread.filter((n) => !emptyPartial.has(n.id)) : thread;
    const total = complete.length;
    const sliced = offset > 0 ? complete.slice(0, Math.max(0, total - offset)) : complete;
    return { messages: loadThreadRows(sliced.slice(-limit)), total };
  }

  /**
   * Fills `blocks` and `tool_calls` back in, for THESE messages only.
   *
   * The other half of a lean load: the thread is walked without the two fat
   * columns, and only the handful of messages that actually leave the server
   * pays for them. A session of 49 messages carrying 14.2 MB across those
   * columns used to read, decompress and parse all of it to answer
   * `{"limit":1}` with 5 KB; now the bytes read follow the answer.
   *
   * Mutates in place. A message whose row has nothing in either column comes
   * back untouched.
   */
  function hydrateMessageBodies(msgs: StoredMessage[], opts?: Pick<ThreadLoadOpts, "withToolOutputs">): StoredMessage[] {
    const hydrate = messageBodyHydrator(msgs, opts);
    for (const m of msgs) hydrate(m);
    return msgs;
  }

  /**
   * The same second pass split in two: ONE query reads the stored columns of
   * every message in `msgs`, and the returned function decodes them for one
   * message at a time, when the caller gets to it.
   *
   * The byte-budgeted first page of `/api/history` walks its rows from the tail
   * and stops at the first one that breaks the budget, so decoding has to stay
   * per row (zstd + JSON.parse is where the cost is). Reading does not: it used
   * to be one SELECT per row, 40 statements for a light page. Measured on a
   * copy of this machine's DB, last 40 rows of the 60 most recent sessions:
   * 0.25 ms p50 / 0.48-0.83 ms p90 for the 40 SELECTs against 0.10 / 0.29 ms
   * for one IN, and the raw columns of those 40 rows are 160 KB p50, 835 KB at
   * most, still compressed.
   */
  function messageBodyHydrator(
    msgs: StoredMessage[],
    opts?: Pick<ThreadLoadOpts, "withToolOutputs">,
  ): (m: StoredMessage) => StoredMessage {
    /** The three columns the second pass reads back, and nothing else. */
    interface BodyRow { id: string; blocks: unknown; tool_calls: unknown }
    const byId = new Map<string, BodyRow>();
    // Chunked: SQLite refuses a statement with more than 999 bound parameters.
    const CHUNK = 500;
    for (let i = 0; i < msgs.length; i += CHUNK) {
      const chunk = msgs.slice(i, i + CHUNK);
      const rows = db
        .query(`SELECT id, blocks, tool_calls FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .all(...chunk.map((m) => m.id)) as BodyRow[];
      for (const row of rows) byId.set(row.id, row);
    }
    return (m) => {
      const row = byId.get(m.id);
      if (!row) return m;
      // Decoded once: a second call for the same message finds nothing to do.
      byId.delete(m.id);
      if (row.tool_calls) {
        const parsed = parseToolCallsCol(row.tool_calls, m.id);
        if (parsed !== undefined) m.toolCalls = parsed;
      }
      if (row.blocks) {
        const parsed = parseBlocksCol(row.blocks, m.id, outputsMode(opts, m.partial));
        if (parsed !== undefined) m.blocks = parsed;
      }
      // A closed row comes out as a fat read builds it: without this a row
      // whose column holds `[]` next to its tool blocks shipped
      // `toolCalls: []`, which `leanMessageForWire` does not drop, where the
      // fat read shipped nothing. A partial row is left as the lean read always
      // shipped it: the wire keeps it whole, and a rebuilt copy would double
      // the in-flight turn on the first page.
      if (!m.partial) restoreToolCallsFromBlocks(m);
      return m;
    };
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
        writeMessage(msg.id, msg.blocks, !msg.partial, (col) => stmts.insertMessage.run({
          $id: msg.id,
          $session_key: sessionKey,
          $role: msg.role,
          $content: msg.content || '',
          $thinking: msg.thinking || null,
          $tool_calls: toolCallsColumnForRow(msg.toolCalls, msg.blocks),
          $media: msg.media ? JSON.stringify(msg.media) : null,
          $partial: msg.partial ? 1 : 0,
          $streamed_at: msg.streamedAt || null,
          $plan_status: msg.planStatus || null,
          $timestamp: msg.timestamp,
          $sort_order: i,
          $parent_id: msg.parentId || null,
          $branch_index: msg.branchIndex || 0,
          ...metaParams(msg, col),
        }));
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
    /** The send's key (`clientMessageId`), on the person's row a send stored. Unique per session. */
    clientMessageId?: string,
  ): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order;
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
      ...(clientMessageId ? { clientMessageId } : {}),
      // Written whole, in one go: a sub-agent's report, a notice, an answer.
      ...(role === "assistant" ? { endReason: "done" as const } : {}),
    };
    writeMessage(stored.id, stored.blocks, true, (col) => stmts.insertMessage.run({
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
      ...metaParams(stored, col),
    }));
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
      const base = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order as number;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        writeMessage(msg.id, msg.blocks, true, (col) => stmts.insertMessage.run({
          $id: msg.id,
          $session_key: sessionKey,
          $role: msg.role,
          $content: msg.content || '',
          $thinking: msg.thinking || null,
          $tool_calls: toolCallsColumnForRow(msg.toolCalls, msg.blocks),
          $media: msg.media ? JSON.stringify(msg.media) : null,
          $partial: 0,
          $streamed_at: null,
          $plan_status: msg.planStatus || null,
          $timestamp: msg.timestamp,
          $sort_order: base + 1 + i,
          $parent_id: msg.parentId || null,
          $branch_index: msg.branchIndex || 0,
          ...metaParams(msg, col),
        }));
      }
    })();
  }

  function createPartialMessage(sessionKey: string, role: "user" | "assistant"): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order;
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
   *  `reattached`, e il client svuota la bolla prima di riempirla col replay.
   *
   *  A CLOSE FROM OUTSIDE IS NOT AN END. The StaleStream sweeper,
   *  `/api/chat/abort`, and the soft/hard timeouts in `routes/chat.ts` can all
   *  close this row (`partial=0`) while the turn's process is still alive —
   *  the `abort` they send it is an attempt, not a synchronous guarantee. If
   *  the process keeps going, the NEXT restart finds it still open
   *  (`reattachSurvivingChatTurns`, server.ts, asks the broker BEFORE calling
   *  in here: by the time this function runs, the caller already has proof
   *  the turn is alive). With `partial===1` as the only pass, that row was
   *  never reused again: a new one opened and the JSONL replay poured the
   *  turn into it FROM THE START — two consecutive rows, the second starting
   *  exactly like the first. Measured on the live DB on 2026-09-10: 65 pairs
   *  across 54 conversations.
   *
   *  The row says how it was closed (`end_reason`): `closed-outside` is this
   *  turn's own row, `done` is a whole answer and is left alone. For the rest,
   *  and for rows written before that column, the discriminant stays
   *  `latency_ms`: only the turn's legitimate completion writes it
   *  (`routes/chat.ts`, `Date.now() - turnStartMs`, never null), and none of
   *  the external closes pass it.
   *
   *  THE TURN'S ROW COMES FIRST, not the session's last one. With the child
   *  alive the boot sweep leaves the turn's row open, and a sub-agent's report
   *  written while the turn ran sits after it: adopting the LAST row poured
   *  the replay over the report, and the turn's own row was closed from
   *  outside once the leg ended, so a send waiting on it heard "a restart or a
   *  watchdog" for an answer that had completed (card a57e6d4d, test B). The
   *  same when the row was closed from outside before the reattach reached it:
   *  a window reloading after the restart runs the history cleanup first, and
   *  the stale sweeper may have given up on the turn. A turn that ended
   *  after such a row, finished, stopped or failed, is the last turn row, and
   *  with its latency it is not taken. */
  function reuseOrCreatePartialForReattach(sessionKey: string): ReattachedPartial {
    const row = (stmts.getTurnRow.get({ $sk: sessionKey }) ?? stmts.getLastMessage.get(sessionKey)) as DbRow;
    const isAssistant = row && row.role === "assistant";
    const stillPartial = isAssistant && (row.partial === 1 || row.partial === true);
    // A row the MACHINE wrote (a goal's stop line, the line under a turn the
    // machine stopped) is closed without `latency_ms` too, but it was never a
    // turn's own row: adopting it poured the replay over the line, and a replay
    // that then failed turned it into an error row offering Retry again.
    const closedFromOutsideWhileAlive = isAssistant && !stillPartial
      && (row.end_reason === "closed-outside" || (row.end_reason !== "done" && row.latency_ms == null))
      && !hasMachineMark(parseBlocksCol(row.blocks, String(row.id), "stub"));
    if (isAssistant && (stillPartial || closedFromOutsideWhileAlive)) {
      const now = new Date().toISOString();
      db.run("UPDATE messages SET streamed_at = ?, partial = 1, end_reason = NULL WHERE id = ?", [now, String(row.id)]);
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
    const row = stmts.getLastMessage.get(sessionKey) as DbRow;
    const riusabile = isReusableHeadstone(
      row
        ? {
            role: String(row.role ?? ""),
            content: String(row.content ?? ""),
            toolCallsJson: row.tool_calls == null ? null : String(row.tool_calls),
            // `decodeCol` and not `String`: since the writer compresses this
            // column, `String(blob)` would hand the headstone rule a comma
            // separated list of byte values instead of JSON.
            blocksJson: decodeCol(row.blocks),
            timestamp: String(row.timestamp ?? ""),
            partial: row.partial === 1 || row.partial === true,
          }
        : null,
      Date.now(),
    );
    if (!riusabile) return createPartialMessage(sessionKey, "assistant");
    const now = new Date().toISOString();
    db.run(
      "UPDATE messages SET content = '', blocks = NULL, tool_calls = NULL, streamed_at = ?, partial = 1, latency_ms = NULL, end_reason = NULL WHERE id = ?",
      [now, String(row.id)],
    );
    return {
      id: String(row.id), role: "assistant", content: "", timestamp: String(row.timestamp),
      partial: true, streamedAt: now, parentId: row.parent_id ?? null, branchIndex: row.branch_index ?? 0,
    } as StoredMessage;
  }

  /** `opts.rowId`: write THAT row of the session instead of the last one (see `getMessageForBodyUpdateById`). */
  function updateLastMessage(sessionKey: string, updates: Partial<StoredMessage>, opts?: { rowId?: string }): StoredMessage | null {
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
    const row = (opts?.rowId
      ? stmts.getMessageForBodyUpdateById.get(opts.rowId, sessionKey)
      : stmts.getLastMessageForBodyUpdate.get(sessionKey)) as DbRow;
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false, withToolCalls: false });
    Object.assign(msg, updates);
    // Only overwrite the body fields the caller actually passed. Fields absent
    // from `updates` go in as null so the COALESCE in updateMessage keeps the
    // existing column — a partial update (e.g. flipping `partial` on timeout)
    // must never re-persist a stale content/thinking/tool snapshot over
    // concurrent writes, which is how turns were being blanked.
    // The turn's closing write (`partial` off, whole timeline) is where a new
    // row sheds its tool output: while the row is open the stream rewrites it.
    writeMessage(msg.id, updates.blocks, !msg.partial, (col) => stmts.updateMessage.run({
      $id: msg.id,
      $content: 'content' in updates ? (msg.content || '') : null,
      $thinking: 'thinking' in updates ? (msg.thinking || null) : null,
      $tool_calls: 'toolCalls' in updates ? toolCallsColumnForRow(msg.toolCalls, updates.blocks) : null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      // Only the partial-msg fields landing in `updates` should overwrite —
      // the SQL's COALESCE keeps existing values when these are null.
      ...metaParams(updates, col),
    }));
    return msg;
  }

  function appendToLastMessage(sessionKey: string, contentDelta: string, thinkingDelta?: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as DbRow;
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
    const row = stmts.getLastMessage.get(sessionKey) as DbRow;
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
   * `has_tool_calls` is the one exception: a row that already carries the copy
   * (an older row, or the first tool of a turn announced before the first
   * block was persisted) gets ONE write to clear it, and then no more.
   *
   * `mirroredInBlocks` is DECLARED by the caller, not guessed from the row:
   * only whoever writes the block knows that the block carries this same tool
   * call (`routes/chat.ts` does, right after). The paths that write no
   * timeline at all (the gateway SSE consumer, an import) say nothing and keep
   * the column, which for them is the only source there is. Reading the blocks
   * here to check would cost the very parse this exists to avoid.
   */
  function toolColumnWriteMode(
    row: { has_blocks?: number; has_tool_calls?: number },
    mirroredInBlocks: boolean,
  ): 'skip' | 'clear' | 'write' {
    if (!mirroredInBlocks || row.has_blocks !== 1) return 'write';
    return row.has_tool_calls === 1 ? 'clear' : 'skip';
  }

  /** The row the two hot tool writers patch: the named one, or the session's last. */
  function toolUpdateRow(sessionKey: string, rowId: string | undefined): DbRow | null {
    return rowId
      ? stmts.getMessageForToolUpdateById.get(rowId, sessionKey) as DbRow | null
      : stmts.getLastMessageForToolUpdate.get(sessionKey) as DbRow | null;
  }

  function addToolCallToLastMessage(sessionKey: string, toolCall: ToolCall, opts?: { mirroredInBlocks?: boolean; rowId?: string }): StoredMessage | null {
    const row = toolUpdateRow(sessionKey, opts?.rowId);
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
      // In place, newer args win; the first times stay (lib/tool-call-times.ts).
      msg.toolCalls[existingIdx] = keepFirstTimes(msg.toolCalls[existingIdx], { ...msg.toolCalls[existingIdx], ...toolCall });
    } else {
      msg.toolCalls.push(toolCall);
    }
    const mode = toolColumnWriteMode(row, opts?.mirroredInBlocks === true);
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

  function updateToolCallResult(sessionKey: string, toolCallId: string, result: string, error?: string, extra?: Partial<ToolCall>, opts?: { mirroredInBlocks?: boolean; rowId?: string }): StoredMessage | null {
    const row = toolUpdateRow(sessionKey, opts?.rowId);
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false });
    const mode = toolColumnWriteMode(row, opts?.mirroredInBlocks === true);
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
  function updateToolCallFields(sessionKey: string, toolCallId: string, patch: Partial<ToolCall>, opts?: { rowId?: string }): StoredMessage | null {
    // L'UNICA statement che porta `blocks`: qui servono davvero (vedi sotto), e
    // questa via si percorre quando un tool si ferma a chiedere qualcosa a una
    // persona, non a ogni evento di tool.
    const row = (opts?.rowId
      ? stmts.getMessageForToolFieldsById.get(opts.rowId, sessionKey)
      : stmts.getLastMessageForToolFields.get(sessionKey)) as DbRow;
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
    // Same column as `metaParams`: this writer overrides `$blocks`, so without
    // the codec the pending-permission path would put the timeline back in
    // plaintext on a row the stream had just compressed. The row was read
    // whole (its stored tool output put back), so a closed one is split again.
    writeMessage(msg.id, nextBlocks, !msg.partial, (col) => stmts.updateMessage.run({
      $id: msg.id,
      $content: null,
      $thinking: null,
      $tool_calls: toolCallsColumnForRow(msg.toolCalls, nextBlocks ?? msg.blocks),
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
      $blocks: col.value,
    }));
    return msg;
  }

  // --- Branching helpers ---
  function getMessageById(id: string): StoredMessage | null {
    const row = stmts.getMessageById.get(id) as DbRow;
    return row ? rowToMessage(row) : null;
  }

  function getMessageSessionKey(id: string): string | null {
    const row = stmts.getMessageById.get(id) as DbRow;
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
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order;
    const maxBranch = (stmts.getMaxBranchIndex.get(parentId) as { max_idx: number }).max_idx;
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
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order;
    // Allocate the next branch index under the parent, like createBranchMessage.
    // This used to hardcode 0 — correct on the EDIT path (the parent is a
    // brand-new user message with no children) but colliding on REGENERATE,
    // where the anchor user message already has the original assistant reply
    // at index 0: two children with the same branch_index break both
    // loadActiveThread's selection and the sibling arrows.
    const maxBranch = (stmts.getMaxBranchIndex.get(parentId) as { max_idx: number }).max_idx;
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
      const row = stmts.getMessageBlocks.get(msg.id) as { blocks?: unknown } | undefined;
      // Through `decodeCol`, like every other reader of this column: the writer
      // stores it as zstd above 512 bytes, and the predicate wants the JSON.
      if (!isEmptyAssistantTurn({ role: "assistant", blocks: decodeCol(row?.blocks) })) return null;
    }
    // An empty placeholder with rows under it stays. The turn is finalized by
    // id, so this can be a row that others were born after, and those hang
    // from it (`appendLocalMessage` parents to the last row): the user's
    // resend, a sub-agent's exit report. The delete below takes a SUBTREE, and
    // an empty bubble costs less than a lost message.
    if (stmts.messageHasChildren.get(sessionKey, msg.id)) return null;
    return deleteMessageSubtree(sessionKey, msg.id) ? msg.id : null;
  }

  function switchActiveBranch(sessionKey: string, parentId: string, branchIndex: number): void {
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
  }

  function getSiblingMessages(parentId: string): StoredMessage[] {
    const rows = stmts.getSiblings.all(parentId) as DbRow[];
    return rows.map((row) => rowToMessage(row));
  }

  return { getMessagesPath, loadActiveThread, loadLocalMessages, loadThreadSkeleton, loadThreadRows, loadThreadWindow, hydrateMessageBodies, messageBodyHydrator, countMessagesBySession, saveLocalMessages, appendLocalMessage, appendImportedMessages, createPartialMessage, reuseOrCreatePartialForReattach, reuseHeadstoneOrCreate, updateLastMessage, appendToLastMessage, finalizeLastMessage, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields, getMessageById, getMessageSessionKey, createBranchMessage, createBranchPartialMessage, deleteMessageSubtree, discardIfEmptyTurn, switchActiveBranch, getSiblingMessages };
}
