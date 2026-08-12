import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Kanban, LayoutGrid, List, Search, type LucideIcon } from 'lucide-react';
import { getPaneConfig } from '@/state/pane/adapters/paneConfig';
import { useMobile } from '@/hooks/useMobile';
import { alzateFila, pavimentoFila, raggioSchermo } from '@/lib/safeAreaArc';
import { SIDEBAR_ACTIVE, SIDEBAR_HOVER } from '@/lib/selectionStyles';

/**
 * LE TRE PORTE, IN FONDO ALLO SCHERMO — cerca · aggiungi · board.
 *
 * ── PERCHÉ IN BASSO, E PERCHÉ SOLO TRE ─────────────────────────────────────
 * In alto ci sta poco e ci arriva peggio il pollice: la chrome del telefono
 * tiene lassù una cosa sola (il menu «Topics») e porta quaggiù i gesti che si
 * ripetono. Tre, non cinque: la fila non è un cassetto di scorciatoie, è
 * l'elenco delle stanze da cui si riparte.
 *
 * ── IL «BOARD» È UN INTERRUTTORE, NON UN LINK ──────────────────────────────
 * Premuto porta alla Kanban; premuto di nuovo torna alla LISTA — cioè alla
 * colonna dei topic, che sul telefono è a schermo intero ed è dove stanno le
 * tab aperte. Serve anche a una cosa che prima non si poteva fare affatto: «non
 * vedo la possibilità di aprire la Kanban, non vedo il tasto» (Attilio, da
 * PWA). Un link solo-andata avrebbe risposto a metà della frase.
 *
 * ── LA FILA SEGUE LA CURVA DELLO SCHERMO ───────────────────────────────────
 * Gli estremi salgono di quanto l'arco dell'angolo mangia alla loro ascissa, e
 * quello in mezzo non sale affatto: così la fila può stare a 8px dai bordi
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
 * delle tre porte serve.
 */

/** L'altezza pubblicata: la leggono la radice dell'app e il cassetto. */
export const MOBILE_CHROME_H_VAR = '--mobile-chrome-h';

/** Rientro laterale della fila. Stretto DI PROPOSITO: è l'arco a tenere gli
 *  estremi fuori dal vetro tondo, non un margine grande abbastanza per tutti. */
const RIENTRO = 8;
/** Aria sopra le scatole, dentro la barra. */
const SOPRA = 6;

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
}

export function MobileChromeBar({ onSearch, addSlot, boardInFront, onToggleBoard }: MobileChromeBarProps) {
  const { isMobile, keyboardVisible, safeAreaInsets } = useMobile();
  const barraRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [alzate, setAlzate] = useState<number[]>([]);

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
    const prossime = alzateFila({
      larghezza: largo,
      scatole,
      raggio,
      pavimento: pavimentoFila(safeAreaInsets.bottom),
    });
    setAlzate((prec) => (
      prec.length === prossime.length && prec.every((v, i) => v === prossime[i]) ? prec : prossime
    ));
  }, [safeAreaInsets.bottom]);

  useLayoutEffect(() => {
    if (!attivo) return;
    misura();
    const barra = barraRef.current;
    if (!barra || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => misura());
    ro.observe(barra);
    return () => ro.disconnect();
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
  }, [attivo, alzate]);

  if (!attivo) return null;

  const massima = alzate.length ? Math.max(...alzate) : pavimentoFila(safeAreaInsets.bottom);

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
      {/* Le tre caselle. Il `ref` che le misura sta DENTRO questo componente e
          non in un figlio: scrivere nel ref di qualcun altro passandoglielo
          come prop è la mutazione di un argomento, e il cancello del lint la
          ferma — giustamente, perché renderebbe la misura di questa fila una
          cosa che un altro componente può rompere da fuori. */}
      <div ref={(n) => { slotRefs.current[0] = n; }} className="flex" style={{ marginBottom: alzate[0] ?? 10 }}>
        <BottoneFila etichetta="Cerca" onClick={onSearch} testId="mobile-chrome-search">
          <Search size={22} aria-hidden="true" />
        </BottoneFila>
      </div>

      <div ref={(n) => { slotRefs.current[1] = n; }} className="flex" style={{ marginBottom: alzate[1] ?? 10 }}>
        {addSlot}
      </div>

      <div ref={(n) => { slotRefs.current[2] = n; }} className="flex" style={{ marginBottom: alzate[2] ?? 10 }}>
        <BottoneFila
          etichetta={boardInFront ? 'Tab' : 'Board'}
          onClick={onToggleBoard}
          attivo={boardInFront}
          testId="mobile-chrome-board"
          // Il tasto dice DOVE PORTA, e lo dice anche a chi non vede: con la
          // board davanti porta indietro alla lista, altrimenti alla board.
          titolo={boardInFront ? 'Torna alla lista delle tab' : 'Apri la Kanban'}
        >
          {boardInFront ? <List size={22} aria-hidden="true" /> : <BoardGlyph size={22} aria-hidden="true" />}
        </BottoneFila>
      </div>
    </div>
  );
}

/**
 * Il bersaglio: 44 di altezza e almeno 64 di larghezza, glifo sopra ed
 * etichetta sotto.
 *
 * L'etichetta non è decorazione. Due icone sole in mezzo a una fascia larga
 * sono un indovinello — è la ragione per cui `PaneAddMenu` ha `triggerLabel` —
 * e qui le stanze sono tre, di cui una cambia faccia: senza la parola,
 * «Board»/«Tab» sarebbero due glifi che si alternano senza dire perché.
 */
function BottoneFila({ etichetta, onClick, children, attivo, testId, titolo }: {
  etichetta: string;
  onClick: () => void;
  children: ReactNode;
  attivo?: boolean;
  testId?: string;
  titolo?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      title={titolo ?? etichetta}
      aria-label={titolo ?? etichetta}
      aria-pressed={attivo}
      className={`flex min-w-[64px] h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-3 transition-colors ${
        attivo ? `${SIDEBAR_ACTIVE} text-primary` : `${SIDEBAR_HOVER} text-app-text`
      }`}
    >
      {children}
      <span className="text-[10px] font-medium leading-none">{etichetta}</span>
    </button>
  );
}
