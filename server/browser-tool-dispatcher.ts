/**
 * Phase 30 BROWSER-CHAT-04 -- Server-side dispatcher for browser_* tool calls.
 *
 * When the LLM emits a tool call with name starting with "browser_",
 * server/routes/topics.ts intercepts it (in onToolStart) and calls
 * dispatchBrowserToolCall here. This calls the canonical handler in
 * server/browser-tools-handler.ts directly (no HTTP roundtrip), so the
 * agent_active broadcast still fires from withLock try/finally.
 */

import type { BrowserService } from "./browser-service";
import type { Topic } from "./types";
import {
  handleBrowserOpen,
  handleBrowserObserve,
  handleBrowserAct,
  handleBrowserExtract,
  handleBrowserScreenshot,
  handleBrowserPoint,
} from "./browser-tools-handler";

export type ToolCallArgs = Record<string, unknown>;

/**
 * Resolve the BrowserService context id for a given topic.
 *   - If topic.browserState.contextId exists, use it (preferred -- set by 30-01 navigate hook)
 *   - Otherwise fall back to topic.id (per-topic isolation pattern from 30-01:
 *     each topic uses its own ID as the contextId; getOrCreateContext upserts on demand)
 */
export function resolveContextIdForTopic(topic: Topic): string {
  return topic.browserState?.contextId ?? topic.id;
}

/**
 * Dispatch a `browser_*` tool call to the canonical handler.
 * Returns the handler's response object (success or { error: string }).
 * Throws ONLY for input validation errors; runtime failures are caught
 * inside the handlers and returned as structured `{ error }`.
 *
 * The `as any` and similar casts at the dispatcher boundary are deliberate:
 * args coming from the LLM are unknown JSON. Each handler performs its own
 * input validation and throws on bad shape (per 30-03 decisions: "Throws are
 * reserved for input validation"). Duplicating Zod here would be redundant
 * with what server/routes/browser.ts already does for the REST surface.
 */
export async function dispatchBrowserToolCall(
  toolName: string,
  args: ToolCallArgs,
  topic: Topic,
  browserService: BrowserService,
): Promise<unknown> {
  const contextId = resolveContextIdForTopic(topic);

  switch (toolName) {
    case "browser_open":
      // Args validated by handler
      return handleBrowserOpen(browserService, contextId, args as { url: string });
    case "browser_observe":
      // Args validated by handler
      return handleBrowserObserve(browserService, contextId, args as { max_elements?: number });
    case "browser_act":
      // Args validated by handler
      return handleBrowserAct(browserService, contextId, args as { element_id: number; action: "click" | "type" | "select"; text?: string });
    case "browser_extract":
      // Args validated by handler
      return handleBrowserExtract(browserService, contextId, args as { schema: Record<string, unknown>; instruction?: string });
    case "browser_screenshot":
      // Args validated by handler
      return handleBrowserScreenshot(browserService, contextId, args as { full_page?: boolean });
    case "browser_point":
      // Args validated by handler
      return handleBrowserPoint(browserService, contextId, args as { description: string });
    default:
      return { error: `Unknown browser tool: ${toolName}` };
  }
}
