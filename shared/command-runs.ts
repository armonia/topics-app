/**
 * A run of a command from the chat (Run under a code block of a reply,
 * CHAT-RUN-03 / CMDRUN-06), as the server keeps it in `command_runs` and the
 * client reads it. One shape for both sides.
 */
export type RunStatus = "running" | "done" | "error" | "stopped" | "unknown";

/** `output` is null while it runs: then it is read from the registry's cursor (`GET /api/scripts/:id/output`). */
export interface CommandRun {
  runId: string;
  blockKey: number;
  command: string;
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  output: string | null;
  droppedLines: number;
}
