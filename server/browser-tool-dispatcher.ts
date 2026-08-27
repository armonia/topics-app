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
import { nativeDelegateRegistry } from "./browser-native-delegate";
import { isNativeStateOp, nativeStateOp } from "./browser-native-state";
import {
  handleBrowserOpen,
  handleBrowserObserve,
  handleBrowserAct,
  handleBrowserExtract,
  handleBrowserGetText,
  handleBrowserEval,
  handleBrowserReadScreen,
  handleBrowserConsole,
  handleBrowserNetwork,
  handleBrowserSaveState,
  handleBrowserLoadState,
  handleBrowserScreenshot,
  handleBrowserPoint,
  handleBrowserImportChrome,
  handleBrowserUpload,
  handleBrowserStatus,
  writeAgentScreenshot,
  resolveAgentNavUrl,
} from "./browser-tools-handler";
import type { BrowserActAction } from "./browser-tools";
import { describeImage, pointObject } from "./integrations/moondream-client";
import { basename, extname } from "node:path";
import { realpathSync } from "node:fs";
import { checkUploadPath } from "./lib/upload-allowlist";

/**
 * Le radici da cui `browser_upload` può leggere. Le fornisce il boot del server
 * (`setUploadRootsProvider` in server.ts), che è l'unico posto che conosce
 * UPLOADS_DIR, le cartelle media e i progetti registrati.
 *
 * Non wired ⇒ nessuna radice ⇒ si RIFIUTA. Fail-closed di proposito: un
 * provider dimenticato deve rompere l'upload in modo evidente, non riaprire in
 * silenzio la lettura dell'intero disco.
 */
let uploadRootsProvider: (() => string[]) | null = null;
export function setUploadRootsProvider(fn: () => string[]): void {
  uploadRootsProvider = fn;
}

export type ToolCallArgs = Record<string, unknown>;

/** Upload payload: the file already read + base64-encoded server-side (the page —
 *  WKWebView or Playwright — can't read local disk), plus the target input ref. */
export type UploadFile = { ref?: number; dataB64: string; filename: string; mime: string };

const UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // CVs / docs / images; guards huge reads
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".csv": "text/csv", ".json": "application/json", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
};

/** Read + base64-encode the agent-supplied upload file ONCE (both the Tauri
 *  native-delegate path and the CDP/Playwright path need the bytes, not the path,
 *  since neither the WKWebView nor the page can read local disk).
 *
 *  CONFINATO a un'allowlist di radici (lib/upload-allowlist.ts). Prima non lo
 *  era, e il commento che stava qui giustificava la cosa con «the browser REST
 *  bridge is gateway-token gated» — ma il gate fida il loopback SENZA token, per
 *  disegno, quindi sul percorso locale quella mitigazione non esisteva. Il
 *  risultato era che una tool-call con un path qualsiasi faceva leggere al
 *  server un file arbitrario dell'utente e lo caricava su una pagina
 *  raggiungibile (`~/.ssh/id_rsa` sta sotto il cap dei 25 MB).
 *
 *  Il confronto gira sul path REALE (`realpathSync`): senza risolvere, un
 *  symlink piazzato dentro una radice consentita porterebbe fuori con un path
 *  che a stringa è impeccabile. */
async function readUploadFile(args: ToolCallArgs): Promise<UploadFile | { error: string }> {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return { error: "browser_upload: 'path' (string) is required" };
  const ref = typeof args.ref === "number" ? args.ref : undefined;
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return { error: `browser_upload: file not found: ${path}` };
    // Risoluzione PRIMA del controllo, e su un file che esiste già (altrimenti
    // realpathSync solleva e diremmo "fuori radice" per un file mancante).
    let realPath: string;
    try { realPath = realpathSync(path); }
    catch { return { error: `browser_upload: file not found: ${path}` }; }
    const verdict = checkUploadPath(realPath, uploadRootsProvider?.() ?? []);
    if (!verdict.ok) return { error: verdict.error };
    if (f.size > UPLOAD_MAX_BYTES)
      return { error: `browser_upload: file too large (${f.size} bytes > ${UPLOAD_MAX_BYTES})` };
    const dataB64 = Buffer.from(await f.arrayBuffer()).toString("base64");
    const mime = MIME_BY_EXT[extname(path).toLowerCase()] || "application/octet-stream";
    return { ref, dataB64, filename: basename(path), mime };
  } catch (e) {
    return { error: `browser_upload: cannot read ${path}: ${String((e as Error)?.message || e)}` };
  }
}

