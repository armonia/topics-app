/**
 * La maniglia dei fogli dal basso: la riga che dice «questo si tira giù».
 *
 * Il gesto (`hooks/useSheetDrag`) funziona su tutto il foglio, non solo qui:
 * questa barretta non è un bersaglio, è l'unica cosa che lo rende SCOPRIBILE.
 * Un foglio senza maniglia si chiude solo per chi già sa che si può.
 *
 * `shrink-0` perché il foglio è una colonna che scorre: senza, la maniglia si
 * schiaccia a zero appena il contenuto supera il tetto d'altezza.
 */
export function SheetGrabber() {
  return (
    <div
      aria-hidden="true"
      data-sheet-grabber=""
      className="mx-auto mb-1.5 h-1 w-9 shrink-0 rounded-full bg-app-border"
    />
  );
}
