/**
 * Per-session plumbing of the Claude Code provider: the MCP config file each
 * spawn is pinned to, the persisted CLI session id (resume vs. fresh start) and
 * the stderr patterns that say a resume or fork start was refused. Moved out of
 * `claude-code.ts` unchanged; the provider class and its callers import from here.
 */

import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from "fs";
import { getDatabase } from "../db";
import { topicsHome } from "../services/daemon-state";
import { topicsMcpBridgeLaunch } from "../lib/topics-mcp-bridge-argv";
import { issueSessionTokenFile } from "../lib/session-token";
import { resolveInheritedMcp } from "./mcp-inheritance";
import { forkStartFor } from "../lib/chat-fork";
import { readForkOrigin } from "../lib/chat-fork-store";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { restoreSweptTranscript } from "../lib/transcript-keeper";
import { hasPriorMessagesInDB } from "./claude/history-replay";
import { readDispatchBinding } from "../services/agent-job-quota";
import type { PersistentProcess } from "./claude-code";

// ============ MCP Config Generation ============
//
// Topics-app exposes a custom MCP server (server/mcp/topics-mcp-server.ts)
// that bridges the Claude Code CLI back to the host process. The CLI accepts
// `--mcp-config <path>` once per spawn; we generate a temporary JSON file
// describing how to spawn our stdio server, and pin it for the lifetime of
// the persistent process. The MCP server gets sessionKey + base URL + token
// as argv so it can call back into us without any extra discovery.
//
// The temp file is cleaned up when the persistent process is killed (see
// `cleanupMcpConfigForSession`). If cleanup misses (crash), the next spawn
// for the same sessionKey will simply overwrite the path — files in
// `os.tmpdir()/topics-mcp/` are bounded by sessionKey, not by run.

export const MCP_CONFIG_DIR = join(tmpdir(), "topics-mcp");

export function topicsAppBaseUrl(): string {
  const port = process.env.PORT || "3333";
  // The MCP subprocess always runs on the same host as topics-app (spawned
  // by the same Bun process), so localhost is sufficient and avoids
  // depending on hostname resolution.
  //
  // Protocol must match the server's actual listener: server.ts enables TLS
  // when certs/ exists and NO_TLS is unset. A mismatch (http:// against an
  // https listener) makes every gateway fetch fail with "socket connection
  // closed unexpectedly", which breaks all MCP tools. Mirror that detection
  // here. The MCP server disables cert verification for this loopback origin.
  // certs/ lives at the repo root (server.ts resolves it via its own
  // import.meta.dir); this file is two levels deeper under server/providers/.
  const certsDir = join(import.meta.dir, "..", "..", "certs");
  const useTls = !process.env.NO_TLS
    && existsSync(join(certsDir, "fullchain.pem"))
    && existsSync(join(certsDir, "key.pem"));
  const proto = useTls ? "https" : "http";
  return `${proto}://127.0.0.1:${port}`;
}

export function mcpConfigPathForSession(sessionKey: string): string {
  // Slugify sessionKey for filesystem safety; keep it deterministic so
  // re-spawns overwrite the same path instead of leaking files.
  const safe = sessionKey.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(MCP_CONFIG_DIR, `${safe}.json`);
}

// ---- Global MCP inheritance policy --------------------------------------
//
// A Claude session spawned inside Topics inherits the user's GLOBAL MCP
// servers (~/.claude.json) because the CLI auto-loads them (default config +
// `--setting-sources user`). Left unscoped, EVERY session re-spawns the entire
// fleet. To keep this controllable we write the FULL desired server set into
// the per-session config and pass `--strict-mcp-config`, so the CLI uses ONLY
// that set and ignores all other MCP configurations.
//
// THE POLICY ITSELF NO LONGER LIVES HERE: it is `providers/mcp-inheritance.ts`,
// because the native runtime has to answer the same question and a copy would
// drift on the first fix. This branch keeps only what is CLI-specific, which is
// the config file and the `--strict-mcp-config` decision.

/**
 * The servers this session inherits, or `null` when we must not scope (the
 * caller then keeps the legacy additive merge with NO `--strict-mcp-config`, so
 * the user loses nothing). The exclusion reasons are reported by the shared
 * resolver; here they only reach the log.
 */
export function resolveInheritedMcpServers(): Record<string, unknown> | null {
  const { servers, excluded } = resolveInheritedMcp();
  // Never a silent exclusion: a tool that is missing without an explanation is
  // indistinguishable from a bug, and people go looking in the wrong place.
  // The screen that shows this properly is fed by the same resolver.
  for (const e of excluded) {
    if (e.reason === "cold-boot") console.log(`[claude-code] MCP not inherited: ${e.name} (${e.detail})`);
  }
  return servers;
}

