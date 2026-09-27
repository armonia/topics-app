/**
 * BOOT CLEANUP: a FINALIZED message (partial=0) must never carry a tool still
 * marked 'running'. The client renders it as a spinner whose timer ticks
 * forever (observed: a Shell tool "running" for 2h+ at session end). These are
 * orphans from turns that died without finalizing their tools: a server restart
 * clears the in-memory activeStreams, so the stale-stream sweeper can no longer
 * reach them. They are marked interrupted, with `endedAt` stamped so the
 * duration freezes. Scoped to partial=0, so a mid-turn row being adopted
 * (partial=1) is never touched. Idempotent: a clean boot finds nothing to fix.
 *
 * The rule for one tool lives in `orphan-tool-sweep.ts`; this is the boot's
 * walk over the table, run once by server.ts after the partial sweep.
 */
import type { Database } from "bun:sqlite";
import { decodeCol, encodeCol } from "../../shared/message-blob";
import { NOT_ARCHIVED_SQL } from "./archived-scope";
import { finalizeOrphanTool } from "./orphan-tool-sweep";
import { bonificaTurniMuti } from "./verdetto-turno-interrotto";

const RUNNING_RE = /"status":"(running|pending|waiting_for_input|awaiting_permission)"/;
const INTERRUPTED_RE = /Interrotto/;
const INTERRUPTED_MARKER = "⚠️ Turno interrotto prima di una risposta finale: la sessione si è chiusa mentre un tool era ancora in corso (probabile comando che non è terminato). Il tool interessato risulta in errore qui sotto — puoi rilanciarlo o riprendere da qui.";

type OrphanRow = { id: string; session_key: string | null; content: string | null; tool_calls: unknown; blocks: unknown; end_reason: string | null };