/**
 * Tauri native pane vision: `browser_read_screen` / `browser_point` have no
 * Playwright `ops` on the WKWebView pane (no CDP), so `handleBrowserReadScreen`
 * / `handleBrowserPoint` can't run. Instead the server orchestrates them: delegate
 * a native screenshot to the pane, run Moondream on it, and (for point) click via
 * `document.elementFromPoint` on the pane. Same Moondream + failsoft model as the
 * CDP/Playwright path — the agent gets the IDENTICAL `{vision}` / `{clicked,point}`
 * result whether the pane is native or streaming.
 */
/**
 * Native-pane `browser_screenshot`: delegate the capture to the WKWebView, then
 * write the PNG to disk server-side and return its PATH — never the base64. The
 * web-pane path (handleBrowserScreenshot) already does this; mirroring it here
 * closes the seam so NEITHER pane type ever floods the agent's context with an
 * un-viewable image blob (the root cause of the compact/stall spiral).
 */
async function nativeScreenshotOp(contextId: string): Promise<unknown> {
  const shot = await nativeDelegateRegistry.delegateOp(contextId, "browser_screenshot", {});
  if (shot && typeof shot === "object" && "error" in shot) return shot; // failsoft
  const data = (shot as { data?: unknown })?.data;
  if (typeof data !== "string" || !data) {
    return { error: "browser_screenshot: native pane returned no image data" };
  }
  const buf = Buffer.from(data, "base64");
  const path = await writeAgentScreenshot(buf, contextId, "png");
  return { format: "png" as const, path, bytes: buf.length };
}

/**
 * Native-pane `browser_observe(screenshot: true)`: the snapshot from the pane's
 * executor, the image from the same delegated capture as `browser_screenshot`.
 * Failsoft on the image: an observe that answered its snapshot is a success, and
 * losing the picture must not turn it into an error.
 */
async function nativeObserveWithShot(contextId: string, args: ToolCallArgs): Promise<unknown> {
  const observed = await nativeDelegateRegistry.delegateOp(contextId, "browser_observe", args);
  if (!observed || typeof observed !== "object" || "error" in observed) return observed;
  const shot = await nativeScreenshotOp(contextId).catch(() => null);
  const path = (shot as { path?: unknown } | null)?.path;
  if (typeof path !== "string") return observed;
  return { ...(observed as Record<string, unknown>), screenshot_path: path, screenshot_boxes: false };
}

