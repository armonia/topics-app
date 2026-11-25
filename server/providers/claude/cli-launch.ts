/**
 * Launching the Claude CLI outside the chat pool: which binary, with which
 * environment, and the one-shot `--print` completion (auto-titles, digests,
 * the SSE fallback) with the parse of its stdout.
 *
 * Moved out of `claude-code.ts` unchanged. Nothing here reads the provider's
 * state: the caller resolves model, permission mode and workspace and passes
 * them in.
 */

import { spawn } from "child_process";
import { join } from "path";
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import type { ChatMessage, CompletionOptions, CompletionResult } from "../types";
import { agentBaseEnv } from "../../lib/agent-env";
import { ASK_TRANSPORT_CEILING_MS } from "../../lib/ask-user-bridge";
import { warnThrottled } from "../../lib/warn-throttled";
import { buildClaudeOneshotArgs } from "./args";
import { MCP_CONFIG_DIR, cleanupMcpConfigForSession, mcpConfigPathForSession } from "../claude-code-session";

/** Longest a one-shot may run, and the chat turn watchdog's window. */
export const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;        // 30 min

// ============ CLI Path Resolution ============

const CLI_VERSIONS_DIR = join(process.env.HOME || "", ".local/share/claude/versions");

export function resolveCliPath(): string {
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
  } catch { /* probe: a stat failure means the launcher is unusable, try the next fallback */ }

  // Last resort: PATH
  return "claude";
}

// ============ Env Sanitization ============

export function buildSafeEnv(): Record<string, string> {
  // The allowlist and the blocklist live in `lib/agent-env.ts`: a `run_command`
  // process gets the same environment, so it runs as it would in this CLI's Bash.
  const env = agentBaseEnv();

  env.JARVIS_SPAWN = "1";

  // The CLI's own patience with an MCP tool call. Its default (30 min) killed a
  // question under a human who took a long lunch ("no response and no progress
  // for 1800s"). The bridge emits `notifications/progress` on every poll leg,
  // which resets this timer in a client that honours it; this is the belt for
  // one that does not, and it costs nothing elsewhere: a tool really stuck is
  // still reaped by the turn watchdog (30 min), which stops ONLY for a question
  // on screen. A question has no lifetime, so the value is the largest delay a
  // JS timer honours: one more millisecond overflows to 1 ms and kills every
  // call at once (see `ASK_TRANSPORT_CEILING_MS`).
  env.MCP_TOOL_TIMEOUT = String(ASK_TRANSPORT_CEILING_MS);

  return env;
}

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
  // The shares and the CLI's own price go back too: the side-call ledger
  // (`usage/side-calls.ts`) needs them to say what a title cost. Without them
  // 1102 card titles on Sonnet (9-12/10, 14.1M tokens written to the one-hour
  // cache) left no trace outside the CLI transcripts.
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const models = resultEvent?.modelUsage && typeof resultEvent.modelUsage === "object" ? Object.keys(resultEvent.modelUsage) : [];
  return {
    content,
    usage: usage ? {
      promptTokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens),
      completionTokens: n(usage.output_tokens),
      cacheReadTokens: n(usage.cache_read_input_tokens),
      cacheCreationTokens: n(usage.cache_creation_input_tokens),
      cacheCreation1hTokens: n(usage.cache_creation?.ephemeral_1h_input_tokens),
      ...(models.length === 1 ? { model: models[0] } : {}),
      ...(typeof resultEvent?.total_cost_usd === "number" ? { costUsd: resultEvent.total_cost_usd } : {}),
    } : undefined,
  };
}

/**
 * The one-shot `complete()` of the provider, after it has resolved the model,
 * the permission mode and the workspace.
 */
export function runOneshotCompletion(
  messages: ChatMessage[],
  options: CompletionOptions | undefined,
  resolved: { model: string; permissionMode: string; workspace: string },
): Promise<CompletionResult> {
  const { model, permissionMode, workspace } = resolved;
  // (stdout parsing lives in parseCompletionStdout, exported for tests)
  // Build a single prompt from all messages
  const prompt = messages
    .map((m) => {
      if (m.role === "system") return `[System]\n${m.content}`;
      if (m.role === "assistant") return `[Assistant]\n${m.content}`;
      return m.content;
    })
    .join("\n\n");

  // One-shot completions (auto-naming, daily digest, SSE fallback) need NO
  // MCP tools — but `claude` otherwise auto-loads the user's entire global
  // ~/.claude.json fleet (incl chrome-devtools' ~1.2GB Chrome) for a single
  // text completion. Pin an EMPTY strict MCP config so this hot path spawns
  // zero servers. Falls back to legacy (no scoping) only if the temp write
  // fails; the file is removed when the process exits (cleanup below).
  const oneshotKey = `oneshot-${crypto.randomUUID()}`;
  let emptyMcpConfigPath: string | null = null;
  try {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true });
    const p = mcpConfigPathForSession(oneshotKey);
    writeFileSync(p, JSON.stringify({ mcpServers: {} }, null, 2), { encoding: "utf-8", mode: 0o600 });
    emptyMcpConfigPath = p;
  } catch { /* fall back to no scoping */ }

  // The flags (and why each one is there) live in `claude/args.ts`, under snapshot.
  const args = buildClaudeOneshotArgs({
    permissionMode, model, emptyMcpConfigPath, effort: options?.reasoningEffort, userFacing: options?.userFacing,
  });

  const env = buildSafeEnv();

  return new Promise((resolve, reject) => {
    const ownedGroup = process.platform !== "win32";
    const proc = spawn(resolveCliPath(), args, {
      detached: ownedGroup,
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (ownedGroup && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch { /* Already closed. */ }
    }, Math.min(MESSAGE_TIMEOUT_MS, Math.max(1, options?.timeoutMs ?? MESSAGE_TIMEOUT_MS)));

    proc.on("close", (code) => {
      clearTimeout(timer);
      cleanupMcpConfigForSession(oneshotKey);
      if (timedOut) { reject(new Error("Completion timed out")); return; }
      if (code !== 0) {
        console.warn(`[claude-code] complete() exited with code ${code}: ${stderr.slice(0, 200)}`);
        // Still an answer to the caller (they read the notice), but a failed
        // one for the ledger: the CLI may have spent tokens before dying.
        resolve({ content: `Error: CLI exited with code ${code}`, error: `exit ${code}` });
        return;
      }
      resolve(parseCompletionStdout(stdout));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      cleanupMcpConfigForSession(oneshotKey);
      reject(err);
    });

    // A CLI that exits BEFORE reading the prompt leaves us writing into a
    // closed pipe, and the EPIPE surfaces ASYNCHRONOUSLY as the stream tears
    // down: it is raised inside `end()`, not inside `write()`, so no
    // try/catch around the write can ever see it. With no listener on this
    // stream it becomes an unhandled exception and Bun kills the WHOLE
    // server process.
    //
    // Observed in CI (run 33030011608): the test server died mid-run and
    // took ~200 never-started tests down with it. A CLI exiting early is
    // ordinary (startup crash, wrong binary, --version), not a test-bench
    // quirk, so this belongs here and not in the harness. The turn still
    // ends through `close`, which reports the non-zero exit.
    proc.stdin!.on("error", () => { /* CLI is gone; `close` reports it */ });
    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}
