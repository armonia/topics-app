/**
 * `show_view`: THE AGENT SENDS DATA, TOPICS DRAWS IT (GENUI-01).
 *
 * The comparison of three stays in topic:64095902 was a 12 KB HTML page the
 * agent wrote by hand into `~/.topics/media/sitges-alloggi/` and then opened in
 * the browser pane. Every such page is a new design, and none of them follow
 * the app's theme or fit a phone. This tool takes the same content as typed
 * data; the chat draws it with the client's components, and the same data is
 * served as a standalone page at `/v/<id>`.
 *
 * The schema below is what the MODEL reads, so it is written as guidance: the
 * descriptions say when to use the view and what makes it good. The real
 * validation is `normalizeViewSpec` (shared/views.ts), run by the server route;
 * its errors come back as this tool's error so the agent can fix and retry.
 *
 * A module of its own, like `command-tools.ts`, because the bridge file is the
 * dispatcher and `check:bloat` counts its lines. Annotations are spelled out
 * for the same reason given there (importing them back would be a cycle).
 */
import { HttpAnswerError, httpJson, type ParsedArgs } from "./topics-http";
import { COMPARE_MAX_OPTIONS, COMPARE_MIN_OPTIONS, VIEW_ID_RE, viewSummary, type ViewSpec } from "../../shared/views";
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "../../shared/views-table";
import { STEP_MODES, TIMELINE_MAX_ALTERNATIVES, TIMELINE_MAX_STEPS } from "../../shared/views-timeline";
import { MCP_APP_MIME, VIEW_APP_URI, VIEW_META_KEY, renderViewAppShell, viewResourceUri } from "../views/view-html";

const METRIC_ITEM = {
  type: "object",
  properties: {
    label: { type: "string", description: "Short label, the SAME text in every option so they line up (e.g. 'to centre', 'to station')." },
    value: { type: ["number", "string"], description: "A number whenever it is one (12, not '12 min'): numbers are compared across options." },
    unit: { type: "string", description: "Unit shown after the value: 'min', 'km', '€'." },
    better: { type: "string", enum: ["lower", "higher"], description: "Which direction wins. Set it and the best and worst option get marked." },
  },
  required: ["label", "value"],
} as const;

const OPTION_ITEM = {
  type: "object",
  properties: {
    title: { type: "string", description: "The option's name." },
    subtitle: { type: "string", description: "One line of context: kind, source, rating ('Suite in boutique hotel · Airbnb · 4.62 of 101')." },
    price: {
      type: "object",
      description: "Final price, as a number.",
      properties: {
        amount: { type: "number" },
        currency: { type: "string", description: "ISO code, default EUR." },
        note: { type: "string", description: "What the price covers: 'total, 2 nights', 'per month'." },
      },
      required: ["amount"],
    },
    images: {
      type: "array",
      description: "Up to 12 photos, first one is the cover. https URLs or ABSOLUTE local paths (screenshots and downloads you saved are served by Topics).",
      items: {
        type: "object",
        properties: { src: { type: "string" }, caption: { type: "string", description: "2-4 words: 'Sea-view terrace'." } },
        required: ["src"],
      },
    },
    pros: { type: "array", items: { type: "string" }, description: "Up to 8 short, concrete facts in its favour. Bold nothing, no emoji." },
    cons: { type: "array", items: { type: "string" }, description: "Up to 8 short, concrete facts against it." },
    metrics: { type: "array", items: METRIC_ITEM, description: "Up to 8 comparable numbers (minutes on foot, size, rating)." },
    link: {
      type: "object",
      properties: { url: { type: "string", description: "https only." }, label: { type: "string", description: "e.g. 'Open on Booking'." } },
      required: ["url"],
    },
    recommended: { type: "boolean", description: "Mark THE option you would pick, at most one. Say why in `verdict`." },
  },
  required: ["title"],
} as const;

const PRICE = {
  type: "object",
  properties: { amount: { type: "number" }, currency: { type: "string", description: "ISO code, default EUR." }, note: { type: "string" } },
  required: ["amount"],
} as const;

const COLUMN_ITEM = {
  type: "object",
  properties: {
    label: { type: "string" },
    unit: { type: "string", description: "Shown after numbers; with format 'price' it is the ISO currency." },
    format: { type: "string", enum: ["duration", "price"], description: "'duration': the cells are MINUTES (199 reads '3 h 19'). 'price': the cells are amounts." },
    better: { type: "string", enum: ["lower", "higher"], description: "Set it and the best value of the column is marked." },
    align: { type: "string", enum: ["start", "end"] },
  },
  required: ["label"],
} as const;

