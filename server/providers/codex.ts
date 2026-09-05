/**
 * CodexProvider — wraps the OpenAI Codex CLI.
 *
 * Auto-detected when the `codex` (or $CODEX_BIN) binary is present in PATH.
 * Auth is delegated to the upstream CLI (`codex login`); this provider does
 * not handle OAuth or store keys.
 *
 * Implementation strategy:
 *   - One-shot `codex exec` per message (non-interactive). Streams stdout
 *     line-by-line if the CLI emits JSON events; otherwise treats stdout as
 *     plain text and emits a single text_delta on close.
 *   - Long-lived JSONL "app-server" mode (à la Paseo) is left as a future
 *     enhancement; the one-shot path keeps the protocol surface small.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type {
  AIProvider,
  ChatMessage,
  CompletionResult,
  ProviderCapability,
  ProviderDiagnostic,
  ProviderDoneMessage,
  ProviderRequirement,
  ProviderUsage,
  StreamHandler,
} from "./types";
import { probeBinaryPath } from "../utils/executable";
import { resolveCodexBin } from "../lib/codex-bin";
import { resolveCodexReasoningEffort } from "../lib/topics-agent-prompt";
import { topicsMcpBridgeSpec } from "./claude-code";
import { buildCodexArgs, buildCodexOneshotArgs } from "./codex/args";
import { getDatabase } from "../db";
import { applyJobQuota } from "../services/agent-job-quota";
import { contextTokensFromUsage } from "../usage/usage-update";
import {
  isEligibleGlobalOrchestratorSession,
  isGlobalOrchestratorSession,
} from "../services/global-orchestrator-session";

// ============ Config ============

export interface CodexProviderConfig {
  type: "codex";
  model?: string;
  approvalMode?: "auto" | "full-access";
  defaultWorkspace?: string;
}

// ============ Constants ============

const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const KILL_GRACE_MS = 3_000;

const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "TZ", "USER", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "CODEX_SESSION_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
]);

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

/** Coerce an unknown to a finite non-negative number, or undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/**
 * Codex emits `turn.completed` with usage at one of several paths depending
 * on CLI version: `usage.input_tokens`, `usage.prompt_tokens`, or nested
 * under `response.usage`. Try them in order and normalize to `ProviderUsage`.
 *
 * Exported (alongside `extractCodexErrorMessage`) so the routing logic stays
 * unit-testable without spawning a real CLI.
 */
export function extractCodexUsage(event: Record<string, unknown>): ProviderUsage | null {
  const candidates: unknown[] = [
    event.usage,
    (event.response && typeof event.response === "object")
      ? (event.response as Record<string, unknown>).usage
      : undefined,
    (event.item && typeof event.item === "object")
      ? (event.item as Record<string, unknown>).usage
      : undefined,
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as Record<string, unknown>;
    const inputTokens = num(u.input_tokens) ?? num(u.prompt_tokens) ?? num(u.inputTokens);
    const outputTokens = num(u.output_tokens) ?? num(u.completion_tokens) ?? num(u.outputTokens);
    // CLI 0.131 renamed these: `reasoning_output_tokens` (was `reasoning_tokens`)
    // and `cached_input_tokens` (was `cache_read_input_tokens`). Accept both so
    // usage keeps rendering across CLI versions.
    const reasoningTokens = num(u.reasoning_output_tokens) ?? num(u.reasoning_tokens) ?? num(u.reasoningTokens);
    const cacheRead = num(u.cached_input_tokens) ?? num(u.cache_read_input_tokens) ?? num(u.cached_tokens) ?? num(u.cacheRead);
    const cacheCreation = num(u.cache_creation_input_tokens) ?? num(u.cacheCreation);
    if (inputTokens === undefined && outputTokens === undefined) continue;
    const usage: ProviderUsage = {};
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
    if (cacheRead !== undefined) usage.cacheRead = cacheRead;
    if (cacheCreation !== undefined) usage.cacheCreation = cacheCreation;
    return usage;
  }
  return null;
}

