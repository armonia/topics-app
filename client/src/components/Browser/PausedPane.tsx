/**
 * The state of a HEAVY native pane that is paused (`useNativePanePause`).
 *
 * The native view is hidden, so this is plain DOM in its place, like
 * `ParkedPane`: nothing sits over a live page (TOPIC-BROWSER-03). Under it the
 * placeholder draws the 1x still of the page as it was; without a still the card
 * stands on the neutral surface.
 *
 * STATIC ON PURPOSE. A paused pane exists to stop spending CPU and GPU, so the
 * veil and the card carry no animation of their own. A click anywhere on it
 * resumes, the button is the same action said out loud.
 */
import { CirclePause, Play } from 'lucide-react';
import { useT } from '../../hooks/useT';

interface PausedPaneProps {
  /** % of one core the page was using when it was judged heavy. */
  cpu: number;
  hasStill: boolean;
  onResume?: () => void;
}

export function PausedPane({ cpu, hasStill, onResume }: PausedPaneProps) {
  const tr = useT();
  return (
    <div
      className={`absolute inset-0 z-10 flex items-center justify-center p-6 cursor-pointer ${hasStill ? 'bg-black/35' : 'bg-app-bg'}`}
      data-testid="browser-paused"
      onClick={() => onResume?.()}
    >
      <div className="max-w-sm text-center rounded-lg px-5 py-4 bg-app-bg border border-app-border shadow-lg">
        <CirclePause size={28} className="mx-auto mb-2 text-app-text-tertiary" aria-hidden />
        <div className="text-prose font-medium text-app-text">{tr('browser.heavy.paused.title')}</div>
        <div className="mt-1.5 text-compact text-app-text-muted leading-snug">
          {tr('browser.heavy.paused.body', { cpu: String(Math.round(cpu)) })}
        </div>
        <button
          type="button"
          data-testid="browser-paused-resume"
          onClick={(e) => { e.stopPropagation(); onResume?.(); }}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-compact rounded-md border border-app-border-light text-app-text hover:bg-app-hover"
        >
          <Play size={12} aria-hidden />
          {tr('browser.heavy.paused.resume')}
        </button>
      </div>
    </div>
  );
}
