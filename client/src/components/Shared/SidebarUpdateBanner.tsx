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
import { ROW_INSET } from '@/lib/selectionStyles';
import { useT } from '../../hooks/useT';

const SLOT_SELECTOR = '[data-update-slot]';

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
            ? 'bg-red-500/10 text-red-700 dark:text-red-300'
            : 'bg-black/[0.05] dark:bg-white/[0.06] text-app-text'
      }`}
    >
      {icon && <span className="mt-0.5 flex-shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-micro uppercase tracking-wide text-app-text-tertiary">{tr(EYEBROW_KEY[kind])}</div>
        {/* IT WRAPS, IT DOES NOT TRUNCATE. The column gives this card about
            244px: "Aggiornamento v2.2.277 disponibile" came out cut after
            "disp", and a version announcement that hides the end of itself is
            worse than a card one line taller. Long unbroken tokens still break
            instead of pushing the layout out. */}
        <div className="break-words font-medium">{title}</div>
        {children}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="tap-expand-y flex-shrink-0 leading-none text-app-text-muted hover:text-app-text"
          aria-label="Ignora"
        >
          ×
        </button>
      )}
    </div>
  );

  const slot = typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>(SLOT_SELECTOR)
    : null;

  if (slot) {
    return createPortal(
      <div role="status" aria-live="polite">{card}</div>,
      slot,
    );
  }

  // Nessuna sidebar in questa finestra: l'angolo, con lo stesso rientro.
  return (
    <div
      className="fixed z-50 max-w-xs"
      style={{ right: ROW_INSET * 2, bottom: ROW_INSET * 2 }}
      role="status"
      aria-live="polite"
    >
      {card}
    </div>
  );
}
