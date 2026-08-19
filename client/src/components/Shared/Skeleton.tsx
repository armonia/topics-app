/**
 * Gli SCHELETRI dell'attesa — e la regola che li rende diversi da una girella.
 *
 * Uno spinner dice «aspetta» e non dice altro; uno scheletro dice già che forma
 * avrà la cosa. Ma questo vale solo se le sue misure sono LE MISURE DEL
 * CONTENUTO VERO: uno scheletro alto 32px davanti a una riga alta 34 non toglie
 * il salto, lo rimanda — è un layout shift col cappello.
 *
 * Da cui l'unica regola di questo file: le misure non si scrivono a mano, si
 * IMPORTANO da dove le scrive il contenuto vero (`ROW_H` & co. per le righe di
 * sidebar, le stesse classi del messaggio per la chat). Se la riga cambia
 * altezza, lo scheletro la segue senza che nessuno se ne ricordi.
 */
import { ROW_H, ROW_PX, ROW_GAP } from '@/lib/selectionStyles';

// Fixed, varied widths (%) cycled by row index so the placeholder list looks
// staggered without an impure Math.random() call during render.
const SKELETON_WIDTHS = [78, 56, 88, 64, 72, 50, 84, 60];
/** La seconda riga (l'anteprima dell'ultimo messaggio) è sempre più corta del
 *  nome: stesso ciclo, spostato, così le due righe non finiscono mai pari. */
const SKELETON_SUB_WIDTHS = [52, 71, 44, 63, 38, 58, 49, 67];

/**
 * La barretta grigia, e il suo rialzo è quello DI CASA: la coppia
 * `bg-black/N dark:bg-white/N` che `index.css` fissa come rialzo tema-agnostico
 * (un `bg-white/N` bare sparirebbe in tema chiaro).
 *
 * `/10` e non `/8`: `board-theme.spec.ts` verifica quella coppia iniettandola a
 * runtime e dando per scontato che sia già nel bundle — e con Tailwind JIT una
 * classe sta nel bundle solo se QUALCUNO la scrive. Finora l'unico a scriverla
 * in tutto il client era lo scheletro inline della chat, che questo file ha
 * sostituito: passare a `/8` l'ha fatta sparire dal CSS compilato e quel test è
 * diventato rosso senza che nessuno avesse toccato un tema. Se un giorno serve
 * cambiarla, si controlla prima `git grep dark:bg-white/10`.
 */
const BAR = 'rounded bg-black/10 dark:bg-white/10';

/**
 * L'elenco delle chat in sidebar mentre arriva.
 *
 * `ROW_H` / `ROW_PX` / `ROW_GAP` sono le stesse costanti di `TopicItem`: la
 * riga finta è alta ESATTAMENTE quanto quella vera (44 sul telefono, 34 sul
 * desktop), gliifo compreso. E ha DUE righe di testo, perché la riga vera ne ha
 * due — nome sopra, anteprima sotto: disegnarne una sola qui significava
 * promettere una riga bassa e consegnarne una alta.
 */
