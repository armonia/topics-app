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
 */
import { z } from 'zod';

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
  phase: z.enum(['request', 'response']),
});

const agentActiveMessageSchema = z.object({
  type: z.literal('agent_active'),
  active: z.boolean(),
});

const consoleMessageSchema = z.object({
  type: z.literal('console'),
  level: z.enum(['log', 'warn', 'error']),
  text: z.string(),
});

const takeControlMessageSchema = z.object({
  type: z.literal('take_control'),
});

export const browserWsMessageSchema = z.discriminatedUnion('type', [
  frameMessageSchema,
  inputMessageSchema,
  navMessageSchema,
  agentActiveMessageSchema,
  consoleMessageSchema,
  takeControlMessageSchema,
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
