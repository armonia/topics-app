import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { appSettingsApi, profileApi, type AppBehaviorSettings, type ProfileStats } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { bannerMarkdown } from '../../lib/bannerShare';

/**
 * LE TUE STATISTICHE: quanto lavoro è passato davvero di qui.
 *
 * ── I NUMERI VENGONO DA DOVE QUALCUNO SCRIVE ────────────────────────────────
 * `usage_records` e `agent_sessions` sono tabelle vere che NESSUNO scrive: un
 * pannello che le leggesse mostrerebbe zeri per sempre, e uno zero è la bugia
 * peggiore — «0 sessioni» si legge «non hai lavorato», non «non lo so». La
 * fonte è `messages`/`tasks`/`topics`, e la storia sta in cima a
 * `server/services/profile-stats.ts`.
 *
 * ── IL COSTO PORTA CON SÉ CIÒ CHE NON SA ────────────────────────────────────
 * Il totale in dollari è quello MISURATO. Le righe scritte prima dello
 * scorporo della cache hanno un costo gonfiato di un fattore non
 * ricostruibile: non si sommano, e non si nascondono — la riga sotto dice
 * quante ne sono state escluse. Un dato mancante dichiarato è informazione.
 */

function compatto(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

function Cifra({ valore, etichetta, nota }: { valore: string; etichetta: string; nota?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[19px] font-semibold leading-tight text-app-text tabular-nums">{valore}</div>
      <div className="truncate text-[10.5px] uppercase tracking-wide text-app-text-tertiary">{etichetta}</div>
      {nota && <div className="truncate text-[10.5px] text-app-text-muted">{nota}</div>}
    </div>
  );
}

/** Lo sparkline dei 30 giorni. Tutto a zero ⇒ niente curva: una linea piatta
 *  disegnerebbe una costanza che non c'è. */
function Sparkline({ serie }: { serie: ProfileStats['activity']['last30'] }) {
  const max = Math.max(0, ...serie.map((p) => p.tokens));
  if (serie.length < 2 || max <= 0) return null;
  const w = 100;
  const h = 22;
  const dx = w / (serie.length - 1);
  const punti = serie.map((p, i) => `${(i * dx).toFixed(1)},${(h - (p.tokens / max) * h).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-6 w-full" aria-hidden="true">
      <path d={`M0,${h} L${punti.join(' L')} L${w},${h} Z`} className="fill-primary/15" />
      <path d={`M${punti.join(' L')}`} fill="none" strokeWidth={1.2} vectorEffect="non-scaling-stroke" className="stroke-primary" />
    </svg>
  );
}

/**
 * Risultato della configurazione relay: URL condivisibile via relay oppure
 * URL locale (LAN only).
 */
interface RelayInfo {
  /** URL di destinazione (relay o localhost). */
  url: string;
  /** `true` = l'URL è raggiungibile solo sulla LAN locale. */
  lanOnly: boolean;
}

export function ProfileStatsSection() {
  const t = useT();
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [nome, setNome] = useState<string | null>(null);
  const [errore, setErrore] = useState(false);
  const [copiato, setCopiato] = useState(false);
  // L'avviso vive finche' non si ricopia: e' la risposta a un gesto.
  const [avviso, setAvviso] = useState<string | null>(null);
  const [copiatoLink, setCopiatoLink] = useState(false);
  const [appSettings, setAppSettings] = useState<AppBehaviorSettings | null>(null);
  const [relayInfo, setRelayInfo] = useState<RelayInfo | null>(null);

  useEffect(() => {
    let vivo = true;
    profileApi.stats()
      .then((r) => { if (vivo) { setStats(r.stats); setNome(r.name); } })
      .catch(() => { if (vivo) setErrore(true); });
    appSettingsApi.get()
      .then((s) => { if (vivo) setAppSettings(s); })
      .catch(() => { /* non bloccante */ });
    // Costruisce l'URL pubblico dal relay se disponibile.
    // `/i/:relayId/public/profile` e' il percorso del browser proxy del relay.
    fetch('/api/auth/relay', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((r: { enabled: boolean; baseUrl: string | null; relayId: string | null }) => {
        if (!vivo) return;
        if (r.enabled && r.baseUrl && r.relayId) {
          setRelayInfo({
            url: `${r.baseUrl}/i/${r.relayId}/public/profile`,
            lanOnly: false,
          });
        } else {
          // Relay non configurato: l'URL funziona solo in LAN.
          setRelayInfo({
            url: `${typeof window !== 'undefined' ? window.location.origin : ''}/public/profile`,
            lanOnly: true,
          });
        }
      })
      .catch(() => {
        if (!vivo) return;
        setRelayInfo({
          url: `${typeof window !== 'undefined' ? window.location.origin : ''}/public/profile`,
          lanOnly: true,
        });
      });
    return () => { vivo = false; };
  }, []);

  // Prima che il relay risponda, usa l'URL locale come placeholder.
  const publicUrl = relayInfo?.url
    ?? `${typeof window !== 'undefined' ? window.location.origin : ''}/public/profile`;
  const lanOnly = relayInfo?.lanOnly ?? true;

  const togglePublishCost = useCallback(async () => {
    if (!appSettings) return;
    const next = !appSettings.profilePublishCost;
    setAppSettings((s) => s ? { ...s, profilePublishCost: next } : s);
    try {
      const updated = await appSettingsApi.update({ profilePublishCost: next });
      setAppSettings(updated);
    } catch {
      // Ripristina il valore precedente in caso di errore
      setAppSettings((s) => s ? { ...s, profilePublishCost: !next } : s);
    }
  }, [appSettings]);

  if (errore) {
    return (
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">{t('profile.stats.title')}</h3>
        <p className="text-[11px] text-app-text-tertiary">{t('profile.stats.unavailable')}</p>
      </div>
    );
  }

  const s = stats;
  const daQuando = s?.activity.firstSeen
    ? new Date(s.activity.firstSeen).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
    : null;

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">
        {t('profile.stats.title')}
      </h3>
      <p className="text-[11px] leading-relaxed text-app-text-tertiary">
        {daQuando ? t('profile.stats.blurbSince', { data: daQuando }) : t('profile.stats.blurb')}
      </p>

      <div className="space-y-3 rounded-lg border border-app-border px-3 py-3" data-testid="profile-stats">
        {!s ? (
          <div className="text-[11px] text-app-text-tertiary">{t('profile.stats.loading')}</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              <Cifra
                valore={compatto(s.sessions.total)}
                etichetta={t('profile.stats.sessions')}
                nota={t('profile.stats.open', { n: compatto(s.sessions.open) })}
              />
              <Cifra
                valore={compatto(s.tasks.done)}
                etichetta={t('profile.stats.tasksDone')}
                nota={t('profile.stats.ofTotal', { n: compatto(s.tasks.total) })}
              />
              <Cifra
                valore={compatto(s.tokens.total)}
                etichetta={t('profile.stats.tokens')}
                nota={t('profile.stats.cacheIncluded')}
              />
              <Cifra
                valore={compatto(Math.round(s.agentHours))}
                etichetta={t('profile.stats.agentHours')}
                nota={t('profile.stats.activeDays', { n: s.activity.activeDays })}
              />
              <Cifra
                valore={compatto(s.projects)}
                etichetta={t('profile.stats.projects')}
                nota={s.activity.streakDays > 0 ? t('profile.stats.streak', { n: s.activity.streakDays }) : '-'}
              />
            </div>

            <Sparkline serie={s.activity.last30} />

            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-app-border pt-2">
              <span className="text-[11px] text-app-text-secondary">
                {t('profile.stats.spend', { v: s.cost.measuredUsd.toFixed(2) })}
              </span>
              {s.cost.uncertainRows > 0 && (
                <span className="text-[10.5px] text-app-text-muted">
                  {t('profile.stats.uncertain', { n: s.cost.uncertainRows })}
                </span>
              )}
            </div>

            {/* Il banner sta qui e non in una scheda sua: è la stessa misura,
                in un formato che si può portare fuori. */}
            <div className="flex flex-wrap items-center gap-2 border-t border-app-border pt-2">
              <span className="text-[11px] text-app-text-secondary">{t('profile.banner.label')}</span>
              {/* `coarse:min-h-11`: dentro una riga flex questi `<a>` sono
                  elementi flex, quindi non ricadono nell'esenzione WCAG per il
                  link INLINE dentro una frase — sono bottoni a tutti gli
                  effetti, e sotto il dito devono misurare 44px come tali. */}
              <a
                href={`/api/profile/banner.svg${nome ? `?name=${encodeURIComponent(nome)}` : ''}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover coarse:min-h-11"
              >
                {t('profile.banner.open')}
              </a>
              <a
                href={`/api/profile/banner.svg?theme=light${nome ? `&name=${encodeURIComponent(nome)}` : ''}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover coarse:min-h-11"
              >
                {t('profile.banner.light')}
              </a>
              {/* IL MARKDOWN GIA' SCRITTO, non le istruzioni per scriverlo.
                  Il suggerimento diceva «da salvare e mettere in un README»:
                  cioe' apri, salva, cerca la sintassi, ricordati l'URL. La
                  riga che serve e' una sola, e la sa gia' l'app. Segnalato:
                  «ci deve potere essere il banner da mettere sul mio profilo
                  di github». */}
              <button
                type="button"
                data-testid="profile-banner-copy"
                onClick={async () => {
                  // `bannerMarkdown` non costruisce solo la stringa: risponde
                  // anche alla domanda che il bottone deve porsi PRIMA di
                  // copiarla - questo indirizzo lo raggiunge qualcuno che non
                  // sono io? Da localhost la risposta e' no, e allora il
                  // markdown si copia lo stesso (chi ha un tunnel lo adatta)
                  // ma accompagnato dall'avviso: un link rotto scoperto dopo
                  // averlo incollato su GitHub e' il momento peggiore.
                  const m = bannerMarkdown(window.location.origin, nome);
                  setAvviso(m.condivisibile ? null : m.avviso);
                  setCopiato(await copyText(m.testo));
                  // Torna com'era da solo: un «copiato» che resta acceso
                  // diventa un'etichetta e smette di dire che e' successo ORA.
                  setTimeout(() => setCopiato(false), 2000);
                }}
                className="flex items-center rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover coarse:min-h-11"
              >
                {copiato ? t('profile.banner.copied') : t('profile.banner.copy')}
              </button>
              <span className="text-[10.5px] text-app-text-muted">{t('profile.banner.hint')}</span>
              {avviso && (
                <p data-testid="profile-banner-warning" className="w-full text-[10.5px] leading-snug text-amber-400">{avviso}</p>
              )}
            </div>

            {/* ── Pagina pubblica: URL da condividere, senza login. ──────── */}
            <div className="flex flex-col gap-1.5 border-t border-app-border pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-app-text-secondary">{t('profile.public.label')}</span>
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover coarse:min-h-11"
                >
                  {t('profile.public.open')}
                </a>
                <button
                  type="button"
                  data-testid="profile-public-copy"
                  onClick={async () => {
                    setCopiatoLink(await copyText(publicUrl));
                    setTimeout(() => setCopiatoLink(false), 2000);
                  }}
                  className="flex items-center rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover coarse:min-h-11"
                >
                  {copiatoLink ? t('profile.public.copied') : t('profile.public.copy')}
                </button>
              </div>
              {/* Avviso LAN-only: se il relay non e' configurato, l'URL funziona
                  solo sulla rete locale. Distinguiamo i due casi con testo diverso
                  cosi' chi incolla sa gia' cosa aspettarsi. */}
              <p className="text-[10.5px] text-app-text-muted">
                {lanOnly ? t('profile.public.hintLanOnly') : t('profile.public.hint')}
              </p>
              {/* Toggle spesa: dato personale, opt-in esplicito. */}
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3 w-3 flex-shrink-0 accent-primary"
                  checked={appSettings?.profilePublishCost === true}
                  onChange={togglePublishCost}
                  disabled={appSettings == null}
                />
                <span className="text-[11px] text-app-text-secondary">
                  {t('profile.public.showCost')}
                  <span className="ml-1 text-[10.5px] text-app-text-muted">{t('profile.public.showCostHint')}</span>
                </span>
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
