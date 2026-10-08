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
import { COMPARE_MAX_OPTIONS, COMPARE_MIN_OPTIONS } from "../../shared/views";

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

export const SHOW_VIEW_TOOL = {
  name: "show_view",
  description:
    `Show the human a designed, interactive view IN THIS CHAT instead of a markdown table or a hand-made HTML page. Today one view: 'compare', for ${COMPARE_MIN_OPTIONS}-${COMPARE_MAX_OPTIONS} options to choose between (stays, flights, products, vendors, plans) with photos, price, pros/cons, comparable metrics and a recommendation. Topics draws it with its own components (dark/light theme, phone layout) and returns the address of the same view as a standalone page. Never write HTML for a comparison: call this. After it, write only the verdict in one or two lines, do not repeat the table in prose. Open the page in the browser pane only if the human asked for a page.`,
  inputSchema: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["compare"], description: "Which view. Default 'compare'." },
      title: { type: "string", description: "What is being compared, with the key constraint: 'Sitges, 19-21 Oct, 2 nights for 2'." },
      subtitle: { type: "string", description: "Optional one line under the title (what prices include, where data comes from)." },
      verdict: { type: "string", description: "One sentence: which option and why. Shown above the options." },
      options: { type: "array", minItems: COMPARE_MIN_OPTIONS, maxItems: COMPARE_MAX_OPTIONS, items: OPTION_ITEM },
    },
    required: ["title", "options"],
  },
  // It changes nothing in the person's world: it stores a page of data and
  // draws it. Declared read-only so a chat in plan mode ("ask first") can still
  // SHOW options, which is exactly when it needs to (same reasoning as
  // ask_user_question). Not idempotent: each call is a new page.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: "Show a view in the chat" },
};

interface ShowViewResp { id?: string; path?: string }

export async function callShowView(
  args: ParsedArgs,
  toolArgs: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
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
  const n = Array.isArray(toolArgs?.options) ? toolArgs.options.length : 0;
  return `shown in chat · compare · ${n} options · page ${args.baseUrl}${res.path}`;
}