/**
 * Il contesto VIVO di Codex, dall'evento `token_count` (3.1).
 *
 * Fino a qui il ring era acceso solo per Claude: Codex i token li aveva in
 * mano e li buttava nel footer di fine turno, quindi il cerchietto restava
 * vuoto per l'intera sessione. Il payload standard `usage_update` non serve a
 * niente se un solo provider lo riempie.
 *
 * Si legge `last_token_usage`, MAI `total_token_usage`: il totale somma tutte
 * le chiamate del turno, ed è esattamente l'errore che faceva dichiarare al
 * divisore di compaction un contesto ESPLOSO. Il numeratore poi lo compone
 * `contextTokensFromUsage`, uguale per tutti.
 *
 * `model_context_window` è il denominatore detto dal provider: vale più della
 * nostra tabella di finestre, che su un modello Codex nuovo tirerebbe a
 * indovinare.
 */
export function extractCodexContext(
  event: Record<string, unknown>,
): { usage: ProviderUsage; windowTokens?: number } | null {
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  const info = obj(event.info) ?? obj(event.token_usage_info) ?? event;
  const last = obj(info.last_token_usage) ?? obj(info.lastTokenUsage);
  if (!last) return null;
  const usage = extractCodexUsage({ usage: last });
  if (!usage) return null;
  const windowTokens = num(info.model_context_window) ?? num(info.modelContextWindow);
  return windowTokens !== undefined ? { usage, windowTokens } : { usage };
}

/**
 * `turn.failed.error.message` is occasionally a JSON string (sometimes
 * double-encoded). Walk up to two levels of decoding looking for an inner
 * `error.message` / `message` / `error` field; bail out the moment we see
 * a non-JSON string and treat that as the human-facing message.
 */
export function extractCodexErrorMessage(event: Record<string, unknown>): string {
  const errObj = (event.error && typeof event.error === "object")
    ? event.error as Record<string, unknown>
    : null;
  const seedRaw = errObj?.message ?? event.message ?? errObj?.error ?? "Codex error";
  let msg = typeof seedRaw === "string" ? seedRaw : JSON.stringify(seedRaw);
  for (let i = 0; i < 2; i++) {
    const trimmed = msg.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) break;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
      if (Array.isArray(parsed)) break;
      const inner = parsed.error && typeof parsed.error === "object"
        ? (parsed.error as Record<string, unknown>).message
        : undefined;
      const next = (typeof inner === "string" ? inner : null)
        ?? (typeof parsed.message === "string" ? parsed.message : null)
        ?? (typeof parsed.error === "string" ? parsed.error : null);
      if (!next) break;
      msg = next;
    } catch {
      break;
    }
  }
  return msg;
}

// Binary resolution lives in the shared `lib/codex-bin` resolver so the chat
// provider and the interactive PTY route (routes/terminal.ts) agree on where
// codex is — including the Codex.app bundle, which isn't on PATH.
const resolveCodexBinary = resolveCodexBin;

/**
 * An empty directory of its own for the global Kanban coordinator's Codex
 * process, under the app data dir so it follows `APP_DATA_DIR` in tests and in
 * a container instead of landing in a shared temp root.
 *
 * Best effort: if it cannot be created the caller still gets a usable path, and
 * a cwd that does not exist is Codex's problem to report, not a reason to fail
 * a turn here.
 */
export function globalOrchestratorWorkspace(): string {
  const dataDir =
    process.env.APP_DATA_DIR || process.env.OPENCLAW_DIR || join(process.env.HOME ?? ".", ".openclaw");
  const dir = join(dataDir, "orchestrator-cwd");
  try { mkdirSync(dir, { recursive: true }); } catch { /* reported by Codex if it matters */ }
  return dir;
}

function hasActiveSession(): boolean {
  // Heuristic: Codex stores real credentials under $CODEX_HOME (or ~/.codex).
  // config.toml only proves the user has run codex once — not that they're logged in.
  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
  return existsSync(join(codexHome, "auth.json")) ||
         existsSync(join(codexHome, "credentials.json")) ||
         Boolean(process.env.CODEX_API_KEY) ||
         Boolean(process.env.OPENAI_API_KEY);
}

// ============ Helpers ============

/**
 * Maximum non-system transcript turns to ship to `codex exec`. Codex's
 * single-shot mode has a finite context window and there's no resume API to
 * lean on — past this cap we keep the most recent turns and ALL system
 * messages (which are typically small but carry pinned context the user
 * specifically wants preserved). Tuned for ~32k context with reasonable
 * room for the response; bump if codex grows.
 */
