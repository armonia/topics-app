/** Browser pane tools: open, close, list and focus panes, Chrome import, and the generic browser_* bridge. */
import { READ_ONLY_BROWSER_ENDPOINTS } from "../browser-tool-spec";
import { bridgeAuthHeaders, httpJson, lostRequestError, loopbackInit, REQUEST_TIMEOUT_MS } from "./topics-http";
import type { ParsedArgs } from "./topics-http";

export async function callOpenBrowserPane(
  args: ParsedArgs,
  toolArgs: { url?: unknown; name?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; title: string; visible: boolean; contextId?: string; media?: string; note?: string; warning?: string }> {
  if (typeof toolArgs?.url !== "string" || !toolArgs.url) {
    throw new Error("open_browser_pane: 'url' (string) is required");
  }
  const endpoint = `${args.baseUrl}/api/sessions/${encodeURIComponent(args.sessionKey)}/browser/open-pane`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...bridgeAuthHeaders(args) };

  // `name` viaggia solo se c'è: il body storico è `{url}`, e mandare `name:""`
  // cambierebbe i byte di ogni chiamata esistente per niente.
  const name = typeof toolArgs?.name === "string" ? toolArgs.name.trim() : "";
  let resp: Response;
  try {
    resp = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(name ? { url: toolArgs.url, name } : { url: toolArgs.url }),
      // The same deadline as every other bridge call: this one waits for a pane
      // to attach and for a page to load, both bounded server-side, so an answer
      // that never comes is a lost request and not a slow one. No second send:
      // opening a pane twice is a second tab.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // topics-app serves a self-signed cert on this loopback origin; skip
      // verification (Bun fetch extension). Safe: we only ever talk to 127.0.0.1.
      ...loopbackInit(),
    });
  } catch (err: unknown) {
    throw lostRequestError(err, "POST", "/browser/open-pane");
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`topics-app HTTP ${resp.status}: ${text || resp.statusText}`);
  }
  const body = (await resp.json()) as { url?: unknown; title?: unknown; visible?: unknown; contextId?: unknown; media?: unknown; note?: unknown; warning?: unknown; error?: unknown };
  if (body.error) throw new Error(String(body.error));
  return {
    url: typeof body.url === "string" ? body.url : toolArgs.url,
    title: typeof body.title === "string" ? body.title : "",
    // Assente (server più vecchio del flag) ⇒ si tiene il messaggio storico:
    // meglio non dire niente che dire «invisibile» a un server che non lo sa.
    visible: body.visible !== false,
    // Absent from a server older than BROWSER-CHAT-05: then the text simply
    // does not name it, and the chat falls back to the topic's own context.
    ...(typeof body.contextId === "string" && body.contextId ? { contextId: body.contextId } : {}),
    ...(typeof body.media === "string" && body.media ? { media: body.media } : {}),
    ...(typeof body.note === "string" && body.note ? { note: body.note } : {}),
    // The foreign-port / no-response check (task f9cf765e): present only when
    // there IS something to say, so a plain open keeps its plain result shape.
    ...(typeof body.warning === "string" && body.warning ? { warning: body.warning } : {}),
  };
}

export async function callCloseBrowserPane(
  args: ParsedArgs,
  toolArgs: { contextId?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body: Record<string, unknown> = {};
  if (typeof toolArgs?.contextId === "string" && toolArgs.contextId) body.contextId = toolArgs.contextId;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/browser/close-pane`;
  const resp = await httpJson<{ ok?: boolean; contextId?: string; error?: string }>(
    args, "POST", path, body, fetchImpl,
  );
  return `Closed browser pane${resp?.contextId ? ` (context ${resp.contextId})` : ""}`;
}

export async function callListBrowserTabs(
  args: ParsedArgs,
  _toolArgs: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/browser/list-tabs`;
  const body = await httpJson<{ tabs?: unknown[] }>(args, "POST", path, {}, fetchImpl);
  return JSON.stringify(body?.tabs ?? [], null, 2);
}

export async function callFocusBrowserTab(
  args: ParsedArgs,
  toolArgs: { contextId?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const reqBody: Record<string, unknown> = {};
  if (typeof toolArgs?.contextId === "string" && toolArgs.contextId) reqBody.contextId = toolArgs.contextId;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/browser/focus-pane`;
  const resp = await httpJson<{ ok?: boolean; contextId?: string; error?: string }>(
    args, "POST", path, reqBody, fetchImpl,
  );
  return `Focused browser pane${resp?.contextId ? ` (context ${resp.contextId})` : ""}`;
}

export async function callImportChrome(
  args: ParsedArgs,
  toolArgs: { domains?: unknown; profile?: unknown; dry_run?: unknown; browser?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const domains = Array.isArray(toolArgs?.domains) ? toolArgs.domains.map(String) : [];
  const profile = typeof toolArgs?.profile === "string" ? toolArgs.profile : undefined;
  const dryRun = !!toolArgs?.dry_run;
  const browser = typeof toolArgs?.browser === "string" ? toolArgs.browser : undefined;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/browser/import-chrome`;
  const body = await httpJson<Record<string, unknown>>(args, "POST", path, { domains, profile, dry_run: dryRun, browser }, fetchImpl);
  return JSON.stringify(body ?? {}, null, 2);
}

/**
 * Generic bridge for the ref-based browser tools (observe/act/extract/get_text/
 * screenshot/eval and, later, read_screen/save_state/load_state). Forwards the
 * tool args verbatim to /api/sessions/:key/browser/:endpoint — the server-side
 * handler validates. One function for all of them keeps the 3 surfaces in sync.
 */
export async function callBrowserBridge(
  args: ParsedArgs,
  toolArgs: Record<string, unknown>,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/browser/${endpoint}`;
  // These are all POSTs, so the method says nothing about repeatability: what
  // says it is the tool's own `readOnly` flag, the same one the MCP annotation
  // comes from. Observing twice costs a snapshot; clicking twice costs a click
  // nobody asked for, so `act` and friends are never re-sent.
  const body = await httpJson<Record<string, unknown>>(
    args, "POST", path, toolArgs, fetchImpl, undefined,
    { retryOnLostRequest: READ_ONLY_BROWSER_ENDPOINTS.has(endpoint) },
  );
  return JSON.stringify(body ?? {}, null, 2);
}
