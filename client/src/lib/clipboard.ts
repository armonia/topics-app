/**
 * copyText — l'UNICA porta per «copia questa stringa».
 *
 * Perché un helper per due righe: `navigator.clipboard` è `undefined` fuori da
 * un secure context (HTTP in LAN, alcune webview), quindi `navigator.clipboard
 * .writeText(...)` non fallisce con una promise rifiutata: TIRA. Chi lo chiama
 * senza `?.` e senza try/catch fa saltare l'handler del click, e con lui tutto
 * ciò che veniva dopo (il feedback «copiato ✓» compreso).
 *
 * Nel client la stessa riga è già stata riscritta quattro volte, ogni volta un
 * po' diversa (`TaskDetail` la awaita senza `?.`, `Board/atoms` la fa
 * fire-and-forget con `?.`, `EditorTabs` e `FileExplorer` a modo loro): il
 * risultato è che «copia» funziona o no a seconda del bottone. Qui la regola è
 * una sola, e l'esito è un boolean — così il call-site può mostrare «copiato ✓»
 * SOLO quando è vero, invece di mentire su una copia mai avvenuta.
 *
 * Non tocca il DOM e non ha fallback con `document.execCommand`: quello richiede
 * una selezione viva e un nodo temporaneo, cioè esattamente il genere di
 * effetto collaterale che un helper puro non deve avere. Se il browser non
 * concede la clipboard, `false` è la risposta onesta.
 */
/**
 * «Copia immagine»: i BYTE nella clipboard, non l'indirizzo.
 *
 * Prende una PROMESSA e non i byte gia' pronti, ed e' il punto delicato di
 * questa funzione. In WebKit la scrittura in clipboard e' concessa solo dentro
 * il gesto dell'utente, e i byte dell'immagine arrivano da uno script che gira
 * dentro la pagina della pane nativa: aspettarli prima di chiamare `write`
 * consumerebbe il gesto e la copia verrebbe negata. `ClipboardItem` accetta una
 * promessa proprio per questo, quindi il permesso si prende subito e i byte
 * arrivano dopo.
 *
 * `false` copre tutto cio' che puo' andare storto senza che sia un guasto:
 * clipboard assente fuori dai secure context, `ClipboardItem` non implementato,
 * canvas contaminato perche' il sito non manda CORS. Chi chiama offre allora
 * l'unica cosa che riesce sempre, cioe' copiare l'indirizzo.
 */
export async function copyImagePng(png: Promise<string | null>): Promise<boolean> {
  try {
    const write = typeof navigator !== 'undefined' ? navigator.clipboard?.write : undefined;
    if (!write || typeof ClipboardItem === 'undefined') {
      // Nessuno consumera' la promessa: senza questo `catch` un fallimento
      // dell'estrazione diventerebbe una rejection non gestita.
      void png.catch(() => null);
      return false;
    }
    const blob = png.then(async (dataUrl) => {
      if (!dataUrl) throw new Error('immagine non leggibile');
      // `fetch` su una data: URL non tocca la rete: e' il modo piu' corto di
      // trasformare base64 in Blob senza scrivere un decoder a mano.
      return await (await fetch(dataUrl)).blob();
    });
    await write.call(navigator.clipboard, [new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    // `navigator` può mancare del tutto (test senza DOM, SSR); `clipboard` manca
    // fuori dai secure context. Entrambi i casi valgono «non si può copiare».
    const write = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText : undefined;
    if (!write) return false;
    await write.call(navigator.clipboard, text);
    return true;
  } catch {
    // Permesso negato, documento non a fuoco, clipboard bloccata dalla policy:
    // per chi chiama è sempre e solo «non copiato».
    return false;
  }
}
