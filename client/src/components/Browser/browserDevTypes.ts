/**
 * Shared types for the browser dev-toolbar features (device emulation, quick
 * console, nav history). Kept in one place so the hook (useNativeBrowser), the
 * toolbar, and the small sub-components agree on the shapes.
 */

/** Device-emulation presets surfaced in the toolbar switcher. */
export type DeviceMode = 'desktop' | 'mobile' | 'tablet' | 'auto' | 'custom';

/** A device preset's metrics + UA. `desktop`/`auto` carry no metrics (disable
 *  emulation / fit-the-pane respectively); mobile/tablet/custom carry a size.
 *
 *  There is no `deviceScaleFactor` and no `mobile` flag. Both used to be here,
 *  set on the mobile and tablet presets, and NOTHING read either one: the native
 *  pane emulates a device by overriding the User-Agent and letterboxing the view
 *  to the preset's size, and WKWebView exposes no way to fake a backing-scale
 *  factor or a touch pointer from outside the page. Carrying the fields anyway
 *  described an emulation that wasn't happening — the sort of thing you only
 *  discover by wondering why setting them changed nothing. */
export interface DevicePreset {
  mode: DeviceMode;
  label: string;
  width?: number;
  height?: number;
  userAgent?: string;
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const DEVICE_PRESETS: Record<Exclude<DeviceMode, 'custom'>, DevicePreset> = {
  desktop: { mode: 'desktop', label: 'Desktop' },
  auto: { mode: 'auto', label: 'Auto' },
  mobile: { mode: 'mobile', label: 'Mobile', width: 390, height: 844, userAgent: IPHONE_UA },
  tablet: { mode: 'tablet', label: 'Tablet', width: 820, height: 1180, userAgent: IPAD_UA },
};

/**
 * Which device the pane is ACTUALLY emulating, read back from the page.
 *
 * The webview outlives the React component that owns the toolbar. `browser_open`
 * is idempotent and REUSES a live view, a background tab stays mounted, and a ⌘R
 * of the host UI doesn't tear the child webview down at all. Meanwhile the
 * toolbar's device mode was a plain `useState('desktop')`, so every one of those
 * remounts put the control back to Desktop while the WKWebView carried on
 * serving the iPhone User-Agent it had been given. The menu said one thing and
 * the site saw another, with nothing on screen to suggest which was true.
 *
 * A custom User-Agent is the whole of what "emulating" means on this path, so
 * the page's own `navigator.userAgent` is the authority — not a value the client
 * remembers. `custom` (responsive resize) sets no UA and so cannot be recovered:
 * it reads back as `desktop`, which is exactly what the view has reverted to.
 */
export function deviceModeFromUserAgent(ua: string): 'desktop' | 'mobile' | 'tablet' {
  if (ua === IPHONE_UA) return 'mobile';
  if (ua === IPAD_UA) return 'tablet';
  return 'desktop';
}

/** A console entry forwarded from the native view (main.ts wc.on('console-message')). */
export interface BrowserConsoleEntry {
  /** Monotonic id for stable React keys + de-dup. */
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  /** "file.js:42" when Chromium provides it. */
  source?: string;
  /**
   * Quando la voce e' stata RACCOLTA, epoch ms.
   *
   * Non e' l'istante esatto della `console.log`: il proxy in pagina
   * (CONSOLE_PROXY_JS, lato Rust) accumula in un array senza data e il poll lo
   * svuota ogni 800ms, quindi la marca la mette il client allo svuotamento e
   * tutte le voci di uno stesso giro portano la stessa ora. Al secondo, che e'
   * la risoluzione mostrata, la differenza si vede solo su una riga arrivata a
   * cavallo del tick. Stamparla qui invece che in pagina evita di toccare il
   * guscio nativo, che sarebbe da ricompilare perche' un'ora compaia.
   */
  at: number;
}

/**
 * Il bersaglio di un tasto destro DENTRO la pane nativa.
 *
 * Le coordinate sono quelle della FINESTRA dell'app, non della pagina: il menu è
 * un nodo del DOM dell'app, e la conversione (origine dello slot, zoom,
 * letterbox dell'emulazione) è già stata fatta da `paneToHostPoint`. Chi disegna
 * il menu non deve saperne niente.
 */
export interface PaneContextTarget {
  x: number;
  y: number;
  /** Primi 200 caratteri della selezione: dice SE mostrare «Copia», non cosa
   *  copiare. Il testo intero lo rilegge `readSelection()` al click. */
  selection: string;
  /** href assoluto quando il click è caduto dentro un <a>, '' altrimenti. */
  linkUrl: string;
  /** src assoluto quando il click è caduto su un'immagine, '' altrimenti. */
  imageUrl: string;
  /** Cresce a ogni click destro: due click sullo stesso punto sono due menu. */
  seq: number;
}

/** One entry of the page's back/forward navigation history. */
export interface NavHistoryEntry {
  url: string;
  title: string;
  index: number;
}

/**
 * Handle returned by the native browser hook (`useTauriBrowser`) and consumed by
 * `NativeBrowserPlaceholder` + `RemoteBrowserPanel`'s Tauri path. Kept here (a
 * neutral, host-agnostic types module) so it survives the removal of the archived
 * Electron `useNativeBrowser` hook that originally declared it.
 */
export interface NativeBrowserHandle {
  url: string;
  title: string;
  loading: boolean;
  agentActive: boolean;
  /** Human-readable label of the agent's current action ("Clicca", "Naviga su
   *  example.com", …). Last value seen on agent_active=true; persists through the
   *  brief idle linger so a burst of tool calls shows steady text. */
  agentAction: string | null;
  ready: boolean;             // native webview opened (browser_open resolved)
  viewId: string | null;
  /** Optional — Tauri only. A base64 PNG data-URL still of the page, shown in the
   *  placeholder while the native WKWebView is parked off-screen (a dropdown/menu
   *  overlaps it, or a sidebar/divider animation is in flight). A native child
   *  webview always composites ABOVE the DOM, so it can't be z-ordered under an
   *  HTML overlay nor cheaply moved per-frame; freezing to a DOM <img> lets
   *  overlays render over a pixel-perfect still and lets animations move the image,
   *  not the native view. */
  frozenImage?: string | null;
  /** Favicon URL emitted by the page. Empty during navigation. */
  faviconUrl: string;
  /** Optional — Tauri only. Last navigation failure (WKNavigationDelegate
   *  did-fail, drained from the Rust queue). Cleared by the next navigate()
   *  or by clearNavError(). Null on the web path (it has its own WS channel). */
  /** `hint` = seconda riga facoltativa (vedi `navErrorMessage.ts`): il perché,
   *  quando il perché non sta nella prima riga. */
  navError?: { message: string; url: string; hint?: string } | null;
  /** Optional — dismiss the navigation-error strip without navigating. */
  clearNavError?(): void;
  /** Optional — il «Riprova» della strip. Su una porta locale sonda prima di
   *  ricaricare, così una porta ancora spenta produce una risposta invece del
   *  nulla. Assente sul path web, che ricade su navigate(). */
  retryNav?(url: string): Promise<void>;
  /** Optional — Tauri only. Scheda PARCHEGGIATA: punta a una porta locale su
   *  cui non c'è nessuno in ascolto, quindi la webview nativa non è stata
   *  nemmeno creata e il pannello disegna la sua schermata al posto della view. */
  parked?: { url: string; checkedAt: number } | null;
  /** Optional — una sonda del parcheggio è in corso. */
  parkedChecking?: boolean;
  /** Optional — Tauri only. La webview nativa non risponde più: una raffica di
   *  comandi strutturali di fila è stata rifiutata dalla shell (vedi
   *  `lib/shell/browserPaneFault.ts`). Non è un errore della PAGINA — è il pane
   *  che non c'è più, ed è l'unico stato in cui la chrome continuerebbe a
   *  disegnare un browser perfettamente normale sopra una vista morta. */
  nativeFault?: { command: string } | null;
  /** Optional — Tauri only. Butta via la webview e ne costruisce una nuova allo
   *  stesso indirizzo: l'unico rimedio a un mutex avvelenato, che per quella
   *  vista è definitivo. */
  recreate?(): Promise<void>;
  /** Optional — risonda la porta: se è tornata su, apre la view. */
  retryParked?(): Promise<void>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  goHome(): Promise<void>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  /** Optional — Tauri macOS only. Sidebar-slide handoff: commit `bounds` as the
   *  pane's final slot in ONE IPC and let Core Animation slide the native view
   *  from `fromDx` px away along the given duration/curve (the same the DOM
   *  FLIP rides), instead of a per-frame setBounds chase. Resolves false when
   *  the shell lacks the command — caller falls back to the poll. */
  animateBounds?(
    bounds: { x: number; y: number; width: number; height: number },
    fromDx: number,
    durationMs: number,
    timing: [number, number, number, number],
  ): Promise<boolean>;
  toggleDevTools(): Promise<void>;
  /** Find in page (Cmd+F). Pass empty string + findNext=false to clear. */
  findInPage(text: string, options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }): Promise<void>;
  stopFind(): Promise<void>;
  /** Optional — count matches of `text` in the page (Tauri pane, where
   *  window.find gives no count). `matchCase` deve essere lo STESSO passato a
   *  `findInPage`: il totale e la ricerca che ci cammina sopra sono due letture
   *  della stessa cosa, e se non concordano il contatore «n/m» cicla in anticipo. */
  countMatches?(text: string, options?: { matchCase?: boolean }): Promise<number>;
  /** Optional — inspect the element at page CSS coords (Tauri select-element). */
  inspectAt?(x: number, y: number): Promise<{
    cssPath: string;
    domPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text: string;
  } | null>;
  /** Optional — Tauri only. Un tasto destro raccolto DENTRO la pagina (il click
   *  non raggiunge React: la vista nativa composita sopra il DOM), già mappato
   *  nelle coordinate della finestra. Null quando non c'è nessun menu da aprire. */
  paneContext?: PaneContextTarget | null;
  /** Optional — la richiesta è stata consumata (menu chiuso o voce scelta). */
  clearPaneContext?(): void;
  /** Optional — la selezione INTERA della pagina, per la voce «Copia». Il campo
   *  `selection` di `paneContext` è tagliato: serve a decidere, non a copiare. */
  readSelection?(): Promise<string>;
  /** Optional — i byte di un'immagine della pagina come data URL PNG, per la voce
   *  «Copia immagine». Null quando il server dell'immagine non manda CORS (il
   *  canvas resta contaminato) o l'estrazione non arriva in tempo: il chiamante
   *  deve dirlo, non far finta di aver copiato. */
  readImageDataUrl?(src: string): Promise<string | null>;
  /** Optional — Cmd+Shift+E select-element. On the Tauri pane the picking runs
   *  IN-PAGE (the native view sits above the DOM, so a React overlay can't catch
   *  the click); the hook dispatches `chat:insert-text` with the picked node. */
  selectMode?: boolean;
  enterSelectMode?(): void;
  exitSelectMode?(): void;
  /** Zoom (Cmd+/-/0). Only the sign of `delta` matters (one ladder notch);
   *  'reset' → 100%. Returns the new zoom percentage (a clean integer). */
  setZoom(delta: number | 'reset'): Promise<number>;
  /** Current zoom percentage (clean integer on the ZOOM_STEPS ladder, default 100).
   *  Reactive source of truth for the toolbar label so button + keyboard agree. */
  zoom: number;
  /** Current device-emulation mode (default 'desktop'). */
  deviceMode: DeviceMode;
  /** Apply a device preset. 'mobile'/'tablet' emulate; 'custom' = responsive
   *  resize (real view sized to width/height, no emulation); 'desktop'/'auto'
   *  fill the pane. */
  setDevice(mode: DeviceMode, custom?: { width: number; height: number; deviceScaleFactor?: number }): void;
  /** Responsive-resize viewport (px) when deviceMode==='custom'; null otherwise. */
  responsiveSize: { width: number; height: number } | null;
  /** Live-set the responsive viewport (called continuously while dragging a handle). */
  setResponsiveSize(width: number, height: number): void;
  /** Recent page console messages (ring buffer) for the toolbar quick-console. */
  consoleEntries: BrowserConsoleEntry[];
  /** Counts for the toolbar badge. */
  consoleSummary: { errors: number; warnings: number };
  clearConsole(): void;
  /** Fetch the back/forward navigation history for the Chrome-style menu. */
  getNavEntries(): Promise<{ entries: NavHistoryEntry[]; activeIndex: number }>;
  goToNavIndex(index: number): Promise<void>;
  /** Optional — Tauri only. Whether the WKBackForwardList has an entry to go
   *  back/forward to, derived from getNavEntries after each load settles. Lets
   *  the toolbar grey the arrows at the ends of history instead of leaving them
   *  always live (a silent no-op click). Absent on the streaming/web path,
   *  where the toolbar falls back to enabled. */
  canGoBack?: boolean;
  canGoForward?: boolean;
}
