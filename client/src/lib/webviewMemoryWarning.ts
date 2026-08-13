/**
 * QUANDO DIRE CHE LE WEBVIEW SI SONO MANGIATE LA MACCHINA.
 *
 * IL GUASTO. Le pane browser sono WKWebView, e wry non le dealloca mai:
 * `impl Drop for InnerWebView` chiama `self.webview.retain()`, cioè incrementa
 * il conteggio dei riferimenti mentre distrugge. È ancora lì in wry 0.56.0 e sul
 * branch `dev` (verificato il 2026-08-12; a monte tauri-apps/wry#1733 è aperta).
 * Chiudere una pane toglie la view dallo schermo e lascia vivo il suo processo
 * WebContent per sempre. Il racconto completo, con le misure e il perché non si
 * sfratta, sta in `state/pane/residency/policy.ts:75`. Qui non si riassume: si
 * decide soltanto quando parlarne.
 *
 * PERCHÉ UN AVVISO E NON UNA CURA. Il guasto è invisibile e la sua unica cura
 * sta fuori dalla nostra portata. L'utente chiude le pane, la memoria non
 * scende, e nell'app non c'è una riga che gliene dia notizia. Misurato su un Mac
 * da 32 GB: 15 WebView per 9,7 GB, primo consumatore della macchina, swap al
 * 96%. Riavviare Topics la restituisce tutta. Questo modulo non sfratta e non
 * riavvia niente: dice quando è il momento di dirlo, poi decide l'utente.
 *
 * PERCHÉ È UN FILE A PARTE. Accensione, isteresi e memoria del rifiuto sono
 * l'unica parte che può sbagliarsi in silenzio, e un banner che sbaglia in
 * silenzio o lampeggia o tace per sempre. Qui si prova senza montare React.
 */

/**
 * ACCENSIONE: 4096 MB di sole webview.
 *
 * Le 15 WebView misurate stavano a 9,7 GB, cioè ~650 MB l'una, e una di quelle è
 * la finestra della UI. 4 GB sono all'incirca cinque pane browser più la UI:
 * sotto, l'accumulo esiste ma non è ancora lui a decidere la salute della
 * macchina, e un avviso lì sarebbe rumore su una condizione normale. Sopra, è
 * già la voce più grossa del footprint e continuerà a salire da sola, perché
 * niente di ciò che l'utente può fare la fa scendere.
 *
 * Sta apposta più in alto della soglia d'allarme dell'app intera
 * (`SidebarStatusBar`, 3072 MB su `appMemMB`): là si colora un numero che sei
 * già andato a leggere, qui si scrive una frase in mezzo alla colonna, e una
 * frase costa più attenzione di un colore.
 */
export const WEBVIEW_WARN_ON_MB = 4096;

/**
 * SPEGNIMENTO: 512 MB più in basso. È isteresi, non una seconda soglia.
 *
 * `rendererMB` è un footprint, quindi respira: il sistema comprime e ripagina
 * sotto pressione, e la stessa identica scena si legge diversa da un campione al
 * successivo. Con una soglia sola un valore che oscilla intorno ai 4 GB
 * accenderebbe e spegnerebbe il banner a ogni poll, che è il modo più rapido di
 * insegnare a ignorarlo. 512 MB è meno di una webview (~650 MB misurati):
 * abbastanza per assorbire il respiro, troppo poco perché il banner sopravviva a
 * un calo vero.
 */
export const WEBVIEW_WARN_OFF_MB = 3584;

/**
 * RI-ARMO DOPO UN RIFIUTO: +2048 MB rispetto a quanto si leggeva alla chiusura.
 *
 * Chi chiude l'avviso ha capito e ha scelto di andare avanti così. Rimettergli
 * la stessa frase davanti al campione dopo è molestia, e un avviso che molesta
 * viene chiuso senza leggerlo anche la volta che conta. Ma il numero cresce e da
 * solo non torna più giù, quindi il silenzio non può essere per sempre: 2 GB
 * sono circa tre webview in più (~650 MB l'una), cioè un'altra sessione di
 * lavoro intera. A quel punto la situazione non è più quella che ha ignorato, e
 * l'avviso ha di nuovo qualcosa da dire.
 */
