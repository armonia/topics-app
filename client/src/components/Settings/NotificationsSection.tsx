import { useState, useEffect } from 'react';
import { useT } from '@/hooks/useT';
import { Bell, BellOff, Check, AlertCircle, Moon, Smartphone } from 'lucide-react';
import type { AppSettings } from '../../types';
import { notificationStatus, type NativeNotificationStatus } from '../../lib/shell/app';
import { describeNativeNotifications } from '../../lib/notificationStatus';
import { focusGateState, FULL_DISK_ACCESS_URL, type FocusGateState } from '../../lib/shell/focus';
import { openExternalOnce } from '../../lib/openExternal';
import { ToggleRow } from './ToggleRow';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import type { PushWhenOpen } from '../../state/pushDevice';

interface NotificationsSectionProps {
  settings: AppSettings;
  onChange: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void;
}

/**
 * Lo stato VERO della catena dei banner nativi.
 *
 * Il testo della scheda prometteva "native macOS notification" a prescindere.
 * Su una build non firmata da Apple quella promessa è falsa e non c'era modo di
 * accorgersene: la catena cade in silenzio in tre punti diversi. Questa riga
 * legge lo stato dal guscio (`notification_status`, sola lettura) e dice cosa
 * succede davvero — inclusa la riga di log da guardare quando non arriva nulla.
 */
