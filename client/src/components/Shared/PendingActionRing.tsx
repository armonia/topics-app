/**
 * PendingActionRing — Things3-style "mark as done" affordance.
 *
 * Two visual states:
 *  - **idle** (no pending entry for the key): empty circle outline. Click
 *    fires `onIdleClick`, which is expected to enqueue a PendingAction
 *    (and auto-tick it, so the countdown starts immediately).
 *  - **pending** (an entry exists, ticked because of auto-tick): filled
 *    circle with a check inside, accented with the topic color when
 *    available. Click cancels.
 *
 * The countdown progress itself is rendered separately by
 * `<PendingActionProgressOverlay>` over the parent row/tab background —
 * not on the icon — so the visual cue scans more like a Things3 task
 * being filled in than a small spinner.
 *
 * Replaces the previous "X close button" + ring affordance: the icon is
 * always semantically "complete this", whether it commits a tab close or
 * archives a topic.
 */
import { Check } from 'lucide-react';
import type { PendingActionStatus } from '../../contexts/PendingActionContext';

interface Props {
  /** Current pending entry for this key, or null when idle. */
  status: PendingActionStatus | null;
  /** Diametro DISEGNATO del cerchio, in px. Default 14. */
  size?: number;
  /**
   * Il BOX CLICCABILE, quando deve essere più grande del cerchio.
   *
   * `tap-expand-y` su `baseBtn` (qui sotto) risolve METÀ del problema: proietta
   * un'area alta 44 ma larga `100%` del bottone — e il bottone è largo `size`,
   * cioè 14px, perché la misura finisce in uno `style` INLINE che nessuna classe
   * può scavalcare. Il bersaglio restava 14 di largo: un terzo della soglia iOS
   * sull'asse dove il dito sbaglia di più, e col dito si prendeva la riga invece
   * della spunta.
   *
   * Quando questa prop c'è, la misura inline resta solo sul CERCHIO e il bottone
   * prende il suo box dalle classi (es. `w-9 h-9 md:w-6 md:h-6` = 36px sotto i
   * 768px, che dentro una riga da 44 ci sta con 4px di aria per lato). È un box
   * VERO, non un `::after` proiettato: cresce nel flusso e spinge i vicini,
   * quindi non può rubare l'hit-test a nessuno — la trappola che `.tap-expand`
   * aveva già pagato nel binario della sidebar (44 di LARGO sopra un glifo da 24
   * coprivano il pin accanto, e toccare il pin chiudeva il browser).
   *
   * I due pezzi si compongono: il box dà la LARGHEZZA, `tap-expand-y` porta
   * l'ALTEZZA a 44 dove la riga glielo consente.
   */
  boxClassName?: string;
  /** Triggered when idle (empty circle clicked). Caller enqueues + auto-ticks. */
  onIdleClick?: () => void;
  /** Override `aria-label` for the idle state. */
  idleAriaLabel?: string;
  /** Override `aria-label` for the pending state. */
  pendingAriaLabel?: string;
  /** Title attribute (tooltip). Per-state defaults supplied if not set. */
  idleTitle?: string;
  pendingTitle?: string;
  /** Extra Tailwind classes for the wrapping <button>. */
  className?: string;
}

// `tap-expand-y` sta QUI, sul bottone, e non sul suo contenitore: il glifo è un
// cerchio da 14px con larghezza e altezza INLINE (`style={{width:size}}`), quindi
// nessuna classe può allargarne il box — su touch il bersaglio effettivo era
// 14×14, meno di un terzo della soglia iOS. L'utility proietta un'area sensibile
// alta 44px e larga quanto il bottone, cioè cresce dove c'è spazio (la riga su
// mobile è già alta 44) e non ruba un pixel ai vicini del binario. È la stessa
// ricetta dei «…» e della X delle tab: il glifo resta piccolo, il bersaglio no.
const baseBtn =
  'tap-expand-y relative inline-flex items-center justify-center flex-shrink-0 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-full';

export function PendingActionRing({
  status,
  size = 14,
  boxClassName,
  onIdleClick,
  idleAriaLabel = 'Mark as done',
  pendingAriaLabel = 'Annulla',
  idleTitle = 'Done',
  pendingTitle = 'Annulla',
  className,
}: Props) {
  if (!status) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onIdleClick?.(); }}
        aria-label={idleAriaLabel}
        title={idleTitle}
        className={`${baseBtn} ${boxClassName ?? ''} ${className ?? ''}`}
        // Il box viene dalle CLASSI quando il chiamante ne dà (`boxClassName`),
        // altrimenti resta l'inline di sempre: `width`/`height` inline
        // batterebbero qualunque classe, quindi non si possono lasciare entrambi.
        style={boxClassName ? undefined : { width: size, height: size }}
      >
        <span
          className="block rounded-full border-[1.5px] border-current opacity-60"
          style={{ width: size, height: size }}
        />
      </button>
    );
  }
  const accent = status.entry.color || 'currentColor';
  const innerCheck = Math.max(8, size - 5);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); status.cancel(); }}
      aria-label={pendingAriaLabel}
      title={pendingTitle}
      className={`${baseBtn} ${boxClassName ?? ''} ${className ?? ''}`}
      style={boxClassName ? { color: accent } : { width: size, height: size, color: accent }}
    >
      <span
        className="flex items-center justify-center rounded-full"
        style={{ width: size, height: size, backgroundColor: accent }}
      >
        <Check size={innerCheck} strokeWidth={3} className="text-white" />
      </span>
    </button>
  );
}