export function SkeletonTopicList({ count = 5 }: { count?: number }) {
  return (
    <div className="px-2 py-1 space-y-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`flex items-center ${ROW_GAP} ${ROW_H} ${ROW_PX} animate-pulse`}>
          <div className={`w-5 h-5 flex-shrink-0 ${BAR}`} />
          {/* Stessa impaginazione verticale del contenuto vero: 13 + 3 + 11
              (vedi il blocco nome/subline in TopicItem). */}
          <div className="flex-1 min-w-0 flex flex-col justify-center gap-[3px]">
            <div
              className={`h-3 ${BAR}`}
              // Deterministic per-row width (was Math.random() during render,
              // which is impure and re-rolled every re-render). A fixed cycle of
              // widths keyed on the row index keeps the staggered look while
              // staying pure and stable across re-renders.
              style={{ width: `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%` }}
            />
            <div
              className={`h-2 ${BAR} hidden md:block`}
              style={{ width: `${SKELETON_SUB_WIDTHS[i % SKELETON_SUB_WIDTHS.length]}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * L'ELENCO GENERICO — un albero di file, una lista di modifiche Git, qualunque
 * colonna di righe tutte uguali.
 *
 * `rowClassName` non ha un default apposta: le misure della riga (padding,
 * `min-h`, gap) le passa CHI CHIAMA, copiandole dalla propria riga vera. È
 * l'unico modo perché lo scheletro resti realistico quando quella riga cambia,
 * ed è quello che rende questo componente riusabile senza diventare una
 * seconda fonte di verità sulle altezze.
 *
 * `depths` disegna l'indentazione di un albero (uno step = 12px, come
 * `SIDEBAR_INDENT_STEP`): senza, un albero di file finto sarebbe una colonna
 * piatta, cioè la promessa sbagliata.
 */
export function SkeletonRows({ count = 8, rowClassName, glyph = 14, indentStep = 0, depths }: {
  count?: number;
  rowClassName: string;
  /** Lato del quadratino che sta al posto dell'icona. 0 = nessuna icona. */
  glyph?: number;
  /** Pixel per livello di profondità. 0 = lista piatta. */
  indentStep?: number;
  /** La profondità di ogni riga; ciclata se più corta di `count`. */
  depths?: number[];
}) {
  return (
    <div aria-hidden="true" className="py-1 overflow-hidden">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`${rowClassName} animate-pulse`}
          style={depths && indentStep ? { paddingLeft: `${depths[i % depths.length] * indentStep + 8}px` } : undefined}
        >
          {glyph > 0 && (
            <div className={`flex-shrink-0 ${BAR}`} style={{ width: glyph, height: glyph }} />
          )}
          <div
            className={`h-3 ${BAR}`}
            style={{ width: `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Le altezze delle bolle finte, in pixel di CONTENUTO (senza il padding della
 * bolla, che le classi aggiungono sotto).
 *
 * Non sono inventate: una riga di testo della chat è 13px con interlinea ~19, e
 * i valori qui sotto sono 1, 3, 2, 5 e 2 righe — la forma di uno scambio vero,
 * dove le domande sono corte e le risposte no. Servono ad avere un'ALTEZZA
 * TOTALE plausibile: lo scheletro riempie il fondo della lista, e se fosse più
 * basso del contenuto vero il primo frame di contenuto lo vedresti crescere.
 */
const BUBBLE_LINES = [2, 5, 2, 3, 1];

/**
 * La chat mentre la lista si monta.
 *
 * DAL BASSO, come la chat vera: una conversazione è ancorata al fondo, e uno
 * scheletro allineato in cima prometterebbe il contrario di ciò che arriva.
 *
 * LE DUE FASCE CHE NON SONO SUE. Il contenitore del trascritto
 * (`.chat-under-chrome`) si prende TUTTA la cella: risale sotto la barra di
 * chrome con un margine negativo e continua sotto il composer, che gli sta
 * sopra in `absolute bottom-0`. Il contenuto vero non ci finisce dentro perché
 * Virtuoso apre un Header alto `--chat-gutter` e un Footer alto
 * `inputAreaHeight + CHAT_BOTTOM_GUTTER_PX`. Questo scheletro è un fratello
 * `absolute` dello scroller, quindi quei due varchi non li eredita: con
 * `inset-0` nasceva mezzo coperto dal vetro in cima e con le bolle basse
 * dietro al composer, cioè l'attesa mostrava una forma che il contenuto vero
 * non ha mai avuto.
 *
 * Il rientro è sul BOX (`top`/`bottom`), non su un padding: `overflow-hidden`
 * taglia al bordo del padding, quindi con `justify-end` una pila di bolle più
 * alta dello spazio disponibile sarebbe rispuntata DENTRO il padding, sotto la
 * barra. Spostando i bordi il taglio cade dove deve.
 *
 * `chat-measure` e `px-4`/`px-2` sono le stesse dei messaggi: la colonna finta
 * cade esattamente dove cadrà quella vera, quindi non c'è un movimento
 * orizzontale al momento del cambio.
 */
export function SkeletonChatMessages({ isMobile = false, count = BUBBLE_LINES.length, bottomInset = 24 }: {
  isMobile?: boolean;
  count?: number;
  /**
   * La fascia in fondo che il composer occupa, in px: la passa CHI CHIAMA
   * perché l'altezza del composer la misura solo lui (`inputAreaHeight`), e
   * ci somma lo stesso gutter del Footer vero. Il default è il solo gutter,
   * per una lista montata dove non c'è nessun composer sopra.
   */
  bottomInset?: number;
}) {
  const righe = BUBBLE_LINES.slice(-count);
  return (
    <div
      aria-hidden="true"
      data-testid="chat-skeleton"
      className={`absolute inset-x-0 flex flex-col justify-end overflow-hidden pointer-events-none ${isMobile ? 'px-2' : 'px-4'}`}
      style={{ top: 'var(--chat-gutter, 0px)', bottom: bottomInset }}
    >
      <div className="chat-measure space-y-3">
        {righe.map((linee, i) => {
          // Alterna come uno scambio: le pari sono tue (a destra, strette), le
          // dispari dell'agente (a sinistra, larghe).
          const mio = i % 2 === 0;
          return (
            <div key={i} className={`flex ${mio ? 'justify-end' : 'justify-start'} animate-pulse`}>
              <div
                className={`rounded-lg px-3 py-2 ${mio ? 'bg-primary/10 max-w-[70%]' : 'bg-app-hover max-w-[85%]'} w-full`}
              >
                <div className="space-y-1.5">
                  {Array.from({ length: linee }).map((__, r) => (
                    <div
                      key={r}
                      className={`h-3 ${BAR}`}
                      // L'ultima riga di un paragrafo non arriva mai in fondo.
                      style={{ width: r === linee - 1 ? `${SKELETON_SUB_WIDTHS[(i + r) % SKELETON_SUB_WIDTHS.length]}%` : '100%' }}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
