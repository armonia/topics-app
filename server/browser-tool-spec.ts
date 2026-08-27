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

/**
 * Le annotazioni MCP di un tool (`tools/list` → `annotations`).
 *
 * `readOnlyHint` è la sola che cambia il comportamento della CLI: in
 * `--permission-mode plan` passano SOLO i tool che si dichiarano di sola
 * lettura. Le altre tre sono descrittive e viaggiano insieme perché un
 * client che le legge non debba indovinarle.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface BrowserToolSpec {
  name: string;
  description: string;
  schema: JsonSchema;
  surfaces: { passthrough: boolean; mcp: boolean };
  /**
   * Il tool GUARDA e basta, senza cambiare la pagina né lo stato dell'app.
   *
   * Non è documentazione: è la riga che la CLI legge in `--permission-mode
   * plan` per decidere se un tool MCP può girare. Senza, una chat in «ask»
   * (= plan) non può nemmeno LEGGERE — è il difetto del task `46480579`.
   * Proiettato in `annotations.readOnlyHint` da `mcpBrowserTools()`.
   *
   * Il campo è OBBLIGATORIO di proposito: un tool nuovo non può restare muto
   * e finire di default nella metà sbagliata. Chi lo aggiunge decide.
   *
   * Nota su `screenshot`/`read_screen`: scrivono un file di cattura, ma non
   * toccano né la pagina né lo stato dell'app — l'artefatto È il modo in cui
   * l'osservazione torna indietro (un base64 in contesto sarebbe inusabile).
   * Restano osservazione, quindi read-only.
   */
  readOnly: boolean;
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
    readOnly: false,
  },
  {
    name: "browser_observe",
    description:
      "Read the pane as a compact ref-based accessibility snapshot — lines like `[3] button \"Sign in\"`. Use those [ref] numbers with browser_act. INCREMENTAL by default (only what changed since the last observe — ~0 tokens when stable); pass full:true for the complete list. No screenshot by default (you already see the pane); pass screenshot:true to also get an image, which comes back as a FILE PATH (`screenshot_path`), never as pixels in your context.",
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
          description: "Also capture the pane to a file and return its path in `screenshot_path` (default off). `screenshot_boxes` tells you whether the numbered boxes are drawn on it.",
        },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
    readOnly: true,
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
    readOnly: false,
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
    readOnly: true,
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
    readOnly: true,
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of the pane and SAVE IT TO A FILE — returns { format, path, bytes, viewport }, never the raw image. `path` is an absolute file you can feed to the `moondream <path>` CLI or the Read tool. The image is NOT put in your context (a base64 blob would be tens of thousands of unusable tokens). To just SEE/describe what's rendered, prefer browser_read_screen (one call, returns text — no file, no pixels to handle).",
    schema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture the full scrollable page (default false)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
    readOnly: true,
  },
  {
    name: "browser_read_screen",
    description:
      "The DEFAULT way to visually check a page: SEE the current pane via a vision model and get a TEXT description/answer back — WITHOUT loading any image into your context and WITHOUT any file to decode. Pass `question` for a specific query (e.g. \"is the layout correct?\", \"is there a captcha?\", \"what's the error?\"), else you get a caption. Prefer this over browser_screenshot for any \"does it look right / what's on screen\" check; reach for browser_screenshot only when you genuinely need the raw image file.",
    schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Specific question about the screen; omit for a caption." },
        full_page: { type: "boolean", description: "Capture the full scrollable page (default false)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
    readOnly: true,
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
    readOnly: true,
  },
  {
    name: "browser_network",
    description:
      "Read the network requests the pane has made (method, url, type, status, duration, failure). Use when the UI 'does nothing': see the call that fired, the 401, the request that never came back — instead of guessing from pixels. Defaults to DATA requests only (xhr/fetch/document/websocket) and the 50 most recent: images and fonts are noise. Returns { entries:[…], shown, recorded, failures }.",
    schema: {
      type: "object",
      properties: {
        url_contains: { type: "string", description: "Keep only URLs containing this (case-insensitive)." },
        types: { type: "array", items: { type: "string" }, description: "Resource types to keep (xhr, fetch, document, image, font, …). Omit for data requests only." },
        only_failures: { type: "boolean", description: "Only what went wrong: status >= 400 or never answered." },
        limit: { type: "number", description: "Max entries, most-recent kept (default 50)." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: true },
    readOnly: true,
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
    readOnly: false,
  },
  {
    name: "browser_save_state",
    description:
      "Export this pane's authenticated state (cookies + localStorage) under a handle — a PORTABLE login cache that browser_load_state and a configured external browser tool can reuse. Save right after a login while still ON the site; pass extra `origins` for token-in-localStorage SPAs (Firebase/Supabase/Auth0).",
    schema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Name to store the login under (reusable here and by an external browser tool)." },
      },
      required: ["handle"],
    },
    surfaces: { passthrough: true, mcp: true },
    readOnly: false,
  },
  {
    name: "browser_load_state",
    description:
      "Seed this pane from a saved login handle (injects cookies + localStorage, then returns to the page — now logged in). Reuse an existing local login cache without re-authenticating. Set from_external:true to load a handle saved by a configured external browser tool.",
    schema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "A saved login handle to inject." },
        from_external: { type: "boolean", description: "Load from an external browser tool's saved state of this handle." },
      },
      required: ["handle"],
    },
    surfaces: { passthrough: true, mcp: true },
    readOnly: false,
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
    readOnly: false,
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
        browser: { type: "string", enum: ["chrome", "dia", "arc", "chromium"], description: "Which Chromium-family browser to read cookies from (default 'chrome'). Use this when the user is signed in on a different browser — e.g. Dia." },
      },
      required: [],
    },
    surfaces: { passthrough: true, mcp: false },
    readOnly: false,
  },
  {
    name: "browser_status",
    description:
      "Report the pane's current state: { url, title, viewport: {width,height}, loading, lastDialog? }. `lastDialog` appears when an alert/confirm/prompt showed up: it is auto-closed (an unhandled dialog freezes every later event on the page) but reported here, so 'nothing happens after I click' has an answer instead of a silence. Use to confirm where the pane is, read its REAL viewport size (e.g. before responsive checks), or poll whether a navigation has finished.",
    schema: { type: "object", properties: {}, required: [] },
    surfaces: { passthrough: true, mcp: true },
    readOnly: true,
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
    readOnly: false,
  },
];

