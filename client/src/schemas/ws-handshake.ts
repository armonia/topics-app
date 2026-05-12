/**
 * Client mirror of `server/schemas/ws-handshake.ts` for the v3 foundations
 * WS-02 handshake protocol.
 *
 * Why a mirror: the composite TS project boundary (TS6307) forbids
 * cross-imports from `server/`. The Zod schema is duplicated; the
 * canonical type is derived via `z.infer` on both sides — drift is caught
 * by structural-equality assignability tests in the test files.
 */
import { z } from 'zod';

// ----- Server -> Client: welcome --------------------------------------------

export const welcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
  capabilities: z.array(z.string()),
  serverTime: z.number(),
  clientId: z.string(),
});

export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;

// ----- Client -> Server: hello ----------------------------------------------

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  clientVersion: z.string(),
  protocolVersion: z.number().int(),
  capabilities: z.array(z.string()),
});

export type HelloMessage = z.infer<typeof helloMessageSchema>;

// ----- Server -> Client: upgrade-required (future) --------------------------

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

// ----- Client capabilities advertised in hello ------------------------------

/**
 * Canonical capability list this client build understands. Must match the
 * server's view if the feature is used — server has the source of truth in
 * `server/ws-capabilities.ts`.
 */
export const CLIENT_PROTOCOL_VERSION = 1 as const;

export const CLIENT_CAPABILITIES = [
  'ws-validation-v1',
  'browser-ws-v1',
  'tool-detail-v1',
  'chat-fast-mode',
  'ask-user-tool',
  'stream-catchup-v1',
] as const;

/**
 * Best-effort client version. In Vite/electron this is injected at build
 * time via `import.meta.env.VITE_APP_VERSION`. Falls back to a generic
 * marker if not set so the handshake still works.
 */
export const CLIENT_VERSION: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_VERSION) || '0.0.0-dev';
