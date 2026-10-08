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
 * A command's row in the strip under the chat opens the same tail of the same
 * process (`ProcessTail`, `SubAgentsStrip`): one log, the card's, in two places.
 * In the row it is drawn as the row's own content (`variant="row"`): no box of
 * its own, the row's surface under it. Boxed like the card's, on 08/10 it read
 * as a terminal that had nothing to do with the row («it looks like a terminal»).
 *
 * The box scrolls back to the first line the registry still has, and follows
 * the end only while the reader is there: a reader who goes up stays up while
 * new lines arrive, and comes back to the follow by going back to the end.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useT } from '../../hooks/useT';
import { useLaunchedProcess, type LiveBackgroundShell } from '../../hooks/useBackgroundShell';
import { stripAnsi } from '../../lib/stripAnsi';
import { launchedProcessId } from './launchedProcess';

/** At the end of the box within this: a reader a few pixels up has gone up on purpose. */
const FOLLOW_SLACK_PX = 4;

export function LiveShellTail({ live, variant = 'card' }: { live: LiveBackgroundShell; variant?: 'card' | 'row' }) {
  const tr = useT();
  // Without colour and cursor codes, as the docked log reads them: on the
  // Prince of Persia chat (08/10) Muse's escape codes showed as boxes.
  const text = stripAnsi(live.output);
  // The newest line in sight, as the docked log keeps it (`ProcessLogPane`):
  // the box follows the end until the reader scrolls up inside it.
  const outputRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  // A wheel over the strip's log is the log's. Let through, a wheel up there
  // took the chat's follow away (`MessageList`, `releaseToUser`): reading old
  // lines, the reader at the bottom stopped seeing the chat's new messages.
  // Whether the box could still scroll cannot be read in the handler: Chromium
  // has applied the wheel's scroll by then (08/10, the notch that took the box
  // to its first line read 0 px of room), so a box that scrolls keeps every
  // wheel and hands none on to the chat (`overscroll-contain`). A box too short
  // to scroll leaves them alone. The card's box is left as it was.
  const guardsWheel = variant === 'row' && !!live.output;
  useEffect(() => {
    const el = outputRef.current;
    if (!el || !guardsWheel) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollHeight - el.clientHeight > 1) e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, [guardsWheel]);
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
          ref={outputRef}
          data-testid="shell-live-output"
          onScroll={(e) => { const el = e.currentTarget; followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX; }}
          className={variant === 'row'
            ? 'tool-card-code text-mini font-mono text-app-text-secondary whitespace-pre-wrap overflow-y-auto overscroll-contain max-h-72 py-0.5'
            : 'tool-card-code text-mini font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5'}
        >
          {text}
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

/** The tail of a process by its id: in its card, and in its row of the strip. */
export function ProcessTail({ processId, variant }: { processId: string; variant?: 'card' | 'row' }) {
  return <LiveShellTail live={useLaunchedProcess(processId)} variant={variant} />;
}
