/**
 * Le zone con cui si trascina la finestra, dichiarate AL RENDER.
 *
 * IL COSTO CHE TOGLIE. Prima l'attributo veniva specchiato sulla classe da un
 * `MutationObserver` su `document.body` con `{childList, subtree: true}`, armato
 * incondizionatamente sotto Tauri. Il debounce a 250 ms era A VALLE: il costo di
 * ALLOCARE e ACCODARE un record è già pagato prima che il callback esista, e
 * xterm sostituisce i figli di ogni riga a ogni refresh
 * (`rowElement.replaceChildren(...)`, per riga per refresh). Con sedici PTY
 * attive sono migliaia di record al secondo, tutti per poi scoprire quasi sempre
 * che non era comparsa nessuna chrome nuova. È la spiegazione della sega di RSS
 * del renderer: 161 → 575 MB in pochi minuti, misurata il 2026-07-28.
 *
 * PERCHÉ SI PUÒ TOGLIERE. L'observer non serviva a reagire a un CAMBIO di
 * classe: le classi sono stringhe statiche nel JSX. Serviva a coprire i nodi
 * montati DOPO — e quelli passano comunque da un render. Se l'attributo lo mette
 * il render, non c'è niente da inseguire.
 *
 * È anche una correzione di comportamento, non solo di costo: spariva la
 * finestra di ~250 ms in cui una tab appena montata era trascinabile per
 * sbaglio, perché la classe `.app-no-drag` c'era ma l'attributo che la fa
 * valere non ancora (vedi la nota in `PaneTabBar`).
 *
 * COME SI USA. Si spargono accanto alla classe, che resta la fonte per il CSS:
 *
 *     <div className="… app-drag-region" {...DRAG_REGION}>
 *     <button className="… app-no-drag" {...NO_DRAG_REGION}>
 *
 * `tests/e2e/drag-regions.spec.ts` verifica A RUNTIME che non esista un elemento
 * con la classe e senza l'attributo — cioè fa, una volta sola e in un test,
 * esattamente il lavoro che l'observer faceva per sempre a ogni mutazione.
 *
 * Fuori da Tauri l'attributo è inerte: un `data-` sconosciuto che nessuno legge.
 * Per questo si emette sempre, senza un ramo a runtime.
 */

/** Trascina la finestra. `deep` = tutto il sottoalbero, meno i figli
 *  interattivi che Tauri esclude da sé (button, a, input, role=tab). */
export const DRAG_REGION = { 'data-tauri-drag-region': 'deep' } as const;

/** Rinuncia esplicita: dentro una zona `deep`, questo NON trascina. Serve alle
 *  tab riordinabili col drag e a ogni controllo cliccabile nella chrome. */
export const NO_DRAG_REGION = { 'data-tauri-drag-region': 'false' } as const;
