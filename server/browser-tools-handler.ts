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
  AgentObserveResponse,
  BrowserActAction,
  IndexedElement,
} from "./browser-tools";
import { pointObject } from "./integrations/moondream-client";
import { isElectronCdpAvailable } from "./electron-cdp-probe";
import type { ElectronCdpDispatcher } from "./browser-cdp-dispatcher";
import { playwrightOps, cdpOps, type BrowserOps } from "./browser-ops-adapter";

const observeCache = new Map<string, IndexedElement[]>();

// Phase 30.1 BROWSER-CHAT-06 — module-level dispatcher reference. Set once at
// boot via setBrowserCdpDispatcher() in server.ts. Null in pure-web builds.
let cdpDispatcher: ElectronCdpDispatcher | null = null;
export function setBrowserCdpDispatcher(d: ElectronCdpDispatcher | null): void {
  cdpDispatcher = d;
}

/**
 * Resolve the right BrowserOps adapter for a contextId.
 * - Electron CDP up + cdpTargetId registered for this contextId -> CDP path
 * - Otherwise -> existing Playwright path (zero regressions in web mode)
 */
async function resolveOps(service: BrowserService, contextId: string): Promise<BrowserOps> {
  if (cdpDispatcher && (await isElectronCdpAvailable()) && cdpDispatcher.getTargetId(contextId)) {
    return cdpOps(cdpDispatcher, contextId, service);
  }
  return playwrightOps(service, contextId);
}

export function clearObserveCache(contextId: string): void {
  observeCache.delete(contextId);
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

export async function handleBrowserOpen(
  service: BrowserService,
  contextId: string,
  args: { url: string }
): Promise<{ url: string; title: string }> {
  if (typeof args.url !== "string" || !args.url) {
    throw new Error("browser_open: 'url' (string) is required");
  }
  console.log(`[BrowserTools] browser_open(${contextId}, ${args.url})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const result = await ops.navigate(args.url);
    // Page navigated -> any cached IndexedElement[] is stale.
    clearObserveCache(contextId);
    return result;
  });
}

export async function handleBrowserObserve(
  service: BrowserService,
  contextId: string,
  args: { max_elements?: number }
): Promise<AgentObserveResponse> {
  const max = typeof args?.max_elements === "number" ? args.max_elements : 50;
  console.log(`[BrowserTools] browser_observe(${contextId}, max=${max})`);
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const elements = await ops.extractIndexedElements({
      maxElements: max,
    });
    const screenshot_annotated = await ops.captureAnnotatedScreenshot(elements);
    const a11y = await ops.accessibilitySnapshot();
    observeCache.set(contextId, elements);
    return {
      a11y_tree: a11y.ariaSnapshot,
      screenshot_annotated,
      elements,
      url: a11y.url,
      title: a11y.title,
    };
  });
}

export async function handleBrowserAct(
  service: BrowserService,
  contextId: string,
  args: { element_id: number; action: BrowserActAction; text?: string }
): Promise<{ ok: true; element: IndexedElement }> {
  if (typeof args.element_id !== "number" || !Number.isFinite(args.element_id)) {
    throw new Error("browser_act: 'element_id' (number) is required");
  }
  const validActions: BrowserActAction[] = ["click", "type", "select"];
  if (!validActions.includes(args.action)) {
    throw new Error(
      `browser_act: 'action' must be one of ${validActions.join(", ")}`
    );
  }
  const cached = observeCache.get(contextId);
  if (!cached) {
    throw new Error(
      "browser_act: no observe cache for context. Call browser_observe first."
    );
  }
  const el = cached.find((e) => e.id === args.element_id);
  if (!el) {
    throw new Error(
      `browser_act: element_id ${args.element_id} not found in latest observe (cache has ${cached.length} elements). Call browser_observe again -- page may have changed.`
    );
  }
  console.log(
    `[BrowserTools] browser_act(${contextId}, id=${args.element_id}, action=${args.action})`
  );
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    const cx = el.bbox.x + Math.round(el.bbox.width / 2);
    const cy = el.bbox.y + Math.round(el.bbox.height / 2);
    if (args.action === "click") {
      await ops.dispatchInput("click", { x: cx, y: cy });
    } else if (args.action === "type") {
      if (typeof args.text !== "string") {
        throw new Error("browser_act type: 'text' (string) is required");
      }
      // Click first to focus, then type.
      await ops.dispatchInput("click", { x: cx, y: cy });
      await ops.dispatchInput("type", { text: args.text });
    } else {
      // 'select' falls through to a focus click. Full option-by-text selection
      // (e.g. via <select><option> matching args.text) is deferred -- MVP
      // treats select like click on the indexed element and lets the agent
      // call browser_observe again to interact with the popped option list.
      await ops.dispatchInput("click", { x: cx, y: cy });
    }
    return { ok: true as const, element: el };
  });
}

function getSchemaKeys(s: unknown): string[] {
  if (!s || typeof s !== "object") return [];
  const props = (s as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props as Record<string, unknown>);
}

export async function handleBrowserExtract(
  service: BrowserService,
  contextId: string,
  args: { schema: Record<string, unknown>; instruction?: string }
): Promise<{ extracted: unknown } | { error: string }> {
  if (!args.schema || typeof args.schema !== "object") {
    throw new Error("browser_extract: 'schema' (object) is required");
  }
  const keys = getSchemaKeys(args.schema);
  console.log(
    `[BrowserTools] browser_extract(${contextId}, schema keys: ${keys.length ? keys.join(",") : "<none>"})`
  );
  const ops = await resolveOps(service, contextId);
  return withLock(service, contextId, async () => {
    try {
      const a11y = await ops.accessibilitySnapshot();
      // MVP: return discovery payload (a11y snapshot + schemaEcho + page metadata).
      // Full LLM-driven extraction landing in a follow-up plan -- the schema
      // is echoed back so a downstream LLM call can do the structured output.
      return {
        extracted: {
          url: a11y.url,
          title: a11y.title,
          ariaSnapshot: a11y.ariaSnapshot,
          schemaEcho: args.schema,
          instruction: args.instruction,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `browser_extract failed: ${msg}` };
    }
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
    const vp = ops.viewport();
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
    const vp = ops.viewport();
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