const ROW_ITEM = {
  type: "object",
  properties: {
    cells: { type: "array", items: { type: ["string", "number", "null"] }, description: "One per column, in order. null = not known (never guess a value)." },
    note: { type: "string", description: "A short line under the first cell." },
    recommended: { type: "boolean", description: "At most one row." },
    link: { type: "object", properties: { url: { type: "string" }, label: { type: "string" } }, required: ["url"] },
  },
  required: ["cells"],
} as const;

const STEP_ITEM = {
  type: "object",
  properties: {
    day: { type: "string", description: "Heading the step sits under ('Monday 19'). Repeat it on every step of that day." },
    time: { type: "string", description: "HH:MM, 24h." },
    mode: { type: "string", enum: [...STEP_MODES] },
    title: { type: "string", description: "The leg: 'Bus 1149 from T1 to Sitges'." },
    detail: { type: "string" },
    duration: { type: "string", description: "'32 min', '3 h 19'." },
    price: PRICE,
    deadline: { type: "boolean", description: "A limit (be at the gate by...), drawn as such." },
    alternatives: {
      type: "array",
      maxItems: TIMELINE_MAX_ALTERNATIVES,
      description: "Other ways to do the SAME leg (taxi instead of bus).",
      items: { type: "object", properties: { title: { type: "string" }, mode: { type: "string", enum: [...STEP_MODES] }, detail: { type: "string" }, duration: { type: "string" }, price: PRICE }, required: ["title"] },
    },
    link: { type: "object", properties: { url: { type: "string" }, label: { type: "string" } }, required: ["url"] },
  },
  required: ["title"],
} as const;

export const SHOW_VIEW_TOOL = {
  name: "show_view",
  description:
    "Show the human a designed view IN THIS CHAT instead of a markdown table or a hand-made HTML page. Three views:\n" +
    `- 'compare': ${COMPARE_MIN_OPTIONS}-${COMPARE_MAX_OPTIONS} options to choose between (stays, products, vendors) with photos, price, pros/cons, comparable metrics and one recommendation.\n` +
    `- 'table': up to ${TABLE_MAX_ROWS} rows of the same kind read across up to ${TABLE_MAX_COLUMNS} columns (departures, quotes, specs); numeric columns can rank.\n` +
    `- 'timeline': a plan in order, up to ${TIMELINE_MAX_STEPS} steps grouped by day (door-to-door trip, schedule, procedure), with time, means, duration, price and alternatives per leg.\n` +
    "Topics draws it with its own components (dark/light theme, phone layout) and returns the address of the same view as a standalone page. Never write HTML for these: call this. Leave unknown values empty, never guess. After it, write only the verdict in one or two lines, do not repeat the data in prose. Open the page in the browser pane only if the human asked for a page.",
  inputSchema: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["compare", "table", "timeline"], description: "Which view. Default 'compare'." },
      title: { type: "string", description: "What it shows, with the key constraint: 'Sitges, 19-21 Oct, 2 nights for 2'." },
      subtitle: { type: "string", description: "Optional one line under the title (what prices include, where data comes from)." },
      verdict: { type: "string", description: "One sentence: what you would pick and why. Shown above the data." },
      options: { type: "array", minItems: COMPARE_MIN_OPTIONS, maxItems: COMPARE_MAX_OPTIONS, items: OPTION_ITEM, description: "compare only." },
      columns: { type: "array", maxItems: TABLE_MAX_COLUMNS, items: COLUMN_ITEM, description: "table only. The first column names the row." },
      rows: { type: "array", maxItems: TABLE_MAX_ROWS, items: ROW_ITEM, description: "table only." },
      footnote: { type: "string", description: "table only: sources, what is missing and why." },
      steps: { type: "array", maxItems: TIMELINE_MAX_STEPS, items: STEP_ITEM, description: "timeline only, in order." },
    },
    required: ["title"],
  },
  // MCP Apps (SEP-1865): a host that supports it fetches this resource and
  // shows the view the tool result carries in `_meta`, instead of only the
  // text. Both spellings: the nested one is the spec, the flat one is what the
  // earlier hosts read.
  _meta: { ui: { resourceUri: VIEW_APP_URI }, "ui/resourceUri": VIEW_APP_URI },
  // It changes nothing in the person's world: it stores a page of data and
  // draws it. Declared read-only so a chat in plan mode ("ask first") can still
  // SHOW options, which is exactly when it needs to (same reasoning as
  // ask_user_question). Not idempotent: each call is a new page.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: "Show a view in the chat" },
};

