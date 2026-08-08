import { useState } from 'react';
import type { TaskStatus } from '../../lib/board';
import { STATUS_ICON_COLOR, DISPATCH_CHIP } from './constants';
import { memorableId } from '../../lib/memorableId';

/**
 * Memorable, click-to-copy task id chip — shown in the card eyebrow AND the
 * drawer, after the project. Displays a stable adjective-noun slug (e.g.
 * "brave-otter") so a task is recognisable at a glance; clicking copies the
 * FULL UUID (the actionable key for the API / deep links). stopPropagation so
 * copying never opens/navigates the card.
 */
export function TaskIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        try { void navigator.clipboard?.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
      }}
      title={copied ? 'ID copiato' : `${memorableId(id)} · clicca per copiare l'ID pieno (${id})`}
      className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-xs leading-none text-app-text-muted hover:bg-white/10 hover:text-app-text-heading md:text-[10px]"
    >{copied ? 'copiato ✓' : memorableId(id)}</button>
  );
}

/** Il centro del glifo, e i tre raggi che lo compongono. Numeri INTERI, e non
 *  per estetica: reso 1:1 (viewBox 14 ⇒ 14px, vedi {@link StatusIcon}) una
 *  unità vale un pixel, quindi un bordo a 5 o a 7 cade sul confine di un pixel
 *  invece che a metà. L'anello ha tratto 2 centrato su r=6 ⇒ bordi esatti a 5 e
 *  a 7; il settore si ferma a 4, cioè UN pixel pieno di fessura dal bordo
 *  interno dell'anello (prima erano quattro decimi, e a 1x si leggevano come un
 *  alone); il disco di `done` arriva a 7, dove finiva il bordo esterno
 *  dell'anello — il pieno occupa esattamente il posto del vuoto. */
const GLYPH_C = 7;
const GLYPH_R_RING = 6;
const GLYPH_R_SECTOR = 4;

/**
 * Un SETTORE vero — non un cerchio tratteggiato spesso.
 *
 * Il taglio precedente disegnava la torta come un anello da r=2.4 con tratto
 * 4.8 e `strokeDasharray` sulla percentuale, e portava tre difetti insieme:
 * il tratto si auto-sovrappone sull'apice (r=0) e il rasterizzatore ci lascia
 * una tacca; il bordo esterno restava a 4.8 contro i 5.2 dell'anello, cioè una
 * fessura da 0,4 che a 1x diventa un alone; e il dash è misurato sulla Bezier
 * che APPROSSIMA il cerchio, quindi il 75% cade a una frazione di grado dal
 * 270° esatto.
 *
 * Un arco esplicito è esatto per costruzione a qualunque percentuale: niente
 * `pathLength`, niente dasharray, niente apice sovrapposto, bordo pieno netto.
 * Parte da mezzogiorno e cresce in senso orario, come il glifo Linear che
 * questa famiglia cita.
 */
function sectorPath(pct: number): string {
  const a = (2 * Math.PI * pct) / 100;
  const x = GLYPH_C + GLYPH_R_SECTOR * Math.sin(a);
  const y = GLYPH_C - GLYPH_R_SECTOR * Math.cos(a);
  // `1` sul flag large-arc appena si supera il mezzo giro: sotto, l'arco corto
  // è quello giusto; sopra, il lungo.
  const large = pct > 50 ? 1 : 0;
  return `M${GLYPH_C},${GLYPH_C} L${GLYPH_C},${GLYPH_C - GLYPH_R_SECTOR} ` +
    `A${GLYPH_R_SECTOR},${GLYPH_R_SECTOR} 0 ${large} 1 ${x.toFixed(3)},${y.toFixed(3)} Z`;
}

/**
 * Linear-style status glyph — the segmented progress circle that became the
 * de-facto standard for issue states (dashed ring → empty ring → half pie →
 * ¾ pie → checked disc). One shape family, color + fill carry the state, so
 * the eye reads progress at a glance: il colore da solo direbbe «rosso», non
 * direbbe «review» né in che ordine vengono le colonne.
 *
 * ── VA RESO A 14px, NON A 12 ────────────────────────────────────────────────
 * Il viewBox è 14 e il default lo rende a 14 (`h-3.5`): a quel punto una unità
 * del disegno VALE un pixel e ogni misura qui sotto cade dove è scritta. A 12
 * — l'override che la sidebar si portava dietro — la scala è 0,857 e il tratto
 * dell'anello finisce a cavallo di due pixel: su uno schermo 1x il tratteggio
 * del backlog diventa poltiglia. Sulle card della board era già 1:1, ed è per
 * questo che lì si vedeva e nella sidebar no. Chi lo usa NON deve rimpicciolirlo.
 *
 * `shape-rendering="geometricPrecision"` perché il default (`auto`) lascia al
 * motore la libertà di aggrapparsi alla griglia: su archi e tratteggi quel
 * ritocco sposta gli estremi di mezzo pixel ciascuno, che è proprio ciò che
 * qui sopra si è appena finito di allineare a mano.
 */
export function StatusIcon({ status, className = 'h-3.5 w-3.5' }: { status: TaskStatus; className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      shapeRendering="geometricPrecision"
      className={`${className} shrink-0 ${STATUS_ICON_COLOR[status]}`}
    >
      {status === 'done' ? (
        <>
          <circle cx={GLYPH_C} cy={GLYPH_C} r={GLYPH_C} fill="currentColor" />
          <path d="M4.3 7.3l1.8 1.8 3.6-3.9" fill="none" stroke="#171717" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle
            cx={GLYPH_C} cy={GLYPH_C} r={GLYPH_R_RING} fill="none" stroke="currentColor" strokeWidth="2"
            // `pathLength={40}` con tratti «2 2»: DIECI trattini esatti, chiusi
            // sul giro. La circonferenza vera (37,699) non è multipla del passo
            // 2,4+2,6 di prima, quindi il pattern si richiudeva su sé stesso con
            // un trattino tronco — e i cappucci tondi allungavano ogni tratto di
            // 0,8 per lato fino a saldarli fra loro. Cappucci netti, passo esatto.
            {...(status === 'backlog' ? { pathLength: 40, strokeDasharray: '2 2' } : {})}
          />
          {status === 'in_progress' && <path d={sectorPath(50)} fill="currentColor" />}
          {status === 'review' && <path d={sectorPath(75)} fill="currentColor" />}
        </>
      )}
    </svg>
  );
}

/** Dispatch-state chip: state label + (optional) icon. DRYs the card + drawer
 *  render sites so both stay in lockstep. 'delivered' carries a PackageCheck
 *  glyph so "consegnato" reads at a glance, not just as colored text. */
export function DispatchChip({ state, error }: { state: string; error?: string | null }) {
  const chip = DISPATCH_CHIP[state];
  if (!chip) return null;
  const Icon = chip.Icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs md:text-[11px] ${chip.cls}`}
      title={chip.title ?? error ?? undefined}
    >
      {Icon && <Icon className="h-3 w-3" aria-hidden />}
      {chip.text}
    </span>
  );
}
