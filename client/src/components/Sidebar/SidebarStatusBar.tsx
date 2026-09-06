import { useEffect, useState } from 'react';
import { IdentityBlock } from './IdentityBlock';
import type { SidebarCommands } from './ProfileMenu';
import { SEGNALE_ATTESA, SEGNALE_GUASTO, SEGNALE_OK, PALLINO_ATTESA, PALLINO_GUASTO, PALLINO_OK } from './chromeSignals';
import type { ConnectionStatus } from '@/types';
import { ROW_INSET } from '@/lib/selectionStyles';
import { clearBootDegraded, degradedNotice, fetchBootDegraded, type BootDegraded } from '@/lib/shell/bootDegraded';
import { useMobile } from '@/hooks/useMobile';
import { useT } from '@/hooks/useT';
import { useProviderHold } from '@/state/providerHold';
import { usePlanUsage } from '@/state/planUsage';
import { PLAN_DISPATCH_HOLD_AT, PLAN_USAGE_WARN_AT } from '../../../../shared/provider-hold';

/**
 * IL FONDO DELLA COLONNA: chi sei, e cosa non va.
 *
 * Qui c'era una striscia densa di cifre — memoria, CPU, fotogrammi, versione,
 * un bottone di riavvio — larga quanto la colonna e alta ventotto pixel. Non
 * c'e' piu': quelle sono statistiche, cioe' cose che si vanno a GUARDARE due
 * volte a settimana, e adesso sono tre righe col chevron dentro il menu
 * «Topics» (`SidebarSystemMenu`), le stesse su desktop e su telefono. Prima
 * erano due implementazioni della stessa risposta, una per schermo.
 *
 * QUELLO CHE NON PUO' STARE DIETRO UN GESTO E' RIMASTO QUI. Un allarme si deve
 * vedere senza aprire niente: il websocket che non e' connesso, l'avviso «dati
 * dalla cache», l'avvio degradato del guscio con la sua via d'uscita. Le
 * statistiche vivono dietro un gesto, gli allarmi no. Accanto alla parola
 * «Topics» c'e' anche un pallino che pulsa quando ce n'e' uno (`TopicsLoadDot`),
 * cosi' il menu si apre gia' sapendo perche'.
 *
 * E LA FASCIA DELL'IDENTITA', che e' l'altra meta' e non se n'e' mai andata:
 * chi sei, le organizzazioni, le persone intorno. Il 07/08 la barra era gia'
 * tornata quaggiu' proprio per questo — «dove sono finiti gli account?» — e
 * spostarla di nuovo per portare via le cifre sarebbe stato uno scambio, non
 * una cura.
 */
/**
 * THE TRANSPORT ALARMS, ON THEIR OWN: the websocket that is not connected, the
 * «cached data» notice, the shell's degraded boot with its way out.
 *
 * They live in a component of THEIR OWN, split from the identity band, because
 * the two halves of this bar have different audiences. `App` used to mount the
 * whole thing inside `{!isMobile && (…)}`, and these rows were the ONLY
 * surfaces in all of `client/src` that name the connection state: on the PHONE
 * — the device that actually loses the network, in a lift or underground —
 * there was no element saying «Offline» or «Reconnecting…» at all. What was
 * left was the dot in the drawer header, which with the drawer closed is zero
 * wide and off screen: an alarm that needs a gesture to be seen is not an
 * alarm. Spec SIDEBAR-STATUS-01 says «an ALARM is not a statistic», and every
 * one of its scenarios used to start with «GIVEN a desktop».
 *
 * The identity stays desktop-only, and that is not an oversight: it is a band
 * with a RESPONSIVE contract on the column widths, and on the phone the same
 * question is already answered by the fourth door of the bottom row.
 */
