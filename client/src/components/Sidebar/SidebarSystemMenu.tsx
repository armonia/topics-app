import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Activity, Bot, Cpu, Tag } from 'lucide-react';
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
import { refreshGateWaits, useGateWaits } from '../../state/gateWaits';
import { WorkSignals } from './AgentLines';
import { PerfSection } from './PerfSection';
import { VersionChip } from './VersionChip';
import { bundleDrift } from './bundleDrift';
import { reportLoadFailure } from '@/lib/chunkReloadGuard';
import { busyDotColor, busyTone } from '../../lib/machineBusy';
import type { WorkSignal } from './workSignals';
import { apiFetch } from '../../lib/shell/net';
import { useHubEverRead, useHubLive } from '@/state/hubLive';
import { useActiveAgentRows } from '@/state/signals';
import { useTopics, useTerminalSessions } from '@/contexts/TopicsContext';
import { PALLINO_ATTESA } from './chromeSignals';
import type { UserMenuLevel } from '@/lib/openUserMenu';

// The sites kept live are read when the Performance level opens, not before.
const KeptSites = lazy(async () => {
  const { KeptSites: Body } = await import('./KeptSites');
  return { default: Body };
});

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
 * ── WHO YOU ARE DOES NOT LIVE HERE ─────────────────────────────────────────
 * The account sat at the top of this menu for two days. It was behind a
 * gesture all the same, and the profile is not a menu entry, it is a face: on
 * the phone it is the fourth door of the row at the foot of the screen
 * (`MobileChromeBar`), on the desktop the first pill of the band at the foot
 * of the column (`IdentityBlock`). No duplicate stays here: two doors to the
 * same room are two places that one day say different things.
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
// Who works, with the hub's queue and workflows: its own chunk, read when the level opens.
const importAgentsJobsLevel = async () => {
  const { AgentsJobsLevel: Component } = await import('./AgentsJobsLevel');
  return { default: Component };
};
const AgentsJobsLevel = lazy(importAgentsJobsLevel);
// The rows that exist only with the hub: context, processes, features.
const HubSystemRows = lazy(async () => {
  const { HubSystemRows: Rows } = await import('./HubSystemRows');
  return { default: Rows };
});

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
  /** The two digits of the row's tail, picked by `workSignals`: the agents at
   *  work (the card badge's number, from the rows this row's level lists) and
   *  the installation's open chats. They ride on the same row as the
   *  machine's numbers because «who is working» and «what it costs» are one
   *  question at two zooms. */
  signals?: WorkSignal[];
  /** Closes the menu that hosts this one: a row that opens a pane leaves the menu. */
  onNavigate?: () => void;
  /** A level asked for by a door (the palette, HUBBR-19): System opens on it. */
  openLevel?: UserMenuLevel | null;
}

