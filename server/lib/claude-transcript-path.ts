/**
 * Locate a Claude Code session's transcript on disk.
 *
 * Claude Code stores each session's JSONL transcript under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the cwd is
 * encoded by replacing every NON-ALPHANUMERIC character with `-`.
 *
 * The transcript is the DURABLE record of a session: it survives server
 * restarts and outlives the `terminal_sessions` row. So "is this dormant
 * claude session still revivable?" reduces to "does its transcript exist?" —
 * which is exactly what the reaper/reconcile needs to decide whether a row is
 * worth keeping (resumable) or truly dead.
 */
import { homedir } from "os";
import { join } from "path";

/**
 * Encode a cwd the way Claude Code names its projects directory: EVERY
 * character that is not a letter or a digit becomes `-`.
 *
 * Non e' `/` e `.`, ed e' costato due corse di `measure:thread`. La regola vera
 * prende anche `_`, lo spazio, `+`, `@`, `~`. Sonda: una sessione aperta in
 * `/private/var/folders/.../T/enc_probe.l9VFnH/a_b.c d+e@f~g` si registra sotto
 * `-private-var-folders-...-T-enc-probe-l9VFnH-a-b-c-d-e-f-g`; e nessuna delle
 * 556 cartelle vere di `~/.claude/projects` contiene un carattere fuori da
 * `[-0-9A-Za-z]`.
 *
 * L'underscore non e' un caso di scuola: la temp dir di macOS e'
 * `/var/folders/<due>/<venti-caratteri>_<altri>/T/`, quindi ogni misura che
 * lavora in sandbox lo incontra sempre. E un progetto chiamato `my_project`
 * cadeva nello stesso buco: percorso inesistente, transcript «mancante»,
 * quindi zero token sulla card, `read_agent` cieco e la sessione dichiarata
 * orfana invece che ripresa.
 *
 * La codifica e' A SENSO UNICO (`/`, `.` e `_` finiscono tutti su `-`): da un
 * nome di cartella non si torna alla cwd. Chi deve risalire alla cwd la legge
 * dentro il JSONL, non dal nome della cartella.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Absolute path to a session's transcript JSONL (may or may not exist). */
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", claudeProjectDirName(cwd), `${sessionId}.jsonl`);
}

/**
 * Decide whether a topic's Claude session is an ORPHANED transcript: its
 * transcript is missing at the cwd the provider will actually resume from, so
 * `--resume` is doomed and the row should be forgotten (the next turn then
 * spawns fresh, seeded with the DB history recap — like lost-session recovery,
 * minus the wasted failed resume). Pure/injectable so it unit-tests without
 * touching disk or a DB.
 *
 * Guards — return false (keep the session) whenever we can't prove it's dead:
 *   - no claude_session_id, or no resolvable cwd → can't decide, keep.
 *   - within the flush grace window → a just-spawned session may not have
 *     written its jsonl yet; never mistake "not written yet" for "gone".
 *   - transcript present at the resolved cwd → resumable, keep.
 */
export function isTranscriptOrphaned(opts: {
  cwd: string | null | undefined;
  claudeSessionId: string | null | undefined;
  updatedAtMs: number;
  nowMs: number;
  graceMs: number;
  transcriptExists: (path: string) => boolean;
}): boolean {
  const { cwd, claudeSessionId, updatedAtMs, nowMs, graceMs, transcriptExists } = opts;
  if (!claudeSessionId) return false;
  if (!cwd) return false;
  if (updatedAtMs > 0 && nowMs - updatedAtMs < graceMs) return false;
  return !transcriptExists(claudeTranscriptPath(cwd, claudeSessionId));
}
