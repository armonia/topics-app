/**
 * Persistence layer for ClaudeSessionState — thin wrapper around the
 * `claude_code_sessions` table. All JSON-encoded columns are decoded here so
 * the caller works with the canonical TypeScript state object.
 *
 * Constraints inherited from the table:
 *   - PK is `session_key` (with FK to topics.session_key ON DELETE CASCADE).
 *     One row per Topics session, regardless of how many Claude CLI sessions
 *     have been launched/resumed against it.
 *   - `claude_session_id` is the current Claude CLI UUID, mutated on resume.
 *
 * We therefore look up by *either* key. Inserts go through the existing
 * upsert pattern (`ON CONFLICT(session_key) DO UPDATE`) used by the
 * claude-code provider, so the two writers coexist without races.
 *
 * No business logic — that lives in claude-session-state.ts.
 */

import type { Database } from 'bun:sqlite';
import {
  type ClaudeSessionState,
  type ClaudeSessionPhase,
  type PendingApproval,
  type ActiveTool,
  type ClaudeSessionError,
  ALL_PHASES,
} from './claude-session-state';

interface RawRow {
  session_key: string | null;
  claude_session_id: string;
  created_at: string;
  updated_at: string;
  phase: string;
  phase_updated_at: string | null;
  jsonl_path: string | null;
  jsonl_offset: number;
  import_offset: number | null;
  pending_approval_json: string | null;
  last_tool_json: string | null;
  last_hook_at: string | null;
  rev: number;
  error_json: string | null;
}

function isoToMs(s: string | null): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function safeParse<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function isValidPhase(p: string): p is ClaudeSessionPhase {
  return (ALL_PHASES as readonly string[]).includes(p);
}

function rowToState(row: RawRow): ClaudeSessionState {
  const phase: ClaudeSessionPhase = isValidPhase(row.phase) ? row.phase : 'dormant';
  return {
    sessionKey: row.session_key,
    claudeSessionId: row.claude_session_id,
    phase,
    phaseUpdatedAt: isoToMs(row.phase_updated_at) || isoToMs(row.updated_at),
    jsonlPath: row.jsonl_path ?? undefined,
    jsonlOffset: row.jsonl_offset,
    importOffset: row.import_offset,
    pendingApproval: safeParse<PendingApproval>(row.pending_approval_json),
    lastTool: safeParse<ActiveTool>(row.last_tool_json),
    lastHookAt: row.last_hook_at ? isoToMs(row.last_hook_at) : undefined,
    rev: row.rev,
    error: safeParse<ClaudeSessionError>(row.error_json),
    createdAt: isoToMs(row.created_at),
    updatedAt: isoToMs(row.updated_at),
  };
}

export interface ClaudeSessionRepo {
  loadByClaudeSessionId(claudeSessionId: string): ClaudeSessionState | null;
  loadBySessionKey(sessionKey: string): ClaudeSessionState | null;
  /**
   * Persist the full state. The row MUST already exist (inserted by the
   * claude-code provider on spawn). If it doesn't, this is a no-op and
   * returns false — caller can log "untracked session".
   *
   * NOTE: deliberately does NOT touch `import_offset` — that column has its own
   * writer (`setImportOffset`). The phase tracker calls `update` on every tail
   * sweep; folding import_offset in here would let a stale phase-copy clobber
   * the message importer's watermark (and vice-versa). One column, one owner.
   */
  update(state: ClaudeSessionState): boolean;
  /**
   * Narrow single-column write of the message importer's byte watermark. Its
   * own statement so it never races the full-state `update` (each owns disjoint
   * columns). Returns false if the row is gone.
   */
  setImportOffset(sessionKey: string, offset: number): boolean;
  /**
   * Every session enrolled in JSONL message import — `import_offset IS NOT NULL`
   * AND a transcript path to read. This is the set the import sweep walks; it is
   * exactly the ADOPTED sessions (adopt-claude is the only writer of a non-null
   * import_offset).
   */
  listImportable(): ClaudeSessionState[];
  /**
   * Segue il FORK del transcript: la sessione continua in un altro file
   * (`--resume` che riapre un nuovo `<id>.jsonl` con la storia ricopiata).
   * Sposta in UN colpo path + entrambi i cursori — separarli lascerebbe una
   * finestra in cui un offset del file vecchio viene letto sul file nuovo.
   *
   * Compare-and-swap su `jsonl_path`: se nel frattempo un hook (SessionStart
   * del figlio) ha già stabilito il path, la nostra rilettura perde e non
   * scrive nulla — chi ha la prova diretta vince sull'euristica.
   * Ritorna false se la riga è cambiata o non esiste.
   */
  relinkTranscript(args: {
    sessionKey: string;
    fromPath: string;
    toPath: string;
    claudeSessionId: string;
    offset: number;
    updatedAt: number;
  }): boolean;
  /**
   * Un ALTRO topic sta già seguendo questo transcript? Due sessioni nella
   * stessa cartella di progetto non devono rubarsi il file a vicenda.
   */
  isTranscriptPathTaken(path: string, exceptSessionKey: string): boolean;
  listAll(): ClaudeSessionState[];
  listActive(): ClaudeSessionState[];
  /**
   * Every row whose phase is non-terminal — ACTIVE_PHASES plus `dormant`.
   * The live JSONL tail sweeps THIS set, not listActive: the reaper demotes a
   * merely-silent `running` session (PTY alive, quiet) to `dormant`, and that
   * exact session can be woken by a Monitor/background event whose only trace
   * is its transcript growing. Terminal phases stay excluded — a completed or
   * errored session is never revived by JSONL (applyJsonlEvent guards too).
   */
  listLive(): ClaudeSessionState[];
  /**
   * Iterate every row whose phase is still active or starting. Used by the
   * recovery + reaper sweeps.
   */
  forEachLive(visitor: (state: ClaudeSessionState) => void): void;
}

