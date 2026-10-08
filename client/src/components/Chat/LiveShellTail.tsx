/**
 * THE LIVE TAIL OF A PROCESS UNDER ITS CARD: a shell the agent left in the
 * background, or the process a `run_command` / `run_script` started.
 *
 * Read from the process registry, not from the transcript. The transcript says
 * what there was when the tool answered and never says it again; the registry
 * knows whether the process still runs, what it printed since and how it
 * ended. When the registry does not know it (an old chat, a restarted server)
 * nothing is drawn and the card stays as it was: no placeholder for a state we
 * do not have.
 *
 * The launched process is what a row of the strip opens (chat-strips-in-transcript,
 * `liveWorkCard.ts`): its card shows the log the strip used to dock over itself.
 */
import { useT } from '../../hooks/useT';
import { useLaunchedProcess, type LiveBackgroundShell } from '../../hooks/useBackgroundShell';
import { launchedProcessId } from './liveWorkCard';

export function LiveShellTail({ live }: { live: LiveBackgroundShell }) {
  const tr = useT();
  if (!live.known) return null;
  const running = live.status === 'running';
  return (
    <div className="space-y-1" data-testid="shell-live">
      <div className="flex items-center gap-1.5 text-mini text-app-text-muted">
        <span
          data-testid="shell-live-status"
          data-status={running ? 'running' : 'ended'}
          className={`inline-block w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-500 animate-pulse' : (live.status === 'error' ? 'bg-red-500' : 'bg-app-text-muted')}`}
        />
        <span>{running ? tr('tool.live.running') : (live.exitCode != null ? tr('tool.live.exit', { code: live.exitCode }) : tr('tool.live.ended'))}</span>
      </div>
      {live.truncatedLines > 0 && (
        <div className="text-mini text-app-text-muted">{tr('tool.logTruncated', { n: live.truncatedLines })}</div>
      )}
      {live.output && (
        <pre
          data-testid="shell-live-output"
          className="tool-card-code text-mini font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5"
        >
          {live.output}
        </pre>
      )}
    </div>
  );
}

/** The tail of the process a `run_command` / `run_script` answer names; nothing for any other answer. */
export function LaunchedProcessTail({ answer }: { answer?: string }) {
  const processId = launchedProcessId(answer);
  return processId ? <ProcessTail processId={processId} /> : null;
}

function ProcessTail({ processId }: { processId: string }) {
  return <LiveShellTail live={useLaunchedProcess(processId)} />;
}