function NativeBannerStatus() {
  const [status, setStatus] = useState<NativeNotificationStatus | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void notificationStatus().then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, []);

  // `undefined` = ancora in volo. Non si disegna una diagnosi non ancora letta:
  // un lampo di "NON arrivano" che poi si smentisce è peggio del nulla.
  if (status === undefined) return null;

  const verdict = describeNativeNotifications(status);
  const tone = {
    ok: 'text-app-text-muted',
    degraded: 'text-amber-500',
    broken: 'text-red-400',
    unknown: 'text-app-text-muted',
  }[verdict.health];

  return (
    <div className="flex items-start gap-2 mb-3 text-[11.5px]">
      {verdict.health === 'ok' ? (
        <Check size={13} className={`shrink-0 mt-px ${tone}`} />
      ) : (
        <AlertCircle size={13} className={`shrink-0 mt-px ${tone}`} />
      )}
      <div className="min-w-0">
        <div className={tone}>{verdict.headline}</div>
        {verdict.hint && (
          <div className="text-app-text-muted mt-0.5">{verdict.hint}</div>
        )}
        {status?.logPath && verdict.health !== 'ok' && (
          <div className="text-app-text-muted mt-0.5 font-mono text-[10.5px] break-all">
            {status.logPath}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Il gate Focus/Non disturbare, quando c'è qualcosa da dire.
 *
 * Su macOS 26 il gate legge lo stato del Focus da `~/Library/DoNotDisturb/DB/`,
 * che è protetto da TCC: senza Full Disk Access la lettura fallisce, il gate
 * resta trasparente (default sicuro — si notifica sempre) e l'utente riceve
 * banner durante un Focus **senza sapere perché**.
 *
 * Due cose sono cambiate, e vanno lette insieme.
 *
 * Il ramo «va tutto bene» NON si disegna più. Diceva «i banner restano zitti
 * mentre è attivo» e occupava una riga permanente per confermare che una
 * funzione fa il suo mestiere: una funzione che va non merita una riga.
 *
 * Il ramo «bloccato» scende da avviso ambra a riga muta. È un avviso
 * PERMANENTE per una funzione OPZIONALE — tacere i banner durante un Focus — e
 * il rapporto costo/beneficio era rovesciato: chiedeva il permesso più invasivo
 * di macOS con l'urgenza di un errore. L'azione resta, in linea; concedere il
 * permesso è un gesto che deve restare dell'utente, l'app può solo portarcelo
 * davanti.
 *
 * E `blocked` ora arriva SOLO da un permesso davvero negato: il caso «nessun
 * Focus è mai stato impostato» (file inesistente) non è più confuso con quello
 * (vedi `focus_status` lato Rust). Prima erano lo stesso `None`, e su un Mac
 * pulito questa riga chiedeva l'accesso completo al disco per niente.
 */
function FocusGateStatus() {
  const tr = useT();
  const [state, setState] = useState<FocusGateState>(() => focusGateState());
  useEffect(() => {
    // La prima lettura è asincrona: si ricontrolla finché non è tornata,
    // invece di fotografare uno stato «in attesa» e lasciarlo lì.
    if (state !== 'pending') return;
    const t = setInterval(() => {
      const next = focusGateState();
      if (next !== 'pending') { setState(next); clearInterval(t); }
    }, 400);
    return () => clearInterval(t);
  }, [state]);

  if (state !== 'blocked') return null;

  return (
    <div className="flex items-start gap-2 mb-3 text-[11.5px] text-app-text-muted">
      <Moon size={13} className="shrink-0 mt-px" />
      <div className="min-w-0">
        {tr('notif.focus.blurb')}{' '}
        <button
          onClick={() => openExternalOnce(FULL_DISK_ACCESS_URL)}
          className="underline underline-offset-2 hover:text-app-text transition-colors"
        >{tr('notif.focus.grant')}</button>
        {tr('notif.focus.thenRestart')}
      </div>
    </div>
  );
}

/** Il nome che si legge nella sidebar: l'ultimo segmento del path. */
function projectName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * I progetti che hai silenziato, e il gesto per riaccenderli.
 *
 * `mutedProjects` cresceva solo dal menu contestuale della sidebar, e l'unica
 * traccia era un'icona su quella riga. Archivia il progetto o passa a un altro
 * dispositivo e la regola continua a valere: le notifiche smettono di arrivare e
 * non c'è nessun posto dove chiedersi perché. È lo stesso scenario dei permessi
 * degli strumenti — un interruttore permanente premuto di corsa, in un posto, e
 * rileggibile in nessuno.
 *
 * Nessuna persistenza nuova: si legge e si riscrive lo stesso campo di
 * `AppSettings`, che è già sincronizzato lato server. Quando non c'è niente da
 * elencare il blocco non si disegna — un elenco vuoto è rumore.
 *
 * Solo i PROGETTI: il silenziamento della singola chat ha già la sua icona
 * sulla riga della chat, che è dove la si va a cercare.
 */
function MutedProjects({ settings, onChange }: NotificationsSectionProps) {
  const tr = useT();
  const muted = settings.mutedProjects ?? [];
  if (muted.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="settings-muted-projects">
      <div>
        <h3 className="text-[13px] font-medium text-app-text mb-1">{tr('notif.muted.title')}</h3>
        <p className="text-[12px] leading-snug text-app-text-muted">
          {tr('notif.muted.blurb')}
        </p>
      </div>
      <ul className="space-y-1">
        {muted.map((path) => (
          <li
            key={path}
            className="flex items-center gap-2 rounded-md border border-app-border px-2.5 py-2"
            data-testid={`muted-project-${path}`}
          >
            <BellOff size={14} className="shrink-0 text-app-text-muted" />
            <div className="min-w-0 flex-1" title={path}>
              <div className="truncate text-[12px] text-app-text">{projectName(path)}</div>
              <div className="truncate font-mono text-[10.5px] text-app-text-muted">{path}</div>
            </div>
            <button
              type="button"
              onClick={() => onChange('mutedProjects', muted.filter((p) => p !== path))}
              title={tr('notif.muted.unmute')}
              className="shrink-0 rounded p-1.5 text-app-text-muted hover:bg-app-hover hover:text-app-text transition-colors"
            >
              <Bell size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Le notifiche a APP CHIUSA, e i dispositivi che le ricevono.
 *
 * Prima qui non c'era niente: l'infrastruttura del push esisteva tutta e la UI
 * era stata tolta, quindi `push_subscriptions` aveva 0 righe e a porte chiuse
 * non arrivava mai nulla. Questa scheda è la porta — più tre cose che una
 * semplice porta non avrebbe:
 *
 *  · lo STATO DETTO PER INTERO. «Non iscritto», «negato dal sistema» e «su
 *    iPhone serve Topics installato» producono tutti e tre lo stesso silenzio, e
 *    due su tre hanno un rimedio a due tocchi. Un interruttore premibile con il
 *    permesso già negato prometterebbe una cosa che il sistema ha già deciso.
 *  · una preferenza PER DISPOSITIVO, non per account: l'iscrizione push è già
 *    per-endpoint, e le impostazioni la seguono. Il telefono e il Mac dicono
 *    cose diverse, e ognuno vede sé stesso marcato.
 *  · «ad app aperta» con due valori veri: la notifica di sistema (default,
 *    quello che l'utente ha chiesto) oppure il banner dentro Topics. Mai
 *    entrambi — la voce è una.
 */
function PushDevices() {
  const tr = useT();
  const { status, subscribed, devices, loading, subscribe, unsubscribe, setDevicePrefs } = usePushNotifications();
  const thisDevice = devices.find((d) => d.isThisDevice);
  const others = devices.filter((d) => !d.isThisDevice);

  const tone = {
    on: 'text-app-text-muted',
    off: 'text-amber-500',
    blocked: 'text-red-400',
    unavailable: 'text-app-text-muted',
  }[status.health];

  return (
    <div className="space-y-3" data-testid="settings-push-devices">
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Smartphone size={14} />
          {tr('notif.push.title')}
        </label>
        <p className="text-[12px] leading-snug text-app-text-muted">
          {tr('notif.push.blurb')}
        </p>
      </div>

      <div className="flex items-start gap-2 text-[11.5px]" data-testid="push-status">
        {status.health === 'on' ? (
          <Check size={13} className={`shrink-0 mt-px ${tone}`} />
        ) : (
          <AlertCircle size={13} className={`shrink-0 mt-px ${tone}`} />
        )}
        <div className="min-w-0">
          <div className={tone} data-testid="push-status-headline">{status.headline}</div>
          {status.hint && <div className="text-app-text-muted mt-0.5">{status.hint}</div>}
        </div>
      </div>

      {/* Il bottone esiste SOLO quando premerlo fa davvero qualcosa. Con il
          permesso negato non c'è nessun interruttore da mostrare: la riga di
          stato qui sopra dice dove si rimedia, e non è qui. */}
      {status.canSubscribe && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void subscribe()}
          data-testid="push-subscribe"
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {tr('notif.push.enableHere')}
        </button>
      )}

      {subscribed && thisDevice && (
        <div className="space-y-2">
          <ToggleRow
            label="Ricevi su questo dispositivo"
            description="Spegnere qui non tocca gli altri dispositivi."
            value={thisDevice.enabled}
            onChange={(v) => void setDevicePrefs(thisDevice.deviceId!, { enabled: v })}
          />
          <div>
            <div className="text-[12px] text-app-text mb-1">{tr('notif.push.whenOpen')}</div>
            <div className="flex gap-1.5" data-testid="push-when-open">
              {([
                ['native', 'Notifica di sistema'],
                ['in-app', 'Banner in Topics'],
              ] as [PushWhenOpen, string][]).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`push-when-open-${value}`}
                  aria-pressed={thisDevice.whenOpen === value}
                  onClick={() => void setDevicePrefs(thisDevice.deviceId!, { whenOpen: value })}
                  className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${
                    thisDevice.whenOpen === value
                      ? 'border-app-border bg-app-hover text-app-text'
                      : 'border-app-border text-app-text-muted hover:bg-app-hover'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-app-text-muted">
              {tr('notif.push.oneVoice')}
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void unsubscribe()}
            data-testid="push-unsubscribe"
            className="text-[11.5px] text-app-text-muted underline underline-offset-2 hover:text-app-text disabled:opacity-50"
          >
            {tr('notif.push.unsubscribe')}
          </button>
        </div>
      )}

      {others.length > 0 && (
        <div className="space-y-1">
          <div className="text-[12px] text-app-text">{tr('notif.push.others')}</div>
          <ul className="space-y-1">
            {others.map((d) => (
              <li
                key={d.deviceId ?? d.label}
                data-testid={`push-device-${d.deviceId ?? 'legacy'}`}
                className="flex items-center gap-2 rounded-md border border-app-border px-2.5 py-2"
              >
                <Smartphone size={14} className="shrink-0 text-app-text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-app-text">{d.label}</div>
                  <div className="truncate text-[10.5px] text-app-text-muted">
                    {d.enabled ? 'riceve le notifiche' : 'spento'}
                  </div>
                </div>
                {d.deviceId && (
                  <button
                    type="button"
                    onClick={() => void setDevicePrefs(d.deviceId!, { enabled: !d.enabled })}
                    title={d.enabled ? tr('notif.push.offHere') : tr('notif.push.onHere')}
                    className="shrink-0 rounded p-1.5 text-app-text-muted transition-colors hover:bg-app-hover hover:text-app-text"
                  >
                    {d.enabled ? <BellOff size={13} /> : <Bell size={13} />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Notifications settings — covers the in-window toast + native desktop
 * notification pair, plus le notifiche ad app chiusa (Web Push) per dispositivo
 * — vedi `PushDevices` qui sopra.
 */
export function NotificationsSection({ settings, onChange }: NotificationsSectionProps) {
  const tr = useT();
  const masterOn = settings.notificationsEnabled;
  return (
    <div className="space-y-5">
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Bell size={14} />
          Topic completion notifications
        </label>
        <p className="text-[12px] text-app-text-muted mb-2">
          {tr('notif.topic.blurb')}
        </p>

        <NativeBannerStatus />
        <FocusGateStatus />

        <ToggleRow
          label="Enable notifications"
          description="Master switch for both toast and desktop notifications."
          value={masterOn}
          onChange={(v) => onChange('notificationsEnabled', v)}
        />

        <div className={masterOn ? '' : 'opacity-50 pointer-events-none'}>
          <ToggleRow
            label="Play sound"
            description="Short tone when an agent completes."
            value={settings.notificationsSound}
            onChange={(v) => onChange('notificationsSound', v)}
          />
          <ToggleRow
            label="Notify even when topic is focused"
            description="Useful when you keep multiple topics open in parallel."
            value={settings.notifyEvenWhenFocused}
            onChange={(v) => onChange('notifyEvenWhenFocused', v)}
          />
        </div>
      </div>

      {/* Le notifiche ad app CHIUSA sono un canale a sé — per dispositivo, non
          per account — e stanno dopo gli interruttori generali perché è lì che
          si va a cercarle: prima «come mi avvisi», poi «dove». */}
      <PushDevices />

      {/* Le eccezioni vanno DOPO gli interruttori: prima la regola generale,
          poi chi ne è escluso. */}
      <MutedProjects settings={settings} onChange={onChange} />
    </div>
  );
}
