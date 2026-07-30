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
import { getAiBridgeClient, type AiBridgeClient } from "../lib/ai-bridge-client";
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
import { parseCompactBoundary } from "./claude/compaction";
import { TOPICS_AGENT_SYSTEM_PROMPT, resolveClaudeEffort } from "../lib/topics-agent-prompt";
import { detectUserInputRequest } from "./ask-user-detector";
import { cancelled, classifyResultEvent } from "./stop-reason";
import { contextTokensFromUsage } from "../usage/usage-update";
import { warnThrottled } from "../lib/warn-throttled";
import { clearSessionCliPid, setSessionCliPid } from "./session-pids";
import { discoverClaudeModels } from "./claude-models";

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
// Finestra di accorpamento degli aggiornamenti di sub-agent. 150 ms non si
// percepiscono su una lista che si allunga, e tolgono il grosso dei fotogrammi
// in una raffica di azioni.
const SUBAGENT_COALESCE_MS = 150;

// Throttle for provisional partial-input emits (filename/command surfaced +
// route timer keep-alive) while a `--include-partial-messages` tool input
// streams. 500ms is imperceptible to the reader but bounds the broadcast rate
// on a large Write/Edit input to ~2/s.
const PARTIAL_ARGS_EMIT_MS = 500;

// Primary input fields, in priority order — the ONE thing worth surfacing on a
// tool row before its full input finishes streaming (the file being written,
// the command being run, the URL being fetched). Matched against the still-
// incomplete input-JSON buffer, so only a FULLY received quoted value counts.
const PARTIAL_PRIMARY_KEYS = ["file_path", "filePath", "path", "command", "cmd", "url", "pattern", "query"] as const;

/**
 * Pull the first fully-received primary field from a partial input-JSON buffer.
 * The regex only matches a complete `"key":"value"` (closing quote present), so
 * a value still mid-stream is ignored until done — no garbage on the row. In
 * Write/Edit/Bash the primary key streams first, so this surfaces the target
 * within moments of the input starting.
 */
function extractPrimaryToolArg(buf: string): { key: string; value: string } | null {
  for (const key of PARTIAL_PRIMARY_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = re.exec(buf);
    if (m) {
      try {
        return { key, value: JSON.parse(`"${m[1]}"`) as string };
      } catch {
        return { key, value: m[1] };
      }
    }
  }
  return null;
}

// ============ CLI Path Resolution ============

const CLI_VERSIONS_DIR = join(process.env.HOME || "", ".local/share/claude/versions");

function resolveCliPath(): string {
  // Explicit pin (operators / the ai-bridge restart-survival E2E, which points
  // this at a fake stream-json CLI). Wins over version scanning when set.
  const override = process.env.TOPICS_CLAUDE_CLI_PATH;
  if (override) return override;
  // Scan for latest installed version
  try {
    const versions = readdirSync(CLI_VERSIONS_DIR)
      .filter((f) => /^\d/.test(f))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length > 0) return `${CLI_VERSIONS_DIR}/${versions[0]}`;
  } catch (err) {
    // Load-bearing: a versions dir that EXISTS but can't be read (permissions /
    // corruption) silently drops us to PATH `claude`, which may be the wrong or
    // a missing binary. The normal "not installed" case (dir absent) stays quiet.
    if (existsSync(CLI_VERSIONS_DIR)) {
      warnThrottled("resolveCliPath:versions", `[ClaudeCode] Could not read CLI versions dir ${CLI_VERSIONS_DIR}, falling back:`, err);
    }
  }

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
//
const DEFAULT_DENY_MCP = new Set(["chrome-devtools"]);

/**
 * Server che si RIAVVIANO a ogni spawn non entrano in una sessione di lavoro
 * lunga — e la regola è strutturale, non una lista di nomi.
 *
 * Un server `stdio` lanciato con `npx -y <pkg>` (o `npm exec -y`, o `bunx`)
 * risolve e scarica il pacchetto a ogni avvio: è cold-boot per costruzione, ed è
 * fragile per la stessa ragione. Quando quel processo cade, la CLI toglie i suoi
 * tool dallo schema e poi li rimette — e ogni giro cambia il PREFISSO del prompt.
 * Un prefisso che cambia va riscritto in cache per intero, e in una sessione
 * agentica la cache è il 96% del volume letto.
 *
 * Misurato sul transcript armonia-site (275 risposte): 8 richieste — il 2,9% —
 * portano l'85% di TUTTE le scritture di cache della sessione, 1,97M token per
 * ~$20-33. Sono le 8 che seguono una rimozione di tool-set, e il server che si
 * muoveva era `wigolo` (`npx -y wigolo`), l'unico dei globali che soddisfa questa
 * regola: gli altri sono `http` (nessun boot) o `node` su un path locale.
 *
 * Le chat non perdono niente di unico: la ricerca web resta con `exa` (http) e i
 * WebSearch/WebFetch nativi. Per rimettere un server escluso da questa regola:
 * `TOPICS_SESSION_MCP_ALLOW="wigolo,…"` (l'allowlist ha la precedenza) oppure
 * `TOPICS_SESSION_MCP_COLDBOOT_OK=1` per disattivare la regola in blocco.
 */