async function nativeVisionOp(
  toolName: string,
  args: ToolCallArgs,
  contextId: string,
): Promise<unknown> {
  const shot = await nativeDelegateRegistry.delegateOp(contextId, "browser_screenshot", {});
  if (shot && typeof shot === "object" && "error" in shot) return shot; // failsoft
  const data = (shot as { data?: unknown })?.data;
  const mime = (shot as { mime?: unknown })?.mime;
  if (typeof data !== "string" || !data) {
    return { error: "browser vision: native screenshot failed (no image data)" };
  }
  const imageMime = typeof mime === "string" ? mime : "image/png";

  if (toolName === "browser_read_screen") {
    const question = typeof args?.question === "string" ? args.question : undefined;
    const result = await describeImage({ contextId, imageBase64: data, mime: imageMime, question });
    if ("error" in result) return result;
    return { vision: result.text, question };
  }

  // browser_point
  const description = typeof args?.description === "string" ? args.description : "";
  if (!description.trim()) {
    return { error: "browser_point: 'description' (non-empty string) is required" };
  }
  // CSS viewport of the native pane — Moondream returns normalized coords scaled
  // to this; DPR is irrelevant since the coords are normalized to the image.
  let viewport = { width: 0, height: 0 };
  try {
    const vpRaw = await nativeDelegateRegistry.delegateOp(contextId, "browser_eval", {
      expression: "JSON.stringify({width:innerWidth,height:innerHeight})",
    });
    if (typeof vpRaw === "string") viewport = JSON.parse(vpRaw);
  } catch {
    /* fall through to the fallback viewport */
  }
  if (!(viewport.width > 0 && viewport.height > 0)) viewport = { width: 1280, height: 800 };

  const result = await pointObject({ contextId, imageBase64: data, mime: imageMime, description, viewport });
  if ("error" in result) return result;
  if (!result.points.length) {
    return {
      error: `browser_point: Moondream returned no candidates for "${description}". Try a more specific description, or use browser_observe.`,
    };
  }
  const target = result.points[0];
  // WKWebView has no trusted-input API: resolve the element at the point and
  // click it in-page (best-effort, mirrors the native act path).
  await nativeDelegateRegistry.delegateOp(contextId, "browser_eval", {
    expression: `(function(){var el=document.elementFromPoint(${target.x},${target.y});if(el){el.click();return true}return false})()`,
  });
  return { clicked: true, point: target };
}

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
    case "browser_console": return "Legge la console";
    case "browser_network": return "Legge le richieste di rete";
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
  // Dove va la pane lo si decide QUI, prima di sapere che pane è.
  //
  // `browser_open` su una pane NATIVA non passava da handleBrowserOpen — scende
  // dritto a delegateOp poco sotto — quindi la guardia sugli schemi valeva per
  // il ramo Playwright e non per quello Tauri: stesso tool, stesso agente, due
  // regole. Sul nativo restava a fermarlo solo il nav-guard del Rust, che nega
  // senza dire niente e lascia la pane BIANCA. Un file locale diventa un URL
  // http di /api/media (browser-local-file-url.ts) e tutto il resto incontra la
  // guardia di sempre: un punto solo, prima della biforcazione, per entrambi.
  if (toolName === "browser_open" && typeof args.url === "string") {
    // Alla pane nativa va il RIFERIMENTO relativo: la sua origine è il proxy in
    // chiaro dell'app (13333), non il server in TLS (3333), e solo lei la
    // conosce. All'headless, che naviga da qui, l'assoluto.
    const form = nativeDelegateRegistry.isDelegated(contextId) ? "relative" : "absolute";
    args = { ...args, url: resolveAgentNavUrl(args.url, "browser_open", form) };
  }
  // browser_upload: read the file bytes ONCE here (neither the WKWebView nor the
  // Playwright page can read local disk), then hand the base64 to whichever
  // surface renders the pane — the native executor evals UPLOAD_FN on Tauri, the
  // handler evals it over CDP/Playwright. Same UPLOAD_FN, one code path each.
  if (toolName === "browser_upload") {
    const file = await readUploadFile(args);
    if ("error" in file) return file;
    if (nativeDelegateRegistry.isDelegated(contextId)) {
      return nativeDelegateRegistry.delegateOp(contextId, "browser_upload", file);
    }
    return handleBrowserUpload(browserService, contextId, file);
  }
  // Tauri native pane: this contextId belongs to a real WKWebView the server can't
  // reach via CDP/Playwright. A Tauri client has registered as its executor over
  // /ws/browser, so forward the WHOLE tool-call there and return the client's reply.
  // (Electron/web contexts are never registered, so this is a no-op for them.)
  if (nativeDelegateRegistry.isDelegated(contextId)) {
    // Vision ops have no native executor op — the server runs Moondream on a
    // delegated native screenshot instead of forwarding the whole call.
    if (toolName === "browser_read_screen" || toolName === "browser_point") {
      return nativeVisionOp(toolName, args, contextId);
    }
    // Screenshot: capture natively but persist to disk + return a path (same as
    // the web pane) so the agent never gets a base64 blob it can't view.
    if (toolName === "browser_screenshot") {
      return nativeScreenshotOp(contextId);
    }
    // Observe with `screenshot: true`: the native executor has no annotator, so
    // asking it alone answered a snapshot and NO image, quietly - the caller had
    // no way to tell "opted in" from "got it". The pixels come from the same
    // native capture `browser_screenshot` uses, on disk like every other one;
    // `screenshot_boxes: false` says out loud that the numbered boxes of the web
    // pane are not drawn on this one.
    if (toolName === "browser_observe" && (args as { screenshot?: unknown })?.screenshot === true) {
      return nativeObserveWithShot(contextId, args);
    }
    // Login-state ops split across the seam the same way: handle persistence
    // (Topics + external stores) and Chrome Keychain decryption stay server-side,
    // only the pane-local cookie/localStorage legs are delegated.
    if (isNativeStateOp(toolName)) {
      return nativeStateOp(toolName, args, contextId);
    }
    return nativeDelegateRegistry.delegateOp(contextId, toolName, args);
  }
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
    case "browser_console":
      // Args validated by handler
      return handleBrowserConsole(browserService, contextId, args as { level?: "all" | "errors" | "warnings"; limit?: number });
    case "browser_network":
      // Args validated by handler
      return handleBrowserNetwork(browserService, contextId, args as { url_contains?: string; types?: string[]; only_failures?: boolean; limit?: number });
    case "browser_save_state":
      // Args validated by handler
      return handleBrowserSaveState(browserService, contextId, args as { handle?: string });
    case "browser_load_state":
      // Args validated by handler
      return handleBrowserLoadState(browserService, contextId, args as { handle?: string; from_external?: boolean; from_jarvis?: boolean });
    case "browser_screenshot":
      // Args validated by handler
      return handleBrowserScreenshot(browserService, contextId, args as { full_page?: boolean });
    case "browser_point":
      // Args validated by handler
      return handleBrowserPoint(browserService, contextId, args as { description: string });
    case "browser_import_chrome":
      // Args validated by handler
      return handleBrowserImportChrome(browserService, contextId, args as { domains?: string[]; profile?: string; dry_run?: boolean; browser?: string });
    case "browser_status":
      return handleBrowserStatus(browserService, contextId);
    default:
      return { error: `Unknown browser tool: ${toolName}` };
  }
}
