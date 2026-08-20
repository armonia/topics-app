/**
 * The one way a browser pane says something is wrong.
 *
 * IN FLOW, never an absolute overlay: on the Tauri path the native WKWebView
 * composites ABOVE the DOM, so an overlay here would simply be invisible.
 * Shrinking the placeholder is what pushes the native view down below the strip.
 *
 * There are two things a pane needs to report and they are not the same thing,
 * which is exactly why they share a shell instead of each growing its own:
 *
 *  - a navigation FAILED — the page didn't load, the previous one is still on
 *    screen, and the user can retry or dismiss;
 *  - the PANE is dead — the native view stopped accepting commands, so what is
 *    on screen is a picture of the last page it managed to draw and nothing the
 *    chrome offers will do anything until the view is rebuilt.
 *
 * The second one is the one worth having a component for. Without it the chrome
 * renders from React state and goes on looking perfectly healthy over a view
 * that has stopped answering: the address bar updates, the favicon sits there,
 * the buttons depress, and nothing happens. A surface that can't fail visibly is
 * a surface that lies.
 */
import type { ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { AlertTriangle, RotateCw, X } from 'lucide-react';

export interface BrowserNoticeStripProps {
  /** Primary line — what happened. */
  message: string;
  /** Optional second line — why, when the why doesn't fit in the first. */
  hint?: string;
  /** Optional action button (retry, rebuild). */
  action?: { label: string; icon?: ReactNode; onClick: () => void };
  /** Optional dismiss. Omitted when the condition can't be waved away. */
  onDismiss?: () => void;
  testId: string;
}

export function BrowserNoticeStrip({ message, hint, action, onDismiss, testId }: BrowserNoticeStripProps) {
  const tr = useT();
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border-b border-red-500/30 text-red-700 dark:text-red-300 text-[12px] flex-shrink-0"
      data-testid={testId}
      role="alert"
    >
      <AlertTriangle size={13} className="flex-shrink-0" aria-hidden />
      {/* Due righe, non una troncata: la prima dice cosa è successo, la seconda
          perché. Il testo viene già scritto corto apposta — `truncate` qui
          tagliava proprio la parte che spiegava il problema.
          `line-clamp-*` imposta già `display:-webkit-box`: aggiungerci `block`
          metterebbe due utility sulla stessa proprietà, e a decidere sarebbe
          l'ordine nel foglio di stile, non quello delle classi. */}
      <span className="flex-1 min-w-0 leading-tight" title={[message, hint].filter(Boolean).join('\n')}>
        <span className="line-clamp-2">{message}</span>
        {hint && <span className="line-clamp-2 opacity-70">{hint}</span>}
      </span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 font-medium transition-colors flex-shrink-0"
        >
          {action.icon ?? <RotateCw size={11} aria-hidden />}
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/15 transition-colors flex-shrink-0"
          title={tr('common.close')}
          aria-label={tr('notice.dismiss')}
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
