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

export type BrowserToolName =
  | "browser_open"
  | "browser_observe"
  | "browser_act"
  | "browser_extract"
  | "browser_screenshot"
  | "browser_point"
  | "browser_import_chrome";

export type BrowserActAction = "click" | "type" | "select";

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

export interface AgentObserveResponse {
  /** Result of page.accessibility.snapshot() (string-formatted). */
  a11y_tree: string;
  /** Base64 JPEG with bbox overlay + numbered labels. */
  screenshot_annotated: string;
  /** Up to max_elements indexed elements (default 50, range 1-100). */
  elements: IndexedElement[];
  /** page.url() at observe time. */
  url: string;
  /** page.title() at observe time. */
  title: string;
}

export interface BrowserPointInput {
  description: string;
}

export const browserTools: Tool[] = [
  {
    name: "browser_open",
    description:
      "Navigate the browser to a URL. Opens or reuses the topic's browser context. Returns final URL + title after navigation. Use this as the entry point for any browser interaction.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute URL to navigate to (e.g. https://example.com). Must include protocol.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_observe",
    description:
      "Returns the current page state for agent reasoning: { a11y_tree, screenshot_annotated (base64 jpeg with numbered bounding boxes 1-N), elements }. Use this BEFORE browser_act to discover element_ids. Indexes interactive elements only -- max 50 by default.",
    input_schema: {
      type: "object",
      properties: {
        max_elements: {
          type: "number",
          description:
            "Maximum number of indexed elements to return (default 50, clamped to range 1-100).",
        },
      },
      required: [],
    },
  },
  {
    name: "browser_act",
    description:
      "Perform an action on an indexed element from the latest browser_observe call. element_id is the integer N shown in the annotated screenshot bbox label. action is one of click/type/select. For 'type', text is required. Throws if element_id is invalid or stale (re-call browser_observe to refresh).",
    input_schema: {
      type: "object",
      properties: {
        element_id: {
          type: "number",
          description:
            "1-based id of the element from the latest browser_observe response.",
        },
        action: {
          type: "string",
          enum: ["click", "type", "select"],
          description: "The interaction to perform on the element.",
        },
        text: {
          type: "string",
          description:
            "Text to type (when action='type') or option to select (when action='select').",
        },
      },
      required: ["element_id", "action"],
    },
  },
  {
    name: "browser_extract",
    description:
      "Extract structured data from the current page matching a JSON-Schema subset. Use this to scrape information once you have navigated and observed the right page. MVP returns a discovery payload (a11y snapshot + schemaEcho + page metadata); full LLM-driven extraction is a follow-up.",
    input_schema: {
      type: "object",
      properties: {
        schema: {
          type: "object",
          description:
            "JSON Schema subset describing the desired output shape. Echoed back in the response.",
        },
        instruction: {
          type: "string",
          description: "Optional natural-language guidance for extraction.",
        },
      },
      required: ["schema"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a JPEG screenshot of the current viewport. Returns { format, data: base64, viewport }. Use this when you need a clean snapshot WITHOUT bbox annotations.",
    input_schema: {
      type: "object",
      properties: {
        full_page: {
          type: "boolean",
          description:
            "If true, capture the full scrollable page instead of the viewport. Default false.",
        },
      },
      required: [],
    },
  },
  {
    name: "browser_point",
    description:
      "Vision fallback: locate an element by natural-language description using Moondream cloud API and click it. Use ONLY when browser_observe returned <3 indexed elements (canvas, captcha, cross-origin iframe). Subject to per-context budget (MOONDREAM_MAX_CALLS_PER_TASK, default 5). Returns structured error if MOONDREAM_API_KEY is unset.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "Natural-language description of the target element (e.g. 'the blue Submit button', 'the captcha checkbox').",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "browser_import_chrome",
    description:
      "Sign the topic's browser into sites the user is ALREADY logged into in their real Chrome, by importing those cookies (macOS) — no per-site sign-in. Reads ONLY cookies, never saved passwords; the one-time macOS Keychain prompt is the user's consent. Open the browser pane (browser_open) first, then import. Call with dry_run:true to list which hosts are importable (no prompt); then pass the specific domains to import. Use when the user wants to reuse existing logins rather than signing in manually. (Note: a fresh sign-in/registration is a different flow — open the page in the pane and let the user complete it; it persists.)",
    input_schema: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "string" },
          description:
            'Hostnames to import cookies for, e.g. ["youtube.com","github.com"]. Required unless dry_run is true.',
        },
        dry_run: {
          type: "boolean",
          description:
            "If true, only list importable hosts + cookie counts (no Keychain prompt, no values).",
        },
        profile: {
          type: "string",
          description: "Chrome profile directory name (default 'Default').",
        },
      },
      required: [],
    },
  },
];

export function getBrowserToolByName(name: string): Tool | undefined {
  return browserTools.find((t) => t.name === name);
}