export function SidebarSystemMenu({ onOpenChangelog, isMobile = false, signals = [], onNavigate, openLevel = null }: SidebarSystemMenuProps) {
  const tr = useT();
  // The machine's Processes read the usage hub: without it the row does not exist (HUBBR-04).
  const hubPresent = useHubEverRead();
  // Warm the optional update panel when its parent menu opens, keeping it off
  // the app's initial download without waiting for the submenu gesture.
  // A failed warm-up is reported, not swallowed: a missing chunk raises the
  // reload prompt, a chunk that threw is logged.
  useEffect(() => { void importVersionPanel().catch(reportLoadFailure); }, []);
  const [mostraStato, setMostraStato] = useState(false);
  const [versioneGuscio, setVersioneGuscio] = useState('');
  const [versioneServer, setVersioneServer] = useState('');
  const [mostraVersione, setMostraVersione] = useState(false);
  const [riavviando, setRiavviando] = useState(false);
  const load = useLoad();
  // The tail of «Agenti e lavori»: who waits on you, else who works. Same rows as the level and the badge.
  const agentRows = useActiveAgentRows(useTerminalSessions(), useTopics());
  // The workflows at a gate come from the hub's automations, read again when
  // System opens and whenever the hub's own count of what needs you moves.
  const needsYouAt = useHubLive().automations;
  const needsYouKey = needsYouAt?.error ? 'down' : JSON.stringify((needsYouAt?.data as { needsYou?: unknown } | undefined)?.needsYou ?? null);
  useEffect(() => { if (hubPresent) void refreshGateWaits(); }, [hubPresent, needsYouKey]);
  const waitingOnYou = agentRows.awaitingInput.length + useGateWaits();
  // Who works counts the hub's agents outside Topics too (Claude Code elsewhere, Codex, Muse,
  // sub-agents, workflow agents), as the hub's own «Lavori» did; the Topics tabs it found are already counted.
  const projectsLive = useHubLive().projects;
  const outside = hubPresent && !projectsLive?.error ? (projectsLive?.data as { agentsOutside?: unknown } | undefined)?.agentsOutside : 0;
  const atWork = agentRows.working.length + (typeof outside === 'number' && outside > 0 ? outside : 0);
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
    void apiFetch('/api/version', { cache: 'no-store' })
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

  return (
    <div data-testid="sidebar-system-menu">
      {/* ONE ROW FOR THE WORK AND ITS COST, and a LEVEL, not an accordion.
          «Active agents» and «performance» were two rows one above the other,
          and they are the same question at two zooms: who is working, and what
          the machine is paying for it. The accordion under this row pushed the
          version and the restart down the panel every time it opened. */}
      <SubmenuItem
        icon={Cpu}
        label={tr('statusBar.system.title')}
        testId="menu-system-status"
        defaultOpen={openLevel === 'agents' || openLevel === 'context'}
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
                <span
                  data-testid="system-load-gauge"
                  className="h-1.5 w-7 flex-shrink-0 overflow-hidden rounded-full bg-app-border"
                  title={tr('statusBar.system.loadTitle', { n: Math.round(load.livello * 100) })}
                >
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.max(6, Math.min(100, Math.round(load.livello * 100)))}%`, backgroundColor: busyDotColor(busyTone(Math.round(load.livello * 100))) }}
                  />
                </span>
              )}
              {load?.totalMB != null && <span>{formatMemoryMB(load.totalMB, { partial: load.partial })}</span>}
              {load?.totalCpu != null && <span>{Math.round(load.totalCpu)}%</span>}
            </span>
          </>
        }
      >
        {/* PERFORMANCE, ONE BRANCH: what the work costs in megabytes and
            frames. Who is working has its own level right below
            («Agenti e lavori»): the branches answer the questions this level
            exists for, what it COSTS, what is RUNNING, what the MACHINE itself
            is doing. */}
        <SubmenuItem
          icon={Activity}
          label={tr('statusBar.system.performance')}
          testId="menu-system-performance"
          minWidth={300}
          className="max-h-[min(78vh,560px)] overflow-y-auto"
        >
          <PerfSection />
          <Suspense fallback={null}>
            <KeptSites />
          </Suspense>
          {/* What is left of «This computer»: facts of this installation, not
              of the machine (open tabs, archived, the health of the bridges).
              No gateway, no server, no cron count and no restart: those are
              the machine's Processes and Automations. */}
          <Suspense fallback={null}>
            <SystemStatusPanel enabled />
          </Suspense>
        </SubmenuItem>

        {/* WHO WORKS, ITS OWN LEVEL (HUBBR-13). The names of the sessions at
            work sat on top of Performance; with the hub they are one list with
            the proxy's sessions, the hub's queue and the workflows, filtered by
            running, waiting and finished, and that list is too big to stand
            above the megabytes. Without the hub the level lists Topics alone. */}
        <SubmenuItem
          icon={Bot}
          label={tr('agentsJobs.open')}
          testId="menu-system-agents"
          defaultOpen={openLevel === 'agents'}
          minWidth={400}
          maxWidth={420}
          // On the phone the level covers the sheets it came from, as tall as a
          // sheet can be: one sheet in sight, with its own way back and close.
          className={isMobile ? 'min-h-[calc(100dvh-3rem)]' : 'max-h-[min(80vh,640px)] overflow-y-auto'}
          tail={waitingOnYou > 0 ? (
            <span data-testid="menu-system-agents-tail" className="flex flex-shrink-0 items-center gap-1.5 text-app-text-secondary tabular-nums">
              <span className={`h-1.5 w-1.5 rounded-full ${PALLINO_ATTESA}`} />
              {waitingOnYou === 1 ? tr('agentsJobs.tail.waitingOne') : tr('agentsJobs.tail.waiting', { n: waitingOnYou })}
            </span>
          ) : atWork > 0 ? (
            <span data-testid="menu-system-agents-tail" className="flex-shrink-0 text-app-text-secondary tabular-nums">
              {tr('agentsJobs.tail.working', { n: atWork })}
            </span>
          ) : undefined}
        >
          <Suspense fallback={<div className="min-h-24 px-3 py-2 text-mini text-app-text-muted">{tr('common.loading')}</div>}>
            <AgentsJobsLevel onNavigate={onNavigate} />
          </Suspense>
        </SubmenuItem>

        {/* The usage per project lives in the Dashboard now, opened from the
            usage row in the menu with your name (HUBBR-12): kept here too it
            would be the duplicate the hub map removes. */}

        {/* THE MACHINE IS A VIEW NOW, not a level: «Processi» is a pane beside
            the work (HUBBR-04). With it, the agents' context (a level) and
            the feature map (a view): the three rows exist only where the hub
            answers, so they come in their own chunk, off the first download. */}
        {hubPresent && (
          <Suspense fallback={null}>
            <HubSystemRows isMobile={isMobile} onNavigate={onNavigate} openContext={openLevel === 'context'} />
          </Suspense>
        )}
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
        maxWidth={300}
        className="p-3 space-y-3"
        onOpenChange={setMostraVersione}
        tail={
          <span className="flex flex-shrink-0 items-center gap-1.5 text-compact tabular-nums">
            {updateAvailable && (
              <span data-testid="menu-version-update-dot" title={tr('statusBar.updateAvailable')} className="h-1.5 w-1.5 rounded-full bg-primary" />
            )}
            <VersionChip
              appVersion={version}
              shellVersion={versioneGuscio}
              drift={drift}
              devInstall={devInstall}
              hmrAge={isDev && lastChange ? formatChangeAge(lastChange) : undefined}
              desktop={isDesktop}
            />
          </span>
        }
      >
        <Suspense fallback={<div className="min-h-24 text-mini text-app-text-muted">{tr('common.loading')}</div>}>
          <VersionPanel
            appVersion={version}
            shellVersion={versioneGuscio}
            drift={drift}
            isDev={isDev}
            buildDate={typeof __BUILD_TIME__ !== 'undefined' && __BUILD_TIME__ ? formatBuildDate(__BUILD_TIME__) : ''}
            buildSha={typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : ''}
            onOpenChangelog={() => { setMostraVersione(false); onOpenChangelog(version); }}
            restart={{
              run: restart,
              busy: riavviando,
              desktop: isDesktop,
              highlight: updateAvailable,
              label: isDesktop ? tr('statusBar.restartApp') : updateAvailable ? tr('statusBar.updateAvailable') : tr('statusBar.reload'),
            }}
          />
        </Suspense>
      </SubmenuItem>

    </div>
  );
}


function formatBuildDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}