/** `liveSessions`: the chat sessions whose child the broker still lists alive at boot. */
export function finalizeOrphanedRunningTools(db: Database, liveSessions: ReadonlySet<string>): void {
  try {
    // A time window, not the whole history. Without `timestamp >=` this ran at
    // boot as a SCAN of a ~128 MB table with four LIKEs on JSON columns (215 ms
    // measured warm), and on this DB it returned 17 rows that were ALL false
    // positives: `"status":"running"` inside a tool's OUTPUT (a log, quoted
    // JSON), not a real state. Thirty days because this cleans up after a
    // restart: a tool left 'running' for over a month is not a turn anyone
    // will resume. idx_messages_timestamp (migration 074) makes it a SEARCH.
    //
    // ITERATED, NOT LOADED: the difference between 148 MB and 2.6 GB. An
    // `.all()` here materialised every row of thirty days before looking at
    // one: 8,354 rows for 706 MB of `content` + `tool_calls` + `blocks`,
    // doubled by `decodeCol` into UTF-16 strings, and the server's footprint
    // rose to 2.6 GB eighteen seconds into boot. The peak left swapped pages
    // behind that the footprint never gave back (`idle-gc.ts`). `iterate()`
    // holds one row at a time, so the peak follows what is FOUND, not the DB.
    //
    // The filter stays in JS on purpose: the regex cannot see through the
    // zstd-compressed JSON (`shared/message-blob.ts`), so a `LIKE` on those
    // columns would find nothing.
    const rowIter = db.prepare(
      `SELECT id, session_key, content, tool_calls, blocks, end_reason FROM messages
       WHERE timestamp >= date('now', '-30 days') AND partial = 0
         AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)
         AND ${NOT_ARCHIVED_SQL}`
    ).iterate() as Iterable<OrphanRow>;
    const rows: OrphanRow[] = [];
    for (const r of rowIter) {
      // Only what will be rewritten is kept: the other rows leave scope here.
      if (RUNNING_RE.test((decodeCol(r.tool_calls) ?? "") + (decodeCol(r.blocks) ?? ""))) rows.push(r);
    }
    if (rows.length === 0) return;
    const upd = db.prepare(`UPDATE messages SET content = ?, tool_calls = ?, blocks = ? WHERE id = ?`);
    const now = Date.now();
    let msgs = 0, tools = 0;
    let spared = 0;
    for (const r of rows) {
      // The session's child is still ALIVE in the broker: its tool can still
      // deliver and a QUESTION on screen can still be answered. Calling it
      // interrupted here turned a live question into a ⚠️ with Retry on the
      // first hot reload that lost the `partial` flag (topic:ed2070df, 3
      // August). A child really dead shows at the next boot, when the broker
      // no longer lists it.
      const alive = !!r.session_key && liveSessions.has(r.session_key);
      if (alive) spared++;
      let changed = false;
      const tcDecoded = decodeCol(r.tool_calls);
      const blDecoded = decodeCol(r.blocks);
      let tcStr: string | Uint8Array | null = r.tool_calls as string | null;
      let blStr: string | Uint8Array | null = r.blocks as string | null;
      // The client renders tool state from `blocks` (the chronological timeline)
      // when present, so BOTH columns must be finalized, or the spinner keeps
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
        // so the user sees a reason instead of a bare unexplained error X. Not
        // on a live session: there only a permission panel was closed, not the
        // turn. Nor on a row the boot sweep cut: the restart notice right after
        // it is the explanation, and a second one was handed back by
        // send_chat_message as what the turn had written (card a57e6d4d).
        const hasProse = typeof r.content === "string" && r.content.trim().length > 0;
        const content = hasProse || alive || r.end_reason === "cut-by-restart" ? r.content : INTERRUPTED_MARKER;
        upd.run(content, tcStr, blStr, r.id); msgs++;
      }
    }
    if (msgs > 0) console.log(`[boot] finalized ${tools} orphaned running tool(s) across ${msgs} message(s)`);
    if (spared > 0) console.log(`[boot] ${spared} message(s) with a live broker child: only permissions closed, the rest left alone`);
    // Second pass: an assistant turn already finalized as interrupted (its tool
    // carries the "Interrotto" marker) but with no final prose renders as a bare
    // unexplained error X. Give it the explanation. Idempotent: once content is
    // set the row no longer matches. Uses decoded text, since LIKE on
    // compressed blobs would not match; iterated for the same reason as above.
    // A row the boot sweep cut is left out, as in the first pass.
    const explainIter = db.prepare(
      `SELECT id, tool_calls, blocks FROM messages WHERE role = 'assistant'
         AND (content IS NULL OR trim(content) = '')
         AND COALESCE(end_reason, '') <> 'cut-by-restart'
         AND timestamp >= date('now', '-30 days') AND partial = 0
         AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)
         AND ${NOT_ARCHIVED_SQL}`
    ).iterate() as Iterable<{ id: string; tool_calls: unknown; blocks: unknown }>;
    let explainCount = 0;
    const explainUpd = db.prepare(`UPDATE messages SET content = ? WHERE id = ?`);
    // The ids are collected BEFORE writing: updating the table being iterated
    // is undefined in SQLite, and this UPDATE touches the WHERE's own column.
    const toExplain: string[] = [];
    for (const row of explainIter) {
      if (INTERRUPTED_RE.test((decodeCol(row.tool_calls) ?? "") + (decodeCol(row.blocks) ?? ""))) toExplain.push(row.id);
    }
    for (const id of toExplain) { explainUpd.run(INTERRUPTED_MARKER, id); explainCount++; }
    if (explainCount > 0) console.log(`[boot] added interruption explanation to ${explainCount} message(s)`);

    // THIRD PASS: the mute turns WITH prose, which are most of them. The two
    // above explain only rows that wrote NOTHING, and an agent's turn nearly
    // always writes something. The walk and its reason are in
    // `verdetto-turno-interrotto.ts`, tested on their own.
    bonificaTurniMuti(db, INTERRUPTED_MARKER.replace(/^⚠️\s*/, ""));
  } catch (e) {
    console.warn(`[boot] finalizeOrphanedRunningTools failed:`, e);
  }
}
