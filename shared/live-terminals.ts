/**
 * One live terminal on the Mac, inside or outside Topics: the shape
 * `/api/live-terminals` returns (server/lib/live-terminals.ts) and the
 * tab-bar menu reads (client/src/lib/liveTerminals.ts).
 */
export type LiveTerminalSource = "topics" | "tmux" | "terminal";

export interface LiveTerminal {
  /** `topics:<id>`, `tmux:%8`, `terminal:ttys004`. */
  id: string;
  source: LiveTerminalSource;
  /** Display name: Topics session title, tmux `session:window.pane`, tab title. */
  title: string;
  /** Foreground program (`claude`, `zsh`, `node`…), when known. */
  command: string | null;
  cwd: string | null;
  /** `/dev/ttys004`, when present. */
  tty: string | null;
  /** Only Topics knows whether an agent is working; for the rest `null` = unknown. */
  busy: boolean | null;
  /** For `topics`: the PTY session id, which the client uses to foreground its tab. */
  sessionId?: string;
}
