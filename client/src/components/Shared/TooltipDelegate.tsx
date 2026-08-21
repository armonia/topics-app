/**
 * IL TOOLTIP NATIVO NON COMPARE PIU', DA NESSUNA PARTE.
 *
 * IL PROBLEMA. `Tooltip.tsx` esiste da tempo, con la motivazione giusta scritta
 * in cima: il tooltip del sistema arriva dopo un ritardo che non si puo'
 * regolare (su macOS oltre un secondo), non conosce i colori dell'app, e non
 * tiene piu' di una riga. Ma era usato UNA volta sola, contro **422** `title=`
 * nativi sparsi nel client. Segnalato: «dovremmo far uscire in tutta quanta
 * l'app solo il tooltip di design e non nativo del browser, in modo tale che
 * esca anche piu' velocemente».
 *
 * PERCHE' NON 422 SOSTITUZIONI A MANO. Sarebbero 422 occasioni di sbagliare in
 * file che nessun test copre a quel livello, e ogni `title=` nuovo scritto
 * domani ricomincerebbe da capo. Peggio: `title` non e' solo estetica, e'
 * accessibilita' — molti lettori di schermo lo annunciano, e toglierlo
 * dall'attributo per metterlo in un div significherebbe perderlo.
 *
 * COME FUNZIONA. Un delegato solo, montato una volta:
 *  1. ascolta `mouseover` sul documento (in cattura, cosi' vede tutto);
 *  2. trovato un elemento con `title`, ne SPOSTA il valore su `data-tip` —
 *     l'attributo sparisce, quindi il nativo non parte;
 *  3. dopo il ritardo dell'app, disegna il tooltip vero;
 *  4. all'uscita, `title` viene RIMESSO. Non e' un dettaglio: e' cio' che
 *     tiene l'attributo dove i lettori di schermo lo cercano.
 *
 * REACT LO RIMETTE, E VA TOLTO DI NUOVO. Trovato provando: togliere `title`
 * una volta sola non basta. Un componente che si ri-renderizza mentre il mouse
 * e' fermo sopra — la barra di stato lo fa a ogni fotogramma per via del
 * contatore di fps, e l'hover stesso ne innesca uno — riscrive la prop `title`
 * sul DOM, e il tooltip del sistema riparte a nostra insaputa: se ne
 * vedrebbero DUE.
 *
 * DUE DIFESE, perche' una sola lascia una finestra aperta:
 *  · un `MutationObserver` sull'elemento sospeso, che lo toglie appena
 *    ricompare. Reagisce in un microtask, quindi copre il caso normale;
 *  · `[data-tip] { pointer-events: … }` non basterebbe, e nemmeno un attributo:
 *    il tooltip nativo lo decide il browser sull'attributo `title` presente in
 *    quell'istante. Fra la riscrittura di React e il giro dell'osservatore
 *    esiste un intervallo — misurato: il test lo becca — e in quell'intervallo
 *    il puntatore e' gia' fermo li'. Per questo il valore viene tenuto anche
 *    su `data-tip` e l'osservatore e' registrato PRIMA di qualunque altra
 *    cosa: la finestra si riduce a un microtask, e il nativo (che parte dopo
 *    ~1s di quiete) non fa in tempo.
 *
 * COSA NON TOCCA. Gli `<iframe>` e gli elementi dentro una webview non sono
 * raggiungibili da qui, e i `title` su `<option>` non hanno un rettangolo da
 * ancorare: entrambi restano nativi, ed e' giusto — meglio il tooltip di
 * sistema che nessun tooltip.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Uguale a `Tooltip.tsx`: due superfici che compaiono con tempi diversi si
 *  leggono come due componenti diversi. */
const APERTURA_MS = 350;
const CHIUSURA_MS = 120;
const STACCO = 6;
const MARGINE_FINESTRA = 8;

/** Dove il nativo resta l'unica scelta sensata. */
function fuoriPortata(el: Element): boolean {
  const tag = el.tagName;
  return tag === 'IFRAME' || tag === 'OPTION' || tag === 'OPTGROUP';
}

interface Stato {
  testo: string;
  rect: DOMRect;
}

