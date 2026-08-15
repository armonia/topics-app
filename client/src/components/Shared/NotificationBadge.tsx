/**
 * NotificationBadge — small primary-coloured pill showing an unread or
 * activity count. Single canonical look across the app (sidebar topic
 * row, sidebar project row, sidebar section header, top tab bar).
 *
 * - Auto-hides when count <= 0 (the parent doesn't have to gate the
 *   render conditionally; this matches the previous inline contract at
 *   every call site).
 * - Caps display at "99+" so a runaway counter doesn't blow the layout.
 *
 * Don't roll your own pill in a new surface — drop this in. If you
 * genuinely need a different colour or size, extend with a variant
 * prop rather than copy-pasting the className.
 */

interface NotificationBadgeProps {
  count: number;
  /** Extra wrapper classes (margins, visibility toggles like
   *  `group-hover/proj:hidden`). */
  className?: string;
  /** Optional accessible label override; defaults to "{n} unread". */
  ariaLabel?: string;
  /** Optional tooltip. */
  title?: string;
  /** `onFill` = the badge sits ON an attention fill (amber/blue). Use a
   *  translucent-white pill so it stays legible instead of the default
   *  primary-blue, which rendered blue-on-blue (invisible) on the awaiting fill. */
  variant?: 'default' | 'onFill';
}

export function NotificationBadge({ count, className = '', ariaLabel, title, variant = 'default' }: NotificationBadgeProps) {
  if (count <= 0) return null;
  const display = count > 99 ? '99+' : String(count);
  // `onFill`: a translucent-black pill + white text reads on BOTH attention
  // fills (dark-text amber AND white-text blue), where the default primary-blue
  // pill went blue-on-blue (invisible) on the awaiting surface.
  const tone = variant === 'onFill'
    ? 'bg-black/35 text-white'
    : 'bg-primary text-white';
  return (
    <span
      // Il conteggio come DATO, accanto al conteggio come testo. `aria-label` è
      // una frase tradotta: un test che ci si aggancia si rompe il giorno in cui
      // la frase si riscrive, e nel frattempo la frase non si può più migliorare
      // (vedi tests/e2e/CONVENTIONS.md → «Never anchor on translated copy»).
      // Questo attributo non parla nessuna lingua ed è il segnale su cui
      // agganciarsi.
      data-notification-count={display}
      // `leading-4` e non `leading-none`, ed è la ragione per cui il numero non
      // stava al centro del pallino: con `leading-none` la riga di testo è alta
      // quanto il carattere (11px) dentro una pastiglia da 16, quindi nasce a
      // (16 − 11) / 2 = 2,5px — mezzo pixel — e la cifra si posa mezza riga di
      // sub-pixel più in basso del centro del cerchio (misurato: +0,62px).
      // Con l'interlinea PARI all'altezza della pastiglia la riga non ha
      // mezze-guide da scavalcare e il conto torna intero. Resta anche ora che
      // c'è `cap-box`: è ciò che tiene decente la pastiglia sui motori dove
      // `text-box-*` non esiste ancora.
      //
      // …ma da solo non bastava, e il resto lo faceva vedere solo il runner
      // Linux. Qualunque centratura verticale — `items-center` come
      // `content-center` — centra la LINE BOX, e dentro la line box il motore
      // posa il testo per BASELINE: l'inchiostro di una cifra, che sta tutto
      // sopra la baseline, cade fuori asse di una quantità fatta di sole
      // metriche del font (ascent, descent, altezza della cifra; la formula
      // esatta è accanto alla utility, in index.css). Con la pila UI di macOS
      // vale +0,12px e non si vede; con quella che risolve un Linux (profilo
      // DejaVu: ascent 10, descent 3 a 11px) vale −1px su un pallino da 16, e
      // si vede. `cap-box` stringe la line box a cap-height→baseline, cioè al
      // rettangolo che l'occhio chiama «la cifra»: centrare quello è centrare
      // la cifra, su qualunque font. I numeri, font per font, stanno accanto
      // alla utility in index.css.
      //
      // `cap-box` porta anche il `display` e la centratura — al posto di
      // `flex items-center justify-center`, che non c'è più qui: la trim agisce
      // sulle line box del proprio blocco, e in un flex il testo nudo sta in un
      // item anonimo che nessuna regola raggiunge (verificato: con `flex` la
      // trim non sposta un centesimo). Le due centrature, quella nuova e quella
      // di prima come fallback, stanno nella stessa regola apposta: separate,
      // a decidere sarebbe l'ordine dentro `@layer utilities`.
      className={`flex-shrink-0 ${tone} text-[11px] font-semibold rounded-full min-w-[16px] h-4 cap-box px-1 leading-4 tabular-nums ${className}`}
      aria-label={ariaLabel ?? `${count} unread`}
      title={title}
    >
      {display}
    </span>
  );
}
