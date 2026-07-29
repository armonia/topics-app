/**
 * Handshake WS lato client.
 *
 * Gli schemi (`hello`, `welcome`, `upgrade-required`) NON vivono più qui: erano
 * una copia a mano di `server/schemas/ws-handshake.ts` tenuta insieme da un
 * commento "KEEP IN SYNC". Ora sono in `shared/ws-handshake.ts`, unica fonte
 * per i due progetti TS. Restano qui solo le costanti che descrivono QUESTA
 * build del client — il server ha le sue in `server/ws-capabilities.ts`.
 */
export {
  helloMessageSchema,
  welcomeMessageSchema,
  upgradeRequiredSchema,
  parseHelloMessage,
  parseWelcomeMessage,
  type HelloMessage,
  type WelcomeMessage,
  type UpgradeRequiredMessage,
} from '../../../shared/ws-handshake';

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
