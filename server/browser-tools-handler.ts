/**
 * Phase 30 BROWSER-CHAT-03 -- Handler implementations for the 6 native
 * browser tools.
 *
 * Each handler:
 *  1. Validates input (throws/returns structured error on bad shape).
 *  2. Wraps the action in withLock(): broadcasts agent_active=true on
 *     entry and agent_active=false on exit (try/finally -- guaranteed
 *     unlock even if the action throws).
 *  3. Returns a structured response or a structured { error } object
 *     (failsoft to the agent rather than throwing for known failure modes).
 *
 * Cache: the latest browser_observe IndexedElement[] is kept in-process
 * per contextId. browser_act resolves element_id against this cache.
 * clearBrowserCaches() flushes it (+ the ref snapshot cache) on browser_open
 * (page changed -> indices stale) and on context destroy.
 */
import { filterNetwork, summarizeNetwork, type NetworkEntry } from "./browser-network-log";
import type { BrowserService } from "./browser-service";
import type {
  BrowserActAction,
  IndexedElement,
} from "./browser-tools";
import { pointObject, describeImage } from "./integrations/moondream-client";
import { playwrightOps, type BrowserOps } from "./browser-ops-adapter";
import { listChromeCookieHosts } from "./integrations/chrome-cookies";
import { toServableUrl, isMediaRef, getLocalFileServing } from "./browser-local-file-url";
import {
  serialize,
  diff,
  type Snapshot,
  type RefAction,
  type ExtractFields,
} from "./browser-snapshot";
import {
  saveStateToStores,
  loadStateFromStores,
  safeHandle,
} from "./browser-login-state";
// SHARED action set — the SAME source the native validator (tauriBrowserOps) uses,
// so the two paths can never disagree on what browser_act accepts.
import {
  REF_ACTIONS,
  ACT_ACTIONS,
  UPLOAD_FN,
  STATUS_JS,
  isStaleRefError,
  refAfterResnapshot,
} from "../shared/browser-snapshot-core";
import { writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { topicsHome } from "./services/daemon-state";

const observeCache = new Map<string, IndexedElement[]>();
/** Last ref-based snapshot per context — powers incremental diffs in observe/act. */
const prevSnapshotCache = new Map<string, Snapshot>();

/**
 * Resolve the BrowserOps adapter for a contextId. The Tauri native pane is
 * intercepted upstream by the native delegate registry (see
 * dispatchBrowserToolCallByContext), so it never reaches here — this only ever
 * serves a web-mode pane, backed by the server-launched Playwright context.
 * (The former Electron-CDP branch went away with the Electron shell in v2.0.0.)
 */
async function resolveOps(service: BrowserService, contextId: string): Promise<BrowserOps> {
  return playwrightOps(service, contextId);
}

/**
 * Flush all per-context agent caches (legacy bbox observe cache + the ref-based
 * snapshot cache). Call when the page changes (navigate/reload/load_state) or
 * the context is destroyed, so a later act can't resolve a stale ref/bbox.
 */
export function clearBrowserCaches(contextId: string): void {
  observeCache.delete(contextId);
  prevSnapshotCache.delete(contextId);
}

/**
 * try/finally lock helper. Broadcasts agent_active=true on entry and
 * agent_active=false on exit -- guaranteed even if fn throws.
 */
async function withLock<T>(
  service: BrowserService,
  contextId: string,
  fn: () => Promise<T>
): Promise<T> {
  service.broadcastAgentActive(contextId, true);
  try {
    return await fn();
  } finally {
    service.broadcastAgentActive(contextId, false);
  }
}

/**
 * Schemes an AGENT may navigate to via browser_open. Blocks file://, chrome://,
 * view-source: etc. so a confused/poisoned agent can't read local files or
 * privileged pages. The user-facing open_browser_pane flow (where the human
 * asked for a URL) keeps its own policy and may allow file://. Override with
 * BROWSER_ALLOW_ALL_SCHEMES=1.
 */
const AGENT_NAV_SCHEMES = new Set(["http:", "https:", "about:", "data:"]);
function assertAgentNavAllowed(url: string): void {
  if (process.env.BROWSER_ALLOW_ALL_SCHEMES === "1") return;
  let scheme: string;
  try {
    scheme = new URL(url).protocol.toLowerCase();
  } catch {
    throw new Error(`browser_open: invalid URL "${url}"`);
  }
  if (!AGENT_NAV_SCHEMES.has(scheme)) {
    throw new Error(
      `browser_open: scheme "${scheme}" is not allowed for agent navigation (allowed: http, https, about, data). Set BROWSER_ALLOW_ALL_SCHEMES=1 to override.`,
    );
  }
}

/**
 * L'URL su cui la pane va DAVVERO, dato quello che l'agente ha chiesto.
 *
 * Un file locale non diventa una navigazione `file://` — quella resta vietata
 * per l'agente, oggi come prima. Diventa l'URL http di `/api/media`, che è il
 * modo standard di mostrare un file a un contesto non fidato (vedi
 * browser-local-file-url.ts). Tutto il resto passa di qui intatto e incontra la
 * guardia di sempre.
 *
 * Il rifiuto porta il motivo VERO: «questo percorso non lo posso servire», non
 * «lo schema file: non è permesso». Era quella risposta a mandare l'agente a
 * sbattere e a lasciare la pane bianca senza dire niente.
 */
export function resolveAgentNavUrl(
  url: string,
  tool: string,
  /**
   * `"relative"` per chi ha un'origine propria e la sa risolvere da sé: la pane
   * nativa (che parla col proxy in chiaro dell'app), il telefono, un client in
   * LAN. `"absolute"` per chi naviga DA QUI, cioè il pane headless, che di
   * origine ha solo quella del server.
   */
  form: "absolute" | "relative" = "absolute",
): string {
  // Un riferimento già servito da noi ripassa di qui: la rotta open-pane
  // riscrive per poter annunciare alla finestra, il dispatcher riscrive perché
  // è lì che la regola vale per tutti i rami. Non è una navigazione da
  // giudicare una seconda volta — è la NOSTRA, e va solo messa nella forma che
  // chi naviga sa risolvere. Senza questo ramo finiva sulla guardia, che su un
  // relativo dice «invalid URL» e lascia di nuovo una pane bianca.
  if (isMediaRef(url)) {
    if (form === "relative") return url;
    const origin = getLocalFileServing()?.origin;
    return origin ? `${origin.replace(/\/$/, "")}${url}` : url;
  }
  const servable = toServableUrl(url);
  if (servable.kind === "rewritten") {
    console.log(`[BrowserTools] ${tool}: local file served over http — ${servable.path}`);
    return form === "relative" ? servable.ref : servable.url;
  }
  if (servable.kind === "refused") throw new Error(`${tool}: ${servable.reason}`);
  assertAgentNavAllowed(url);
  return url;
}

export async function handleBrowserOpen(
  service: BrowserService,
  contextId: string,
  args: { url: string }
): Promise<{ url: string; title: string; snapshot: string }> {
  if (typeof args.url !== "string" || !args.url) {
    throw new Error("browser_open: 'url' (string) is required");
  }
  const target = resolveAgentNavUrl(args.url, "browser_open");
  console.log(`[BrowserTools] browser_open(${contextId}, ${target})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const result = await ops.navigate(target);
    // Page navigated -> any cached element refs/bboxes are stale.
    clearBrowserCaches(contextId);
    // navigate() resolves at domcontentloaded; give an SPA a bounded moment to
    // render its first view so the snapshot isn't empty (agent would think the
    // page has no elements). ~0 cost once the page is idle; best-effort.
    await ops.settle?.().catch(() => {});
    // Return a fresh ref-based snapshot so the agent can act immediately.
    let snapshot = "";
    try {
      const snap = await ops.snapshot({ max: 200 });
      prevSnapshotCache.set(contextId, snap);
      snapshot = serialize(snap);
    } catch {
      /* snapshot is best-effort; navigate result still returned */
    }
    return { ...result, snapshot };
  });
}

/** Observe response: ref-based snapshot text (+ optional annotated screenshot). */
export interface BrowserObserveResult {
  url: string;
  title: string;
  /** Number of interactive elements in the snapshot. */
  count: number;
  /** Compact serialized snapshot (full) or incremental diff text. */
  snapshot: string;
  /** True when `snapshot` is a full listing (no prior snapshot / full requested). */
  full: boolean;
  /**
   * ABSOLUTE PATH of the annotated JPEG — present only when screenshot:true was
   * requested and the capture succeeded. A path, never the pixels: the image
   * used to travel back as base64, tens of thousands of tokens the caller
   * cannot look at, on the same turn that already carries the snapshot. The
   * file is fed to `moondream <path>` / the Read tool, or just left alone.
   */
  screenshot_path?: string;
  /** Are the numbered boxes drawn on that image? The web pane annotates; the
   *  native pane has no annotator and says so instead of implying it. */
  screenshot_boxes?: boolean;
}

export async function handleBrowserObserve(
  service: BrowserService,
  contextId: string,
  args: { full?: boolean; max?: number; max_elements?: number; screenshot?: boolean }
): Promise<BrowserObserveResult> {
  const max =
    typeof args?.max === "number"
      ? args.max
      : typeof args?.max_elements === "number"
        ? args.max_elements
        : 200;
  const wantScreenshot = !!args?.screenshot;
  console.log(
    `[BrowserTools] browser_observe(${contextId}, max=${max}, full=${!!args?.full}, screenshot=${wantScreenshot})`
  );
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const next = await ops.snapshot({ max });
    const prev = prevSnapshotCache.get(contextId);
    prevSnapshotCache.set(contextId, next);

    const result: BrowserObserveResult = args?.full
      ? { url: next.url, title: next.title, count: next.elements.length, snapshot: serialize(next), full: true }
      : (() => {
          const d = diff(prev, next);
          return { url: next.url, title: next.title, count: next.elements.length, snapshot: d.text, full: d.full };
        })();

    // Heavy annotated screenshot is opt-in (the user already sees the pane), and
    // it lands ON DISK like every other agent-facing capture: same helper, same
    // media dir, same prune. `browser_screenshot` learned this long ago; observe
    // kept inlining base64 into a response that already carries the snapshot.
    if (wantScreenshot) {
      try {
        const elements = await ops.extractIndexedElements({ maxElements: max });
        observeCache.set(contextId, elements);
        const b64 = await ops.captureAnnotatedScreenshot(elements);
        const buf = Buffer.from(b64, "base64");
        // A PNG starts with 0x89 and a JPEG with 0xff: the annotator picks, we
        // name the file after what it actually produced instead of assuming.
        const ext = buf[0] === 0x89 ? "png" : "jpg";
        result.screenshot_path = await writeAgentScreenshot(buf, contextId, ext);
        result.screenshot_boxes = true;
        // NB: the compact ref snapshot above + the annotated JPEG already give the
        // agent both structure and pixels; the old `a11y_tree` (full ariaSnapshot)
        // duplicated the snapshot at ~3–6k tokens per call, so it's dropped.
      } catch {
        /* screenshot best-effort */
      }
    }
    return result;
  });
}

/** Actions that target a specific element ref via a Playwright locator — built
 *  from the SHARED REF_ACTIONS list (single source with the native validator). */
const REF_ACTION_SET = new Set<string>(REF_ACTIONS);

export interface BrowserActResult {
  ok: true;
  action: BrowserActAction;
  ref?: number;
  /** Incremental snapshot diff after the action (so the agent sees changes). */
  snapshot?: string;
  /** Present for get_text. */
  text?: string;
  truncated?: boolean;
}

export async function handleBrowserAct(
  service: BrowserService,
  contextId: string,
  args: {
    ref?: number;
    element_id?: number; // deprecated alias
    action: BrowserActAction;
    text?: string;
    value?: string;
    key?: string;
    dy?: number;
  }
): Promise<BrowserActResult> {
  const ref =
    typeof args.ref === "number" && Number.isFinite(args.ref)
      ? args.ref
      : typeof args.element_id === "number" && Number.isFinite(args.element_id)
        ? args.element_id
        : undefined;
  const action = args.action;
  if (!(ACT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`browser_act: 'action' must be one of ${ACT_ACTIONS.join(", ")}`);
  }
  if (REF_ACTION_SET.has(action) && ref == null) {
    throw new Error(`browser_act: '${action}' requires 'ref' (number) from the latest browser_observe`);
  }
  if ((action === "fill" || action === "type") && typeof args.text !== "string") {
    throw new Error(`browser_act ${action}: 'text' (string) is required`);
  }
  if (action === "select" && typeof args.value !== "string" && typeof args.text !== "string") {
    throw new Error("browser_act select: 'value' or 'text' (string) is required");
  }
  console.log(`[BrowserTools] browser_act(${contextId}, ref=${ref ?? "-"}, action=${action})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    /** Set when a stale ref was followed to the number it now carries. */
    let rerefedTo: number | undefined;
    // get_text reads — no mutation, no diff.
    if (action === "get_text") {
      const r = await ops.getText({ ref });
      return { ok: true as const, action, ref, text: r.text, truncated: r.truncated };
    }
    if (action === "scroll") {
      const dy = typeof args.dy === "number" ? args.dy : 600;
      await ops.dispatchInput("scroll", { deltaY: dy });
    } else if (action === "press" && ref == null) {
      await ops.dispatchInput("keypress", { key: args.key ?? "Enter" });
    } else {
      const payload = { text: args.text, value: args.value, key: args.key };
      try {
        await ops.actByRef(ref as number, action as RefAction, payload);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isStaleRefError(msg)) throw err;
        // THE REF IS GONE, so take the snapshot the caller was told to take.
        // A ref is a position in a listing: a re-render renumbers, and the
        // element aimed at is usually still there under another number. Two
        // outcomes, both of which cost the caller nothing:
        //   - it is followable (one element with the same identity): act there,
        //     once, and say so in the result;
        //   - it is not: the error CARRIES the fresh snapshot, so the next call
        //     is the action again, not an observe to earn the right to retry.
        const fresh = await ops.snapshot({ max: 200 });
        const again = refAfterResnapshot(prevSnapshotCache.get(contextId), fresh, ref as number);
        prevSnapshotCache.set(contextId, fresh);
        if (again == null) {
          throw new Error(`${msg}\nFresh snapshot (already taken for you):\n${serialize(fresh)}`);
        }
        await ops.actByRef(again, action as RefAction, payload);
        rerefedTo = again;
      }
    }
    // Let a click-triggered navigation / async re-render settle before we read
    // the result, so the diff reflects the RESULT rather than the pre-effect DOM
    // (bounded, and ~0 cost when the page is already idle); best-effort.
    await ops.settle?.().catch(() => {});
    // Return what changed so the agent doesn't need a separate observe.
    let snapshot: string | undefined;
    try {
      const prev = prevSnapshotCache.get(contextId);
      const next = await ops.snapshot({ max: 200 });
      prevSnapshotCache.set(contextId, next);
      const d = diff(prev, next);
      // When the structure shifted, refs from the agent's last observe may now
      // point at DIFFERENT elements (SNAPSHOT_FN renumbers in DOM order). Tell the
      // agent to re-observe rather than act on a stale ref that would silently hit
      // the wrong element.
      snapshot = d.changed > 0
        ? `${d.text}\n(elements changed. Call browser_observe before acting on a ref again.)`
        : d.text;
    } catch {
      /* diff best-effort */
    }
    if (rerefedTo != null) {
      const note = `(ref ${ref} was stale; re-snapshotted and acted on [${rerefedTo}], same element.)`;
      snapshot = snapshot ? `${note}\n${snapshot}` : note;
    }
    return { ok: true as const, action, ref: rerefedTo ?? ref, snapshot };
  });
}

