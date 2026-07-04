/**
 * Phase 30 BROWSER-CHAT-03 -- Native browser tool definitions.
 *
 * 6 tools exposed to chat agents via REST endpoints under
 * /api/browsers/:id/agent/* (see server/routes/browser.ts) and via the
 * provider-level wiring in plan 30-04 (Anthropic Tool[] passthrough,
 * OpenAI {type:'function', function:{...}} wrap).
 *
 * Tool shape verified against @anthropic-ai/sdk 0.86.1 +
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use:
 *   { name: string; description: string;
 *     input_schema: { type: 'object'; properties: ...; required: string[] } }
 *
 * Handlers live in server/browser-tools-handler.ts.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { BROWSER_TOOL_SPECS } from "./browser-tool-spec";
import { ACT_ACTIONS } from "../shared/browser-snapshot-core";

export type BrowserToolName =
  | "browser_open"
  | "browser_observe"
  | "browser_act"
  | "browser_extract"
  | "browser_get_text"
  | "browser_screenshot"
  | "browser_read_screen"
  | "browser_eval"
  | "browser_save_state"
  | "browser_load_state"
  | "browser_point"
  | "browser_import_chrome"
  | "browser_upload"
  | "browser_status";

// Derived from the SHARED action set so this type can't drift from the runtime
// validators (native + server) — one source for the whole browser_act surface.
export type BrowserActAction = (typeof ACT_ACTIONS)[number];

/** Indexed interactive element discovered by browser_observe DOM walker. */
export interface IndexedElement {
  /** 1-based index. Stable until the next browser_observe call. */
  id: number;
  /** ARIA role or fallback to lowercased tagName. */
  role: string;
  /** Best human-readable name (aria-label > title > truncated innerText). */
  name: string;
  /** Page-relative bounding box (CSS pixels). */
  bbox: { x: number; y: number; width: number; height: number };
  /** Truncated innerText (max 200 chars). */
  text?: string;
  tagName: string;
}

/**
 * Anthropic Tool[] for passthrough (claude/openai SDK) chat. Projected from the
 * single source of truth in browser-tool-spec.ts so the passthrough, MCP, and
 * REST surfaces can never drift. Filtered to the passthrough surface.
 */
export const browserTools: Tool[] = BROWSER_TOOL_SPECS.filter(
  (s) => s.surfaces.passthrough,
).map((s) => ({
  name: s.name,
  description: s.description,
  input_schema: s.schema as Tool["input_schema"],
}));
