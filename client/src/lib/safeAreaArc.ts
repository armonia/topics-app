/**
 * LA CURVA DELLO SCHERMO, RICAVATA — non imitata con scarti scelti a occhio.
 *
 * Una fila di comandi in fondo a un iPhone non è una riga dritta: gli angoli
 * dello schermo sono tondi, e vicino ai bordi il vetro finisce PRIMA. Chi tiene
 * la fila dritta ha due sole scelte, e sono entrambe uno spreco:
 *
 *  · alzare TUTTA la fila fino a dove passa anche l'elemento peggiore (il primo
 *    e l'ultimo) — e allora i millimetri li perde anche quello in mezzo, che
 *    l'arco non tocca;
 *  · rientrare in orizzontale finché gli estremi escono dall'arco — è ciò che
 *    fa la barra di stato della sidebar, con 32px per lato, e su 390 di
 *    larghezza sono 64 che nessuno usa.
 *
 * La terza è misurare: ogni elemento sale ESATTAMENTE di quanto l'arco gli
 * mangia alla sua ascissa, e chi sta in mezzo non sale affatto. Da lontano la
 * fila segue il bordo dello schermo; da vicino non c'è nessun numero inventato.
 *
 * ── LA FORMULA ──────────────────────────────────────────────────────────────
 * L'angolo in basso a sinistra è un quarto di cerchio di raggio R col centro in
 * (R, H−R). Un punto ad ascissa x < R può scendere fino a
 *   y(x) = H − R + √(R² − (R − x)²)
 * quindi l'arco mangia, a quell'ascissa,
 *   alzata(x) = R − √(R² − (R − x)²)
 * che vale R sul bordo (x = 0) e zero da x = R in poi. A destra è la stessa
 * cosa specchiata: al posto di x si usa la distanza dal bordo destro.
 *
 * Il punto che vincola una scatola è il suo angolo basso ESTERNO — il sinistro
 * per chi sta a sinistra, il destro per chi sta a destra — quindi si misura lì
 * e non al centro dell'icona: misurare al centro fa passare la scatola con
 * l'angolo dentro il vetro tondo, che è esattamente il difetto che si sente e
 * non si vede.
 *
 * ── E IL RAGGIO DA DOVE ARRIVA ──────────────────────────────────────────────
 * Il web NON espone il raggio dello schermo: non c'è media query né API. L'unico
 * segnale che il sistema dà è `env(safe-area-inset-bottom)` — la fascia
 * dell'home indicator — e su ogni dispositivo che ha gli angoli tondi quella
 * fascia c'è. Il rapporto qui sotto è tarato sui due estremi della famiglia
 * (iPhone con indicatore: fascia 34px, raggio reale fra 44 e 55; iPad: fascia
 * ~20, raggio ~25) e SBAGLIA IN ECCESSO di proposito: un raggio stimato più
 * grande del vero alza gli estremi di qualche pixel in più, uno più piccolo li
 * fa tagliare. Il primo errore non si vede, il secondo sì.
 *
 * Fascia zero ⇒ raggio zero ⇒ alzata zero per tutti: su uno schermo squadrato
 * la fila torna dritta DA SÉ, senza un ramo dedicato. Non è un caso speciale, è
 * lo stesso calcolo con R = 0.
 *
 * Chi conosce il valore vero (una shell nativa che lo sa) può dirlo scrivendo
 * `--screen-corner-radius` sul documento: `raggioSchermo` lo preferisce alla
 * stima. Vedi `useSafeAreaArc`.
 */

/** Il rapporto fascia→raggio. Vedi il blocco sopra: sovrastima voluta. */
const RAGGIO_PER_FASCIA = 1.6;

/**
 * Il raggio da usare per la fila, in pixel CSS.
 *
 * `override` è il valore dichiarato da chi lo sa (la variabile
 * `--screen-corner-radius`); `NaN`, negativi e zero non contano come dichiarati
 * — zero lo si ottiene già, e correttamente, da una fascia assente.
 */
export function raggioSchermo(fascia: number, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  if (!Number.isFinite(fascia) || fascia <= 0) return 0;
  return Math.round(fascia * RAGGIO_PER_FASCIA);
}

/**
 * Quanto l'arco mangia a una certa distanza dal bordo laterale più vicino.
 *
 * `distanza` è già la distanza dal bordo (sinistro o destro, chi decide è il
 * chiamante): la funzione non sa da che parte sta e non deve saperlo.
 */
export function alzataArco(distanza: number, raggio: number): number {
  if (raggio <= 0) return 0;
  if (!Number.isFinite(distanza) || distanza >= raggio) return 0;
  const d = Math.max(0, distanza);
  return raggio - Math.sqrt(raggio * raggio - (raggio - d) * (raggio - d));
}

/** Una scatola della fila: dove comincia e quanto è larga, in pixel CSS. */
export interface ScatolaFila {
  x: number;
  larghezza: number;
}

export interface OpzioniFila {
  /** Larghezza della fila (= dello schermo, se la fila è a tutta larghezza). */
  larghezza: number;
  /** Le scatole, in ordine di lettura. */
  scatole: readonly ScatolaFila[];
  /** Il raggio degli angoli, da `raggioSchermo`. */
  raggio: number;
  /**
   * Il pavimento: quanto sta comunque sopra il bordo inferiore chi non è
   * toccato dall'arco. È la fascia ABITATA, non lasciata vuota — stessa legge
   * della barra di stato: con 34px di inset il contenuto cade a 22 dal fondo,
   * dentro la fascia e sopra l'home indicator (ultimi ~10px).
   */
  pavimento: number;
}

/**
 * Di quanto sta sopra il bordo inferiore ciascuna scatola.
 *
 * `max()` e non una somma: il pavimento c'è già, e l'arco lo ALLARGA solo dove
 * arriva. Sommarli alzerebbe anche chi non ne ha bisogno, cioè rifarebbe a mano
 * lo spreco che questo modulo esiste per togliere.
 */
export function alzateFila({ larghezza, scatole, raggio, pavimento }: OpzioniFila): number[] {
  return scatole.map((s) => {
    const daSinistra = s.x;
    const daDestra = larghezza - (s.x + s.larghezza);
    const arco = Math.max(alzataArco(daSinistra, raggio), alzataArco(daDestra, raggio));
    return Math.round(Math.max(pavimento, arco) * 100) / 100;
  });
}

/**
 * Il pavimento della fila, dalla fascia inferiore.
 *
 * Con `fascia = 34` (iPhone in verticale) dà 22, che è dove la barra di stato
 * mette già il suo contenuto; con `fascia = 0` dà 10, cioè un respiro dal bordo
 * e nient'altro. Il 10 è anche il minimo assoluto: sotto quella quota, su un
 * iPhone, c'è l'home indicator e il dito colpisce il gesto di sistema invece
 * del bottone.
 */
export function pavimentoFila(fascia: number): number {
  if (!Number.isFinite(fascia) || fascia <= 0) return 10;
  return Math.max(10, fascia - 12);
}
