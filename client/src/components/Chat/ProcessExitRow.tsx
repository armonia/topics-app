/**
 * THE END OF A COMMAND, SAID AS A SERVICE LINE.
 *
 * A command the agent started with `run_command` wakes its topic when it ends
 * (server/lib/process-exit-wake.ts): a `user` row, because that is the role a
 * provider answers, carrying the exit code and the last lines. As a bubble it
 * would put the machine's report in the person's mouth. One line instead,
 * openable, because the lines it carries are what the agent is answering.
 */
import { useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { ProcessExitBlock } from './machineRow';

export function ProcessExitRow({ messageId, block, content }: {
  messageId?: string;
  block: ProcessExitBlock;
  /** The text the agent received: outcome and last lines. */
  content: string;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const line = block.exitCode === null
    ? tr('chat.processExit.lineUnknown', { label: block.label })
    : tr('chat.processExit.line', { label: block.label, code: block.exitCode });
  return (
    <div
      data-testid="process-exit-row"
      data-message-id={messageId}
      data-exit-code={block.exitCode ?? 'unknown'}
      data-open={open || undefined}
      className="my-1 px-2 text-mini text-app-text-muted"
    >
      <div className="flex items-center justify-center gap-1.5">
        <SquareTerminal size={11} className="flex-shrink-0" />
        <span className="truncate" title={tr('chat.processExit.title')}>{line}</span>
        <button
          type="button"
          data-testid="process-exit-toggle"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 underline-offset-2 hover:text-app-text hover:underline"
        >
          {open ? tr('chat.processExit.hide') : tr('chat.processExit.show')}
        </button>
      </div>
      {open && (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-app-inset p-2 text-mini leading-relaxed text-app-text-secondary">
          {content}
        </pre>
      )}
    </div>
  );
}
