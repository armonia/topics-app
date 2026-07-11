/**
 * ClaudeCodeProvider — AIProvider implementation that spawns Claude Code CLI processes.
 *
 * Ports the persistent process pool pattern from the Jarvis router.
 * Instead of calling the Anthropic SDK, spawns `claude` CLI with stream-json I/O,
 * maintaining long-lived processes per session with inactivity/lifetime timeouts.
 */

import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { createInterface, Interface } from "readline";
import { readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import type {
  AIProvider,
  ChatMessage,
  CompletionResult,
  ProviderCapability,
  ProviderDiagnostic,
  ProviderRequirement,
  StreamHandler,
} from "./types";
import { probeBinaryPath } from "../utils/executable";
import { getDatabase } from "../db";
import { SidechainTracker } from "./claude/sidechain-tracker";
import { TOPICS_AGENT_SYSTEM_PROMPT, resolveClaudeEffort } from "../lib/topics-agent-prompt";
import { detectUserInputRequest } from "./ask-user-detector";

// ============ Config ============

export interface ClaudeCodeProviderConfig {
  type: "claude-code";
  model?: string;           // defaults to "claude-sonnet-4-6"
  permissionMode?: string;  // defaults to "bypassPermissions"
  defaultWorkspace?: string; // defaults to HOME
}

// ============ Constants ============

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;      // 2 hours
const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;        // 30 min
const RATE_LIMIT_GRACE_MS = 10_000;               // 10s grace after rate limit detection
const KILL_GRACE_MS = 3_000;                       // 3s between SIGTERM and SIGKILL
// Heartbeat (Fix B in stream-timeout-resilience):
//   Re-emit `onSubAgentUpdate` snapshots when the provider has gone quiet
//   for ≥ HEARTBEAT_QUIET_MS while Task() sub-agents are still pending.
//   Tick frequency is independent of quiet window — we tick every 10s and
//   check the elapsed-since-last-event inside the interval. This keeps the
//   timer cost trivial (one setInterval per active stream) while giving
//   responsive heartbeats once we cross the quiet threshold.
const HEARTBEAT_TICK_MS = 10_000;                  // 10s tick (cheap)
const HEARTBEAT_QUIET_MS = 30_000;                 // emit only after 30s silence

// ============ CLI Path Resolution ============

const CLI_VERSIONS_DIR = join(process.env.HOME || "", ".local/share/claude/versions");

function resolveCliPath(): string {
  // Scan for latest installed version
  try {
    const versions = readdirSync(CLI_VERSIONS_DIR)
      .filter((f) => /^\d/.test(f))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length > 0) return `${CLI_VERSIONS_DIR}/${versions[0]}`;
  } catch { /* directory not readable */ }

  // Fallback: stable launcher
  const launcher = join(process.env.HOME || "", ".local/bin/claude");
  try {
    if (existsSync(launcher)) return launcher;
  } catch {}

  // Last resort: PATH
  return "claude";
}

// ============ Env Sanitization ============

const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "TZ", "USER", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "ANTHROPIC_API_KEY",
]);

const ENV_BLOCKLIST_PATTERNS = [
  /API_KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i,
  /PRIVATE_KEY/i, /CREDENTIAL/i, /AUTH/i,
];

const ENV_BLOCKLIST_EXCEPTIONS = new Set(["ANTHROPIC_API_KEY"]);

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // Double-check blocklist
  for (const key of Object.keys(env)) {
    if (ENV_BLOCKLIST_EXCEPTIONS.has(key)) continue;
    if (ENV_BLOCKLIST_PATTERNS.some((p) => p.test(key))) {
      delete env[key];
    }
  }

  env.JARVIS_SPAWN = "1";
  return env;
}

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

const MCP_CONFIG_DIR = join(tmpdir(), "topics-mcp");
const MCP_SERVER_SCRIPT = join(import.meta.dir, "..", "mcp", "topics-mcp-server.ts");

function topicsAppBaseUrl(): string {
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
// fleet — including chrome-devtools-mcp, which launches a real ~1.2GB Chrome.
// To keep this controllable we write the FULL desired server set into the
// per-session config and pass `--strict-mcp-config`, so the CLI uses ONLY that
// set and ignores all other MCP configurations.
//
// Everything is override-able via env (no code change, no rebuild):
//   TOPICS_SESSION_MCP_INHERIT_ALL=1 -> legacy: inherit everything, no strict
//   TOPICS_SESSION_MCP_ALLOW="a,b"   -> strict allowlist (topics + these only)
//   TOPICS_SESSION_MCP_DENY="x,y"    -> inherit all global EXCEPT these
//   (none)                           -> inherit all global EXCEPT DEFAULT_DENY
//
// Default-deny: chrome-devtools — a per-session real Chrome, redundant with
// jarvis-browser / claude-in-chrome, and the single heaviest idle offender.
const DEFAULT_DENY_MCP = new Set(["chrome-devtools"]);

function parseCsvEnv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve which GLOBAL (~/.claude.json) MCP servers a Topics session should
 * inherit. Returns null when we cannot / should not scope (caller then keeps
 * the legacy additive merge with NO --strict-mcp-config, so the user loses
 * nothing). Server definitions are copied verbatim so they spawn identically.
 */
function resolveInheritedMcpServers(): Record<string, unknown> | null {
  if (process.env.TOPICS_SESSION_MCP_INHERIT_ALL === "1") return null;
  const home = process.env.HOME;
  if (!home) return null;
  let global: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    global = (parsed && typeof parsed === "object" && (parsed as any).mcpServers) || {};
  } catch {
    return null; // can't read global config -> don't risk stripping tools
  }
  const allow = parseCsvEnv("TOPICS_SESSION_MCP_ALLOW");
  const deny = new Set([...parseCsvEnv("TOPICS_SESSION_MCP_DENY"), ...DEFAULT_DENY_MCP]);
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(global)) {
    if (name === "topics") continue; // our bridge is added explicitly below
    if (allow.length > 0) {
      if (allow.includes(name)) out[name] = def;
    } else if (!deny.has(name)) {
      out[name] = def;
    }
  }
  return out;
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
 * sessionKey + base URL + gateway token as argv to call back into topics-app.
 */
export function topicsMcpBridgeSpec(sessionKey: string): { command: string; args: string[] } {
  return {
    command: process.execPath, // bun
    args: [
      "run",
      MCP_SERVER_SCRIPT,
      `--base-url=${topicsAppBaseUrl()}`,
      `--session-key=${sessionKey}`,
      ...(process.env.GATEWAY_TOKEN ? [`--gateway-token=${process.env.GATEWAY_TOKEN}`] : []),
    ],
  };
}