const CODEX_HISTORY_TURN_CAP = 20;

/**
 * Format a chat transcript as a markdown preamble that codex `exec` can read.
 * We label each turn with its role so the model can disambiguate; system
 * messages flow through as `## Context` blocks since codex doesn't have a
 * dedicated system-prompt slot in single-shot mode.
 *
 * Long histories are truncated to `CODEX_HISTORY_TURN_CAP` user/assistant
 * turns from the tail. System messages are always preserved because they
 * usually encode pinned context (SOUL.md, project hints, etc.).
 */
function renderHistoryAsPrompt(history: ChatMessage[]): string {
  const systemMessages = history.filter((m) => m.role === "system");
  const conversational = history.filter((m) => m.role === "user" || m.role === "assistant");

  let truncated = false;
  let kept = conversational;
  if (conversational.length > CODEX_HISTORY_TURN_CAP) {
    kept = conversational.slice(-CODEX_HISTORY_TURN_CAP);
    truncated = true;
  }

  const lines: string[] = ["# Conversation so far"];
  if (truncated) {
    lines.push(
      "",
      `> _(Earlier ${conversational.length - kept.length} turns omitted; only the most recent ${kept.length} are shown.)_`
    );
  }

  for (const m of systemMessages) {
    lines.push("", "## Context", "", m.content);
  }
  for (const m of kept) {
    if (m.role === "user") {
      lines.push("", "## User", "", m.content);
    } else if (m.role === "assistant") {
      lines.push("", "## Assistant", "", m.content);
    }
  }
  return lines.join("\n");
}

// ============ Provider ============

/** Per-turn bookkeeping shared between the JSONL event router and the close
 *  handler. Held both in `sessionState` (keyed by sessionKey, for abort/event
 *  routing) and as a per-spawn local (`turnState`) so an overlapping newer
 *  turn can't swap the state out from under a dying child's close handler. */
interface CodexTurnState {
  /** Set when the user aborted this turn — close handler emits `onAborted` instead of `onError`. */
  aborted: boolean;
  /** Latest usage payload extracted from `turn.completed` (if seen). */
  usage?: ProviderUsage;
  /** Modello richiesto per questo turno, se esplicito. Etichetta il ring;
   *  il denominatore vero lo manda Codex (`model_context_window`). */
  model?: string;
  /** Wall-clock turn duration captured at close. */
  startedAt: number;
  /** Active command_execution tool calls, keyed by Codex's command id. */
  runningTools: Map<string, { toolCallId: string; partial: string }>;
}

export class CodexProvider implements AIProvider {
  readonly name = "codex";
  readonly capabilities: Set<ProviderCapability> = new Set([
    "streaming",
    "tools",
    "sessions",
    "abort",
    // `history` capability tells the chat route to forward the full transcript
    // every turn. Codex's `exec` mode is one-shot stateless — without this
    // the CLI saw only the new user message and forgot every prior turn,
    // exactly the behavior the user reported as "topics losing history".
    "history",
  ]);
  // Codex `exec` mode is one-shot stateless: full transcript per turn via
  // `options.history`. See `server/context/adapt.ts`.
  readonly contextStrategy = "history-aware" as const;

  private config: CodexProviderConfig;
  private started = false;
  private activeChildren = new Map<string, ChildProcess>();
  /**
   * Per-session bookkeeping that survives between event lines and the close
   * handler. Cleared in `child.on("close")`.
   */
  private sessionState = new Map<string, CodexTurnState>();

  constructor(config: CodexProviderConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.started && resolveCodexBinary() !== null;
  }

  start(): void {
    this.started = true;
    console.log("[codex] Provider started");
  }

  stop(): void {
    this.started = false;
    for (const [, child] of this.activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
    }
    this.activeChildren.clear();
    console.log("[codex] Provider stopped");
  }

