/**
 * A SERVER THE CHAT RUNS, as one compact row under the last message (BGVIS-08).
 *
 * On 01/10 a chat whose agent had started `python3 -m http.server 8777` with
 * `run_command` (no wake) said "waiting on 1 job in the background" for as long
 * as the server ran, and its sidebar row and tab carried the grey ring: a
 * server read as work the chat waits for. The person asked for what an IDE
 * shows instead: the server is running, here is its address.
 *
 * So a command that listens on a port and does not wake the chat is listed by
 * the server as a server (`services` of `/api/topics/streaming`), never as
 * background work, and this row draws it: "Server · 127.0.0.1:8777 · name",
 * with Open (a browser tab of the app, through `openLink` like any link of the
 * chat), Logs (the process log, in the Processes pane of the chat's project
 * window) and Stop. It is a row, not a banner: the chat stays free.
 *
 * It follows the process: a port that appears or goes, a start, an end reach
 * it through the `background:changed` push. When the server ends the row says
 * how (stopped, exit code) for a few seconds and goes; that clock is the
 * store's (`state/runningServices.ts`), so a remount does not restart it.
 *
 * Same place and same geometry as `BackgroundWorkLine` beside it (the
 * Virtuoso `Footer` in `MessageList`), entering with the shared `reveal-in`.
 * Its own chunk: `RunningServiceRows` loads it the first time a chat has a
 * server, so the entry bundle carries only the subscription.
 */
import { useState, type MouseEvent } from 'react';
import { ExternalLink, ScrollText, Server, Square } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { listenLabel, listenUrl, type RunningServiceSummary } from '../../../../shared/background-work';
import { CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';
import { scriptsApi } from '../../lib/api';
import { useToast } from '../Shared/Toast';
import { OPEN_PROCESS_LOG_EVENT } from '../Layout/fileOpenScope';

/** The rows of a chat's servers. Loaded on demand by `RunningServiceRows`: most chats never run one. */
export default function RunningServiceList({ services, projectPath }: { services: readonly RunningServiceSummary[]; projectPath?: string }) {
  return <>{services.map((s) => <ServiceRow key={s.processId} service={s} projectPath={projectPath} />)}</>;
}

const BUTTON = 'flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-50';

function ServiceRow({ service, projectPath }: { service: RunningServiceSummary; projectPath?: string }) {
  const tr = useT();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const ended = service.ended;

  // The server puts the page first when the command serves more than one port.
  const first = service.listen[0];
  const url = first ? listenUrl(first) : '';
  const address = service.listen.map(listenLabel).join(', ');
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    if (url) openLink(url, { external: isExternalLinkGesture(e), origin: e.currentTarget });
  };
  const logs = () => {
    window.dispatchEvent(new CustomEvent(OPEN_PROCESS_LOG_EVENT, {
      detail: { processId: service.processId, scriptName: service.description, projectPath },
    }));
  };
  const stop = async () => {
    setStopping(true);
    try { await scriptsApi.stop(service.processId); } catch { toast.error(tr('chat.service.stopFailed')); setStopping(false); }
  };
  const endedText = !ended ? ''
    : ended.stopped ? tr('chat.service.stopped')
      : typeof ended.exitCode === 'number' ? tr('chat.service.ended', { code: ended.exitCode }) : tr('chat.service.endedUnknown');

  return (
    <div
      data-testid="running-service-row"
      data-process-id={service.processId}
      data-state={ended ? 'ended' : 'running'}
      className="reveal-in rounded-lg border border-app-border/60 bg-app-hover/40 text-app-text"
      title={[service.command, ended ? '' : tr('chat.service.free')].filter(Boolean).join('\n')}
    >
      <div className={`${CHAT_STRIP_ROW} min-w-0`}>
        <Server className={`h-3.5 w-3.5 flex-shrink-0 ${ended ? 'text-app-text-tertiary' : 'text-emerald-600 dark:text-emerald-400'}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-compact">
          <span className="text-app-text-secondary">{tr('chat.service.label')}</span>
          {address && <>{' · '}<span data-testid="running-service-address" className="tabular-nums">{address}</span></>}
          {' · '}<span data-testid="running-service-name" className="text-app-text-secondary">{service.description}</span>
        </span>
        {ended ? (
          <span key="ended" data-testid="running-service-ended" className="reveal-in flex-shrink-0 text-mini text-app-text-secondary">{endedText}</span>
        ) : (
          <span className="flex flex-shrink-0 items-center gap-0.5">
            {url && (
              <button type="button" data-testid="running-service-open" className={BUTTON} onClick={open} title={tr('chat.service.openTitle', { url })}>
                <ExternalLink className="h-3 w-3" aria-hidden />{tr('chat.service.open')}
              </button>
            )}
            <button type="button" data-testid="running-service-logs" className={BUTTON} onClick={logs} title={tr('chat.service.logsTitle')}>
              <ScrollText className="h-3 w-3" aria-hidden />{tr('chat.service.logs')}
            </button>
            <button type="button" data-testid="running-service-stop" className={BUTTON} onClick={() => void stop()} disabled={stopping} title={tr('chat.service.stopTitle')}>
              <Square className="h-3 w-3" aria-hidden />{tr('chat.service.stop')}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
