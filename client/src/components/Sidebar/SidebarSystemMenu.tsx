import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Coins, Gauge, MonitorCog, RefreshCw, RotateCcw, Tag } from 'lucide-react';
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
import { formatMemoryMB } from '@/lib/formatMemory';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { AgentLines, WorkSignals } from './AgentLines';
import { PerfSection } from './PerfSection';
import { VersionChip } from './VersionChip';
import { bundleDrift } from './bundleDrift';
import { loadTint } from './loadTint';
import type { WorkSignal } from './workSignals';
import type { UsageRange } from '@/hooks/useProjectUsage';

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
const importVersionPanel = async () => {
  const { VersionPanel: Component } = await import('./VersionPanel');
  return { default: Component };
};
const VersionPanel = lazy(importVersionPanel);
const importProjectUsagePanel = async () => {
  const { ProjectUsagePanel: Component } = await import('./ProjectUsagePanel');
  return { default: Component };
};
const ProjectUsagePanel = lazy(importProjectUsagePanel);

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
  /** What the installation is running right now, already picked and tiered by
   *  `workSignals`. It rides on the same row as the machine's numbers because
   *  «who is working» and «what it costs» are one question at two zooms. */
  signals?: WorkSignal[];
}

export function SidebarSystemMenu({ onOpenChangelog, isMobile = false, signals = [] }: SidebarSystemMenuProps) {
  const tr = useT();
  // Warm the optional update panel when its parent menu opens, keeping it off
  // the app's initial download without waiting for the submenu gesture.
  useEffect(() => { void importVersionPanel().catch(() => {}); }, []);
  const [mostraStato, setMostraStato] = useState(false);
  // The window the usage level is reading. It lives HERE and not in the panel
  // so that closing the level and reopening it does not silently snap back to
  // «all» and re-run the expensive query: the choice is the person's, and it
  // outlives the panel that shows it.
  const [usageRange, setUsageRange] = useState<UsageRange>('all');
  const [versioneGuscio, setVersioneGuscio] = useState('');
  const [versioneServer, setVersioneServer] = useState('');
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
      {/* ONE ROW FOR THE WORK AND ITS COST, and a LEVEL, not an accordion.
          «Active agents» and «performance» were two rows one above the other,
          and they are the same question at two zooms: who is working, and what
          the machine is paying for it. The accordion under this row pushed the
          version and the restart down the panel every time it opened. */}
      <SubmenuItem
        icon={Gauge}
        label={tr('statusBar.system.title')}
        testId="menu-system-status"
        minWidth={312}
        // The tallest level of the menu: the names of what is running, then
        // the numbers. On a short window the two together are more than the
        // screen, and the placement can only move a panel, not shrink it.
        className="max-h-[min(78vh,560px)] overflow-y-auto"
        onOpenChange={setMostraStato}
        tail={
          <>
            <WorkSignals signals={signals} />
            {/* ALWAYS RENDERED, numbers or not: this span is what carries the
                tooltip, and a host that appears only once a sample has landed
                is a tooltip that is missing exactly when somebody opens the
                menu to find out why nothing is being measured.
                `mouseenter`/`focus` rather than hover styling because it lives
                inside a <button>: the button is the thing that gets hovered,
                this is the thing that has to notice. */}
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
              {load?.totalMB != null && <span>{formatMemoryMB(load.totalMB, { partial: load.partial })}</span>}
              {load?.totalCpu != null && <span>{Math.round(load.totalCpu)}%</span>}
            </span>
          </>
        }
      >
        {/* WHO IS WORKING FIRST, then what it costs: the names answer the
            question the numbers only quantify. */}
        <AgentLines />
        <div className="border-t border-app-border" />
        <PerfSection />
        {/* WHAT EACH PROJECT HAS COST, in the third unit.
            The rows above say megabytes, and one of them is now per project:
            this says TOKENS and the dollars that have a price, for the same
            subject. It is a level and not a column because the panel's whole
            discipline is that two units never share one (`featureWeight.ts`),
            and because the read behind it is a GROUP BY over the whole message
            table - 1,2 s cold - which must not happen because a menu opened.
            Behind its own row it costs nothing until somebody asks. */}
        <SubmenuItem
          icon={Coins}
          label={tr('usage.perProject')}
          testId="menu-usage-projects"
          minWidth={320}
          className="max-h-[min(78vh,560px)] overflow-y-auto"
        >
          <Suspense fallback={<div className="p-3 text-center text-[11px] text-app-text-muted">{tr('common.loading')}</div>}>
            <ProjectUsagePanel range={usageRange} onRange={setUsageRange} />
          </Suspense>
        </SubmenuItem>

        {/* THE MACHINE ITSELF ONE LEVEL FURTHER IN: cores, disks, the server's
            own processes. It is the answer AFTER «is Topics heavy», it is the
            tallest block of the three, and behind its own row it costs
            nothing until somebody asks for it. */}
        {/* AND IT KEEPS ITS OWN CEILING, like the level above it. Without one
            the panel is as tall as its content and the window simply cuts it:
            measured on 1280x800, the gateway row landed 30 px from the bottom
            edge and everything under it — memory, uptime, the restart — was
            off the screen with nothing to scroll. A level can be moved by the
            placement, never shrunk by it. */}
        <SubmenuItem
          icon={MonitorCog}
          label={tr('statusBar.system.machine')}
          testId="menu-system-machine"
          minWidth={300}
          className="max-h-[min(78vh,560px)] overflow-y-auto"
        >
          <Suspense fallback={<div className="p-3 text-center text-[11px] text-app-text-muted">{tr('common.loading')}</div>}>
            <SystemStatusPanel enabled />
          </Suspense>
        </SubmenuItem>
      </SubmenuItem>

      {/* THE VERSION OPENS SIDEWAYS TOO. It used to be a chip carrying its own
          popover, which landed ON TOP of the menu it was opened from: the one
          row of this panel that answered somewhere else. The chip stays as the
          tail (the number, the drift dot, the «dev» badge are read without
          opening anything) and the row is the trigger. */}
      <SubmenuItem
        icon={Tag}
        label={tr('statusBar.version.title')}
        testId="menu-version"
        minWidth={260}
        className="p-3 space-y-3"
        onOpenChange={setMostraVersione}
        tail={
          <span className="flex flex-shrink-0 items-center gap-1.5 text-[12px] tabular-nums">
            <VersionChip
              appVersion={version}
              shellVersion={versioneGuscio}
              drift={drift}
              devInstall={devInstall}
              hmrAge={isDev && lastChange ? formatChangeAge(lastChange) : undefined}
              desktop={isDesktop}
              popoverOpen={mostraVersione}
            />
          </span>
        }
      >
        <Suspense fallback={<div className="min-h-24 text-[11px] text-app-text-muted">{tr('common.loading')}</div>}>
          <VersionPanel
            appVersion={version}
            shellVersion={versioneGuscio}
            drift={drift}
            isDev={isDev}
            buildDate={typeof __BUILD_TIME__ !== 'undefined' && __BUILD_TIME__ ? formatBuildDate(__BUILD_TIME__) : ''}
            buildSha={typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : ''}
            onOpenChangelog={() => { setMostraVersione(false); onOpenChangelog(version); }}
          />
        </Suspense>
      </SubmenuItem>

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
    </div>
  );
}


function formatBuildDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}