interface ViewAppResp { uri: string; mimeType: string; html: string; resourceDomains: string[] }
interface ShowViewResp { id?: string; path?: string; spec?: ViewSpec; app?: ViewAppResp }

/** What `tools/call` answers for show_view: text for the model, the drawn view for an MCP Apps host. */
export interface ShowViewResult {
  text: string;
  structuredContent: { id: string; view: string; page: string };
  _meta: Record<string, unknown>;
}

export async function showView(
  args: ParsedArgs,
  toolArgs: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ShowViewResult> {
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/views`;
  let res: ShowViewResp | undefined;
  try {
    res = await httpJson<ShowViewResp>(args, "POST", path, toolArgs ?? {}, fetchImpl);
  } catch (err) {
    // The route's 400 lists what is wrong, written for the model: pass it on
    // as is, so the retry fixes the right field.
    if (err instanceof HttpAnswerError) throw new Error(`show_view: ${err.message}`);
    throw err;
  }
  if (!res?.id || !res.path) throw new Error("show_view: server did not return a view id");
  const page = `${args.baseUrl}${res.path}`;
  const sum = res.spec ? viewSummary(res.spec) : null;
  const what = sum ? `${sum.kind} · ${sum.count} ${sum.unit}` : String(toolArgs?.view ?? "compare");
  return {
    text: `shown in chat · ${what} · page ${page}`,
    structuredContent: { id: res.id, view: sum?.kind ?? "compare", page },
    // The drawn view rides in `_meta`, which a host hands to the app and not
    // to the model: 30 KB of markup are not tokens anyone should pay for.
    _meta: res.app ? { [VIEW_META_KEY]: { id: res.id, uri: res.app.uri, html: res.app.html, resourceDomains: res.app.resourceDomains } } : {},
  };
}

/** The text-only form, for the native runtime and every caller that reads text. */
export async function callShowView(
  args: ParsedArgs,
  toolArgs: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return (await showView(args, toolArgs, fetchImpl)).text;
}

// MCP resources (GENUI-08): the views as `ui://` documents an MCP Apps host can show.

const appResource = { uri: VIEW_APP_URI, name: "Topics view", description: "Shows the view a show_view call returned.", mimeType: MCP_APP_MIME };

export async function listViewResources(args: ParsedArgs, fetchImpl: typeof fetch = fetch) {
  const res = await httpJson<{ views?: Array<{ id: string; title: string; view: string; createdAt: string }> }>(args, "GET", "/api/views?limit=50", undefined, fetchImpl);
  return {
    resources: [
      appResource,
      ...(res?.views ?? []).map((v) => ({ uri: viewResourceUri(v.id), name: v.title, description: `${v.view} · ${v.createdAt}`, mimeType: MCP_APP_MIME })),
    ],
  };
}

export function listViewResourceTemplates() {
  return {
    resourceTemplates: [{ uriTemplate: `${VIEW_APP_URI}/{id}`, name: "Topics view by id", description: "A view shown in a Topics chat, as a self-contained page.", mimeType: MCP_APP_MIME }],
  };
}

/** `resources/read`: the generic app, or one stored view. Null for a URI that is not ours. */
export async function readViewResource(args: ParsedArgs, uri: string, fetchImpl: typeof fetch = fetch) {
  if (uri === VIEW_APP_URI) {
    return { contents: [{ uri, mimeType: MCP_APP_MIME, text: renderViewAppShell(), _meta: { ui: { prefersBorder: true } } }] };
  }
  const id = uri.startsWith(`${VIEW_APP_URI}/`) ? uri.slice(VIEW_APP_URI.length + 1) : "";
  if (!VIEW_ID_RE.test(id)) return null;
  let app: ViewAppResp | undefined;
  try {
    app = await httpJson<ViewAppResp>(args, "GET", `/api/views/${id}/app`, undefined, fetchImpl);
  } catch (err) {
    if (err instanceof HttpAnswerError && err.status === 404) return null;
    throw err;
  }
  if (!app?.html) return null;
  return {
    contents: [{
      uri, mimeType: MCP_APP_MIME, text: app.html,
      _meta: { ui: { prefersBorder: true, ...(app.resourceDomains.length ? { csp: { resourceDomains: app.resourceDomains } } : {}) } },
    }],
  };
}
