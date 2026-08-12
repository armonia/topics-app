import { useState, useEffect } from 'react';
import { Bell, BellOff, Check, AlertCircle, Moon } from 'lucide-react';
import type { AppSettings } from '../../types';
import { notificationStatus, type NativeNotificationStatus } from '../../lib/shell/app';
import { describeNativeNotifications } from '../../lib/notificationStatus';
import { focusGateState, FULL_DISK_ACCESS_URL, type FocusGateState } from '../../lib/shell/focus';
import { openExternalOnce } from '../../lib/openExternal';
import { ToggleRow } from './ToggleRow';

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
        Non riusciamo a leggere lo stato del Focus / Non disturbare, quindi i
        banner arrivano anche mentre è attivo: su macOS quel dato è protetto.{' '}
        <button
          onClick={() => openExternalOnce(FULL_DISK_ACCESS_URL)}
          className="underline underline-offset-2 hover:text-app-text transition-colors"
        >Concedi l'accesso completo al disco</button>
        , poi riavvia Topics: il permesso si legge all'avvio del processo.
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
  const muted = settings.mutedProjects ?? [];
  if (muted.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="settings-muted-projects">
      <div>
        <h3 className="text-[13px] font-medium text-app-text mb-1">Silenziati</h3>
        <p className="text-[12px] leading-snug text-app-text-muted">
          Questi progetti non fanno arrivare banner né suono quando un agente
          finisce. Contano lo stesso nel badge dell'app: a sparire è
          l'interruzione, non il conteggio.
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
              title="Riattiva le notifiche per questo progetto"
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
 * Notifications settings — covers the in-window toast + native desktop
 * notification pair. Web Push (other devices) is intentionally NOT exposed:
 * per product decision, completion alerts are scoped to the desktop client.
 *
 * Web Push notifications were intentionally removed from the UI: the push
 * subscription infrastructure (`usePushNotifications`, `/api/push/*`) is left
 * in place so a future "notify me on other devices" toggle can wire back into
 * it without redoing the server side.
 */
export function NotificationsSection({ settings, onChange }: NotificationsSectionProps) {
  const masterOn = settings.notificationsEnabled;
  return (
    <div className="space-y-5">
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Bell size={14} />
          Topic completion notifications
        </label>
        <p className="text-[12px] text-app-text-muted mb-2">
          Toast in finestra quando un agente finisce (o va in errore) su un
          topic. Il banner di sistema si aggiunge solo se il sistema operativo
          lo consente. Qui sotto c'è lo stato reale.
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

      {/* Le eccezioni vanno DOPO gli interruttori: prima la regola generale,
          poi chi ne è escluso. */}
      <MutedProjects settings={settings} onChange={onChange} />
    </div>
  );
}
