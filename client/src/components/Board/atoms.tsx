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

/** Il centro del glifo e i due raggi che lo compongono. Numeri INTERI su una
 *  griglia PARI: reso 1:1 (viewBox 16 ⇒ 16px, vedi {@link StatusIcon}) una
 *  unità vale un pixel, quindi ogni bordo cade sul confine di un pixel invece
 *  che a metà.
 *
 *  L'anello ha tratto 2 centrato su r=7 ⇒ bordi esatti a 6 e a 8, cioè il
 *  bordo del riquadro. Il settore si ferma a 6, cioè ESATTAMENTE sul bordo
 *  interno dell'anello: è la differenza che conta rispetto al taglio a 14, dove
 *  fra torta e anello restava una fessura da un pixel. A quella misura la
 *  fessura non era un dettaglio — era il terzo dettaglio in sette pixel di
 *  raggio, e il primo a diventare poltiglia a 1x. Senza fessura restano DUE
 *  forme, e il «tre quarti» smette di essere un pac-man dentro un cerchio e
 *  diventa un disco pieno con un morso netto («è tre quarti, ma non preciso»,
 *  Attilio 08/08). Il disco di `done` arriva a 8, dove finiva il bordo esterno
 *  dell'anello — il pieno occupa esattamente il posto del vuoto. */
const GLYPH_C = 8;
const GLYPH_R_RING = 7;
const GLYPH_R_SECTOR = 6;

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
 * ── VA RESO A 16px, NON MENO ────────────────────────────────────────────────
 * Il viewBox è 16 e il default lo rende a 16 (`h-4`): a quel punto una unità
 * del disegno VALE un pixel e ogni misura qui sopra cade dove è scritta.
 * Rimpicciolirlo riporta i bordi a cavallo di due pixel, ed è così che il
 * tratteggio del backlog torna poltiglia su uno schermo 1x. `STATUS_GLYPH_PX`
 * (in `lib/board`) è quella misura, in un posto solo, per chi deve riservargli
 * spazio.
 *
 * L'UNICA riduzione ammessa è `h-3 w-3` (12px) nelle righe dense — elenco dei
 * sottotask, cronologia dei cambi di stato — e vale perché 12/16 fa ESATTAMENTE
 * 0,75: il tratto da 2 diventa 1,5 e i raggi cadono su quarti di pixel, non su
 * frazioni qualunque. Ogni altra misura intermedia (14, 15) rimette i bordi a
 * cavallo di due pixel ed è il difetto da cui questo taglio esce.
 *
 * ── PERCHÉ 16 E NON 14 ──────────────────────────────────────────────────────
 * Misurato a 1x, il taglio a 14 aveva tre difetti che vengono tutti dalla
 * stessa causa — troppe forme in troppo pochi pixel:
 *   · il tratteggio del backlog erano DIECI trattini da 1,9px: specchi grigi,
 *     non un anello;
 *   · fra la torta (r=4) e l'anello (interno a 5) restava un pixel di fessura,
 *     che l'antialiasing riempiva di alone;
 *   · il «tre quarti» aveva raggi lunghi 4px, cioè un morso da 4×4: illeggibile
 *     come frazione.
 * A 16 con la torta a filo dell'anello restano due forme sole, i raggi del
 * morso passano a 6px e il tratteggio a CINQUE trattini da 4,5px.
 *
 * `shape-rendering="geometricPrecision"` perché il default (`auto`) lascia al
 * motore la libertà di aggrapparsi alla griglia: su archi e tratteggi quel
 * ritocco sposta gli estremi di mezzo pixel ciascuno, che è proprio ciò che
 * qui sopra si è appena finito di allineare a mano.
 */
export function StatusIcon({ status, className = 'h-4 w-4' }: { status: TaskStatus; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      shapeRendering="geometricPrecision"
      className={`${className} shrink-0 ${STATUS_ICON_COLOR[status]}`}
    >
      {status === 'done' ? (
        <>
          <circle cx={GLYPH_C} cy={GLYPH_C} r={GLYPH_C} fill="currentColor" />
          <path d="M4.9 8.2l2.1 2.1 4.1-4.4" fill="none" stroke="#171717" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle
            cx={GLYPH_C} cy={GLYPH_C} r={GLYPH_R_RING} fill="none" stroke="currentColor" strokeWidth="2"
            // `pathLength={20}` con tratti «2 2»: CINQUE trattini esatti, chiusi
            // sul giro, da 4,5px l'uno. `pathLength` normalizza la circonferenza
            // vera (43,98) a 20, quindi il passo è esatto e il pattern non si
            // richiude con un trattino tronco. Il numero è misurato, non scelto:
            // a 8 e a 10 trattini il tratto scende sotto i 3px e a 1x diventa
            // una fila di specchi; a 4 l'anello si legge come quattro tacche.
            {...(status === 'backlog' ? { pathLength: 20, strokeDasharray: '2 2' } : {})}
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
