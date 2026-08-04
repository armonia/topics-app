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

export interface NightStatus {
  enabled: boolean;
  until: string | null;
  startedAt: string | null;
  action: 'off' | 'dispatch' | 'wait' | 'expire';
  reason: string | null;
  load1: number;
  cores: number;
  busySessions: number;
  endsInMs: number | null;
}

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
  try {
    const r = await fetch(`/api/boards/${encodeURIComponent(projectId)}/night-status`);
    if (!r.ok) return null;
    return (await r.json()) as NightStatus;
  } catch {
    return null;
  }
}

/** «fra 2h 15min» — la scadenza come DURATA, che è come la si pensa alle 23. */
export function formatCountdown(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'meno di un minuto';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

/**
 * Il testo dello stato. Separato dal componente perché è la parte che si può
 * sbagliare — e sbagliarla significa dire a qualcuno che la board sta lavorando
 * mentre è ferma.
 */
export function describeNight(st: NightStatus | null, enabled: boolean): {
  tone: 'off' | 'go' | 'wait';
  title: string;
  detail: string | null;
} {
  if (!enabled) {
    return {
      tone: 'off',
      title: 'Spenta',
      detail: 'La board dispaccia come sempre, senza guardare il carico.',
    };
  }
  if (!st) {
    return { tone: 'wait', title: 'Stato non disponibile', detail: 'Il server non ha risposto: riprovo fra poco.' };
  }
  if (st.action === 'wait') {
    return { tone: 'wait', title: 'In attesa', detail: st.reason };
  }
  if (st.action === 'expire') {
    return { tone: 'off', title: 'Scaduta', detail: st.reason ?? 'Orario di fine raggiunto: si spegne al prossimo giro.' };
  }
  return { tone: 'go', title: 'Sta dispacciando', detail: 'Macchina libera: i task in coda partono.' };
}

export function NightModeCard({ projectId, enabled, until, onChange, fetchStatus }: Props) {
  const [st, setSt] = useState<NightStatus | null>(null);

  useEffect(() => {
    // Spenta: nessun polling. Una card che non ha niente da raccontare non deve
    // nemmeno chiedere.
    if (!enabled) { setSt(null); return; }
    let alive = true;
    const load = async () => {
      const next = await (fetchStatus ?? defaultFetch)(projectId);
      if (alive) setSt(next);
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [projectId, enabled, fetchStatus]);

  const info = describeNight(st, enabled);
  const soglia = Math.max(1, (st?.cores ?? 1)) * MAX_LOAD_PER_CORE;
  const caricoPct = st ? Math.min(100, Math.round((st.load1 / soglia) * 100)) : 0;

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
      aria-label="Modalità notturna"
      data-testid="night-mode-card"
    >
      <label className="flex cursor-pointer items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span aria-hidden>🌙</span>
          <span className="font-medium">Modalità notturna</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ nightMode: e.target.checked })}
          className="h-3.5 w-3.5 accent-emerald-500"
          data-testid="night-mode-toggle"
        />
      </label>

      <p className="mt-1 text-[11px] leading-snug text-app-text-muted">
        Mentre sei via, la coda parte solo a macchina libera — e si spegne da sola
        all'orario di fine, invece di restare armata addosso a chi lavora.
      </p>

      {enabled && (
        <>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-app-text-muted">Si ferma alle</span>
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
              <div className="text-[11px] font-medium text-app-text">{info.title}</div>
              {info.detail && (
                <div className="text-[11px] leading-snug text-app-text-muted">{info.detail}</div>
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
                  <span>Carico</span>
                  <span className="tabular-nums">
                    {st.load1.toFixed(1)} / {soglia.toFixed(1)} ({st.cores} core)
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-[width] ${caricoPct >= 100 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${caricoPct}%` }}
                  />
                </div>
              </div>

              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-app-text-muted">
                <span>
                  {st.busySessions === 0
                    ? 'Nessuno attaccato a una sessione'
                    : `${st.busySessions} ${st.busySessions === 1 ? 'sessione attiva' : 'sessioni attive'}`}
                </span>
                {st.endsInMs != null && (
                  <span data-testid="night-mode-countdown">Si spegne fra {formatCountdown(st.endsInMs)}</span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