export function writeMcpConfigForSession(sessionKey: string): { path: string; strict: boolean } {
  try {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  } catch { /* race-tolerant */ }
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
  // 0600: this file now carries inherited server `env` blocks (API tokens) and
  // the topics bridge's --gateway-token — must not be world-readable in /tmp.
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
 */
function getOrCreateClaudeSessionId(sessionKey: string): { id: string; isNew: boolean } {
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
     RETURNING claude_session_id, created_at`
  ).get(sessionKey, id, now, now) as { claude_session_id: string; created_at: string };
  return { id: row.claude_session_id, isNew: row.created_at === now };
}

/**
 * Read the per-topic reasoning-effort override (migration 033) for a session.
 * Returns null when there's no topic, no override, or the DB isn't ready — in
 * every case the caller falls back to the global env-resolved default via
 * `resolveClaudeEffort(null)`. Kept as a narrow single-column read (not the
 * full `getTopicBySessionKey`) to avoid a circular import with utils.ts.
 */
function getTopicEffortForSession(sessionKey: string): string | null {
  try {
    const row = getDatabase()
      .prepare("SELECT effort FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { effort?: string | null } | undefined;
    return row?.effort ?? null;
  } catch {
    return null;
  }
}

/**
 * Forget the persisted Claude session UUID for a sessionKey. Called when the
 * CLI signals the on-disk session file is gone (missing/corrupted/upgrade) so
 * the next spawn starts fresh with `--session-id` instead of looping on a
 * doomed `--resume`.
 */
function forgetClaudeSessionId(sessionKey: string): void {
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
];

function looksLikeMissingSessionError(stderrChunk: string): boolean {
  return SESSION_NOT_FOUND_PATTERNS.some((p) => p.test(stderrChunk));
}

// ============ DB-driven History Replay (resilience layer) ============

/**
 * Maximum non-system turns to replay when recovering from a lost CLI session.
 * Mirrors codex's CODEX_HISTORY_TURN_CAP — 20 user/assistant turns is enough
 * for the model to pick up context without blowing the context window.
 */
const REPLAY_TURN_CAP = 20;

const REPLAY_CONTEXT_PREFIX = "[Chat messages since your last reply";
const REPLAY_BROWSER_MARKER = /\{\{BROWSER:.*?\}\}/g;
const REPLAY_TOPIC_SWITCH_MARKER = /\{\{TOPIC_SWITCH:[\w-]+\}\}\s*/g;
const REPLAY_TOPIC_NEW_MARKER = /\{\{TOPIC_NEW:[^}]+\}\}\s*/g;

export interface ReplayTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Walk the active branch of the `messages` table for `sessionKey` and return
 * the turns (excluding the very last one, which is the user's brand-new
 * message that the caller is about to send fresh).
 *
 * Why a duplicate-ish helper rather than reusing buildProviderHistory: the
 * provider has no access to the AppContext closure where loadActiveThread
 * lives — and adding a constructor-time DI parameter just for this would
 * ripple through provider/index/createProvider. A direct query against the
 * already-imported `getDatabase()` keeps the resilience layer self-contained.
 */
export function loadActiveBranchForReplay(sessionKey: string): ReplayTurn[] {
  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch {
    return [];
  }

  // Pull every persisted row for this session (skip partial/streaming rows;
  // they'd teach the model that truncation is OK).
  type Row = { id: string; role: string; content: string | null; parent_id: string | null; branch_index: number | null };
  const rows = db
    .prepare(
      `SELECT id, role, content, parent_id, branch_index
       FROM messages
       WHERE session_key = ? AND COALESCE(partial,0) = 0`,
    )
    .all(sessionKey) as Row[];
  if (rows.length === 0) return [];

  // Build parent → children map and walk the active branch from root.
  // For each parent we pick the child whose branch_index matches the
  // active branch row in `active_branches`; absent that, branch 0.
  const childrenOf = new Map<string | "__root__", Row[]>();
  for (const r of rows) {
    const key = r.parent_id ?? "__root__";
    const list = childrenOf.get(key) ?? [];
    list.push(r);
    childrenOf.set(key, list);
  }

  let activeRows: Row[] = [];
  let cursor: string | null = null;
  while (true) {
    const key = cursor ?? "__root__";
    const candidates = childrenOf.get(key) ?? [];
    if (candidates.length === 0) break;
    let chosen: Row | undefined;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      try {
        const lookupKey = cursor ?? "__root__";
        const active = db
          .prepare(
            "SELECT active_branch_index FROM active_branches WHERE parent_id = ? AND session_key = ?",
          )
          .get(lookupKey, sessionKey) as { active_branch_index: number } | undefined;
        const targetIdx = active?.active_branch_index ?? 0;
        chosen =
          candidates.find((c) => (c.branch_index ?? 0) === targetIdx) ?? candidates[0];
      } catch {
        chosen = candidates[0];
      }
    }
    if (!chosen) break;
    activeRows.push(chosen);
    cursor = chosen.id;
  }

  return activeRows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .filter((r) => !(r.content ?? "").startsWith(REPLAY_CONTEXT_PREFIX))
    .map((r) => ({
      role: r.role as "user" | "assistant",
      content: (r.content ?? "")
        .replace(REPLAY_BROWSER_MARKER, "")
        .replace(REPLAY_TOPIC_SWITCH_MARKER, "")
        .replace(REPLAY_TOPIC_NEW_MARKER, "")
        .trim(),
    }))
    .filter((t) => t.content.length > 0)
    // Exclude the last entry — it's the user's just-appended turn that
    // sendChatInternal will dispatch fresh as the new prompt.
    .slice(0, -1);
}

export function hasPriorMessagesInDB(sessionKey: string): boolean {
  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch {
    return false;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE session_key = ? AND role IN ('user','assistant') AND COALESCE(partial,0) = 0`,
    )
    .get(sessionKey) as { n: number } | undefined;
  // > 1 because the user's brand-new turn was just appended; we only need
  // *prior* context, not the message we're about to send.
  return (row?.n ?? 0) > 1;
}

export function renderReplayPrologue(turns: ReplayTurn[]): string {
  const kept = turns.length > REPLAY_TURN_CAP ? turns.slice(-REPLAY_TURN_CAP) : turns;
  const truncated = kept.length < turns.length;
  const lines: string[] = [
    "[The CLI session was reset and lost its memory. Recap of the conversation so far — read carefully, then respond to the new message that follows.]",
    "",
    "<conversation_recap>",
  ];
  if (truncated) {
    lines.push(
      `_(Earlier ${turns.length - kept.length} turns omitted; only the most recent ${kept.length} are shown.)_`,
      "",
    );
  }
  for (const t of kept) {
    if (t.role === "user") {
      lines.push("**User:**", t.content, "");
    } else {
      lines.push("**Assistant:**", t.content, "");
    }
  }
  lines.push("</conversation_recap>", "");
  return lines.join("\n");
}

