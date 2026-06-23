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
  handleBrowserGetText,
  handleBrowserEval,
  handleBrowserReadScreen,
  handleBrowserSaveState,
  handleBrowserLoadState,
  handleBrowserScreenshot,
  handleBrowserPoint,
  handleBrowserImportChrome,
} from "./browser-tools-handler";
import type { BrowserActAction } from "./browser-tools";

export type ToolCallArgs = Record<string, unknown>;

/**
 * Human-readable, present-tense label for what a browser_* tool call is doing,
 * surfaced to the user via the agent_active overlay (e.g. "Clicca", "Naviga su
 * example.com", "Legge la pagina"). Best-effort: never throws on odd args.
 */
export function describeBrowserAction(toolName: string, args: ToolCallArgs): string {
  const host = (u: unknown): string => {
    if (typeof u !== "string" || !u) return "";
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
  };
  switch (toolName) {
    case "browser_open": {
      const h = host(args.url);
      return h ? `Naviga su ${h}` : "Naviga";
    }
    case "browser_observe":
      return "Osserva la pagina";
    case "browser_act": {
      const a = typeof args.action === "string" ? args.action : "";
      switch (a) {
        case "click": return "Clicca";
        case "type":
        case "fill": return "Scrive";
        case "scroll": return "Scorre la pagina";
        case "press": return args.key ? `Preme ${String(args.key)}` : "Preme un tasto";
        default: return "Interagisce";
      }
    }
    case "browser_get_text": return "Legge il testo";
    case "browser_eval": return "Esegue uno script";
    case "browser_extract": return "Estrae dati";
    case "browser_read_screen": return "Legge lo schermo";
    case "browser_save_state": return "Salva la sessione";
    case "browser_load_state": return "Ripristina la sessione";
    case "browser_screenshot": return "Cattura uno screenshot";
    case "browser_point": return "Individua un elemento";
    case "browser_import_chrome": return "Importa i login da Chrome";
    default: return "Al lavoro";
  }
}

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
  return dispatchBrowserToolCallByContext(
    toolName,
    args,
    resolveContextIdForTopic(topic),
    browserService,
  );
}

/**
 * Same as `dispatchBrowserToolCall` but keyed on a raw BrowserService/CDP
 * contextId instead of a Topic. Used by the MCP bridge routes so a session
 * that is NOT a chat topic (a Claude Code *terminal* tab, whose pane is
 * registered under `term-<terminalId>`) can drive the very same pane. The
 * handlers already resolve CDP-vs-Playwright purely by contextId, so this is
 * the honest seam — no synthetic Topic needed.
 */
export async function dispatchBrowserToolCallByContext(
  toolName: string,
  args: ToolCallArgs,
  contextId: string,
  browserService: BrowserService,
): Promise<unknown> {
  // Label the in-flight action for the agent_active overlay. The handler's
  // withLock broadcasts agent_active=true synchronously on entry (just after
  // this), reading this hint; the finally clears it. Optional-chained on purpose:
  // this is a best-effort UX side-effect, so a partial/legacy service (or a test
  // mock) without setAgentAction must never break actual tool dispatch.
  browserService.setAgentAction?.(contextId, describeBrowserAction(toolName, args));
  switch (toolName) {
    case "browser_open":
      // Args validated by handler
      return handleBrowserOpen(browserService, contextId, args as { url: string });
    case "browser_observe":
      // Args validated by handler
      return handleBrowserObserve(browserService, contextId, args as { full?: boolean; max?: number; max_elements?: number; screenshot?: boolean });
    case "browser_act":
      // Args validated by handler
      return handleBrowserAct(browserService, contextId, args as { ref?: number; element_id?: number; action: BrowserActAction; text?: string; value?: string; key?: string; dy?: number });
    case "browser_extract":
      // Args validated by handler
      return handleBrowserExtract(browserService, contextId, args as { fields?: Record<string, unknown>; schema?: Record<string, unknown> });
    case "browser_get_text":
      // Args validated by handler
      return handleBrowserGetText(browserService, contextId, args as { ref?: number; max?: number });
    case "browser_eval":
      // Args validated by handler
      return handleBrowserEval(browserService, contextId, args as { expression: string });
    case "browser_read_screen":
      // Args validated by handler
      return handleBrowserReadScreen(browserService, contextId, args as { question?: string; full_page?: boolean });
    case "browser_save_state":
      // Args validated by handler
      return handleBrowserSaveState(browserService, contextId, args as { handle?: string });
    case "browser_load_state":
      // Args validated by handler
      return handleBrowserLoadState(browserService, contextId, args as { handle?: string; from_jarvis?: boolean });
    case "browser_screenshot":
      // Args validated by handler
      return handleBrowserScreenshot(browserService, contextId, args as { full_page?: boolean });
    case "browser_point":
      // Args validated by handler
      return handleBrowserPoint(browserService, contextId, args as { description: string });
    case "browser_import_chrome":
      // Args validated by handler
      return handleBrowserImportChrome(browserService, contextId, args as { domains?: string[]; profile?: string; dry_run?: boolean });
    default:
      return { error: `Unknown browser tool: ${toolName}` };
  }
}
