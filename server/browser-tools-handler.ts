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
 * clearObserveCache() is invoked on browser_open (page changed -> indices
 * stale) and is exported so external callers (e.g. context destroy hooks)
 * can flush.
 */
import type { BrowserService } from "./browser-service";
import type {
  BrowserActAction,
  IndexedElement,
} from "./browser-tools";
import { pointObject, describeImage } from "./integrations/moondream-client";
import { isElectronCdpAvailable } from "./electron-cdp-probe";
import type { ElectronCdpDispatcher } from "./browser-cdp-dispatcher";
import { playwrightOps, cdpOps, type BrowserOps } from "./browser-ops-adapter";
import { decryptChromeCookies, listChromeCookieHosts } from "./integrations/chrome-cookies";
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
import { REF_ACTIONS, ACT_ACTIONS, UPLOAD_FN, STATUS_JS } from "../shared/browser-snapshot-core";

const observeCache = new Map<string, IndexedElement[]>();
/** Last ref-based snapshot per context — powers incremental diffs in observe/act. */
const prevSnapshotCache = new Map<string, Snapshot>();

// Phase 30.1 BROWSER-CHAT-06 — module-level dispatcher reference. Set once at
// boot via setBrowserCdpDispatcher() in server.ts. Null in pure-web builds.
let cdpDispatcher: ElectronCdpDispatcher | null = null;
export function setBrowserCdpDispatcher(d: ElectronCdpDispatcher | null): void {
  cdpDispatcher = d;
}

/**
 * Wait (bounded poll) for a native WebContentsView's CDP target to be registered
 * for `contextId`. Returns the targetId once available, or null on timeout / when
 * not in Electron-host mode. No-op fast path in pure web mode (no dispatcher or
 * CDP unavailable). Used both by resolveOps (between-turns re-registration race)
 * and by the open-pane route (first-open mount race) so open_browser_pane can
 * deterministically navigate the SAME native view the agent's tools drive.
 */
export async function awaitNativeCdpTarget(
  contextId: string,
  timeoutMs = 3000,
): Promise<string | null> {
  if (!cdpDispatcher) return null;
  if (!(await isElectronCdpAvailable())) return null;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let targetId = cdpDispatcher.getTargetId(contextId);
  while (!targetId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    targetId = cdpDispatcher.getTargetId(contextId);
  }
  return targetId;
}

/**
 * Resolve the right BrowserOps adapter for a contextId.
 * - Electron CDP up + cdpTargetId registered for this contextId -> CDP path
 * - Electron CDP up + context is native-bound but its target is momentarily
 *   unresolved (renderer remount / first-open mount race) -> WAIT briefly for it,
 *   and if it still doesn't appear, FAIL LOUD rather than silently driving an
 *   invisible Playwright phantom (a different browser, no auth) the user never
 *   sees. That silent fallback was the root cause of the "open_browser_pane shows
 *   about:blank / state resets between turns" bug.
 * - Pure web mode (no dispatcher / CDP down) OR a context that never owned a
 *   native pane -> existing Playwright path (zero regressions in web mode).
 */
