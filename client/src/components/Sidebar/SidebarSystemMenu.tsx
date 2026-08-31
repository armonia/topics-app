import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, Gauge, RefreshCw, RotateCcw, Tag } from 'lucide-react';
import { getVersion, relaunch, reloadAllWindows } from '@/lib/shell/app';
import { isDesktop } from '@/lib/shell';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useFpsActive } from '@/lib/fpsMonitor';
import { useCarico } from '@/state/systemLoad';
import { useT } from '@/hooks/useT';
import { PerfSection } from './PerfSection';
import { VersionChip } from './VersionChip';
import { VersionPopover } from './VersionPopover';
import { bundleDrift } from './bundleDrift';
import { tintaCarico } from './loadTint';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_SHA__: string;

/**
 * WHAT USED TO BE THE STRIP AT THE FOOT OF THE COLUMN, now inside the «Topics»
 * menu, on every screen.
 *
 * It arrived here on the phone first, and for a local reason: down there the
 * band cost 80px of a tall narrow column to say "This computer" to somebody
 * holding the computer. It stays for a better one. Memory, CPU, frame rate and
 * a version number are things you go and LOOK UP, two or three times a week,
 * usually because you already suspect something. They were spending a
 * permanent row of the column, in eleven-pixel digits, to be available for a
 * question nobody asks per hour. The menu is exactly where a rarely asked
 * question belongs, and it has room to answer it properly instead of in an
 * abbreviation.
 *
 * WHAT DID NOT COME WITH THEM. The alarms stayed at the foot of the column,
 * where they can be seen without opening anything: the websocket that is not
 * connected, the "cached data" notice, the shell's degraded boot. Statistics
 * live behind a gesture, alarms cannot. See `SidebarStatusBar`.
 *
 * AND WHAT STAYED IN SIGHT IN THEIR PLACE: a dot next to the word «Topics»,
 * whose colour is the load (`TopicsLoadDot`). The numbers answer "how much";
 * the dot answers "is it fine", and only the second question gets asked all
 * day. This menu shows both: the dot's own colour rides on the first row, so
 * opening the menu after noticing a hot dot lands on the row that explains it.
 *
 * ── CHI SEI NON STA QUI ────────────────────────────────────────────────────
 * L'account ci e' passato per due giorni, in testa al menu. Era comunque dietro
 * un gesto e il profilo non e' una voce di menu, e' una faccia: sul telefono e'
 * la quarta porta della fila in fondo allo schermo (`MobileChromeBar`), sul
 * desktop e' la prima pastiglia della fascia in fondo alla colonna
 * (`IdentityBlock`). Qui NON resta un duplicato: due porte per la stessa stanza
 * sono due posti che un giorno dicono cose diverse.
 */

const importSystemStatusPanel = async () => {
  const { SystemStatusPanel: Component } = await import('./SystemStatusPanel');
  return { default: Component };
};
const SystemStatusPanel = lazy(importSystemStatusPanel);

/** A row of this menu. The two sizes are the finger and the mouse, and the
 *  predicate is the same one the header uses: a `md:` breakpoint here would be
 *  a second mechanism deciding the same thing, and two mechanisms in one row
 *  diverge. */
function voce(isMobile: boolean): string {
  return 'w-full flex items-center gap-2.5 px-3 text-app-text hover:bg-app-hover transition-colors '
    + (isMobile ? 'py-3 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]');
}

export interface SidebarSystemMenuProps {
  /** Apre il changelog. La versione viaggia col gesto perché la modale la
   *  chiede e qui la si conosce già: farla ri-cercare a chi ospita la modale
   *  sarebbe un secondo modo di rispondere a «che versione gira», e i due
   *  divergono il giorno di un auto-update. */
  onOpenChangelog: (versione: string) => void;
  /** The finger or the mouse. Passed in rather than measured here: the header
   *  that owns this menu has already decided, and deciding twice is how the
   *  trigger and its panel end up sized for two different hands. */
  isMobile?: boolean;
}

