// The shapes the ai-bridge client hands to its callers. Out of `ai-bridge-client.ts`, which re-exports them.

export interface SpawnOpts {
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface SessionHandlers {
  /** A stdout NDJSON chunk arrived at byte `offset` in the durable store. */
  onData: (chunk: Buffer, offset: number) => void;
  /** A stderr chunk (rate-limit / missing-session detection lives in the provider). */
  onStderr?: (chunk: Buffer) => void;
  /** The child exited (crash/normal). `exitCode` null = signal/error; `endOffset` absent from a daemon older than the field. */
  onExit?: (exitCode: number | null, endOffset?: number) => void;
}
export interface AttachResult {
  endOffset: number;
  alive: boolean;
  exitCode: number | null;
  /** True when the daemon had no session for this id (nothing to re-attach). */
  missing?: boolean;
  /** When the child last wrote to its store (epoch ms); absent from a daemon older than the field. */
  lastDataAt?: number;
  /** The daemon's frame protocol (`PROTOCOL` in ai-bridge.mjs); 1 for a daemon that predates the field. */
  protocol: number;
}
export interface SessionInfo {
  id: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  endOffset: number;
  createdAt: number;
}