export function TransportAlarms({ wsStatus, dataNotice, inset }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
  /** The side inset of the rows. In the column it is the sidebar row inset; in
   *  the phone band it is dictated by the safe area. */
  inset?: { left: string; right: string };
}) {
  const tr = useT();
  const { isMobile } = useMobile();
  const padLeft = inset?.left ?? ROW_INSET;
  const padRight = inset?.right ?? ROW_INSET;
  // The plan's usage window is spent (server/lib/provider-hold.ts): every turn
  // would end on a 429 until the reset, so the server holds the fleet and the
  // resumes. Said here, once, for the whole app: 27 silent retries per chat
  // were how the person found out on 2026-09-04.
  const providerHold = useProviderHold();
  const planUsage = usePlanUsage();
  // The row appears only when the number would change what someone does. Below
  // the warning line it is true and useless (nobody stops at 12%), and once the
  // hold is in force the sentence above already says it, harder: two amber rows
  // about the same window read as two problems.
  const fiveHour = planUsage?.fiveHour ?? null;
  const planNotice = !providerHold && fiveHour && fiveHour.utilization >= PLAN_USAGE_WARN_AT ? fiveHour : null;

  /**
   * L'ATTESA MUTA, DETTA.
   *
   * E' il solo stato in cui «sto riconnettendo» e' una bugia per omissione:
   * non sta tornando su niente da solo, perche' il guscio aspetta un server che
   * questa macchina aveva e non ha piu'. La frase nomina la causa e stampa il
   * percorso completo del marcatore, che e' l'unica via d'uscita e vive in una
   * cartella dove non passa nessuno. Compare SOLO sul verdetto esplicito del
   * guscio (`bootDegraded.ts`): un riavvio normale resta il pallino ambra.
   */
  const [degraded, setDegraded] = useState<BootDegraded | null>(null);
  const [degradedFixFailed, setDegradedFixFailed] = useState(false);
  const connected = wsStatus === 'connected';
  useEffect(() => {
    if (degraded || connected) return;
    let alive = true;
    const ask = () => {
      void fetchBootDegraded().then((d) => {
        if (alive && d) setDegraded(d);
      });
    };
    ask();
    const t = window.setInterval(ask, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [degraded, connected]);
  const degradedLines = degradedNotice(degraded, wsStatus);

  return (
    <>
      {/* GLI ALLARMI STANNO SOPRA LA FASCIA, non sotto: compaiono e spariscono,
          e una riga che appare SOTTO qualcosa di permanente sposta in su cio'
          che stavi guardando. Sopra, spinge giu' se stessa. */}
      {degradedLines && (
        <div
          data-testid="boot-degraded-notice"
          className={`flex flex-col gap-0.5 pt-1 pb-1.5 text-[11px] leading-snug ${SEGNALE_ATTESA}`}
          style={{
            paddingLeft: inset?.left ?? (isMobile ? 'max(32px, var(--sal))' : ROW_INSET),
            paddingRight: inset?.right ?? (isMobile ? 'max(32px, var(--sar))' : ROW_INSET),
          }}
        >
          <span>{tr(degradedLines.whyKey, { port: degradedLines.port })}</span>
          <span>{tr(degradedLines.wayOutKey)}</span>
          <span className="font-mono text-app-text-secondary select-text break-all">
            {degradedLines.markerPath}
          </span>
          {/* THE WAY OUT, DONE. Printing an AppData path and asking the person to
              quit the app, find it in a file manager and delete it by hand is a
              way out only on paper — and it is asked on the machine where the app
              is the thing that stopped working. The button does exactly what the
              sentence describes; the path stays above it, because a shell too old
              for the command still has only that. */}
          <button
            type="button"
            data-testid="boot-degraded-fix"
            className="mt-1 self-start underline underline-offset-2 hover:no-underline"
            onClick={async () => {
              setDegradedFixFailed(false);
              await clearBootDegraded();
              // Reached only when nothing happened: a success never returns here.
              setDegradedFixFailed(true);
            }}
          >
            {tr('statusBar.degraded.fix')}
          </button>
          {degradedFixFailed && <span>{tr('statusBar.degraded.fixFailed')}</span>}
        </div>
      )}

      {/* WebSocket connection status. Only visible when NOT connected: offline =
          red, connecting/reconnecting = amber. The dot pulses; the label stays
          steady, because a moving word is unreadable. */}
      {wsStatus && wsStatus !== 'connected' && (
        <div style={{ paddingLeft: padLeft, paddingRight: padRight }}>
          <span
            data-testid="ws-connection-status"
            className={`flex items-center gap-1.5 text-[11px] min-w-0 overflow-hidden ${
              wsStatus === 'offline' ? SEGNALE_GUASTO : SEGNALE_ATTESA
            }`}
            title={tr('statusBar.wsTitle')}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 animate-pulse ${
              wsStatus === 'offline' ? PALLINO_GUASTO : PALLINO_ATTESA
            }`} />
            <span className="truncate">
              {wsStatus === 'connecting' ? 'Connecting…' : wsStatus === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
            </span>
          </span>
        </div>
      )}

      {wsStatus === 'connected' && providerHold && (
        <div style={{ paddingLeft: padLeft, paddingRight: padRight }}>
          <span
            data-testid="provider-hold-notice"
            className={`flex items-center gap-1.5 text-[11px] ${SEGNALE_ATTESA} min-w-0 overflow-hidden`}
            title={tr('statusBar.providerHold.title')}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PALLINO_ATTESA}`} />
            <span className="truncate">
              {tr(providerHold.window === 'seven_day' ? 'statusBar.providerHold.week' : 'statusBar.providerHold.fiveHours', {
                time: new Date(providerHold.untilMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
              })}
            </span>
          </span>
        </div>
      )}

      {wsStatus === 'connected' && planNotice && (
        <div style={{ paddingLeft: padLeft, paddingRight: padRight }}>
          <span
            data-testid="plan-usage-notice"
            className={`flex items-center gap-1.5 text-[11px] ${planNotice.utilization >= PLAN_DISPATCH_HOLD_AT ? SEGNALE_ATTESA : SEGNALE_OK} min-w-0 overflow-hidden`}
            title={tr('statusBar.planUsage.title')}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${planNotice.utilization >= PLAN_DISPATCH_HOLD_AT ? PALLINO_ATTESA : PALLINO_OK}`} />
            <span className="truncate">
              {tr('statusBar.planUsage.fiveHours', {
                pct: Math.round(planNotice.utilization),
                time: planNotice.resetsAtMs != null
                  ? new Date(planNotice.resetsAtMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                  : '--:--',
              })}
            </span>
          </span>
        </div>
      )}

      {/* Data-fetch notice (e.g. "Using cached data — server unreachable").
          Shown only when the WS IS connected: otherwise the line above already
          says it, and two amber rows for one outage read as two outages. */}
      {wsStatus === 'connected' && dataNotice && (
        <div style={{ paddingLeft: padLeft, paddingRight: padRight }}>
          <span
            data-testid="data-notice"
            className={`flex items-center gap-1.5 text-[11px] ${SEGNALE_ATTESA} min-w-0 overflow-hidden`}
            title={dataNotice}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PALLINO_ATTESA}`} />
            <span className="truncate">{dataNotice}</span>
          </span>
        </div>
      )}

    </>
  );
}

export function SidebarStatusBar({ wsStatus, dataNotice, onOpenDevices, commands }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
  onOpenDevices?: () => void;
  /** The commands of the column, on their way to the user card's menu: on the
   *  desktop that card is the only door of the chrome, so they travel through
   *  here rather than hanging off a dropdown at the top. */
  commands: SidebarCommands;
}) {
  return (
    <>
      {/* The very same rows that on the phone live in the bottom band
          (`MobileTransportBand`): one component, mounted in two places. */}
      <TransportAlarms wsStatus={wsStatus} dataNotice={dataNotice} />

      {/* ONLY THE HOME INDICATOR IS LEFT ON THIS WRAPPER. The bottom breathing
          room itself belongs to the band and is written on the band
          (`IdentityBlock`, `paddingBottom: ROW_INSET`), because a wrapper's
          padding STACKS on the child's: this div used to add ROW_INSET under a
          block that already had `pb-1`, and the foot ended up 10px deep against
          6px at the sides — measured 2026-08-31. */}
      <div style={{ paddingBottom: 'var(--sab, 0px)' }}>
        <IdentityBlock
          onOpenDevices={onOpenDevices}
          commands={commands}
          // The alarm the title dot used to carry. It rides on the card's dot
          // now, because the title is no longer a control: same rule as before,
          // one dot, and the alarm outranks the load tint on it.
          alarm={(wsStatus !== undefined && wsStatus !== 'connected') || !!dataNotice}
        />
      </div>
    </>
  );
}