async function resolveOps(service: BrowserService, contextId: string): Promise<BrowserOps> {
  if (cdpDispatcher && (await isElectronCdpAvailable())) {
    let targetId = cdpDispatcher.getTargetId(contextId);
    if (!targetId) {
      // Wait briefly for the native pane to (re)register — covers the first-open
      // mount race and a between-turns remount. We poll regardless of
      // isNativeBound: after a server restart the in-memory native-bound set is
      // empty even though a real pane is mounted (the persisted target map / the
      // renderer heartbeat re-register within the window).
      targetId = await awaitNativeCdpTarget(contextId, 3000);
    }
    if (targetId) return cdpOps(cdpDispatcher, contextId, service);
    // IN ELECTRON THE AGENT MUST DRIVE THE USER'S VISIBLE WebContentsView — never
    // the off-screen Playwright phantom (a different, headless browser the user
    // can't see, with no shared auth/storage). When no native pane resolves, the
    // pane simply isn't open/visible for this session; fail LOUD so the agent
    // (re)opens a visible one instead of silently operating an invisible browser
    // (the "tools work but the user sees nothing" bug). The Playwright path is
    // reserved for true web mode (Electron CDP down), handled below.
    throw new Error(
      "No visible browser pane is open for this session. Call open_browser_pane " +
        "(with a url) to open one the user can see in the app, then retry — browser " +
        "tools won't drive an off-screen browser in the desktop app.",
    );
  }
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

/** @deprecated kept as an alias — use clearBrowserCaches. */
export function clearObserveCache(contextId: string): void {
  clearBrowserCaches(contextId);
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

export async function handleBrowserOpen(
  service: BrowserService,
  contextId: string,
  args: { url: string }
): Promise<{ url: string; title: string; snapshot: string }> {
  if (typeof args.url !== "string" || !args.url) {
    throw new Error("browser_open: 'url' (string) is required");
  }
  assertAgentNavAllowed(args.url);
  console.log(`[BrowserTools] browser_open(${contextId}, ${args.url})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const result = await ops.navigate(args.url);
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
  /** Base64 annotated JPEG — present only when screenshot:true was requested. */
  screenshot_annotated?: string;
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

    // Heavy annotated screenshot is opt-in (the user already sees the pane).
    if (wantScreenshot) {
      try {
        const elements = await ops.extractIndexedElements({ maxElements: max });
        observeCache.set(contextId, elements);
        result.screenshot_annotated = await ops.captureAnnotatedScreenshot(elements);
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
      await ops.actByRef(ref as number, action as RefAction, {
        text: args.text,
        value: args.value,
        key: args.key,
      });
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
        ? `${d.text}\n(elements changed — call browser_observe before acting on a ref again)`
        : d.text;
    } catch {
      /* diff best-effort */
    }
    return { ok: true as const, action, ref, snapshot };
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
): Promise<{ url?: string; title?: string; viewport?: { width: number; height: number }; loading?: boolean; error?: string }> {
  const ops = await resolveOps(service, contextId);
  try {
    const { result } = await ops.evalExpression(STATUS_JS);
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    return parsed && typeof parsed === "object"
      ? (parsed as { url?: string; title?: string })
      : { error: "browser_status: unexpected result" };
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
  if (!cdpDispatcher || !(await isElectronCdpAvailable()) || !cdpDispatcher.isNativeBound(contextId)) {
    return { error: "browser_console is available only for a visible native browser pane. Call open_browser_pane (with a url) first." };
  }
  try {
    const all = await cdpDispatcher.getConsole(contextId, { level: args?.level ?? "all", limit: args?.limit });
    let errors = 0, warnings = 0;
    for (const e of all) { if (e.level === "error") errors++; else if (e.level === "warn") warnings++; }
    return { entries: all.map((e) => ({ level: e.level, text: e.text })), errors, warnings, total: all.length };
  } catch (err: unknown) {
    return { error: `browser_console failed: ${err instanceof Error ? err.message : String(err)}` };
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
          "No localStorage captured — for token-in-localStorage logins (Firebase/Supabase/Auth0), save while ON the site so its origin is captured.";
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
  args: { handle?: string; from_jarvis?: boolean }
): Promise<{ ok: true; handle: string; source: string; cookies: number; origins: number } | { error: string }> {
  if (typeof args?.handle !== "string" || !args.handle.trim()) {
    throw new Error("browser_load_state: 'handle' (string) is required");
  }
  const handle = safeHandle(args.handle);
  const loaded = loadStateFromStores(handle, { fromJarvis: !!args.from_jarvis });
  if (!loaded) {
    return {
      error: `browser_load_state: no saved state for handle "${handle}"${args.from_jarvis ? " in the Jarvis store" : ""}.`,
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

export async function handleBrowserScreenshot(
  service: BrowserService,
  contextId: string,
  args: { full_page?: boolean }
): Promise<{
  format: "jpeg";
  data: string;
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
    return {
      format: "jpeg" as const,
      data: buf.toString("base64"),
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
 * the macOS Keychain prompt is the consent gate. Requires the Electron native pane
 * (CDP). Cookies are injected over the page's own CDP session via Network.setCookies
 * so they land in that exact partition. `dry_run` lists hosts only (no Keychain).
 */
export async function handleBrowserImportChrome(
  service: BrowserService,
  contextId: string,
  args: { domains?: string[]; profile?: string; dry_run?: boolean }
): Promise<unknown> {
  const domains = Array.isArray(args?.domains) ? args.domains.map(String) : [];
  const profile = typeof args?.profile === "string" && args.profile ? args.profile : "Default";
  const dryRun = !!args?.dry_run;

  if (dryRun) {
    return listChromeCookieHosts({ domains, profile });
  }
  if (!domains.length) {
    throw new Error(
      'browser_import_chrome: "domains" (non-empty array) is required, e.g. ["youtube.com"]. Use dry_run:true to list importable hosts first.'
    );
  }
  if (!cdpDispatcher || !(await isElectronCdpAvailable()) || !cdpDispatcher.getTargetId(contextId)) {
    return {
      error:
        "browser_import_chrome requires the Topics native browser. Open the browser pane first (open_browser_pane / browser_open), then retry.",
    };
  }
  console.log(`[BrowserTools] browser_import_chrome(${contextId}, domains=${domains.join(",")})`);
  return withLock(service, contextId, async () => {
    const { cookies, decrypted, decryptFailed, skippedEmpty, appBoundEncrypted, profile: p } =
      await decryptChromeCookies({ domains, profile });
    if (!cookies.length) {
      return { ok: true, imported: 0, note: "no matching cookies (none found, all expired, or App-Bound encrypted)", appBoundEncrypted };
    }
    const page = await cdpDispatcher!.getPage(contextId);
    const session = await page.context().newCDPSession(page);
    try {
      // Inject into THIS page's network/session = the WebContentsView's persistent
      // partition. setCookies replaces matching cookies; never logs values.
      await session.send("Network.setCookies", { cookies: cookies as never });
    } finally {
      await session.detach().catch(() => { /* ignore */ });
    }
    await page.reload().catch(() => { /* harmless if on about:blank */ });
    clearBrowserCaches(contextId); // page reloaded -> refs/bboxes stale
    const out: Record<string, unknown> = { ok: true, profile: p, imported: decrypted, decryptFailed, skippedEmpty };
    if (appBoundEncrypted) out.appBoundEncrypted = appBoundEncrypted;
    return out;
  });
}