export function SidebarSystemMenu({ onOpenChangelog, isMobile = false }: SidebarSystemMenuProps) {
  const tr = useT();
  const [mostraStato, setMostraStato] = useState(false);
  const [versioneGuscio, setVersioneGuscio] = useState('');
  const [versioneServer, setVersioneServer] = useState('');
  const [ancora, setAncora] = useState<HTMLButtonElement | null>(null);
  const [mostraVersione, setMostraVersione] = useState(false);
  const [riavviando, setRiavviando] = useState(false);
  const carico = useCarico();
  const { updateAvailable } = useServiceWorkerUpdate();
  // Only while the menu is open, which is the only time this component exists:
  // the panel is mounted by the portal on demand, so this poll starts and stops
  // with the gesture instead of running all day for a row nobody is reading.
  const { status } = useSystemStatus(true, 60000);

  // The frame counter goes to its live cadence only while the panel below is
  // open, exactly as it did in the bar's dropdown: a sparkline nobody is
  // looking at does not deserve a sample per second.
  useFpsActive(mostraStato);

  // Nell'app desktop la versione la sa la shell, e un auto-update può averla
  // cambiata dopo la build di questo bundle: si chiede, e si ripiega su quella
  // compilata solo se non risponde.
  useEffect(() => {
    let vivo = true;
    void getVersion().then((v) => { if (vivo && v) setVersioneGuscio(v); }).catch(() => {});
    // `/api/version` re-reads package.json, so it is the truth right after a
    // bump, while the baked constant is frozen at build time. The chip follows
    // the CLIENT, which is what a deploy moves.
    void fetch('/api/version', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { version?: string } | null) => { if (vivo && d?.version) setVersioneServer(d.version); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // DERIVED, not synchronised. The server answer wins when it arrives and the
  // constant baked at build time holds until then. Keeping this in a state that
  // an effect copied over meant two sources for one number, and the effect that
  // copied them is exactly what `react-hooks/set-state-in-effect` forbids.
  const versione = versioneServer || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');

  const isDev = import.meta.env.DEV;
  const drift = bundleDrift(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '', versioneServer, { hmr: isDev });
  // A development INSTALL is a fact about the machine, not about the build:
  // the desktop app always runs a built bundle, so `isDev` alone would answer
  // "no" on the very machine that rebuilds Topics all day.
  const devInstall = isDev || !!status?.server?.devReload;

  const riavvia = async () => {
    setRiavviando(true);
    if (isDesktop) {
      try { await relaunch(); return; } catch { /* fall through to the web path */ }
    }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.update();
        if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      }
    } catch { /* a cache that will not clear is not a reason to skip the reload */ }
    void reloadAllWindows();
  };

  const VOCE = voce(isMobile);
  const glifo = isMobile ? 18 : 14;

  return (
    <div data-testid="sidebar-system-menu">
      <button
        type="button"
        onClick={() => setMostraStato((v) => !v)}
        className={VOCE}
        aria-expanded={mostraStato}
        data-testid="menu-system-status"
      >
        <Gauge size={glifo} className="flex-shrink-0" />
        <span className="flex-1 text-left">Prestazioni e sistema</span>
        {/* THE HEADLINE THE STRIP USED TO SHOW, and the dot's own colour with
            it. One number for memory and one for CPU: the halves, the metric
            and the inventory are in the panel below, which is what "open" now
            means. */}
        {carico && (
          <span data-testid="menu-load-summary" className="flex flex-shrink-0 items-center gap-1.5 text-app-text-secondary tabular-nums">
            {carico.misurato && (
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tintaCarico(carico.livello) }} />
            )}
            {carico.totalMB !== null && <span>{carico.parziale ? '~' : ''}{formatMB(carico.totalMB)}</span>}
            {carico.totalCpu !== null && <span>{Math.round(carico.totalCpu)}%</span>}
          </span>
        )}
        <ChevronRight size={isMobile ? 16 : 14} className={`flex-shrink-0 text-app-text-tertiary transition-transform ${mostraStato ? 'rotate-90' : ''}`} />
      </button>
      {mostraStato && (
        <div className="border-y border-app-border">
          <PerfSection />
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
            <SystemStatusPanel enabled />
          </Suspense>
        </div>
      )}

      {/* THE VERSION IS A ROW AND NOT A BUTTON, because the number itself is
          already one: the chip carries its own popover, its drift dot and the
          "dev install" badge, and a button wrapping a button is invalid HTML
          the browser takes apart on its own. */}
      <div className={`${VOCE} cursor-default`} data-testid="menu-version">
        <Tag size={glifo} className="flex-shrink-0" />
        <span className="flex-1 text-left">Versione</span>
        <span className="flex flex-shrink-0 items-center gap-1.5 text-[12px] tabular-nums">
          <VersionChip
            appVersion={versione}
            shellVersion={versioneGuscio}
            drift={drift}
            devInstall={devInstall}
            desktop={isDesktop}
            popoverOpen={mostraVersione}
            onOpen={(anchor) => { setAncora(anchor); setMostraVersione((v) => !v); }}
          />
        </span>
      </div>

      {/* RESTART, and it says which of the two things it does. On the desktop
          it replaces the process (the way an update lands); in a browser it
          clears the caches and reloads. Same intention, two machines. */}
      <button
        type="button"
        onClick={riavvia}
        disabled={riavviando}
        className={`${VOCE} ${updateAvailable ? 'text-primary' : ''}`}
        data-testid="menu-restart"
      >
        {isDesktop
          ? <RotateCcw size={glifo} className={`flex-shrink-0 ${riavviando ? 'animate-spin' : ''}`} />
          : <RefreshCw size={glifo} className={`flex-shrink-0 ${riavviando ? 'animate-spin' : ''}`} />}
        <span className="flex-1 text-left">
          {isDesktop ? tr('statusBar.restartApp') : updateAvailable ? tr('statusBar.updateAvailable') : tr('statusBar.reload')}
        </span>
      </button>

      {mostraVersione && (
        <VersionPopover
          anchorEl={ancora}
          appVersion={versione}
          shellVersion={versioneGuscio}
          drift={drift}
          isDev={isDev}
          buildDate={typeof __BUILD_TIME__ !== 'undefined' && __BUILD_TIME__ ? formatBuildDate(__BUILD_TIME__) : ''}
          buildSha={typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : ''}
          onClose={() => setMostraVersione(false)}
          onOpenChangelog={() => { setMostraVersione(false); onOpenChangelog(versione); }}
        />
      )}
    </div>
  );
}

/** Gigabytes past a thousand: the row has one line and four digits of memory
 *  would be read as a phone number. */
function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}

function formatBuildDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}
