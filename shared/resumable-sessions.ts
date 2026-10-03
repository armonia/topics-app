/**
 * The rows of `/resume` (CMDUI-03): what the server reads from a project's
 * Claude Code transcripts and the picker shows. One declaration for both
 * sides; the reader is `server/lib/resumable-claude-sessions.ts`.
 */

/** Where the title of a row comes from: `/rename`, the CLI's own title, or the last question. */
export type ResumableTitleSource = "custom" | "ai" | "prompt";

export interface ResumableSession {
  sessionId: string;
  title: string | null;
  titleSource: ResumableTitleSource | null;
  branch: string | null;
  cwd: string;
  /** Last activity: the transcript's mtime, epoch ms. */
  lastActivityAt: number;
  /** Touched within the last 15 minutes: maybe still running in a terminal. */
  active: boolean;
  transcriptPath: string;
}

export interface ResumablePage {
  sessions: ResumableSession[];
  /** More transcripts are left after this page. */
  more: boolean;
  /** Where the next page starts (`before`), when there is one. */
  cursor: string | null;
}
