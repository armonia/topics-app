import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ChevronRight, Gauge, RefreshCw, RotateCcw, Tag } from 'lucide-react';
import { getVersion, relaunch, reloadAllWindows } from '@/lib/shell/app';
import { isDesktop } from '@/lib/shell';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { usePerfMetrics } from '@/hooks/usePerfMetrics';
import { useFps, useFpsActive } from '@/lib/fpsMonitor';
import { useFeatureWeights } from '@/hooks/useFeatureWeights';
import { bloccoTooltip } from '@/lib/featureWeightText';
import { ensurePaneUsageFresh, webviewSnapshot } from '@/lib/paneUsage';
import { composeUsageTooltip, wantsResidentLine } from './usageTooltip';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';

import { useLoad } from '@/state/systemLoad';
import { useT } from '@/hooks/useT';
import { PerfSection } from './PerfSection';
import { VersionChip } from './VersionChip';
import { VersionPopover } from './VersionPopover';
import { bundleDrift } from './bundleDrift';
import { loadTint } from './loadTint';

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

// WHEN THE CODE LAST CHANGED, so the chip can say whether YOUR change landed.
// It followed the version chip here from the strip at the foot of the column.
// In dev it tracks Vite's HMR socket (any module, not just this one); in the
// desktop app `import.meta.env.DEV` is false even while you are working on it,
// so there the build timestamp is the only signal a local `vite build` landed,
// and that is exactly the question the chip answers.
let lastUpdateTime = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : new Date().toISOString();
if (import.meta.env.DEV) {
  lastUpdateTime = new Date().toISOString();
  try {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}`, 'vite-hmr');
    socket.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'update') {
          lastUpdateTime = new Date().toISOString();
          window.dispatchEvent(new CustomEvent('hmr-update'));
        }
      } catch { /* a frame we do not understand is not a code change */ }
    });
  } catch { /* no dev server to listen to */ }
}

function useLastChangeTime(): string {
  const [time, setTime] = useState(lastUpdateTime);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handler = () => setTime(new Date().toISOString());
    window.addEventListener('hmr-update', handler);
    return () => window.removeEventListener('hmr-update', handler);
  }, []);
  return time;
}

/** How long ago, in one or two characters: the chip has room for that much. */
function formatChangeAge(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    return `${Math.floor(diffH / 24)}d`;
  } catch { return iso; }
}

const importSystemStatusPanel = async () => {
  const { SystemStatusPanel: Component } = await import('./SystemStatusPanel');
  return { default: Component };
};
const SystemStatusPanel = lazy(importSystemStatusPanel);

/** A row of this menu. The two sizes are the finger and the mouse, and the
 *  predicate is the same one the header uses: a `md:` breakpoint here would be
 *  a second mechanism deciding the same thing, and two mechanisms in one row
 *  diverge. */
function item(isMobile: boolean): string {
  return 'w-full flex items-center gap-2.5 px-3 text-app-text hover:bg-app-hover transition-colors '
    + (isMobile ? 'py-3 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]');
}

export interface SidebarSystemMenuProps {
  /** Apre il changelog. La versione viaggia col gesto perché la modale la
   *  chiede e qui la si conosce già: farla ri-cercare a chi ospita la modale
   *  sarebbe un secondo modo di rispondere a «che versione gira», e i due
   *  divergono il giorno di un auto-update. */
  onOpenChangelog: (version: string) => void;
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
  const load = useLoad();
  const lastChange = useLastChangeTime();
  const { updateAvailable } = useServiceWorkerUpdate();
  // Only while the menu is open, which is the only time this component exists:
  // the panel is mounted by the portal on demand, so this poll starts and stops
  // with the gesture instead of running all day for a row nobody is reading.
  const { status, refresh: refreshStatus } = useSystemStatus(true, 60000);

  // THE HEADLINE'S OWN EXPLANATION, on the headline. The dense strip at the
  // foot of the column carried both and is gone; the number is this row now,
  // so the paragraph that says what holds it belongs to this row too. Both
  // polls start and stop with the menu, which is the only time anybody is
  // reading them.
  const perf = usePerfMetrics(true, 5000);
  const fps = useFps();
  // THE INVENTORY IS COLLECTED ONLY WITH THE POINTER ON IT (RES-ATTR-04):
  // listing it means serialising half the app's state, and doing that every
  // five seconds for a text nobody is reading is work at rest. The same
  // gesture asks for a fresh sample, because a minute-old one without the
  // fleet would list the held entries alone — the inventory without the half
  // that weighs.
  const [inventoryAsked, setInventarioChiesto] = useState(false);
  const showInventory = useCallback(() => {
    setInventarioChiesto(true);
    ensurePaneUsageFresh();
    void refreshStatus();
  }, [refreshStatus]);
  const weightEntries = useFeatureWeights(inventoryAsked, {
    sessioni: status?.server.fleet?.sessions ?? [],
    browser: webviewSnapshot(),
    radici: status?.server.fleet?.roots ?? [],
    scriptsMB: status?.server.fleet?.scriptsMB ?? 0,
    scriptsProcessCount: status?.server.fleet?.scriptsProcessCount ?? 0,
  }, status?.timestamp);
  const usageTitle = composeUsageTooltip({
    isMobile,
    perf,
    status,
    fps,
    residentLine: wantsResidentLine(perf, status)
      ? tr('statusBar.residenteInline', { mb: perf?.memory?.residentMB ?? 0 })
      : null,
    inventory: bloccoTooltip(weightEntries),
  });

  // THE POPOVER HAS TO SAY IT IS OPEN. `UpdaterToast` listens for this and
  // suppresses itself while it is: the popover anchors to the same version chip
  // and carries the whole check/download/install flow, so both showing stacked
  // two update cards on top of each other, live on 2026-07-11:
  // «due modali una nell'altra». allow-italian: the report is quoted verbatim.
  // The event used to be dispatched by the strip at
  // the foot of the column; the strip is gone and this menu is now the only
  // host of that popover, on every screen, so it is the one that has to say it.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('topics:version-popover', { detail: { open: mostraVersione } }));
    return () => {
      if (mostraVersione) {
        window.dispatchEvent(new CustomEvent('topics:version-popover', { detail: { open: false } }));
      }
    };
  }, [mostraVersione]);

  // The frame counter goes to its live cadence only while the panel below is
  // open, exactly as it did in the bar's dropdown: a sparkline nobody is
  // looking at does not deserve a sample per second.
  useFpsActive(mostraStato);

  // Nell'app desktop la versione la sa la shell, e un auto-update può averla
  // cambiata dopo la build di questo bundle: si chiede, e si ripiega su quella
  // compilata solo se non risponde.
  useEffect(() => {
    let alive = true;
    void getVersion().then((v) => { if (alive && v) setVersioneGuscio(v); }).catch(() => {});
    // `/api/version` re-reads package.json, so it is the truth right after a
    // bump, while the baked constant is frozen at build time. The chip follows
    // the CLIENT, which is what a deploy moves.
    void fetch('/api/version', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { version?: string } | null) => { if (alive && d?.version) setVersioneServer(d.version); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // DERIVED, not synchronised. The server answer wins when it arrives and the
  // constant baked at build time holds until then. Keeping this in a state that
  // an effect copied over meant two sources for one number, and the effect that
  // copied them is exactly what `react-hooks/set-state-in-effect` forbids.
  const version = versioneServer || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');

  const isDev = import.meta.env.DEV;
  const drift = bundleDrift(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '', versioneServer, { hmr: isDev });
  // A development INSTALL is a fact about the machine, not about the build:
  // the desktop app always runs a built bundle, so `isDev` alone would answer
  // "no" on the very machine that rebuilds Topics all day.
  const devInstall = isDev || !!status?.server?.devReload;

  const restart = async () => {
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

  const VOCE = item(isMobile);
  const glyph = isMobile ? 18 : 14;

  return (
    <div data-testid="sidebar-system-menu">
      <button
        type="button"
        onClick={() => setMostraStato((v) => !v)}
        className={VOCE}
        aria-expanded={mostraStato}
        data-testid="menu-system-status"
      >
        <Gauge size={glyph} className="flex-shrink-0" />
        <span className="flex-1 text-left">Prestazioni e sistema</span>
        {/* THE HEADLINE THE STRIP USED TO SHOW, and the dot's own colour with
            it. One number for memory and one for CPU: the halves, the metric
            and the inventory are in the panel below, which is what "open" now
            means. */}
        {/* ALWAYS RENDERED, numbers or not: this span is what carries the
            tooltip, and a host that appears only once a sample has landed is a
            tooltip that is missing exactly when somebody opens the menu to find
            out why nothing is being measured. `mouseenter`/`focus` rather than
            hover styling because it lives inside a <button>: the button is the
            thing that gets hovered, this is the thing that has to notice. */}
        <span
          data-testid="metrics-total"
          title={usageTitle}
          onMouseEnter={showInventory}
          onFocus={showInventory}
          className="flex flex-shrink-0 items-center gap-1.5 text-app-text-secondary tabular-nums"
        >
          {load?.misurato && (
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: loadTint(load.livello) }} />
          )}
          {load?.totalMB != null && <span>{load.partial ? '~' : ''}{formatMB(load.totalMB)}</span>}
          {load?.totalCpu != null && <span>{Math.round(load.totalCpu)}%</span>}
        </span>
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
        <Tag size={glyph} className="flex-shrink-0" />
        <span className="flex-1 text-left">Versione</span>
        <span className="flex flex-shrink-0 items-center gap-1.5 text-[12px] tabular-nums">
          <VersionChip
            appVersion={version}
            shellVersion={versioneGuscio}
            drift={drift}
            devInstall={devInstall}
            hmrAge={isDev && lastChange ? formatChangeAge(lastChange) : undefined}
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
        onClick={restart}
        disabled={riavviando}
        className={`${VOCE} ${updateAvailable ? 'text-primary' : ''}`}
        data-testid="menu-restart"
      >
        {isDesktop
          ? <RotateCcw size={glyph} className={`flex-shrink-0 ${riavviando ? 'animate-spin' : ''}`} />
          : <RefreshCw size={glyph} className={`flex-shrink-0 ${riavviando ? 'animate-spin' : ''}`} />}
        <span className="flex-1 text-left">
          {isDesktop ? tr('statusBar.restartApp') : updateAvailable ? tr('statusBar.updateAvailable') : tr('statusBar.reload')}
        </span>
      </button>

      {mostraVersione && (
        <VersionPopover
          anchorEl={ancora}
          appVersion={version}
          shellVersion={versioneGuscio}
          drift={drift}
          isDev={isDev}
          buildDate={typeof __BUILD_TIME__ !== 'undefined' && __BUILD_TIME__ ? formatBuildDate(__BUILD_TIME__) : ''}
          buildSha={typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : ''}
          onClose={() => setMostraVersione(false)}
          onOpenChangelog={() => { setMostraVersione(false); onOpenChangelog(version); }}
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
