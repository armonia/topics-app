/**
 * THE DOT NEXT TO "Topics": how loaded this machine is, at a glance.
 *
 * ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────
 * Memory, CPU and frame rate used to sit in a strip at the foot of the column,
 * in eleven-pixel digits, next to the version number. That strip is gone: the
 * numbers moved into the "Topics" menu, which is where you go when you want to
 * KNOW. What was lost in the move is the part nobody was reading on purpose
 * either, and still worked: the corner of the eye that notices the machine is
 * getting heavy before anything is visibly wrong.
 *
 * A dot gives that back for the price of eight pixels. It is deliberately
 * BIGGER than the status dots elsewhere in the chrome (those are 6px and they
 * are read only once you have already gone looking for them): this one has to
 * be legible without being looked at, and its whole content is a colour.
 *
 * ── WHY IT SITS ON THE TITLE AND NOT IN THE MENU ────────────────────────────
 * Because a load you have to open a menu to see is a load you check after
 * something already went wrong. The menu answers "how much exactly", the dot
 * answers "is it fine", and only the second question gets asked all day.
 *
 * ── AND WHY IT OWNS THE POLLING ─────────────────────────────────────────────
 * It is the surface that is always mounted, so it is the one that can guarantee
 * a single reader of the sample (see `state/systemLoad.ts` for why two readers
 * is not merely wasteful but wrong). The menu subscribes to what this publishes.
 */
import { useEffect } from 'react';
// RELATIVE, NOT `@/`: this component is MOUNTED by a unit test
// (`TopicsLoadDot.test.tsx`) and `bun test` does not resolve the alias — the
// same reason `VersionChip` next door is written this way. Vite resolves both,
// so nothing else changes.
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { usePerfMetrics } from '../../hooks/usePerfMetrics';
import { useFps } from '../../lib/fpsMonitor';
import { computeTopicsFootprint } from '../../lib/topicsFootprint';
import { publishLoad } from '../../state/systemLoad';
import { useActiveLocale, useT } from '../../hooks/useT';
import { busyDotColor, busyTone, machineBusyPct, pctPlaceholders, type BusyTone } from '../../lib/machineBusy';

/** The three words the hover says, one per tone of the one number. */
const WORD: Record<Exclude<BusyTone, 'unknown'>, 'calmo' | 'caldo' | 'carico'> = { ok: 'calmo', busy: 'caldo', critical: 'carico' };

export function TopicsLoadDot({ hidden = false, alarm = false }: {
  /** Covered by the window commands (Tauri, menu open): kept in the DOM, made
   *  invisible. Unmounting it resized the trigger row at the click. */
  hidden?: boolean;
  /** Something that cannot wait behind a gesture: WS down, or a data notice. */
  alarm?: boolean;
} = {}) {
  const tr = useT();
  const locale = useActiveLocale();
  // The same cadences the status bar used, and for the same reasons: system
  // status is a minute (it is a server round trip), the shell metrics are five
  // seconds (they are a local call and the number has to move while you watch
  // something run). Both hooks pause on a hidden window by themselves.
  const { status } = useSystemStatus(true, 60000);
  const perf = usePerfMetrics(true, 5000);
  const fps = useFps();

  const appMemMB = perf?.memory?.totalMB ?? null;
  const isPartialMem = perf?.partial ?? false;
  const fleet = status?.server.fleet;
  const serverSideMemMB = fleet?.memoryMB ?? status?.server.memoryMB ?? null;

  const usage = computeTopicsFootprint({
    deviceMB: appMemMB,
    deviceProcessCount: perf?.memory?.processCount ?? 0,
    devicePartial: isPartialMem,
    deviceCpu: perf?.cpu.total ?? null,
    serverMB: serverSideMemMB,
    serverProcessCount: fleet?.processCount ?? (serverSideMemMB !== null ? 1 : 0),
    serverMetric: fleet?.memMetric ?? 'rss',
    serverCpu: fleet?.cpuPercent ?? null,
    scriptsMB: fleet?.scriptsMB ?? 0,
    scriptsProcessCount: fleet?.scriptsProcessCount ?? 0,
    sampleKey: status?.timestamp,
  });

  // THE DOT SAYS HOW BUSY THE MAC IS (24/09), the one number every load
  // surface says: the larger of the whole Mac's CPU% and memory%, green under
  // 60, amber to 85, red above. It used to be Topics' own footprint against
  // fixed megabyte thresholds, a second scale that disagreed with the board's.
  // Topics' own megabytes and CPU still travel to the menu, which prints them.
  const busyPct = machineBusyPct(status?.machine);
  const tone = busyTone(busyPct);
  const measured = busyPct != null;
  const level = measured ? busyPct / 100 : 0;
  const partial = usage.memPartial || usage.cpuPartial;

  // Published for the menu, which spells the same sample out in words. Written
  // in an effect and not during render: a render that writes to a store outside
  // React is the one shape that can tear a concurrent render.
  useEffect(() => {
    publishLoad({ livello: level, misurato: measured, totalMB: usage.totalMB, totalCpu: usage.totalCpu, fps, partial });
  }, [level, measured, usage.totalMB, usage.totalCpu, fps, partial]);

  const title = tone !== 'unknown' && busyPct != null
    ? tr(`statusBar.load.${WORD[tone]}`, pctPlaceholders(locale, { pct: busyPct }))
    : tr('statusBar.load.unknown');

  return (
    <span
      // `connection-status`, because that is what this dot now answers for.
      // The name comes from the status-bar button that used to live at the foot
      // of the column; the bar moved into the «Topics» menu on 2026-08-31 and
      // the handle could not follow it behind a gesture — half the E2E suite
      // reads it to know the app is up.
      data-testid="connection-status"
      data-load-dot="true"
      // The level travels as an attribute so a test can read the state without
      // sampling a pixel and reverse engineering a hue.
      data-load={level.toFixed(2)}
      data-tone={tone}
      data-measured={measured ? 'true' : 'false'}
      data-alarm={alarm || undefined}
      title={title}
      // `flex-shrink-0`: the title next to it truncates, this does not. A dot
      // that shrinks is a dot that becomes an artefact.
      className={`ml-0.5 h-2 w-2 flex-shrink-0 rounded-full ${alarm ? 'animate-pulse' : ''} ${hidden ? 'invisible' : ''}`}
      style={{
        // Unmeasured is not painted as calm: an outline says "no reading" where
        // a green fill would say "all good", and those are different facts.
        // The alarm OVERRIDES the load tint: "you are offline" outranks "the
        // machine is busy", and painting both on one dot would mean neither.
        backgroundColor: alarm ? 'var(--warning, #f59e0b)' : busyDotColor(tone),
        boxShadow: alarm || measured ? undefined : 'inset 0 0 0 1px var(--text-muted)',
      }}
    />
  );
}

