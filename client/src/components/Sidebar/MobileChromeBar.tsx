import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Kanban, LayoutGrid, List, Search, User, type LucideIcon } from 'lucide-react';
import { getPaneConfig } from '@/state/pane/adapters/paneConfig';
import { useMobile } from '@/hooks/useMobile';
import { formaFila, pavimentoFila, raggioSchermo, type FormaScatola } from '@/lib/safeAreaArc';
import { RAISED_CONTROL, SIDEBAR_ACTIVE } from '@/lib/selectionStyles';
import { iniziali, useProfileIdentity } from './useProfileIdentity';

/**
 * LE QUATTRO PORTE, IN FONDO ALLO SCHERMO — cerca · aggiungi · board · profilo.
 *
 * ── PERCHÉ IN BASSO, E PERCHÉ COSÌ POCHE ───────────────────────────────────
 * In alto ci sta poco e ci arriva peggio il pollice: la chrome del telefono
 * tiene lassù il menu «Topics» e la campanella, e porta quaggiù i gesti che si
 * ripetono. Quattro, non otto: la fila non è un cassetto di scorciatoie, è
 * l'elenco delle stanze da cui si riparte.
 *
 * ── LA QUARTA PORTA È IL PROFILO, E PRIMA NON ERA UNA PORTA ────────────────
 * Stava dentro il menu «Topics», cioè dietro un gesto che nessuno fa per
 * cercare il proprio account (chi usa la app, 14/08: «il tasto del profilo, togliendolo
 * dal menu di Topics»). Qui è una faccia, che è il modo in cui un account si
 * riconosce a colpo d'occhio, e porta dove portava prima: Impostazioni →
 * Account e dispositivi. Non è una copia della voce del menu: quella voce non
 * c'è più, altrimenti sarebbero due porte per la stessa stanza.
 *
 * ── IL «BOARD» È UN INTERRUTTORE, NON UN LINK ──────────────────────────────
 * Premuto porta alla Kanban; premuto di nuovo torna alla LISTA — cioè alla
 * colonna dei topic, che sul telefono è a schermo intero ed è dove stanno le
 * tab aperte. Serve anche a una cosa che prima non si poteva fare affatto: «non
 * vedo la possibilità di aprire la Kanban, non vedo il tasto» (chi usa la app, da
 * PWA). Un link solo-andata avrebbe risposto a metà della frase.
 *
 * ── LA FILA SEGUE LA CURVA DELLO SCHERMO ───────────────────────────────────
 * Gli estremi salgono di quanto l'arco dell'angolo mangia alla loro ascissa, e
 * quelli in mezzo non salgono affatto: così la fila può stare a 8px dai bordi
 * invece dei 32 con cui la barra di stato si tiene larga, e nessuno finisce
 * dentro il vetro tondo. Il calcolo — e il perché del raggio stimato dalla
 * fascia — sta tutto in `lib/safeAreaArc.ts`. Su uno schermo squadrato il
 * raggio è zero e la fila torna dritta da sé: nessun ramo dedicato.
 *
 * ── L'ALTEZZA LA PUBBLICA LA BARRA, NON LA RICALCOLA CHI LE STA SOPRA ──────
 * `--mobile-chrome-h` sul documento: la barra si misura e la scrive, la radice
 * dell'app e il cassetto la leggono come `paddingBottom`. Due conti separati
 * per la stessa altezza sono due conti che prima o poi divergono — e il primo a
 * divergere sarebbe proprio quello con l'arco dentro.
 *
 * ── CON LA TASTIERA APERTA NON C'È ─────────────────────────────────────────
 * Sparisce, e con lei la banda riservata: una fila di comandi sopra la tastiera
 * ruba righe al testo che si sta scrivendo, ed è il momento in cui nessuna
 * delle quattro porte serve.
 */

/** L'altezza pubblicata: la leggono la radice dell'app e il cassetto. */
export const MOBILE_CHROME_H_VAR = '--mobile-chrome-h';

/** Rientro laterale della fila. Stretto DI PROPOSITO: è l'arco a tenere gli
 *  estremi fuori dal vetro tondo, non un margine grande abbastanza per tutti. */
const RIENTRO = 8;
/** Aria sopra le scatole, dentro la barra. */
const SOPRA = 6;
/** Altezza di un bottone della fila (h-11). Serve al calcolo della curvatura:
 *  mezza altezza è il massimo raggio che quel bottone può portare. */