  // --- Streaming chat ---

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[] },
  ): Promise<{ runId?: string }> {
    // The HTTP chat entry point rejects this state too, but do it at the
    // provider boundary as well: a raw registry role that has become bound or
    // switched provider must never fall through to a normal Codex bridge,
    // inherited user config, or project/home workspace through a direct call.
    let ineligibleRawCoordinator = false;
    try {
      const db = getDatabase();
      ineligibleRawCoordinator = (
        isGlobalOrchestratorSession(db, sessionKey)
        && !isEligibleGlobalOrchestratorSession(db, sessionKey)
      );
    } catch {
      // A provider unit test or early bootstrap may not have initialized the
      // database yet. Without a readable registry we cannot classify a role;
      // preserve ordinary provider startup behavior.
    }
    if (ineligibleRawCoordinator) {
      // A prior direct turn may still be alive while an out-of-band database
      // change corrupts the role. Stop it rather than leaving a generic
      // provider process behind after refusing the new turn.
      try { await this.abort(sessionKey); } catch { /* fail closed anyway */ }
      try { handler.onError("Global coordinator integrity is invalid; reopen it from the Kanban."); }
      catch { /* caller callbacks must not reopen this provider path */ }
      return { runId: undefined };
    }

    const bin = resolveCodexBinary();
    if (!bin) {
      handler.onError("Codex CLI not found. Install it and run `codex login`.");
      return { runId: undefined };
    }

    const runId = crypto.randomUUID();
    const explicitModel = options?.model ?? this.config.model;

    // Wire the topics-app MCP bridge into `codex exec` so a codex session can
    // drive topics (open browser pane, switch/create topic, open/create project)
    // through the SAME tools claude-code uses — no markers. sessionKey resolves
    // to this topic server-side. Un bridge che non si monta è un degrado, non un
    // guasto: il turno parte comunque, senza i tool di Topics.
    let bridge: { command: string; args: string[] } | null = null;
    let globalOrchestrator = false;
    try {
      // A ChatGPT/Codex subscription remains an ordinary provider choice. The
      // only special capability is this registry-backed tool profile; it does
      // not imply, observe, or connect any voice session.
      globalOrchestrator = isEligibleGlobalOrchestratorSession(getDatabase(), sessionKey);
      const profile = globalOrchestrator ? "global-orchestrator" : undefined;
      bridge = topicsMcpBridgeSpec(sessionKey, profile);
    } catch (err) {
      console.warn(`[codex] MCP bridge config failed for ${sessionKey}:`, err);
    }

    // The coordinator never inherits a project/home workspace. Its durable
    // board operations travel through the registry-gated bridge, and the Codex
    // subprocess runs `--sandbox read-only` in a directory of its own.
    //
    // ITS OWN, and not the temp root, which is what this used to be. Read-only
    // stops WRITES, it does not stop reads: whatever the cwd contains is
    // readable, and on a machine running the fleet the temp root holds other
    // sessions' scratch files, test databases and agent workspaces. An empty
    // directory changes what is one `ls .` away, which is the part a cwd
    // actually decides. It does not confine reads, and nothing here pretends
    // to: the confinement of the coordinator is its five-tool profile, not
    // its sandbox flag.
    const workspace = globalOrchestrator
      ? globalOrchestratorWorkspace()
      : (this.config.defaultWorkspace || process.env.HOME || "/tmp");

    // Force the reasoning-effort tier explicitly — the codex mirror of the
    // `--effort` flag claude-code sessions get. Deterministic under launchd
    // and surfaced as the picker badge (snapshot-manager calls the same
    // resolver). The resolver honours the user's own config.toml value, so
    // this never downgrades an explicit user choice; null (disabled or
    // unrecognised tier) means no override at all.
    const reasoningEffort = resolveCodexReasoningEffort();

    // L'elenco delle flag vive in `codex/args.ts`, funzione pura sotto snapshot:
    // è la superficie che si rompe a ogni release della CLI. Qui restano le
    // decisioni (quale modello, quale sandbox, quale tier) — incluso il fatto
    // che `--model` si passa SOLO se qualcuno l'ha scelto: senza, la CLI pesca
    // da `~/.codex/config.toml`, ed è l'unico modo perché funzionino gli account
    // ChatGPT (che rifiutano `gpt-5-codex` passato a mano).
    const args = buildCodexArgs({
      model: explicitModel,
      // Never inherit a global full-access setting into the coordinator.
      approvalMode: globalOrchestrator ? null : this.config.approvalMode,
      sandbox: globalOrchestrator ? "read-only" : undefined,
      // `-c` alone layers onto user config. The global profile must not inherit
      // arbitrary user MCP servers or executable rules; Codex auth remains
      // available with this CLI isolation flag.
      isolated: globalOrchestrator,
      bridge,
      reasoningEffort,
    });

    // La stessa quota di core di claude-code, per la stessa ragione: il
    // provider si sceglie per INSTALLAZIONE (`AI_PROVIDER`), non per topic, e su
    // una macchina a codex il dispatcher fa nascere agenti codex — che
    // compilano esattamente come gli altri. Senza questa riga il recinto
    // esisterebbe solo per metà delle installazioni.
    //
    // `buildSafeEnv()` qui sotto resta l'ambiente di OGNI sessione, chat
    // interattive comprese: la quota si fonde SOPRA, e solo se questo topic è
    // la chat di un task dispatchato (altrimenti `null`, e l'ambiente resta
    // quello di prima).
    const env = buildSafeEnv();
    try {
      const quota = applyJobQuota(getDatabase(), sessionKey, env);
      if (quota != null) {
        console.log(`[codex] job quota for dispatched ${sessionKey}: -j${quota} (rilettura viva attiva)`);
      }
    } catch { /* nessun recinto: la sessione parte comunque, com'è sempre stato */ }

    const child = spawn(bin, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    // Keep a direct handle to THIS turn's state: the maps are keyed by
    // sessionKey and a newer turn overwrites both entries (e.g. the chat
    // route's timeout aborts this turn and the queue moves on while this
    // child is still dying). The close/error handlers below must read their
    // OWN state and only delete map entries they still own — an unconditional
    // delete would strip the NEWER turn's entries, leaving its "stop" button
    // pointing at nothing while the process keeps running.
    const turnState: CodexTurnState = {
      aborted: false,
      startedAt: Date.now(),
      runningTools: new Map(),
      ...(explicitModel ? { model: explicitModel } : {}),
    };
    this.activeChildren.set(sessionKey, child);
    this.sessionState.set(sessionKey, turnState);

    let fullText = "";
    const rl = createInterface({ input: child.stdout! });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Try to parse as Codex JSONL event; fall back to plain text.
      try {
        const event = JSON.parse(trimmed);
        const surfaced = this.routeCodexEvent(sessionKey, event, handler, fullText);
        if (surfaced) fullText += surfaced;
      } catch {
        fullText += trimmed + "\n";
        handler.onTextDelta(trimmed + "\n", fullText);
      }
    });

    let stderrBuf = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      handler.onError("Codex turn timed out after 30 minutes");
      // SIGKILL fallback if it ignores SIGTERM, so the close handler runs and
      // we don't leak an orphan child. Mirrors abort()'s grace-window guard.
      setTimeout(() => {
        if (this.activeChildren.get(sessionKey) === child) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, KILL_GRACE_MS);
    }, MESSAGE_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeout);
      // Owner-scoped cleanup (see turnState above): never strip a newer turn's
      // entries, and read THIS turn's state, not whatever the map holds now.
      if (this.activeChildren.get(sessionKey) === child) this.activeChildren.delete(sessionKey);
      try { rl.close(); } catch {}

      const state = turnState;
      if (this.sessionState.get(sessionKey) === turnState) this.sessionState.delete(sessionKey);
      const done: ProviderDoneMessage = {};
      if (state?.usage) done.usage = state.usage;
      if (state) done.durationMs = Date.now() - state.startedAt;
      const trimmed = fullText.trim();
      if (trimmed) done.result = trimmed;

      // Aborted by the user (we sent SIGINT). Codex commonly exits with 130
      // after SIGINT; emit `aborted` rather than `error` so the UI shows the
      // partial assistant text without a red error stub. Falls through to
      // `onDone` if `onAborted` isn't implemented.
      if (state?.aborted) {
        if (handler.onAborted) handler.onAborted(done);
        else handler.onDone(done);
        return;
      }

      if (code === 0) {
        handler.onDone(done);
      } else {
        // Sanitize stderr: don't echo full upstream errors to the UI (may leak
        // tokens/paths). Log full tail server-side, surface a generic message.
        const tail = stderrBuf.trim().split("\n").slice(-3).join("\n");
        if (tail) console.warn(`[codex] exit ${code}: ${tail}`);
        handler.onError(`Codex exited with code ${code}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      // Owner-scoped, same as the close handler.
      if (this.activeChildren.get(sessionKey) === child) this.activeChildren.delete(sessionKey);
      if (this.sessionState.get(sessionKey) === turnState) this.sessionState.delete(sessionKey);
      handler.onError(err.message);
    });

    // Codex `exec` is stateless — every turn spawns a fresh child with no
    // memory of prior turns. To restore continuity we prepend the conversation
    // transcript (when the chat route supplies one) ahead of the new user
    // message. Without this, every reply read like the first one.
    const history = options?.history ?? [];
    const prompt = history.length > 0
      ? renderHistoryAsPrompt(history) + "\n\n## Current message\n\n" + message
      : message;

    child.stdin!.write(prompt);
    child.stdin!.end();

    return { runId };
  }

  // --- Routing for JSONL events from `codex exec --json` ---

  /**
   * Returns the text that was surfaced as a delta (so the caller can keep its
   * cumulative buffer in sync), or `null` if the event didn't produce any.
   * Side effects: invokes the relevant `handler.*` callbacks and mutates the
   * per-session bookkeeping (running tools, usage, abort flag).
   */
  private routeCodexEvent(
    sessionKey: string,
    event: Record<string, unknown>,
    handler: StreamHandler,
    fullTextRef: string,
  ): string | null {
    // Codex event format isn't fully stable across versions; handle the
    // common shapes defensively. Current CLI (0.125.x) emits items wrapped
    // in `item.completed` with the actual payload under `event.item`.
    const t = (typeof event.type === "string" ? event.type : null)
      ?? (typeof event.kind === "string" ? event.kind : null);

    // Wrapped item events: item.completed / item.started / item.updated carry
    // an inner item. command_execution items stream stdout via item.updated
    // which the UI surfaces as incremental tool output.
    if (t === "item.completed" || t === "item.started" || t === "item.updated") {
      const item = (event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : {});
      const itemType = item.type;

      if (itemType === "agent_message" || itemType === "assistant_message") {
        const text = typeof item.text === "string" ? item.text
          : typeof item.content === "string" ? item.content : "";
        if (text.length > 0) {
          handler.onTextDelta(text, fullTextRef + text);
          return text;
        }
        return null;
      }

      if (itemType === "command_execution" || itemType === "tool_call") {
        const id = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
        const name = typeof item.name === "string" ? item.name
          : typeof item.command === "string" ? item.command : "tool";
        const state = this.sessionState.get(sessionKey);

        if (t === "item.started") {
          state?.runningTools.set(id, { toolCallId: id, partial: "" });
          handler.onToolStart(id, name, this.coerceArgs(item.arguments ?? item.input));
        } else if (t === "item.updated") {
          // Partial command output. Codex emits `aggregated_output` (full
          // accumulated text so far) on each delta — track and forward via
          // `onToolUpdate` so the UI shows running tool output as it streams.
          const aggregated = typeof item.aggregated_output === "string"
            ? item.aggregated_output
            : (typeof item.output === "string" ? item.output : null);
          if (aggregated && handler.onToolUpdate) {
            const ctx = state?.runningTools.get(id);
            if (ctx) ctx.partial = aggregated;
            handler.onToolUpdate(id, aggregated);
          }
        } else if (t === "item.completed") {
          const ctx = state?.runningTools.get(id);
          state?.runningTools.delete(id);
          const result = typeof item.output === "string" ? item.output
            : ctx?.partial && ctx.partial.length > 0 ? ctx.partial
            : JSON.stringify(item.output ?? item.result ?? "");
          handler.onToolResult(id, result);
        }
      }
      return null;
    }

    // Flat shape (older CLI versions / future-compat).
    if (t === "agent_message" || t === "assistant_message" || t === "message") {
      const text = typeof event.text === "string" ? event.text
        : typeof event.content === "string" ? event.content
        : typeof event.message === "string" ? event.message : "";
      if (text.length > 0) {
        handler.onTextDelta(text, fullTextRef + text);
        return text;
      }
      return null;
    }

    if (t === "agent_message_delta" || t === "delta" || t === "text_delta") {
      const text = typeof event.text === "string" ? event.text
        : typeof event.delta === "string" ? event.delta : "";
      if (text.length > 0) {
        handler.onTextDelta(text, fullTextRef + text);
        return text;
      }
      return null;
    }

    // Flat command-output delta — older CLI emitted these directly instead of
    // wrapping them in item.updated. Same destination: onToolUpdate.
    if (t === "exec_command_output_delta" || t === "command_output_delta") {
      const id = typeof event.command_id === "string" ? event.command_id
        : typeof event.id === "string" ? event.id : "";
      const data = typeof event.data === "string" ? event.data
        : typeof event.text === "string" ? event.text
        : typeof event.delta === "string" ? event.delta : "";
      if (id && data && handler.onToolUpdate) {
        const state = this.sessionState.get(sessionKey);
        const ctx = state?.runningTools.get(id);
        if (ctx) {
          ctx.partial += data;
          handler.onToolUpdate(id, ctx.partial);
        } else {
          handler.onToolUpdate(id, data);
        }
      }
      return null;
    }

    if (t === "tool_call" || t === "tool_use" || t === "function_call") {
      const id = typeof event.id === "string" ? event.id
        : typeof event.call_id === "string" ? event.call_id : crypto.randomUUID();
      const name = typeof event.name === "string" ? event.name
        : typeof event.tool === "string" ? event.tool : "tool";
      const state = this.sessionState.get(sessionKey);
      state?.runningTools.set(id, { toolCallId: id, partial: "" });
      handler.onToolStart(id, name, this.coerceArgs(event.arguments ?? event.args));
      return null;
    }

    if (t === "tool_result" || t === "function_result") {
      const id = typeof event.id === "string" ? event.id
        : typeof event.call_id === "string" ? event.call_id : "";
      const state = this.sessionState.get(sessionKey);
      const ctx = id ? state?.runningTools.get(id) : undefined;
      if (id) state?.runningTools.delete(id);
      const result = typeof event.output === "string" ? event.output
        : ctx?.partial && ctx.partial.length > 0 ? ctx.partial
        : JSON.stringify(event.output ?? event.result ?? "");
      handler.onToolResult(id, result);
      return null;
    }

    // Contesto vivo. Codex lo manda per conto suo a ogni chiamata, con la
    // finestra del modello dentro: è la stessa misura che per Claude ricaviamo
    // dall'evento `assistant`, e alimenta lo stesso `usage_update` (3.1).
    if (t === "token_count" && handler.onContextSize) {
      const live = extractCodexContext(event);
      if (live) {
        const tokens = contextTokensFromUsage(live.usage);
        const model = this.sessionState.get(sessionKey)?.model ?? this.config.model;
        if (tokens > 0) handler.onContextSize(tokens, model, live.windowTokens);
      }
      return null;
    }

    // Final turn marker — capture usage so the UI footer can render
    // tokens + cost + duration. Stored on the session and consumed in the
    // close handler.
    if (t === "turn.completed") {
      const state = this.sessionState.get(sessionKey);
      if (state) {
        const usage = extractCodexUsage(event);
        if (usage) state.usage = usage;
      }
      return null;
    }

    if (t === "turn.failed" || t === "error") {
      handler.onError(extractCodexErrorMessage(event));
      return null;
    }

    // Unknown event types are silently ignored (forward-compat).
    return null;
  }

  private coerceArgs(raw: unknown): Record<string, unknown> | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "object") return raw as Record<string, unknown>;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch { /* fall through */ }
      return { value: raw };
    }
    return { value: raw };
  }

  // --- Non-streaming completion ---

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    const bin = resolveCodexBinary();
    if (!bin) return { content: "Codex CLI not found." };

    const prompt = messages
      .map((m) => m.role === "system" ? `[System]\n${m.content}` :
                  m.role === "assistant" ? `[Assistant]\n${m.content}` :
                  m.content)
      .join("\n\n");

    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    // Only forward --model when explicitly configured; otherwise let the CLI
    // pick from ~/.codex/config.toml so ChatGPT-account-bound models work
    // (e.g. gpt-5-codex is rejected for ChatGPT-account auth). Mirrors sendChat.
    const args = buildCodexOneshotArgs({ model: this.config.model });

    return new Promise<CompletionResult>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildSafeEnv(),
      });

      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("Codex completion timed out"));
      }, MESSAGE_TIMEOUT_MS);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          if (stderr) console.warn(`[codex] complete exit ${code}: ${stderr.slice(0, 500)}`);
          resolve({ content: `Error: Codex exited with code ${code}` });
          return;
        }
        resolve({ content: stdout.trim() });
      });

      child.on("error", (err) => { clearTimeout(timer); reject(err); });

      child.stdin!.write(prompt);
      child.stdin!.end();
    });
  }

  // --- Abort ---

  /**
   * Cancel the in-flight Codex turn for `sessionKey`.
   *
   * Strategy: SIGINT → let the CLI flush its in-flight `turn.failed` /
   * partial-output events → SIGKILL fallback after a grace window if it
   * doesn't exit cleanly. Marking `aborted: true` on the session state lets
   * the close handler emit `onAborted` (with the partial assistant text)
   * instead of an `onError("exit code 130")` stub.
   *
   * We deliberately do NOT clear `activeChildren` here — `child.on("close")`
   * is the single point that owns cleanup. Clearing early would race the
   * final stdout drain and lose any post-SIGINT lines (the trailing
   * `turn.failed` Codex emits after Ctrl-C).
   */
  async abort(sessionKey: string): Promise<void> {
    const child = this.activeChildren.get(sessionKey);
    if (!child) return;
    const state = this.sessionState.get(sessionKey);
    if (state) state.aborted = true;
    try { child.kill("SIGINT"); } catch {}
    setTimeout(() => {
      // Still alive after the grace window? Force-kill so the close handler
      // runs and the user isn't stuck with a phantom stream.
      if (this.activeChildren.get(sessionKey) === child) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, KILL_GRACE_MS);
  }

  // --- Diagnostics ---

  async diagnose(): Promise<ProviderDiagnostic> {
    const requirements: ProviderRequirement[] = [];

    const binPath = resolveCodexBinary();
    const probe = binPath
      ? await probeBinaryPath(binPath)
      : { available: false };
    requirements.push({
      key: "codex-cli",
      label: "Codex CLI installed",
      present: probe.available,
      hint: probe.available ? undefined : "Install Codex.app or run: brew install openai-codex",
    });

    const session = hasActiveSession();
    requirements.push({
      key: "codex-session",
      label: "Active Codex session",
      present: session,
      hint: session ? undefined : "Run in terminal: codex login",
    });

    const allOk = requirements.every((r) => r.present);
    return {
      name: this.name,
      // Same convention as claude-code: missing setup → unavailable, not error.
      status: allOk ? "ready" : "unavailable",
      binaryPath: probe.path,
      version: probe.version,
      requirements,
    };
  }

  async listModels(): Promise<string[]> {
    // The CLI caches the user's available models in $CODEX_HOME/models_cache.json
    // (populated after the first turn). Reading it here means the picker shows
    // exactly what the user can actually call — different ChatGPT plans expose
    // different model sets, and the codex-specific slugs (gpt-5-codex, etc.)
    // are rejected for ChatGPT-account auth.
    const codexHome = process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
    const cachePath = join(codexHome, "models_cache.json");
    try {
      const raw = readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(raw) as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
      const slugs = (parsed.models ?? [])
        .filter((m): m is { slug: string; visibility: string } =>
          typeof m?.slug === "string" && m.visibility === "list",
        )
        .map((m) => m.slug);
      if (slugs.length > 0) return slugs;
    } catch {
      // No cache yet — fall through.
    }
    // Empty list signals "use whatever the CLI has configured" — picker shows
    // the provider but no model rows; user can still trigger via no-override.
    return [];
  }

  /**
   * Lo stesso tier che finisce in `-c model_reasoning_effort` a ogni turno:
   * stesso resolver, così il badge del picker non racconta un'altra storia.
   * Dichiarato dal provider invece che indovinato dal nome dentro lo snapshot
   * manager (vedi `AIProvider.effortTier`).
   */
  effortTier(): string | undefined {
    return resolveCodexReasoningEffort() ?? undefined;
  }
}
