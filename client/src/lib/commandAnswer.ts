/**
 * THE ANSWER OF A COMMAND, AS THE CHAT'S CARD SHOWS IT (CMDUI-04).
 *
 * A command that answers with something to read (`/status`, `/project`, a
 * refusal, the outcome of `/compact`, the CLI's own words for a local command)
 * used to print it in a green or red monospace strip that a timer closed after
 * five seconds, fourteen lines of `/help` included. The answer is now a card at
 * the end of the pane's messages: typed content, not a string, and a state of
 * THIS SCREEN only. It is never saved, never enters the history sent to the
 * engine, and is gone on reload: a snapshot of state that is saved reads as
 * true when the chat is reopened, and by then it is not.
 *
 * It closes with its X, with the next message, or when another command
 * replaces it. No timer.
 */

/** `running` while the outcome is awaited (`/compact`), then one of the other three. */
export type CommandAnswerKind = 'facts' | 'text' | 'error' | 'running';

export interface CommandAnswerRow {
  readonly label: string;
  readonly value: string;
}

export interface CommandAnswer {
  readonly kind: CommandAnswerKind;
  /** What the card is about, in the reader's language ("Session status"). */
  readonly title: string;
  readonly rows?: readonly CommandAnswerRow[];
  readonly body?: string;
  /** One gesture of Topics that does what was asked ("Open a terminal"). */
  readonly action?: { readonly label: string; readonly run: () => void };
}

/** The window event `useChat` raises for a `stream:command-answer` frame. */
export const COMMAND_ANSWER_EVENT = 'chat:command-answer';

export interface CommandAnswerEventDetail {
  sessionKey: string;
  command: string;
  text: string;
  outcome?: { ok: boolean; error?: string };
}

/**
 * The `Label: value` lines of a report (`/status`, `/project`) as rows. A line
 * without a label is kept whole, as a row with an empty label, so nothing the
 * server said is dropped.
 */
export function reportRows(report: string): CommandAnswerRow[] {
  return report
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([^:]{1,40}):\s+(.+)$/.exec(line);
      return m ? { label: m[1]!.trim(), value: m[2]!.trim() } : { label: '', value: line };
    });
}

/**
 * The rows of `/status` the card shows. The session's internal key is left
 * out: it is an identifier for a bug report, and the card is read, not
 * copied from (CMD-07 puts it last for the same reason). The chat's own name
 * and project are on screen already, and the server does not send them.
 */
export function statusRows(report: string): CommandAnswerRow[] {
  return reportRows(report).filter((r) => !/^(sessione|session)$/i.test(r.label));
}