const ALTEZZA = 44;
/** Il raggio che ha un tasto quando l'arco non lo tocca — `rounded-xl`. */
const RAGGIO_STANDARD = 12;

const GLIFI: Record<string, LucideIcon> = { Kanban, LayoutGrid, List };
/** Il glifo della board arriva da `PANE_CONFIG`, come per la riga della
 *  sidebar e per la barra delle tab: una copia scritta a mano qui sarebbe il
 *  terzo glifo per la stessa stanza. */
const BoardGlyph = GLIFI[getPaneConfig('board').icon] ?? Kanban;

export interface MobileChromeBarProps {
  /** Apre la palette di ricerca (⌘K). */
  onSearch: () => void;
  /** Il «+»: arriva già montato da App, perché è lo STESSO `PaneAddMenu` del
   *  desktop — un secondo menu «aggiungi» sarebbe un secondo elenco di cose
   *  creabili, e divergerebbe al primo tipo di pane che si aggiunge. */
  addSlot: ReactNode;
  /** La board è la superficie davanti adesso? Decide verso e faccia del tasto. */
  boardInFront: boolean;
  /** L'interruttore: board ⇄ lista. */
  onToggleBoard: () => void;
  /** Apre Impostazioni → Account e dispositivi: la stanza del profilo. */
  onOpenProfile: () => void;
}