/**
 * Write the per-session MCP config and report whether the CLI should run with
 * `--strict-mcp-config` (i.e. we successfully scoped the global fleet). The
 * returned config always includes the `topics` bridge; when scoping succeeds
 * it also includes the curated set of inherited global servers.
 */
/**
 * The stdio spawn spec for the topics-app MCP bridge, keyed by sessionKey.
 * Shared so every MCP-capable host (claude-code CLI via --mcp-config, codex via
 * `-c mcp_servers.topics.*`) wires the SAME bridge — the subprocess gets the
 * sessionKey + base URL as argv to call back into topics-app.
 *
 * No secret travels with it. The bridge authenticates with the server's own
 * daemon token, which it reads from `--topics-home` on every request (a path,
 * not a secret: argv is fine). The old gateway token used to ride in argv,
 * where every `ps` printed it, and that is how it reached dozens of transcripts.
 */
export function topicsMcpBridgeSpec(sessionKey: string, profile?: string): { command: string; args: string[] } {
  // The token that lets this bridge sign AS this session goes in a 0600 file
  // the bridge reads, never in the argv below (`lib/session-token.ts`).
  issueSessionTokenFile(topicsHome(), sessionKey);
  // Checkout: Bun runs the script. Compiled binary: the binary itself, with a
  // flag (see `topics-mcp-bridge-argv.ts` for the second server it used to start).
  return topicsMcpBridgeLaunch([
    `--base-url=${topicsAppBaseUrl()}`,
    `--session-key=${sessionKey}`,
    // Tool profile: "dispatch" trims the bridge to what a board agent needs
    // (task tools + browser verification + processes) — fewer tool schemas
    // in the agent's per-call context. Absent = full toolset (interactive).
    ...(profile ? [`--profile=${profile}`] : []),
    `--topics-home=${topicsHome()}`,
  ]);
}

export function writeMcpConfigForSession(
  sessionKey: string,
  opts?: { mcpPolicy?: string | null; profile?: "global-orchestrator" },
): { path: string; strict: boolean } {
  try {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  } catch { /* race-tolerant */ }
  // The registry-owned global coordinator is never inferred from mcp_policy.
  // It receives just its five registry-gated board tools, and no inherited MCP
  // fleet. The strict config is defense in depth: tool discovery cannot leak a
  // broad capability into the coordinator's ordinary Topic conversation.
  // Only CodexProvider asks for this profile: this provider refuses the
  // coordinator outright (see `isRawGlobalCoordinator`).
  if (opts?.profile === "global-orchestrator") {
    const config = { mcpServers: { topics: topicsMcpBridgeSpec(sessionKey, "global-orchestrator") } };
    const path = mcpConfigPathForSession(sessionKey);
    writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    return { path, strict: true };
  }
  // 'bridge-only' (dispatched board agents, topics.mcp_policy, migration 049):
  // the session gets ONLY the topics bridge, spawned with the dispatch tool
  // profile, and strict unconditionally — the global fleet's tool schemas are
  // re-read on EVERY API call of every turn, a pure token tax for an agent
  // that works one task. Web research stays available via the CLI's built-in
  // WebSearch/WebFetch (not MCP). Per-board escape hatch: dispatch_mcp='inherit'.
  if (opts?.mcpPolicy === "bridge-only") {
    const config = { mcpServers: { topics: topicsMcpBridgeSpec(sessionKey, "dispatch") } };
    const path = mcpConfigPathForSession(sessionKey);
    writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    return { path, strict: true };
  }
  const topicsBridge = topicsMcpBridgeSpec(sessionKey);
  const inherited = resolveInheritedMcpServers();
  // strict ONLY when we scoped: the config then holds the full set the session
  // should see, so the CLI can safely ignore everything else. When scoping is
  // disabled/unavailable (inherited === null) we stay additive so the user
  // keeps every tool they already had.
  const strict = inherited !== null;
  const config = {
    mcpServers: {
      topics: topicsBridge,
      ...(inherited ?? {}),
    },
  };
  const path = mcpConfigPathForSession(sessionKey);
  // 0600: this file carries inherited server `env` blocks (API tokens) — must
  // not be world-readable in /tmp.
  // `mode` only applies on CREATE, and re-spawns overwrite the same path, so
  // chmod afterwards to force 0600 even if the file pre-existed at 0644.
  writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { path, strict };
}

export function cleanupMcpConfigForSession(sessionKey: string): void {
  try {
    unlinkSync(mcpConfigPathForSession(sessionKey));
  } catch { /* file may not exist, ignore */ }
}

// ============ Claude CLI Session ID Persistence ============

