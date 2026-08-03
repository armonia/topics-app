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