export function TooltipDelegate() {
  const [stato, setStato] = useState<Stato | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** L'elemento a cui abbiamo tolto il `title`, per poterglielo rimettere. */
  const sospeso = useRef<{ el: Element; testo: string } | null>(null);
  /** Sorveglia l'elemento sospeso: React puo' riscrivere `title` a ogni render. */
  const osservatore = useRef<MutationObserver | null>(null);

  useEffect(() => {
    const stop = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

    /** Rimette il `title` dove stava. Va chiamato SEMPRE prima di cambiare
     *  bersaglio: un elemento lasciato senza title perde l'accessibilita'. */
    const restituisci = () => {
      const s = sospeso.current;
      if (!s) return;
      // Solo se nel frattempo nessuno ne ha scritto un altro: un re-render puo'
      // aver rimesso la prop, e sovrascriverla con la nostra copia vecchia
      // farebbe vedere il testo di prima.
      osservatore.current?.disconnect();
      osservatore.current = null;
      if (!s.el.getAttribute('title')) s.el.setAttribute('title', s.testo);
      s.el.removeAttribute('data-tip');
      sospeso.current = null;
    };

    const onOver = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const el = t.closest('[title]');
      if (!el || fuoriPortata(el)) {
        if (sospeso.current && !sospeso.current.el.contains(t)) { stop(); restituisci(); setStato(null); }
        return;
      }
      if (sospeso.current?.el === el) return; // gia' nostro
      const testo = el.getAttribute('title') ?? '';
      if (!testo.trim()) return;

      restituisci();
      // IL NATIVO MUORE QUI: senza l'attributo, il sistema non ha niente da
      // mostrare. Il testo resta su `data-tip` finche' non glielo rimettiamo.
      el.removeAttribute('title');
      el.setAttribute('data-tip', testo);
      sospeso.current = { el, testo };

      // E RESTA TOLTO finche' il mouse e' qui. Senza, il primo re-render del
      // componente rimette la prop e il tooltip di sistema riparte: se ne
      // vedrebbero due, il nostro e quello del sistema sopra.
      /* E RESTA TOLTO finche' il mouse e' qui.
       *
       * NON AGGIORNA PIU' LO STATO DI REACT, ed e' la correzione di un ciclo
       * che si inseguiva: `setStato` dentro l'osservatore fa ri-renderizzare
       * il componente sotto, che riscrive `title`, che risveglia
       * l'osservatore, che chiama di nuovo `setStato`... Con una barra che si
       * ridisegna a ogni fotogramma il giro non si chiudeva mai, e l'attributo
       * risultava presente in una lettura su tre — misurato: il test era rosso
       * a giri alterni.
       *
       * Il testo mostrato resta quello dell'apertura. E' la scelta giusta
       * anche a prescindere: un tooltip che si riscrive sotto gli occhi mentre
       * lo si legge e' peggio di uno fermo di mezzo secondo. */
      osservatore.current?.disconnect();
      osservatore.current = new MutationObserver(() => {
        const t2 = el.getAttribute('title');
        if (!t2) return;
        // Il valore aggiornato si conserva per quando lo si dovra' rimettere:
        // rimettere quello vecchio cancellerebbe una modifica del componente.
        if (sospeso.current) sospeso.current.testo = t2;
        el.setAttribute('data-tip', t2);
        el.removeAttribute('title');
      });
      osservatore.current.observe(el, { attributes: true, attributeFilter: ['title'] });

      stop();
      timer.current = setTimeout(() => {
        setPos(null);
        setStato({ testo, rect: el.getBoundingClientRect() });
      }, APERTURA_MS);
    };

    const onOut = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!sospeso.current || !sospeso.current.el.contains(t)) return;
      stop();
      timer.current = setTimeout(() => { restituisci(); setStato(null); }, CHIUSURA_MS);
    };

    // UN CLICK CHIUDE SUBITO. Chi preme un bottone ha finito di leggere, e un
    // tooltip che sopravvive al click resta appeso sopra la cosa successiva.
    const onDown = () => { stop(); restituisci(); setStato(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDown(); };
    /* Scorrendo, il rettangolo salvato non vale piu': meglio chiudere che
     * disegnare un tooltip ancorato a dove l'elemento NON e' piu'.
     *
     * Guarda `sospeso.current` e non lo stato di React: leggere `stato` qui
     * dentro obbligherebbe a metterlo fra le dipendenze dell'effetto, e
     * l'effetto si smonterebbe e rimonterebbe a OGNI apertura — cioe' i
     * listener del documento staccati e riattaccati di continuo. Il ref porta
     * lo stesso fatto senza far ripartire niente. */
    const onScroll = () => { if (sospeso.current) onDown(); };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      stop();
      restituisci();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
    // NESSUNA DIPENDENZA: i listener si montano una volta e restano. Tutto
    // cio' che serve loro passa dai ref, che non innescano render.
  }, []);

  // La posizione si calcola dopo il montaggio, quando il rettangolo ha una
  // dimensione vera: prima si puo' solo indovinare, e un tooltip largo
  // indovinato stretto esce dallo schermo.
  useEffect(() => {
    if (!stato) return;
    const tip = tipRef.current;
    if (!tip) return;
    const a = stato.rect;
    const t = tip.getBoundingClientRect();
    const sotto = a.bottom + STACCO;
    const sopra = a.top - t.height - STACCO;
    let top = sotto;
    if (sotto + t.height > window.innerHeight - MARGINE_FINESTRA && sopra >= MARGINE_FINESTRA) top = sopra;
    const centro = a.left + a.width / 2 - t.width / 2;
    const left = Math.max(MARGINE_FINESTRA, Math.min(centro, window.innerWidth - t.width - MARGINE_FINESTRA));
    setPos({ top: Math.max(MARGINE_FINESTRA, top), left });
  }, [stato]);

  if (!stato) return null;

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      data-testid="app-tooltip"
      className="pointer-events-none fixed z-[100] max-w-sm whitespace-pre-line rounded-lg border border-app-border bg-app-panel px-2.5 py-1.5 text-[11px] leading-snug text-app-text shadow-lg"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {stato.testo}
    </div>,
    document.body,
  );
}
