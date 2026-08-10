/**
 * When a native browser pane stops working, saying so.
 *
 * The Rust side has a panic firewall (`no_abort` in src-tauri/src/lib.rs) around
 * every command that touches wry's webview dispatcher. It exists because those
 * methods all do `window_id.lock().unwrap()`, and once any thread panics while
 * holding that lock the mutex is POISONED — from then on every call on that
 * webview panics too, forever. Unwinding through the objc boundary would abort
 * the whole app, so the firewall catches the panic and returns an `Err`. Its
 * doc comment describes what happens next: "the command returns Err, the client
 * surfaces/retries, and the pane self-heal path can recreate the webview".
 *
 * The client did neither. Twenty-one `.catch(() => {})` in `useTauriBrowser`
 * swallowed every rejection, so a pane whose mutex had gone bad looked exactly
 * like a healthy one: toolbar, address bar, favicon, a perfectly ordinary
 * browser that silently ignored every click, every navigation and every attempt
 * to move it. (The field evidence is a 126 MB panic log holding 522.313 copies
 * of that same poison, all from `with_webview` — the call the bounds path makes
 * on every frame of a drag.) A pane that cannot work must not be able to look
 * like one that can.
 *
 * This module is the decision, kept pure so it is testable without a shell: how
 * many failures mean "broken", and which failures count.
 */

/**
 * Commands whose failure means the PANE is broken rather than that one action
 * didn't land.
 *
 * These are the dispatcher-touching commands — the ones a poisoned mutex kills
 * wholesale. Deliberately NOT here:
 *  - `browser_eval_js` / `browser_screenshot`: a page can hang on its own (the
 *    Rust side gives eval an 8s timeout), and a hung PAGE is not a broken pane.
 *    Counting it would put a healthy pane into fault every time a site stalls.
 *  - `browser_open` / `browser_close`: lifecycle, already surfaced by the
 *    bounded-retry path at mount, and a close that fails harms nothing.
 *  - `browser_animate_bounds`: its documented failure mode is "this shell
 *    doesn't have the command", which is a capability answer, not a broken
 *    pane — the caller reads the `false` and falls back to the per-frame poll.
 */
export const STRUCTURAL_COMMANDS: ReadonlySet<string> = new Set([
  'browser_set_bounds',
  'browser_navigate',
  'browser_reload',
  'browser_back',
  'browser_forward',
  'browser_set_visible',
  'browser_set_user_agent',
  'browser_go_to_index',
]);

/**
 * Consecutive structural failures before a pane is presumed dead.
 *
 * Not one: a single rejection is ordinary. A command can race the pane's own
 * teardown, or land in the window between a deferred close and the reopen that
 * cancels it, and treating that as a fault would put an error strip over a pane
 * that is about to be perfectly fine. A poisoned mutex, on the other hand, never
 * recovers — it fails the next one too, and the one after that. A streak tells
 * the two apart without needing a timer, and `browser_set_bounds` fires often
 * enough that the streak completes in well under a second.
 */
export const FAULT_STREAK = 3;

export interface FaultState {
  /** Consecutive structural failures since the last success. */
  streak: number;
  /** True once the streak reached {@link FAULT_STREAK}. */
  faulted: boolean;
  /** The command that tipped it over — shown so a report says what died. */
  command: string | null;
}

export const NO_FAULT: FaultState = { streak: 0, faulted: false, command: null };

/**
 * A structural command succeeded. Any success clears the fault outright,
 * including one that arrives after the pane was already declared broken: the
 * only way a poisoned webview answers again is if it was replaced, and a pane
 * that works must not keep wearing an error strip.
 */
export function recordPaneOk(state: FaultState): FaultState {
  return state.streak === 0 && !state.faulted ? state : NO_FAULT;
}

/**
 * A command failed. Non-structural commands leave the state untouched — they
 * neither accuse the pane nor absolve it.
 */
export function recordPaneError(state: FaultState, command: string): FaultState {
  if (!STRUCTURAL_COMMANDS.has(command)) return state;
  const streak = state.streak + 1;
  if (streak < FAULT_STREAK) return { streak, faulted: false, command: state.command };
  return { streak, faulted: true, command };
}

/** I passi che «Ricrea la scheda» esegue, iniettati per poterli osservare. */
export interface PaneRecreateSteps {
  /** Chiude la vista. `false` = il guscio ha rifiutato: etichetta BRUCIATA. */
  close(): Promise<boolean>;
  /** Riapre. `true` = sotto questa pane c'è di nuovo una vista. */
  open(): Promise<boolean>;
  /** Un comando STRUTTURALE sulla vista nuova — è ciò che cancella il guasto. */
  handshake(): void;
  /** Diagnostica: la chiusura non è atterrata. */
  onLabelBurned?(): void;
}

/**
 * La cura, nell'ordine in cui deve andare.
 *
 * Tre cose che prima non erano vere, e per cui il pulsante non ricreava niente
 * proprio nel caso per cui esiste — un dispatcher col mutex avvelenato:
 *
 *  1. l'esito della chiusura SI LEGGE. `Webview::close()` passa dallo stesso
 *     `window_id.lock().unwrap()` di tutto il resto: avvelenato quello, la vista
 *     non muore e resta registrata nel manager di tauri. Con un `.catch(() => {})`
 *     sopra, la riapertura cadeva nel ramo di RIUSO di `browser_open` e
 *     riconsegnava la stessa vista morta.
 *  2. si riapre COMUNQUE, anche dopo una chiusura fallita: è il guscio a bruciare
 *     l'etichetta quando la vista rifiuta di morire (`burn_pane_label` in
 *     src-tauri/src/lib.rs), quindi la riapertura nasce sotto un'etichetta libera
 *     e quindi come vista NUOVA. Rinunciare qui lascerebbe la pane com'era.
 *  3. il guasto NON si azzera a mano. Azzerarlo faceva sparire la striscia
 *     all'istante per farla tornare dopo altri tre fallimenti: «risolto» per un
 *     attimo, e poi no. Lo cancella la vista nuova rispondendo al `handshake`,
 *     via {@link recordPaneOk} — l'unica prova che qualcosa è cambiato davvero.
 *
 * Restituisce `true` se sotto la pane c'è di nuovo una vista.
 */
export async function recreatePane(steps: PaneRecreateSteps): Promise<boolean> {
  const closed = await steps.close();
  if (!closed) steps.onLabelBurned?.();
  const reopened = await steps.open();
  if (reopened) steps.handshake();
  return reopened;
}
