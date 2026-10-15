/**
 * THE LIVE-TERMINALS MENU: every terminal running on the Mac, not only Topics'
 * own, i.e. Terminal.app tabs and tmux panes where a `claude` was started by hand.
 * One branch per source. A Topics session opens in its tab; an outside terminal
 * opens a level beside it with its current SCREEN and a field to type into, which
 * is what the phone needs to answer an agent parked on a question.
 *
 * NOTHING IS POLLED WHILE CLOSED. The list is fetched when its level opens and
 * refreshed only while it stays open; a screen only while its level is open. An
 * idle client must not receive bytes for something it is not looking at (the
 * daily-driver plan, D1).
 *
 * Switched off from the View menu, «show live terminals» (`showLiveTerminals`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, SquareTerminal } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { POPOVER_ITEM } from '../../lib/popoverStyles';
import {
  fetchLiveTerminals,
  fetchLiveTerminalScreen,
  groupLiveTerminals,
  liveTerminalDetail,
  liveTerminalLabel,
  sendToLiveTerminal,
  type LiveTerminal,
} from '../../lib/liveTerminals';
import { SubmenuItem } from './SubmenuItem';

const LIST_REFRESH_MS = 3000;
const SCREEN_REFRESH_MS = 1500;

const SECTION_CLASS = 'px-3 pt-2 pb-1 text-mini font-semibold text-app-text-muted uppercase tracking-wider';

/**
 * The live-terminals branch: one row that opens a level beside it. Mounted at the
 * end of the «+» menu (the end of every tab bar) and in the «Topics» menu, which is
 * one tap away on the phone. It costs the tab bar no width: a button of its own in
 * every bar squeezed the tabs into squares at 600px (tab-bar-density DENS-02).
 */
export function LiveTerminalsLevel({ onClose }: { onClose: () => void }) {
  const tr = useT();
  return (
    <SubmenuItem
      icon={SquareTerminal}
      label={tr('liveTerminals.trigger')}
      testId="live-terminals"
      minWidth={260}
      maxWidth={360}
    >
      <LiveTerminalsList onClose={onClose} />
    </SubmenuItem>
  );
}

/** The list itself. Asked for when the level opens, refreshed only while it stays open. */
function LiveTerminalsList({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const [rows, setRows] = useState<LiveTerminal[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetchLiveTerminals()
        .then((r) => { if (live) { setRows(r); setFailed(false); } })
        .catch(() => { if (live) setFailed(true); });
    };
    load();
    const timer = setInterval(load, LIST_REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const openTopics = (t: LiveTerminal) => {
    onClose();
    window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: t.sessionId, name: t.title } }));
  };

  const groups = rows ? groupLiveTerminals(rows) : [];

  return (
    <div className="max-h-[70vh] overflow-y-auto" data-testid="live-terminals-list">
      {rows === null && !failed && <div className="px-3 py-2 text-compact text-app-text-muted">{tr('liveTerminals.loading')}</div>}
      {failed && <div className="px-3 py-2 text-compact text-app-text-muted">{tr('liveTerminals.failed')}</div>}
      {rows !== null && groups.length === 0 && (
        <div className="px-3 py-2 text-compact text-app-text-muted" data-testid="live-terminals-empty">{tr('liveTerminals.empty')}</div>
      )}
      {groups.map((g) => (
        <div key={g.source} role="group" aria-label={tr(`liveTerminals.source.${g.source}`)} data-testid={`live-terminals-group-${g.source}`}>
          <div className={SECTION_CLASS} aria-hidden="true">{tr(`liveTerminals.source.${g.source}`)}</div>
          {g.rows.map((t) => g.source === 'topics' ? (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className={POPOVER_ITEM}
              onClick={() => openTopics(t)}
              aria-label={liveTerminalLabel(t)}
              data-testid="live-terminals-row"
              data-terminal-id={t.id}
            >
              <RowText t={t} />
            </button>
          ) : (
            <SubmenuItem
              key={t.id}
              label={liveTerminalLabel(t)}
              tail={<span className="truncate text-mini text-app-text-muted">{liveTerminalDetail(t)}</span>}
              testId={`live-terminals-row-${t.id}`}
              levelRole="dialog"
              minWidth={420}
              maxWidth={560}
            >
              <TerminalPeek terminal={t} />
            </SubmenuItem>
          ))}
        </div>
      ))}
    </div>
  );
}

function RowText({ t }: { t: LiveTerminal }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${t.busy ? 'bg-emerald-500' : 'bg-app-border'}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{liveTerminalLabel(t)}</span>
      <span className="max-w-[45%] truncate text-mini text-app-text-muted">{liveTerminalDetail(t)}</span>
    </span>
  );
}

/**
 * An outside terminal screen plus a field for writing into it. Enter sends the
 * text plus Enter; the ⏎ key alone sends a bare Enter (confirms a
 * prompt, wakes a shell).
 */
function TerminalPeek({ terminal }: { terminal: LiveTerminal }) {
  const tr = useT();
  const [screen, setScreen] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const load = useCallback(() => {
    fetchLiveTerminalScreen(terminal.id)
      .then((s) => { if (s === null) setGone(true); else { setGone(false); setScreen(s); } })
      .catch(() => { /* next round retries */ });
  }, [terminal.id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, SCREEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The screen reads from the bottom, where the prompt lives.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [screen]);

  const send = async (value: string) => {
    setSending(true);
    setError(null);
    try {
      const ok = await sendToLiveTerminal(terminal.id, value, true);
      if (!ok) setError(tr('liveTerminals.sendFailed'));
      else { setText(''); setTimeout(load, 300); }
    } catch {
      setError(tr('liveTerminals.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="live-terminals-peek">
      <pre
        ref={preRef}
        className="max-h-[50vh] min-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/80 p-2 font-mono text-mini leading-snug text-zinc-100"
        data-testid="live-terminals-screen"
      >
        {gone ? tr('liveTerminals.gone') : screen ?? tr('liveTerminals.loading')}
      </pre>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => { e.preventDefault(); if (text.trim() && !sending) void send(text); }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={tr('liveTerminals.inputPlaceholder')}
          aria-label={tr('liveTerminals.inputPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-2 py-1 text-compact text-app-text outline-none focus:border-app-accent"
          disabled={gone}
          data-testid="live-terminals-input"
        />
        <button
          type="button"
          onClick={() => void send('')}
          disabled={sending || gone}
          title={tr('liveTerminals.enter')}
          aria-label={tr('liveTerminals.enter')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-app-text hover:bg-app-hover disabled:opacity-40"
          data-testid="live-terminals-enter"
        >
          <CornerDownLeft size={14} aria-hidden="true" />
        </button>
      </form>
      {error && <div className="text-mini text-red-600 dark:text-red-400" role="alert">{error}</div>}
    </div>
  );
}