export const WEBVIEW_WARN_REARM_DELTA_MB = 2048;

export interface WebviewMemoryWarningState {
  /** L'avviso è acceso adesso. */
  visible: boolean;
  /**
   * I MB letti quando l'utente ha chiuso l'avviso, `null` se non l'ha chiuso.
   *
   * Vive in memoria e basta, mai in `localStorage`: dopo un riavvio le webview
   * ripartono da zero e l'avviso è comunque spento dalla soglia. Persisterlo
   * terrebbe zitto un avviso che non avrebbe parlato, e alla prossima crescita
   * lo farebbe partire da un riferimento che non esiste più.
   */
  dismissedAtMB: number | null;
}

export const WEBVIEW_MEMORY_WARNING_INITIAL: WebviewMemoryWarningState = {
  visible: false,
  dismissedAtMB: null,
};

/**
 * Un campione nuovo.
 *
 * `rendererMB` a `null` vuol dire "nessuna misura", e i casi sono due: il web,
 * dove `usePerfMetrics` non ha processi da guardare e resta `null`, e una lettura
 * `partial` (Windows e Linux, che non hanno
 * `responsibility_get_pid_responsible_for_pid`), dove il numero copre la sola
 * shell e non dice niente sulle webview. In entrambi lo stato non si muove.
 *
 * Ritorna `prev` per identità quando non cambia niente, così il `setState` del
 * chiamante non ridisegna a ogni poll.
 */
export function nextWebviewMemoryWarning(
  prev: WebviewMemoryWarningState,
  rendererMB: number | null,
): WebviewMemoryWarningState {
  if (rendererMB === null || !Number.isFinite(rendererMB)) return prev;

  // Sotto la soglia di spegnimento non c'è più niente da ignorare, quindi il
  // rifiuto si dimentica insieme all'avviso. Se la memoria risalirà, ripartirà
  // dalla soglia normale invece che da una soglia alzata da una decisione presa
  // su una situazione che nel frattempo è finita.
  if (rendererMB < WEBVIEW_WARN_OFF_MB) {
    return prev.visible || prev.dismissedAtMB !== null ? WEBVIEW_MEMORY_WARNING_INITIAL : prev;
  }

  // Zona alta. Chi è già acceso ci resta: l'accensione la decide solo la soglia
  // alta, lo spegnimento solo quella bassa. È tutta l'isteresi.
  if (prev.visible) return prev;

  const soglia =
    prev.dismissedAtMB === null ? WEBVIEW_WARN_ON_MB : prev.dismissedAtMB + WEBVIEW_WARN_REARM_DELTA_MB;
  if (rendererMB < soglia) return prev;

  // Il rifiuto è stato consumato: da qui vale di nuovo la soglia normale, e una
  // seconda chiusura registrerà il proprio valore invece di sommarsi al primo.
  return { visible: true, dismissedAtMB: null };
}

/**
 * L'utente ha chiuso l'avviso. `rendererMB` è il valore che stava leggendo:
 * è il riferimento da cui si misura la crescita che lo farà tornare.
 */
export function dismissWebviewMemoryWarning(
  prev: WebviewMemoryWarningState,
  rendererMB: number,
): WebviewMemoryWarningState {
  if (!prev.visible) return prev;
  return { visible: false, dismissedAtMB: rendererMB };
}

/**
 * MB in gigabyte con una cifra e la virgola. È un titolo italiano, non un log,
 * e a quattro cifre in su i megabyte smettono di essere una quantità che si
 * legge a colpo d'occhio.
 */
export function formatWebviewMemoryGB(mb: number): string {
  return (mb / 1024).toFixed(1).replace('.', ',');
}
