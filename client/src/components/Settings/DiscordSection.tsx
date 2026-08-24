import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { Switch } from '../Shared/Switch';
import {
  appSettingsApi,
  profileApi,
  type DiscordActivityPreview,
  type DiscordDetailLevel,
  type DiscordPresenceStatus,
} from '../../lib/api';

/**
 * DISCORD: cosa dice di te questa app, a chi, e con quanto dettaglio.
 *
 * ── L'ANTEPRIMA È IL PEZZO IMPORTANTE, NON UN ABBELLIMENTO ──────────────────
 * Un interruttore che dice «mostra la mia attività su Discord» chiede di
 * fidarsi. Qui non serve fidarsi: la card sotto è ciò che vedono gli altri,
 * costruita dalla STESSA funzione del server che pubblica (`buildActivity`),
 * non da una sua imitazione scritta di qua. Cambiando livello cambia
 * l'anteprima, quindi la scelta si fa guardando il risultato.
 *
 * ── SI GUARDA PRIMA DI ACCENDERE ───────────────────────────────────────────
 * Le anteprime arrivano anche a interruttore spento — è il punto. Un pannello
 * che mostra cosa pubblicherà solo DOPO aver pubblicato ha l'ordine invertito.
 *
 * ── LO STATO DEL FILO NON È UN PALLINO E BASTA ─────────────────────────────
 * «Discord non è aperto» e «Discord ha rifiutato questa applicazione» hanno lo
 * stesso aspetto (niente presence) e due rimedi opposti: uno si apre, l'altro
 * si configura. Il server li distingue (`no_discord` vs `error`) e qui si
 * distinguono anche a parole, con la ragione in chiaro sotto.
 */

const LIVELLI: DiscordDetailLevel[] = ['minimal', 'activity', 'detailed'];

/** Come si legge un pallino: colore + PAROLA. Il colore da solo non è un'
 *  informazione per chi non lo distingue. */
const COLORE: Record<DiscordPresenceStatus['connection'], string> = {
  off: 'bg-app-text-muted',
  connecting: 'bg-amber-500',
  connected: 'bg-emerald-500',
  no_discord: 'bg-app-text-muted',
  error: 'bg-red-500',
};

/**
 * La card come la disegna Discord: due righe, l'icona e il cronometro.
 *
 * `appName` arriva da Discord (`status.applicationName`), non da qui. Prima
 * era scritto «Topics» a mano, e chi apriva questo pannello per sapere cosa
 * vedono gli altri leggeva un nome che sulla card vera non compare: quel
 * titolo e' il nome dell'APPLICAZIONE del portale sviluppatori, che per questa
 * installazione e' «Jarvis». Finche' il filo e' chiuso non lo sappiamo, e si
 * mostra un segnaposto invece di indovinare.
 */
