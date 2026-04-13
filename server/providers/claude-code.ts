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
import { readdirSync, existsSync } from "fs";
import type {
  AIProvider,
  ChatMessage,
  CompletionResult,
  ProviderCapability,
  StreamHandler,
} from "./types";

// ============ Config ============

export interface ClaudeCodeProviderConfig {
  type: "claude-code";
  model?: string;           // defaults to "claude-sonnet-4-6"
  permissionMode?: string;  // defaults to "bypassPermissions"
  defaultWorkspace?: string; // defaults to HOME
}

// ============ Constants ============

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;      // 2 hours
const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;        // 30 min
const RATE_LIMIT_GRACE_MS = 10_000;               // 10s grace after rate limit detection
const KILL_GRACE_MS = 3_000;                       // 3s between SIGTERM and SIGKILL

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
  /** Active tool calls being tracked */
  activeToolCalls: Set<string>;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
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
  ): Promise<{ runId?: string }> {
    // Serial queue: prevent concurrent stdin writes per session
    const prev = this.queues.get(sessionKey) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const myTurn = new Promise<void>((r) => { resolveQueue = r; });
    this.queues.set(sessionKey, prev.then(() => myTurn));
    await prev;

    try {
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

    // Build NDJSON message
    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
    }) + "\n";

    // Set up message timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("TIMEOUT")), MESSAGE_TIMEOUT_MS);
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
    } catch (err: any) {
      const errMsg = err?.message ?? "";
      pp.streamHandler = null;
      pp.pendingResolve = null;
      pp.pendingReject = null;

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

    const args = [
      "--print",
      "--permission-mode", permissionMode,
      "--verbose",
      "--model", model,
      "--setting-sources", "user,project,local",
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
        reject(err);
      });

      proc.stdin!.write(prompt);
      proc.stdin!.end();
    });
  }

  // --- Abort ---

  async abort(sessionKey: string, _runId?: string): Promise<void> {
    const pp = this.processes.get(sessionKey);
    if (!pp || !pp.alive) return;

    // SIGINT cancels the current turn without killing the process
    try {
      pp.proc.kill("SIGINT");
    } catch {}

    // Clean up pending state
    if (pp.streamHandler) {
      pp.streamHandler.onAborted?.();
      pp.streamHandler = null;
    }
    pp.pendingResolve = null;
    pp.pendingReject = null;
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

    console.log(`[claude-code] Spawning persistent process for ${sessionKey}`);
    const pp = this.spawnPersistentProcess();
    this.processes.set(sessionKey, pp);
    return pp;
  }

  private spawnPersistentProcess(): PersistentProcess {
    const model = this.config.model ?? DEFAULT_MODEL;
    const permissionMode = this.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    const args = [
      "--print",
      "--permission-mode", permissionMode,
      "--verbose",
      "--model", model,
      "--setting-sources", "user,project,local",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ];

    const env = buildSafeEnv();

    const proc = spawn(resolveCliPath(), args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const rl = createInterface({ input: proc.stdout! });

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

    // --- stderr: rate limit detection ---
    let stderrBuf = "";
    proc.stderr!.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);

      const chunk = d.toString();
      if (
        (chunk.includes("rate_limit") || chunk.includes("429") || /overloaded/i.test(chunk)) &&
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
      }

      if (pp.pendingResolve) {
        const resolve = pp.pendingResolve;
        pp.pendingResolve = null;
        pp.pendingReject = null;
        resolve({ runId: "" });
      }
      return;
    }

    // Assistant content events
    if (event.type === "assistant" && Array.isArray(event.content) && handler) {
      for (const block of event.content) {
        if (block.type === "text" && block.text) {
          pp.fullText += block.text;
          handler.onTextDelta(block.text, pp.fullText);
        } else if (block.type === "thinking" && block.thinking) {
          handler.onThinkingDelta?.(block.thinking);
        } else if (block.type === "tool_use") {
          const toolId = block.id ?? crypto.randomUUID();
          pp.activeToolCalls.add(toolId);
          handler.onToolStart(toolId, block.name, block.input);
        } else if (block.type === "tool_result") {
          const toolId = block.tool_use_id ?? "";
          const resultContent = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          handler.onToolResult(toolId, resultContent);
          pp.activeToolCalls.delete(toolId);
        }
      }
    }
  }

  // --- Timer Management ---

  private cleanupTimers(pp: PersistentProcess): void {
    if (pp.inactivityTimer) { clearTimeout(pp.inactivityTimer); pp.inactivityTimer = null; }
    if (pp.lifetimeTimer) { clearTimeout(pp.lifetimeTimer); pp.lifetimeTimer = null; }
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
  }
}