// ============ Persistent Process ============

interface PersistentProcess {
  proc: ChildProcess;
  readline: Interface;
  createdAt: number;
  lastActivity: number;
  alive: boolean;
  /** Current streaming handler (set during sendChat, null otherwise) */
  streamHandler: StreamHandler | null;
  /** Pending promise resolvers for sendChat */
  pendingResolve: ((result: { runId: string }) => void) | null;
  pendingReject: ((err: Error) => void) | null;
  /** Accumulated full text for onTextDelta */
  fullText: string;
  /** Tool calls announced but not yet resulted. */
  activeToolCalls: Set<string>;
  /** Tool calls that have already had their result emitted — the Claude CLI
   *  re-emits them on every cumulative `assistant` snapshot, so we need a
   *  set to skip duplicates and prevent push-without-dedup downstream. */
  settledToolCalls?: Set<string>;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Per-stream heartbeat interval that re-emits `onSubAgentUpdate` snapshots
   * for any pending Task() parents when no provider event has occurred for
   * ≥ HEARTBEAT_INTERVAL_MS. Prevents the route's stream inactivity timer
   * from firing during long sub-agent tool runs (Bash builds, WebFetch, etc.)
   * where the SDK is silent for minutes by design.
   *
   * Idempotent: emits the LAST KNOWN snapshot, so a client that already
   * rendered the same actions sees no change beyond the keep-alive bump.
   * Cleared on every stream finalization path (done/error/aborted/exit).
   */
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  /** Wall-clock time of the last event emitted to the StreamHandler (text,
   *  tool, sub-agent). Used by the heartbeat to decide whether to fire. */
  lastEventAt: number;
  /**
   * Set when this process was spawned with `--session-id` because the prior
   * `claude_session_id` was either missing on disk or never existed, but the
   * topics-app DB *does* contain prior user/assistant turns for this
   * sessionKey. The next sendChat will prepend a markdown recap so the model
   * doesn't lose the conversation thread. Cleared after one use.
   */
  needsHistoryReplay: boolean;
  /**
   * Sidechain (Task tool sub-agent) tracker. The Claude Code CLI emits
   * sub-agent events with a `parent_tool_use_id` field on the same NDJSON
   * stream as the parent. We intercept those events and aggregate them into
   * the parent Task call's `detail.sub_agent.actions[]` log instead of
   * letting them be silently routed to the parent agent's text/tool
   * handlers. One tracker per process — sub-agents are scoped to a single
   * topic/session so this is the right granularity.
   */
  sidechain: SidechainTracker;
  /**
   * Tool calls that asked the user for input via `AskUserQuestion` /
   * MCP elicitation. Keyed by `tool_use.id`. Each entry pins the
   * sessionKey (for cross-stream lookup from the route handler) and the
   * resolved schema so we can rebuild the WS broadcast if a client
   * reconnects mid-pause. The heartbeat treats these the same as a
   * running Task() parent — keeps the soft timer suspended while we
   * wait for the human.
   *
   * The provider is the source of truth; the route handler queries this
   * map via `resumeWithToolResponse` to validate that a submission
   * matches a still-pending request, then drops the entry once the
   * `tool_result` line is written to stdin.
   */
  pendingInputs: Map<string, { sessionKey: string; schema: import("../types").UserInputSchema; awaitingSince: number }>;
}

// ============ Provider ============

export class ClaudeCodeProvider implements AIProvider {
  readonly name = "claude-code";
  readonly capabilities: Set<ProviderCapability> = new Set([
    "streaming",
    "tools",
    "sessions",
    "abort",
  ]);
  // The CLI is process-resident with its own session state; it does NOT accept
  // an `options.history` field. System blocks are inlined into the user turn
  // as a `<context>...</context>` preamble. See `server/context/adapt.ts`.
  // Behavior preserved verbatim from the previous inline branch in
  // `streamEditResponse` (server/routes/topics.ts).
  readonly contextStrategy = "inline-system" as const;

  private config: ClaudeCodeProviderConfig;
  private processes = new Map<string, PersistentProcess>();
  private queues = new Map<string, Promise<void>>();
  private started = false;

  constructor(config: ClaudeCodeProviderConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.started;
  }

  // --- Lifecycle ---

  start(): void {
    this.started = true;
    console.log("[claude-code] Provider started");
  }

  stop(): void {
    this.started = false;
    for (const [key, pp] of this.processes) {
      console.log(`[claude-code] Shutdown: killing process for ${key}`);
      this.killProcess(pp);
    }
    this.processes.clear();
    this.queues.clear();
    console.log("[claude-code] Provider stopped");
  }