/**
 * Optional `contextId` argument injected into every MCP browser tool at
 * projection time (see `mcpBrowserTools`) so the agent can target a DIFFERENT
 * pane than its own — the one thing that turns these from "my pane" tools into
 * "any tab" tools. Injected once here rather than hand-added to all 11 specs:
 * zero per-tool drift, and the passthrough surface (SDK chat, topic-bound by
 * design) intentionally never gets it. Pure data — keeps this module import-free.
 */
export const CONTEXT_ID_PROP = {
  type: "string",
  description:
    "Optional: target a DIFFERENT browser pane by its contextId (get one from browser_list_tabs). Omit to use this session's own pane.",
} as const;

/** Map a `browser_*` tool name to its REST endpoint slug (kebab, no prefix). */
export function toolNameToEndpoint(name: string): string {
  return name.replace(/^browser_/, "").replace(/_/g, "-");
}

/** Browser tools bridged generically over REST (endpoint slug → tool name). */
export const BRIDGED_BROWSER_ENDPOINTS: Record<string, string> = Object.fromEntries(
  BROWSER_TOOL_SPECS.filter((s) => s.surfaces.mcp).map((s) => [
    toolNameToEndpoint(s.name),
    s.name,
  ]),
);

/** Project to the MCP `tools/list` shape (name, description, inputSchema).
 *  Every MCP tool gets the optional `contextId` arg injected (CONTEXT_ID_PROP)
 *  so it can target any tab; `required` is untouched (contextId is optional).
 *  `readOnly` diventa `annotations.readOnlyHint`: è ciò che permette a una chat
 *  in «ask» (= `--permission-mode plan`) di GUARDARE una pagina senza poterla
 *  toccare. `openWorldHint` è true perché questi tool leggono il web vivo. */
export function mcpBrowserTools(): Array<{
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: McpToolAnnotations;
}> {
  return BROWSER_TOOL_SPECS.filter((s) => s.surfaces.mcp).map((s) => ({
    name: s.name,
    description: s.description,
    annotations: {
      readOnlyHint: s.readOnly,
      destructiveHint: false,
      idempotentHint: s.readOnly,
      openWorldHint: true,
    },
    inputSchema: {
      ...s.schema,
      properties: { ...s.schema.properties, contextId: CONTEXT_ID_PROP },
    },
  }));
}
