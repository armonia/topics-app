import { useState, useEffect } from 'react';
import { Bell, Check, AlertCircle } from 'lucide-react';
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
 * Il gate Focus/Non disturbare, e cosa fare quando è spento.
 *
 * Su macOS 26 il gate legge lo stato del Focus da `~/Library/DoNotDisturb/DB/`,
 * che è protetto da TCC: senza Full Disk Access la lettura fallisce, il gate
 * resta trasparente (default sicuro — si notifica sempre) e l'utente riceve
 * banner durante un Focus **senza sapere perché**. La funzione sembra
 * semplicemente non esistere.
 *
 * Qui la si nomina e si offre l'unica azione utile. Il bottone apre il pannello
 * di sistema: concedere il permesso è un gesto che deve restare dell'utente,
 * l'app può solo portarcelo davanti.
 *
 * Tre stati, tre risposte diverse: fuori dal guscio nativo non si disegna nulla
 * (non c'è niente da concedere), in attesa nemmeno (una diagnosi che poi si
 * smentisce è peggio del nulla), e solo `blocked` merita l'avviso.
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

  if (state === 'unavailable' || state === 'pending') return null;

  if (state === 'active') {
    return (
      <div className="flex items-start gap-2 mb-3 text-[11.5px]">
        <Check size={13} className="shrink-0 mt-px text-app-text-muted" />
        <div className="text-app-text-muted">
          Focus / Non disturbare: i banner restano zitti mentre è attivo.
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 mb-3 text-[11.5px]">
      <AlertCircle size={13} className="shrink-0 mt-px text-amber-500" />
      <div className="min-w-0">
        <div className="text-amber-500">Focus / Non disturbare: non lo vediamo</div>
        <div className="text-app-text-muted mt-0.5">
          Topics non riesce a leggere lo stato del Focus, quindi i banner arrivano
          anche mentre è attivo. Su macOS quel dato è protetto e serve concedere
          l'accesso completo al disco.
        </div>
        <button
          onClick={() => openExternalOnce(FULL_DISK_ACCESS_URL)}
          className="mt-1.5 rounded bg-white/10 px-2 py-1 text-[11px] text-app-text hover:bg-white/20"
        >Apri Accesso completo al disco</button>
        <div className="text-app-text-muted mt-1">
          Dopo averlo concesso serve riavviare Topics: il permesso si legge
          all'avvio del processo.
        </div>
      </div>
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
          lo consente — qui sotto c'è lo stato reale.
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
    </div>
  );
}
