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
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { usePerfMetrics } from '@/hooks/usePerfMetrics';
import { useFps } from '@/lib/fpsMonitor';
import { computeTopicsFootprint } from '@/lib/topicsFootprint';
import { livelloCarico, parolaCarico, tintaCarico } from './loadTint';
import { pubblicaCarico } from '@/state/systemLoad';
import { useT } from '@/hooks/useT';

/**
 * The megabytes at which each half counts as fully loaded. These are the SAME
 * two thresholds the old strip turned amber on, kept to the number on purpose:
 * the dot going hot has to happen where the numbers used to go amber, or the
 * move would have quietly retuned an alarm while claiming to relocate one.
 *
 * The device half is much lower when the reading is partial, because then it
 * covers the shell process alone and three gigabytes of shell is not a state
 * that occurs before the machine is long gone.
 */
const SOGLIA_DISPOSITIVO_MB = 3072;
const SOGLIA_DISPOSITIVO_PARZIALE_MB = 1024;
const SOGLIA_SERVER_MB = 6144;

export function TopicsLoadDot() {
  const tr = useT();
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

  const memCeilingMB = (appMemMB !== null ? (isPartialMem ? SOGLIA_DISPOSITIVO_PARZIALE_MB : SOGLIA_DISPOSITIVO_MB) : 0)
    + (usage.serverMB !== null ? SOGLIA_SERVER_MB : 0);
  const { livello, misurato } = livelloCarico({
    cpu: usage.totalCpu,
    memMB: usage.totalMB,
    memCeilingMB,
  });
  const parziale = usage.memPartial || usage.cpuPartial;

  // Published for the menu, which spells the same sample out in words. Written
  // in an effect and not during render: a render that writes to a store outside
  // React is the one shape that can tear a concurrent render.
  useEffect(() => {
    pubblicaCarico({ livello, misurato, totalMB: usage.totalMB, totalCpu: usage.totalCpu, fps, parziale });
  }, [livello, misurato, usage.totalMB, usage.totalCpu, fps, parziale]);

  const titolo = misurato
    ? tr(`statusBar.load.${parolaCarico(livello)}`, {
        mem: usage.totalMB !== null ? formatMB(usage.totalMB, parziale) : '-',
        cpu: usage.totalCpu !== null ? Math.round(usage.totalCpu).toString() : '-',
        fps: fps > 0 ? fps.toString() : '-',
      })
    : tr('statusBar.load.unknown');

  return (
    <span
      data-testid="topics-load-dot"
      // The level travels as an attribute so a test can read the state without
      // sampling a pixel and reverse engineering a hue.
      data-load={livello.toFixed(2)}
      data-measured={misurato ? 'true' : 'false'}
      title={titolo}
      // `flex-shrink-0`: the title next to it truncates, this does not. A dot
      // that shrinks is a dot that becomes an artefact.
      className="ml-0.5 h-2 w-2 flex-shrink-0 rounded-full"
      style={{
        // Unmeasured is not painted as calm: an outline says "no reading" where
        // a green fill would say "all good", and those are different facts.
        backgroundColor: misurato ? tintaCarico(livello) : 'transparent',
        boxShadow: misurato ? undefined : 'inset 0 0 0 1px var(--text-muted)',
      }}
    />
  );
}

/** The same short form the old strip used: gigabytes past a thousand, and the
 *  leading "~" when the figure covers one half of the app instead of both. */
function formatMB(mb: number, parziale: boolean): string {
  const testo = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  return parziale ? `~${testo}` : testo;
}
