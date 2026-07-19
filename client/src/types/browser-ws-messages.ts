/**
 * Phase 30 BROWSER-CHAT-02 — client-side Zod schema for the WS message envelope.
 * KEEP IN SYNC with `server/browser-ws-messages.ts` (canonical source).
 *
 * Why a duplicate instead of a re-export from `../../../server/...`?
 * The client `tsconfig.app.json` is a `composite` project rooted at `src/`.
 * TypeScript enforces TS6307 ("file not listed within project") on any
 * `import type` that crosses the `include` boundary. Vite resolves the path
 * at build time, but `tsc --noEmit` (the strict gate this plan signs off on)
 * refuses to compile.
 *
 * The mirror is at the Zod schema level so the protocol contract is identical
 * — both sides validate against the same shape. Type is derived via z.infer.
 *
 * Migrated from a manual type union to Zod (v3 foundations WS-01) on
 * 2026-05-12 — the client now validates every inbound WS message instead of
 * casting it unsafely.
 *
 * Uses `zod/mini` (functional, tree-shakable API) so this client-bundled
 * schema doesn't drag the method-heavy core into the critical entry chunk.
 * `z.optional(...)` replaces the `.optional()` method; `.safeParse` is identical.
 */
import { z } from 'zod/mini';

const inputActionSchema = z.enum(['click', 'type', 'scroll', 'mousemove', 'keypress']);
const inputButtonSchema = z.enum(['left', 'right', 'middle']);

const inputPayloadSchema = z.object({
  x: z.optional(z.number()),
  y: z.optional(z.number()),
  text: z.optional(z.string()),
  key: z.optional(z.string()),
  deltaX: z.optional(z.number()),
  deltaY: z.optional(z.number()),
  button: z.optional(inputButtonSchema),
});

const frameMetadataSchema = z.object({
  timestamp: z.number(),
  pageScaleFactor: z.optional(z.number()),
  deviceWidth: z.optional(z.number()),
  deviceHeight: z.optional(z.number()),
});

const frameMessageSchema = z.object({
  type: z.literal('frame'),
  data: z.string(),
  metadata: frameMetadataSchema,
});

const inputMessageSchema = z.object({
  type: z.literal('input'),
  action: inputActionSchema,
  payload: inputPayloadSchema,
});

const navMessageSchema = z.object({
  type: z.literal('nav'),
  url: z.string(),
  // 'error' (server -> client): goto/launch failed; `error` carries the short
  // reason the panel renders with Retry (BRW-REL-02). Mirrors server schema.
  phase: z.enum(['request', 'response', 'error']),
  error: z.optional(z.string()),
});

const agentActiveMessageSchema = z.object({
  type: z.literal('agent_active'),
  active: z.boolean(),
  /** What the agent is doing (e.g. "Clicca", "Naviga su example.com"). active=true only. */
  action: z.optional(z.string()),
});

const consoleMessageSchema = z.object({
  type: z.literal('console'),
  level: z.enum(['log', 'warn', 'error']),
  text: z.string(),
});

const takeControlMessageSchema = z.object({
  type: z.literal('take_control'),
});

/** Client -> server: real pane size (CSS px) + devicePixelRatio. See the
 *  canonical server schema for the deviceScaleFactor immutability note. */
const resizeMessageSchema = z.object({
  type: z.literal('resize'),
  width: z.number(),
  height: z.number(),
  deviceScaleFactor: z.optional(z.number()),
});

/** Server -> client: a headless-page download saved under our origin. */
const downloadMessageSchema = z.object({
  type: z.literal('download'),
  filename: z.string(),
  href: z.string(),
  size: z.optional(z.number()),
  state: z.enum(['started', 'completed', 'failed']),
});

/** Client -> server: request this pane run on a different engine (native ↔
 *  chromium). Ignored by servers without the TOPICS_CHROMIUM_ENGINE flag. */
const setEngineMessageSchema = z.object({
  type: z.literal('set_engine'),
  engine: z.enum(['native', 'chromium']),
});

/** Server -> client: the engine this pane now runs on (+ extension count for the
 *  toolbar badge). Mirrors the canonical server schema. */
const engineMessageSchema = z.object({
  type: z.literal('engine'),
  engine: z.enum(['native', 'chromium']),
  extensions: z.optional(z.number()),
});

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

export type ParseResult =
  | { ok: true; data: BrowserWsMessage }
  | { ok: false; error: string };

/**
 * Validate and parse a value as a BrowserWsMessage. Use this at every WS
 * receive boundary instead of `as BrowserWsMessage` unsafe casts.
 */
export function parseBrowserWsMessage(value: unknown): ParseResult {
  const result = browserWsMessageSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const error = result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
  return { ok: false, error };
}
