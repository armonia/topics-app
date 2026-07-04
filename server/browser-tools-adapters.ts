/**
 * Phase 30 BROWSER-CHAT-04 — Provider format adapters for browserTools.
 *
 * The canonical schema is Anthropic Tool[] (server/browser-tools.ts).
 * Different providers expect different wire formats:
 *   - Anthropic SDK (claude.ts): passthrough Tool[] directly to messages.stream({ tools })
 *   - OpenAI Chat Completions (openai.ts): wrap each as { type:'function', function: {...} }
 *   - Codex CLI (codex.ts): tools managed by CLI itself; no inline registration
 *   - Claude Code CLI (claude-code.ts): tools managed by CLI; no inline registration
 *   - OpenClaw gateway (openclaw.ts): tools managed by gateway; no inline registration
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";

/** OpenAI Chat Completions tool format (gpt-4o, gpt-4-turbo, o3, etc.). */
export interface BrowserToolForOpenAI {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object; // JSON Schema; OpenAI accepts the same shape as input_schema
  };
}

/**
 * Wrap an Anthropic Tool[] into OpenAI Chat Completions function-calling format.
 * The JSON Schema in `input_schema` is accepted as-is by OpenAI under the
 * `parameters` field, so this is a pure shape adapter (no schema rewrite).
 */
export function toOpenAIFunctions(tools: Tool[]): BrowserToolForOpenAI[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema,
    },
  }));
}

/**
 * Returns true ONLY for providers whose sendChat() implementation supports
 * inline browserTools registration (i.e. the SDK-driven providers, not the
 * CLI/gateway providers that manage their own tool surface).
 *
 *   claude   -> true  (Anthropic SDK Tool[] passthrough)
 *   openai   -> true  (Chat Completions function-calling format)
 *   codex    -> false (CLI tools are managed upstream by the codex binary)
 *   claude-code -> false (CLI tools are managed upstream by claude binary)
 *   openclaw -> false (gateway-managed, agents register tools via the OpenClaw protocol)
 */
export function isPassthroughProvider(name: string): boolean {
  return name === "claude" || name === "openai";
}
