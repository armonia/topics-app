/** Message rows read from SQLite: the row codec, the active thread and its windows. */
import type { Database } from "bun:sqlite";
import { join } from "path";
import { decodeCol } from "../../shared/message-blob";
import { knownDetailTypes, parseToolCallDetail } from "../../shared/tool-call-detail";
import type { ToolCallDetail } from "../../shared/types";
import { CONTEXT_PREFIX } from "../../shared/prompt-number";
import { type SkeletonRow, walkActiveThread } from "../lib/thread-skeleton";
import { type BlocksColumn, blocksColumn, restoreFromStore, writeSplitRow } from "../lib/tool-output-store";
import { warnThrottled } from "../lib/warn-throttled";
import type { ContentBlock, StoredMessage, ThreadLoadOpts, ThreadSkeletonNode, ToolCall } from "../types";
import { type AppStatements, type DbRow, type LeanMessageRow, LEAN_MESSAGE_COLUMNS } from "./app-statements";

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
/** What `sanitizeToolCallDetail` hands back: the same tool call with `detail` parsed, degraded or gone. */
export type SanitizedToolCall<T> = T extends object ? Omit<T, 'detail'> & { detail?: ToolCallDetail } : T;

export function sanitizeToolCallDetail<T>(input: T): SanitizedToolCall<T> {
  type Loose = { id?: string; name?: string; detail?: { type?: unknown } };
  const tc = input as Loose | null | undefined;
  if (!tc || typeof tc !== 'object' || !tc.detail) return input as SanitizedToolCall<T>;
  const result = parseToolCallDetail(tc.detail);
  if (result.ok) {
    return (tc.detail === result.data ? tc : { ...tc, detail: result.data }) as SanitizedToolCall<T>;
  }
  const declaredType = typeof tc.detail?.type === 'string' ? tc.detail.type : undefined;
  if (declaredType && !knownDetailTypes.has(declaredType)) {
    warnThrottled(
      `NORM-DB:unknown-type:${declaredType}`,
      `[NORM-DB] Unknown detail type '${declaredType}' (${tc.name ?? '?'}): kept as raw`,
    );
    return { ...tc, detail: { type: 'unknown', raw: { args: tc.detail } } } as SanitizedToolCall<T>;
  }
  warnThrottled(
    `NORM-DB:malformed:${declaredType ?? '?'}`,
    `[NORM-DB] Dropping malformed detail for tool call ${tc.id ?? '?'} (${tc.name ?? '?'}): ${result.error}`,
  );
  // `_drop` non si usa PER COSTRUZIONE: destrutturare-e-scartare è il modo di
  // togliere una chiave da un oggetto senza mutarlo. Il valore che conta è `rest`.
  const { detail: _drop, ...rest } = tc;
  return rest as SanitizedToolCall<T>;
}

/**
 * `toolCalls` rebuilt from the tool blocks when the column left it empty (see
 * `rowToMessage`). Module level and exported: a route that picks a window of the
 * thread (`GET /api/topics/:id/messages`) needs the SAME rule for the partial row
 * it ships whole, not a copy of it.
 */
export function restoreToolCallsFromBlocks(msg: StoredMessage): void {
  if (!msg.toolCalls?.length && msg.blocks?.length) {
    const fromBlocks = msg.blocks
      .map((b) => b as { kind?: string; toolCall?: ToolCall })
      .filter((b) => b && b.kind === 'tool' && b.toolCall)
      .map((b) => b.toolCall as ToolCall);
    if (fromBlocks.length > 0) msg.toolCalls = fromBlocks;
  }
}

export function createMessageThreadReads({ MESSAGES_DIR, db, stmts }: { MESSAGES_DIR: string; db: Database; stmts: AppStatements }) {
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

  return { parseBlocksCol, rowToMessage, metaParams, writeMessage, getMessagesPath, loadActiveThread, loadLocalMessages, loadThreadSkeleton, loadThreadRows, loadThreadWindow, hydrateMessageBodies, messageBodyHydrator, countMessagesBySession };
}

export type MessageThreadReads = ReturnType<typeof createMessageThreadReads>;
