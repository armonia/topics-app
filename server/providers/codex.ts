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
  ProviderRequirement,
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

// ============ Provider ============

export class CodexProvider implements AIProvider {
  readonly name = "codex";
  readonly capabilities: Set<ProviderCapability> = new Set([
    "streaming",
    "tools",
    "sessions",
    "abort",
  ]);

  private config: CodexProviderConfig;
  private started = false;
  private activeChildren = new Map<string, ChildProcess>();

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
    options?: { model?: string },
  ): Promise<{ runId?: string }> {
    const bin = resolveCodexBinary();
    if (!bin) {
      handler.onError("Codex CLI not found. Install it and run `codex login`.");
      return { runId: undefined };
    }

    const runId = crypto.randomUUID();
    const model = options?.model ?? this.config.model ?? DEFAULT_MODEL;
    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    // `codex exec --json` is the canonical non-interactive entrypoint.
    // We pass the prompt via stdin to avoid argv length limits.
    const args = ["exec", "--json", "--model", model];
    if (this.config.approvalMode === "full-access") {
      args.push("--approval", "never", "--sandbox", "danger-full-access");
    } else {
      args.push("--approval", "on-request", "--sandbox", "workspace-write");
    }

    const child = spawn(bin, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSafeEnv(),
    });
    this.activeChildren.set(sessionKey, child);

    let fullText = "";
    let fellBackToPlain = false;
    const rl = createInterface({ input: child.stdout! });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Try to parse as Codex JSONL event; fall back to plain text.
      try {
        const event = JSON.parse(trimmed);
        this.routeCodexEvent(event, handler, () => {
          fullText += event.text ?? event.delta ?? "";
        }, fullText);
      } catch {
        fellBackToPlain = true;
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

      if (code === 0) {
        if (fellBackToPlain && fullText.trim()) {
          // Plain-text path already streamed; emit done.
          handler.onDone({ result: fullText.trim() });
        } else {
          handler.onDone();
        }
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
      handler.onError(err.message);
    });

    child.stdin!.write(message);
    child.stdin!.end();

    return { runId };
  }

  // --- Routing for JSONL events from `codex exec --json` ---

  private routeCodexEvent(
    event: any,
    handler: StreamHandler,
    onTextAccum: () => void,
    fullTextRef: string,
  ): void {
    // Codex event format isn't fully stable across versions; handle the
    // common shapes defensively.
    const t = event.type ?? event.kind;

    if (t === "agent_message" || t === "assistant_message" || t === "message") {
      const text = event.text ?? event.content ?? event.message ?? "";
      if (typeof text === "string" && text.length > 0) {
        handler.onTextDelta(text, fullTextRef + text);
      }
      return;
    }

    if (t === "agent_message_delta" || t === "delta" || t === "text_delta") {
      const text = event.text ?? event.delta ?? "";
      if (typeof text === "string" && text.length > 0) {
        handler.onTextDelta(text, fullTextRef + text);
      }
      return;
    }

    if (t === "tool_call" || t === "tool_use" || t === "function_call") {
      const id = event.id ?? event.call_id ?? crypto.randomUUID();
      const name = event.name ?? event.tool ?? "tool";
      handler.onToolStart(id, name, event.arguments ?? event.args);
      return;
    }

    if (t === "tool_result" || t === "function_result") {
      const id = event.id ?? event.call_id ?? "";
      const result = typeof event.output === "string"
        ? event.output
        : JSON.stringify(event.output ?? event.result ?? "");
      handler.onToolResult(id, result);
      return;
    }

    if (t === "error") {
      handler.onError(event.message ?? "Codex error");
      return;
    }

    // Unknown event types are silently ignored (forward-compat).
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

  async abort(sessionKey: string): Promise<void> {
    const child = this.activeChildren.get(sessionKey);
    if (!child) return;
    try { child.kill("SIGINT"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, KILL_GRACE_MS);
    this.activeChildren.delete(sessionKey);
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
    // Hardcoded baseline; we could shell out to `codex models list` once that
    // command's output is stable.
    return ["gpt-5-codex", "gpt-5", "o3-mini"];
  }
}
