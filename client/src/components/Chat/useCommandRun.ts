/**
 * The part of a code block that runs it (CHAT-RUN-01, CHAT-RUN-02), as a hook:
 * which command the block holds, whether Run asks a second time, the block's
 * last run, and the gestures. `CodeBlock` (MessageContent.tsx) draws them with
 * `CodeBlockRunControls.tsx`.
 */
import { useCallback, useMemo, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useToast } from '../Shared/Toast';
import { apiErrorCode, commandRunsApi, ApiError } from '../../lib/api';
import { commandBlockKey, type CommandRunTarget } from './commandRunContext';
import { runnableCommand } from './runnableCommand';
import { commandRisk, type RiskReason } from './commandRisk';
import { putStartedRun, useMessageRuns } from './commandRunStore';

/** A refusal of Run, said in the reader's language: the server's text never reaches the screen. */
function commandRunRefusal(err: unknown, tr: (key: string) => string): string {
  if (!(err instanceof ApiError)) return tr('run.err.unreachable');
  const code = apiErrorCode(err);
  if (err.status === 404 || code === 'message_not_found') return tr('run.err.notFound');
  if (err.status === 409 || code === 'message_partial') return tr('run.err.partial');
  if (err.status === 501 || code === 'no_shell') return tr('run.err.noShell');
  if (err.status === 401 || err.status === 403) return tr('run.err.forbidden');
  return tr('run.err.failed');
}

/**
 * The part of a code block that runs it (CHAT-RUN-01, CHAT-RUN-02): Run and
 * Open in terminal in the header, the strip that asks a second time, and the
 * run under the block. Only inside a `CommandRunContext`, and only for a
 * block that `runnableCommand` reads a command from.
 */
export function useCommandRun(target: CommandRunTarget | null, language: string, text: string, offset: number | undefined) {
  const tr = useT();
  const toast = useToast();
  const command = useMemo(() => (target && offset !== undefined ? runnableCommand(language, text) : null), [target, offset, language, text]);
  const risk = useMemo(() => (command ? commandRisk(command) : null), [command]);
  const blockKey = target && offset !== undefined ? commandBlockKey(target.segment, offset) : null;
  const runs = useMessageRuns(command ? target!.sessionKey : null, command ? target!.messageId : null);
  // A run belongs to this block only while the block still says the same command.
  const run = runs.find((r) => r.blockKey === blockKey && r.command === command) ?? null;
  const [confirming, setConfirming] = useState<RiskReason[] | null>(null);
  const [starting, setStarting] = useState(false);

  const start = useCallback(async () => {
    if (!target || !command || blockKey === null) return;
    setConfirming(null);
    setStarting(true);
    try {
      const started = await commandRunsApi.start(target.sessionKey, { messageId: target.messageId, blockKey, command });
      putStartedRun(target.messageId, {
        runId: started.runId, blockKey, command, cwd: started.cwd, status: 'running', exitCode: null,
        startedAt: started.startedAt, endedAt: null, output: null, droppedLines: 0,
      });
    } catch (err) {
      toast.error(commandRunRefusal(err, tr), 6000);
    } finally {
      setStarting(false);
    }
  }, [target, command, blockKey, toast, tr]);

  /** The click on Run (or Run again): at once, or the strip first when the command asks for it. */
  const requestRun = useCallback(() => {
    if (!risk || risk.block) return;
    if (risk.confirm.length) setConfirming(risk.confirm);
    else void start();
  }, [risk, start]);

  const openTerminal = useCallback(() => {
    if (!target || !command) return;
    window.dispatchEvent(new CustomEvent('topics:open-terminal-with-command', { detail: { sessionKey: target.sessionKey, command } }));
  }, [target, command]);

  return { command, risk, run, confirming, cancel: () => setConfirming(null), start, requestRun, starting, openTerminal };
}
