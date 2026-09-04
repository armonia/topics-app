/**
 * The terminal gestures that talk to the server, and the ONE place that turns a
 * refusal into a sentence.
 *
 * Three gestures used to throw the server's answer away. Creating a terminal
 * did it in three copies (`usePanelLifecycle.handleQuickCreateTerminal`, and
 * twice in `useProjectLayout`): `if (!res.ok) return;` plus `catch { return; }`.
 * The server refuses in four documented ways there (503 no PTY bridge in this
 * installation, 502 the bridge could not spawn, 400 cwd outside a known
 * project, 401 unauthorized) and none of them reached the screen: clicking
 * «+ → Claude Code» did literally nothing.        allow-italian: quoted UI string
 * The rename did the same with a bare `.catch(() => {})`, so a 404 left the old
 * label back in place without a word.
 *
 * The other half of the silence was the opposite mistake: `terminalReload` DID
 * check `res.ok`, then passed the raw body to the toast — and since
 * `errorResponse` always serialises `{"error": "..."}`, what a person read was
 * a pair of braces. So the mapping below is shared by all of them: parse the
 * envelope, then say the reason in the user's own language. Server text is
 * never rendered: it is English, internal, and sometimes an exception message.
 */
import { STANDALONE_NO_PTY_CODE } from '../../../shared/terminal-messages';
import type { TerminalSessionType } from '../../../shared/terminal-session-types';

type ErrorReporter = { error: (message: string, duration?: number) => void };
type Translate = (key: string) => string;

/** Which gesture failed. Picks the fallback sentence when the status says nothing specific. */
export type TerminalAction = 'create' | 'rename' | 'restart';

const FAILED_KEY: Record<TerminalAction, string> = {
  create: 'terminal.err.createFailed',
  rename: 'terminal.err.renameFailed',
  restart: 'tab.restartSessionFailed',
};

const UNREACHABLE_KEY: Record<TerminalAction, string> = {
  create: 'terminal.err.createUnreachable',
  rename: 'terminal.err.renameUnreachable',
  restart: 'tab.restartSessionUnreachable',
};

/**
 * The refusal, in one translated sentence.
 *
 * `body` is the raw response text: it may be the `{"error": "..."}` envelope,
 * plain text, or empty. Whatever it is, it never reaches the screen — only the
 * `code` inside it is read, because two different 503s mean two different
 * things (no bridge at all vs. a session that would not stop in time).
 */
export function terminalErrorText(
  action: TerminalAction,
  status: number,
  body: string,
  tr: Translate,
): string {
  let code: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.code === 'string') code = obj.code;
    }
  } catch { /* not an envelope: nothing to read, the status decides alone */ }

  if (code === STANDALONE_NO_PTY_CODE) return tr('terminal.err.unavailable');
  switch (status) {
    case 401:
    case 403: return tr('terminal.err.unauthorized');
    case 404: return tr('terminal.err.notFound');
    case 409: return tr('terminal.err.busy');
    case 503: return tr('terminal.err.retry');
    default: return tr(FAILED_KEY[action]);
  }
}

/** The sentence for a request that never got an answer (network down, server gone). */
export function terminalUnreachableText(action: TerminalAction, tr: Translate): string {
  return tr(UNREACHABLE_KEY[action]);
}

/** What POST /api/terminal/sessions answers with when it works. */
export interface CreatedTerminalSession {
  id: string;
  name: string;
  createdAt: string;
  cwd: string;
  command: string;
  topicId?: string;
  type: TerminalSessionType;
  claudeSessionId?: string | null;
}

/**
 * POST a new terminal session, and SAY IT when the server says no.
 *
 * Returns null on failure, exactly like the three call sites did before — what
 * changes is that the caller is no longer the only one who knows.
 */
export async function createTerminalSession(
  body: unknown,
  toast: ErrorReporter,
  tr: Translate,
): Promise<CreatedTerminalSession | null> {
  let res: Response;
  try {
    res = await fetch('/api/terminal/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    toast.error(terminalUnreachableText('create', tr), 6000);
    return null;
  }
  if (!res.ok) {
    const said = await res.text().catch(() => '');
    toast.error(terminalErrorText('create', res.status, said, tr), 6000);
    return null;
  }
  try {
    return await res.json() as CreatedTerminalSession;
  } catch {
    toast.error(tr(FAILED_KEY.create), 6000);
    return null;
  }
}

/**
 * PATCH a terminal session's name (marks `name_source='user'`).
 *
 * The tab relabels off the roster re-broadcast, not off a local write, so a
 * refusal is invisible by construction: the name simply springs back to the old
 * one. Hence the toast.
 */
export function renameTerminalSession(
  sessionId: string,
  name: string,
  toast: ErrorReporter,
  tr: Translate,
): void {
  void fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
    .then(async (res) => {
      if (res.ok) return;
      const said = await res.text().catch(() => '');
      toast.error(terminalErrorText('rename', res.status, said, tr), 6000);
    })
    .catch(() => toast.error(terminalUnreachableText('rename', tr), 6000));
}