export function MobileChromeBar({ onSearch, addSlot, boardInFront, onToggleBoard, onOpenProfile }: MobileChromeBarProps) {
  const { isMobile, keyboardVisible, safeAreaInsets } = useMobile();
  const barraRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [forme, setForme] = useState<FormaScatola[]>([]);

  const attivo = isMobile && !keyboardVisible;

  // Le alzate si ricalcolano quando cambia la LARGHEZZA (rotazione, finestra
  // ridimensionata) o la fascia inferiore. Si leggono i rettangoli veri e non
  // le misure previste: le scatole hanno etichette di lunghezza diversa, e
  // indovinarle qui vorrebbe dire riscrivere il layout del browser a mano.
  const misura = useCallback(() => {
    const barra = barraRef.current;
    if (!barra) return;
    const largo = barra.getBoundingClientRect().width;
    const scatole = slotRefs.current.filter((n): n is HTMLDivElement => !!n).map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.left - barra.getBoundingClientRect().left, larghezza: r.width };
    });
    if (scatole.length === 0) return;
    const raggio = raggioSchermo(
      safeAreaInsets.bottom,
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--screen-corner-radius')),
    );
    const prossime = formaFila({
      larghezza: largo,
      scatole,
      raggio,
      pavimento: pavimentoFila(safeAreaInsets.bottom),
      altezza: ALTEZZA,
      standard: RAGGIO_STANDARD,
    });
    setForme((prec) => (
      prec.length === prossime.length
        && prec.every((v, i) => v.alzata === prossime[i].alzata && v.curvatura === prossime[i].curvatura && v.lato === prossime[i].lato)
        ? prec
        : prossime
    ));
  }, [safeAreaInsets.bottom]);

  useLayoutEffect(() => {
    if (!attivo) return;
    misura();
    // `resize` E l'osservatore, non uno solo. L'osservatore vede cambiare la
    // SCATOLA della barra; il raggio dello schermo invece arriva da una
    // variabile CSS (`--screen-corner-radius`), e cambiarla non muove nessuna
    // scatola — senza l'ascolto diretto, una shell che dichiara il raggio dopo
    // il montaggio non farebbe ricalcolare niente.
    window.addEventListener('resize', misura);
    const barra = barraRef.current;
    if (!barra || typeof ResizeObserver === 'undefined') return () => window.removeEventListener('resize', misura);
    const ro = new ResizeObserver(() => misura());
    ro.observe(barra);
    return () => { ro.disconnect(); window.removeEventListener('resize', misura); };
  }, [attivo, misura]);

  // L'altezza pubblicata. Zero quando la barra non c'è — così la banda
  // riservata sparisce insieme a lei invece di restare come spazio morto.
  useEffect(() => {
    const radice = document.documentElement;
    if (!attivo) {
      radice.style.setProperty(MOBILE_CHROME_H_VAR, '0px');
      return () => radice.style.setProperty(MOBILE_CHROME_H_VAR, '0px');
    }
    const h = barraRef.current?.getBoundingClientRect().height ?? 0;
    radice.style.setProperty(MOBILE_CHROME_H_VAR, `${Math.round(h)}px`);
    return () => radice.style.setProperty(MOBILE_CHROME_H_VAR, '0px');
  }, [attivo, forme]);

  if (!attivo) return null;

  const massima = forme.length
    ? Math.max(...forme.map((f) => f.alzata))
    : pavimentoFila(safeAreaInsets.bottom);
  // Prima della prima misura non si inventa una curva: raggio standard e
  // pavimento minimo, cioè la fila dritta di uno schermo squadrato.
  const forma = (i: number): FormaScatola => forme[i] ?? { alzata: 10, curvatura: RAGGIO_STANDARD, lato: null };

  return (
    <div
      ref={barraRef}
      data-testid="mobile-chrome-bar"
      role="toolbar"
      aria-label="Comandi"
      // `bg-app-chrome` si può dipingere QUI e non dentro la sidebar: questa
      // barra è un fratello della colonna, non un suo figlio, quindi non
      // compone la sua trasparenza con quella del vetro (la trappola descritta
      // su `--chrome-bg`). E comunque esiste solo sotto i 768px, dove la shell
      // mac non arriva.
      className="fixed bottom-0 left-0 right-0 flex items-end justify-between bg-app-chrome border-t border-app-border"
      style={{
        zIndex: 60,
        paddingLeft: `max(${RIENTRO}px, var(--sal))`,
        paddingRight: `max(${RIENTRO}px, var(--sar))`,
        paddingTop: SOPRA,
        height: `${Math.round(SOPRA + 44 + massima)}px`,
      }}
    >
      {/* Le quattro caselle. Il `ref` che le misura sta DENTRO questo componente e
          non in un figlio: scrivere nel ref di qualcun altro passandoglielo
          come prop è la mutazione di un argomento, e il cancello del lint la
          ferma — giustamente, perché renderebbe la misura di questa fila una
          cosa che un altro componente può rompere da fuori. */}
      <div ref={(n) => { slotRefs.current[0] = n; }} className="flex" style={{ marginBottom: forma(0).alzata }}>
        <BottoneFila etichetta="Cerca" onClick={onSearch} testId="mobile-chrome-search" forma={forma(0)}>
          <Search size={22} aria-hidden="true" />
        </BottoneFila>
      </div>

      {/* Il «+» sta in mezzo, dove nessun bordo arriva: il suo raggio è quello
          standard di `triggerVariant="bar"` e non c'è niente da passargli. */}
      <div ref={(n) => { slotRefs.current[1] = n; }} className="flex" style={{ marginBottom: forma(1).alzata }}>
        {addSlot}
      </div>

      <div ref={(n) => { slotRefs.current[2] = n; }} className="flex" style={{ marginBottom: forma(2).alzata }}>
        <BottoneFila
          etichetta={boardInFront ? 'Tab' : 'Task'}
          onClick={onToggleBoard}
          attivo={boardInFront}
          testId="mobile-chrome-board"
          forma={forma(2)}
          // Il tasto dice DOVE PORTA, e lo dice anche a chi non vede: con la
          // board davanti porta indietro alla lista, altrimenti alla board.
          titolo={boardInFront ? 'Torna alla lista delle tab' : 'Apri la lista dei task'}
        >
          {boardInFront ? <List size={22} aria-hidden="true" /> : <BoardGlyph size={22} aria-hidden="true" />}
        </BottoneFila>
      </div>

      {/* La quarta porta è l'ULTIMA, quindi è lei a prendere la curva dell'angolo
          destro: prima ce l'aveva il tasto della board, che adesso sta in mezzo
          e torna standard. Il verso non è scritto qui — lo decide `formaFila`
          guardando da che bordo dista meno — e per questo aggiungere una porta
          non ha richiesto di toccare l'arco. */}
      <div ref={(n) => { slotRefs.current[3] = n; }} className="flex" style={{ marginBottom: forma(3).alzata }}>
        <PortaProfilo onClick={onOpenProfile} forma={forma(3)} />
      </div>
    </div>
  );
}

/**
 * LA PORTA DEL PROFILO — la faccia, e dietro l'account.
 *
 * È un componente a parte, e non due righe dentro la barra, per una ragione che
 * si paga: chiedere «chi sei» è una chiamata di rete, e un hook scritto nel
 * corpo della barra girerebbe anche sul desktop, dove la barra non si disegna
 * affatto (`return null` arriva DOPO gli hook). Montato solo qui, la domanda si
 * fa solo dove la risposta si vede.
 */
