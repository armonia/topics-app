/**
 * Canonical list of WebSocket protocol capabilities advertised by this
 * server build, plus version constants used by the handshake (v3
 * foundations WS-02).
 *
 * Capabilities are stable string identifiers that clients can check at
 * connection time to know which features are available. Add a new
 * capability when shipping a feature that changes the wire protocol or
 * introduces a new message type that clients can opt into.
 *
 * Do NOT change a capability string after release — clients depend on
 * exact-match. To deprecate, add the replacement and ship both in
 * parallel for one major version.
 */

/**
 * Increment when the wire protocol gets a breaking change (e.g., removing
 * a message field, narrowing a type, requiring a previously-optional
 * field). Clients with `clientProtocolVersion < SERVER_PROTOCOL_VERSION`
 * are considered out-of-date and should be prompted to upgrade.
 *
 * Backward-compat policy: server SHOULD continue serving clients one
 * major version behind in read-only mode (per WS-06).
 */
export const SERVER_PROTOCOL_VERSION = 1 as const;

/**
 * Capabilities advertised by this build. Each is a stable identifier.
 * Names follow the convention `<feature>-v<n>` for versioned features,
 * or `<feature>` for stable single-version features.
 */
export const SERVER_CAPABILITIES = [
  // v3 foundations WS-01: Zod-validated message envelopes on /ws and /ws/browser
  'ws-validation-v1',
  // Phase 30 BROWSER-CHAT-02: bidirectional /ws/browser/:contextId protocol
  'browser-ws-v1',
  // ToolCallDetail discriminated union with per-tool typed rendering (NORM-01)
  'tool-detail-v1',
  // chat-fast-mode toggle (faster provider model when on)
  'chat-fast-mode',
  // ask-user-tool: stream pauses, UI shows form, resume on submit
  'ask-user-tool',
  // stream:catchup carries toolCalls + blocks for mid-stream attach
  'stream-catchup-v1',
] as const;

/**
 * Best-effort read of the server version. Used for the welcome message
 * so clients can show "server: 1.2.3" or compare against their own. Not
 * a hard versioning gate — that's `SERVER_PROTOCOL_VERSION` above.
 *
 * Reads from package.json at module load. If the read fails (e.g., file
 * missing in a test bundle), falls back to "0.0.0-unknown" — handshake
 * still works, just the human-readable version label is generic.
 */
export const SERVER_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- il
    // `try/catch` è il punto di questo blocco, e un `import` statico non ci sta
    // dentro: viene issato e risolto prima del corpo del modulo, quindi un
    // package.json assente (bundle di test) farebbe fallire l'INTERO modulo
    // invece di ricadere sull'etichetta generica qui sotto.
    const pkg = require('../package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
})();
