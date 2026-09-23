/**
 * The state of a HEAVY native pane that is paused (`useNativePanePause`).
 *
 * The native view is hidden, so this is plain DOM in its place, like
 * `ParkedPane`: nothing sits over a live page (TOPIC-BROWSER-03). Under it the
 * placeholder draws the 1x still of the page as it was; without a still the card
 * stands on the neutral surface.
 *
 * THE NUMBERS ARE SHARES OF THE MAC, not of a core (23/09): «37% di un core» is
 * a unit nobody keeps in mind, and a page costs memory too. So the card says
 * how much of the whole machine the page was taking, CPU over all its cores and
 * memory over its physical RAM, and leaves out what is not measured.
 *
 * THREE WAYS BACK. «Riprendi» brings the page back and it may pause again when
 * you leave it; «keep it this time» keeps it live until it navigates
 * somewhere else; «keep always» never pauses this site again.
 *
 * STATIC ON PURPOSE. A paused pane exists to stop spending CPU and GPU, so the
 * veil and the card carry no animation of their own. A click on the card's
 * background resumes, the first button is the same action said out loud.
 */
import { CirclePause, Play } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { machineMemoryMb } from '../../lib/shell/heavyPanes';
import { pausedUsageText } from './pausedUsage';

const CPU_CORES = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 1) || 1);

interface PausedPaneProps {
  /** % of one core the page was using when it was judged heavy. */
  cpu: number;
  /** Its footprint in MB at the last sample, when the shell gave it. */
  memMb?: number;
  hasStill: boolean;
  onResume?: () => void;
  onKeepOnce?: () => void;
  onKeepAlways?: () => void;
}

export function PausedPane({ cpu, memMb, hasStill, onResume, onKeepOnce, onKeepAlways }: PausedPaneProps) {
  const tr = useT();
  const body = pausedUsageText(tr, { cpu, memMb }, { cores: CPU_CORES, memMb: machineMemoryMb() });
  const secondary = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-compact rounded-md text-app-text-secondary hover:text-app-text hover:bg-app-hover';
  return (
    <div
      className={`absolute inset-0 z-10 flex items-center justify-center p-6 cursor-pointer ${hasStill ? 'bg-black/35' : 'bg-app-bg'}`}
      data-testid="browser-paused"
      onClick={() => onResume?.()}
    >
      <div
        className="max-w-sm text-center rounded-lg px-5 py-4 bg-app-bg border border-app-border shadow-lg cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        <CirclePause size={28} className="mx-auto mb-2 text-app-text-tertiary" aria-hidden />
        <div className="text-prose font-medium text-app-text">{tr('browser.heavy.paused.title')}</div>
        <div className="mt-1.5 text-compact text-app-text-muted leading-snug" data-testid="browser-paused-usage">
          {body}
        </div>
        <div className="mt-3 flex flex-col items-center gap-1">
          <button
            type="button"
            data-testid="browser-paused-resume"
            onClick={() => onResume?.()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-compact rounded-md border border-app-border-light text-app-text hover:bg-app-hover"
          >
            <Play size={12} aria-hidden />
            {tr('browser.heavy.paused.resume')}
          </button>
          {onKeepOnce && (
            <button type="button" data-testid="browser-paused-keep-once" onClick={onKeepOnce} className={secondary}>
              {tr('browser.heavy.paused.keepOnce')}
            </button>
          )}
          {onKeepAlways && (
            <button type="button" data-testid="browser-paused-keep-always" onClick={onKeepAlways} className={secondary}>
              {tr('browser.heavy.paused.keepAlways')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