function PortaProfilo({ onClick, forma }: { onClick: () => void; forma: FormaScatola }) {
  const { nome, avatarUrl } = useProfileIdentity();
  const sigla = nome ? iniziali(nome) : '';

  return (
    <BottoneFila
      etichetta="Profilo"
      onClick={onClick}
      testId="mobile-chrome-profile"
      forma={forma}
      titolo={nome ? `${nome}. Account e dispositivi` : 'Account e dispositivi'}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="h-[22px] w-[22px] flex-shrink-0 rounded-full object-cover" />
      ) : sigla ? (
        // Le iniziali stanno nella STESSA scatola da 22 del glifo: se il cerchio
        // cambiasse misura con la lunghezza del nome, la fila si muoverebbe da
        // sola al primo login — e le alzate dell'arco si rimisurano su quella
        // larghezza.
        <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-white">
          {sigla}
        </span>
      ) : (
        <User size={22} aria-hidden="true" />
      )}
    </BottoneFila>
  );
}

/**
 * Il bersaglio: 44 di altezza e almeno 64 di larghezza, glifo sopra ed
 * etichetta sotto.
 *
 * L'etichetta non è decorazione. Due icone sole in mezzo a una fascia larga
 * sono un indovinello — è la ragione per cui `PaneAddMenu` ha `triggerLabel` —
 * e qui le stanze sono quattro, di cui una cambia faccia: senza la parola,
 * «Task»/«Tab» sarebbero due glifi che si alternano senza dire perché.
 *
 * ── HANNO LA FACCIA DI UN TASTO, NON DI UN LINK ────────────────────────────
 * `raised-control` + `edge-lit`, cioè la pelle che porta ogni comando
 * dell'app: campitura di un gradino sopra il fondo e il filo di luce in cima.
 * Nascevano piatti — colore solo sotto il dito — e un comando che si vede solo
 * mentre lo premi è un comando che non si trova (chi usa la app: «i tasti devono
 * avere il design classico dei tasti, come il + che c'era»).
 *
 * ── E L'ANGOLO ESTERNO SEGUE L'ARCO DELLO SCHERMO ──────────────────────────
 * `forma.lato` dice quale dei due angoli bassi guarda il bordo tondo e
 * `forma.curvatura` con che raggio, concentrico a quello del vetro. Va scritto
 * INLINE e non come classe: è un numero che cambia col dispositivo e con la
 * rotazione, e Tailwind compila le classi che vede nel sorgente. Il filo di
 * `edge-lit` lo segue da sé — quel bordo eredita il raggio (`inherit`).
 */
function BottoneFila({ etichetta, onClick, children, attivo, testId, titolo, forma }: {
  etichetta: string;
  onClick: () => void;
  children: ReactNode;
  attivo?: boolean;
  testId?: string;
  titolo?: string;
  forma: FormaScatola;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      title={titolo ?? etichetta}
      aria-label={titolo ?? etichetta}
      aria-pressed={attivo}
      className={`edge-lit flex min-w-[64px] h-11 flex-col items-center justify-center gap-0.5 px-3 transition-colors ${
        attivo ? `${SIDEBAR_ACTIVE} text-primary` : `${RAISED_CONTROL} text-app-text`
      }`}
      style={angoliFila(forma)}
    >
      {children}
      <span className="text-[10px] font-medium leading-none">{etichetta}</span>
    </button>
  );
}

/**
 * I quattro raggi di un tasto della fila.
 *
 * Solo l'angolo BASSO esterno cambia: è l'unico che incontra il vetro tondo.
 * Alzare anche quello in alto farebbe una goccia, e in cima non c'è nessun
 * arco da seguire.
 */
function angoliFila({ curvatura, lato }: FormaScatola): { borderRadius: string } {
  const s = `${RAGGIO_STANDARD}px`;
  const c = `${curvatura}px`;
  // Ordine CSS: alto-sinistra, alto-destra, basso-destra, basso-sinistra.
  if (lato === 'sinistra') return { borderRadius: `${s} ${s} ${s} ${c}` };
  if (lato === 'destra') return { borderRadius: `${s} ${s} ${c} ${s}` };
  return { borderRadius: s };
}
