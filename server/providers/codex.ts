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
import { existsSync } from "fs";
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

// ============ Config ============

export interface CodexProviderConfig {
  type: "codex";
  model?: string;
  approvalMode?: "auto" | "full-access";
  defaultWorkspace?: string;
}

// ============ Constants ============

const DEFAULT_MODEL = "gpt-5-codex";
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
    const reasoningTokens = num(u.reasoning_tokens) ?? num(u.reasoningTokens);
    const cacheRead = num(u.cache_read_input_tokens) ?? num(u.cached_tokens) ?? num(u.cacheRead);
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

const MAC_APP_BUNDLE_PATHS = [
  "/Applications/Codex.app/Contents/Resources/codex",
  join(process.env.HOME || "", "Applications/Codex.app/Contents/Resources/codex"),
];

function resolveCodexBinary(): string | null {
  const envBin = process.env.CODEX_BIN;
  if (envBin && existsSync(envBin)) return envBin;

  const inPath = Bun.which("codex");
  if (inPath) return inPath;

  // macOS: Codex.app ships the binary inside the bundle
  for (const candidate of MAC_APP_BUNDLE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
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
  private sessionState = new Map<string, {
    /** Set when the user aborted this turn — close handler emits `onAborted` instead of `onError`. */
    aborted: boolean;
    /** Latest usage payload extracted from `turn.completed` (if seen). */
    usage?: ProviderUsage;
    /** Wall-clock turn duration captured at close. */
    startedAt: number;
    /** Active command_execution tool calls, keyed by Codex's command id. */
    runningTools: Map<string, { toolCallId: string; partial: string }>;
  }>();

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
    const bin = resolveCodexBinary();
    if (!bin) {
      handler.onError("Codex CLI not found. Install it and run `codex login`.");
      return { runId: undefined };
    }

    const runId = crypto.randomUUID();
    const explicitModel = options?.model ?? this.config.model;
    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    // `codex exec --json` is the canonical non-interactive entrypoint.
    // We pass the prompt via stdin to avoid argv length limits.
    // Only forward --model when explicitly requested; otherwise let the CLI
    // pick from ~/.codex/config.toml so ChatGPT-account-bound models work
    // (e.g. gpt-5-codex is rejected for ChatGPT-account auth).
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (explicitModel) args.push("--model", explicitModel);
    // Sandbox: full-access opts into the dangerous bypass; otherwise workspace-write.
    // `--approval` is not a valid `codex exec` flag in current CLI versions.
    if (this.config.approvalMode === "full-access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--sandbox", "workspace-write");
    }

    const child = spawn(bin, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSafeEnv(),
    });
    this.activeChildren.set(sessionKey, child);
    this.sessionState.set(sessionKey, {
      aborted: false,
      startedAt: Date.now(),
      runningTools: new Map(),
    });

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
    }, MESSAGE_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeout);
      this.activeChildren.delete(sessionKey);
      try { rl.close(); } catch {}

      const state = this.sessionState.get(sessionKey);
      this.sessionState.delete(sessionKey);
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
      this.activeChildren.delete(sessionKey);
      this.sessionState.delete(sessionKey);
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

    const model = this.config.model ?? DEFAULT_MODEL;
    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    return new Promise<CompletionResult>((resolve, reject) => {
      const child = spawn(bin, ["exec", "--model", model], {
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
      const { readFileSync } = require("fs");
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
}