const ACTIVE_PHASES: ReadonlyArray<ClaudeSessionPhase> = [
  'starting', 'running', 'tool-running', 'awaiting-user', 'awaiting-approval', 'paused', 'watching',
];

const LIVE_PHASES: ReadonlyArray<ClaudeSessionPhase> = [...ACTIVE_PHASES, 'dormant'];

export function createClaudeSessionRepo(db: Database): ClaudeSessionRepo {
  const selectByClaudeId = db.prepare(`SELECT * FROM claude_code_sessions WHERE claude_session_id = ?`);
  const selectByKey = db.prepare(`SELECT * FROM claude_code_sessions WHERE session_key = ?`);
  const selectAll = db.prepare(`SELECT * FROM claude_code_sessions ORDER BY updated_at DESC`);
  const selectActiveStmt = db.prepare(
    `SELECT * FROM claude_code_sessions
     WHERE phase IN (${ACTIVE_PHASES.map(() => '?').join(',')})
     ORDER BY phase_updated_at DESC NULLS LAST`
  );
  const selectLiveStmt = db.prepare(
    `SELECT * FROM claude_code_sessions
     WHERE phase IN (${LIVE_PHASES.map(() => '?').join(',')})
     ORDER BY phase_updated_at DESC NULLS LAST`
  );
  const selectImportableStmt = db.prepare(
    `SELECT * FROM claude_code_sessions
     WHERE import_offset IS NOT NULL AND jsonl_path IS NOT NULL
     ORDER BY updated_at DESC`
  );
  const setImportOffsetStmt = db.prepare(
    `UPDATE claude_code_sessions SET import_offset = ? WHERE session_key = ?`
  );
  const relinkStmt = db.prepare(
    `UPDATE claude_code_sessions
        SET jsonl_path = ?, jsonl_offset = ?, import_offset = ?, claude_session_id = ?, updated_at = ?
      WHERE session_key = ? AND jsonl_path = ?`
  );
  const pathTakenStmt = db.prepare(
    `SELECT 1 FROM claude_code_sessions WHERE jsonl_path = ? AND session_key IS NOT ? LIMIT 1`
  );

  const updateRow = db.prepare(`
    UPDATE claude_code_sessions SET
      claude_session_id = ?,
      updated_at = ?,
      phase = ?,
      phase_updated_at = ?,
      jsonl_path = ?,
      jsonl_offset = ?,
      pending_approval_json = ?,
      last_tool_json = ?,
      last_hook_at = ?,
      rev = ?,
      error_json = ?
    WHERE session_key = ?
  `);

  function rowFor(row: any | undefined): ClaudeSessionState | null {
    if (!row) return null;
    return rowToState(row as RawRow);
  }

  function update(state: ClaudeSessionState): boolean {
    if (!state.sessionKey) return false;
    const r = updateRow.run(
      state.claudeSessionId,
      msToIso(state.updatedAt),
      state.phase,
      msToIso(state.phaseUpdatedAt),
      state.jsonlPath ?? null,
      state.jsonlOffset,
      state.pendingApproval ? JSON.stringify(state.pendingApproval) : null,
      state.lastTool ? JSON.stringify(state.lastTool) : null,
      state.lastHookAt ? msToIso(state.lastHookAt) : null,
      state.rev,
      state.error ? JSON.stringify(state.error) : null,
      state.sessionKey,
    );
    return r.changes > 0;
  }

  function setImportOffset(sessionKey: string, offset: number): boolean {
    return setImportOffsetStmt.run(offset, sessionKey).changes > 0;
  }

  return {
    loadByClaudeSessionId: (id) => rowFor(selectByClaudeId.get(id)),
    loadBySessionKey: (key) => rowFor(selectByKey.get(key)),
    listAll: () => (selectAll.all() as RawRow[]).map(rowToState),
    listActive: () => (selectActiveStmt.all(...ACTIVE_PHASES) as RawRow[]).map(rowToState),
    listLive: () => (selectLiveStmt.all(...LIVE_PHASES) as RawRow[]).map(rowToState),
    listImportable: () => (selectImportableStmt.all() as RawRow[]).map(rowToState),
    setImportOffset,
    relinkTranscript: ({ sessionKey, fromPath, toPath, claudeSessionId, offset, updatedAt }) =>
      relinkStmt.run(toPath, offset, offset, claudeSessionId, msToIso(updatedAt), sessionKey, fromPath).changes > 0,
    isTranscriptPathTaken: (path, exceptSessionKey) => pathTakenStmt.get(path, exceptSessionKey) != null,
    update,
    forEachLive: (visitor) => {
      for (const s of (selectActiveStmt.all(...ACTIVE_PHASES) as RawRow[])) {
        visitor(rowToState(s));
      }
    },
  };
}
