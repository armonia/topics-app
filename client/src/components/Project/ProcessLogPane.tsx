import { useState, useEffect, useRef, useCallback } from 'react';
import { Square } from 'lucide-react';
import { scriptsApi } from '../../lib/api';
import type { WSMessage } from '../../types';

// Strip ANSI escape sequences (colors, bold, cursor, etc.)
// Also strip orphaned CSI fragments like "[32m" where the ESC byte was lost in transit
/**
 * Tetto al log tenuto in memoria dal pannello.
 *
 * Il ring buffer da 500KB sta sul SERVER: qui i delta si sommavano per
 * l'intera vita del pane, senza nessun limite. Un build verboso lasciato
 * aperto una notte cresceva finché la scheda non moriva.
 */
const MAX_CLIENT_LOG_CHARS = 400_000;

const stripAnsi = (text: string) =>
  // Il byte ESC è ciò che questa regex deve riconoscere per poterlo togliere.
  // La regola serve a intercettare i byte di controllo finiti in un pattern per
  // sbaglio; qui sono il soggetto.
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')
      .replace(/\[(?:\d+;)*\d*[A-HJKSTfm]/g, '');

interface ProcessLogPaneProps {
  processId: string;
  scriptName?: string;
  /**
   * Iscrizione alla WS. Senza, il pane torna al solo polling: funziona, ma
   * ricade nel comportamento che questo prop esiste per superare.
   */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diff = Math.floor((end - start) / 1000);
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ProcessLogPane({ processId, scriptName, onMessage }: ProcessLogPaneProps) {
  const [output, setOutput] = useState('');
  /** L'ultima riga non ancora terminata: si MOSTRA ma non si accumula, o la si
   *  vedrebbe due volte quando arriva completa. */
  const [pending, setPending] = useState('');
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<string>('running');
  const [exitCode, setExitCode] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  // Pane-mount fallback only: replaced by the REAL process start time from
  // the registry as soon as it loads (below). Without that, opening the log
  // of a long-running/detected process showed a duration restarting from 0s.
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
  const [completedAt, setCompletedAt] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    scriptsApi.list()
      .then(({ scripts }) => {
        if (!active) return;
        const rec = scripts.find(s => s.processId === processId);
        if (rec?.startedAt) setStartedAt(rec.startedAt);
        if (rec?.completedAt) setCompletedAt(rec.completedAt);
      })
      .catch(() => { /* registry unavailable — keep the mount-time fallback */ });
    return () => { active = false; };
  }, [processId]);
  const preRef = useRef<HTMLPreElement>(null);
  const autoScrollRef = useRef(true);

  // Track if user has scrolled up (disable auto-scroll)
  const handleScroll = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = isNearBottom;
  }, []);

  // Output: guidato dall'EVENTO, con il polling come rete di sicurezza.
  //
  // Prima era un `setInterval(poll, 2000)` secco: su un processo muto — un dev
  // server acceso e fermo, che è il caso di un pane lasciato aperto — sono 30
  // richieste al minuto che tornano vuote. E intanto il server annunciava
  // `scripts:output` (accorpato a max 1/s per processo, `notifyScriptOutput`) e
  // nessuno lo ascoltava: l'evento esisteva PER evitare questo polling.
  //
  // Ora: si legge quando c'è qualcosa da leggere, e la rete di sicurezza scatta
  // ogni SAFETY_POLL_MS perché l'evento può mancare — WS caduta, oppure un
  // processo che termina senza produrre altro output (`done`/`exitCode`
  // arrivano dalla stessa risposta, quindi servono comunque).
  //
  // La lettura è limitata a 1/s come l'accorpamento del server: su un processo
  // loquace la latenza si dimezza rispetto ai 2s senza moltiplicare le
  // richieste; su uno muto scendono a zero.
  useEffect(() => {
    let active = true;
    let currentOffset = 0;
    // In-flight guard: currentOffset only advances AFTER the await resolves, so a
    // request slower than the tick would let the next poll start on the same
    // offset — both fetch the same chunk and both append it → duplicated log text.
    let inFlight = false;
    let lastPollAt = 0;
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    const SAFETY_POLL_MS = 10_000;
    const MIN_GAP_MS = 1_000;

    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      lastPollAt = Date.now();
      try {
        const data = await scriptsApi.output(processId, currentOffset);
        if (!active) return;
        if (data.truncatedLines && data.truncatedLines > 0) {
          // Il buffer ha buttato righe che questo pannello non vedrà mai:
          // dirlo è meglio che lasciar credere di aver visto tutto.
          const notice = `[… ${data.truncatedLines} righe scartate: il buffer del log è pieno]`;
          setOutput(prev => prev ? prev + '\n' + notice : notice);
        }
        if (data.output) {
          // Lo strip degli ANSI si fa QUI, sul delta, non nel JSX: là girava
          // due regex globali su TUTTA la stringa a ogni render.
          const clean = stripAnsi(data.output);
          setOutput(prev => {
            const next = prev ? prev + '\n' + clean : clean;
            // Tetto lato client: il ring buffer da 500KB è del server, qui si
            // sommavano i delta per l'intera vita del pane.
            return next.length > MAX_CLIENT_LOG_CHARS ? next.slice(next.length - MAX_CLIENT_LOG_CHARS) : next;
          });
        }
        setPending(stripAnsi(data.pending ?? ''));
        currentOffset = data.offset;
        setOffset(data.offset);
        setStatus(data.status);
        setExitCode(data.exitCode);
        if (data.done) {
          setCompletedAt(new Date().toISOString());
        }
        setError(null);
      } catch (err: unknown) {
        if (!active) return;
        setError((err instanceof Error && err.message) || 'Failed to fetch output');
      } finally {
        inFlight = false;
      }
    };

    /** Legge subito se è passato abbastanza, altrimenti accoda una sola lettura. */
    const pollSoon = () => {
      if (!active || coalesceTimer) return;
      const since = Date.now() - lastPollAt;
      if (since >= MIN_GAP_MS) { void poll(); return; }
      coalesceTimer = setTimeout(() => { coalesceTimer = null; void poll(); }, MIN_GAP_MS - since);
    };

    void poll();
    const id = setInterval(() => { void poll(); }, SAFETY_POLL_MS);
    const unsub = onMessage?.((msg: WSMessage) => {
      const m = msg as { type?: string; processId?: string };
      if (m.type === 'scripts:output' && m.processId === processId) pollSoon();
    });

    return () => {
      active = false;
      clearInterval(id);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      unsub?.();
    };
  }, [processId, onMessage]);

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    if (autoScrollRef.current && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [output]);

  const handleStop = useCallback(async () => {
    try {
      await scriptsApi.stop(processId);
    } catch {}
  }, [processId]);

  const statusColor = status === 'running'
    ? 'text-green-500'
    : status === 'done'
    ? 'text-app-text-muted'
    : 'text-red-500';

  const statusLabel = status === 'running'
    ? 'Running'
    : status === 'done'
    ? `Done (exit ${exitCode ?? 0})`
    : `Error (exit ${exitCode ?? 1})`;

  return (
    <div className="flex flex-col h-full bg-app-bg">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-app-border bg-elevated flex-shrink-0">
        <span className="text-[12px] font-medium text-app-text truncate">
          {scriptName || processId.slice(0, 8)}
        </span>
        <span className={`text-[11px] ${statusColor}`}>
          {statusLabel}
        </span>
        <span className="text-[11px] text-app-text-muted">
          {formatDuration(startedAt, completedAt)}
        </span>
        <div className="flex-1" />
        {/* THE LIVENESS SIGNAL LIVES HERE, not in a bar under the log.
            It used to be a strip below the `pre`, mounted only while the
            process ran: the moment the process finished, that strip unmounted
            and the log grew by its height. A reload landing on a process that
            had ended while nobody watched paid the same shift, in reverse,
            because the pane starts out assuming "running". After the spacer
            nothing follows but the Stop button, so appearing and disappearing
            here moves nothing. */}
        {status === 'running' && (
          <span className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            {offset} lines
          </span>
        )}
        {status === 'running' && (
          <button
            onClick={handleStop}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-red-500 hover:bg-red-500/10 rounded transition-colors"
            title="Stop process"
          >
            <Square size={10} />
            Stop
          </button>
        )}
      </div>

      {/* Output */}
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-3 text-[12px] leading-relaxed text-app-text font-mono whitespace-pre-wrap break-words select-text"
      >
        {output || pending
          ? (pending ? (output ? output + '\n' + pending : pending) : output)
          : (error ? `Error: ${error}` : 'Waiting for output...')}
      </pre>
    </div>
  );
}