  // --- Streaming Chat ---

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string },
  ): Promise<{ runId?: string }> {
    // Serial queue: prevent concurrent stdin writes per session
    const prev = this.queues.get(sessionKey) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const myTurn = new Promise<void>((r) => { resolveQueue = r; });
    this.queues.set(sessionKey, prev.then(() => myTurn));
    await prev;

    try {
      // Note: per-message `options.model` override is intentionally ignored —
      // claude-code spawns a long-lived child whose --model is set at spawn
      // time. Switching models requires respawning, which we don't do mid-flow.
      // To use a different model, set it as the topic default or in config.
      return await this.sendChatInternal(sessionKey, message, handler);
    } finally {
      resolveQueue();
    }
  }

  private async sendChatInternal(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
  ): Promise<{ runId?: string }> {
    const pp = this.getOrCreateProcess(sessionKey);
    const runId = crypto.randomUUID();

    pp.streamHandler = handler;
    pp.fullText = "";
    pp.activeToolCalls.clear();
    pp.settledToolCalls?.clear();
    // Sidechain state belongs to a single turn — fresh tracker per sendChat
    // so a Task() called in turn N doesn't leak state into turn N+1.
    pp.sidechain.clear();
    // Start the per-turn heartbeat — keep-alives flow only while a stream
    // handler is registered. Cleared in every finalization path below.
    this.startHeartbeat(pp, sessionKey);

    // Resilience: if the process was respawned fresh (e.g. after a doomed
    // `--resume`) and the DB carries prior turns, prepend a markdown recap
    // so the model picks up the conversation thread on its very first stdin
    // write. One-shot — clear the flag so subsequent turns flow normally.
    let outboundMessage = message;
    if (pp.needsHistoryReplay) {
      pp.needsHistoryReplay = false;
      try {
        const replayTurns = loadActiveBranchForReplay(sessionKey);
        if (replayTurns.length > 0) {
          outboundMessage = renderReplayPrologue(replayTurns) + "\n" + message;
          console.log(
            `[claude-code] Injected recap prologue (${replayTurns.length} prior turns) for ${sessionKey}`,
          );
        }
      } catch (err: any) {
        // Replay is best-effort — if the DB is unavailable, fall back to the
        // raw message rather than blocking the user's send.
        console.warn(
          `[claude-code] History replay failed for ${sessionKey}: ${err?.message ?? err}`,
        );
      }
    }

    // Build NDJSON message
    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content: outboundMessage },
    }) + "\n";

    // Set up message timeout. Keep the handle: the race below settles in
    // seconds on a normal turn, and an uncleared 30-min timer would linger for
    // its full window — one per message, so an active session accumulated
    // dozens of pending timers (the complete() path already clears its own).
    let messageTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      messageTimeout = setTimeout(() => reject(new Error("TIMEOUT")), MESSAGE_TIMEOUT_MS);
    });

    const messagePromise = new Promise<{ runId: string }>((resolve, reject) => {
      pp.pendingResolve = resolve;
      pp.pendingReject = reject;
      pp.lastActivity = Date.now();

      if (!pp.alive) {
        reject(new Error("PROCESS_DEAD"));
        return;
      }

      pp.proc.stdin!.write(input);
    });

    try {
      await Promise.race([messagePromise, timeoutPromise]);
      clearTimeout(messageTimeout);
    } catch (err: any) {
      clearTimeout(messageTimeout);
      const errMsg = err?.message ?? "";
      pp.streamHandler = null;
      pp.pendingResolve = null;
      pp.pendingReject = null;
      this.stopHeartbeat(pp);

      // User-initiated abort: `abort()` already invoked `handler.onAborted` and
      // rejected this promise so the serial-queue lock can release. Returning
      // here lets `sendChat`'s `finally` call `resolveQueue()`, unblocking the
      // next `sendChat` for this session. Without this branch a follow-up
      // message hangs on `await prev` until MESSAGE_TIMEOUT_MS (30 min) — the
      // exact symptom of "stop on the tab kills the topic".
      if (errMsg === "ABORTED") {
        return { runId };
      }

      if (errMsg === "TIMEOUT") {
        console.warn(`[claude-code] Message timed out for ${sessionKey}, killing process`);
        this.killProcess(pp);
        this.processes.delete(sessionKey);
        handler.onError("Message timed out after 30 minutes");
        return { runId };
      }

      if (errMsg === "RATE_LIMIT") {
        console.warn(`[claude-code] Rate limited for ${sessionKey}`);
        handler.onError("Rate limited — please try again later");
        return { runId };
      }

      if (errMsg.startsWith("PROCESS_D")) {
        this.processes.delete(sessionKey);
        handler.onError("Process died unexpectedly");
        return { runId };
      }

      handler.onError(errMsg || "Unknown error");
      return { runId };
    }

    // Successful turn — heartbeat is no longer needed; the resolution of
    // messagePromise above means the SDK signaled `result` and the handler
    // already received `onDone`.
    this.stopHeartbeat(pp);
    this.resetInactivityTimer(sessionKey, pp);
    return { runId };
  }

  // --- Non-streaming Completion ---

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    // Build a single prompt from all messages
    const prompt = messages
      .map((m) => {
        if (m.role === "system") return `[System]\n${m.content}`;
        if (m.role === "assistant") return `[Assistant]\n${m.content}`;
        return m.content;
      })
      .join("\n\n");

    const model = this.config.model ?? DEFAULT_MODEL;
    const permissionMode = this.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    // One-shot completions (auto-naming, daily digest, SSE fallback) need NO
    // MCP tools — but `claude` otherwise auto-loads the user's entire global
    // ~/.claude.json fleet (incl chrome-devtools' ~1.2GB Chrome) for a single
    // text completion. Pin an EMPTY strict MCP config so this hot path spawns
    // zero servers. Falls back to legacy (no scoping) only if the temp write
    // fails; the file is removed when the process exits (cleanup below).
    const oneshotKey = `oneshot-${crypto.randomUUID()}`;
    let oneshotMcpArgs: string[] = [];
    try {
      mkdirSync(MCP_CONFIG_DIR, { recursive: true });
      const p = mcpConfigPathForSession(oneshotKey);
      writeFileSync(p, JSON.stringify({ mcpServers: {} }, null, 2), { encoding: "utf-8", mode: 0o600 });
      oneshotMcpArgs = ["--mcp-config", p, "--strict-mcp-config"];
    } catch { /* fall back to no scoping */ }

    const args = [
      "--print",
      "--permission-mode", permissionMode,
      "--verbose",
      "--model", model,
      "--setting-sources", "user,project,local",
      ...oneshotMcpArgs,
      "--output-format", "json",
    ];

    const env = buildSafeEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(resolveCliPath(), args, {
        cwd: workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("Completion timed out"));
      }, MESSAGE_TIMEOUT_MS);

      proc.on("close", (code) => {
        clearTimeout(timer);
        cleanupMcpConfigForSession(oneshotKey);
        if (code !== 0) {
          console.warn(`[claude-code] complete() exited with code ${code}: ${stderr.slice(0, 200)}`);
          resolve({ content: `Error: CLI exited with code ${code}` });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const resultText = parsed.result ?? stdout.trim();
          const usage = parsed.usage;
          resolve({
            content: resultText,
            usage: usage ? {
              promptTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
              completionTokens: usage.output_tokens ?? 0,
            } : undefined,
          });
        } catch {
          resolve({ content: stdout.trim() });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        cleanupMcpConfigForSession(oneshotKey);
        reject(err);
      });

      proc.stdin!.write(prompt);
      proc.stdin!.end();
    });
  }

  // --- Config refresh ---

  /**
   * Force the next turn for `sessionKey` to respawn the CLI child so it picks
   * up a changed per-topic config (migration 033 effort tier — the flags are
   * fixed at spawn time, see `spawnPersistentProcess`). Safe: the respawn uses
   * `--resume`, so the model's memory is reloaded losslessly (identical to an
   * inactivity/crash respawn). No-op while a turn is streaming — killing mid-
   * stream would drop the partial; the change then applies on the next natural
   * respawn instead. Idempotent: nothing to do if no process is pooled.
   */
  refreshSessionConfig(sessionKey: string): void {
    const pp = this.processes.get(sessionKey);
    if (!pp) return;
    if (pp.streamHandler) return; // live turn — apply on next respawn
    console.log(`[claude-code] refreshSessionConfig: dropping idle process for ${sessionKey} to pick up new config`);
    this.killProcess(pp);
    this.processes.delete(sessionKey);
  }

  // --- Abort ---

  async abort(sessionKey: string, _runId?: string): Promise<void> {
    const pp = this.processes.get(sessionKey);
    if (!pp || !pp.alive) return;

    // SIGINT cancels the current turn without killing the process
    try {
      pp.proc.kill("SIGINT");
    } catch {}

    // The aborted turn may have had outstanding human-input requests. Drop
    // them so a stale `POST /api/chat/tool-response` can't write a tool
    // result to a stream that the user just cancelled.
    pp.pendingInputs.clear();

    // Notify the stream handler so the route flushes any partial assistant
    // content as a finalized message instead of an error stub.
    if (pp.streamHandler) {
      pp.streamHandler.onAborted?.();
      pp.streamHandler = null;
    }
    this.stopHeartbeat(pp);

    // Critical: `sendChatInternal` is awaiting a `messagePromise` whose
    // resolve/reject were captured in a closure. Setting `pp.pendingResolve`
    // / `pp.pendingReject` to null on the object does NOT call those captured
    // callbacks — they would stay pending until the 30-minute MESSAGE_TIMEOUT
    // and the per-session serial queue (`this.queues`) would block every
    // follow-up `sendChat` on `await prev`. Reject the captured callback
    // first so the queue's `resolveQueue()` runs in `sendChat`'s `finally`.
    if (pp.pendingReject) {
      const reject = pp.pendingReject;
      pp.pendingResolve = null;
      pp.pendingReject = null;
      reject(new Error("ABORTED"));
    } else {
      pp.pendingResolve = null;
      pp.pendingReject = null;
    }
  }

  // --- Diagnostics ---

  async diagnose(): Promise<ProviderDiagnostic> {
    const requirements: ProviderRequirement[] = [];

    const cliPath = resolveCliPath();
    const probe = await probeBinaryPath(cliPath);
    requirements.push({
      key: "claude-cli",
      label: "Claude Code CLI installed",
      present: probe.available,
      hint: probe.available ? undefined : "Install from https://docs.claude.com/claude-code or run: npm i -g @anthropic-ai/claude-code",
    });

    // Claude Code uses `claude login` (OAuth) — no env key required.
    // Check for a credentials directory under ~/.claude as a best-effort signal.
    const claudeHome = join(process.env.HOME || "", ".claude");
    const hasSession =
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      existsSync(claudeHome);
    requirements.push({
      key: "claude-session",
      label: "Active Claude Code session",
      present: hasSession,
      hint: hasSession ? undefined : "Run in terminal: claude login",
    });

    const allOk = requirements.every((r) => r.present);
    return {
      name: this.name,
      // Missing requirement (CLI not installed, no API key) = unavailable, not error.
      // "error" is reserved for runtime failures with all requirements present.
      status: allOk ? "ready" : "unavailable",
      binaryPath: probe.path,
      version: probe.version,
      requirements,
    };
  }

  async listModels(): Promise<string[]> {
    // Current models the installed CLI accepts (aliases `opus`/`sonnet`/`haiku`/
    // `fable` resolve to these). Full names, not aliases, to match the other
    // providers' id lists and the token-based fast-models/snapshot guard.
    // THIS is the single list to update when Anthropic ships new model names.
    const all = [
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-fable-5",
    ];
    // Surface the configured model first so the snapshot's effective default
    // (clients use models[0]) reflects the user's settings.json choice. We
    // tolerate an unknown model by inserting it at the head — it lets the
    // user pin a future Anthropic model without a code change.
    const preferred = this.config.model;
    if (!preferred) return all;
    const rest = all.filter((m) => m !== preferred);
    return [preferred, ...rest];
  }

  // ============ Process Pool Internals ============

  private getOrCreateProcess(sessionKey: string): PersistentProcess {
    const existing = this.processes.get(sessionKey);
    if (existing && existing.alive) return existing;

    // Clean up dead process
    if (existing) {
      this.killProcess(existing);
      this.processes.delete(sessionKey);
    }

    const pp = this.spawnPersistentProcess(sessionKey);
    this.processes.set(sessionKey, pp);
    return pp;
  }

  private spawnPersistentProcess(sessionKey: string): PersistentProcess {
    const model = this.config.model ?? DEFAULT_MODEL;
    const permissionMode = this.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    // Look up (or create) the persistent Claude CLI session UUID for this
    // sessionKey. On first spawn we use `--session-id` to pin the UUID; on
    // every subsequent spawn (after hot reload, inactivity timeout, lifetime
    // cap, crash) we use `--resume` to reload the session from disk and
    // restore the AI's memory of prior turns.
    const { id: claudeSessionId, isNew: isNewSession } = getOrCreateClaudeSessionId(sessionKey);

    // Generate the per-session MCP config so the CLI can spawn our bridge
    // and surface `mcp__topics__open_browser_pane` as a callable tool. The
    // file path goes into argv as `--mcp-config`; the file lifetime is
    // bounded by `killProcess` below.
    const { path: mcpConfigPath, strict: mcpStrict } = writeMcpConfigForSession(sessionKey);

    const args = [
      "--print",
      "--permission-mode", permissionMode,
      "--verbose",
      "--model", model,
      // Effort tier: a per-topic override (migration 033, set via the picker's
      // effort selector) wins; otherwise match the Warp default ("ultracode" =
      // xhigh). Without this the spawn falls back to settings.json effortLevel
      // (low). Resolved fresh per spawn, so a change respawn picks up the tier.
      ...((): string[] => { const e = resolveClaudeEffort(getTopicEffortForSession(sessionKey)); return e ? ["--effort", e] : []; })(),
      "--setting-sources", "user,project,local",
      "--mcp-config", mcpConfigPath,
      // When we scoped the global fleet into the config above, tell the CLI to
      // use ONLY that set (drops the per-session chrome-devtools Chrome etc.).
      ...(mcpStrict ? ["--strict-mcp-config"] : []),
      // Nudge the agent to launch dev servers via mcp__topics__run_script so they
      // appear in the Processes panel instead of leaking into the bare shell.
      "--append-system-prompt", TOPICS_AGENT_SYSTEM_PROMPT,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      ...(isNewSession ? ["--session-id", claudeSessionId] : ["--resume", claudeSessionId]),
    ];

    console.log(
      `[claude-code] Spawning ${isNewSession ? 'new' : 'resumed'} session for ${sessionKey} (claude_session_id=${claudeSessionId})`
    );

    const env = buildSafeEnv();

    const proc = spawn(resolveCliPath(), args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const rl = createInterface({ input: proc.stdout! });

    // Resilience layer: a fresh `--session-id` spawn is normal for a brand-
    // new topic, but it's *also* what happens after `forgetClaudeSessionId`
    // wipes a doomed `--resume`. If the DB already holds prior turns, we
    // need to recap them in the next stdin write or the model resumes a
    // fresh-feeling conversation that contradicts the visible chat history.
    const needsHistoryReplay = isNewSession && hasPriorMessagesInDB(sessionKey);
    if (needsHistoryReplay) {
      console.log(
        `[claude-code] Session for ${sessionKey} respawned fresh but DB has prior turns — next message will include a recap prologue`,
      );
    }

    const pp: PersistentProcess = {
      proc,
      readline: rl,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      alive: true,
      streamHandler: null,
      pendingResolve: null,
      pendingReject: null,
      fullText: "",
      activeToolCalls: new Set(),
      inactivityTimer: null,
      lifetimeTimer: null,
      heartbeatInterval: null,
      lastEventAt: Date.now(),
      needsHistoryReplay,
      sidechain: new SidechainTracker(),
      pendingInputs: new Map(),
    };

    // --- NDJSON stdout parsing ---
    rl.on("line", (line: string) => {
      try {
        const event = JSON.parse(line);
        this.handleStreamEvent(pp, event);
      } catch {
        // non-JSON line, ignore
      }
    });

    // --- stderr: rate limit + missing-session detection ---
    let stderrBuf = "";
    proc.stderr!.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);

      // Detect on the ACCUMULATED tail, not the single chunk: the CLI can
      // flush an error across multiple write()s, splitting the pattern over
      // two data events — neither chunk alone would match, and a real
      // rate-limit would go undetected until the 30-min hard timeout (or a
      // doomed --resume would retry forever). The 2 KiB cap keeps the scan
      // cheap; both detections are latch-style (idempotent on re-match).
      if (!isNewSession && looksLikeMissingSessionError(stderrBuf)) {
        // The CLI was asked to `--resume` a session that no longer exists on
        // disk. Wipe the DB row so the next spawn falls back to --session-id
        // instead of looping forever on a doomed resume. We don't kill here —
        // the close handler will fire shortly with the non-zero exit code.
        console.warn(
          `[claude-code] Resume failed for ${sessionKey} (claude_session_id=${claudeSessionId}); forgetting and will respawn fresh on next call`
        );
        forgetClaudeSessionId(sessionKey);
      }

      if (
        (stderrBuf.includes("rate_limit") || stderrBuf.includes("429") || /overloaded/i.test(stderrBuf)) &&
        pp.pendingReject
      ) {
        const reject = pp.pendingReject;
        setTimeout(() => {
          if (pp.pendingReject === reject) {
            pp.pendingResolve = null;
            pp.pendingReject = null;
            pp.streamHandler = null;
            reject(new Error("RATE_LIMIT"));
          }
        }, RATE_LIMIT_GRACE_MS);
      }
    });

    // --- Process exit ---
    proc.on("close", (code) => {
      pp.alive = false;
      console.log(`[claude-code] Process exited with code ${code}`);
      if (pp.pendingReject) {
        const reject = pp.pendingReject;
        pp.pendingResolve = null;
        pp.pendingReject = null;
        reject(new Error(`PROCESS_DIED_${code}`));
      }
      if (pp.streamHandler) {
        pp.streamHandler.onError(`Process exited with code ${code}`);
        pp.streamHandler = null;
      }
      this.cleanupTimers(pp);
    });

    proc.on("error", (err) => {
      pp.alive = false;
      console.error(`[claude-code] Process error: ${err.message}`);
      if (pp.pendingReject) {
        const reject = pp.pendingReject;
        pp.pendingResolve = null;
        pp.pendingReject = null;
        reject(err);
      }
      if (pp.streamHandler) {
        pp.streamHandler.onError(err.message);
        pp.streamHandler = null;
      }
      this.cleanupTimers(pp);
    });

    // --- Max lifetime timer ---
    pp.lifetimeTimer = setTimeout(() => {
      console.log("[claude-code] Max lifetime reached, killing process");
      this.killProcess(pp);
      // Find and remove from map
      for (const [key, p] of this.processes) {
        if (p === pp) { this.processes.delete(key); break; }
      }
    }, MAX_LIFETIME_MS);

    return pp;
  }

  // --- NDJSON Event Handling ---

  private handleStreamEvent(pp: PersistentProcess, event: any): void {
    const handler = pp.streamHandler;

    // Filter noise
    if (event.type === "system" || event.type === "rate_limit_event") return;

    // Mark "real activity from provider" — heartbeats consult this to
    // decide whether to fire. Any event that gets past the noise filter
    // counts (assistant text, tool_use, tool_result, sub-agent, result).
    pp.lastEventAt = Date.now();

    // Result event: stream is done for this turn
    if (event.type === "result") {
      const resultText = event.result ?? "";
      if (!resultText || resultText === "waiting for message") return;

      if (handler) {
        const usage = event.usage ?? {};
        const cacheCreation = usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        handler.onDone({
          result: resultText,
          usage: {
            inputTokens: (usage.input_tokens ?? 0) + cacheCreation + cacheRead,
            outputTokens: usage.output_tokens ?? 0,
            cacheCreation: cacheCreation || undefined,
            cacheRead: cacheRead || undefined,
          },
          durationMs: event.duration_ms,
          costUsd: event.total_cost_usd,
        });
        pp.streamHandler = null;
        // Stream finished — drop heartbeat. The sendChatInternal `finally`
        // path also clears it, but doing it here avoids one tick of
        // unnecessary keep-alive between `result` and the await resolution.
        this.stopHeartbeat(pp);
      }

      if (pp.pendingResolve) {
        const resolve = pp.pendingResolve;
        pp.pendingResolve = null;
        pp.pendingReject = null;
        resolve({ runId: "" });
      }
      return;
    }

    // Assistant + user content events.
    // Wire format from `claude --print --output-format stream-json` is:
    //   { type: "assistant", message: { content: [...blocks] }, ... }   ← text/thinking/tool_use
    //   { type: "user",      message: { content: [...blocks] }, ... }   ← tool_result (one per tool)
    // Earlier code read `event.content` directly which is always undefined,
    // so onTextDelta was never fired → fullContent stayed empty → the chat
    // route's finalizeStream("done") emitted the "No response received" stub.
    // Accept both shapes defensively in case a future CLI version flattens it.
    //
    // CRITICAL: we must process `user` events too — the CLI emits
    // tool_result blocks there, NOT inside cumulative assistant snapshots.
    // Without this, every tool stays in `running` until the final `result`
    // event fires the finalize-loop in the route handler, so cascading tools
    // all show a spinner long after they actually finished. The dedup via
    // `pp.settledToolCalls` keeps re-deliveries idempotent.
    // Block shapes the Claude CLI emits inside `message.content`. Marked as
    // discriminated union so the loop below narrows on `type` instead of
    // riding through with `any`.
    type AssistantBlock =
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "tool_use"; id?: string; name: string; input: unknown }
      | { type: "tool_result"; tool_use_id?: string; content: unknown; is_error?: boolean }
      | { type: string; [k: string]: unknown };
    const eventContent: AssistantBlock[] | null =
      (event.type === "assistant" || event.type === "user")
        ? (Array.isArray(event.message?.content) ? (event.message.content as AssistantBlock[])
            : Array.isArray(event.content) ? (event.content as AssistantBlock[])
            : null)
        : null;

    // ── Sub-agent (Task tool) sidechain detection ──
    // Claude Code marks events emitted by a sub-agent with a top-level
    // `parent_tool_use_id` field naming the parent Task() call. We route
    // those events to the SidechainTracker, accumulate them as actions on
    // the parent's `detail.sub_agent.actions[]`, and emit a single
    // `onSubAgentUpdate` for each child event so the UI shows the parent
    // Task row live-growing instead of a black box. The events are NOT
    // forwarded to onTextDelta/onToolStart — they belong to a different
    // logical agent and would otherwise pollute the parent's text and
    // double-count tool calls.
    const parentToolUseId =
      typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id
        ? event.parent_tool_use_id
        : null;
    if (parentToolUseId && eventContent && handler) {
      // Lazy registration: sub-agent emits before the parent tool_use block
      // arrives in the cumulative snapshot can happen on the very first
      // sidechain event. Register a placeholder so events aren't dropped;
      // the real input fields are filled when the parent tool_use shows up
      // in a later non-sidechain `assistant` event.
      if (!pp.sidechain.has(parentToolUseId)) {
        pp.sidechain.registerParent(parentToolUseId, {});
      }
      for (const block of eventContent) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          pp.sidechain.recordChildText(parentToolUseId, block.text);
        } else if (block.type === "tool_use") {
          const childId = typeof block.id === "string" ? block.id : crypto.randomUUID();
          pp.sidechain.recordChildToolUse(parentToolUseId, childId, String(block.name ?? ""), block.input);
        } else if (block.type === "tool_result") {
          const childId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          if (childId) {
            const result = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            pp.sidechain.recordChildToolResult(childId, result, block.is_error === true);
          }
        }
        // thinking blocks: ignore (not surfaced in sub-agent action log)
      }
      const snap = pp.sidechain.snapshot(parentToolUseId);
      if (snap && handler.onSubAgentUpdate) {
        handler.onSubAgentUpdate(parentToolUseId, {
          subAgentType: snap.subAgentType,
          description: snap.description,
          actions: snap.actions,
          finished: snap.finished,
          result: snap.fullText || undefined,
        });
      }
      return; // sidechain events do NOT also fire parent text/tool callbacks
    }

    if (eventContent && handler) {
      // The Claude CLI emits cumulative `assistant` events: each event's
      // `message.content` is a snapshot containing ALL blocks accumulated so
      // far, NOT a delta. Iterating naively re-fires onToolStart /
      // onToolResult for blocks already announced — produces duplicate
      // ToolCall entries on the message (push-without-dedup downstream),
      // and the duplicates stay in `running` forever because
      // updateToolCallResult only patches the first match by id. Symptom:
      // tool spinner never clears.
      //
      // Dedup by tracking which tool_use ids we've already announced
      // (`pp.activeToolCalls`) and which we've already settled
      // (`pp.settledToolCalls`). Both are per-process-instance Sets.
      const settled = (pp.settledToolCalls ??= new Set<string>());
      for (const block of eventContent) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          pp.fullText += block.text;
          handler.onTextDelta(block.text, pp.fullText);
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          handler.onThinkingDelta?.(block.thinking);
        } else if (block.type === "tool_use") {
          const toolId = (typeof block.id === "string" ? block.id : null) ?? crypto.randomUUID();
          if (pp.activeToolCalls.has(toolId) || settled.has(toolId)) continue;
          pp.activeToolCalls.add(toolId);
          // Sidechain bookkeeping: if this is a Task() call, register it as a
          // sub-agent parent so its child events get aggregated. We do this
          // before onToolStart so the route handler sees the right state if
          // it queries the tracker.
          const toolName = String(block.name ?? "");
          if (toolName === "Task") {
            pp.sidechain.registerParent(toolId, block.input);
          }
          handler.onToolStart(toolId, toolName, block.input as Record<string, unknown> | undefined);
          // Detect "I am asking the user a question" tools (AskUserQuestion,
          // MCP elicitation). When matched, the CLI is now sitting on its
          // stdin waiting for a `tool_result` line; the route handler must
          // pause the soft inactivity timer, broadcast the form schema, and
          // wait for `POST /api/chat/tool-response`. We surface the request
          // via the optional `onUserInputRequired` callback so the route can
          // also stamp the corresponding `ToolCall.status` to
          // `waiting_for_input`.
          {
            const schema = detectUserInputRequest({ name: toolName, input: block.input });
            if (schema) {
              const sessionKey = this.findSessionKeyForProcess(pp);
              if (sessionKey) {
                pp.pendingInputs.set(toolId, { sessionKey, schema, awaitingSince: Date.now() });
              }
              handler.onUserInputRequired?.(toolId, toolName, schema);
            }
          }
        } else if (block.type === "tool_result") {
          const toolId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          if (!toolId || settled.has(toolId)) continue;
          const resultContent = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          // Propagate the SDK's `is_error` flag so the route can persist
          // status='error' and the UI renders red ✗ instead of green ✓.
          // Claude Code emits `is_error: true` on tool results whose tool
          // returned a failure (Bash exit≠0, Read on missing file, WebFetch
          // 4xx/5xx, etc.). Without this every failed tool reports as success.
          const isError = block.is_error === true;

          // Sidechain finalization: a tool_result whose tool_use_id matches a
          // tracked parent Task() means the sub-agent finished. Emit one last
          // onSubAgentUpdate snapshot with finished=true and the actual result
          // body before the standard onToolResult path runs (so the parent
          // Task row also gets its terminal `success`/`error` from below).
          if (pp.sidechain.has(toolId) && handler.onSubAgentUpdate) {
            const finalSnap = pp.sidechain.finish(toolId, resultContent);
            if (finalSnap) {
              handler.onSubAgentUpdate(toolId, {
                subAgentType: finalSnap.subAgentType,
                description: finalSnap.description,
                actions: finalSnap.actions,
                finished: true,
                result: finalSnap.fullText || resultContent,
              });
            }
            pp.sidechain.delete(toolId);
          }
          handler.onToolResult(toolId, resultContent, isError);
          pp.activeToolCalls.delete(toolId);
          settled.add(toolId);
        }
      }
    }
  }

  // --- Timer Management ---

  private cleanupTimers(pp: PersistentProcess): void {
    if (pp.inactivityTimer) { clearTimeout(pp.inactivityTimer); pp.inactivityTimer = null; }
    if (pp.lifetimeTimer) { clearTimeout(pp.lifetimeTimer); pp.lifetimeTimer = null; }
    this.stopHeartbeat(pp);
  }

  /**
   * Start the per-stream sub-agent heartbeat. Runs every HEARTBEAT_TICK_MS
   * (10s). On each tick, if (a) the provider has had no events for
   * ≥ HEARTBEAT_QUIET_MS (30s) AND (b) at least one Task() parent is still
   * pending, re-emit the last snapshot for each pending parent. The route's
   * `onSubAgentUpdate` handler resets its own inactivity timer on receipt,
   * so this is enough to keep the route alive during long sub-agent waits.
   *
   * Snapshot is identical to the last persisted one — the UI dedupes on
   * `actions.length` and content offsets, so the user sees nothing.
   */
  private startHeartbeat(pp: PersistentProcess, sessionKey: string): void {
    this.stopHeartbeat(pp); // idempotent
    pp.lastEventAt = Date.now();
    pp.heartbeatInterval = setInterval(() => {
      try {
        const handler = pp.streamHandler;
        if (!handler || !handler.onSubAgentUpdate) return;
        if (Date.now() - pp.lastEventAt < HEARTBEAT_QUIET_MS) return;
        const pending = pp.sidechain.listPendingParents();
        if (pending.length === 0) return;
        for (const parentId of pending) {
          const snap = pp.sidechain.snapshot(parentId);
          if (!snap) continue;
          handler.onSubAgentUpdate(parentId, {
            subAgentType: snap.subAgentType,
            description: snap.description,
            actions: snap.actions,
            finished: snap.finished,
            result: snap.fullText || undefined,
          });
        }
        // Note: do NOT bump lastEventAt — these are heartbeats, not real
        // events. We want the next real event to still mark "fresh data".
        // The route side sees the snapshot and resets its inactivity timer,
        // which is the whole point.
        if (process.env.DEBUG_CLAUDE_CODE) {
          console.log(`[claude-code] heartbeat: ${pending.length} pending parent(s) for ${sessionKey}`);
        }
      } catch (err) {
        console.warn("[claude-code] heartbeat error:", (err as Error)?.message || err);
      }
    }, HEARTBEAT_TICK_MS);
  }

  private stopHeartbeat(pp: PersistentProcess): void {
    if (pp.heartbeatInterval) {
      clearInterval(pp.heartbeatInterval);
      pp.heartbeatInterval = null;
    }
  }

  private resetInactivityTimer(key: string, pp: PersistentProcess): void {
    if (pp.inactivityTimer) clearTimeout(pp.inactivityTimer);
    pp.inactivityTimer = setTimeout(() => {
      console.log(`[claude-code] Inactivity timeout for ${key}`);
      this.killProcess(pp);
      this.processes.delete(key);
    }, INACTIVITY_TIMEOUT_MS);
  }

  private killProcess(pp: PersistentProcess): void {
    pp.alive = false;
    this.cleanupTimers(pp);
    try { pp.readline.close(); } catch {}
    try { pp.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { pp.proc.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
    // Best-effort cleanup of the per-session MCP config file. Doesn't block
    // the kill — if removal fails (file already gone, fs error), the next
    // spawn for the same sessionKey will overwrite the path anyway.
    const sk = this.findSessionKeyForProcess(pp);
    if (sk) cleanupMcpConfigForSession(sk);
  }

  /**
   * Reverse lookup: given a PersistentProcess, find the sessionKey under
   * which it was registered in `this.processes`. Used by the
   * `tool_use` detector path which only has the `pp` in scope.
   */
  private findSessionKeyForProcess(pp: PersistentProcess): string | null {
    for (const [key, value] of this.processes) {
      if (value === pp) return key;
    }
    return null;
  }

  /**
   * Resume a paused turn by writing the user's tool answer to the CLI's
   * stdin in the stream-json input format the CLI already accepts (same
   * shape `sendChat` uses for normal user messages, but `content` is a
   * single `tool_result` block instead of a string).
   *
   * Idempotent on the absence side: if no pending input matches the
   * (sessionKey, toolCallId) pair we throw — the route handler should
   * have validated already. If the process is dead we also throw so the
   * caller fails the tool fast.
   */
  async resumeWithToolResponse(
    sessionKey: string,
    toolCallId: string,
    response: import("../types").ToolUserResponse,
  ): Promise<void> {
    const pp = this.processes.get(sessionKey);
    if (!pp || !pp.alive) {
      throw new Error(`claude-code: no live process for ${sessionKey}`);
    }
    const pending = pp.pendingInputs.get(toolCallId);
    if (!pending) {
      throw new Error(`claude-code: no pending input for tool ${toolCallId}`);
    }

    // Serialise the answer to plain text the model can read in the
    // tool_result block. `questions` → JSON-encoded answers map (mirrors
    // the SDK's own format when AskUserQuestion runs in the official
    // Claude Code UI). `elicitation` → JSON-encoded value. `raw` → the
    // verbatim string.
    let serialized: string;
    switch (response.kind) {
      case "questions":
        serialized = JSON.stringify({
          answers: response.answers,
          ...(response.metadata ? { metadata: response.metadata } : {}),
        });
        break;
      case "elicitation":
        serialized = JSON.stringify(response.value);
        break;
      case "raw":
        serialized = response.text;
        break;
      default: {
        // Exhaustiveness check — narrows `response` to `never`.
        const _never: never = response;
        throw new Error(`unreachable: ${String(_never)}`);
      }
    }

    const input =
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolCallId,
              content: [{ type: "text", text: serialized }],
              is_error: false,
            },
          ],
        },
      }) + "\n";

    pp.lastActivity = Date.now();
    pp.lastEventAt = Date.now();
    pp.pendingInputs.delete(toolCallId);

    try {
      pp.proc.stdin!.write(input);
    } catch (err: any) {
      // Restore the entry so a retry from the route can succeed if the
      // stdin transient hiccups (rare; mostly here as defence-in-depth).
      pp.pendingInputs.set(toolCallId, pending);
      throw new Error(`claude-code: stdin write failed — ${err?.message ?? err}`);
    }
  }
}