/**
 * Get or create the persistent Claude CLI session UUID for a given sessionKey.
 * Returns `{ id, isNew }` so the caller can decide between `--session-id` (new)
 * and `--resume` (existing). Survives hot reloads, inactivity timeouts, and
 * crashes — every spawn for the same sessionKey resumes the same conversation.
 *
 * Without this, the in-memory child process pool was the only thing tying a
 * sessionKey to a CLI conversation. Killing the child (which happens on
 * `bun --watch` hot reloads) erased the AI's memory of prior turns even
 * though all messages were preserved in the messages table.
 *
 * Esportata perché `isNew` È la decisione dell'argv (`--session-id` contro
 * `--resume`, riga ~1568): il test di `/clear` verifica lì che dopo il reset lo
 * spawn successivo riparta davvero da una sessione nuova, invece di fidarsi
 * del fatto che una riga sia stata cancellata.
 */
export function getOrCreateClaudeSessionId(sessionKey: string): { id: string; isNew: boolean } {
  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch {
    // DB not yet initialized — fall back to a transient ID. This shouldn't
    // happen in practice (initProviders runs after initDatabase) but we
    // don't want a fatal error.
    return { id: crypto.randomUUID(), isNew: true };
  }

  // Atomic upsert: SELECT-then-INSERT was racy (two parallel callers for the
  // same sessionKey could both see "no row" and the second INSERT would hit
  // the PRIMARY KEY constraint and crash). `INSERT ... ON CONFLICT DO UPDATE
  // ... RETURNING` collapses the read+write into one statement and returns
  // BOTH the resolved id and whether the row was freshly inserted.
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = db.prepare(
    `INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET updated_at = excluded.updated_at
     RETURNING claude_session_id`
  ).get(sessionKey, id, now, now) as { claude_session_id: string };
  // `isNew` = ha vinto l'INSERT, e lo si vede dall'id che torna: se è quello
  // che abbiamo appena generato la riga è nuova, se è un altro esisteva già
  // (il ramo ON CONFLICT non tocca `claude_session_id`). Un uuid appena
  // generato non può collidere, quindi il confronto è esatto.
  //
  // Prima era `created_at === now`, cioè due timestamp ISO al millisecondo:
  // due chiamate nello stesso millisecondo davano `isNew: true` su una riga
  // che esisteva, e lo spawn seguente partiva con `--session-id <id già
  // usato>` invece di `--resume`. Un difetto che si vede solo quando il
  // clock è "sfortunato" — cioè quasi mai, e mai in modo riproducibile.
  return { id: row.claude_session_id, isNew: row.claude_session_id === id };
}

/**
 * The session a spawn starts: its uuid, minted or resumed, the fork of a
 * forked chat's first start (CHAT-FORK-02, `forkStartFor`), and whether the
 * first message carries the database recap (CCLI-06). A fork is never a fresh
 * session (the route wrote the row), so it never carries the recap: the memory
 * comes from the CLI, and the recap would say it twice.
 */
export function planClaudeSessionStart(sessionKey: string, workspace: string) {
  const { id, isNew } = getOrCreateClaudeSessionId(sessionKey);
  // A resume of a session the CLI's 30-day cleanup swept would fail with "no
  // conversation found" and restart the chat from the DB recap: put the kept
  // transcript back first (lib/transcript-keeper.ts).
  if (!isNew) {
    let db: ReturnType<typeof getDatabase> | null = null;
    try { db = getDatabase(); } catch { /* no database: nothing kept */ }
    restoreSweptTranscript(db, workspace, id, `chat ${sessionKey}`);
  }
  let forkFrom: { sessionId: string; atUuid: string } | null = null;
  try {
    const origin = isNew ? null : readForkOrigin(getDatabase(), sessionKey);
    if (origin) forkFrom = forkStartFor(origin, id, existsSync(claudeTranscriptPath(workspace, id)));
  } catch { /* no database: an ordinary resume */ }
  return { claudeSessionId: id, isNewSession: isNew, forkFrom, needsHistoryReplay: isNew && hasPriorMessagesInDB(sessionKey) };
}

/** Read-only lookup of a session's claude_session_id (never INSERTs). Used by
 *  reattach, which must not conjure a row for a session it's only adopting. */
