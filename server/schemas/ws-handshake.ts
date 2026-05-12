/**
 * v3 foundations WS-02 — Schema-stable WebSocket handshake.
 *
 * The handshake exchanges version + capabilities at connection time so
 * either side can detect protocol drift and surface a structured upgrade
 * prompt instead of crashing silently.
 *
 * Flow:
 *   1. Client opens /ws.
 *   2. Server immediately emits `connected` (existing message, byte-compat
 *      with v2.x clients) followed by `welcome` (new in v3).
 *   3. Client optionally sends `hello` with its own version and capability
 *      list. Old clients that don't send hello are treated as v1.
 *   4. Server logs the hello and, if `clientProtocolVersion <
 *      SERVER_PROTOCOL_VERSION`, may emit `upgrade-required` (future work;
 *      for now just logs since SERVER_PROTOCOL_VERSION is 1).
 *
 * KEEP IN SYNC with `client/src/schemas/ws-handshake.ts` (mirror; TS6307
 * forbids cross-project imports).
 */
import { z } from 'zod';

// ----- Server -> Client: welcome --------------------------------------------

export const welcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  /** Human-readable server version (from package.json). */
  serverVersion: z.string(),
  /** Integer protocol version. Compare against client's to detect drift. */
  protocolVersion: z.number().int(),
  /** Stable capability identifiers the server supports. */
  capabilities: z.array(z.string()),
  /** Server-side wall-clock (ms since epoch). Clients can use for clock skew. */
  serverTime: z.number(),
  /** Echo of the WS client id (matches `connected.clientId`). */
  clientId: z.string(),
});

export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;

// ----- Client -> Server: hello ----------------------------------------------

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  /** Human-readable client version (from package.json). */
  clientVersion: z.string(),
  /** Integer protocol version. */
  protocolVersion: z.number().int(),
  /** Capabilities the client knows how to use. Empty = legacy. */
  capabilities: z.array(z.string()),
});

export type HelloMessage = z.infer<typeof helloMessageSchema>;

// ----- Server -> Client: upgrade-required (future) --------------------------

/**
 * Sent when the server detects a client is too old to operate safely.
 * For SERVER_PROTOCOL_VERSION = 1 this is never emitted; reserved for v2+
 * where structured upgrade prompts become necessary.
 */
export const upgradeRequiredSchema = z.object({
  type: z.literal('upgrade-required'),
  minClientProtocolVersion: z.number().int(),
  currentClientProtocolVersion: z.number().int(),
  message: z.string(),
});

export type UpgradeRequiredMessage = z.infer<typeof upgradeRequiredSchema>;

// ----- Public API -----------------------------------------------------------

export type WelcomeParseResult =
  | { ok: true; data: WelcomeMessage }
  | { ok: false; error: string };

export function parseWelcomeMessage(value: unknown): WelcomeParseResult {
  const result = welcomeMessageSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
      .join('; '),
  };
}

export type HelloParseResult =
  | { ok: true; data: HelloMessage }
  | { ok: false; error: string };

export function parseHelloMessage(value: unknown): HelloParseResult {
  const result = helloMessageSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
      .join('; '),
  };
}
