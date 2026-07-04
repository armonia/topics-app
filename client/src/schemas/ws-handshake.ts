/**
 * Client mirror of `server/schemas/ws-handshake.ts` for the v3 foundations
 * WS-02 handshake protocol.
 *
 * Why a mirror: the composite TS project boundary (TS6307) forbids
 * cross-imports from `server/`. The Zod schema is duplicated; the
 * canonical type is derived via `z.infer` on both sides — drift is caught
 * by structural-equality assignability tests in the test files.
 */
// Uses `zod/mini` (functional, tree-shakable API) so these client-bundled
// schemas don't drag the method-heavy core into the critical entry chunk.
// Parse methods (`.safeParse`) are identical across full zod and zod/mini.
import { z } from 'zod/mini';

// ----- Client -> Server: hello ----------------------------------------------

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  clientVersion: z.string(),
  protocolVersion: z.int(),
  capabilities: z.array(z.string()),
});

export type HelloMessage = z.infer<typeof helloMessageSchema>;

// ----- Server -> Client: upgrade-required (future) --------------------------

export const upgradeRequiredSchema = z.object({
  type: z.literal('upgrade-required'),
  minClientProtocolVersion: z.int(),
  currentClientProtocolVersion: z.int(),
  message: z.string(),
});

export type UpgradeRequiredMessage = z.infer<typeof upgradeRequiredSchema>;

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
