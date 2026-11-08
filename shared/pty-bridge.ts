/**
 * Why the terminal bridge in use is the one it is. The server decides it
 * (server/lib/pty-bridge-selection.ts, routes/terminal.ts) and the Performance
 * panel words it as `perf.ptyBridge.reason.<code>`: a code and not a sentence,
 * so the two sides cannot drift apart.
 */
export type PtyBridgeReason =
  | "override"
  | "checkout"
  | "disabled"
  | "stale"
  | "notBuilt"
  | "reused"
  | "disconnected"
  | "notConnected";