function Anteprima({ activity, vuoto, appName, nomeIgnoto }: { activity: DiscordActivityPreview | null; vuoto: string; appName: string | null; nomeIgnoto: string }) {
  // Lo STESSO testid sui due rami: chi misura vuole «cosa vede l'altro
  // adesso», e «niente» è una di quelle risposte. Un testid solo sul ramo
  // pieno costringerebbe la spec a distinguere fra «vuoto» e «non montato»,
  // che sono due cose diverse e nessuna delle due è quella cercata.
  if (!activity) {
    return (
      <div
        data-testid="discord-preview"
        className="rounded-md border border-dashed border-app-border px-3 py-2 text-[11px] text-app-text-muted"
      >
        {vuoto}
      </div>
    );
  }
  return (
    <div
      data-testid="discord-preview"
      className="flex items-start gap-2.5 rounded-md border border-app-border bg-app-hover/40 px-3 py-2"
    >
      {/* L'iniziale del nome VERO. La «T» fissa di prima faceva credere che
          Discord non stesse onorando l'immagine, mentre era solo questo
          quadratino disegnato da noi. */}
      <div className="mt-0.5 h-8 w-8 flex-shrink-0 rounded bg-primary/15 text-center text-[13px] font-semibold leading-8 text-primary">
        {(appName ?? '?').slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-app-text-tertiary">
          {appName ?? nomeIgnoto}
        </div>
        <div className="truncate text-[12px] text-app-text">{activity.details}</div>
        {activity.state && <div className="truncate text-[11.5px] text-app-text-secondary">{activity.state}</div>}
      </div>
    </div>
  );
}

export function DiscordSection() {
  const t = useT();
  const [status, setStatus] = useState<DiscordPresenceStatus | null>(null);
  const [preview, setPreview] = useState<Record<DiscordDetailLevel, DiscordActivityPreview | null> | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const vivo = useRef(true);

  const carica = useCallback(async () => {
    try {
      const r = await profileApi.discord();
      if (!vivo.current) return;
      setStatus(r.status);
      setPreview(r.preview);
      setErrore(null);
    } catch {
      if (vivo.current) setErrore(t('discord.unreachable'));
    }
  }, [t]);

  useEffect(() => {
    vivo.current = true;
    void carica();
    // Il filo si apre (o cade) senza che nessuno tocchi niente: senza un
    // rinfresco, il pannello aperto mentre Discord parte resterebbe fermo su
    // «non è aperto» a tempo indeterminato.
    const id = setInterval(() => { void carica(); }, 5000);
    return () => { vivo.current = false; clearInterval(id); };
  }, [carica]);

  /** L'unica porta di scrittura è `PUT /api/app-settings` — la stessa di ogni
   *  altro knob globale. Dopo, si rilegge: lo stato del filo lo sa il server. */
  const salva = useCallback(async (patch: { discordPresenceEnabled?: boolean; discordDetailLevel?: DiscordDetailLevel }) => {
    setInCorso(true);
    setErrore(null);
    // Ottimistica sulla sola parte che l'utente ha appena mosso: l'attesa fra
    // il clic e il giro del server non deve leggersi come «non ha funzionato».
    setStatus((s) => (s ? { ...s, ...(patch.discordPresenceEnabled !== undefined ? { enabled: patch.discordPresenceEnabled } : {}), ...(patch.discordDetailLevel ? { level: patch.discordDetailLevel } : {}) } : s));
    try {
      await appSettingsApi.update(patch);
      await carica();
    } catch {
      setErrore(t('discord.saveFailed'));
      await carica();
    } finally {
      if (vivo.current) setInCorso(false);
    }
  }, [carica, t]);

  const acceso = status?.enabled ?? false;
  const livello = status?.level ?? 'activity';
  const stato = status?.connection ?? 'off';

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">
        {t('discord.title')}
      </h3>
      <p className="text-[11px] leading-relaxed text-app-text-tertiary">{t('discord.blurb')}</p>

      <div className="space-y-3 rounded-lg border border-app-border px-3 py-2.5" data-testid="discord-card">
        {/* L'interruttore */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-app-text">{t('discord.toggle')}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${COLORE[stato]}`} aria-hidden="true" />
              <span className="text-[11px] text-app-text-muted" data-testid="discord-state">
                {t(`discord.state.${stato}`)}
                {stato === 'connected' && status?.user?.username ? ` · ${status.user.username}` : ''}
              </span>
            </div>
          </div>
          {/* L'interruttore dell'app, non una sua copia. La copia che stava qui
              aveva esattamente i due difetti per cui `Shared/Switch` esiste: da
              spento `bg-app-border`, cioè quasi bianco su bianco in tema chiaro,
              e un bersaglio 36×20 che sotto il dito sta sotto la soglia dei
              44px (`settings-mobile.spec.ts` lo misura scheda per scheda). */}
          <Switch
            checked={acceso}
            onChange={(v) => void salva({ discordPresenceEnabled: v })}
            label={t('discord.toggle')}
            disabled={inCorso || !status}
            className="mt-0.5"
          />
        </div>

        {/* Perché non funziona, quando non funziona. Il messaggio del server è
            in chiaro: «non riesco» senza la ragione manda a indovinare. */}
        {acceso && status?.lastError && stato !== 'connected' && (
          <p className="text-[11px] leading-snug text-app-text-muted">{status.lastError}</p>
        )}

        {/* Quanto se ne vede.
            Bottoni con la semantica del radio, non `<input type="radio">`: il
            pallino nativo è 13px e nessuna classe lo porta a 44 senza
            disegnarlo grande come una moneta. Qui il bersaglio è la RIGA — che
            porta già due righe di testo, quindi sotto il dito supera i 44px per
            conto suo — e il pallino resta la dimensione giusta perché è
            disegnato, non di sistema. È la stessa ragione per cui nel pannello
            non c'è un solo `<select>` nativo. */}
        <div className="space-y-1 border-t border-app-border pt-2">
          <div className="mb-1 text-[11px] font-medium text-app-text-secondary" id="discord-level-label">
            {t('discord.level')}
          </div>
          <div role="radiogroup" aria-labelledby="discord-level-label" className="space-y-0.5">
            {LIVELLI.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={livello === l}
                disabled={inCorso || !status}
                onClick={() => void salva({ discordDetailLevel: l })}
                className="flex w-full cursor-pointer items-start gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-app-hover disabled:cursor-default disabled:opacity-50 coarse:min-h-11"
              >
                <span
                  aria-hidden="true"
                  className={`mt-1 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                    livello === l ? 'border-primary' : 'border-app-text-muted'
                  }`}
                >
                  {livello === l && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] text-app-text">{t(`discord.level.${l}`)}</span>
                  <span className="block text-[11px] leading-snug text-app-text-muted">{t(`discord.level.${l}.hint`)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Ciò che vedono gli altri */}
        <div className="space-y-1.5 border-t border-app-border pt-2">
          <div className="text-[11px] font-medium text-app-text-secondary">{t('discord.preview')}</div>
          <Anteprima
            activity={preview?.[livello] ?? null}
            vuoto={t('discord.previewEmpty')}
            appName={status?.applicationName ?? null}
            nomeIgnoto={t('discord.appNameUnknown')}
          />
          <p className="text-[10.5px] leading-snug text-app-text-muted">{t('discord.previewNote')}</p>
        </div>

        {errore && <p className="text-[11px] text-red-500">{errore}</p>}
      </div>
    </div>
  );
}
