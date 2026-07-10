/**
 * Phase 30 BROWSER-CHAT-02 — discriminated union for the /ws/browser/:contextId
 * bidirectional protocol. Shared between Bun server and React client via
 * mirrored Zod schemas (this file is the canonical source).
 *
 * Direction conventions:
 *   - frame, agent_active, console:  server -> client only
 *   - input, take_control:           client -> server only
 *   - nav:                           both directions (request from either side, response broadcast)
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

// ----- Top-level discriminated union ----------------------------------------

export const browserWsMessageSchema = z.discriminatedUnion('type', [
  frameMessageSchema,
  inputMessageSchema,
  navMessageSchema,
  agentActiveMessageSchema,
  consoleMessageSchema,
  takeControlMessageSchema,
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
