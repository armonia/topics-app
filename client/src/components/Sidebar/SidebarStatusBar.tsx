import { useEffect, useState } from 'react';
import { IdentityBlock } from './IdentityBlock';
import { SEGNALE_ATTESA, SEGNALE_GUASTO, PALLINO_ATTESA, PALLINO_GUASTO } from './chromeSignals';
import type { ConnectionStatus } from '@/types';
import { ROW_INSET } from '@/lib/selectionStyles';
import { clearBootDegraded, degradedNotice, fetchBootDegraded, type BootDegraded } from '@/lib/shell/bootDegraded';
import { useMobile } from '@/hooks/useMobile';
import { useT } from '@/hooks/useT';

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
 * GLI ALLARMI DEL TRASPORTO, DA SOLI: il websocket che non e' connesso, l'avviso
 * «dati dalla cache», l'avvio degradato del guscio con la sua via d'uscita.
 *
 * Stanno in un componente PROPRIO, staccati dalla fascia dell'identita', perche'
 * le due meta' di questa barra hanno pubblico diverso. `App` montava tutto
 * dentro `{!isMobile && (…)}`, e queste righe erano le UNICHE superfici in tutto
 * `client/src` che nominano lo stato della connessione: sul TELEFONO — cioe' sul
 * dispositivo che la rete la perde davvero, in ascensore o in metropolitana —
 * non esisteva nessun elemento che dicesse «Offline» o «Reconnecting…». Restava
 * il pallino nell'header del cassetto, che a cassetto chiuso e' largo zero e
 * fuori schermo: un allarme che per vedersi chiede un gesto non e' un allarme.
 * Lo spec SIDEBAR-STATUS-01 dice «un ALLARME non e' una statistica», e i suoi
 * scenari cominciano tutti con «GIVEN un desktop».
 *
 * L'identita' invece resta desktop-only e non e' una svista: e' una fascia con
 * un contratto RESPONSIVE sulle larghezze della colonna, e sul telefono la
 * stessa risposta ce l'ha gia' la quarta porta della fila in fondo.
 */
export function TransportAlarms({ wsStatus, dataNotice, inset }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
  /** Il rientro laterale delle righe. Nella colonna e' quello delle righe di
   *  sidebar; nella banda del telefono lo detta la fascia di sicurezza. */
  inset?: { left: string; right: string };
}) {
  const tr = useT();
  const { isMobile } = useMobile();
  const padLeft = inset?.left ?? ROW_INSET;
  const padRight = inset?.right ?? ROW_INSET;

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

export function SidebarStatusBar({ wsStatus, dataNotice, onOpenDevices }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
  onOpenDevices?: () => void;
} = {}) {
  return (
    <>
      {/* Le stesse righe che sul telefono vivono nella banda in fondo
          (`MobileTransportBand`): un componente solo, montato in due posti. */}
      <TransportAlarms wsStatus={wsStatus} dataNotice={dataNotice} />

      {/* ONLY THE HOME INDICATOR IS LEFT ON THIS WRAPPER. The bottom breathing
          room itself belongs to the band and is written on the band
          (`IdentityBlock`, `paddingBottom: ROW_INSET`), because a wrapper's
          padding STACKS on the child's: this div used to add ROW_INSET under a
          block that already had `pb-1`, and the foot ended up 10px deep against
          6px at the sides — measured 2026-08-31. */}
      <div style={{ paddingBottom: 'var(--sab, 0px)' }}>
        <IdentityBlock onOpenDevices={onOpenDevices} />
      </div>
    </>
  );
}

/**
 * LA BANDA DEL TELEFONO: la stessa frase, dove il telefono la puo' vedere.
 *
 * Sta SOPRA la fila in fondo e non dentro la colonna, per la stessa ragione per
 * cui ci sta la fila (`MobileChromeBar`): la colonna sul telefono e' un cassetto,
 * e un allarme che si vede solo aprendo il cassetto e' un allarme che non si
 * vede. Fissa in fondo, alzata di `--mobile-chrome-h` — la stessa variabile che
 * la fila pubblica, quindi la banda la segue da se' quando la fila sparisce con
 * la tastiera aperta, senza un secondo conto della stessa altezza.
 *
 * ESISTE SOLO QUANDO C'E' QUALCOSA DA DIRE: connessa e senza avvisi, qui non
 * c'e' nessun elemento. Non e' una barra di stato permanente, e' un allarme, e
 * per questo non riserva nessuna banda alla radice — se la riservasse, il caso
 * normale (tutto a posto) pagherebbe lo spazio del caso eccezionale.
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
      // Sotto la fila (`zIndex: 60`) di proposito: la fila e' come si esce da
      // qui, e nessun avviso deve poterla coprire.
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
