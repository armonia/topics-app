/**
 * Phase 30 BROWSER-CHAT-03 -- Moondream cloud API client.
 *
 * Used by the browser_point agent tool as a vision FALLBACK when
 * browser_observe DOM indexing returns too few elements (canvas, captcha,
 * cross-origin iframe). Cost guard via per-contextId counter.
 *
 * Endpoint: https://api.moondream.ai/v1/point
 * Auth: header X-Moondream-Auth (NOT Bearer -- verified via
 *       https://docs.moondream.ai/skills/point cURL example).
 * Request: { image_url: 'data:image/jpeg;base64,<...>', object: '<description>' }
 * Response: { request_id: string, points: Array<{ x: 0..1, y: 0..1 }> }
 *
 * Failsoft: missing MOONDREAM_API_KEY returns a structured error to the
 * agent (no crash). Network errors caught + returned as { error, details }.
 * Cost guard: MOONDREAM_MAX_CALLS_PER_TASK env (default 5) enforced before
 * the HTTP call; over-limit returns structured error.
 *
 * Counter is reset by resetMoondreamCounter() -- called when a context is
 * destroyed (or by tests that need a clean slate).
 */

interface MoondreamPointResponse {
  request_id: string;
  points: Array<{ x: number; y: number }>;
}

export interface MoondreamPointResult {
  /** Viewport-scaled pixel coordinates (already multiplied by viewport.width/height). */
  points: Array<{ x: number; y: number }>;
  callsRemaining: number;
}

export interface MoondreamPointError {
  error: string;
  details?: unknown;
}

const counter = new Map<string, number>();

function getMaxCallsPerTask(): number {
  const raw = process.env.MOONDREAM_MAX_CALLS_PER_TASK;
  if (!raw) return 5;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.floor(parsed);
}

export function resetMoondreamCounter(contextId: string): void {
  counter.delete(contextId);
}

export function getMoondreamUsage(contextId: string): { used: number; max: number } {
  return { used: counter.get(contextId) ?? 0, max: getMaxCallsPerTask() };
}

interface PointObjectArgs {
  contextId: string;
  imageBase64: string;
  description: string;
  viewport: { width: number; height: number };
}

export async function pointObject(
  args: PointObjectArgs
): Promise<MoondreamPointResult | MoondreamPointError> {
  const { contextId, imageBase64, description, viewport } = args;

  if (
    !viewport ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return {
      error: "Invalid viewport: width/height must be finite positive numbers.",
      details: viewport,
    };
  }

  const apiKey = process.env.MOONDREAM_API_KEY;
  if (!apiKey) {
    return {
      error:
        "Vision fallback unavailable: MOONDREAM_API_KEY not set. Set it in .env to enable browser_point tool.",
    };
  }

  const max = getMaxCallsPerTask();
  const used = counter.get(contextId) ?? 0;
  if (used >= max) {
    return {
      error: `Vision fallback budget exceeded: used ${used}/${max} calls for context "${contextId}". Counter resets when the BrowserContext is destroyed.`,
    };
  }

  // Increment BEFORE the network call so a failed call still consumes
  // budget -- prevents pathological retry loops.
  counter.set(contextId, used + 1);

  let resp: Response;
  try {
    resp = await fetch("https://api.moondream.ai/v1/point", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Moondream-Auth": apiKey,
      },
      body: JSON.stringify({
        image_url: `data:image/jpeg;base64,${imageBase64}`,
        object: description,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Moondream network error: ${msg}`, details: err };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "<no body>");
    return {
      error: `Moondream API error: HTTP ${resp.status}`,
      details: text,
    };
  }

  let parsed: MoondreamPointResponse;
  try {
    parsed = (await resp.json()) as MoondreamPointResponse;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Moondream response parse error: ${msg}`, details: err };
  }

  if (!Array.isArray(parsed.points)) {
    return {
      error: "Moondream response shape invalid: missing points array",
      details: parsed,
    };
  }

  // Scale 0..1 normalized coords to viewport pixels. Skip any point whose
  // coords aren't finite numbers (defensive against a malformed response).
  const scaled = parsed.points
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .map((p) => ({
      x: Math.round(p.x * viewport.width),
      y: Math.round(p.y * viewport.height),
    }));

  if (process.env.MOONDREAM_DEBUG) {
    console.log(
      `[Moondream] point("${description}") -> ${scaled.length} candidates (used ${used + 1}/${max} for ctx ${contextId})`
    );
  }

  return {
    points: scaled,
    callsRemaining: max - (used + 1),
  };
}

export interface MoondreamVisionResult {
  /** Text answer (for a question) or caption. */
  text: string;
  callsRemaining: number;
}

interface MoondreamQueryResponse { answer?: string; request_id?: string }
interface MoondreamCaptionResponse { caption?: string; request_id?: string }

/**
 * Vision → TEXT for browser_read_screen: ask a question about the screenshot
 * (/v1/query) or get a caption (/v1/caption). Returns text only — the image is
 * never put in the agent's context. Same auth/budget/failsoft model as
 * pointObject.
 */
export async function describeImage(args: {
  contextId: string;
  imageBase64: string;
  question?: string;
  length?: "short" | "normal" | "long";
}): Promise<MoondreamVisionResult | MoondreamPointError> {
  const { contextId, imageBase64, question } = args;

  const apiKey = process.env.MOONDREAM_API_KEY;
  if (!apiKey) {
    return {
      error:
        "Vision unavailable: MOONDREAM_API_KEY not set. Set it in .env to enable browser_read_screen.",
    };
  }

  const max = getMaxCallsPerTask();
  const used = counter.get(contextId) ?? 0;
  if (used >= max) {
    return {
      error: `Vision budget exceeded: used ${used}/${max} calls for context "${contextId}". Counter resets when the BrowserContext is destroyed.`,
    };
  }
  counter.set(contextId, used + 1); // charge before the call (retry-loop guard)

  const image_url = `data:image/jpeg;base64,${imageBase64}`;
  const useQuery = typeof question === "string" && question.trim().length > 0;
  const endpoint = useQuery
    ? "https://api.moondream.ai/v1/query"
    : "https://api.moondream.ai/v1/caption";
  const body = useQuery
    ? { image_url, question }
    : { image_url, length: args.length ?? "normal" };

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Moondream-Auth": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    return { error: `Moondream network error: ${err instanceof Error ? err.message : String(err)}`, details: err };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<no body>");
    return { error: `Moondream API error: HTTP ${resp.status}`, details: text };
  }

  let text = "";
  try {
    const parsed = (await resp.json()) as MoondreamQueryResponse & MoondreamCaptionResponse;
    text = (useQuery ? parsed.answer : parsed.caption) ?? "";
  } catch (err: unknown) {
    return { error: `Moondream response parse error: ${err instanceof Error ? err.message : String(err)}`, details: err };
  }

  if (process.env.MOONDREAM_DEBUG) {
    console.log(`[Moondream] ${useQuery ? "query" : "caption"} -> ${text.length} chars (used ${used + 1}/${max} for ctx ${contextId})`);
  }
  return { text, callsRemaining: max - (used + 1) };
}