export function isColdBootServer(def: unknown): boolean {
  if (!def || typeof def !== "object") return false;
  const d = def as { type?: string; command?: string; args?: unknown };
  // Solo stdio: un server http non ha un processo da far ripartire.
  if (d.type && d.type !== "stdio") return false;
  const cmd = (d.command || "").split("/").pop() || "";
  if (!/^(npx|bunx|pnpx)$/.test(cmd) && !(cmd === "npm" && Array.isArray(d.args) && d.args.includes("exec"))) {
    return false;
  }
  // `npx pkg` senza `-y` si ferma a chiedere conferma e non parte affatto: è il
  // flag di auto-conferma che rende il download silenzioso, e quindi ripetibile.
  const args = Array.isArray(d.args) ? d.args.map(String) : [];
  return args.includes("-y") || args.includes("--yes");
}

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
  const coldBootOk = process.env.TOPICS_SESSION_MCP_COLDBOOT_OK === "1";
  const droppedForColdBoot: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(global)) {
    if (name === "topics") continue; // our bridge is added explicitly below
    if (allow.length > 0) {
      if (allow.includes(name)) out[name] = def;
    } else if (deny.has(name)) {
      // già escluso per nome
    } else if (!coldBootOk && isColdBootServer(def)) {
      // Escluso dalla regola, non da una lista: vedi `isColdBootServer`.
      droppedForColdBoot.push(name);
    } else {
      out[name] = def;
    }
  }
  // Mai un'esclusione silenziosa: un tool che manca senza spiegazione è
  // indistinguibile da un bug, e si finisce a cercarlo nel posto sbagliato.
  if (droppedForColdBoot.length > 0) {
    console.log(
      `[claude-code] MCP esclusi perché si riavviano a ogni spawn (invalidano la cache del prompt): ` +
        `${droppedForColdBoot.join(", ")} — per rimetterli: TOPICS_SESSION_MCP_ALLOW="${droppedForColdBoot.join(",")}" ` +
        `oppure TOPICS_SESSION_MCP_COLDBOOT_OK=1`,
    );
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
export function topicsMcpBridgeSpec(sessionKey: string, profile?: string): { command: string; args: string[] } {
  return {
    command: process.execPath, // bun
    args: [
      "run",
      MCP_SERVER_SCRIPT,
      `--base-url=${topicsAppBaseUrl()}`,
      `--session-key=${sessionKey}`,
      // Tool profile: "dispatch" trims the bridge to what a board agent needs
      // (task tools + browser verification + processes) — fewer tool schemas
      // in the agent's per-call context. Absent = full toolset (interactive).
      ...(profile ? [`--profile=${profile}`] : []),
      ...(process.env.GATEWAY_TOKEN ? [`--gateway-token=${process.env.GATEWAY_TOKEN}`] : []),
    ],
  };
}

export function writeMcpConfigForSession(
  sessionKey: string,
  opts?: { mcpPolicy?: string | null },
): { path: string; strict: boolean } {
  try {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  } catch { /* race-tolerant */ }
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

/** Read-only lookup of a session's claude_session_id (never INSERTs). Used by
 *  reattach, which must not conjure a row for a session it's only adopting. */
function peekClaudeSessionId(sessionKey: string): string | null {
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
function getTopicSpawnOverridesForSession(sessionKey: string): { effort: string | null; model: string | null; mcpPolicy: string | null } {
  try {
    const row = getDatabase()
      .prepare("SELECT effort, model, provider, mcp_policy FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { effort?: string | null; model?: string | null; provider?: string | null; mcp_policy?: string | null } | undefined;
    if (!row) return { effort: null, model: null, mcpPolicy: null };
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
    return { effort: row.effort ?? null, model, mcpPolicy: row.mcp_policy ?? null };
  } catch {
    return { effort: null, model: null, mcpPolicy: null };
  }
}

/**
 * Resolve the OS working directory for a session's spawn, mirroring the
 * `ctx.resolveTopicCwd` precedence (a ready worktree's absPath, else the
 * topic's projectPath) directly from the DB — the provider module can't reach
 * the ctx closure. Returns null when the topic has no bound dir or the
 * resolved path is missing, so the caller falls back to defaultWorkspace/HOME.
 *
 * WHY this matters (2026-07-18): the CLI child spawns with THIS cwd, and the
 * agent's relative-path tools (Bash/Glob/Grep) resolve against it. We used to
 * spawn EVERY session in HOME and rely on the "You are working in <path>"
 * awareness block alone. For a plain interactive project chat that diverges:
 * asked to "analizza tutta la repository", the agent — sitting in HOME — ran
 * `find ~/Projects`, wandered into the WRONG repo, and piled up 60s no-data
 * timeouts (the "chat keeps freezing" report). Aligning the OS cwd with
 * resolveTopicCwd removes the divergence; for worktree-bound board agents the
 * cwd now equals the isolated worktree the awareness block already names.
 */
export function getTopicWorkspaceForSession(sessionKey: string): string | null {
  try {
    const row = getDatabase()
      .prepare(
        `SELECT t.project_path AS projectPath, w.abs_path AS wtAbs, w.status AS wtStatus
         FROM topics t LEFT JOIN worktrees w ON w.id = t.worktree_id
         WHERE t.session_key = ? LIMIT 1`,
      )
      .get(sessionKey) as { projectPath?: string | null; wtAbs?: string | null; wtStatus?: string | null } | undefined;
    if (!row) return null;
    // A ready worktree wins — same precedence as resolveTopicCwd, and it matches
    // the path the awareness block already tells the agent to work in.
    if (row.wtAbs && row.wtStatus === "ready" && existsSync(row.wtAbs)) return row.wtAbs;
    // Otherwise the project checkout. Expand a leading ~ like resolveProjectPath.
    let p = row.projectPath ?? "";
    if (!p) return null;
    if (p.startsWith("~")) {
      const home = process.env.HOME;
      if (!home) return null;
      p = p.replace(/^~/, home);
    }
    // Guard existence: spawning with a stale/missing cwd throws → fall back.
    return existsSync(p) ? p : null;
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
  // The CLI's exact stream-json phrasing when `--resume <id>` finds nothing:
  // reported as an `error_during_execution` result frame on stdout.
  /no conversation found with session id/i,
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
    // Both annotated on purpose: `cursor` is reassigned from `chosen.id` at the
    // bottom of this loop, so under `noImplicitAny` tsc sees key → candidates →
    // chosen → cursor → key and gives up (TS7022, "referenced in its own
    // initializer"). Naming the types cuts the cycle; they are what the map
    // already declares.
    const key: string = cursor ?? "__root__";
    const candidates: Row[] = childrenOf.get(key) ?? [];
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

/**
 * Restart/crash survival: route persistent stream-json sessions through the
 * detached ai-bridge daemon so a turn survives a server restart AND crash
 * (mid-turn reattach) instead of being cut and burning a retry.
 *
 * DEFAULT ON where it works, not behind an opt-in flag. The one hard constraint
 * is transport: the broker talks over a UNIX DOMAIN SOCKET (`net.connect` on a
 * `.sock` path), which Windows doesn't support (it needs named pipes), so it
 * stays OFF on win32 — there the direct child_process.spawn path runs
 * byte-identically. Explicit override wins on any platform: TOPICS_AI_BRIDGE=1
 * forces on, =0 forces off. See server/ai-bridge.mjs + ai-bridge-client.
 */
const USE_AI_BRIDGE = process.env.TOPICS_AI_BRIDGE === "1"
  || (process.env.TOPICS_AI_BRIDGE !== "0" && process.platform !== "win32");

/** Whether chat children run in the detached ai-bridge daemon (broker mode).
 *  Exported for the server's boot sweep that re-adopts surviving chat turns. */
export function aiBridgeEnabled(): boolean {
  return USE_AI_BRIDGE;
}

/**
 * The stdin/signal/kill surface of a session — the ONLY child-coupled operations
 * left after the pool state (streamHandler, pending promises, tool state, timers)
 * was made transport-agnostic. Direct mode drives the spawned child's pipes;
 * broker mode drives the daemon over the socket. Everything else (stdout parsing,
 * stderr scan, close handling) is shared via the extracted methods.
 */
interface SessionIO {
  writeStdin(data: string): void;
  signal(sig: string): void;
  kill(): void;
}

function directIO(proc: ChildProcess): SessionIO {
  return {
    writeStdin: (data) => { try { proc.stdin?.write(data); } catch { /* PROCESS_DEAD handled by callers */ } },
    signal: (sig) => { try { proc.kill(sig as NodeJS.Signals); } catch { /* already gone */ } },
    kill: () => {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
    },
  };
}

function brokerIO(client: AiBridgeClient, sessionKey: string): SessionIO {
  return {
    writeStdin: (data) => client.write(sessionKey, data),
    signal: (sig) => client.signal(sessionKey, sig),
    kill: () => client.kill(sessionKey),
  };
}

interface PersistentProcess {
  /** Set in DIRECT mode only (the spawned child); null in broker mode. */
  proc: ChildProcess | null;
  /** stdout line parser — over proc.stdout (direct) or a PassThrough fed by the
   *  broker's `data` frames (broker). null only transiently during construction. */
  readline: Interface | null;
  /** stdin/signal/kill surface — direct child pipes or broker socket RPCs. */
  io: SessionIO;
  /** Resolves when the child is up (broker: spawn ack; direct: immediately).
   *  The first stdin write awaits this so a write never races ahead of spawn. */
  ready: Promise<void>;
  /** The topics sessionKey (also the broker session id). */
  sessionKey: string;
  /** Byte cursor consumed from the broker store (for reattach). Direct: unused. */
  consumedOffset: number;
  /** True while replaying buffered NDJSON on reattach — suppresses live-only
   *  client side effects (onUserInputRequired) while in-memory state rebuilds. */
  replaySilent?: boolean;
  /** True during reattach's SCAN pass: every handler emission is suppressed
   *  and only the store's tail shape is recorded (see fields below). A broker
   *  store spans the child's LIFETIME — multiple turns — so replaying it
   *  unmuted from 0 both re-streams old turns into the fresh bubble AND lets
   *  an OLD turn's `result` null the handler, misclassifying an open turn as
   *  "completed" (observed live: the adopted turn kept running headless). */
  replayMute?: boolean;
  /** Scan outcome: true when meaningful events follow the last `result` in
   *  the store — i.e. a turn is in flight. */
  replayTailOpen?: boolean;
  /** Scan outcome: the last replayed `result` event (delivered synthetically
   *  through onDone when the turn completed while we were detached). */
  replayLastResult?: unknown;
  /** Scan outcome: consumed-store offset right after the last `result` —
   *  where the LIVE second attach starts so old turns are never re-emitted. */
  replayAfterLastResultOffset?: number;
  /** Accumulated stderr tail for the rate-limit / missing-session scan. */
  stderrBuf: string;
  /** Spawn-time facts the stderr scan + reattach need. */
  spawnMeta: { claudeSessionId: string; isNewSession: boolean };
  createdAt: number;
  lastActivity: number;
  alive: boolean;
  /** Set by abort() before it SIGINTs the child, so the subsequent process
   *  exit is recognised as a user-requested stop (a clean end, NOT a crash) —
   *  the CLI exits code 0 on SIGINT, and without this flag onSessionClosed
   *  surfaced it as "⚠️ Process exited with code 0". */
  aborting?: boolean;
  /** Who asked for the abort — "user" (default) or "watchdog" (stream
   *  timeout). Only affects the exit log label so a watchdog kill is never
   *  misread as the human pressing stop. */
  abortReason?: "user" | "watchdog";
  /** Set when a `--resume` failed because the session is gone (we've already
   *  forgotten it, next spawn is fresh). The turn can't finish, but it's a
   *  recoverable reset — onSessionClosed surfaces a clear "resend" note instead
   *  of a raw "Process exited with code N". */
  recovering?: boolean;
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
  /** In-flight tool inputs from `--include-partial-messages` stream_events,
   *  keyed by content-block index: id/name captured at content_block_start,
   *  `buf` accumulates input_json_delta.partial_json until block stop.
   *  `lastEmitAt`/`emittedPrimary` throttle the provisional filename/command
   *  emit + timer keep-alive during a long input stream. */
  streamingToolInputs?: Map<number, { id: string; name: string; buf: string; lastEmitAt?: number; emittedPrimary?: string }>;
  /** Tool ids whose COMPLETE input has been delivered (onToolArgsUpdate fired
   *  or announced directly with full args). Keeps the late-args path
   *  idempotent across block stop + every cumulative snapshot re-emission. */
  argsFinalized?: Set<string>;
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
  /**
   * Accorpamento degli aggiornamenti di sub-agent, per parent tool_use_id.
   *
   * Ogni azione di un sub-agent faceva partire tre operazioni O(n) sull'INTERO
   * elenco delle azioni: la copia profonda in `sidechain.snapshot()`, una
   * scrittura su DB del `detail` completo e un broadcast del medesimo. Con il
   * tetto di 200 azioni sono ~20.100 elementi copiati, riscritti e spediti per
   * una sola invocazione di Task() — quadratico in qualcosa che l'utente vede
   * come una lista che si allunga.
   *
   * Il contenuto e' uno SNAPSHOT, non un delta: il renderer collassa per
   * `callId` e mostra sempre l'ultimo stato, quindi i fotogrammi intermedi sono
   * scartabili per costruzione. Qui se ne emette al piu' uno ogni
   * SUBAGENT_COALESCE_MS, con il bordo di CODA — se un aggiornamento viene
   * saltato, un timer garantisce che l'ultimo stato arrivi comunque entro la
   * finestra, invece di restare fermo fino al prossimo evento (o ai 30s del
   * heartbeat).
   */
  subAgentEmit: Map<string, { lastAt: number; timer: ReturnType<typeof setTimeout> | null }>;
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

/**
 * Parse the stdout of a `claude --print --output-format json` one-shot into a
 * CompletionResult. Handles BOTH shapes: the single result object, and the
 * full event ARRAY that `--verbose` used to switch on (the result then lives
 * in the final `{type:"result"}` event). NEVER falls back to the raw JSON as
 * "the completion": that poisoned every downstream parser — the model-picker
 * read `haiku` out of the init event's model id and routed real tasks to
 * haiku. Missing result ⇒ empty content, so callers engage their own
 * fallbacks (the picker's is opus). Non-JSON stdout is passed through as
 * plain text (the CLI answered without the json wrapper).
 */
export function parseCompletionStdout(stdout: string): CompletionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { content: stdout.trim() };
  }
  const resultEvent: any = Array.isArray(parsed)
    ? parsed.find((e: any) => e?.type === "result")
    : parsed;
  const content = typeof resultEvent?.result === "string" ? resultEvent.result : "";
  if (!content) {
    console.warn(`[claude-code] complete(): no result text in CLI json output (${stdout.slice(0, 80)}…)`);
  }
  const usage = resultEvent?.usage;
  return {
    content,
    usage: usage ? {
      promptTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      completionTokens: usage.output_tokens ?? 0,
    } : undefined,
  };
}

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
  /** Unsubscribe for the broker reconnect hook armed in start(). */
  private unsubscribeReconnect: (() => void) | null = null;

  constructor(config: ClaudeCodeProviderConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.started;
  }

  // --- Lifecycle ---

  start(): void {
    this.started = true;
    // A dropped broker socket takes every attachment with it (the daemon wipes
    // the closed socket from each session's `attached` map). The children keep
    // running and keep writing to their stores, so nothing looks wrong — the
    // turns simply never end again. `onReconnect` existed for exactly this and
    // had no subscriber; this is it.
    if (USE_AI_BRIDGE) {
      try {
        this.unsubscribeReconnect = getAiBridgeClient().onReconnect(() => {
          const live = [...this.processes.keys()].filter((k) => this.processes.get(k)?.alive);
          if (live.length === 0) return;
          console.warn(`[claude-code] Broker socket reconnected — re-attaching ${live.length} live session(s)`);
          for (const key of live) {
            this.resyncStream(key).catch((err) => console.warn(`[claude-code] Re-attach after reconnect failed for ${key}:`, err));
          }
        });
      } catch (err) {
        console.warn("[claude-code] Could not arm the broker reconnect hook:", err);
      }
    }
    console.log("[claude-code] Provider started");
  }

  stop(): void {
    this.started = false;
    if (this.unsubscribeReconnect) { this.unsubscribeReconnect(); this.unsubscribeReconnect = null; }
    for (const [key, pp] of this.processes) {
      if (USE_AI_BRIDGE && pp.alive) {
        // The child lives in the DETACHED ai-bridge daemon and must SURVIVE a
        // graceful shutdown/hot-reload (mirror of disconnectBridge() for PTY
        // sessions). Killing it here — the pre-broker behavior — was exactly
        // what murdered every in-flight chat turn on each start-prod
        // hot-reload. Drop only our attachment: the next server process
        // re-adopts an in-flight turn via reattach() (boot sweep in
        // server.ts), and an idle child is resumed by the next sendChat's
        // idempotent broker spawn.
        console.log(`[claude-code] Shutdown: detaching broker session for ${key} (child stays alive)`);
        this.cleanupTimers(pp);
        try { getAiBridgeClient().detach(key); } catch { /* daemon gone — nothing to detach */ }
      } else {
        console.log(`[claude-code] Shutdown: killing process for ${key}`);
        this.killProcess(pp);
      }
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
    options?: { model?: string; resetFallbackContent?: string },
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
      return await this.sendChatInternal(sessionKey, message, handler, false, options?.resetFallbackContent);
    } finally {
      resolveQueue();
    }
  }

  private async sendChatInternal(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    retriedReset = false,
    resetFallbackContent?: string,
  ): Promise<{ runId?: string }> {
    const pp = this.getOrCreateProcess(sessionKey);
    const runId = crypto.randomUUID();

    pp.streamHandler = handler;
    pp.fullText = "";
    pp.activeToolCalls.clear();
    pp.settledToolCalls?.clear();
    pp.streamingToolInputs?.clear();
    pp.argsFinalized?.clear();
    // Sidechain state belongs to a single turn — fresh tracker per sendChat
    // so a Task() called in turn N doesn't leak state into turn N+1.
    pp.sidechain.clear();
    // Start the per-turn heartbeat — keep-alives flow only while a stream
    // handler is registered. Cleared in every finalization path below.
    this.startHeartbeat(pp, sessionKey);

    // A turn is in flight → the process is NOT idle. Cancel any inactivity
    // reaper armed at the PREVIOUS turn's end. Without this, that stale 15-min
    // timer fires mid-turn and `killProcess()` reaps a live, working child —
    // the chat dies before reaching the end (observed: a long tool/thinking
    // gap on `topic:6b99e9cf` tripped it → `[claude-code] Inactivity timeout`
    // → `[StaleStream] Auto-clearing`). Idle reaping is re-armed in the
    // `finally` below, but ONLY between turns. Mirrors the route watchdog's
    // "never kill a turn whose child is alive" policy (chat.ts handleHardTimeout).
    this.clearInactivityTimer(pp);

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

    // Turn watchdog — an INACTIVITY backstop, NOT a wall-clock cap. It rejects
    // only after the child has streamed NOTHING for MESSAGE_TIMEOUT_MS (a
    // genuinely wedged child). A turn that keeps producing events (a long e2e
    // run or refactor emitting tool results) bumps pp.lastEventAt and is never
    // killed, however long it takes — the same never-kill-a-live-turn policy
    // the route watchdog enforces (chat.ts isTurnProcessAlive → extend). A
    // fixed 30-min timer here used to SIGKILL live long turns mid-work — the
    // exact "chat stuck/dead before reaching the end" class. Self-reschedules
    // for the time remaining until 30 min of continuous silence; the handle is
    // cleared on settle so an active session never accumulates pending timers.
    let messageTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      const arm = () => {
        const remaining = MESSAGE_TIMEOUT_MS - (Date.now() - pp.lastEventAt);
        if (remaining <= 0) {
          reject(new Error("TIMEOUT"));
          return;
        }
        messageTimeout = setTimeout(arm, remaining);
      };
      messageTimeout = setTimeout(arm, MESSAGE_TIMEOUT_MS);
    });

    // Broker mode: wait for the child to actually exist before the first stdin
    // write (spawn + write share the socket FIFO, but spawn's send is behind an
    // ensureConnected microtask). No-op in direct mode (ready resolved at spawn).
    await pp.ready;

    const messagePromise = new Promise<{ runId: string }>((resolve, reject) => {
      pp.pendingResolve = resolve;
      pp.pendingReject = reject;
      pp.lastActivity = Date.now();
      // Anchor the inactivity watchdog's idle clock at the send: a turn that
      // never produces an event is measured from here, not from a stale prior
      // event. Real stream events keep bumping lastEventAt (see ~1812/1842).
      pp.lastEventAt = Date.now();

      if (!pp.alive) {
        reject(new Error("PROCESS_DEAD"));
        return;
      }

      pp.io.writeStdin(input);
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
        console.warn(
          `[claude-code] No model activity for ${Math.round(MESSAGE_TIMEOUT_MS / 60000)}min on ${sessionKey} — child appears wedged, killing process`,
        );
        this.killProcess(pp);
        this.processes.delete(sessionKey);
        handler.onError("Nessuna attività dal modello per 30 minuti — turno terminato");
        return { runId };
      }

      if (errMsg === "RATE_LIMIT") {
        console.warn(`[claude-code] Rate limited for ${sessionKey}`);
        handler.onError("Rate limited — please try again later");
        return { runId };
      }

      if (errMsg === "SESSION_RESET") {
        // The `--resume` hit a session that no longer exists; the dead id is
        // already forgotten (markMissingSessionRecovery). Drop the dead child and
        // resend the SAME prompt ONCE on a fresh session — spawnPersistentProcess
        // adds a recap prologue via needsHistoryReplay, so the model keeps the
        // thread. Transparent: no error surfaced, no dispatch attempt burned. The
        // cap prevents a loop if the fresh spawn were to reset again (impossible
        // in practice: a brand-new --session-id can't be "not found").
        this.processes.delete(sessionKey);
        if (!retriedReset) {
          console.log(`[claude-code] Session reset for ${sessionKey} — respawning fresh and resending`);
          // La sessione nuova non ha mai visto il preambolo: se la route ha
          // deduplicato (a regime `message` è il testo utente nudo), rispedire
          // QUELLO significa far girare un turno intero — fino a mezz'ora, per un
          // agent dispatchato — senza system prompt del topic, file di contesto,
          // progetto, memoria e pinned. Il recap prologue ricostruisce i turni,
          // non i blocchi di sistema. Qui si rimanda la versione integra.
          const forFreshSession = resetFallbackContent ?? message;
          return this.sendChatInternal(sessionKey, forFreshSession, handler, true, resetFallbackContent);
        }
        handler.onError("La sessione era scaduta ed è stata ripristinata — riprova.");
        return { runId };
      }

      if (errMsg.startsWith("PROCESS_D")) {
        this.processes.delete(sessionKey);
        handler.onError("Process died unexpectedly");
        return { runId };
      }

      handler.onError(errMsg || "Unknown error");
      return { runId };
    } finally {
      // Idle reaping resumes ONLY between turns. Re-arm the inactivity timer
      // for a process that SURVIVED this turn (an abort keeps the child alive).
      // Skipped for a killed/deleted child (TIMEOUT/PROCESS_DEAD) and for a
      // superseded one (SESSION_RESET respawns a fresh pp that owns its own
      // timer) — the identity check guards both. Counterpart to the
      // clearInactivityTimer() at turn start: together they guarantee the
      // reaper never fires while a turn is in flight.
      if (pp.alive && this.processes.get(sessionKey) === pp) {
        this.resetInactivityTimer(sessionKey, pp);
      }
    }

    // Successful turn — heartbeat is no longer needed; the resolution of
    // messagePromise above means the SDK signaled `result` and the handler
    // already received `onDone`. Idle reaping was re-armed in the `finally`.
    this.stopHeartbeat(pp);
    return { runId };
  }

  // --- Non-streaming Completion ---

  async complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult> {
    // (stdout parsing lives in parseCompletionStdout, exported for tests)
    // Build a single prompt from all messages
    const prompt = messages
      .map((m) => {
        if (m.role === "system") return `[System]\n${m.content}`;
        if (m.role === "assistant") return `[Assistant]\n${m.content}`;
        return m.content;
      })
      .join("\n\n");

    // Per-call override (dispatcher classifier forces haiku) → configured model → default.
    const model = options?.model ?? this.config.model ?? DEFAULT_MODEL;
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
      // NO --verbose here: with --output-format json it switches stdout to the
      // full EVENT ARRAY and the single result object disappears — that's how
      // complete() ended up returning raw stream JSON as "the completion".
      "--model", model,
      "--setting-sources", "user,project,local",
      ...oneshotMcpArgs,
      // Stesso ragionamento del config MCP vuoto qui sopra, portato fino in fondo:
      // spenti i server esterni restavano comunque gli schemi di TUTTI i tool
      // built-in (Bash, Edit, Read, WebFetch, Task…) in testa al prompt. Questi
      // completamenti — autoname, digest, fallback SSE, edit, scelta del modello —
      // producono una riga di testo e un tool non lo chiamano mai.
      // Misurato su CLI 2.1.220, prompt "say ok": 40.566 → 9.292 token di prefisso
      // (-77%), stessa risposta.
      // `--tools` è variadico e si mangerebbe un prompt posizionale, ma qui il
      // prompt entra da stdin (`proc.stdin.write` più sotto), quindi è innocuo.
      "--tools", "",
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
        resolve(parseCompletionStdout(stdout));
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

  /**
   * `/clear`: taglia il filo con la sessione della CLI, così il turno dopo
   * riparte da zero.
   *
   * Qui la memoria non sta in Topics. Svuotare la tabella `messages` pulisce
   * quello che si vede; il modello invece rilegge tutto dal file di sessione
   * della CLI, perché lo spawn successivo fa `--resume <id>`. Risultato prima
   * di questo metodo: la chat sembrava azzerata e il modello continuava a
   * citare quello che l'utente aveva appena visto sparire.
   *
   * Il taglio è in due mosse, e servono entrambe: dimenticare l'id (la riga
   * `claude_code_sessions`) manda lo spawn successivo sul ramo `--session-id`
   * con un uuid nuovo; staccare il processo in pool evita che a rispondere
   * resti il figlio ancora attaccato al vecchio id — che è VIVO e ricorda.
   *
   * A differenza di `refreshSessionConfig` questo NON risparmia un turno in
   * corso: chi scrive `/clear` mentre l'AI parla sta chiedendo esattamente di
   * buttare via quel turno, e i suoi messaggi li ha appena cancellati la
   * route. Il file di sessione della CLI resta sul disco: è la sua storia,
   * non tocca a noi cancellarla — semplicemente non ci torniamo più sopra.
   */
  async resetSession(sessionKey: string): Promise<void> {
    const pp = this.processes.get(sessionKey);
    if (pp) {
      this.killProcess(pp);
      this.processes.delete(sessionKey);
    }
    forgetClaudeSessionId(sessionKey);
    console.log(`[claude-code] resetSession: ${sessionKey} riparte con una sessione nuova al prossimo turno`);
  }

  // --- Abort ---

  async abort(sessionKey: string, _runId?: string, reason: "user" | "watchdog" = "user"): Promise<void> {
    const pp = this.processes.get(sessionKey);
    if (!pp || !pp.alive) return;

    // Mark BEFORE signalling: the CLI exits (code 0) on SIGINT, so the exit
    // event that follows must be read as a clean stop, not a crash. The
    // reason keeps the exit log honest ("watchdog stop" vs "user stop").
    pp.aborting = true;
    pp.abortReason = reason;

    // SIGINT cancels the current turn without killing the process
    try {
      pp.io.signal("SIGINT");
    } catch (err) {
      // Load-bearing: a failed SIGINT means the turn is NOT actually cancelled —
      // the user asked to abort and silently didn't get it. Observe (throttled).
      warnThrottled("claudeCode:abort:sigint", `[ClaudeCode] SIGINT on abort failed for ${sessionKey}:`, err);
    }

    // The aborted turn may have had outstanding human-input requests. Drop
    // them so a stale `POST /api/chat/tool-response` can't write a tool
    // result to a stream that the user just cancelled.
    pp.pendingInputs.clear();

    // Notify the stream handler so the route flushes any partial assistant
    // content as a finalized message instead of an error stub.
    if (pp.streamHandler) {
      pp.streamHandler.onAborted?.({ turnEnd: cancelled(reason) });
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
    // Models the INSTALLED CLI accepts, read from the binary we are about to
    // spawn (see claude-models.ts) instead of a list typed by hand here — the
    // hand-typed one silently capped every session at 200k because it had no
    // entry for the 1M variants (`claude-opus-5[1m]`). Cached per CLI version;
    // falls back to a static shortlist if the scan finds nothing.
    const all = await discoverClaudeModels(resolveCliPath());
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
    // Per-topic overrides (model + effort) win over the global config; both
    // are spawn-time CLI flags, so the PATCH handler forces a respawn via
    // refreshSessionConfig when either changes.
    const overrides = getTopicSpawnOverridesForSession(sessionKey);
    const model = overrides.model ?? this.config.model ?? DEFAULT_MODEL;
    const permissionMode = this.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
    // Spawn IN the topic's resolved working dir (worktree/project) so the CLI's
    // relative-path tools match the "You are working in <path>" awareness block.
    // Falls back to the global workspace/HOME for topics with no bound project.
    const workspace = getTopicWorkspaceForSession(sessionKey)
      || this.config.defaultWorkspace || process.env.HOME || "/tmp";

    // Look up (or create) the persistent Claude CLI session UUID for this
    // sessionKey. On first spawn we use `--session-id` to pin the UUID; on
    // every subsequent spawn (after hot reload, inactivity timeout, lifetime
    // cap, crash) we use `--resume` to reload the session from disk and
    // restore the AI's memory of prior turns.
    const { id: claudeSessionId, isNew: isNewSession } = getOrCreateClaudeSessionId(sessionKey);

    // Generate the per-session MCP config so the CLI can spawn our bridge
    // and surface `mcp__topics__open_browser_pane` as a callable tool. The
    // file path goes into argv as `--mcp-config`; the file lifetime is
    // bounded by `killProcess` below. Dispatched board agents carry
    // topics.mcp_policy='bridge-only' → topics bridge only, dispatch profile.
    const { path: mcpConfigPath, strict: mcpStrict } = writeMcpConfigForSession(sessionKey, { mcpPolicy: overrides.mcpPolicy });

    const args = [
      "--print",
      "--permission-mode", permissionMode,
      "--verbose",
      "--model", model,
      // Effort tier: a per-topic override (migration 033, set via the picker's
      // effort selector) wins; otherwise match the Warp default ("ultracode" =
      // xhigh). Without this the spawn falls back to settings.json effortLevel
      // (low). Resolved fresh per spawn, so a change respawn picks up the tier.
      ...((): string[] => { const e = resolveClaudeEffort(overrides.effort); return e ? ["--effort", e] : []; })(),
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
      // Emit `stream_event` lines (content_block_start/delta/stop) in addition
      // to the cumulative assistant snapshots. Without this, a tool_use is only
      // announced AFTER the model finished writing its input — the UI's
      // "running" window covered just the execution (ms for a Read) while the
      // longest phase (input generation, 10-30s for a big Edit) was invisible.
      // handlePartialStreamEvent announces the tool at content_block_start so
      // the visible running state matches the tool's real usage window.
      "--include-partial-messages",
      ...(isNewSession ? ["--session-id", claudeSessionId] : ["--resume", claudeSessionId]),
    ];

    console.log(
      `[claude-code] Spawning ${isNewSession ? 'new' : 'resumed'} session for ${sessionKey} (claude_session_id=${claudeSessionId})`
    );

    const env = buildSafeEnv();
    // Dispatch sessions: defer MCP tool schemas so caricano on-demand via
    // ToolSearch invece di viaggiare nel contesto di ogni chiamata.
    //
    // La guardia `!/haiku/` che stava qui poggiava su un commento falso — «Haiku
    // models don't support tool search» — e quindi escludeva dal deferral proprio
    // i topic bridge-only su haiku: misurato, haiku deferisce come gli altri.
    //
    // ATTENZIONE, e vale più della guardia: questa env è in gran parte INERTE.
    // Lo spawn passa `--setting-sources user,project,local` (poche righe sopra),
    // e `~/.claude/settings.json` dell'utente porta già `ENABLE_TOOL_SEARCH`, che
    // vince sull'ambiente di processo. Finché quel file dice qualcosa, questo
    // ramo non cambia il comportamento: la leva vera sta lì, non qui. Lo si tiene
    // perché è corretto e perché su un'installazione senza quel settaggio è
    // l'unica cosa che accende il deferral.
    if (overrides.mcpPolicy === "bridge-only") {
      env.ENABLE_TOOL_SEARCH = env.ENABLE_TOOL_SEARCH ?? "auto";
    }

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
      proc: null,
      readline: null,
      io: null as unknown as SessionIO, // set below, before pp is returned/used
      ready: Promise.resolve(),
      sessionKey,
      consumedOffset: 0,
      stderrBuf: "",
      spawnMeta: { claudeSessionId, isNewSession },
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
      subAgentEmit: new Map(),
      lastEventAt: Date.now(),
      needsHistoryReplay,
      sidechain: new SidechainTracker(),
      pendingInputs: new Map(),
    };

    // stdout NDJSON → the SAME line parser for both transports.
    const onLine = (line: string) => {
      try { this.handleStreamEvent(pp, JSON.parse(line)); } catch { /* non-JSON line, ignore */ }
    };

    if (USE_AI_BRIDGE) {
      // Broker mode: the child lives in the detached ai-bridge daemon and
      // survives a server restart. `data` frames are folded SYNCHRONOUSLY (a
      // manual line buffer, not an async PassThrough) so that on reattach, once
      // `client.attach` resolves, the replayed NDJSON is fully processed —
      // determinism the four-case reattach branch relies on.
      const client = getAiBridgeClient();
      this.wireBrokerHandlers(pp, client, sessionKey, onLine);
      pp.io = brokerIO(client, sessionKey);
      // Fire the spawn; expose readiness so the first stdin write (sendChat)
      // waits for the child to exist. spawn and write share the socket FIFO,
      // but spawn's send sits behind an ensureConnected microtask.
      pp.ready = client.spawn(sessionKey, { cliPath: resolveCliPath(), args, cwd: workspace, env })
        // Il pid del figlio è l'ancora delle shell in background: senza, una
        // `bun run dev` lasciata da questa sessione è indistinguibile da una
        // uguale avviata altrove. Vedi `providers/session-pids.ts`.
        .then(async ({ pid, resumed }) => {
          setSessionCliPid(sessionKey, pid);
          // `resumed` = the daemon handed us a child that was ALREADY running
          // (it outlives our restarts by design) instead of spawning one. Old
          // daemons don't attach us on that branch, so this turn's stdin write
          // would land on a child whose stdout we never hear: no text, no tool
          // events, and a stream that hangs on "stream lento — il provider è
          // ancora connesso" until the hard cap. Attaching LIVE (no replay —
          // the past turns of that child are already in the DB) closes it, and
          // is a harmless no-op against a daemon that attaches us itself.
          if (!resumed) return;
          console.log(`[claude-code] Adopted live broker child for ${sessionKey} (pid ${pid}) — attaching to its stream`);
          // consumedOffset must land ON the attach point, not stay at 0: it is
          // where resyncStream() re-attaches from, and 0 against an adopted
          // child's store would re-fold that child's whole history.
          pp.consumedOffset = (await client.attachLive(sessionKey)).fromOffset;
        })
        .catch((err) => this.onSessionErrored(pp, err instanceof Error ? err : new Error(String(err))));
    } else {
      const proc = spawn(resolveCliPath(), args, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], env });
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", onLine);
      setSessionCliPid(sessionKey, proc.pid);
      pp.proc = proc;
      pp.readline = rl;
      pp.io = directIO(proc);
      proc.stderr!.on("data", (d: Buffer) => this.handleStderrData(pp, sessionKey, d));
      proc.on("close", (code) => this.onSessionClosed(pp, code));
      proc.on("error", (err) => this.onSessionErrored(pp, err));
    }

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

  // Register the broker's per-session frame callbacks. `data` is folded through
  // a SYNCHRONOUS line buffer (not an async PassThrough) so that on reattach,
  // the moment `client.attach` resolves the replayed NDJSON is fully processed.
  private wireBrokerHandlers(
    pp: PersistentProcess,
    client: AiBridgeClient,
    sessionKey: string,
    onLine: (line: string) => void,
  ): void {
    let lineBuf = "";
    client.registerHandlers(sessionKey, {
      onData: (chunk, offset) => {
        lineBuf += chunk.toString();
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          onLine(line);
        }
        pp.consumedOffset = offset + chunk.byteLength;
      },
      onStderr: (chunk) => this.handleStderrData(pp, sessionKey, chunk),
      onExit: (code) => this.onSessionClosed(pp, code),
    });
  }

  // Build a PersistentProcess around an ALREADY-RUNNING broker session (no
  // spawn): reattach's counterpart to spawnPersistentProcess. Volatile turn
  // state starts empty and is rebuilt by replaying the store (see reattach).
  private adoptBrokerProcess(sessionKey: string): PersistentProcess {
    const client = getAiBridgeClient();
    const pp: PersistentProcess = {
      proc: null,
      readline: null,
      io: null as unknown as SessionIO,
      ready: Promise.resolve(),
      sessionKey,
      consumedOffset: 0,
      stderrBuf: "",
      spawnMeta: { claudeSessionId: peekClaudeSessionId(sessionKey) ?? "", isNewSession: false },
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
      subAgentEmit: new Map(),
      lastEventAt: Date.now(),
      needsHistoryReplay: false,
      sidechain: new SidechainTracker(),
      pendingInputs: new Map(),
    };
    const onLine = (line: string) => {
      try { this.handleStreamEvent(pp, JSON.parse(line)); } catch { /* non-JSON line, ignore */ }
    };
    this.wireBrokerHandlers(pp, client, sessionKey, onLine);
    pp.io = brokerIO(client, sessionKey);
    pp.lifetimeTimer = setTimeout(() => {
      this.killProcess(pp);
      for (const [key, p] of this.processes) { if (p === pp) { this.processes.delete(key); break; } }
    }, MAX_LIFETIME_MS);
    return pp;
  }

  /** Watchdog liveness probe (see Provider.isTurnProcessAlive): true while the
   *  session's child is running — direct or broker mode. A live-but-mute child
   *  (auto-compact) must not be finalized as a timeout. */
  isTurnProcessAlive(sessionKey: string): boolean {
    const pp = this.processes.get(sessionKey);
    return !!pp && pp.alive;
  }

  /**
   * Re-attach the broker stream of a LIVE turn, losslessly, from the last byte
   * we consumed. The self-heal for the whole "we stopped hearing a child that
   * is still working" family: a socket reconnect, a daemon that acked a spawn
   * without attaching us, any future variant. Every one of them looks identical
   * from outside — the child runs, the bytes pile up in the store, and the turn
   * never ends because nothing arrives to end it.
   *
   * Idempotent and cheap: if we ARE still attached, `attach` from consumedOffset
   * replays zero bytes and the daemon just refreshes our delivery cursor. Safe
   * to call speculatively, which is exactly what the route's watchdog does.
   *
   * Precondition, and why the callers all satisfy it: call this only after a
   * stretch of SILENCE (grace expiry, the stale sweeper, a socket reconnect).
   * `consumedOffset` advances when onData folds a chunk, so calling it while
   * frames are still in flight in the socket buffer would replay bytes that are
   * about to arrive anyway — duplicated deltas. After a minute of nothing there
   * is nothing in flight, and after a reconnect the in-flight bytes are gone
   * for good, which is precisely what makes the replay the right answer.
   *
   * Returns true when a live session was re-attached (the caller may recover),
   * false when there was nothing to resync (no broker, dead child, no process).
   */
  async resyncStream(sessionKey: string): Promise<boolean> {
    if (!USE_AI_BRIDGE) return false;
    const pp = this.processes.get(sessionKey);
    if (!pp || !pp.alive) return false;
    // Snapshot BEFORE the await: the replay this attach triggers is folded
    // synchronously by onData, so by the time it resolves pp.consumedOffset has
    // already moved — reading it after would log the destination, not the gap.
    const from = pp.consumedOffset;
    try {
      const res = await getAiBridgeClient().attach(sessionKey, from);
      // A LIVE daemon answering "I don't have that session" (or "its child is
      // gone") is proof the child died: the daemon is the authority on that,
      // and if it died WITH the daemon (daemon crash, then the client respawns
      // a fresh empty one) no `exit` frame will ever arrive to say so. Without
      // this the process stays `alive` in our map forever, isTurnProcessAlive
      // keeps vouching for it, and the route's grace window extends for good —
      // a turn that can never end. Finalize it as a died turn instead: the
      // caller's promise settles, the queue unlocks, the route closes the
      // bubble. A daemon we simply can't REACH throws instead, and lands in the
      // catch below without finalizing anything.
      if (res.missing || !res.alive) {
        console.warn(`[claude-code] Stream resync for ${sessionKey}: the broker no longer has a live child — finalizing the turn as died`);
        this.finalizeDeadReattach(pp);
        return false;
      }
      console.log(`[claude-code] Stream resync for ${sessionKey}: re-attached from offset ${from}, recovered ${Math.max(0, res.endOffset - from)} byte(s)`);
      return true;
    } catch (err: any) {
      console.warn(`[claude-code] Stream resync failed for ${sessionKey}: ${err?.message ?? err}`);
      return false;
    }
  }

  /** True if a still-running broker session exists for `sessionKey`. The signal
   *  the dispatcher uses to REATTACH (non-lossy) vs RESUME-from-scratch. */
  async hasLiveSession(sessionKey: string): Promise<boolean> {
    if (!USE_AI_BRIDGE) return false;
    const pp = this.processes.get(sessionKey);
    if (pp && pp.alive) return true;
    return getAiBridgeClient().hasLiveSession(sessionKey);
  }

  /**
   * Re-attach to an in-flight turn that survived a server restart in the broker
   * (the non-lossy counterpart of resume-from-scratch). Adopts the live child,
   * replays its buffered NDJSON through the SAME fold to rebuild turn state, then
   * branches on the replayed terminal state:
   *   - completed  → the `result` was buffered; onDone already fired, no re-run.
   *   - live       → mid-generation; keep reading until the live `result`.
   *   - awaiting-input → an unanswered AskUserQuestion; re-surface it and wait.
   *   - dead       → child gone (TOCTOU / exited without result) → finalize as a
   *                  died turn so the caller degrades to resume-from-scratch.
   * Resolves when the turn ends (like sendChatInternal), returning the outcome.
   */
  async reattach(sessionKey: string, handler: StreamHandler): Promise<"completed" | "live" | "awaiting-input" | "dead"> {
    const existing = this.processes.get(sessionKey);
    if (existing && existing.alive && existing.streamHandler) return "live"; // already driving

    const client = getAiBridgeClient();
    const pp = this.adoptBrokerProcess(sessionKey);
    this.processes.set(sessionKey, pp);

    // ── Phase 1 · SCAN ──
    // The broker store spans the child's LIFETIME (multiple turns). A muted
    // replay from 0 learns the tail shape without re-emitting old turns:
    // does anything follow the last `result` (open turn), and what was that
    // last result (to deliver it if the turn completed while detached)?
    pp.replayMute = true;
    pp.replayTailOpen = false;
    pp.replayLastResult = undefined;
    pp.replayAfterLastResultOffset = 0;
    const scan = await client.attach(sessionKey, 0);
    pp.replayMute = false;
    if (scan.missing) {
      pp.streamHandler = handler;
      this.finalizeDeadReattach(pp);
      return "dead";
    }

    if (!pp.replayTailOpen) {
      // The store ends on a result: no turn in flight.
      if (pp.replayLastResult) {
        // The turn COMPLETED while we were detached — deliver the missed
        // final result through the normal onDone path so the route finalizes
        // the bubble with the real content instead of dropping it.
        pp.streamHandler = handler;
        this.handleStreamEvent(pp, pp.replayLastResult);
        return "completed";
      }
      // Empty store (child idle since spawn, or nothing meaningful): nothing
      // to adopt.
      pp.streamHandler = handler;
      this.finalizeDeadReattach(pp);
      return scan.alive ? "completed" : "dead";
    }

    // ── Phase 2 · LIVE ──
    // An open turn exists. Attach from just past the last completed turn so
    // ONLY the in-flight turn folds into the fresh handler (replaySilent
    // still suppresses live-only side effects during this replay), then keep
    // driving until the live result.
    pp.streamHandler = handler;
    pp.replaySilent = true;
    const turnDone = new Promise<void>((resolve, reject) => {
      pp.pendingResolve = () => resolve();
      pp.pendingReject = (e) => reject(e);
    });

    const res = await client.attach(sessionKey, pp.replayAfterLastResultOffset ?? 0);
    pp.replaySilent = false;

    // Replay is fully folded now (synchronous onData). Classify from pp state.
    if (res.missing) { this.finalizeDeadReattach(pp); return "dead"; }
    if (pp.streamHandler === null) return "completed"; // the live `result` landed during the replay
    if (!res.alive) { this.finalizeDeadReattach(pp); return "dead"; }

    if (pp.pendingInputs.size > 0) {
      // Case 3: re-surface the questions still awaiting a human, then stay live.
      for (const [toolId, entry] of pp.pendingInputs) handler.onUserInputRequired?.(toolId, "", entry.schema);
      await turnDone;
      return "awaiting-input";
    }
    // Case 2: mid-generation — keep reading live until the result event.
    await turnDone;
    return "live";
  }

  private finalizeDeadReattach(pp: PersistentProcess): void {
    pp.alive = false;
    if (pp.pendingResolve) { const r = pp.pendingResolve; pp.pendingResolve = null; pp.pendingReject = null; r({ runId: "" }); }
    // Riattacco a un processo che nel frattempo è morto: il turno non l'ha
    // fermato nessuno, è finito il processo sotto.
    if (pp.streamHandler) {
      pp.streamHandler.onAborted?.({ turnEnd: { end: "error", cause: "process-died" } });
      pp.streamHandler = null;
    }
    this.cleanupTimers(pp);
  }

  // Route a lost `--resume` into recovery: wipe the DB row so the NEXT spawn
  // falls back to `--session-id` (fresh) instead of looping on a doomed resume,
  // and flag the process so the imminent exit is read as a recoverable reset
  // (SESSION_RESET), not a crash. Shared by the stderr scan and the stdout
  // `result`-error path — the CLI can report the miss on either channel.
  // Idempotent, and a no-op for a fresh --session-id spawn (can't lose a session
  // that was just created). Don't kill here: the close handler fires shortly.
  private markMissingSessionRecovery(pp: PersistentProcess): void {
    if (pp.recovering || pp.spawnMeta.isNewSession) return;
    console.warn(
      `[claude-code] Resume failed for ${pp.sessionKey} (claude_session_id=${pp.spawnMeta.claudeSessionId}); forgetting and will respawn fresh`,
    );
    forgetClaudeSessionId(pp.sessionKey);
    pp.recovering = true;
  }

  // stderr scan (rate limit + missing-session), shared by direct + broker mode.
  // Detects on the ACCUMULATED tail (pp.stderrBuf), not a single chunk: the CLI
  // can split an error across write()s; the 2 KiB cap keeps the scan cheap and
  // both detections are latch-style (idempotent on re-match).
  private handleStderrData(pp: PersistentProcess, _sessionKey: string, d: Buffer): void {
    pp.stderrBuf += d.toString();
    if (pp.stderrBuf.length > 2048) pp.stderrBuf = pp.stderrBuf.slice(-2048);

    if (looksLikeMissingSessionError(pp.stderrBuf)) this.markMissingSessionRecovery(pp);

    if (
      (pp.stderrBuf.includes("rate_limit") || pp.stderrBuf.includes("429") || /overloaded/i.test(pp.stderrBuf)) &&
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
  }

  // Child exited (direct: proc 'close'; broker: daemon `exit` frame). Rejects a
  // pending turn and surfaces the error to a live stream, then drops timers.
  private onSessionClosed(pp: PersistentProcess, code: number | null): void {
    pp.alive = false;
    // Il CLI è morto: il suo pid non è più un'ancora valida (il sistema può
    // riciclare il numero). Le shell che gli pendevano sotto le riconcilia
    // `routes/processes.ts` guardando se il processo è ancora vivo.
    clearSessionCliPid(pp.sessionKey);
    // A user-requested stop (aborting) or a clean exit (code 0) is NOT a crash:
    // the CLI exits code 0 on SIGINT, and a persistent session can also exit 0
    // between/after turns. Only a non-zero exit with a turn still open is a real
    // failure worth an error stub — everything else finalizes gracefully so the
    // chat never shows "⚠️ Process exited with code 0".
    // A lost `--resume` (recovering) is a recoverable reset, NOT a crash: reject
    // the turn with the distinct SESSION_RESET marker so sendChat transparently
    // respawns fresh and resends. A user stop (aborting) or a clean exit (code 0)
    // is ABORTED. Only a genuine non-zero exit is PROCESS_DIED.
    const graceful = pp.aborting === true || code === 0;
    const kind = pp.recovering ? " (session reset)"
      : pp.aborting ? (pp.abortReason === "watchdog" ? " (watchdog stop)" : " (user stop)")
      : "";
    console.log(`[claude-code] Process exited with code ${code}${kind}`);
    if (pp.pendingReject) {
      const reject = pp.pendingReject;
      pp.pendingResolve = null;
      pp.pendingReject = null;
      reject(new Error(pp.recovering ? "SESSION_RESET" : graceful ? "ABORTED" : `PROCESS_DIED_${code}`));
    }
    if (pp.streamHandler) {
      if (pp.recovering) {
        // Recoverable reset — surface NO user-facing error. The sendChat retry
        // re-attaches this handler to a fresh session and resends (with a recap
        // prologue), so the lost session stays invisible.
      } else if (graceful) {
        // Flush any partial assistant content as a finalized message (same path
        // as an explicit abort) instead of an error stub. CHI ha fermato il turno
        // viaggia con esso: uno stop dell'umano e uno del watchdog sono lo stesso
        // `cancelled` di ACP ma due politiche opposte a valle (`consumesAttempt`).
        // Senza `aborting` non ha premuto nessuno: è il figlio uscito pulito a
        // turno aperto. Resta `cancelled` senza causa — meglio "annullato" che
        // una causa inventata.
        pp.streamHandler.onAborted?.({
          turnEnd: pp.aborting
            ? cancelled(pp.abortReason === "watchdog" ? "watchdog" : "user")
            : { end: "cancelled" },
        });
      } else {
        pp.streamHandler.onError(`Process exited with code ${code}`);
      }
      pp.streamHandler = null;
    }
    this.cleanupTimers(pp);
  }

  // Child failed to spawn / errored (direct: proc 'error'; broker: spawn ack rejection).
  private onSessionErrored(pp: PersistentProcess, err: Error): void {
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
  }

  // --- NDJSON Event Handling ---

  private handleStreamEvent(pp: PersistentProcess, event: any): void {
    const handler = pp.streamHandler;

    // Compaction boundary (CHAT-COMPACT-01): lift it out BEFORE the generic
    // `system` drop below. Skip during reattach replay (replayMute scan /
    // replaySilent fold) so re-reading the store never double-fires the marker.
    if (event.type === "system" && event.subtype === "compact_boundary") {
      if (!pp.replayMute && !pp.replaySilent) {
        const marker = parseCompactBoundary(event);
        if (marker) {
          pp.lastEventAt = Date.now();
          handler?.onCompaction?.(marker);
        }
      }
      return;
    }

    // Filter noise
    if (event.type === "system" || event.type === "rate_limit_event") return;

    // Reattach SCAN pass: record the store's tail shape, emit nothing.
    if (pp.replayMute) {
      if (event.type === "result") {
        const rt = event.result ?? "";
        if (rt && rt !== "waiting for message") {
          pp.replayTailOpen = false;
          pp.replayLastResult = event;
          pp.replayAfterLastResultOffset = pp.consumedOffset;
        }
      } else {
        pp.replayTailOpen = true;
      }
      return;
    }

    // Mark "real activity from provider" — heartbeats consult this to
    // decide whether to fire. Any event that gets past the noise filter
    // counts (assistant text, tool_use, tool_result, sub-agent, result).
    // Includes partial-message input deltas: a model spending 30s writing a
    // big Edit input is ACTIVE, and the watchdog must see it as such.
    pp.lastEventAt = Date.now();

    // Partial-message stream events (`--include-partial-messages`). Only the
    // tool_use lifecycle is consumed here — text/thinking keep flowing
    // through the cumulative snapshots below, so nothing double-counts.
    if (event.type === "stream_event") {
      this.handlePartialStreamEvent(pp, event, handler);
      return;
    }

    // Result event: stream is done for this turn
    if (event.type === "result") {
      // Turn over — drop any leftover partial-input buffers (a block that
      // never got its stop event would otherwise pin its JSON forever).
      pp.streamingToolInputs?.clear();
      // A missing-session miss ("No conversation found with session ID …") is
      // reported as an ERROR result on STDOUT, not on stderr — route it into the
      // same resume-recovery as the stderr scan so a dead `--resume` id is
      // forgotten instead of retried forever. Gated inside the helper to resumed
      // sessions only; the missing-session regex avoids false positives on any
      // other error result.
      if (event.is_error === true || event.subtype === "error_during_execution") {
        const errText = [event.subtype, ...(Array.isArray(event.errors) ? event.errors : [])].join(" ");
        if (looksLikeMissingSessionError(errText)) this.markMissingSessionRecovery(pp);
      }
      const resultText = event.result ?? "";
      if (!resultText || resultText === "waiting for message") return;

      if (handler) {
        // PERCHÉ è finito: la CLI lo dice qui e finora lo buttavamo via. A valle
        // il dispatcher lo deduceva dalla durata («probabile timeout»).
        const turnEnd = classifyResultEvent(event);
        const usage = event.usage ?? {};
        const cacheCreation = usage.cache_creation_input_tokens ?? 0;
        // Il TTL sta SCRITTO nell'usage: una scrittura a un'ora costa 2×, una a
        // cinque minuti 1.25×. Tariffarle tutte al ribasso sottostimava il turno.
        const cacheCreation1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        handler.onDone({
          result: resultText,
          usage: {
            inputTokens: (usage.input_tokens ?? 0) + cacheCreation + cacheRead,
            outputTokens: usage.output_tokens ?? 0,
            cacheCreation: cacheCreation || undefined,
            cacheCreation1h: cacheCreation1h || undefined,
            cacheRead: cacheRead || undefined,
          },
          durationMs: event.duration_ms,
          costUsd: event.total_cost_usd,
          turnEnd,
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

    // Per-call context size. Each `assistant` event carries the usage of the ONE
    // model call that produced it, so `input + cache_read + cache_creation` is
    // the real size of the prompt the model just saw. The final `result` usage
    // sums every call in the turn — reading THAT as the context size is what
    // made the post-compaction divider claim the context had grown. Sidechain
    // (sub-agent) calls have their own context and are excluded.
    if (event.type === "assistant" && !parentToolUseId && handler?.onContextSize) {
      const msg = event.message as { usage?: Record<string, unknown>; model?: unknown } | undefined;
      const mu = msg?.usage;
      if (mu) {
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        // Quali token contano come contesto lo decide `contextTokensFromUsage`,
        // non questo provider: la stessa regola vale per Codex e per chiunque
        // arrivi dopo (3.1). Qui si traduce solo il vocabolario della CLI.
        const size = contextTokensFromUsage({
          inputTokens: n(mu.input_tokens),
          cacheRead: n(mu.cache_read_input_tokens),
          cacheCreation: n(mu.cache_creation_input_tokens),
        });
        // The model comes from the SAME event as the usage: it is the model
        // that actually served this call, which is what sizes the window.
        const model = typeof msg?.model === "string" && msg.model ? msg.model : undefined;
        if (size > 0) handler.onContextSize(size, model);
        // Lo stesso evento porta anche il CONSUMO di questa chiamata, che finora
        // buttavamo: `onContextSize` misura il serbatoio (sale e scende con le
        // compattazioni), questo la bolletta (solo cresce). Chi ascolta accumula —
        // il `result` finale somma già tutte le chiamate, quindi non si somma due
        // volte.
        handler.onCallUsage?.({
          inputTokens: n(mu.input_tokens) + n(mu.cache_read_input_tokens) + n(mu.cache_creation_input_tokens),
          outputTokens: n(mu.output_tokens),
          cacheRead: n(mu.cache_read_input_tokens),
          cacheCreation: n(mu.cache_creation_input_tokens),
          // Il TTL sta scritto nell'usage, non si deduce: una scrittura a un'ora
          // costa 2×, una a cinque minuti 1.25×.
          cacheCreation1h: n((mu.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens),
          model,
        });
      }
    }
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
      this.emitSubAgent(pp, parentToolUseId);
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
          if (settled.has(toolId)) continue;
          const toolName = String(block.name ?? "");
          const input = block.input as Record<string, unknown> | undefined;
          if (pp.activeToolCalls.has(toolId)) {
            // Already announced EARLY by handlePartialStreamEvent (args were
            // still streaming then). The cumulative snapshot carries the
            // COMPLETE input — deliver it now (idempotent via argsFinalized).
            // Also the fallback when the partial-json buffer didn't parse or
            // the CLI never emitted a content_block_stop.
            this.finalizeToolArgs(pp, handler, toolId, toolName, input ?? {});
            continue;
          }
          pp.activeToolCalls.add(toolId);
          // Sidechain bookkeeping: if this is a Task() call, register it as a
          // sub-agent parent so its child events get aggregated. We do this
          // before onToolStart so the route handler sees the right state if
          // it queries the tracker.
          if (toolName === "Task") {
            pp.sidechain.registerParent(toolId, block.input);
          }
          handler.onToolStart(toolId, toolName, input);
          // Announced with the full input already in hand — mark finalized
          // and run user-input detection (AskUserQuestion / MCP elicitation).
          (pp.argsFinalized ??= new Set<string>()).add(toolId);
          this.detectUserInputForTool(pp, handler, toolId, toolName, block.input);
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
          // A result for this tool means any user-input request it represented
          // is answered — drop it so that after a reattach REPLAY, pendingInputs
          // holds EXACTLY the questions still awaiting a human (Case 3).
          pp.pendingInputs.delete(toolId);
        }
      }
    }
  }

  // ── Partial-input streaming (below) ──────────────────────────────────────

  /**
   * `--include-partial-messages` stream_event handling. ONLY the tool_use
   * lifecycle is consumed here: `content_block_start` announces the tool the
   * moment the model STARTS writing its input (so the UI's running window
   * covers input generation + execution — the tool's real usage window),
   * `input_json_delta` accumulates the input, and `content_block_stop`
   * parses the complete input and upserts it via onToolArgsUpdate.
   * Text/thinking deltas are ignored — the cumulative snapshots remain their
   * single source, so nothing double-counts. Sidechain (sub-agent) partials
   * are skipped: child tools aggregate from the sidechain's own snapshots.
   */
  private handlePartialStreamEvent(pp: PersistentProcess, event: any, handler: StreamHandler | null): void {
    if (typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id) return;
    const ev = event.event;
    if (!ev || typeof ev !== "object") return;
    const index: number = typeof ev.index === "number" ? ev.index : -1;
    if (ev.type === "content_block_start") {
      const block = ev.content_block;
      if (!block || block.type !== "tool_use" || typeof block.id !== "string" || !block.id) return;
      const toolName = String(block.name ?? "");
      (pp.streamingToolInputs ??= new Map()).set(index, { id: block.id, name: toolName, buf: "" });
      if (pp.activeToolCalls.has(block.id) || pp.settledToolCalls?.has(block.id)) return;
      pp.activeToolCalls.add(block.id);
      // Task parents register immediately (empty input, back-filled by
      // finalizeToolArgs) so early sidechain child events find their parent.
      if (toolName === "Task") pp.sidechain.registerParent(block.id, {});
      handler?.onToolStart(block.id, toolName, {});
    } else if (ev.type === "content_block_delta") {
      if (ev.delta?.type !== "input_json_delta" || typeof ev.delta.partial_json !== "string") return;
      const entry = pp.streamingToolInputs?.get(index);
      if (!entry) return;
      entry.buf += ev.delta.partial_json;
      // The input is actively streaming — the turn is NOT stalled. Two things,
      // throttled: (1) keep the ROUTE's stream timer alive so a minutes-long
      // Write/Edit input doesn't trip the false "stream slow" annotation
      // (input_json_delta reaches only the provider, not the route callbacks),
      // and (2) surface the primary field (filename / command / url) the moment
      // it's fully in the buffer, so the row reads `Write(App.tsx)` instead of a
      // blank running row for the whole (possibly 4-min) input generation.
      if (handler && !pp.replaySilent && !pp.settledToolCalls?.has(entry.id) && !pp.argsFinalized?.has(entry.id)) {
        const now = Date.now();
        if (!entry.lastEmitAt || now - entry.lastEmitAt >= PARTIAL_ARGS_EMIT_MS) {
          entry.lastEmitAt = now;
          handler.onToolActivity?.(entry.id);
          const primary = extractPrimaryToolArg(entry.buf);
          if (primary && primary.value !== entry.emittedPrimary) {
            entry.emittedPrimary = primary.value;
            handler.onToolArgsUpdate?.(entry.id, { [primary.key]: primary.value });
          }
        }
      }
    } else if (ev.type === "content_block_stop") {
      const entry = pp.streamingToolInputs?.get(index);
      if (!entry) return;
      pp.streamingToolInputs?.delete(index);
      // An empty buffer is a REAL empty input (zero-arg tools stream no
      // deltas). A non-empty buffer that doesn't parse to an object is a
      // truncated/odd stream — leave finalization to the snapshot fallback.
      let args: Record<string, unknown> | null = null;
      if (!entry.buf) {
        args = {};
      } else {
        try {
          const parsed = JSON.parse(entry.buf);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          /* cumulative snapshot finalizes instead */
        }
      }
      if (args) this.finalizeToolArgs(pp, handler, entry.id, entry.name, args);
    }
  }

  /**
   * Deliver a tool's COMPLETE input for a call that was announced early with
   * partial args. Idempotent (argsFinalized guard): fires from
   * content_block_stop AND from every cumulative snapshot re-emission —
   * whichever lands first wins. Back-fills Task parents and runs user-input
   * detection, both of which need the full input.
   */
  private finalizeToolArgs(
    pp: PersistentProcess,
    handler: StreamHandler | null,
    toolId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    const finalized = (pp.argsFinalized ??= new Set<string>());
    if (finalized.has(toolId) || pp.settledToolCalls?.has(toolId)) return;
    finalized.add(toolId);
    if (toolName === "Task") pp.sidechain.updateParentInput(toolId, args);
    handler?.onToolArgsUpdate?.(toolId, args);
    this.detectUserInputForTool(pp, handler, toolId, toolName, args);
  }

  /**
   * Detect "I am asking the user a question" tools (AskUserQuestion, MCP
   * elicitation) — requires the COMPLETE input, so it runs at announce time
   * only when the full args are already in hand, otherwise at args-finalize.
   * When matched, the CLI is sitting on stdin waiting for a `tool_result`
   * line; the route handler must pause the soft inactivity timer, broadcast
   * the form schema, and wait for `POST /api/chat/tool-response`. During a
   * reattach REPLAY we rebuild pendingInputs but do NOT re-surface the form
   * live — reattach() re-fires onUserInputRequired once, after replay, for
   * the entries that are STILL unanswered.
   */
  private detectUserInputForTool(
    pp: PersistentProcess,
    handler: StreamHandler | null,
    toolId: string,
    toolName: string,
    input: unknown,
  ): void {
    const schema = detectUserInputRequest({ name: toolName, input });
    if (!schema) return;
    const sessionKey = this.findSessionKeyForProcess(pp);
    if (sessionKey) {
      pp.pendingInputs.set(toolId, { sessionKey, schema, awaitingSince: Date.now() });
    }
    if (!pp.replaySilent) handler?.onUserInputRequired?.(toolId, toolName, schema);
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
    // Stessa vita del heartbeat: ogni percorso di finalizzazione dello stream
    // (done/error/aborted/exit) passa da qui, quindi qui muoiono anche i timer
    // in coda degli aggiornamenti di sub-agent. Uno che sopravvivesse allo
    // stream emetterebbe su un handler morto.
    this.clearSubAgentEmit(pp);
  }

  /**
   * Emette lo snapshot di un sub-agent accorpando le raffiche.
   *
   * Lo snapshot si prende DENTRO il timer, non prima: se durante l'attesa
   * arrivano altre azioni, quello che parte e' lo stato al momento dell'invio,
   * non quello di quando la finestra si e' aperta. Cosi' i fotogrammi saltati
   * non costano nemmeno la copia profonda.
   *
   * `finished` bypassa sempre l'accorpamento: l'ultimo stato di un sub-agent
   * non deve mai aspettare.
   */
  private emitSubAgent(pp: PersistentProcess, parentToolUseId: string): void {
    const handler = pp.streamHandler;
    if (!handler?.onSubAgentUpdate) return;

    const send = () => {
      const snap = pp.sidechain.snapshot(parentToolUseId);
      if (!snap) return;
      const slot = pp.subAgentEmit.get(parentToolUseId);
      if (slot) { slot.lastAt = Date.now(); slot.timer = null; }
      pp.streamHandler?.onSubAgentUpdate?.(parentToolUseId, {
        subAgentType: snap.subAgentType,
        description: snap.description,
        actions: snap.actions,
        finished: snap.finished,
        result: snap.fullText || undefined,
      });
      if (snap.finished) this.clearSubAgentEmit(pp, parentToolUseId);
    };

    // Un sub-agent finito non aspetta: si spegne il timer in coda e si manda.
    if (pp.sidechain.snapshot(parentToolUseId)?.finished) {
      const slot = pp.subAgentEmit.get(parentToolUseId);
      if (slot?.timer) { clearTimeout(slot.timer); slot.timer = null; }
      send();
      return;
    }

    const slot = pp.subAgentEmit.get(parentToolUseId)
      ?? { lastAt: 0, timer: null as ReturnType<typeof setTimeout> | null };
    pp.subAgentEmit.set(parentToolUseId, slot);
    if (slot.timer) return; // gia' accodato: lo stato lo leggera' lui

    const since = Date.now() - slot.lastAt;
    if (since >= SUBAGENT_COALESCE_MS) { send(); return; }
    slot.timer = setTimeout(send, SUBAGENT_COALESCE_MS - since);
    if (typeof slot.timer.unref === "function") slot.timer.unref();
  }

  /** Spegne il timer in coda di un parent e ne dimentica lo stato. */
  private clearSubAgentEmit(pp: PersistentProcess, parentToolUseId?: string): void {
    if (parentToolUseId) {
      const slot = pp.subAgentEmit.get(parentToolUseId);
      if (slot?.timer) clearTimeout(slot.timer);
      pp.subAgentEmit.delete(parentToolUseId);
      return;
    }
    for (const slot of pp.subAgentEmit.values()) if (slot.timer) clearTimeout(slot.timer);
    pp.subAgentEmit.clear();
  }

  private resetInactivityTimer(key: string, pp: PersistentProcess): void {
    if (pp.inactivityTimer) clearTimeout(pp.inactivityTimer);
    pp.inactivityTimer = setTimeout(() => {
      console.log(`[claude-code] Inactivity timeout for ${key}`);
      this.killProcess(pp);
      this.processes.delete(key);
    }, INACTIVITY_TIMEOUT_MS);
  }

  /** Suspend idle reaping for the duration of an active turn. The timer is a
   *  BETWEEN-turns pool cleanup; letting it survive into a turn lets a stale
   *  timer (armed at the previous turn's end) reap the live child mid-work.
   *  Re-armed in sendChatInternal's `finally` once the turn settles. */
  private clearInactivityTimer(pp: PersistentProcess): void {
    if (pp.inactivityTimer) { clearTimeout(pp.inactivityTimer); pp.inactivityTimer = null; }
  }

  private killProcess(pp: PersistentProcess): void {
    pp.alive = false;
    this.cleanupTimers(pp);
    try { pp.readline?.close(); } catch {}
    pp.io.kill();
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
    response: import("../../shared/types").ToolUserResponse,
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
      pp.io.writeStdin(input);
    } catch (err: any) {
      // Restore the entry so a retry from the route can succeed if the
      // stdin transient hiccups (rare; mostly here as defence-in-depth).
      pp.pendingInputs.set(toolCallId, pending);
      throw new Error(`claude-code: stdin write failed — ${err?.message ?? err}`);
    }
  }
}
