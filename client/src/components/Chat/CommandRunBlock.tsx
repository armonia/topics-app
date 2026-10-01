/**
 * A run of a command from the chat, under its code block (CHAT-RUN-03).
 *
 * Read the way Warp and VS Code show a command block: the outcome first (a
 * green dot for `exit 0`, a red bar and `exit N` for a failure, grey for
 * stopped or unknown), the duration and the folder; then the output with its
 * colours. While it runs the output sits in a box sixteen lines high that
 * follows the end, until the reader scrolls up; once over, a long output
 * shows its LAST twenty lines, because a command says how it went at the end.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, RotateCcw, Send, Square, SquareTerminal } from 'lucide-react';
import { scriptsApi, type CommandRunInfo } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { useT } from '../../hooks/useT';
import { useToast } from '../Shared/Toast';
import { Spinner } from '../Shared/Spinner';
import { ansiLines, plainLines, type AnsiSpan } from './ansiSpans';
import { refreshMessageRuns, subscribeRunOutput } from './commandRunStore';
import { formatRunDuration, runDraftText, shortenHome } from './commandRunText';

/** A finished output longer than this shows its last lines and a «Show all». */
const FINISHED_TAIL_LINES = 20;
/** What a live output keeps in memory: the box shows sixteen lines, the rest is the scrollback. */
const LIVE_MAX_CHARS = 400_000;
const LIVE_POLL_MS = 1000;

interface CommandRunBlockProps {
  run: CommandRunInfo;
  sessionKey: string;
  messageId: string;
  onRerun: () => void;
  onOpenTerminal: () => void;
}

function Line({ spans }: { spans: AnsiSpan[] }) {
  if (!spans.length) return <div>{' '}</div>;
  return (
    <div>
      {spans.map((s, i) => {
        const cls = [s.bold && 'font-bold', s.dim && 'opacity-60', s.italic && 'italic', s.underline && 'underline'].filter(Boolean).join(' ');
        if (!cls && !s.fg && !s.bg) return <span key={i}>{s.text}</span>;
        return <span key={i} className={cls || undefined} style={{ color: s.fg, backgroundColor: s.bg }}>{s.text}</span>;
      })}
    </div>
  );
}

const isSameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const CommandRunBlock = memo(function CommandRunBlock({ run, sessionKey, messageId, onRerun, onOpenTerminal }: CommandRunBlockProps) {
  const tr = useT();
  const toast = useToast();
  const running = run.status === 'running';
  const [hidden, setHidden] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [live, setLive] = useState('');
  const [pending, setPending] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // The output while it runs: the registry's cursor, read once a second and
  // at once when the server says there is more (`scripts:output`).
  useEffect(() => {
    if (!running) return;
    let active = true;
    let offset = 0;
    let inFlight = false;
    setLive('');
    setPending('');
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const data = await scriptsApi.output(run.runId, offset);
        if (!active) return;
        if (data.output) setLive((prev) => {
          const next = prev ? `${prev}\n${data.output}` : data.output;
          return next.length > LIVE_MAX_CHARS ? next.slice(next.length - LIVE_MAX_CHARS) : next;
        });
        setPending(data.pending ?? '');
        offset = data.offset;
        if (data.done) refreshMessageRuns(sessionKey, messageId);
      } catch {
        // The registry no longer has it: the list says how it ended.
        if (active) refreshMessageRuns(sessionKey, messageId);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); setNow(Date.now()); }, LIVE_POLL_MS);
    const unsubscribe = subscribeRunOutput(run.runId, () => { void poll(); });
    return () => { active = false; clearInterval(timer); unsubscribe(); };
  }, [running, run.runId, sessionKey, messageId]);

  const text = running ? (pending ? (live ? `${live}\n${pending}` : pending) : live) : (run.output ?? live);
  const lines = useMemo(() => ansiLines(text), [text]);
  const shown = !running && !showAll && lines.length > FINISHED_TAIL_LINES ? lines.slice(-FINISHED_TAIL_LINES) : lines;

  // Follow the end while it runs, unless the reader scrolled up to read.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && running && followRef.current) box.scrollTop = box.scrollHeight;
  }, [lines, running]);
  const onScroll = () => {
    const box = boxRef.current;
    if (box) followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  };

  const startedAt = Date.parse(run.startedAt);
  const durationMs = (run.endedAt ? Date.parse(run.endedAt) : now) - startedAt;
  const duration = formatRunDuration(durationMs);
  const outcome = run.status === 'running' ? tr('run.running')
    : run.status === 'stopped' ? tr('run.stopped')
    : run.status === 'unknown' || run.exitCode === null ? tr('run.unknown')
    : tr('run.exit', { code: run.exitCode });
  const failed = run.status === 'error';
  const ranAt = !isSameDay(new Date(startedAt), new Date()) ? new Date(startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : null;

  const copyOutput = async () => {
    if (await copyText(plainLines(text).join('\n'))) toast.success(tr('run.copied'));
    else toast.error(tr('browser.menu.copyFailed'));
  };
  const sendToAgent = () => {
    const draft = runDraftText(
      { command: run.command, output: text, outcome, duration, cwd: run.cwd },
      (vars) => tr('run.summary', vars),
    );
    window.dispatchEvent(new CustomEvent('topics:seed-composer', { detail: { sessionKey, text: draft, mode: 'append' } }));
  };
  const stop = async () => {
    try { await scriptsApi.stop(run.runId); } catch { /* already over: the list says how */ }
    refreshMessageRuns(sessionKey, messageId);
  };

  const action = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 min-h-6 text-mini text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors';

  return (
    <div
      data-testid="command-run"
      data-status={run.status}
      aria-label={tr('run.label')}
      className={`mt-1 rounded-md bg-app-code-bg text-gray-100 overflow-hidden border-l-2 ${failed ? 'border-red-500' : 'border-transparent'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-2.5 py-1 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0 text-mini">
          {running ? <Spinner size="xs" />
            : <span aria-hidden className={`inline-block w-1.5 h-1.5 rounded-full ${run.status === 'done' ? 'bg-emerald-400' : failed ? 'bg-red-500' : 'bg-gray-500'}`} />}
          <span data-testid="command-run-outcome" className={`font-medium ${run.status === 'done' ? 'text-emerald-300' : failed ? 'text-red-300' : 'text-gray-300'}`}>{outcome}</span>
          <span className="text-gray-400 tabular-nums" data-testid="command-run-duration">{duration}</span>
          <span className="text-gray-500 font-mono truncate" title={run.cwd}>{shortenHome(run.cwd)}</span>
          {ranAt && <span className="text-gray-500">{tr('run.ranAt', { when: ranAt })}</span>}
        </div>
        <div className="flex items-center gap-0.5">
          {running ? (
            <button type="button" className={action} onClick={() => { void stop(); }} data-testid="command-run-stop">
              <Square size={10} /> {tr('run.stop')}
            </button>
          ) : (
            <>
              <button type="button" className={action} onClick={onRerun} data-testid="command-run-rerun"><RotateCcw size={10} /> {tr('run.rerun')}</button>
              <button type="button" className={action} onClick={() => { void copyOutput(); }}><Copy size={10} /> {tr('run.copyOutput')}</button>
              <button type="button" className={action} onClick={sendToAgent} title={tr('run.sendToAgentTitle')} data-testid="command-run-send"><Send size={10} /> {tr('run.sendToAgent')}</button>
              <button type="button" className={action} onClick={onOpenTerminal} aria-label={tr('code.openInTerminal')} title={tr('code.openInTerminalTitle')}><SquareTerminal size={11} /></button>
              <button type="button" className={action} onClick={() => setHidden((h) => !h)} aria-expanded={!hidden}>
                {hidden ? <><ChevronDown size={10} /> {tr('run.show')}</> : <><ChevronUp size={10} /> {tr('run.hide')}</>}
              </button>
            </>
          )}
        </div>
      </div>
      {!hidden && (
        <>
          {!running && lines.length > FINISHED_TAIL_LINES && !showAll && (
            <button type="button" onClick={() => setShowAll(true)} className="w-full text-left px-2.5 py-1 text-mini text-indigo-300/70 hover:text-indigo-300 border-b border-white/5">
              {tr('run.showAll', { n: lines.length })}
            </button>
          )}
          {run.droppedLines > 0 && (showAll || lines.length <= FINISHED_TAIL_LINES) && (
            <div className="px-2.5 pt-1 text-micro text-gray-500">{tr('run.dropped', { n: run.droppedLines })}</div>
          )}
          <div
            ref={boxRef}
            onScroll={onScroll}
            tabIndex={0}
            data-testid="command-run-output"
            className={`px-2.5 py-1.5 font-mono text-prose leading-[1.5] whitespace-pre overflow-x-auto ${running ? 'max-h-[24em] overflow-y-auto' : ''}`}
          >
            {shown.length ? shown.map((spans, i) => <Line key={i} spans={spans} />) : <div className="text-gray-500">{running ? ' ' : tr('run.noOutput')}</div>}
          </div>
        </>
      )}
    </div>
  );
});