export async function handleBrowserGetText(
  service: BrowserService,
  contextId: string,
  args: { ref?: number; max?: number }
): Promise<{ text: string; truncated: boolean; length: number }> {
  console.log(`[BrowserTools] browser_get_text(${contextId}, ref=${args?.ref ?? "-"})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () =>
    ops.getText({ ref: args?.ref, max: args?.max }),
  );
}

export async function handleBrowserEval(
  service: BrowserService,
  contextId: string,
  args: { expression: string }
): Promise<{ result: unknown } | { error: string }> {
  if (typeof args?.expression !== "string" || !args.expression.trim()) {
    throw new Error("browser_eval: 'expression' (non-empty string) is required");
  }
  console.log(`[BrowserTools] browser_eval(${contextId}, ${args.expression.slice(0, 80)})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    try {
      return await ops.evalExpression(args.expression);
    } catch (err: unknown) {
      return { error: `browser_eval failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

/**
 * browser_upload — set a base64-read file onto an `<input type=file>`. The file
 * was read + encoded server-side by the dispatcher (readUploadFile); here we run
 * the shared UPLOAD_FN in the page over the CDP/Playwright surface (the Tauri
 * native pane takes the delegated path instead). UPLOAD_FN returns a JSON string.
 */
export async function handleBrowserUpload(
  service: BrowserService,
  contextId: string,
  file: { ref?: number; dataB64: string; filename: string; mime: string },
): Promise<{ ok?: boolean; name?: string; size?: number; type?: string; error?: string }> {
  console.log(`[BrowserTools] browser_upload(${contextId}, ${file.filename}, ref=${file.ref ?? "-"})`);
  const ops = await resolveOps(service, contextId);
  const js = `(${UPLOAD_FN.toString()})(${JSON.stringify(file)})`;
  return withLock(service, contextId, async () => {
    try {
      const { result } = await ops.evalExpression(js);
      const parsed = typeof result === "string" ? JSON.parse(result) : result;
      return parsed && typeof parsed === "object"
        ? (parsed as { ok?: boolean; error?: string })
        : { error: "browser_upload: unexpected result" };
    } catch (err: unknown) {
      return { error: `browser_upload failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

/**
 * browser_status — the pane's current { url, title, viewport, loading }. Runs the
 * shared STATUS_JS in the page (CDP/Playwright surface; the Tauri native pane
 * takes the delegated path). Fixes the 1280×720 viewport stub with the real size.
 */
export async function handleBrowserStatus(
  service: BrowserService,
  contextId: string,
): Promise<{ url?: string; title?: string; viewport?: { width: number; height: number }; loading?: boolean; lastDialog?: { type: string; message: string; handled: string }; error?: string }> {
  const ops = await resolveOps(service, contextId);
  try {
    const { result } = await ops.evalExpression(STATUS_JS);
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    if (!parsed || typeof parsed !== "object") return { error: "browser_status: unexpected result" };
    // L'ultimo dialogo, se ce n'è stato uno. Il listener lo chiude da sé
    // (altrimenti la pagina si pianta e all'umano arriva «il browser non
    // risponde»), ma chiuderlo in silenzio renderebbe la diagnosi impossibile:
    // qui l'agente scopre CHE c'era e COSA diceva. Va nello status invece che in
    // un tool nuovo perché è la domanda «com'è messa la pagina», che l'agente
    // fa già.
    const d = service.getLastDialog?.(contextId) ?? null;
    const base = parsed as { url?: string; title?: string };
    return d ? { ...base, lastDialog: { type: d.type, message: d.message, handled: d.handled } } : base;
  } catch (err: unknown) {
    return { error: `browser_status failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * browser_console — return recent page console messages (logs + warnings +
 * errors + uncaught exceptions) captured from the native pane. Lets the agent
 * SEE what the page logged (e.g. a failed fetch, a React error) instead of
 * guessing. Read-only: no withLock (it doesn't act on the page). Console capture
 * lives on the CDP page (native pane); in pure-web mode it returns a note.
 */
export async function handleBrowserConsole(
  _service: BrowserService,
  contextId: string,
  args: { level?: "all" | "errors" | "warnings"; limit?: number }
): Promise<{ entries: { level: string; text: string }[]; errors: number; warnings: number; total: number } | { error: string }> {
  console.log(`[BrowserTools] browser_console(${contextId}, level=${args?.level ?? "all"})`);
  // Console capture lives on the native pane — the Tauri client delegates
  // browser_console to its own executor (tauriBrowserOps), so it never reaches
  // this handler. In web mode there is no per-context console buffer, so this
  // path only ever returns the "needs a native pane" note.
  return { error: "browser_console is available only for a visible native browser pane. Call open_browser_pane (with a url) first." };
}

/**
 * Le richieste di rete della pane, filtrate.
 *
 * Il filtro NON è un dettaglio di comodità: una pagina qualsiasi fa centinaia di
 * richieste, e restituirle tutte costa più di quanto informi. Il default tiene
 * solo ciò che porta dati; l'ampiezza si chiede.
 */
export async function handleBrowserNetwork(
  service: BrowserService,
  contextId: string,
  args: { url_contains?: string; types?: string[]; only_failures?: boolean; limit?: number },
): Promise<{ entries: NetworkEntry[]; shown: number; recorded: number; failures: number } | { error: string }> {
  console.log(`[BrowserTools] browser_network(${contextId}, only_failures=${!!args?.only_failures})`);
  try {
    const all = service.getNetworkEntries(contextId);
    const entries = filterNetwork(all, {
      urlContains: args?.url_contains,
      types: args?.types,
      onlyFailures: args?.only_failures,
      limit: args?.limit,
    });
    const s = summarizeNetwork(all, entries);
    // `recorded` dice quante ne sono state viste in tutto: senza, una risposta
    // corta sembrerebbe «non è successo niente» invece di «te ne mostro dieci».
    return { entries, shown: s.shown, recorded: s.recorded, failures: s.failures };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `browser_network failed: ${msg}` };
  }
}

/**
 * Coerce the legacy `{schema:{properties:{...}}}` shape into the CSS-selector
 * `fields` map so old callers degrade gracefully: each property name is treated
 * as a selector (best effort). New callers pass `fields` directly.
 */
function coerceExtractFields(args: {
  fields?: unknown;
  schema?: unknown;
}): ExtractFields {
  if (args.fields && typeof args.fields === "object") {
    return args.fields as ExtractFields;
  }
  const schema = args.schema as { properties?: Record<string, unknown> } | undefined;
  if (schema?.properties && typeof schema.properties === "object") {
    const out: ExtractFields = {};
    for (const k of Object.keys(schema.properties)) out[k] = k;
    return out;
  }
  return {};
}

export async function handleBrowserExtract(
  service: BrowserService,
  contextId: string,
  args: { fields?: Record<string, unknown>; schema?: Record<string, unknown> }
): Promise<{ extracted: Record<string, unknown> } | { error: string }> {
  const fields = coerceExtractFields(args);
  if (!Object.keys(fields).length) {
    throw new Error(
      "browser_extract: 'fields' (CSS-selector map) is required, e.g. {\"title\":\"h1\"}",
    );
  }
  console.log(
    `[BrowserTools] browser_extract(${contextId}, fields: ${Object.keys(fields).join(",")})`,
  );
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    try {
      const extracted = await ops.extractFields(fields);
      return { extracted };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `browser_extract failed: ${msg}` };
    }
  });
}

export async function handleBrowserSaveState(
  service: BrowserService,
  contextId: string,
  args: { handle?: string }
): Promise<
  | { ok: true; handle: string; cookies: number; origins: number; localStorageCaptured: boolean; warning?: string }
  | { error: string }
> {
  if (typeof args?.handle !== "string" || !args.handle.trim()) {
    throw new Error("browser_save_state: 'handle' (string) is required");
  }
  const handle = safeHandle(args.handle);
  console.log(`[BrowserTools] browser_save_state(${contextId}, ${handle})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    try {
      const state = await ops.exportStorageState();
      const { localStorageCaptured } = saveStateToStores(handle, state);
      const out: { ok: true; handle: string; cookies: number; origins: number; localStorageCaptured: boolean; warning?: string } = {
        ok: true,
        handle,
        cookies: state.cookies?.length ?? 0,
        origins: state.origins?.length ?? 0,
        localStorageCaptured,
      };
      if (!localStorageCaptured) {
        out.warning =
          "No localStorage captured. For token-in-localStorage logins (Firebase/Supabase/Auth0), save while ON the site so its origin is captured.";
      }
      return out;
    } catch (err: unknown) {
      return { error: `browser_save_state failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

export async function handleBrowserLoadState(
  service: BrowserService,
  contextId: string,
  args: { handle?: string; from_external?: boolean; from_jarvis?: boolean }
): Promise<{ ok: true; handle: string; source: string; cookies: number; origins: number } | { error: string }> {
  if (typeof args?.handle !== "string" || !args.handle.trim()) {
    throw new Error("browser_load_state: 'handle' (string) is required");
  }
  const handle = safeHandle(args.handle);
  // `from_jarvis` accepted as a deprecated alias of `from_external`.
  const fromExternal = !!(args.from_external ?? args.from_jarvis);
  const loaded = loadStateFromStores(handle, { fromExternal });
  if (!loaded) {
    return {
      error: `browser_load_state: no saved state for handle "${handle}"${fromExternal ? " in the external store" : ""}.`,
    };
  }
  console.log(`[BrowserTools] browser_load_state(${contextId}, ${handle}, source=${loaded.source})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    try {
      const applied = await ops.importStorageState(loaded.state);
      clearBrowserCaches(contextId); // page reloaded -> refs stale
      return { ok: true as const, handle, source: loaded.source, cookies: applied.cookies, origins: applied.origins };
    } catch (err: unknown) {
      return { error: `browser_load_state failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

export async function handleBrowserReadScreen(
  service: BrowserService,
  contextId: string,
  args: { question?: string; full_page?: boolean }
): Promise<{ vision: string; question?: string } | { error: string }> {
  console.log(
    `[BrowserTools] browser_read_screen(${contextId}, ${args?.question ? `"${args.question.slice(0, 60)}"` : "caption"})`
  );
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const buf = await ops.screenshot({ format: "jpeg", quality: 70, fullPage: !!args?.full_page });
    const result = await describeImage({
      contextId,
      imageBase64: buf.toString("base64"),
      question: typeof args?.question === "string" ? args.question : undefined,
    });
    if ("error" in result) return result; // failsoft to the agent
    return { vision: result.text, question: args?.question };
  });
}

/** Where agent-facing screenshots land: durable, under the known media root.
 *  Resolved lazily so a TOPICS_HOME set after import (worktree isolation, tests)
 *  is honoured. */
function agentShotDir(): string {
  return join(topicsHome(), "media", "agent-screenshots");
}
/** Keep the newest N screenshots on disk; prune the rest (best-effort). */
const AGENT_SHOT_KEEP = 50;

/**
 * Persist a screenshot buffer to disk and return its absolute path — instead of
 * handing the agent a base64 blob it can't view and would only bloat its
 * context (a JPEG is tens of thousands of tokens of unusable text, which pushes
 * the turn toward the compact/stall boundary). The agent gets a path it can
 * feed straight to `moondream <path>`, the Read tool, or `browser_read_screen`.
 * Filenames are timestamp-prefixed so lexicographic order == chronological,
 * which makes the prune trivial and deterministic.
 */
export async function writeAgentScreenshot(
  buf: Buffer,
  contextId: string,
  ext: "jpg" | "png" = "jpg"
): Promise<string> {
  const dir = agentShotDir();
  await mkdir(dir, { recursive: true });
  const safeCtx = contextId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  const path = join(dir, `${Date.now()}-${safeCtx}-${rand}.${ext}`);
  await writeFile(path, buf);
  // Best-effort prune of older shots so the dir can't grow unbounded.
  try {
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".jpg") || f.endsWith(".png"))
      .sort(); // ts-prefixed → ascending == oldest first
    const excess = files.length - AGENT_SHOT_KEEP;
    for (let i = 0; i < excess; i++) {
      await unlink(join(dir, files[i])).catch(() => {});
    }
  } catch {
    /* prune is best-effort — never fail a screenshot over cleanup */
  }
  return path;
}

export async function handleBrowserScreenshot(
  service: BrowserService,
  contextId: string,
  args: { full_page?: boolean }
): Promise<{
  format: "jpeg";
  path: string;
  bytes: number;
  viewport: { width: number; height: number };
}> {
  console.log(
    `[BrowserTools] browser_screenshot(${contextId}, full_page=${Boolean(args?.full_page)})`
  );
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const buf = await ops.screenshot({
      format: "jpeg",
      quality: 70,
      fullPage: args?.full_page ?? false,
    });
    const vp = await ops.viewport();
    const path = await writeAgentScreenshot(buf, contextId);
    return {
      format: "jpeg" as const,
      path,
      bytes: buf.length,
      viewport: vp,
    };
  });
}

export async function handleBrowserPoint(
  service: BrowserService,
  contextId: string,
  args: { description: string }
): Promise<
  { clicked: true; point: { x: number; y: number } } | { error: string }
> {
  if (typeof args.description !== "string" || !args.description.trim()) {
    throw new Error("browser_point: 'description' (non-empty string) is required");
  }
  console.log(
    `[BrowserTools] browser_point(${contextId}, "${args.description.slice(0, 80)}")`
  );
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const buf = await ops.screenshot({
      format: "jpeg",
      quality: 70,
    });
    const vp = await ops.viewport();
    const result = await pointObject({
      contextId,
      imageBase64: buf.toString("base64"),
      description: args.description,
      viewport: vp,
    });
    if ("error" in result) return result; // failsoft -- pass error to agent
    if (result.points.length === 0) {
      return {
        error: `browser_point: Moondream returned no candidates for "${args.description}". Try a more specific description, or use browser_observe.`,
      };
    }
    const target = result.points[0];
    await ops.dispatchInput("click", { x: target.x, y: target.y });
    return { clicked: true as const, point: target };
  });
}

/**
 * Seed the topic's native browser (WebContentsView persistent partition) with the
 * user's REAL Chrome logins, so it's instantly signed in to whatever Chrome is —
 * no per-site sign-in. Reads ONLY the Chrome cookie store (never saved passwords);
 * the macOS Keychain prompt is the consent gate. Requires the Topics native pane:
 * the server decrypts the store here, then the native-state delegate
 * (browser-native-state.ts) hands the cookies to the pane's WKWebView so they land
 * in its partition. `dry_run` lists hosts only (no Keychain). This web-mode handler
 * has no native pane, so it only serves dry_run / reports a native pane is needed.
 */
export async function handleBrowserImportChrome(
  _service: BrowserService,
  _contextId: string,
  args: { domains?: string[]; profile?: string; dry_run?: boolean; browser?: string }
): Promise<unknown> {
  const domains = Array.isArray(args?.domains) ? args.domains.map(String) : [];
  const profile = typeof args?.profile === "string" && args.profile ? args.profile : "Default";
  const dryRun = !!args?.dry_run;
  const browser = typeof args?.browser === "string" ? args.browser : undefined;

  if (dryRun) {
    return listChromeCookieHosts({ domains, profile, browser });
  }
  if (!domains.length) {
    throw new Error(
      'browser_import_chrome: "domains" (non-empty array) is required, e.g. ["youtube.com"]. Use dry_run:true to list importable hosts first.'
    );
  }
  // Real cookie injection happens on the native pane: the Tauri client is a
  // native-state delegate for browser_import_chrome (the server decrypts the
  // Chrome store in browser-native-state.ts, then hands the cookies to the
  // pane's WKWebView). This web-mode handler has no native pane to inject into,
  // so it only lists hosts (dry_run, above) or reports a native pane is required.
  return {
    error:
      "browser_import_chrome requires the Topics native browser. Open the browser pane first (open_browser_pane / browser_open), then retry.",
  };
}
