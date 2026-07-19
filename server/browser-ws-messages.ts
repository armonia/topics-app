/**
 * Phase 30 BROWSER-CHAT-02 — discriminated union for the /ws/browser/:contextId
 * bidirectional protocol. Shared between Bun server and React client via
 * mirrored Zod schemas (this file is the canonical source).
 *
 * Direction conventions:
 *   - frame, agent_active, console, download, engine:  server -> client only
 *   - input, take_control, resize, set_engine:         client -> server only
 *   - nav:                                             both directions (request from either side, response broadcast)
 *
 * KEEP IN SYNC: client/src/types/browser-ws-messages.ts mirrors this file.
 * The composite tsconfig boundary forbids cross-import via TS6307, so the
 * Zod schema is duplicated. When adding a variant: edit BOTH files; the
 * Zod schema is the source of truth, the TS type is generated via z.infer.
 *
 * Migrated from manual type-union + type guard to Zod (v3 foundations WS-01)
 * on 2026-05-12 — full payload validation at the WS receive boundary instead
 * of just the `type` discriminator.
 */
import { z } from 'zod';

// ----- Subschemas (reused across variants) -----------------------------------

const inputActionSchema = z.enum(['click', 'type', 'scroll', 'mousemove', 'keypress']);
const inputButtonSchema = z.enum(['left', 'right', 'middle']);

const inputPayloadSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  button: inputButtonSchema.optional(),
});

const frameMetadataSchema = z.object({
  timestamp: z.number(),
  pageScaleFactor: z.number().optional(),
  deviceWidth: z.number().optional(),
  deviceHeight: z.number().optional(),
});

// ----- Message variants ------------------------------------------------------

/** Server -> client: base64 JPEG payload from CDP screencastFrame.data */
const frameMessageSchema = z.object({
  type: z.literal('frame'),
  data: z.string(),
  metadata: frameMetadataSchema,
});

/** Client -> server: forwarded to BrowserService.dispatchInput */
const inputMessageSchema = z.object({
  type: z.literal('input'),
  action: inputActionSchema,
  payload: inputPayloadSchema,
});

/** Both directions: request from either side, response broadcast.
 *  phase 'error' (server -> client) carries a failed goto/launch: `error` is a
 *  short human-readable reason the panel renders with a Retry affordance —
 *  without it a refused connection / missing Chromium left the pane silently
 *  on the previous page or on an infinite "Starting browser…". Additive:
 *  older clients that only know request/response fail zod-parse on 'error'
 *  and drop the frame, which degrades to the previous (silent) behaviour. */
const navMessageSchema = z.object({
  type: z.literal('nav'),
  url: z.string(),
  phase: z.enum(['request', 'response', 'error']),
  error: z.string().optional(),
});

/** Server -> client: lock state for the UI overlay in RemoteBrowserPanel */
const agentActiveMessageSchema = z.object({
  type: z.literal('agent_active'),
  active: z.boolean(),
  /** Human-readable label of WHAT the agent is doing (e.g. "Clicca",
   *  "Naviga su example.com"). Present only on active=true broadcasts. */
  action: z.string().optional(),
});

/** Server -> client: forwarded console messages from the page */
const consoleMessageSchema = z.object({
  type: z.literal('console'),
  level: z.enum(['log', 'warn', 'error']),
  text: z.string(),
});

/** Client -> server (BROWSER-CHAT-04): user reclaimed control */
const takeControlMessageSchema = z.object({
  type: z.literal('take_control'),
});

/** Client -> server: the pane's real on-screen size (CSS px) + its
 *  devicePixelRatio, so the server viewport matches the pane (kills the fixed
 *  1280 letterbox) and renders HiDPI-sharp. width/height are CSS px; the server
 *  clamps deviceScaleFactor and multiplies the screencast frame dims by it.
 *  NOTE (Playwright): deviceScaleFactor is immutable per BrowserContext — it is
 *  applied when the context is CREATED (first-DPR-wins) via a per-context hint;
 *  a later DPR change only takes effect after the context is reaped+recreated. */
const resizeMessageSchema = z.object({
  type: z.literal('resize'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().min(1).max(3).optional(),
});

/** Server -> client: a download the headless page triggered, saved server-side
 *  under our own origin. `href` points at the saved file (user-clicked link),
 *  which satisfies the "no silent/auto download" rule — the web streaming pane
 *  has no native download shelf otherwise (DownloadStrip is Tauri-only). */
const downloadMessageSchema = z.object({
  type: z.literal('download'),
  filename: z.string(),
  href: z.string(),
  size: z.number().optional(),
  state: z.enum(['started', 'completed', 'failed']),
});

/** Client -> server (engine switch, task 54601eeb): request that this pane run on
 *  a different browser ENGINE. 'native' = the default headless-Chromium stream (or
 *  the OS WebView on Tauri); 'chromium' = a real, user-installed Chromium-family
 *  browser driven over CDP so the user's extensions load. Gated server-side by the
 *  TOPICS_CHROMIUM_ENGINE flag — ignored (no engine broadcast) when disabled, so
 *  older/uncapable servers simply never switch. */
const setEngineMessageSchema = z.object({
  type: z.literal('set_engine'),
  engine: z.enum(['native', 'chromium']),
});

/** Server -> client: the engine this pane is now running on, broadcast after a
 *  switch (or on first advertise). `extensions` is the count loaded into the
 *  chromium sidecar profile, for the toolbar badge ("Chromium · N estensioni").
 *  Additive: clients that predate the switch drop this variant at parse. */
const engineMessageSchema = z.object({
  type: z.literal('engine'),
  engine: z.enum(['native', 'chromium']),
  extensions: z.number().int().nonnegative().optional(),
});

// ----- Top-level discriminated union ----------------------------------------

export const browserWsMessageSchema = z.discriminatedUnion('type', [
  frameMessageSchema,
  inputMessageSchema,
  navMessageSchema,
  agentActiveMessageSchema,
  consoleMessageSchema,
  takeControlMessageSchema,
  resizeMessageSchema,
  downloadMessageSchema,
  setEngineMessageSchema,
  engineMessageSchema,
]);

export type BrowserWsMessage = z.infer<typeof browserWsMessageSchema>;

// ----- Public API ------------------------------------------------------------

/**
 * Validate and parse a value as a BrowserWsMessage.
 * Returns a discriminated result so callers can distinguish protocol errors
 * from successful parses without try/catch.
 */
export type ParseResult =
  | { ok: true; data: BrowserWsMessage }
  | { ok: false; error: string };

export function parseBrowserWsMessage(value: unknown): ParseResult {
  const result = browserWsMessageSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const error = result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
  return { ok: false, error };
}

/**
 * Backward-compatible boolean type guard. New code should prefer
 * `parseBrowserWsMessage` to get error context.
 */
export function isBrowserWsMessage(value: unknown): value is BrowserWsMessage {
  return browserWsMessageSchema.safeParse(value).success;
}

/** Helper: serialize a server-side message and send via Bun ServerWebSocket. */
export function sendBrowserWsMessage<T extends { send: (data: string) => void }>(
  ws: T,
  msg: BrowserWsMessage,
): void {
  ws.send(JSON.stringify(msg));
}
