/**
 * Il segno che dice «sì, ha ricaricato».
 *
 * Un reload che rifà lo stesso contenuto è indistinguibile dal non aver fatto
 * niente: premi ⌘R, lo schermo torna identico, e l'unica conclusione possibile
 * è «non va». È già successo — la segnalazione «cmd r non sembra andare» è
 * arrivata su un guscio in cui ⌘R funzionava perfettamente. Il fix di quel
 * fraintendimento non è nel reload, è nella RISPOSTA: dopo il ricarico la app
 * deve dire di aver ricaricato.
 *
 * `sessionStorage` perché è l'unico deposito che sopravvive a
 * `location.reload()` senza sopravvivere alla finestra: la sessione dopo non si
 * porta dietro un toast fossile di ieri. La chiave è duplicata in
 * `desktop-tauri/src-tauri/src/lib.rs` (`RELOAD_WITH_FLASH_JS`), che è chi la
 * scrive quando il reload parte dal nativo — ⌘R intercettato dal monitor
 * NSEvent, la voce Reload del menu, `app_reload_all`. Se cambia qui deve
 * cambiare là: sono i due capi dello stesso filo.
 */
export const RELOAD_FLASH_KEY = 'topics:reloaded';

/**
 * Marca il reload che sta per partire DA JS (il ramo web di `reloadAllWindows`,
 * dove non c'è nessun guscio nativo a metterci il segno).
 *
 * `try/catch` perché in un documento con lo storage negato il solo accesso a
 * `sessionStorage` LANCIA: senza guardia l'eccezione ucciderebbe la riga e il
 * reload con lei — il feedback si mangerebbe la funzione che deve annunciare.
 */
export function markReloadFlash(): void {
  try {
    sessionStorage.setItem(RELOAD_FLASH_KEY, '1');
  } catch {
    /* storage negato: si ricarica lo stesso, solo senza annuncio */
  }
}

/**
 * Legge il segno e lo CONSUMA nello stesso gesto: un toast per reload, non uno
 * per ogni montaggio del componente che lo osserva.
 */
export function consumeReloadFlash(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLASH_KEY) === null) return false;
    sessionStorage.removeItem(RELOAD_FLASH_KEY);
    return true;
  } catch {
    return false;
  }
}
