import { useState } from 'react';
import { Pencil, Sigma } from 'lucide-react';
import type { TaskStatus, TaskLabel } from '../../lib/board';
import type { LabelSource } from '../../../../shared/task-labels';
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

/** Il centro del glifo e i due raggi che lo compongono. Numeri INTERI: reso 1:1
 *  (viewBox 14 ⇒ 14px, vedi {@link StatusIcon}) una unità vale un pixel, quindi
 *  ogni bordo cade sul confine di un pixel invece che a metà.
 *
 *  L'anello ha tratto 2 centrato su r=6 ⇒ bordi esatti a 5 e a 7, cioè il bordo
 *  del riquadro. Il settore si ferma a 5, cioè ESATTAMENTE sul bordo interno
 *  dell'anello — ed è QUESTA la correzione, non la misura. Prima il settore si
 *  fermava a 4 e fra torta e anello restava un pixel di fessura: il terzo
 *  dettaglio in sei pixel di raggio, e il primo a diventare poltiglia a 1x.
 *  Senza fessura restano DUE forme, e il «tre quarti» smette di essere un
 *  pac-man dentro un cerchio e diventa un disco pieno con un morso netto («è
 *  tre quarti, ma non preciso», Attilio 08/08). Il disco di `done` arriva a 7,
 *  dove finiva il bordo esterno dell'anello — il pieno occupa esattamente il
 *  posto del vuoto. */
const GLYPH_C = 7;
const GLYPH_R_RING = 6;
const GLYPH_R_SECTOR = 5;

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
 * ── LA MISURA È QUELLA STANDARD DI OGNI GLIFO DI RIGA ───────────────────────
 * 14px, cioè `ROW_GLYPH`: la stessa di ogni icona della sidebar, delle righe
 * utility, dei terminali. «Tutte le icone dovrebbero avere formato standard»
 * (Attilio, 08/08) — un glifo di stato più grosso dei suoi vicini si legge come
 * una cosa di un'altra famiglia. `STATUS_GLYPH_PX` (in `lib/board`) è quella
 * misura per chi deve riservargli spazio.
 *
 * ── COSA È CAMBIATO, VISTO CHE LA MISURA È LA STESSA DI PRIMA ───────────────
 * Il taglio precedente era ANCHE lui a 14 ed era poltiglia a 1x. Non era la
 * misura: erano tre forme in sei pixel di raggio. Misurato:
 *   · il tratteggio del backlog erano DIECI trattini da 1,9px — specchi grigi,
 *     non un anello;
 *   · fra la torta (r=4) e l'anello (interno a 5) restava un pixel di fessura,
 *     che l'antialiasing riempiva di alone;
 *   · il «tre quarti» aveva raggi lunghi 4px, cioè un morso da 4×4:
 *     illeggibile come frazione.
 * Togliendo la fessura — torta a FILO dell'anello — restano due forme, i raggi
 * del morso passano a 5px e il tratteggio a CINQUE trattini da 3,8px. Un
 * passaggio intermedio a 16px risolveva le stesse tre cose facendo crescere il
 * disegno; a 14 le risolve stando nella griglia di tutti gli altri, che è la
 * versione giusta.
 *
 * L'UNICA riduzione ammessa era `h-3 w-3` nelle righe dense, e non serve più:
 * a 14 il glifo sta nelle righe da 11px come ci sta ogni altro glifo dell'app.
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
          <path d="M4.3 7.2l1.8 1.8 3.6-3.9" fill="none" stroke="#171717" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle
            cx={GLYPH_C} cy={GLYPH_C} r={GLYPH_R_RING} fill="none" stroke="currentColor" strokeWidth="2"
            // `pathLength={20}` con tratti «2 2»: CINQUE trattini esatti, chiusi
            // sul giro, da 3,8px l'uno. `pathLength` normalizza la circonferenza
            // vera (37,70) a 20, quindi il passo è esatto e il pattern non si
            // richiude con un trattino tronco. Il numero è misurato, non scelto:
            // a 8 e a 10 trattini il tratto scende sotto i 2,4px e a 1x diventa
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

/**
 * Il chip di un'etichetta. Due famiglie, e si vedono diverse perché fanno cose
 * diverse: `visibile`/`invisibile` DECIDONO chi chiude la card (e portano il
 * loro perché nel title), le altre servono solo a leggere e filtrare la board.
 *
 * `source` non è decorazione: un'etichetta `derived` è una misura che la
 * consegna successiva può riscrivere, una `human` è una decisione che resta —
 * e chi guarda la card deve poter distinguere le due prima di fidarsi.
 */
export function LabelChip({ label, source }: { label: TaskLabel; source: LabelSource }) {
  const closer = label === 'visibile' || label === 'decisione' || label === 'invisibile';
  const cls = label === 'invisibile'
    ? 'bg-slate-500/20 text-slate-300'
    : label === 'visibile'
      ? 'bg-sky-500/15 text-sky-300'
      : label === 'decisione'
        ? 'bg-violet-500/15 text-violet-300'
        : 'bg-white/10 text-app-text-heading';
  const why = label === 'invisibile'
    ? 'Non tocca nessuna riga di client/src: con la barra verde la può chiudere il conduttore.'
    : label === 'visibile'
      ? 'Tocca una superficie che si vede: resta in review finché non la guarda un umano.'
      : label === 'decisione'
        ? 'Un piano, una ricerca, un documento, o nessun codice affatto: la decide un umano, sempre.'
        : null;
  const origin = source === 'derived'
    ? 'Derivata dal diff della consegna'
    : source === 'agent' ? "Chiesta dall'agent" : 'Messa a mano';
  return (
    <span
      data-testid={`card-label-${label}`}
      title={why ? `${why} (${origin})` : origin}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs md:text-[11px] ${cls}`}
    >
      {closer && (source === 'derived' ? <Sigma className="h-3 w-3" aria-hidden /> : <Pencil className="h-3 w-3" aria-hidden />)}
      {label}
    </span>
  );
}
