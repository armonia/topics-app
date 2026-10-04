/**
 * IL POSTO DEGLI AVVISI DI VERSIONE — uno, dentro la colonna.
 *
 * Attilio, 07/08: «il banner "Nuova versione disponibile" da desktop esce un po'
 * a caso e dovremo fare in modo che sia ben rinchiuso e ben posizionato in
 * termini di spaziature all'interno della sidebar; tutta quanta la larghezza
 * della sidebar».
 *
 * ── Perché usciva «a caso» ──────────────────────────────────────────────────
 * I due avvisi (bundle ricostruito e release firmata) erano cartellini
 * `position: fixed` ancorati al NUMERO DI VERSIONE in fondo alla barra di
 * stato: `bottom = innerHeight − ancora.top + 6`, `right` calcolato dal bordo
 * destro dell'ancora e poi RITAGLIATO al viewport perché la stessa formula
 * aveva già prodotto una `x = −80` (BRW-REL-03). Un cartellino largo fino a
 * 320px appeso a un'ancora larga ~40 dentro una colonna larga ~250: la
 * matematica poteva solo finire fuori dalla colonna, e finiva sopra le pane —
 * cioè sopra il lavoro. Con la sidebar stretta l'ancora veniva scartata e il
 * cartellino cadeva nell'angolo in basso a destra dello SCHERMO, che è
 * dall'altra parte rispetto alla cosa che annuncia.
 *
 * ── Cos'è adesso ────────────────────────────────────────────────────────────
 * Uno SLOT vero nel flusso della colonna (`[data-update-slot]`, App.tsx), sopra
 * la barra di stato: il banner è largo quanto la sidebar meno il suo rientro —
 * `ROW_INSET`, lo stesso di ogni card, riga e tab — e spinge in su ciò che sta
 * sopra invece di coprirlo. Niente più aritmetica di ancoraggio, niente più
 * ritagli difensivi: il layout lo fa il layout.
 *
 * Il ripiego all'angolo resta per le finestre che una sidebar non ce l'hanno
 * (una finestra-gruppo staccata): lì lo slot non esiste, e un avviso che non
 * ha dove atterrare è meglio in un angolo che invisibile.
 *
 * ── DUE STATI, DETTI ────────────────────────────────────────────────────────
 * «Magari anche specificando se è una versione nuova oppure se siamo in
 * modalità automatica, spiegandolo col minimo numero di parole». Sono due
 * canali diversi e finora dicevano la stessa frase:
 *   · `kind="build"`  → il bundle servito è cambiato (consegna continua dal
 *     server di sviluppo). Non è una release: è il lavoro di oggi.
 *   · `kind="release"` → una versione firmata, con un numero.
 * Il `kind` sceglie l'occhiello, che è UNA parola sopra il titolo.
 */
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { ROW_INSET } from '@/lib/selectionStyles';
import { useT } from '../../hooks/useT';

const SLOT_SELECTOR = '[data-update-slot]';
/** The in-flow slot under the panes, used while the sidebar is collapsed. */
const MAIN_SLOT_SELECTOR = '[data-update-slot-main]';

export type UpdateBannerKind = 'build' | 'release';

/**
 * The eyebrow: the word that says which of the two worlds is talking.
 *
 * Over the bundle banner it used to say:
 *   "Aggiornamento automatico" allow-italian: the wrong label is the subject
 * which was wrong twice. Nothing there is automatic (the page reloads on a
 * click, never on its own), and "update" is the OTHER world's word, so the two
 * notices ended up sharing the only term that had to tell them apart. Each one
 * now names its own object, and the buttons follow: reload the bundle, update
 * the shell.
 */
const EYEBROW_KEY: Record<UpdateBannerKind, string> = {
  build: 'banner.eyebrow.build',
  release: 'banner.eyebrow.release',
};

export function SidebarUpdateBanner({
  kind,
  tone = 'neutral',
  icon,
  title,
  children,
  onDismiss,
  testId,
  docked = true,
}: {
  kind: UpdateBannerKind;
  /** `ready` = c'è qualcosa da fare adesso (verde); `error` = è andata male. */
  tone?: 'neutral' | 'ready' | 'error';
  icon?: React.ReactNode;
  /** Il fatto, in una riga. L'occhiello dice già di che genere è. */
  title: string;
  /** L'azione (un bottone) e nient'altro. */
  children?: React.ReactNode;
  onDismiss?: () => void;
  testId?: string;
  /** False when the sidebar is collapsed: its slot is then off screen, so the
   *  banner lands in the row under the panes (`data-update-slot-main`). */
  docked?: boolean;
}) {
  const tr = useT();
  const card = (
    <div
      data-testid={testId}
      data-update-kind={kind}
      className={`edge-lit flex w-full items-start gap-2 rounded-lg p-2.5 text-compact ${
        tone === 'ready'
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : tone === 'error'
            // red-200 in dark, not 300: over its own 10% veil red-300 gave
            // 4.22 (usability audit, 04/10), under the 4.5 of a 12px title.
            ? 'bg-red-500/10 text-red-700 dark:text-red-200'
            : 'bg-black/[0.05] dark:bg-white/[0.06] text-app-text'
      }`}
    >
      {icon && <span className="mt-0.5 flex-shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {/* Secondary, not tertiary: the eyebrow sits on the card's own veil
            (5% black over the chrome), which is darker than the ground the
            tertiary grey is tuned on. Measured 04/10: tertiary 4.13 there,
            secondary 5.12. And 11px, the floor: it was 10. */}
        <div className="text-mini uppercase tracking-wide text-app-text-secondary">{tr(EYEBROW_KEY[kind])}</div>
        {/* IT WRAPS, IT DOES NOT TRUNCATE. The column gives this card about
            244px: "Aggiornamento v2.2.277 disponibile" came out cut after
            "disp", and a version announcement that hides the end of itself is
            worse than a card one line taller. Long unbroken tokens still break
            instead of pushing the layout out. */}
        <div className="break-words font-medium">{title}</div>
        {children}
      </div>
      {onDismiss && (
        // THE CLOSE BUTTON IS A BUTTON, NOT A CHARACTER (04/10: the X of the
        // update notice looked too small, and it was). It was
        // the `×` glyph at 12px: a box of 8x12, and 8x16 under the pointer
        // against the 24x24 of WCAG 2.5.8. Now a 24px box drawn around a
        // small mark (a 14px lucide X), pulled back by `-m-1` into the card's
        // padding so the card does not grow, and `tap-expand` takes it to
        // 44x44 under a finger.
        <button
          type="button"
          onClick={onDismiss}
          className="tap-expand -m-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-app-text-muted hover:bg-app-hover hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          aria-label={tr('banner.dismiss')}
          title={tr('banner.dismiss')}
          data-testid="update-banner-dismiss"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );

  const slot = typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>(docked ? SLOT_SELECTOR : MAIN_SLOT_SELECTOR)
    : null;

  if (slot) {
    return createPortal(
      // Under the panes the row is as wide as the window: the card keeps the
      // width it has in the corner.
      <div role="status" aria-live="polite" className={docked ? undefined : 'w-full max-w-xs'}>{card}</div>,
      slot,
    );
  }

  // Nessuna sidebar in questa finestra: l'angolo, con lo stesso rientro.
  return (
    <div
      // Opaque under the card: its own tint is 5% black, and floating over
      // content the text read on top of whatever was beneath it.
      className="fixed z-50 max-w-xs rounded-lg bg-app-bg shadow-lg"
      style={{ right: ROW_INSET * 2, bottom: ROW_INSET * 2 }}
      role="status"
      aria-live="polite"
    >
      {card}
    </div>
  );
}
