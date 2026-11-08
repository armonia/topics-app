/**
 * Il tentativo di aprire la webview nativa (`browser_open`), fuori dall'hook.
 *
 * Quello che conta qui non è la chiamata: è il RAMO IN CUI CI SI ARRENDE. È
 * l'unico punto che vede il fallimento, quindi è l'unico posto dove può stare
 * tutto ciò che va rimesso a posto quando la view non nasce — la strip
 * d'errore e la barra di caricamento. Chi accende `loading` sono tre chiamanti
 * diversi (`navigate` su scheda parcheggiata, «Riprova» del parcheggio,
 * `recreate`), e nessuno di loro riceve un esito: se lo spegnimento vive da
 * loro, uno dei tre resta indietro (è successo: spinner acceso a vita).
 *
 * Sta in un modulo suo anche per poterlo provare: in questo progetto non ci
 * sono jsdom/happy-dom né un renderer di hook, quindi dentro `useTauriBrowser`
 * questa logica non era osservabile da nessun test.
 */
export interface NativeOpenAttempt {
  /** La chiamata vera (`tauriInvoke('browser_open', …)`). */
  invoke: () => Promise<unknown>;
  /** La view c'è: il chiamante può montarla. Riceve la risposta del guscio
   *  (vedi `readNativeOpenAnswer`). */
  onOpened: (answer: unknown) => void;
  /** Tentativi finiti: qui la strip d'errore E lo spegnimento della barra. */
  onGaveUp: (error: unknown) => void;
  /** L'effetto è stato smontato: non toccare più niente. */
  isCancelled: () => boolean;
  /** Iniettabile nei test per non aspettare davvero il ritardo fra i tentativi. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Ritentativi DOPO il primo giro (default 1, cioè due chiamate in tutto). */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * `browser_open` falliva in silenzio: un singhiozzo dell'IPC lasciava la pane
 * ferma su «Initializing native browser…» per sempre. Un ritentativo limitato,
 * poi si dichiara la resa a chi ci ha chiamato.
 */
export function attemptNativeOpen(a: NativeOpenAttempt): void {
  const schedule = a.schedule ?? ((fn: () => void, ms: number) => { window.setTimeout(fn, ms); });
  const retries = a.retries ?? 1;
  const retryDelayMs = a.retryDelayMs ?? 400;
  const run = (attempt: number): void => {
    void a.invoke().then(
      (answer: unknown) => { if (!a.isCancelled()) a.onOpened(answer); },
      (e: unknown) => {
        if (a.isCancelled()) return;
        if (attempt < retries) {
          console.warn(`[tauri-browser] open failed (attempt ${attempt + 1}), retrying`, e);
          schedule(() => { if (!a.isCancelled()) run(attempt + 1); }, retryDelayMs);
          return;
        }
        console.warn('[tauri-browser] open failed (giving up)', e);
        a.onGaveUp(e);
      },
    );
  };
  run(0);
}

/**
 * What `browser_open` answered, read defensively.
 *
 * The shell answers `{ reused, url }`: `reused` when the pane's view was already
 * alive, and then `url` is where that view IS. An open of a live view does not
 * navigate it any more (lib.rs, `plan_browser_open`), so the page can be
 * anywhere its user took it, and the address bar must show that, not the url
 * the pane asked for. An older shell answers nothing: it created or navigated,
 * so the view is where it was asked to be.
 */
export interface NativeOpenAnswer {
  reused: boolean;
  url: string;
}

export function readNativeOpenAnswer(answer: unknown, requested: string): NativeOpenAnswer {
  if (!answer || typeof answer !== 'object') return { reused: false, url: requested };
  const a = answer as { reused?: unknown; url?: unknown };
  const url = typeof a.url === 'string' && a.url !== '' ? a.url : requested;
  return { reused: a.reused === true, url };
}

/**
 * What a pane does with an answered open. `url` is where the view is (the bar
 * shows it, the did-fail drain compares against it). `landOn`: the caller needs
 * the view AT `openUrl` (a parked tab sent elsewhere, the parked retry,
 * `recreate`), not just a view; the shell no longer navigates a live view on
 * open, so one found elsewhere is navigated explicitly (`navigate`). The mount
 * does not pass it: there the live page is the point.
 */
export function settleOpenedView(answer: unknown, openUrl: string, landOn: boolean): { navigate: boolean; url: string } {
  const opened = readNativeOpenAnswer(answer, openUrl);
  if (opened.reused && landOn && opened.url !== openUrl) return { navigate: true, url: openUrl };
  return { navigate: false, url: opened.url };
}
