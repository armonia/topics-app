/**
 * Single source of truth for the native-browser AGENT tool surface.
 *
 * Three callers project from this one list so they can never drift again:
 *   - server/browser-tools.ts          → Anthropic `Tool[]` for passthrough chat
 *   - server/mcp/topics-mcp-server.ts  → MCP `tools/list` for claude-code CLI
 *   - server/routes/{browser,topics}.ts → REST bridge action validation
 *
 * This module is PURE DATA (no imports) so the dep-light MCP server can import
 * it without dragging in Playwright/DB and blowing its <50ms cold-start.
 *
 * The interaction/read tools (observe/act/extract/get_text/screenshot/
 * read_screen/eval/save_state/load_state) keep the SAME `browser_*` name on
 * every surface. `browser_open`/`browser_import_chrome` are passthrough-only —
 * the MCP server keeps its bespoke `open_browser_pane`/`import_chrome` (they
 * have UI-broadcast / extra-sensitive handlers). `browser_point` is the vision
 * click fallback (passthrough-only).
 */

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface BrowserToolSpec {
  name: string;
  description: string;
  schema: JsonSchema;
  surfaces: { passthrough: boolean; mcp: boolean };
}

export const BROWSER_TOOL_SPECS: BrowserToolSpec[] = [
  {
    name: "browser_open",
    description:
      "Navigate the browser pane to a URL (opens/reuses the topic's pane). Returns the compact ref-based snapshot after load. Entry point for any browser interaction.",
    schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute URL including protocol (e.g. https://example.com).",
        },
      },
      required: ["url"],
    },
    surfaces: { passthrough: true, mcp: false },
  },
  {
    name: "browser_observe",
    description:
      "Read the pane as a compact ref-based accessibility snapshot — lines like `[3] button \"Sign in\"`. Use those [ref] numbers with browser_act. INCREMENTAL by default (only what changed since the last observe — ~0 tokens when stable); pass full:true for the complete list. No screenshot by default (you already see the pane); pass screenshot:true to also get an annotated JPEG.",
    schema: {
      type: "object",
      properties: {
        full: {
          type: "boolean",
          description: "Return the complete element list instead of an incremental diff.",
        },
        max: { type: "number", description: "Max interactive elements (default 200)." },
        max_elements: { type: "number", description: "Deprecated alias for max." },
        screenshot: {
          type: "boolean",
          description: "Also include a base64 annotated screenshot (heavy; default off).",
        },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_act",
    description:
      "Act on the element with the given [ref] from the latest browser_observe. action: click | dblclick | triple_click (select all text in a field) | hover | fill (clear+set text, works on React-controlled inputs) | clear (empty a field) | type (key-by-key) | select (option by value/label) | check | uncheck | press (a key, ref optional) | scroll (page, dy px) | get_text (read element/page). Returns an incremental snapshot diff so you see what changed. Refs reassign on every observe — observe, then act.",
    schema: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Element [ref] from the latest browser_observe." },
        element_id: { type: "number", description: "Deprecated alias for ref." },
        action: {
          type: "string",
          // MUST mirror ACT_ACTIONS in shared/browser-snapshot-core.ts (kept in
          // sync by hand — this module stays import-free for MCP cold-start).
          // The handler accepts all of these; omitting any here makes strict
          // clients (MCP/OpenAI) unable to emit a capability that actually works.
          enum: [
            "click",
            "dblclick",
            "triple_click",
            "hover",
            "fill",
            "clear",
            "type",
            "select",
            "check",
            "uncheck",
            "press",
            "scroll",
            "get_text",
          ],
          description: "The interaction to perform.",
        },
        text: { type: "string", description: "Text for fill/type, or option label for select." },
        value: { type: "string", description: "Option value for select." },
        key: { type: "string", description: "Key for press (Enter, Tab, Escape, ArrowDown, …)." },
        dy: { type: "number", description: "Pixels to scroll vertically (default 600; negative = up)." },
      },
      required: ["action"],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_extract",
    description:
      "Deterministically scrape structured data with CSS selectors — 0 LLM tokens. fields example: {\"title\":\"h1\",\"prices\":{\"selector\":\".price\",\"all\":true},\"link\":{\"selector\":\"a.next\",\"attr\":\"href\"}}.",
    schema: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description:
            'CSS-selector map: value is a selector string, or {selector, attr?, all?}.',
        },
        schema: { type: "object", description: "Deprecated alias for fields (legacy stub shape)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_get_text",
    description:
      "Return readable page text (innerText, truncated). Pass a [ref] to read just that element. Use to READ content; use browser_observe to find actionable elements.",
    schema: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Read only this element (from latest observe); omit for whole page." },
        max: { type: "number", description: "Max characters (default 20000)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a JPEG screenshot of the pane. Returns { format, data (base64), viewport }. To SEE what's rendered, prefer browser_read_screen (lighter, returns text).",
    schema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture the full scrollable page (default false)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_read_screen",
    description:
      "SEE the current pane via a lightweight vision model — returns a TEXT description/answer WITHOUT loading any image into your context. Pass `question` for a specific query (e.g. \"is there a captcha?\", \"what's the error?\"), else you get a caption. Use for charts/images/canvas/captchas the a11y snapshot can't convey.",
    schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Specific question about the screen; omit for a caption." },
        full_page: { type: "boolean", description: "Capture the full scrollable page (default false)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_console",
    description:
      "Read recent page console output (logs, warnings, errors, uncaught exceptions) captured from the pane. Use to DEBUG: see a failed fetch, a thrown error, a framework warning — instead of guessing. Returns { entries:[{level,text}], errors, warnings, total }.",
    schema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["all", "errors", "warnings"], description: "Filter: 'errors' only, 'warnings' (warn+error), or 'all' (default)." },
        limit: { type: "number", description: "Max entries, most-recent kept (default 50)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_eval",
    description:
      "Run JavaScript in the page and return the result (escape hatch for what the other tools can't do). Runs in the page sandbox only — cannot reach the host.",
    schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript to evaluate in the page; returns a JSON-serializable result." },
      },
      required: ["expression"],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_save_state",
    description:
      "Export this pane's authenticated state (cookies + localStorage) under a handle — a PORTABLE login cache that browser_load_state and Jarvis can reuse. Save right after a login while still ON the site; pass extra `origins` for token-in-localStorage SPAs (Firebase/Supabase/Auth0).",
    schema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Name to store the login under (reusable here and by Jarvis)." },
      },
      required: ["handle"],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_load_state",
    description:
      "Seed this pane from a saved login handle (injects cookies + localStorage, then returns to the page — now logged in). Reuse an existing local login cache without re-authenticating. Set from_jarvis:true to load a handle saved by a Jarvis browser session.",
    schema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "A saved login handle to inject." },
        from_jarvis: { type: "boolean", description: "Load from a Jarvis-saved state of this handle." },
      },
      required: ["handle"],
    },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_point",
    description:
      "Vision fallback: locate an element by natural-language description (Moondream) and click it. Use ONLY when browser_observe returned too few elements (canvas, captcha, cross-origin iframe).",
    schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Natural-language description of the target (e.g. 'the blue Submit button')." },
      },
      required: ["description"],
    },
    surfaces: { passthrough: true, mcp: false },
  },
  {
    name: "browser_import_chrome",
    description:
      "Sign the pane into sites the user is ALREADY logged into in their real Chrome, by importing those cookies (macOS) — no per-site sign-in. Reads ONLY cookies, never saved passwords; the one-time Keychain prompt is consent. Open the pane first; call dry_run:true to list importable hosts, then pass domains.",
    schema: {
      type: "object",
      properties: {
        domains: { type: "array", items: { type: "string" }, description: 'Hostnames to import, e.g. ["youtube.com"]. Required unless dry_run.' },
        dry_run: { type: "boolean", description: "Only list importable hosts + counts (no Keychain prompt, no values)." },
        profile: { type: "string", description: "Chrome profile directory name (default 'Default')." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: false },
  },
  {
    name: "browser_status",
    description:
      "Report the pane's current state: { url, title, viewport: {width,height}, loading }. Use to confirm where the pane is, read its REAL viewport size (e.g. before responsive checks), or poll whether a navigation has finished.",
    schema: { type: "object", properties: {}, required: [] },
    surfaces: { passthrough: true, mcp: true },
  },
  {
    name: "browser_upload",
    description:
      "Upload a local file to a file input (<input type=file>) on the page — e.g. attach a CV/résumé or a document to a form. Pass the [ref] of the file input from browser_observe (omit to target the first file input on the page) and the server-accessible file PATH. The file is set on the input and change/input events fire, exactly as if the user had picked it in the OS file dialog. Use for uploads the user asked for; the file must already exist on disk.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the local file to upload (must exist, server-accessible)." },
        ref: { type: "number", description: "The file input's [ref] from the latest browser_observe. Omit to target the first <input type=file>." },
      },
      required: ["path"],
    },
    surfaces: { passthrough: true, mcp: true },
  },
];

/** Map a `browser_*` tool name to its REST endpoint slug (kebab, no prefix). */
export function toolNameToEndpoint(name: string): string {
  return name.replace(/^browser_/, "").replace(/_/g, "-");
}

/** Reverse of toolNameToEndpoint: REST endpoint slug → `browser_*` tool name. */
export function endpointToToolName(endpoint: string): string {
  return "browser_" + endpoint.replace(/-/g, "_");
}

/** Browser tools bridged generically over REST (endpoint slug → tool name). */
export const BRIDGED_BROWSER_ENDPOINTS: Record<string, string> = Object.fromEntries(
  BROWSER_TOOL_SPECS.filter((s) => s.surfaces.mcp).map((s) => [
    toolNameToEndpoint(s.name),
    s.name,
  ]),
);

/** Project to the MCP `tools/list` shape (name, description, inputSchema). */
export function mcpBrowserTools(): Array<{
  name: string;
  description: string;
  inputSchema: JsonSchema;
}> {
  return BROWSER_TOOL_SPECS.filter((s) => s.surfaces.mcp).map((s) => ({
    name: s.name,
    description: s.description,
    inputSchema: s.schema,
  }));
}
