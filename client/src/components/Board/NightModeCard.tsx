/**
 * La modalità notturna, con il suo STATO — non solo il suo interruttore.
 *
 * Perché è una card e non una casella di spunta. Una casella dice se è accesa;
 * la domanda vera è un'altra: «è accesa, e allora perché non parte niente?».
 * Senza una risposta sullo schermo l'unico modo di saperlo era leggere i log del
 * server (`modalità notturna in attesa su …`), cioè nessun modo. Qui il motivo
 * dell'attesa è la riga più grande della card, ed è il motivo per cui esiste.
 *
 * Lo stato arriva da `GET /api/boards/:id/night-status`, che passa dallo STESSO
 * calcolo del gate del dispatcher (`evaluateNight`): l'interfaccia non può
 * mostrare «sta dispacciando» mentre il dispatcher aspetta.
 *
 * Il polling è lento di proposito (15s): questa card racconta una cosa che
 * cambia su scala di minuti — il carico della macchina e chi è attaccato — e
 * interrogare più spesso aggiungerebbe carico proprio a ciò che sta misurando.
 */
import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { useT, useLocale } from '../../hooks/useT';
import { boardApi } from '../../lib/board';
// Il testo sta in un modulo suo: e' la parte pura, e tenerla qui spegneva il
// fast refresh di tutta la card.
import { describeNight, formatCountdown, type NightStatus } from './nightModeText';

interface Props {
  projectId: string;
  enabled: boolean;
  until: string;
  onChange: (patch: { nightMode?: boolean; nightModeUntil?: string }) => void;
  /** Iniettabile per i test: di default interroga il server. */
  fetchStatus?: (projectId: string) => Promise<NightStatus | null>;
}

const POLL_MS = 15_000;
/** La stessa soglia per core del server (`night-mode.ts`), solo per disegnare la barra. */
const MAX_LOAD_PER_CORE = 1.5;

async function defaultFetch(projectId: string): Promise<NightStatus | null> {
  // Via `boardApi` come tutto il resto della board: un `fetch` a mano qui si
  // porterebbe dietro base URL, errori e intestazioni diverse dagli altri.
  try {
    return await boardApi.nightStatus(projectId);
  } catch {
    return null;
  }
}

export function NightModeCard({ projectId, enabled, until, onChange, fetchStatus }: Props) {
  const [st, setSt] = useState<NightStatus | null>(null);
  /** Se una risposta è già arrivata (anche negativa). Serve a non spacciare
   *  «sto ancora chiedendo» per «il server non risponde». */
  const [asked, setAsked] = useState(false);
  const tr = useT();
  const locale = useLocale();

  // Quando l'interruttore cambia, lo stato raccolto prima non vale piu'. Il
  // reset si fa QUI, durante il render, che e' il modo che React documenta per
  // reagire al cambio di una prop: farlo con due setState sincrone dentro
  // l'effetto costava un render in piu' ogni volta e, riaccendendo, faceva
  // lampeggiare per un istante lo stato della sessione precedente.
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
    setSt(null);
    setAsked(false);
  }

  useEffect(() => {
    // Spenta: nessun polling. Una card che non ha niente da raccontare non deve
    // nemmeno chiedere.
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const next = await (fetchStatus ?? defaultFetch)(projectId);
      if (alive) { setSt(next); setAsked(true); }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [projectId, enabled, fetchStatus]);

  const info = describeNight(st, enabled, asked);
  const detail = info.detailText ?? (info.detailKey ? tr(info.detailKey) : null);
  const soglia = Math.max(1, (st?.cores ?? 1)) * MAX_LOAD_PER_CORE;
  const loadPct = st ? Math.min(100, Math.round((st.load1 / soglia) * 100)) : 0;

  const toneRing =
    info.tone === 'go' ? 'border-emerald-500/40 bg-emerald-500/5'
    : info.tone === 'wait' ? 'border-amber-500/40 bg-amber-500/5'
    : 'border-white/10 bg-white/[0.02]';
  const toneDot =
    info.tone === 'go' ? 'bg-emerald-400'
    : info.tone === 'wait' ? 'bg-amber-400'
    : 'bg-app-text-muted/50';

  return (
    <section
      className={`rounded-lg border px-2.5 py-2 transition-colors ${toneRing}`}
      aria-label={tr('board.night.title')}
      data-testid="night-mode-card"
    >
      <label className="flex cursor-pointer items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <Moon className="w-4 h-4" aria-hidden />
          <span className="font-medium">{tr('board.night.title')}</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ nightMode: e.target.checked })}
          className="h-3.5 w-3.5 accent-emerald-500"
          data-testid="night-mode-toggle"
        />
      </label>

      <p className="mt-1 text-[11px] leading-snug text-app-text-muted">{tr('board.night.blurb')}</p>

      {enabled && (
        <>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-app-text-muted">{tr('board.night.until')}</span>
            <input
              type="time"
              value={until}
              onChange={(e) => onChange({ nightModeUntil: e.target.value })}
              className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text"
              data-testid="night-mode-until"
            />
          </div>

          <div className="mt-2 flex items-start gap-2" data-testid="night-mode-state">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${toneDot}`} aria-hidden />
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-app-text">{tr(info.titleKey)}</div>
              {detail && (
                <div className="text-[11px] leading-snug text-app-text-muted">{detail}</div>
              )}
            </div>
          </div>

          {st && (
            <>
              {/* Il carico come BARRA, non come numero: «15.3» non dice niente,
                  «oltre la soglia» sì. La soglia è per core, quindi la stessa
                  barra significa la stessa cosa su macchine diverse. */}
              <div className="mt-2">
                <div className="flex items-baseline justify-between text-[10px] text-app-text-muted">
                  <span>{tr('board.night.load')}</span>
                  <span className="tabular-nums">
                    {st.load1.toFixed(1)} / {soglia.toFixed(1)} ({tr('board.night.cores', { n: st.cores })})
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-[width] ${loadPct >= 100 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${loadPct}%` }}
                  />
                </div>
              </div>

              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-app-text-muted">
                <span>
                  {st.busySessions === 0
                    ? tr('board.night.nobodyAttached')
                    : st.busySessions === 1
                      ? tr('board.night.sessions.one')
                      : tr('board.night.sessions.many', { n: st.busySessions })}
                </span>
                {st.endsInMs != null && (
                  <span data-testid="night-mode-countdown">
                    {tr('board.night.endsIn', { t: formatCountdown(st.endsInMs, locale) })}
                  </span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