/**
 * THE PHONE BAND: the same sentence, where the phone can actually see it.
 *
 * It sits ABOVE the bottom row and not inside the column, for the same reason
 * the row itself does (`MobileChromeBar`): on the phone the column is a drawer,
 * and an alarm you only see by opening the drawer is an alarm you do not see.
 * Fixed to the bottom, lifted by `--mobile-chrome-h` — the very variable the
 * row publishes, so the band follows it by itself when the row disappears with
 * the keyboard open, without a second computation of the same height.
 *
 * IT ONLY EXISTS WHEN THERE IS SOMETHING TO SAY: connected and with no notice,
 * there is no element here at all. This is not a permanent status bar, it is an
 * alarm, which is why it reserves no band on the root: reserving one would make
 * the normal case (all well) pay the space of the exceptional one.
 */
export function MobileTransportBand({ wsStatus, dataNotice }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
}) {
  const somethingToSay = (wsStatus && wsStatus !== 'connected') || (wsStatus === 'connected' && !!dataNotice);
  if (!somethingToSay) return null;
  return (
    <div
      data-testid="mobile-transport-band"
      // Below the row (`zIndex: 60`) on purpose: the row is how you get out of
      // here, and no notice may be allowed to cover it.
      className="fixed left-0 right-0 py-1 bg-app-chrome border-t border-app-border"
      style={{ zIndex: 59, bottom: 'var(--mobile-chrome-h, 0px)' }}
    >
      <TransportAlarms
        wsStatus={wsStatus}
        dataNotice={dataNotice}
        inset={{ left: 'max(12px, var(--sal))', right: 'max(12px, var(--sar))' }}
      />
    </div>
  );
}
