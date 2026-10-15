/**
 * LA TENDINA DEI TERMINALI VIVI, in fondo alle tab accanto al «+».
 * Sul telefono le barre di tab non ci sono (le tab sono la lista): lì sta in
 * alto, accanto alla campanella (`variant="header"`).
 *
 * Elenca ogni terminale acceso sul Mac, non solo quelli di Topics: le tab di
 * Terminal.app e i pane tmux in cui gira un `claude` aperto a mano. Un ramo per
 * origine. Una sessione di Topics si apre nella sua tab; un terminale di fuori
 * apre un livello a lato con lo SCHERMO attuale e un campo per scriverci, che è
 * ciò che serve dal telefono per rispondere a un agente fermo su una domanda.
 *
 * NON INTERROGA NIENTE DA CHIUSA. La lista si chiede all'apertura e si rinfresca
 * solo finché la tendina è aperta; lo schermo solo finché il suo livello è
 * aperto. Un client fermo non deve ricevere byte per una cosa che non guarda
 * (è la barra del piano daily-driver, D1).
 *
 * Si spegne dal menu Vista → «Mostra i terminali vivi in fondo alle tab» (`showLiveTerminals`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, SquareTerminal } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { POPOVER_ITEM } from '../../lib/popoverStyles';
import { RAISED_CONTROL, ROW_ACTION_BOX } from '../../lib/selectionStyles';
import {
  fetchLiveTerminals,
  fetchLiveTerminalScreen,
  groupLiveTerminals,
  liveTerminalDetail,
  liveTerminalLabel,
  sendToLiveTerminal,
  type LiveTerminal,
} from '../../lib/liveTerminals';
import { Menu } from './Menu';
import { SubmenuItem } from './SubmenuItem';

const LIST_REFRESH_MS = 3000;
const SCREEN_REFRESH_MS = 1500;

/** Il box del bottone: quello delle barre di tab (`bar`, gemello del «+») o
 *  quello della riga in alto del telefono (`header`, gemello della campanella). */
const triggerClass = (variant: 'bar' | 'header', isMobile: boolean) =>
  `${variant === 'header' ? (isMobile ? 'h-11 w-11' : 'h-7 w-7') : ROW_ACTION_BOX} edge-lit flex flex-shrink-0 items-center justify-center rounded-lg ${RAISED_CONTROL} text-app-text transition-colors`;

const SECTION_CLASS = 'px-3 pt-2 pb-1 text-mini font-semibold text-app-text-muted uppercase tracking-wider';

export function LiveTerminalsMenu({ variant = 'bar' }: { variant?: 'bar' | 'header' }) {
  const tr = useT();
  const { isMobile } = useMobile();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LiveTerminal[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => {
      fetchLiveTerminals()
        .then((r) => { if (live) { setRows(r); setFailed(false); } })
        .catch(() => { if (live) setFailed(true); });
    };
    load();
    const timer = setInterval(load, LIST_REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const openTopics = (t: LiveTerminal) => {
    close();
    window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: t.sessionId, name: t.title } }));
  };

  const groups = rows ? groupLiveTerminals(rows) : [];
  const title = tr('liveTerminals.trigger');

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${triggerClass(variant, isMobile)} app-no-drag`}
        {...NO_DRAG_REGION}
        // La riga in alto del telefono lascia passare i tocchi alla lista che ci
        // scorre sotto (`pointer-events: none`): la campanella si riprende i suoi
        // allo stesso modo. Senza, il tocco finiva sulla riga della Board.
        style={{ pointerEvents: 'auto' }}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="live-terminals-trigger"
      >
        <SquareTerminal size={isMobile ? 18 : 15} aria-hidden="true" />
      </button>
      <Menu
        open={open}
        anchorRef={buttonRef}
        onClose={close}
        align="right"
        minWidth={260}
        maxWidth={360}
        testId="live-terminals-menu"
        ariaLabel={title}
        className="max-h-[70vh] overflow-y-auto"
      >
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
      </Menu>
    </>
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
 * Lo schermo di un terminale di fuori e un campo per scriverci. Invio manda il
 * testo e preme Invio; il tasto ⏎ da solo preme Invio a vuoto (conferma un
 * prompt, sveglia una shell).
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
      .catch(() => { /* il prossimo giro riprova */ });
  }, [terminal.id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, SCREEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Lo schermo si legge dal fondo, dove sta il prompt.
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
        className="max-h-[50vh] min-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/80 p-2 font-mono text-[11px] leading-snug text-zinc-100"
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