export function peekClaudeSessionId(sessionKey: string): string | null {
  try {
    const row = getDatabase()
      .prepare(`SELECT claude_session_id FROM claude_code_sessions WHERE session_key = ?`)
      .get(sessionKey) as { claude_session_id?: string } | undefined;
    return row?.claude_session_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the per-topic spawn-time overrides for a session: reasoning-effort
 * tier (migration 033) and model (migration 013, picked via the provider/model
 * picker and PATCHed onto the topic). Both are fixed at CLI spawn time, so
 * they're resolved fresh on every spawn and a PATCH-triggered respawn picks
 * them up. Nulls fall back to the global defaults (env-resolved effort,
 * `config.model`). `model` only applies when the topic's provider column
 * actually resolves to this CLI provider — a stale model persisted under a
 * different provider (openai, codex…) must not leak into `--model`. Kept as a
 * narrow row read (not the full `getTopicBySessionKey`) to avoid a circular
 * import with utils.ts.
 */
export function getTopicSpawnOverridesForSession(sessionKey: string): { effort: string | null; model: string | null; mcpPolicy: string | null; autonomy: string | null; dispatched: boolean } {
  try {
    const row = getDatabase()
      .prepare("SELECT id, effort, model, provider, mcp_policy, autonomy_level FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { id?: string; effort?: string | null; model?: string | null; provider?: string | null; mcp_policy?: string | null; autonomy_level?: string | null } | undefined;
    if (!row) return { effort: null, model: null, mcpPolicy: null, autonomy: null, dispatched: false };
    // «Questo topic è l'agente di un task?» Risponde a DUE domande insieme: il
    // cancello sulle immagini (la chat di una persona può volerne aprire una,
    // un agente che consegna una prova di review no — gli basta il path) e il
    // catalogo delle skill coi soli nomi. E non si chiede a `mcp_policy`:
    // 'bridge-only' è la scelta sullo SCOPING MCP, e un board può metterla su
    // 'inherit' (`dispatch_mcp`) restando dispacciato — sono assi diversi.
    // Lettura stretta, come il resto qui, per non ricreare l'import circolare
    // con utils.ts.
    // `readDispatchBinding` also reads `task_attempts`: a fan-out binds only
    // attempt 1 in `tasks.assigned_topic_id`, and attempts 2..N got a chat's
    // system prompt, which lets an agent end its turn on a wake (28/09).
    const dispatched = readDispatchBinding(getDatabase(), sessionKey).dispatched;
    const provider = row.provider ?? null;
    const providerIsUs = provider === null || provider === "claude-code" || provider === "claude-code-team";
    // Loose shape guard only (argv array — no shell involved): the CLI is the
    // authority on which ids/aliases exist, and listModels() deliberately lets
    // users pin future model names. Square brackets are part of the id, not
    // punctuation: the long-window variants are literally `claude-opus-5[1m]`,
    // and excluding them here silently dropped the override and fell back to
    // the 200k default — the picker offered 1M, the spawn never got it.
    const model = providerIsUs && typeof row.model === "string" && /^[A-Za-z0-9._[\]-]{1,64}$/.test(row.model)
      ? row.model
      : null;
    return { effort: row.effort ?? null, model, mcpPolicy: row.mcp_policy ?? null, autonomy: row.autonomy_level ?? null, dispatched };
  } catch {
    return { effort: null, model: null, mcpPolicy: null, autonomy: null, dispatched: false };
  }
}

/**
 * Forget the persisted Claude session UUID for a sessionKey. Called when the
 * CLI signals the on-disk session file is gone (missing/corrupted/upgrade) so
 * the next spawn starts fresh with `--session-id` instead of looping on a
 * doomed `--resume`.
 */
export function forgetClaudeSessionId(sessionKey: string): void {
  try {
    const db = getDatabase();
    db.prepare("DELETE FROM claude_code_sessions WHERE session_key = ?").run(sessionKey);
  } catch {
    // DB unavailable — nothing to do; the in-memory pool already discarded
    // the dead child, and the next bootstrap will regenerate the row.
  }
}

const SESSION_NOT_FOUND_PATTERNS = [
  /session\s+(not\s+found|does not exist)/i,
  /no\s+such\s+session/i,
  /could not find session/i,
  /session id .* not found/i,
  // The CLI's exact stream-json phrasing when `--resume <id>` finds nothing:
  // reported as an `error_during_execution` result frame on stdout.
  /no conversation found with session id/i,
];

export function looksLikeMissingSessionError(stderrChunk: string): boolean {
  return SESSION_NOT_FOUND_PATTERNS.some((p) => p.test(stderrChunk));
}

/**
 * The two ways a forked chat's first start is refused besides a missing
 * parent: the point is not in the parent's transcript (CLI 2.1.284: «No message
 * found with message.uuid of: <uuid>», exit 1, on stderr and in the `result`
 * errors, the same two channels as «No conversation found»), and a release
 * that no longer knows one of the two flags. Missed, the branch's transcript
 * is never born and every turn redoes the same fork and dies.
 */
const FORK_REFUSED_PATTERNS = [
  /no message found with message\.uuid/i,
  /unknown option.*--(fork-session|resume-session-at)/i,
];

export function looksLikeFailedStart(meta: PersistentProcess["spawnMeta"], text: string): boolean {
  return looksLikeMissingSessionError(text) || (!!meta.forkFrom && FORK_REFUSED_PATTERNS.some((p) => p.test(text)));
}
