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

// Default budget of vision calls (read_screen + point, shared) per context. 5 was
// too tight for multi-step agent flows on the native pane (which lives on ONE
// long-lived contextId and only resets on pane-destroy); 20 gives real headroom
// while still capping runaway Moondream spend. Override via MOONDREAM_MAX_CALLS_PER_TASK.
const DEFAULT_MAX_CALLS_PER_TASK = 20;

function getMaxCallsPerTask(): number {
  const raw = process.env.MOONDREAM_MAX_CALLS_PER_TASK;
  if (!raw) return DEFAULT_MAX_CALLS_PER_TASK;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CALLS_PER_TASK;
  return Math.floor(parsed);
}

export function resetMoondreamCounter(contextId: string): void {
  counter.delete(contextId);
}

/**
 * Give back a charged call. The counter is charged BEFORE the request so a
 * retry loop can't spend the budget twice, but a rejected KEY never bought any
 * vision: leaving it charged turned one misconfiguration into two different
 * errors (first "HTTP 401", then "budget exceeded" for the rest of the pane's
 * life), and the second one names the wrong culprit.
 */
function refundCall(contextId: string): void {
  const used = counter.get(contextId) ?? 0;
  if (used > 0) counter.set(contextId, used - 1);
}

/** Is the vision provider refusing the CREDENTIAL rather than the request? */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * The message an agent actually needs when the vision provider answers.
 *
 * Measured on 2026-09-03/05 (card 7bbefd9e): 26 `browser_read_screen` calls on
 * this machine, 26 failures, zero successes, all of them HTTP 401 from a key
 * the .env still carried. The route reports them as 502, so what reached the
 * agent read like a dead gateway on a live pane: it retried, then spent three
 * minutes routing around a tool that could never work. A rejected key is not
 * transient, and saying so out loud (plus which tools DO work meanwhile) is the
 * difference between one failed call and a wasted turn.
 */
export function visionApiErrorMessage(status: number, tool: string): string {
  if (isAuthStatus(status)) {
    return (
      `Vision unavailable: the vision provider rejected MOONDREAM_API_KEY (HTTP ${status}). ` +
      `This is a configuration error, not a transient one - retrying ${tool} will fail the same way. ` +
      `Set a valid key in .env (or Settings) and restart the server. ` +
      `Meanwhile read the page with browser_get_text / browser_observe, or capture it with browser_screenshot.`
    );
  }
  if (status === 429) {
    return `Vision rate-limited by the provider (HTTP 429) on ${tool}. Wait before retrying, or read the page with browser_get_text / browser_observe.`;
  }
  return `Moondream API error: HTTP ${status}`;
}

interface PointObjectArgs {
  contextId: string;
  imageBase64: string;
  description: string;
  viewport: { width: number; height: number };
  /** Image MIME (default image/jpeg). The Tauri native pane snapshots as PNG. */
  mime?: string;
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
        image_url: `data:${args.mime ?? "image/jpeg"};base64,${imageBase64}`,
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
    if (isAuthStatus(resp.status)) refundCall(contextId);
    return {
      error: visionApiErrorMessage(resp.status, "browser_point"),
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

/** Hard ceiling on vision text returned to the agent (post de-loop). */
const VISION_TEXT_MAX_CHARS = 2000;

/**
 * Collapse pathological repetition. Small vision models (moondream included)
 * can fall into a degenerate decode loop on dense/edge pages and emit the SAME
 * phrase or line thousands of times ("infinite repeated output"). Left raw it
 * floods the agent's context. We collapse any consecutively-repeated unit —
 * lines first, then word n-grams (1..10 words) repeated >=4× — down to a few
 * copies, deterministically and in O(n * unit).
 */
function collapseRepeats(text: string): string {
  // 1) Repeated lines (e.g. the same line 200×).
  const lines = text.split(/\r?\n/);
  const outLines: string[] = [];
  let prev: string | null = null;
  let run = 0;
  for (const ln of lines) {
    if (ln === prev) {
      run += 1;
      if (run < 2) outLines.push(ln); // keep at most 2 copies of a repeated line
    } else {
      prev = ln;
      run = 0;
      outLines.push(ln);
    }
  }
  // 2) Repeated word n-grams within the (now line-deduped) stream.
  return collapseWordGrams(outLines.join("\n"));
}

function collapseWordGrams(text: string, maxUnit = 10, keep = 3, minReps = 4): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 8) return text;
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    const maxU = Math.min(maxUnit, Math.floor((words.length - i) / 2));
    // Smallest unit first → collapse to the minimal repeating token ("the the
    // the the…" → 3× "the", not 3× a 10-gram of "the"). A larger genuine unit
    // (distinct words) is still caught once the smaller sizes fail to repeat.
    for (let u = 1; u <= maxU; u++) {
      const unit = words.slice(i, i + u).join("\u0000");
      let reps = 1;
      while (
        i + (reps + 1) * u <= words.length &&
        words.slice(i + reps * u, i + (reps + 1) * u).join("\u0000") === unit
      ) {
        reps += 1;
      }
      if (reps >= minReps) {
        for (let k = 0; k < keep; k++) out.push(...words.slice(i, i + u));
        i += reps * u;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(words[i]);
      i += 1;
    }
  }
  return out.join(" ");
}

/** De-loop + hard-cap vision text before it reaches the agent. */
export function clampVisionText(raw: string, maxChars = VISION_TEXT_MAX_CHARS): string {
  let text = (raw || "").trim();
  if (!text) return text;
  // Bound CPU on a runaway response before the O(n) de-loop.
  if (text.length > 40_000) text = text.slice(0, 40_000);
  text = collapseRepeats(text);
  if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd() + "…[truncated]";
  return text;
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
  /** Image MIME (default image/jpeg). The Tauri native pane snapshots as PNG. */
  mime?: string;
}): Promise<MoondreamVisionResult | MoondreamPointError> {
  const { contextId, imageBase64, question } = args;

  const apiKey = process.env.MOONDREAM_API_KEY;
  if (!apiKey) {
    return {
      error:
        "Vision unavailable: MOONDREAM_API_KEY not set. Set it in .env to enable browser_read_screen. " +
        "Meanwhile read the page with browser_get_text / browser_observe, or capture it with browser_screenshot.",
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

  const image_url = `data:${args.mime ?? "image/jpeg"};base64,${imageBase64}`;
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
    if (isAuthStatus(resp.status)) refundCall(contextId);
    return { error: visionApiErrorMessage(resp.status, "browser_read_screen"), details: text };
  }

  let text = "";
  try {
    const parsed = (await resp.json()) as MoondreamQueryResponse & MoondreamCaptionResponse;
    text = (useQuery ? parsed.answer : parsed.caption) ?? "";
  } catch (err: unknown) {
    return { error: `Moondream response parse error: ${err instanceof Error ? err.message : String(err)}`, details: err };
  }

  // De-loop + cap before returning — a degenerate decode loop (the same phrase
  // repeated forever on a dense page) must not flood the agent's context.
  const rawLen = text.length;
  text = clampVisionText(text);

  if (process.env.MOONDREAM_DEBUG) {
    console.log(`[Moondream] ${useQuery ? "query" : "caption"} -> ${text.length} chars${rawLen !== text.length ? ` (de-looped from ${rawLen})` : ""} (used ${used + 1}/${max} for ctx ${contextId})`);
  }
  return { text, callsRemaining: max - (used + 1) };
}
