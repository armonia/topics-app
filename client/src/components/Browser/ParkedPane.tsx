/**
 * La schermata di una scheda PARCHEGGIATA: punta a una porta locale su cui non
 * c'è nessuno in ascolto, quindi la webview nativa non è stata nemmeno creata.
 *
 * Prima al suo posto restava una pane BIANCA con sopra una striscia rossa: una
 * webview vera (col suo data store) che non mostrava niente e non poteva
 * mostrare niente. Qui invece non c'è nessuna view, e questo è DOM normale —
 * quindi si può anche leggere e cliccare, cosa che sopra una WKWebView non
 * sarebbe possibile (composita sopra tutto).
 */
import { Unplug, RotateCw } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { loopbackDownText } from './navErrorMessage';

interface ParkedPaneProps {
  url: string;
  /** Quando abbiamo guardato l'ultima volta (epoch ms). */
  checkedAt: number;
  checking?: boolean;
  onRetry?: () => void;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ParkedPane({ url, checkedAt, checking, onRetry }: ParkedPaneProps) {
  const tr = useT();
  const { message, hint } = loopbackDownText(url);
  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center p-6 bg-app-bg"
      data-testid="browser-parked"
      data-parked-url={url}
    >
      <div className="max-w-md text-center">
        {/* `Unplug` e non `PlugZap`: la spina col lampo è il segno di
            «acceso» e stava sopra la riga che dice che non c'è nessuno in
            ascolto — il glifo diceva il contrario del testo. */}
        <Unplug size={28} className="mx-auto mb-3 text-app-text-tertiary" aria-hidden />
        <div className="text-[13px] font-medium text-app-text">{message}</div>
        {hint && <div className="mt-1.5 text-[12px] text-app-text-muted leading-snug">{hint}</div>}
        <div className="mt-1.5 text-[11px] text-app-text-tertiary">
          {tr('parked.checkedAt', { when: hhmm(checkedAt) })}
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            disabled={checking}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md border border-app-border-light text-app-text hover:bg-app-hover transition-colors disabled:opacity-50"
          >
            <RotateCw size={12} className={checking ? 'animate-spin' : undefined} aria-hidden />
            {checking ? 'Controllo…' : 'Riprova'}
          </button>
        </div>
        {/* La scheda si chiude con la scorciatoia che chiude qualunque pane: non
            serve un bottone in più, serve saperlo. */}
        <div className="mt-3 text-[11px] text-app-text-tertiary">
          <kbd className="kbd">⌘W</kbd> {tr('parked.closesTab')}
        </div>
      </div>
    </div>
  );
}
