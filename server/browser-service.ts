import type { Page, BrowserContext, Browser } from "playwright-core";
import { pushNetworkEntry, completeNetworkEntry, type NetworkEntry } from "./browser-network-log";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { loadStorageState, saveStorageState, debouncedSaver, saveLastUrl, loadLastUrl, readLastUrlEntry, type BrowserStorageState } from "./browser-state-store";
import { seedSharedFromNative } from "./browser-session-handoff";
import { toServableUrl } from "./browser-local-file-url";
import {
  siteDataRecords as recordsFromState,
  forgetSilosInState,
  originsOfSilos,
  cookieSilo,
  originSilo,
  type SiteDataRecord,
} from "./browser-site-data";
import type { Topic } from "./types";
import type { IndexedElement } from "./browser-tools";
import type { BrowserWsMessage } from "../shared/browser-ws-messages";
import { DESCRIBE_ELEMENT_FN, type ElementDescription } from "../shared/element-describe";
import type { RemoteField } from "../shared/browser-keyboard-field";
import {
  extractIndexedElementsOnPage,
  captureAnnotatedScreenshotOnPage,
} from "./browser-dom-walker";
import { browserMarkArg } from "./lib/browser-orphan-sweep";
import { reapOrphanBrowsersAtBoot } from "./services/browser-orphan-reap";

interface BrowserContextEntry {
  context: BrowserContext;
  page: Page;
  createdAt: string;
  lastActivity: number;
  url: string;
  title: string;
  consoleMessages: { level: string; text: string; timestamp: number }[];
  /**
   * Le richieste di rete osservate su questa pane, buffer limitato.
   * Vive qui e non in un registro globale perché la domanda che l'agente fa è
   * sempre «cosa ha chiesto QUESTA pagina», e un registro condiviso mescolerebbe
   * pane diverse proprio mentre si indaga.
   */
  network?: NetworkEntry[];
  /** L'ultimo dialogo (`alert`/`confirm`/`prompt`) apparso, e come è stato chiuso. */
  lastDialog?: { type: string; message: string; at: number; handled: "accept" | "dismiss" };
  persistCookies?: boolean;
  /** Cleanup hook for autosave timer + cancel for debounced saver. */
  autoSaveCleanup?: () => void;
  /** Guard: page event listeners (console/load) already bound by setupPage. */
  listenersBound?: boolean;
  /** HiDPI factor this context was CREATED with (Playwright fixes it at
   *  newContext() — immutable for the context lifetime). Drives the screencast
   *  frame-dimension multiplier so retina panes render sharp. Defaults to 1. */
  deviceScaleFactor?: number;
  /** Which ENGINE backs this context (task 54601eeb). 'default' (the usual
   *  server-owned headless Chromium) or 'chromium' (a real user-installed
   *  Chromium driven over CDP, where the user's extensions live). Absent = default. */
  engine?: "default" | "chromium";
  /** For the chromium engine only: the playwright Browser obtained via
   *  connectOverCDP. Closing it DISCONNECTS the CDP client (the sidecar process
   *  keeps running — its lifetime is owned by the engine registry's ref count),
   *  so destroyContext must close THIS + the page, never the shared context. */
  engineBrowser?: Browser;
  /** T1 DOM co-browse (opt-in). Set once rrweb has been injected into this
   *  context's page (bundle addInitScript + exposed __rrwebEmit binding). */
  domInjected?: boolean;
  /** Whether captured rrweb events are being broadcast right now. Gated so the
   *  page keeps recording (cheap) but no `dom_event` traffic is sent once every
   *  viewer has switched back to the video stream. */
  domEmit?: boolean;
  /** Bootstrap buffer for late-joiners: last Meta (type 4) + FullSnapshot
   *  (type 2) + incrementals since that snapshot (capped). A new DOM-mode viewer
   *  is replayed [meta, full, ...inc] so it can reconstruct without a reload. */
  dom?: { meta: unknown | null; full: unknown | null; inc: unknown[] };
  /** Cached CDP session used to inject the rrweb recorder via Runtime.evaluate
   *  (CSP-exempt, unlike addScriptTag whose inline <script> most real sites'
   *  Content-Security-Policy refuses). Lazily created; detached on destroy. */
  recorderCdp?: import("playwright-core").CDPSession;
}

interface BrowserServiceOptions {
  maxContexts?: number;
  cleanupIntervalMs?: number;
  inactivityTimeoutMs?: number;
  /** Grace window (ms) after the LAST context is gone before the headless
   *  Chromium process itself is reaped. The context sweep only closes
   *  pages/contexts; this closes the whole browser so an idle server with no
   *  open panes holds zero Chromium processes. Relaunches lazily on next use. */
  browserIdleTimeoutMs?: number;
  defaultViewport?: { width: number; height: number };
  screenshotQuality?: number;
  /** CDP remote debugging port (default: 19222 — matches OpenClaw 'topics' browser profile) */
  cdpPort?: number;
  /** Callback invoked after successful navigate(); used to persist topic.browserState. */
  onNavigate?: (contextId: string, url: string, viewport: { width: number; height: number }) => void;
  /** Callback invoked after a context is destroyed; used to flush per-context
   *  caches (e.g. the browser_observe IndexedElement cache) so a recreated
   *  same-id context can't act on stale element coordinates. */
  onDestroy?: (contextId: string) => void;
  /** Override Chromium executable path (highest priority). Falls back to env CHROMIUM_PATH, then chromium.executablePath(), then legacy macOS hardcoded path. */
  chromiumPath?: string;
  /** Phase 30 BROWSER-CHAT-03 — broadcast a message to all WS clients
   *  watching a given contextId. Wired by server.ts via browserWsClients
   *  registry. No-op if absent. */
  broadcastToBrowserWs?: (contextId: string, msg: BrowserWsMessage) => void;
  /** Engine switch (task 54601eeb): how a 'chromium'-engine context connects to
   *  the real Chromium sidecar over CDP. Injectable so the engine branch is
   *  unit-tested without a live browser. Defaults to
   *  playwright chromium.connectOverCDP(endpoint). */
  connectOverCDP?: (endpoint: string) => Promise<Browser>;
  /**
   * Spazza i Chromium marchiati che un server morto sporco ha lasciato in giro
   * (`server/services/browser-orphan-reap.ts`).
   *
   * SPENTO di serie, e lo accende SOLO server.ts. Non è timidezza: il fondo di
   * quella catena è un SIGKILL su pid letti da `ps`, e una ventina di test
   * unitari costruiscono un BrowserService per motivi che con i processi non
   * c'entrano niente. Un segnale che parte come effetto collaterale di un
   * costruttore è il tipo di cosa che si scopre dopo. L'interruttore a caldo,
   * per chi ce l'ha già acceso, è `TOPICS_BROWSER_SWEEP=0` (o `=dry`).
   */
  sweepOrphansAtBoot?: boolean;
}

const MAX_CONSOLE_MESSAGES = 100;

// ── Che campo è a fuoco: la risposta che il ramo video non può darsi da solo ──
// Sul co-browse DOM il pane ha un mirror del DOM e se lo chiede in casa. Sul
// flusso video ha pixel, quindi la domanda («che campo ho toccato?», cioè quale
// tastiera deve aprire il telefono) arriva fin qui, dopo il click.
/** Oltre questo tempo la risposta arriverebbe a tastiera già aperta: si lascia
 *  perdere e il campo di cattura resta sulla tastiera generica. */
const FOCUSED_FIELD_TIMEOUT_MS = 700;
/** Quanti frame interrogare al massimo. Una pagina con cento iframe pubblicitari
 *  non deve trasformare un click in cento round-trip CDP. */
const MAX_FOCUS_FRAMES = 12;

/**
 * Gira DENTRO la pagina remota, un frame alla volta. Restituisce gli attributi
 * del campo a fuoco, o `null` se questo documento non ha il fuoco o se a fuoco
 * non c'è niente di scrivibile (un bottone, un link, il body).
 *
 * Legge attributi, non proprietà: `type` va preso com'è scritto nel sorgente.
 * La proprietà `el.type` di un <input> normalizza un `type` sconosciuto in
 * "text", e la distinzione fra «non dichiarato» e «dichiarato strano» è
 * esattamente quella che decide la tastiera. Che cosa farne lo dice
 * `shared/browser-keyboard-field`, uguale per il mirror e per il server.
 */
const FOCUSED_FIELD_FN = () => {
  if (!document.hasFocus()) return null;
  // Il fuoco può stare in uno shadow DOM: `activeElement` lì fuori mostra solo
  // l'ospite, e l'ospite non è un campo. Si scende finché si scende.
  let el: Element | null = document.activeElement;
  for (let hops = 0; el && hops < 8; hops++) {
    const inner = (el as HTMLElement).shadowRoot?.activeElement;
    if (!inner) break;
    el = inner;
  }
  if (!el || el === document.body || el === document.documentElement) return null;
  const tag = el.tagName.toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || tag === 'select'
    || (el as HTMLElement).isContentEditable;
  if (!editable) return null;
  const attr = (name: string) => (el!.getAttribute(name) || '').trim().toLowerCase();
  return {
    tag,
    type: tag === 'input' ? attr('type') : '',
    inputMode: attr('inputmode'),
    enterKeyHint: attr('enterkeyhint'),
    autoCapitalize: attr('autocapitalize'),
    autoCorrect: attr('autocorrect'),
    spellCheck: attr('spellcheck'),
    disabled: el.hasAttribute('disabled'),
    readOnly: el.hasAttribute('readonly'),
    inForm: !!el.closest('form'),
  };
};
/** Cap on buffered incrementals kept for late-join bootstrap (a Meta+FullSnapshot
 *  resets this). ~4000 covers minutes of a busy page; older ones drop off. */
const MAX_DOM_INCREMENTALS = 4000;

// ── T1 DOM co-browse: rrweb record injection (opt-in, default OFF) ────────────
// The record UMD is vendored (server/assets/rrweb.min.js) at the SAME version as
// the client's Replayer dependency, so capture and replay can never drift.
// Injected into a page ONLY when a viewer requests DOM render mode — the default
// JPEG/WebRTC pixel path is left completely untouched. Captured events (tiny JSON)
// fan out over /ws/browser/:contextId as `dom_event`; each device reconstructs the
// DOM in its own native engine (the real browser, not a video).
let RRWEB_RECORD_BUNDLE = '';
try {
  // Idempotence guard: the bundle opens with `var rrweb = ...`, and at global
  // scope that IS window.rrweb — re-evaluating it (every enableDomMode calls
  // startRecordingNow) would CLOBBER the live module with a fresh-state copy
  // whose internal "recording started" flag is false, breaking
  // record.takeFullSnapshot for late joiners. Only evaluate into a window that
  // doesn't have the recorder yet; `var` hoisting keeps the block harmless.
  RRWEB_RECORD_BUNDLE =
    'if(!(window.rrweb&&window.rrweb.record)){\n' +
    readFileSync(join(import.meta.dir, 'assets', 'rrweb.min.js'), 'utf8') +
    '\n;window.rrweb=window.rrweb||rrweb;\n}';
} catch (err) {
  console.warn('[BrowserService] rrweb record bundle missing — DOM co-browse disabled:', (err as Error)?.message);
}
// Runs in the page AFTER the bundle. Starts the recorder (guarded against a double
// start on the same document) and pipes each event to the host via __rrwebEmit.
// The recorder's stop fn is stashed on window.__rrwebStop so instrumentation is
// REVOCABLE (see RRWEB_STOP) — the mutation observers detach when no one is watching.
// allow-emdash-block: sotto c'è sorgente JS iniettato nella pagina. I trattini
// stanno nei suoi COMMENTI, che non si leggono da nessuna parte nella app.
const RRWEB_RECORD_START = `(function(){
  function emit(p){ try { window.__rrwebEmit && window.__rrwebEmit(JSON.stringify(p)); } catch(_){} }
  if (window.__rrwebStarted) {
    // A recorder is already live on this document (another viewer enabled DOM
    // first, or a reconnect re-asserted the mode). rrweb emits Meta+FullSnapshot
    // only at record() start, so on a static page a no-op here would starve the
    // (reset) server buffer forever — enableDomMode would time out and force the
    // JOINING viewer to video. Force a fresh checkout instead: Meta+FullSnapshot
    // re-emit for everyone (existing mirrors just rebuild once).
    try { window.rrweb.record.takeFullSnapshot(true); }
    catch(e){ emit({ kind:'error', error:String(e&&e.message||e) }); }
    return;
  }
  if (!window.rrweb || !window.rrweb.record) return;
  function start(){
    if (window.__rrwebStarted) return;
    try {
      window.__rrwebStop = window.rrweb.record({
        emit: function(event){ emit({ kind:'event', event:event }); },
        inlineStylesheet: true, inlineImages: false, collectFonts: false, recordCanvas: false,
        // Never stream password field contents in clear (explicit, not just rrweb's
        // default). Other inputs stay visible — a co-browse of a form is the point.
        maskInputOptions: { password: true },
        // input: 'all' — echo EVERY keystroke to the mirror live. rrweb's 'last'
        // only records the final value once the input settles, so a co-browse
        // user typed and saw NOTHING until blur ("scrivo e non appare"). Typing
        // is human-rate (trivial volume vs the throttled mousemove/scroll), so
        // 'all' is the right call for a real, native-feeling text input.
        sampling: { mousemove: 50, scroll: 100, media: 400, input: 'all' },
      });
      window.__rrwebStarted = true;
    } catch(e){ emit({ kind:'error', error:String(e&&e.message||e) }); }
  }
  if (document.readyState === 'interactive' || document.readyState === 'complete') start();
  else window.addEventListener('DOMContentLoaded', function(){ start(); }, { once:true });
})();`;
// Detach the recorder (stops all MutationObservers) and allow a clean restart.
// end-allow-emdash
const RRWEB_STOP = `(function(){ try { if (window.__rrwebStop) { window.__rrwebStop(); window.__rrwebStop = null; } window.__rrwebStarted = false; } catch(_){} })();`;

/**
 * «Dimentica questo sito», il pezzo che gira DENTRO la pagina aperta sul silo
 * da cancellare. Espressione e non funzione tipata perché il codice qui non è
 * codice del server: gira nel renderer, e `evaluate` gli passa la stringa.
 * Ogni pezzo ha il suo try: un IndexedDB bloccato da un'altra tab non deve
 * impedire a localStorage di svuotarsi.
 */
const CLEAR_PAGE_STORAGE = `(async function(){
  try { localStorage.clear(); } catch(_){}
  try { sessionStorage.clear(); } catch(_){}
  try {
    var dbs = indexedDB.databases ? await indexedDB.databases() : [];
    await Promise.all(dbs.map(function(d){
      if (!d || !d.name) return null;
      return new Promise(function(res){
        var req = indexedDB.deleteDatabase(d.name);
        // Anche 'blocked': una cancellazione che aspetta un'altra connessione
        // non deve tenere fermo il dialogo. Il file su disco viene ripulito
        // comunque subito dopo.
        req.onsuccess = req.onerror = req.onblocked = function(){ res(null); };
      });
    }));
  } catch(_){}
})();`;

export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
  ref?: number;
}

/** A screencast frame consumer (one per connected viewer WS). */
export type ScreencastOnFrame = (data: string, metadata: { timestamp: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number }) => void;

export interface BrowserService {
  launch(): Promise<void>;
  close(): Promise<void>;
  /** Get the CDP target ID for a context's page (used for OpenClaw browser tool routing) */
  getTargetId(id: string): Promise<string | null>;
  createContext(id: string, opts?: { viewport?: { width: number; height: number }; persistCookies?: boolean; deviceScaleFactor?: number; engine?: "default" | "chromium"; cdpEndpoint?: string }): Promise<void>;
  destroyContext(id: string): Promise<void>;
  /** Scrivi ADESSO lo storageState di un contesto VIVO sul suo store, senza
   *  chiuderlo. L'autosave normale è a 30s + un salvataggio finale in
   *  `destroyContext`: chi deve LEGGERE quel barattolo mentre il contesto è
   *  ancora acceso (il passaggio condivisa→nativa) leggerebbe roba vecchia di
   *  mezzo minuto — cioè non il login che il telefono ha appena fatto.
   *  `false` quando non c'è nessun contesto vivo con quell'id (nulla da fare:
   *  il file su disco è già l'ultima parola) o quando il salvataggio fallisce. */
  flushStorageState(id: string): Promise<boolean>;
  /** «Dimentica questo sito», metà LETTURA: i silo di identità di questa pane,
   *  con i nomi che il dialogo mostrerà. Legge il contesto vivo se c'è (il file
   *  su disco è vecchio fino a 30s) e il file quando non c'è. Non tocca niente.
   *  `supported:false` sul motore `chromium`: lì l'identità sta nel profilo del
   *  sidecar e da qui non si cancella, e dirlo è meglio che elencare zero
   *  record facendo credere che non ci sia niente. */
  siteDataRecords(id: string): Promise<{ supported: boolean; records: SiteDataRecord[] }>;
  /** «Dimentica questo sito», metà CANCELLAZIONE: toglie i silo NOMINATI (quelli
   *  che il dialogo ha mostrato) prima dal contesto vivo e poi da `storage.json`.
   *  In quest'ordine: pulire solo il file lascerebbe l'identità viva in RAM, e
   *  il primo autosave la riscriverebbe sul disco appena pulito. */
  forgetSite(id: string, displayNames: string[]): Promise<{ supported: boolean; removed: number }>;
  /** Engine switch (task 54601eeb): remember the engine a context must be
   *  (re)created on. Consulted by createContext — so a switch is: setEngineHint →
   *  destroyContext → (client remounts) → getOrCreate → createContext picks it up.
   *  engine 'default' clears the hint. */
  setEngineHint(id: string, engine: "default" | "chromium", cdpEndpoint?: string): void;
  getOrCreate(id: string): Promise<BrowserContextEntry>;
  /** `error` present when goto failed (refused connection, DNS, timeout…):
   *  the page then still reports the PREVIOUS url/title, so callers must
   *  surface the failure instead of treating the stale shape as success. */
  navigate(id: string, url: string): Promise<{ url: string; title: string; error?: string }>;
  goBack(id: string): Promise<{ url: string; title: string }>;
  goForward(id: string): Promise<{ url: string; title: string }>;
  reload(id: string): Promise<void>;
  click(id: string, x: number, y: number, opts?: { button?: "left" | "right" | "middle"; modifiers?: string[] }): Promise<void>;
  clickSelector(id: string, selector: string, opts?: { button?: "left" | "right" | "middle" }): Promise<void>;
  fillSelector(id: string, selector: string, value: string): Promise<void>;
  type(id: string, text: string): Promise<void>;
  keypress(id: string, key: string): Promise<void>;
  scroll(id: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  hover(id: string, x: number, y: number): Promise<void>;
  screenshot(id: string, opts?: { format?: "jpeg" | "png"; quality?: number; fullPage?: boolean }): Promise<Buffer>;
  accessibilitySnapshot(id: string): Promise<{ url: string; title: string; ariaSnapshot: string }>;
  evaluate(id: string, script: string): Promise<any>;
  getConsoleMessages(id: string): { level: string; text: string; timestamp: number }[];
  /** Le richieste di rete registrate su una pane (buffer limitato, non filtrato). */
  getNetworkEntries(id: string): NetworkEntry[];
  /** L'ultimo dialogo apparso su una pane e come è stato chiuso, o null. */
  getLastDialog(id: string): { type: string; message: string; at: number; handled: "accept" | "dismiss" } | null;
  getUrl(id: string): { url: string; title: string } | null;
  listContexts(): { id: string; url: string; title: string; createdAt: string; lastActivity: number }[];
  /** width/height are CSS px (the pane's real size). deviceScaleFactor (HiDPI)
   *  is applied only when the context is CREATED — see the per-context hint +
   *  the immutability note on resize()'s impl. */
  resize(id: string, width: number, height: number, deviceScaleFactor?: number): Promise<void>;
  isLaunched(): boolean;
  saveCookies(id: string): Promise<void>;
  loadCookies(id: string): Promise<void>;
  /** Restore BrowserContext for every topic with browserState. Best-effort — never throws. */
  restoreAllContexts(topics: Topic[]): Promise<{ restored: number; failed: number }>;
  /** Phase 30 BROWSER-CHAT-02 — start CDP screencast, fire onFrame for every JPEG frame. Returns once startScreencast resolves. Fan-out: additional viewers of the same context add their onFrame to the shared CDP session (Page.startScreencast runs only on the first). */
  startScreencast(
    id: string,
    onFrame: ScreencastOnFrame,
    opts?: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number }
  ): Promise<void>;
  /** Phase 30 BROWSER-CHAT-02 — stop CDP screencast. Pass the same onFrame to remove just that viewer; omit it to tear the whole session down. The CDP session detaches only when no viewers remain. Idempotent. */
  stopScreencast(id: string, onFrame?: ScreencastOnFrame): Promise<void>;
  /** Phase 30 BROWSER-CHAT-02 — dispatch input action via Playwright page.mouse.* / page.keyboard.* / page.mouse.wheel. */
  dispatchInput(
    id: string,
    action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
    payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle' }
  ): Promise<void>;
  /** Che campo è a fuoco ADESSO nella pagina remota, descritto negli attributi
   *  che decidono la tastiera (`shared/browser-keyboard-field`). `null` quando
   *  a fuoco non c'è niente di scrivibile, quando il contesto non esiste, o
   *  quando la pagina non risponde in tempo: è una risposta best-effort, letta
   *  subito dopo un click per far vestire il campo di cattura del pane. */
  describeFocusedField(id: string): Promise<RemoteField | null>;
  /** T1 DOM co-browse: inject rrweb into this context's page (idempotent) and
   *  start broadcasting `dom_event`s to its viewers. Resolves with the bootstrap
   *  burst [meta, full, ...incrementals] for the requesting viewer, or null when
   *  DOM mode can't be enabled (no page / injection failed) — the caller then
   *  forces the pane back to the video stream. */
  enableDomMode(id: string): Promise<unknown[] | null>;
  /** T1 DOM co-browse: gate whether captured events are broadcast. The page keeps
   *  recording (cheap) but `dom_event` traffic stops once no viewer is in DOM mode. */
  setDomEmit(id: string, on: boolean): void;
  /** Phase 30 BROWSER-CHAT-03 — broadcast `{ type: 'agent_active', active, action? }`
   *  over the /ws/browser/:contextId bridge. No-op when no broadcast callback was
   *  wired. On `active=true` it attaches the human-readable action label set by the
   *  last `setAgentAction(contextId, …)` (so the UI can say WHAT the agent is doing,
   *  e.g. "Clicca", "Naviga su example.com"); on `active=false` it clears the hint. */
  broadcastAgentActive(contextId: string, active: boolean): void;
  /** Set the human-readable label for the NEXT `agent_active=true` broadcast on
   *  this context (e.g. derived from the tool name + args in the dispatcher).
   *  Consumed-then-retained: read by broadcastAgentActive(true), cleared on
   *  broadcastAgentActive(false). Pass null to clear. */
  setAgentAction(contextId: string, action: string | null): void;
  /** Phase 30 BROWSER-CHAT-03 — DOM walker that indexes interactive elements
   *  with bounding boxes for the browser_observe tool. Side effect: assigns
   *  data-topics-idx="N" attribute on each indexed element (cleaned by
   *  captureAnnotatedScreenshot's finally-block). Max 50 elements default,
   *  clamped to range 1-100. */
  extractIndexedElements(contextId: string, opts?: { maxElements?: number }): Promise<IndexedElement[]>;
  /** Phase 30 BROWSER-CHAT-03 — overlay-injected JPEG screenshot with bbox
   *  bordering + numbered label badges. Returns base64 string. Cleans up the
   *  overlay container + data-topics-idx attributes in a finally block (best
   *  effort — cleanup errors do not propagate). */
  captureAnnotatedScreenshot(contextId: string, elements: IndexedElement[], opts?: { quality?: number }): Promise<string>;
  /** Phase 30 BROWSER-CHAT-04 — DOM info at a viewport point for the
   *  Cursor-style select-element pattern (Cmd+Shift+E). Returns DOM XPath +
   *  CSS-style selector + bbox + truncated text, or null if no element exists
   *  at the point or the context is gone. */
  resolveElementAtPoint(
    contextId: string,
    point: { x: number; y: number },
  ): Promise<{
    path: string;
    cssPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text?: string;
  } | null>;
  /** 4.2 — la descrizione COMPLETA dell'elemento sotto il punto: markup potato,
   *  stile calcolato, antenati e un ritaglio dello schermo. È quello che serve
   *  a un modello per MODIFICARE l'elemento; `resolveElementAtPoint` basta solo
   *  a nominarlo (e resta perché l'hover lo chiama ogni 100 ms).
   *  Null alle stesse condizioni: contesto assente o punto vuoto. */
  describeElementAtPoint(
    contextId: string,
    point: { x: number; y: number },
    opts?: { screenshot?: boolean },
  ): Promise<ElementDescription | null>;
}

/**
 * The CDP port the headless Chromium listens on, derived from the server port.
 *
 * 19222 is the production number and stays the production number: it is what the
 * OpenClaw `topics` browser profile answers on, and the probe at
 * `/json/list` below reaches an already-running browser through it.
 *
 * A TEST server must not take it. The number used to be a hard-coded constant
 * shared by every server on the machine, so a spec that launched a server-side
 * Chromium while the production one held 19222 died with
 * `bind() failed: Address already in use (48)` and Playwright SIGKILLed the
 * launch. Observed on 2026-08-15 during a four-shard run, on a spec that has
 * nothing to do with browsers. The DB directory, the PTY socket and the
 * ai-bridge socket all already derive from `BUN_PORT`
 * (scripts/start-test-server.sh); this was the fourth of that family and the
 * only one still shared.
 *
 * Mapping: 13334 -> 19334, 13400 -> 19400. One CDP port per server port, inside
 * a band nothing else on this machine claims. Production (3333) and any server
 * that does not declare a port keep 19222, so nothing about the shipped app
 * changes.
 */
export function defaultCdpPort(env: Record<string, string | undefined> = process.env): number {
  const explicit = Number(env.TOPICS_CDP_PORT);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const serverPort = Number(env.BUN_PORT || env.PORT || 0);
  if (!Number.isInteger(serverPort) || serverPort <= 0 || serverPort === 3333) return 19222;
  return 19000 + (serverPort % 1000);
}

export async function createBrowserService(opts: BrowserServiceOptions = {}): Promise<BrowserService> {
  const {
    maxContexts = 20,
    cleanupIntervalMs = 60_000,
    inactivityTimeoutMs = 30 * 60 * 1000,
    browserIdleTimeoutMs = 5 * 60 * 1000,
    defaultViewport = { width: 1280, height: 720 },
    screenshotQuality = 70,
    cdpPort = defaultCdpPort(),
  } = opts;

  const cookieDir = join(process.env.HOME || "/tmp", ".openclaw", "workspace", "topics-app", ".browser-cookies");
  try { mkdirSync(cookieDir, { recursive: true }); } catch {}

  // Downloads triggered by the headless page are saved here and served at
  // /media/browser/downloads/<file> (mediaBase = ~/.openclaw/media, see server.ts).
  // The web streaming pane has no native download shelf, so it surfaces a
  // user-clickable link to the saved file instead of losing the download.
  const browserDownloadDir = join(process.env.HOME || "/tmp", ".openclaw", "media", "browser", "downloads");
  try { mkdirSync(browserDownloadDir, { recursive: true }); } catch {}

  const contexts = new Map<string, BrowserContextEntry>();
  const targetIds = new Map<string, string>();  // contextId → CDP targetId
  // Human-readable label of the in-flight agent action, keyed by contextId.
  // Set by the tool dispatcher (setAgentAction) right before a handler runs,
  // attached to the next agent_active=true broadcast, cleared on active=false.
  const agentActionHints = new Map<string, string>();
  // Phase 30 BROWSER-CHAT-02 — active CDP screencast sessions. Keyed by
  // contextId. Set by startScreencast, deleted by stopScreencast (idempotent).
  // Cleaned up by close() and destroyContext() before the underlying
  // BrowserContext is torn down.
  const screencastSessions = new Map<string, {
    cdpSession: import("playwright-core").CDPSession;
    // Fan-out: one shared CDP session, N viewer callbacks. A 2nd viewer of the
    // same context joins the set (instead of stealing the single onFrame), and
    // the session is torn down only when the LAST viewer detaches.
    subscribers: Set<ScreencastOnFrame>;
    // The opts the stream was started with — resize() restarts the screencast
    // with the same format/quality but the NEW viewport-derived dims.
    opts?: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number };
  }>();
  // Desired viewport + HiDPI per contextId, recorded by resize() BEFORE the
  // context may exist. createContext() consults it so the FIRST-open size + DPR
  // take effect at creation (the client sends resize on ws.onopen, which lands
  // inside the 250ms screencast grace, before getOrCreate creates the context).
  // deviceScaleFactor is immutable per Playwright context → for an already-live
  // context a new DPR only applies after a reap+recreate (first-DPR-wins).
  const pendingViewportHints = new Map<string, { width: number; height: number; deviceScaleFactor: number }>();
  // Engine switch (task 54601eeb): the engine a context must be (re)created on.
  // createContext consults this BEFORE launching the headless Chromium, so a
  // 'chromium' pane connects to the sidecar over CDP instead. Symmetric with
  // pendingViewportHints: set by setEngineHint, cleared on switch-to-default and
  // on destroyContext. Absent entry ⇒ the default headless engine.
  const pendingEngineHints = new Map<string, { engine: "default" | "chromium"; cdpEndpoint?: string }>();
  // Single-flight guard for createContext: on a fresh pane the WS-open handler
  // (screencast bootstrap), set_render and nav all hit getOrCreate CONCURRENTLY.
  // Without this, each racer built a full Playwright context for the same id and
  // the last `contexts.set` won — the losers leaked as ORPHAN live pages. With
  // DOM co-browse the damage was visible: recorder, __rrwebEmit binding and the
  // 'load' re-arm all lived on an orphan stuck on about:blank, so every viewer
  // mirrored a blank page forever (live repro 2026-07-20: double "Context
  // created" lines per id with two targetIds).
  const pendingCreates = new Map<string, Promise<void>>();
  // How a chromium-engine context reaches the real Chromium (injectable for tests).
  const connectOverCDP =
    opts.connectOverCDP ??
    (async (endpoint: string) => (await import("playwright-core")).chromium.connectOverCDP(endpoint));
  /** Clamp DPR to a bandwidth-safe range: 2× covers virtually all retina Macs;
   *  3× would quadruple+ frame bytes and trip the backpressure drop. */
  const clampDsf = (dsf: number | undefined): number => {
    if (!dsf || !Number.isFinite(dsf) || dsf < 1) return 1;
    return Math.min(dsf, 2);
  };
  let browser: Browser | null = null;
  // Single-flight launch guard: in-flight chromium.launch() promise, shared by
  // all concurrent ensureBrowser() callers so a cold start spawns ONE Chromium.
  let browserLaunching: Promise<Browser> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  // Wall-clock of the last activity across ANY context. Drives the browser-idle
  // reaper below: once no context remains and this is older than the grace
  // window, the Chromium process is closed (it relaunches lazily on next use).
  let lastActivityAt = Date.now();

  async function ensureBrowser(): Promise<Browser> {
    if (browser && browser.isConnected()) return browser;
    // Coalesce concurrent cold-starts. After a server restart every WS browser
    // pane reconnects at once → getOrCreate → ensureBrowser, all racing past the
    // isConnected() check before `browser` is set. Without this guard each ran
    // chromium.launch(), spawning N Chromium instances and orphaning all but the
    // last (only that one is tracked by `browser`, so only it is reapable) — a
    // multi-hundred-MB leak on every concurrent boot.
    if (browserLaunching) return browserLaunching;
    browserLaunching = launchBrowserOnce();
    try { return await browserLaunching; }
    finally { browserLaunching = null; }
  }

  async function launchBrowserOnce(): Promise<Browser> {
    const pw = await import("playwright-core");

    // Path resolution chain (priority order):
    //   1. opts.chromiumPath (constructor)
    //   2. process.env.CHROMIUM_PATH
    //   3. pw.chromium.executablePath() (Playwright bundled Chromium)
    //   4. legacy macOS hardcoded paths (defense in depth, logged warning)
    let chromiumPath: string | undefined;
    const tried: string[] = [];

    if (opts.chromiumPath) {
      chromiumPath = opts.chromiumPath;
      tried.push(`opts.chromiumPath=${chromiumPath}`);
    }
    if (!chromiumPath && process.env.CHROMIUM_PATH) {
      chromiumPath = process.env.CHROMIUM_PATH;
      tried.push(`env CHROMIUM_PATH=${chromiumPath}`);
    }
    if (!chromiumPath) {
      try {
        const pwPath = pw.chromium.executablePath();
        if (pwPath && existsSync(pwPath)) {
          chromiumPath = pwPath;
          tried.push(`playwright-core executablePath=${chromiumPath}`);
        } else {
          tried.push(`playwright-core executablePath=${pwPath || "(empty)"} (not found on disk)`);
        }
      } catch (err: any) {
        tried.push(`playwright-core executablePath threw: ${err.message}`);
      }
    }
    if (!chromiumPath) {
      // BUGFIX 2026-05-05: playwright-core's bundled `executablePath()` can point
      // to a build revision (e.g. chromium-1208) that isn't actually installed
      // on disk if the user has multiple Playwright versions or upgraded
      // @playwright/test independently. Glob the cache dir for ANY existing
      // chromium-* build (highest revision wins) before falling back to
      // hardcoded paths. Recovers gracefully from version drift without
      // requiring user to reinstall browsers.
      const cacheRoot = `${process.env.HOME}/Library/Caches/ms-playwright`;
      try {
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        const dirs = readdirSync(cacheRoot, { withFileTypes: true })
          .filter(d => d.isDirectory() && /^chromium-\d+$/.test(d.name))
          .map(d => ({ name: d.name, rev: parseInt(d.name.split("-")[1] || "0", 10) }))
          .sort((a, b) => b.rev - a.rev);
        for (const dir of dirs) {
          const candidates = [
            `${cacheRoot}/${dir.name}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
            `${cacheRoot}/${dir.name}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
            `${cacheRoot}/${dir.name}/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
            `${cacheRoot}/${dir.name}/chrome-linux/chrome`,
          ];
          for (const p of candidates) {
            if (existsSync(p)) {
              chromiumPath = p;
              if (dir.name !== "chromium-1208") {
                console.warn(`[BrowserService] Auto-discovered Chromium at ${p}. Playwright bundled path missing — using ${dir.name}. Run \`bun playwright install chromium\` to silence this warning.`);
              }
              tried.push(`auto-discovered=${p}`);
              break;
            }
          }
          if (chromiumPath) break;
        }
      } catch (err: any) {
        tried.push(`auto-discovery threw: ${err.message}`);
      }
    }
    if (!chromiumPath) {
      // Legacy fallback chain (macOS hardcoded). Last-resort defense.
      const playwrightDir = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208`;
      const legacy = [
        `${playwrightDir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
        `${playwrightDir}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
        `${playwrightDir}/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
        `${playwrightDir}/chrome-linux/chrome`,
      ];
      for (const p of legacy) {
        if (existsSync(p)) {
          chromiumPath = p;
          console.warn(`[BrowserService] Using legacy hardcoded Chromium path: ${p}. Set CHROMIUM_PATH env var to silence this warning.`);
          tried.push(`legacy=${p}`);
          break;
        }
      }
    }
    if (!chromiumPath) {
      throw new Error(`Chromium executable not found. Tried:\n  ${tried.join("\n  ")}`);
    }

    console.log(`[BrowserService] Chromium path: ${chromiumPath}`);
    browser = await pw.chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${cdpPort}`,
        // Il marchio. Chromium ignora gli switch che non conosce, `ps` invece
        // ce lo restituisce: è così che il prossimo avvio riconosce questo
        // processo come proprio se noi moriamo di SIGKILL e lui sopravvive.
        // Il pid dentro è il NOSTRO, non il suo: è il padre di cui si verifica
        // la morte. Vedi server/lib/browser-orphan-sweep.ts.
        browserMarkArg("agent", process.pid),
      ],
    });
    console.log(`[BrowserService] Chromium launched (CDP port: ${cdpPort})`);
    // Recovery: if Chromium dies (crash/OOM/GPU), every context+page it owns is
    // dead. Purge the maps so getOrCreate() recreates on the relaunched browser
    // (ensureBrowser is lazy — it checks isConnected()) instead of handing back
    // corpses, and so their autosave timers stop. Without this, dead entries
    // linger AND touchActivity() keeps refreshing them, starving the idle reaper.
    browser.on("disconnected", () => {
      if (contexts.size) {
        console.warn(`[BrowserService] Chromium disconnected — purging ${contexts.size} stale context(s)`);
      }
      for (const e of contexts.values()) { try { e.autoSaveCleanup?.(); } catch { /* ignore */ } }
      contexts.clear();
      targetIds.clear();
      screencastSessions.clear();
      agentActionHints.clear();
    });
    return browser;
  }

  function touchActivity(entry: BrowserContextEntry) {
    entry.lastActivity = Date.now();
    lastActivityAt = entry.lastActivity;
  }

  async function setupPage(entry: BrowserContextEntry, id: string) {
    // Idempotency guard: never bind console/load listeners twice on the same
    // entry (would double-push console messages + re-fire navigation tracking).
    if (entry.listenersBound) return;
    entry.listenersBound = true;
    const page = entry.page;

    // --- Rete ---------------------------------------------------------------
    // Registrare È il punto: la richiesta che spiega «il bottone non fa niente»
    // passa una volta sola, e se nessuno la stava ascoltando è persa. Il costo è
    // un array limitato per pane; il filtro (quello che evita il muro di token)
    // sta a valle, in `browser-network-log.ts`.
    entry.network ??= [];
    page.on("request", (req) => {
      try {
        pushNetworkEntry(entry.network!, {
          startedAt: Date.now(),
          method: req.method(),
          url: req.url(),
          resourceType: req.resourceType(),
        });
      } catch { /* il registro non deve mai poter rompere la pagina */ }
    });
    page.on("response", (res) => {
      try { completeNetworkEntry(entry.network!, res.url(), { status: res.status(), at: Date.now() }); }
      catch { /* idem */ }
    });
    page.on("requestfailed", (req) => {
      try {
        completeNetworkEntry(entry.network!, req.url(), {
          failure: req.failure()?.errorText || "richiesta fallita",
          at: Date.now(),
        });
      } catch { /* idem */ }
    });

    // --- Dialoghi -----------------------------------------------------------
    // Un `alert()`/`confirm()` non gestito blocca OGNI evento successivo della
    // pagina: l'agente non sbaglia, si pianta, e all'umano arriva «il browser non
    // risponde». Playwright di suo li chiude, ma in silenzio — e il silenzio è
    // esattamente ciò che rende la diagnosi impossibile. Qui si chiude E si
    // registra cosa c'era scritto, che è la metà utile.
    page.on("dialog", async (d) => {
      const type = d.type();
      const message = d.message();
      // `beforeunload` si ACCETTA (lasciar andare via), gli altri si chiudono:
      // rifiutare è la scelta prudente per un agente che non ha chiesto niente.
      const handled: "accept" | "dismiss" = type === "beforeunload" ? "accept" : "dismiss";
      entry.lastDialog = { type, message, at: Date.now(), handled };
      try { handled === "accept" ? await d.accept() : await d.dismiss(); } catch { /* già chiuso */ }
      console.log(`[BrowserService] dialogo ${type} su ${id}: "${message.slice(0, 120)}" → ${handled}`);
    });

    // Live console forwarding to the web streaming pane (schema `console`, which
    // the client already handles). error/warn always pass; log/info/debug go
    // through a token bucket (10/s, burst 10) so a chatty page can't flood the
    // WS. The full ring buffer is still available via REST /console unthrottled.
    let consoleTokens = 10;
    let consoleLastRefill = Date.now();
    const mapConsoleLevel = (t: string): 'log' | 'warn' | 'error' =>
      t === 'error' ? 'error' : (t === 'warning' || t === 'warn') ? 'warn' : 'log';
    page.on("console", (msg) => {
      const rawType = msg.type();
      const text = msg.text();
      entry.consoleMessages.push({
        level: rawType,
        text,
        timestamp: Date.now(),
      });
      if (entry.consoleMessages.length > MAX_CONSOLE_MESSAGES) {
        entry.consoleMessages.shift();
      }
      const level = mapConsoleLevel(rawType);
      if (level === 'log') {
        const now = Date.now();
        consoleTokens = Math.min(10, consoleTokens + (now - consoleLastRefill) / 100);
        consoleLastRefill = now;
        if (consoleTokens < 1) return;
        consoleTokens -= 1;
      }
      opts.broadcastToBrowserWs?.(id, {
        type: 'console',
        level,
        text: text.length > 2000 ? text.slice(0, 2000) + '…' : text,
      });
    });

    // Downloads: the web streaming pane has no native download shelf (the Tauri
    // DownloadStrip is native-only). Save each download under our served media
    // dir and surface a user-clickable link — no silent loss, no auto-open.
    page.on("download", (download) => {
      const rawName = download.suggestedFilename() || "download";
      const safeName = rawName.replace(/[^\w.\-]+/g, "_").slice(-120);
      const safeCtx = id.replace(/[^\w.\-]+/g, "_");
      const stamped = `${safeCtx}__${Date.now()}__${safeName}`;
      const dest = join(browserDownloadDir, stamped);
      const href = `/media/browser/downloads/${encodeURIComponent(stamped)}`;
      opts.broadcastToBrowserWs?.(id, { type: "download", filename: rawName, href, state: "started" });
      download.saveAs(dest).then(() => {
        let size: number | undefined;
        try { size = statSync(dest).size; } catch {}
        opts.broadcastToBrowserWs?.(id, { type: "download", filename: rawName, href, size, state: "completed" });
      }).catch((err: any) => {
        console.warn(`[BrowserService] download saveAs failed for ${id}:`, err?.message);
        opts.broadcastToBrowserWs?.(id, { type: "download", filename: rawName, href, state: "failed" });
      });
    });

    // Track navigation
    page.on("load", async () => {
      entry.url = page.url();
      // Persist the last real page per context id so a recreated context
      // (server restart, inactivity reap) can reopen where it was — the
      // saver itself ignores about:blank / non-http urls.
      saveLastUrl(id, entry.url);
      try { entry.title = await page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
      // Out-of-band navigations (agent tools, last-url restore, in-page link
      // clicks) must reach the pane too: nav/response was previously emitted
      // only for client-INITIATED navs, so every other navigation source left
      // the URL bar stale — a restored context streamed its page while the
      // pane still said "Browser ready". Guarded to real pages so the initial
      // about:blank load can't clobber the pane's url state.
      if (/^https?:\/\//.test(entry.url)) {
        opts.broadcastToBrowserWs?.(id, { type: "nav", url: entry.url, phase: "response" });
      }
    });
  }

  // T1 DOM co-browse: (re)inject the rrweb record bundle + start into the CURRENT
  // document via CDP Runtime.evaluate — NOT addScriptTag. addScriptTag inserts a
  // real inline <script>, which the page's Content-Security-Policy refuses on most
  // of the modern web (GitHub, Google, …: `script-src 'self'` with no
  // 'unsafe-inline') → the bundle silently never runs, no rrweb events flow, and
  // DOM mode falls back to video. Runtime.evaluate runs the code at page-global
  // scope AS THE DEBUGGER (CSP-exempt), so the bundle's top-level `var rrweb`
  // still becomes a real page global and recording starts everywhere. The recorder
  // world matches the exposed __rrwebEmit binding (both main-world). Best-effort:
  // about:blank / a mid-navigation page can reject — the next 'load' re-injects.
  async function startRecordingNow(entry: BrowserContextEntry): Promise<void> {
    if (!entry.recorderCdp) {
      entry.recorderCdp = await entry.context.newCDPSession(entry.page);
    }
    const cdp = entry.recorderCdp;
    const run = async (expression: string) => {
      const res = (await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: false,
        awaitPromise: false,
      })) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "rrweb eval error");
      }
    };
    await run(RRWEB_RECORD_BUNDLE);
    await run(RRWEB_RECORD_START);
  }

  // Bind the rrweb host plumbing to a context's page — ONCE. Deliberately does NOT
  // use addInitScript (Playwright can't remove it, so it would re-instrument every
  // future navigation forever, even after all viewers leave DOM mode). Instead the
  // recorder is (re)injected on demand and on each 'load' WHILE domEmit is true, and
  // torn down (RRWEB_STOP detaches the observers) the moment it isn't — so DOM
  // instrumentation is fully revocable except one inert binding. Returns false when
  // the vendored bundle is missing or the exposed binding can't be installed.
  async function ensureDomBinding(entry: BrowserContextEntry, id: string): Promise<boolean> {
    if (entry.domInjected) return true;
    if (!RRWEB_RECORD_BUNDLE) return false; // vendored bundle missing
    try {
      // Host binding: every rrweb event lands here. Buffer for late-join bootstrap,
      // and broadcast live only while at least one viewer is in DOM mode.
      await entry.page.exposeFunction('__rrwebEmit', (json: string) => {
        if (!entry.dom) return;
        let m: { kind?: string; event?: { type?: number }; error?: string };
        try { m = JSON.parse(json); } catch { return; }
        // In-page recorder failures are otherwise invisible (the page can't log
        // to us) — surface them, they're the difference between "unsupported
        // page" and a plumbing bug.
        if (m.kind === 'error') {
          console.warn(`[BrowserService] rrweb in-page error for ${id}:`, m.error);
          return;
        }
        if (m.kind !== 'event' || !m.event) return;
        const e = m.event;
        const buf = entry.dom;
        if (e.type === 4) buf.meta = e;                        // Meta
        else if (e.type === 2) { buf.full = e; buf.inc = []; } // FullSnapshot → reset prefix
        else { buf.inc.push(e); if (buf.inc.length > MAX_DOM_INCREMENTALS) buf.inc.shift(); }
        if (entry.domEmit) opts.broadcastToBrowserWs?.(id, { type: 'dom_event', event: e });
      });
      // Re-arm the recorder after each navigation, but ONLY while a viewer wants it.
      entry.page.on('load', () => {
        if (entry.domEmit) startRecordingNow(entry).catch((err: unknown) => {
          // A dead re-arm strands every DOM viewer on the previous page's mirror
          // — never swallow it silently.
          console.warn(`[BrowserService] rrweb re-arm failed for ${id}:`, (err as Error)?.message);
        });
      });
      entry.domInjected = true;
      return true;
    } catch (err) {
      console.warn(`[BrowserService] rrweb binding failed for ${id}:`, (err as Error)?.message);
      return false;
    }
  }

  // Reap inactive contexts, then the idle Chromium itself. Started from
  // createBrowserService (NOT from launch(), which the server never calls in
  // its lazy-launch setup) so the reaper is always live. Idempotent.
  function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      // Snapshot the stale ids first — destroyContext mutates `contexts`
      // asynchronously, so we must not delete mid-iteration. Skip any context
      // with a live screencast: a viewer is watching it right now, and frames
      // don't bump lastActivity, so reaping it would blank the pane.
      const stale: string[] = [];
      for (const [id, entry] of contexts) {
        if (screencastSessions.has(id)) continue;
        if (now - entry.lastActivity > inactivityTimeoutMs) stale.push(id);
      }
      for (const id of stale) {
        const entry = contexts.get(id);
        const mins = entry ? Math.round((now - entry.lastActivity) / 60000) : 0;
        console.log(`[BrowserService] Auto-closing inactive context: ${id} (inactive ${mins}min)`);
        // Use the full teardown path: destroyContext stops the screencast,
        // clears the targetIds mapping and runs the autosave/cookie flush.
        // The old inline close() leaked the CDP screencast session + targetId,
        // which froze the pane (black frame) when the context was re-created.
        service.destroyContext(id).catch(() => {});
      }

      // Reap the headless Chromium once every context is gone and it has sat
      // idle past the grace window. destroyContext above only tears down
      // pages/contexts — without this the browser process (browser + GPU +
      // network + utility procs, ~hundreds of MB) would linger for the entire
      // server lifetime even with zero open panes. ensureBrowser() relaunches
      // it lazily on the next navigate/createContext, so this is recoverable.
      // (contexts mutate async from the loop above, so a just-emptied map is
      // caught on the next tick — that's fine, it's a slow reaper.)
      if (browser && browser.isConnected() && contexts.size === 0 &&
          now - lastActivityAt > browserIdleTimeoutMs) {
        const idleMin = Math.round((now - lastActivityAt) / 60000);
        console.log(`[BrowserService] Reaping idle Chromium (0 contexts, idle ${idleMin}min) — relaunches on demand`);
        const b = browser;
        browser = null;  // null first so a racing ensureBrowser relaunches cleanly
        b.close().catch(() => {});
      }
    }, cleanupIntervalMs);
  }

  // ── «Dimentica questo sito» sulla pane condivisa ──────────────────────────
  // Il modulo puro (`browser-site-data`) sa leggere e potare uno `storageState`.
  // Quello che sa solo qui dentro è DOVE sta lo stato buono: nel contesto vivo
  // finché c'è, e sul disco quando non c'è più nessuno acceso.

  /**
   * Lo stato da cui si legge l'inventario, e il contesto vivo se esiste.
   * Il file lo scrive un autosave a 30s: leggerlo mentre il contesto è acceso
   * significherebbe elencare un login fatto mezzo minuto fa come se non ci
   * fosse. Se il contesto vivo non risponde si ripiega sul file: meglio un
   * elenco vecchio che un dialogo che non si apre.
   */
  async function readSiteData(
    id: string,
  ): Promise<{ supported: boolean; entry?: BrowserContextEntry; state: BrowserStorageState | null }> {
    const entry = contexts.get(id);
    // Motore `chromium`: il profilo è del sidecar, `storage.json` non è la sua
    // identità e cancellarlo non sloggherebbe niente. Vedi `flushStorageState`.
    if (entry?.engine === "chromium") return { supported: false, state: null };
    if (entry) {
      try {
        return { supported: true, entry, state: await entry.context.storageState({ indexedDB: true }) };
      } catch (err: any) {
        console.warn(`[BrowserService] readSiteData(${id}) live read failed:`, err?.message ?? err);
        return { supported: true, entry, state: await loadStorageState(id) };
      }
    }
    return { supported: true, state: await loadStorageState(id) };
  }

  /**
   * Toglie i silo nominati dal contesto ACCESO, nei tre posti in cui vivono.
   * Tutto best-effort: un pezzo che fallisce non deve impedire agli altri di
   * cancellare, e comunque il file viene riscritto dopo.
   */
  async function purgeLiveSilos(
    entry: BrowserContextEntry,
    names: string[],
    state: BrowserStorageState | null,
  ): Promise<void> {
    const targets = new Set(names);
    // 1. I cookie. `clearCookies({ domain })` taglia per dominio ESATTO e non sa
    //    del punto iniziale (`.github.com`): rileggerli tutti e riscrivere quelli
    //    che restano cancella esattamente i silo elencati, niente di più.
    try {
      const live = await entry.context.cookies();
      const keep = live.filter((c) => !targets.has(cookieSilo(c.domain)));
      if (keep.length !== live.length) {
        await entry.context.clearCookies();
        if (keep.length > 0) await entry.context.addCookies(keep);
      }
    } catch (err: any) {
      console.warn(`[BrowserService] purgeLiveSilos cookies failed:`, err?.message ?? err);
    }
    // 2. localStorage e IndexedDB, un origin alla volta. Via CDP e non con una
    //    evaluate, perché l'origin da svuotare quasi mai è quello della pagina
    //    aperta: `Storage.clearDataForOrigin` ci arriva senza doverci navigare.
    const origins = originsOfSilos(state, names);
    if (origins.length > 0) {
      let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | null = null;
      try {
        session = await entry.context.newCDPSession(entry.page);
        for (const origin of origins) {
          await session.send("Storage.clearDataForOrigin", {
            origin,
            storageTypes: "local_storage,indexeddb",
          });
        }
      } catch (err: any) {
        console.warn(`[BrowserService] purgeLiveSilos origins failed:`, err?.message ?? err);
      } finally {
        if (session) await session.detach().catch(() => {});
      }
    }
    // 3. La pagina APERTA su uno dei silo. Il renderer tiene la sua copia di
    //    localStorage in RAM e la riscriverebbe al prossimo `setItem`, quindi
    //    svuotarla dal browser non basta: qui è l'unico caso in cui una evaluate
    //    serve, ed è anche quello che l'utente sta guardando.
    try {
      if (targets.has(originSilo(entry.page.url()))) {
        await entry.page.evaluate(CLEAR_PAGE_STORAGE);
      }
    } catch (err: any) {
      console.warn(`[BrowserService] purgeLiveSilos page failed:`, err?.message ?? err);
    }
  }

  const service: BrowserService = {
    async launch() {
      // Optional pre-warm: eagerly spin up Chromium. The server does NOT call
      // this (it relies on lazy launch); the reaper is started at creation
      // below, independent of this. startCleanup() is idempotent.
      await ensureBrowser();
      startCleanup();
      console.log("[BrowserService] Ready");
    },

    async close() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      // Phase 30 BROWSER-CHAT-02 — stop all active screencasts BEFORE
      // closing contexts. Detaches CDP sessions cleanly so the close()
      // call doesn't race with in-flight Page.screencastFrame events.
      for (const id of Array.from(screencastSessions.keys())) {
        await service.stopScreencast(id).catch(() => {});
      }
      for (const [_id, entry] of contexts) {
        entry.autoSaveCleanup?.();
        // Chromium engine: disconnect the CDP client — NEVER close the shared
        // sidecar context (that would kill the user's other sidecar tabs).
        if (entry.engine === "chromium") {
          try { await entry.page.close(); } catch {}
          try { await entry.engineBrowser?.close(); } catch {}
        } else {
          try { await entry.context.close(); } catch {}
        }
      }
      contexts.clear();
      targetIds.clear();
      if (browser) {
        try { await browser.close(); } catch {}
        browser = null;
      }
      console.log("[BrowserService] Closed");
    },

    async createContext(id, opts) {
      // Coalesce concurrent creates for the same id (see pendingCreates above).
      // The first caller's opts win — correct for the same-id race, where every
      // racer wants "the context for this pane", not a specific configuration.
      const inflight = pendingCreates.get(id);
      if (inflight) return inflight;
      const create = (async () => {
      if (contexts.has(id)) return;
      if (contexts.size >= maxContexts) {
        throw new Error(`Max contexts (${maxContexts}) reached`);
      }

      // Engine switch (task 54601eeb): a 'chromium' pane connects to the real
      // user-installed Chromium (sidecar) over CDP instead of launching our own
      // headless one. The engine hint (set by the switch) wins over the call opt,
      // so a getOrCreate-triggered recreate after a switch lands on chromium.
      const engineHint = pendingEngineHints.get(id);
      const engine = engineHint?.engine ?? opts?.engine ?? "default";
      const cdpEndpoint = engineHint?.cdpEndpoint ?? opts?.cdpEndpoint;
      if (engine === "chromium") {
        if (!cdpEndpoint) throw new Error(`chromium engine for ${id} requires a cdpEndpoint`);
        const engineBrowser = await connectOverCDP(cdpEndpoint);
        // The extensions live in the sidecar's persistent default context — use it
        // (don't newContext, which would be a fresh incognito profile with none).
        const context = engineBrowser.contexts()[0] ?? (await engineBrowser.newContext());
        try {
          const page = await context.newPage();
          // Capture the CDP targetId (agent routing) — same as the default path.
          try {
            const session = await context.newCDPSession(page);
            try {
              const info = (await session.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
              if (info?.targetInfo?.targetId) targetIds.set(id, info.targetInfo.targetId);
            } finally {
              await session.detach().catch(() => {});
            }
          } catch (err: any) {
            console.warn(`[BrowserService] chromium targetId capture failed for ${id}:`, err.message);
          }
          const entry: BrowserContextEntry = {
            context,
            page,
            createdAt: new Date().toISOString(),
            lastActivity: Date.now(),
            url: "about:blank",
            title: "",
            consoleMessages: [],
            // deviceScaleFactor is the real Chromium's own — not forced.
            engine: "chromium",
            engineBrowser,
          };
          contexts.set(id, entry);
          lastActivityAt = entry.lastActivity;
          await setupPage(entry, id);
          // No storageState / last-url restore / cookie load / autosave: the
          // sidecar owns a persistent on-disk profile (Option 1), so per-context
          // state serialization would fight it. The pane navigates fresh.
          console.log(`[BrowserService] Chromium-engine context created: ${id} (via ${cdpEndpoint})`);
          return;
        } catch (err) {
          contexts.delete(id);
          targetIds.delete(id);
          agentActionHints.delete(id);
          // Disconnect the CDP client (never kill the sidecar — the registry owns it).
          try { await engineBrowser.close(); } catch {}
          throw err;
        }
      }

      const b = await ensureBrowser();
      // Prefer the client's latest resize hint (real pane size + DPR) over the
      // caller viewport/default, so the FIRST-open render already matches the
      // pane and is HiDPI-sharp instead of the fixed 1280 letterbox.
      const hint = pendingViewportHints.get(id);
      const viewport = hint
        ? { width: hint.width, height: hint.height }
        : (opts?.viewport || defaultViewport);
      const deviceScaleFactor = clampDsf(hint?.deviceScaleFactor ?? opts?.deviceScaleFactor);

      // Un solo cassetto cookie. Se su QUESTO contesto c'è ancora una pane
      // nativa viva (è il caso dell'auto-share: il telefono si affaccia, la
      // sessione condivisa nasce, e solo 1200ms dopo il Mac lascia la
      // WKWebView), versa il suo barattolo nel seme prima di leggerlo. Senza
      // questo passaggio i due lati hanno cookie separati e chi era loggato di
      // là si ritrova sloggato di qua. Non lancia mai e ha un tetto di 2s: al
      // massimo la pane nasce sloggata com'era prima. Vedi
      // browser-session-handoff.ts per le regole (fonde, non sovrascrive; non
      // scrive mai il vuoto; solo nativa → condivisa).
      const handoff = await seedSharedFromNative(id);
      if (handoff.ok) {
        console.log(`[BrowserService] cookie della pane nativa passati alla sessione condivisa ${id} (${handoff.cookies} cookie, ${handoff.origins} origini)`);
      } else if (handoff.skipped !== "no-native-pane") {
        console.warn(`[BrowserService] passaggio cookie nativa→condivisa saltato per ${id}: ${handoff.skipped}${handoff.error ? ` (${handoff.error})` : ""}`);
      }

      // Load persisted storageState if available (cookies + localStorage).
      // null is fine — newContext accepts undefined storageState.
      const persistedState = await loadStorageState(id);
      const context = await b.newContext({
        viewport,
        // deviceScaleFactor is immutable per context — this is the ONLY place it
        // is set. >1 makes CDP render the page at retina backing-store size; the
        // screencast then clamps frames to width*dsf (see startScreencast/resize).
        deviceScaleFactor,
        ...(persistedState ? { storageState: persistedState } : {}),
      });

      try {
        const page = await context.newPage();

        // Capture explicit targetId via CDP (replaces the legacy DOM title-marker hack).
        try {
          const session = await context.newCDPSession(page);
          try {
            const info = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
            if (info?.targetInfo?.targetId) {
              targetIds.set(id, info.targetInfo.targetId);
              console.log(`[BrowserService] Captured targetId for ${id}: ${info.targetInfo.targetId}`);
            }
          } finally {
            // This session exists only to read the targetId — detach it so it
            // doesn't linger attached to the page for the whole context lifetime.
            // Detach failure is non-fatal (the context may already be closing).
            await session.detach().catch(() => {});
          }
        } catch (err: any) {
          // Non-fatal: getTargetId() will fall back to /json/list query.
          console.warn(`[BrowserService] Failed to capture targetId for ${id}:`, err.message);
        }

        const entry: BrowserContextEntry = {
          context,
          page,
          createdAt: new Date().toISOString(),
          lastActivity: Date.now(),
          url: "about:blank",
          title: "",
          consoleMessages: [],
          persistCookies: opts?.persistCookies,
          deviceScaleFactor,
        };
        contexts.set(id, entry);
        lastActivityAt = entry.lastActivity;  // a fresh context counts as activity
        await setupPage(entry, id);

        // Reopen where this context id last was: a context recreated after a
        // server restart or an inactivity reap comes up about:blank even
        // though the PANE persists its url — the page itself must come back
        // for browser tabs to behave like chat tabs. `commit` keeps slow
        // sites from stalling context creation; a dead site degrades to the
        // blank pane it would have been anyway. Callers that navigate right
        // after (restoreAllContexts, force-open) simply supersede this —
        // both paths are awaited in order, no race.
        const lastUrl = loadLastUrl(id);
        if (lastUrl) {
          try {
            await page.goto(lastUrl, { waitUntil: "commit", timeout: 8000 });
            entry.url = lastUrl;
            console.log(`[BrowserService] Restored last url for ${id} -> ${lastUrl}`);
          } catch (err: any) {
            console.warn(`[BrowserService] last-url restore failed for ${id}: ${err.message}`);
          }
        }

        // Auto-save storageState every 30s + on context close.
        // CRITICAL: setInterval calls saver.flush() (force-save), NOT
        // saver.trigger() (debounced). A debounced trigger at the same
        // period as the debounce delay would re-arm the timer on every
        // tick and never fire.
        // indexedDB:true — cookies + localStorage alone lose the session on
        // sites that keep their auth/token in IndexedDB (Firebase, many SPAs):
        // they'd wake up logged OUT even after cookies restored. Playwright
        // captures IndexedDB into storageState only when asked, and newContext
        // replays it automatically on load (createContext passes this state).
        const saver = debouncedSaver(id, async () => context.storageState({ indexedDB: true }), 30_000);
        // Dirty-check: only serialize+write storageState when the context has
        // seen activity since the last save. A parked/idle context (no nav, no
        // clicks) skips the 30s storageState() serialize + disk write entirely.
        // touchActivity() bumps lastActivity on every op, so this is safe; the
        // worst case (a JS-only storage write with no op) is bounded by the
        // explicit save on destroyContext.
        let lastSavedActivity = entry.lastActivity;
        const intervalHandle = setInterval(() => {
          if (entry.lastActivity === lastSavedActivity) return;
          lastSavedActivity = entry.lastActivity;
          saver.flush().catch(err => console.warn(`[BrowserService] autosave flush failed for ${id}:`, err.message));
        }, 30_000);
        // On context close: stop timers only. Do NOT call saver.flush() —
        // destroyContext explicitly saves before close (line 414-419), so a
        // flush here would race against the closed context and surface as a
        // noisy "Target page, context or browser has been closed" warning.
        // For unexpected closures (crash, external close), accept up to 30s
        // of state loss; the autosave interval is the safety net.
        context.on("close", () => {
          clearInterval(intervalHandle);
          saver.cancel();
        });
        entry.autoSaveCleanup = () => {
          clearInterval(intervalHandle);
          saver.cancel();
        };

        // Legacy cookie file load (kept for backwards compat with phase 27 test).
        if (opts?.persistCookies) {
          await service.loadCookies(id);
        }
        console.log(`[BrowserService] Context created: ${id} (total: ${contexts.size}, persisted=${persistedState ? "yes" : "no"})`);
      } catch (err) {
        // Cleanup on failure: drop the (possibly already-set) context entry +
        // targetId, close the context. A throw after contexts.set() (setupPage,
        // loadCookies, …) would otherwise leave a ghost entry pointing at a
        // closed context that getOrCreate would later hand back.
        contexts.delete(id);
        targetIds.delete(id);
        agentActionHints.delete(id);
        await context.close().catch(() => {});
        throw err;
      }
      })();
      const tracked = create.finally(() => pendingCreates.delete(id));
      pendingCreates.set(id, tracked);
      return tracked;
    },

    async flushStorageState(id) {
      const entry = contexts.get(id);
      // Nessun contesto vivo ⇒ niente da forzare: quello su disco è già l'ultimo
      // (destroyContext salva prima di chiudere). Il motore chromium non ha uno
      // stato per-contesto da tirare fuori (il profilo persistente è del
      // sidecar), come già dice destroyContext.
      if (!entry || entry.engine === "chromium") return false;
      try {
        await saveStorageState(id, await entry.context.storageState({ indexedDB: true }));
        return true;
      } catch (err: any) {
        console.warn(`[BrowserService] flushStorageState(${id}) failed:`, err?.message ?? err);
        return false;
      }
    },

    async siteDataRecords(id) {
      const read = await readSiteData(id);
      if (!read.supported) return { supported: false, records: [] };
      return { supported: true, records: recordsFromState(read.state) };
    },

    async forgetSite(id, displayNames) {
      const names = [...new Set(displayNames.map((n) => n.trim().toLowerCase()).filter(Boolean))];
      const read = await readSiteData(id);
      if (!read.supported) return { supported: false, removed: 0 };
      if (names.length === 0) return { supported: true, removed: 0 };
      // PRIMA il contesto vivo. Al contrario, il file pulito verrebbe riscritto
      // dall'autosave con l'identità ancora accesa in RAM, e trenta secondi
      // dopo il sito sarebbe di nuovo lì.
      if (read.entry) await purgeLiveSilos(read.entry, names, read.state);
      // POI il file, e per NOME: quello che sparisce dal disco è esattamente
      // quello che il dialogo ha elencato, non il risultato di un secondo
      // confronto fra host e silo fatto quaggiù.
      if (!read.state) return { supported: true, removed: 0 };
      const { state: next, removed } = forgetSilosInState(read.state, names);
      try {
        await saveStorageState(id, next);
      } catch (err: any) {
        console.warn(`[BrowserService] forgetSite(${id}) save failed:`, err?.message ?? err);
      }
      return { supported: true, removed };
    },

    async destroyContext(id) {
      const entry = contexts.get(id);
      if (!entry) return;
      // Phase 30 BROWSER-CHAT-02 — stop screencast first so no in-flight
      // CDP frames target a context that's about to be torn down.
      await service.stopScreencast(id).catch(() => {});
      // T1 DOM co-browse — detach the recorder CDP session (best-effort; closing
      // the context would detach it anyway, but don't leave it dangling).
      if (entry.recorderCdp) { await entry.recorderCdp.detach().catch(() => {}); entry.recorderCdp = undefined; }
      entry.autoSaveCleanup?.();
      if (entry.engine === "chromium") {
        // Chromium engine: the sidecar owns the persistent profile (no per-context
        // state to flush) and the default context is SHARED with the sidecar's
        // other tabs — closing it would nuke them. Close only this pane's page,
        // then disconnect the CDP client. The sidecar process itself lives on;
        // its lifetime is the engine registry's ref count, released elsewhere.
        try { await entry.page.close(); } catch {}
        try { await entry.engineBrowser?.close(); } catch {}
        contexts.delete(id);
        targetIds.delete(id);
        agentActionHints.delete(id);
        pendingViewportHints.delete(id);
        try { opts.onDestroy?.(id); } catch (err: any) {
          console.warn(`[BrowserService] onDestroy callback failed for ${id}:`, err.message);
        }
        console.log(`[BrowserService] Chromium-engine context destroyed: ${id} (remaining: ${contexts.size})`);
        return;
      }
      // Final flush before close (best effort).
      try {
        const finalState = await entry.context.storageState({ indexedDB: true });
        await saveStorageState(id, finalState);
      } catch (err: any) {
        console.warn(`[BrowserService] Final state save failed for ${id}:`, err.message);
      }
      if (entry.persistCookies) await service.saveCookies(id);
      try { await entry.context.close(); } catch {}
      contexts.delete(id);
      targetIds.delete(id);
      // Tie the agent-action hint's lifetime to the context: a context torn down
      // mid-action (or without a trailing agent_active=false broadcast) would
      // otherwise leave a stale entry that never gets deleted, growing the Map
      // unbounded over the process lifetime as contexts churn.
      agentActionHints.delete(id);
      // Same bound for the viewport hint — a reopened pane re-sends resize on
      // ws.onopen (within the screencast grace), so the recreate gets a fresh one.
      pendingViewportHints.delete(id);
      // Flush per-context caches (e.g. the browser_observe element cache).
      // Without this, the cleanup-timer auto-close + a later getOrCreate(id)
      // recreate a blank context under the same id while a stale IndexedElement[]
      // survives, so browser_act could click an old bbox on the fresh page.
      try { opts.onDestroy?.(id); } catch (err: any) {
        console.warn(`[BrowserService] onDestroy callback failed for ${id}:`, err.message);
      }
      console.log(`[BrowserService] Context destroyed: ${id} (remaining: ${contexts.size})`);
    },

    setEngineHint(id, engine, cdpEndpoint) {
      if (engine === "default") {
        pendingEngineHints.delete(id);
      } else {
        pendingEngineHints.set(id, { engine, cdpEndpoint });
      }
    },

    async getOrCreate(id) {
      let entry = contexts.get(id);
      // Discard a dead entry (its page/context closed — Chromium crash, or the
      // page was closed out from under us) so we recreate on the live browser
      // rather than returning a corpse. Also stops touchActivity() below from
      // perpetually refreshing a dead context and starving the idle reaper.
      if (entry && entry.page.isClosed()) {
        try { entry.autoSaveCleanup?.(); } catch { /* ignore */ }
        contexts.delete(id);
        targetIds.delete(id);
        agentActionHints.delete(id);
        entry = undefined;
      }
      if (!entry) {
        await service.createContext(id);
        entry = contexts.get(id)!;
      }
      touchActivity(entry);
      return entry;
    },

    async navigate(id, url) {
      // Scheme guard (LFI/SSRF defense-in-depth): a browser pane must never be
      // driven to file:// / chrome:// from ANY caller. Only the agent-tool path
      // was guarded (assertAgentNavAllowed); the direct REST `/navigate`, the
      // `/screenshot?url=` route, and the co-browse WS `{type:'nav'}` all reach
      // here with untrusted input. Choke-point here covers them all. http/https/
      // about/data only; escape hatch BROWSER_ALLOW_ALL_SCHEMES=1 (mirrors the
      // agent guard's override). about:/data: stay allowed (blank pane, data URLs).
      // Un file locale non passa di qui come `file://` — diventa l'URL http che
      // lo serve (browser-local-file-url.ts), come sul percorso agente. Senza
      // questo ramo la stessa richiesta aveva due esiti a seconda della porta da
      // cui entrava: aperta dal tool, rifiutata dalla REST e dal co-browse.
      // Assoluto: qui si naviga DAL server, che di origine ha solo la propria.
      const local = toServableUrl(url);
      if (local.kind === "refused") throw new Error(`navigate: ${local.reason}`);
      if (local.kind === "rewritten") url = local.url;
      if (process.env.BROWSER_ALLOW_ALL_SCHEMES !== "1") {
        let scheme = "";
        try { scheme = new URL(url).protocol.toLowerCase(); }
        catch { throw new Error(`navigate: invalid URL "${url}"`); }
        if (!new Set(["http:", "https:", "about:", "data:"]).has(scheme)) {
          throw new Error(`navigate: scheme "${scheme}" not allowed (http, https, about, data)`);
        }
      }
      const entry = await service.getOrCreate(id);
      let navError: string | undefined;
      try {
        await entry.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err: any) {
        // Don't swallow: the page is still on the previous URL, so returning
        // the plain shape reads as success and the pane shows nothing.
        navError = err?.message ? String(err.message).split('\n')[0] : 'Navigation failed';
        console.warn(`[BrowserService] Navigate warning for ${id}:`, err.message);
      }
      entry.url = entry.page.url();
      try { entry.title = await entry.page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
      // Persist topic.browserState via callback (best effort).
      if (opts.onNavigate) {
        try {
          const vp = entry.page.viewportSize() || defaultViewport;
          opts.onNavigate(id, entry.url, vp);
        } catch (err: any) {
          console.warn(`[BrowserService] onNavigate callback failed for ${id}:`, err.message);
        }
      }
      return navError
        ? { url: entry.url, title: entry.title, error: navError }
        : { url: entry.url, title: entry.title };
    },

    async goBack(id) {
      const entry = await service.getOrCreate(id);
      await entry.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      entry.url = entry.page.url();
      try { entry.title = await entry.page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
      return { url: entry.url, title: entry.title };
    },

    async goForward(id) {
      const entry = await service.getOrCreate(id);
      await entry.page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      entry.url = entry.page.url();
      try { entry.title = await entry.page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
      return { url: entry.url, title: entry.title };
    },

    async reload(id) {
      const entry = await service.getOrCreate(id);
      await entry.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      touchActivity(entry);
    },

    async click(id, x, y, opts) {
      const entry = await service.getOrCreate(id);
      await entry.page.mouse.click(x, y, { button: opts?.button || "left" });
      touchActivity(entry);
    },

    async type(id, text) {
      const entry = await service.getOrCreate(id);
      await entry.page.keyboard.type(text);
      touchActivity(entry);
    },

    async keypress(id, key) {
      const entry = await service.getOrCreate(id);
      await entry.page.keyboard.press(key);
      touchActivity(entry);
    },

    async scroll(id, x, y, deltaX, deltaY) {
      const entry = await service.getOrCreate(id);
      await entry.page.mouse.move(x, y);
      await entry.page.mouse.wheel(deltaX, deltaY);
      touchActivity(entry);
    },

    async hover(id, x, y) {
      const entry = await service.getOrCreate(id);
      await entry.page.mouse.move(x, y);
      touchActivity(entry);
    },

    async screenshot(id, opts) {
      const entry = await service.getOrCreate(id);
      touchActivity(entry);
      return await entry.page.screenshot({
        type: opts?.format || "jpeg",
        quality: opts?.format === "png" ? undefined : (opts?.quality || screenshotQuality),
        fullPage: opts?.fullPage || false,
      });
    },

    async accessibilitySnapshot(id) {
      const entry = await service.getOrCreate(id);
      touchActivity(entry);
      try {
        const ariaSnapshot = await entry.page.locator("body").ariaSnapshot();
        return { url: entry.url, title: entry.title, ariaSnapshot };
      } catch {
        // Fallback: extract text content
        const text = await entry.page.locator("body").innerText().catch(() => "");
        return { url: entry.url, title: entry.title, ariaSnapshot: text };
      }
    },

    async clickSelector(id, selector, opts) {
      const entry = await service.getOrCreate(id);
      await entry.page.click(selector, { button: opts?.button || "left", timeout: 10_000 });
      touchActivity(entry);
    },

    async fillSelector(id, selector, value) {
      const entry = await service.getOrCreate(id);
      await entry.page.fill(selector, value, { timeout: 10_000 });
      touchActivity(entry);
    },

    async saveCookies(id) {
      const entry = contexts.get(id);
      if (!entry) return;
      try {
        const cookies = await entry.context.cookies();
        const filePath = join(cookieDir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
        writeFileSync(filePath, JSON.stringify(cookies, null, 2));
        console.log(`[BrowserService] Cookies saved for context: ${id} (${cookies.length} cookies)`);
      } catch (err: any) {
        console.warn(`[BrowserService] Failed to save cookies for ${id}:`, err.message);
      }
    },

    async loadCookies(id) {
      const entry = contexts.get(id);
      if (!entry) return;
      try {
        const filePath = join(cookieDir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
        if (!existsSync(filePath)) return;
        const cookies = JSON.parse(readFileSync(filePath, "utf-8"));
        await entry.context.addCookies(cookies);
        console.log(`[BrowserService] Cookies loaded for context: ${id} (${cookies.length} cookies)`);
      } catch (err: any) {
        console.warn(`[BrowserService] Failed to load cookies for ${id}:`, err.message);
      }
    },

    async evaluate(id, script) {
      const entry = await service.getOrCreate(id);
      touchActivity(entry);
      return await entry.page.evaluate(script);
    },

    getConsoleMessages(id) {
      const entry = contexts.get(id);
      return entry?.consoleMessages || [];
    },

    getNetworkEntries(id) {
      const entry = contexts.get(id);
      return entry?.network ? [...entry.network] : [];
    },

    getLastDialog(id) {
      return contexts.get(id)?.lastDialog ?? null;
    },

    getUrl(id) {
      const entry = contexts.get(id);
      if (!entry) return null;
      return { url: entry.url, title: entry.title };
    },

    listContexts() {
      return Array.from(contexts.entries()).map(([id, e]) => ({
        id,
        url: e.url,
        title: e.title,
        createdAt: e.createdAt,
        lastActivity: e.lastActivity,
      }));
    },

    async resize(id, width, height, deviceScaleFactor) {
      // Record desired size + DPR BEFORE getOrCreate: on FIRST open the context
      // doesn't exist yet, and createContext() consults this hint so the context
      // is born at the pane's real size AND deviceScaleFactor (immutable after).
      const dsf = clampDsf(deviceScaleFactor ?? pendingViewportHints.get(id)?.deviceScaleFactor);
      pendingViewportHints.set(id, { width, height, deviceScaleFactor: dsf });
      const entry = await service.getOrCreate(id);
      await entry.page.setViewportSize({ width, height });
      touchActivity(entry);
      // The ACTUAL frame resolution follows the context's CREATION-time DPR: a
      // later DPR change can't mutate a live Playwright context (first-DPR-wins),
      // so the clamp uses entry.deviceScaleFactor, not the incoming value.
      const effectiveDsf = clampDsf(entry.deviceScaleFactor);
      // Live screencast: Page.startScreencast locks maxWidth/maxHeight at start
      // time, so after an enlarge the stream stayed capped at the OLD dims —
      // blurry upscaled frames until the WS reconnected. Restart the cast on the
      // SAME CDP session (the Page.screencastFrame listener and the subscriber
      // fan-out stay attached) with dims re-derived from the new viewport × DPR.
      // Explicit caller-set maxWidth/maxHeight (a deliberate clamp) is preserved.
      const session = screencastSessions.get(id);
      if (session) {
        try {
          await session.cdpSession.send("Page.stopScreencast");
          await session.cdpSession.send("Page.startScreencast", {
            format: session.opts?.format ?? "jpeg",
            // At >1× the frame carries ~4× the pixels — trim quality to hold the band.
            quality: session.opts?.quality ?? (effectiveDsf > 1 ? 60 : 70),
            maxWidth: session.opts?.maxWidth ?? Math.round(width * effectiveDsf),
            maxHeight: session.opts?.maxHeight ?? Math.round(height * effectiveDsf),
            everyNthFrame: session.opts?.everyNthFrame ?? 2,
          });
        } catch (err: any) {
          // Page/browser closing mid-resize — non-fatal, the old stream (or its
          // teardown path) still owns cleanup.
          console.warn(`[BrowserService] screencast restart on resize failed for ${id}:`, err.message);
        }
      }
    },

    isLaunched() {
      return browser !== null && browser.isConnected();
    },

    async getTargetId(id) {
      // Primary: explicit Map (set during createContext via CDP Target.getTargetInfo).
      const cached = targetIds.get(id);
      if (cached) return cached;

      // Fallback: query CDP /json/list — used for restored contexts that
      // pre-date the Map (e.g. resurrected from disk with no targetId capture).
      const entry = contexts.get(id);
      if (!entry) return null;
      try {
        // Bounded: a wedged CDP endpoint must not hang the tool dispatch forever.
        const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(3000) });
        const targets = await resp.json() as any[];
        const pageUrl = entry.page.url();
        if (pageUrl !== "about:blank") {
          const byUrl = targets.find((t: any) => t.url === pageUrl && t.type === "page");
          if (byUrl?.id) {
            targetIds.set(id, byUrl.id);  // backfill cache
            return byUrl.id;
          }
        }
        const pageTitle = await entry.page.title().catch(() => "");
        if (pageTitle) {
          const byTitle = targets.find((t: any) => t.title === pageTitle && t.type === "page");
          if (byTitle?.id) {
            targetIds.set(id, byTitle.id);
            return byTitle.id;
          }
        }
        return null;
      } catch (err) {
        console.warn(`[BrowserService] Failed to get targetId for ${id}:`, err);
        return null;
      }
    },

    async restoreAllContexts(topics) {
      // Source of truth = the DISK store, NOT topic.browserState. browserState
      // is never persisted to SQLite, so after a restart every topic loads with
      // browserState=undefined and the old loop skipped 100% of them ("0
      // restored" over 962 boots). The per-context storage.json + last-url.json
      // (browser-state-store.ts) DO survive, keyed by the same contextId the
      // pane uses, so we drive the restore off them.
      //
      // Bounded on purpose: eagerly re-launching a Chromium context for every
      // topic that ever opened a page would be a boot storm (hundreds of
      // headless contexts + RAM). We warm only the RECENTLY-active ones, newest
      // first, capped. Everything else still restores LAZILY on first use —
      // createContext loads storageState + last-url exactly the same way — so no
      // login or URL is lost, it's just paid for on demand instead of at boot.
      const RESTORE_MAX = 8;
      const RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const now = Date.now();

      const candidates: { topic: (typeof topics)[number]; contextId: string; updatedAt: number; viewport?: { width: number; height: number } }[] = [];
      for (const topic of topics) {
        const contextId = topic.browserState?.contextId ?? topic.id;
        const entry = readLastUrlEntry(contextId);
        if (!entry) continue; // nothing persisted for this context — skip
        if (entry.updatedAt && now - entry.updatedAt > RESTORE_MAX_AGE_MS) continue; // stale
        candidates.push({ topic, contextId, updatedAt: entry.updatedAt, viewport: topic.browserState?.viewport });
      }
      candidates.sort((a, b) => b.updatedAt - a.updatedAt); // newest first
      const toWarm = candidates.slice(0, RESTORE_MAX);
      const skipped = candidates.length - toWarm.length;

      let restored = 0;
      let failed = 0;
      for (const { topic, contextId, viewport } of toWarm) {
        try {
          // createContext loads storageState AND re-navigates to the persisted
          // last-url internally (see the getOrCreate path) — DO NOT add a
          // separate loadStorageState()/navigate() here, it would double-load.
          await service.createContext(contextId, viewport ? { viewport } : {});
          restored++;
          console.log(`[BrowserService] Restored context ${contextId} for topic ${topic.id}`);
        } catch (err: any) {
          failed++;
          console.warn(`[BrowserService] Failed to restore context for topic ${topic.id}:`, err.message);
        }
      }
      console.log(`[BrowserService] restoreAllContexts: ${restored} restored, ${failed} failed, ${skipped} deferred to lazy (cap ${RESTORE_MAX})`);
      return { restored, failed };
    },

    // Phase 30 BROWSER-CHAT-02 — push-driven CDP screencast.
    // Pattern (Browser Use 2025 + Playwright 1.59 release notes):
    //   1. Open a dedicated CDP session per context (not the targetId-capture
    //      session — that one is GC'd in createContext after Target.getTargetInfo).
    //   2. Subscribe to Page.screencastFrame, ACK each frame BEFORE invoking
    //      onFrame so the next frame keeps flowing (CDP holds the next frame
    //      until ACK — built-in flow control).
    //   3. Call Page.startScreencast with format/quality tuned for the
    //      BROWSER-CHAT-02 budget (jpeg q70, everyNthFrame=2 -> 15 FPS floor).
    //
    // CDP doc: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast
    async startScreencast(id, onFrame, opts) {
      // Fan-out: if already streaming, ADD this viewer to the subscriber set
      // (reuses the existing CDP session, no restart). The old code SWAPPED the
      // single onFrame, so a 2nd viewer stole frames from the 1st.
      const existing = screencastSessions.get(id);
      if (existing) {
        existing.subscribers.add(onFrame);
        return;
      }

      const entry = await service.getOrCreate(id);
      const cdpSession = await entry.context.newCDPSession(entry.page);

      cdpSession.on("Page.screencastFrame", async (payload: { data: string; sessionId: number; metadata: { timestamp?: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number } }) => {
        // ACK first to keep frames flowing.
        try {
          await cdpSession.send("Page.screencastFrameAck", { sessionId: payload.sessionId });
        } catch (err: any) {
          // ACK can fail if the session/page closed mid-frame — non-fatal.
          console.warn(`[BrowserService] screencastFrameAck failed for ${id}:`, err.message);
          return;
        }
        const session = screencastSessions.get(id);
        if (!session) return;  // stopScreencast was called between ACK and frame
        const meta = {
          timestamp: payload.metadata?.timestamp ?? Date.now(),
          pageScaleFactor: payload.metadata?.pageScaleFactor,
          deviceWidth: payload.metadata?.deviceWidth,
          deviceHeight: payload.metadata?.deviceHeight,
        };
        // Fan the frame out to every viewer; one throwing must not starve the rest.
        for (const cb of session.subscribers) {
          try {
            cb(payload.data, meta);
          } catch (err: any) {
            console.warn(`[BrowserService] onFrame handler threw for ${id}:`, err.message);
          }
        }
      });

      // Defaults match BROWSER-CHAT-02 budget:
      //   - format jpeg + quality 70 → ~500kbps - 1.5Mbps (target band)
      //   - everyNthFrame 2 → effective 30 → 15 FPS (Nyquist floor)
      //   - maxWidth/maxHeight clamp to viewport (no upscale)
      const viewport = entry.page.viewportSize() || { width: 1280, height: 720 };
      // HiDPI: the page is rendered at deviceScaleFactor backing-store size;
      // clamping to viewport.width (CSS) would downscale that retina detail away.
      // Clamp to width×dsf so the first frames are already sharp (resize() keeps
      // them so on later size changes). deviceWidth in frame metadata stays CSS
      // px (DIP), so click mapping is unaffected.
      const dsf = clampDsf(entry.deviceScaleFactor);
      try {
        await cdpSession.send("Page.startScreencast", {
          format: opts?.format ?? "jpeg",
          quality: opts?.quality ?? (dsf > 1 ? 60 : 70),
          maxWidth: opts?.maxWidth ?? Math.round(viewport.width * dsf),
          maxHeight: opts?.maxHeight ?? Math.round(viewport.height * dsf),
          everyNthFrame: opts?.everyNthFrame ?? 2,
        });
      } catch (err) {
        // startScreencast failed (page closed / browser disconnected in the
        // window between newCDPSession and this send) — detach the orphaned
        // session so it doesn't leak, then surface the error to the caller.
        await cdpSession.detach().catch(() => {});
        throw err;
      }

      // Lost a concurrent first-start race? Another startScreencast for this id
      // may have registered while we awaited getOrCreate/startScreencast — the
      // `existing` fan-out check at the top is a TOCTOU gap before this set.
      // Join the winner's subscriber set and tear down our duplicate session
      // instead of leaking an untracked, never-detached CDP session.
      const winner = screencastSessions.get(id);
      if (winner) {
        winner.subscribers.add(onFrame);
        try { await cdpSession.send("Page.stopScreencast"); } catch { /* best effort */ }
        await cdpSession.detach().catch(() => {});
        return;
      }

      screencastSessions.set(id, { cdpSession, subscribers: new Set([onFrame]), opts });
      console.log(`[BrowserService] Screencast started for ${id} (q=${opts?.quality ?? 70}, everyNthFrame=${opts?.everyNthFrame ?? 2})`);
    },

    async stopScreencast(id, onFrame) {
      const session = screencastSessions.get(id);
      if (!session) return;  // Idempotent
      if (onFrame) {
        // Remove just this viewer; keep the shared session alive for the others.
        session.subscribers.delete(onFrame);
        if (session.subscribers.size > 0) return;
      }
      // No viewers left (or a full teardown was requested): stop + detach.
      try {
        await session.cdpSession.send("Page.stopScreencast");
      } catch (err: any) {
        console.warn(`[BrowserService] Page.stopScreencast failed for ${id}:`, err.message);
      }
      try {
        await session.cdpSession.detach();
      } catch (err: any) {
        // CDP detach can fail if context already closed — non-fatal.
        console.warn(`[BrowserService] CDP detach failed for ${id}:`, err.message);
      }
      screencastSessions.delete(id);
      console.log(`[BrowserService] Screencast stopped for ${id}`);
    },

    async dispatchInput(id, action, payload) {
      const entry = await service.getOrCreate(id);
      // Coordinates are sent as native-CSS px from the client (the client-side
      // mapper handles devicePixelRatio via screencast metadata). The server
      // trusts the input as native-CSS px and forwards directly to Playwright.
      switch (action) {
        case 'click':
          if (payload.x == null || payload.y == null) {
            throw new Error("dispatchInput click: x and y required");
          }
          await entry.page.mouse.click(payload.x, payload.y, { button: payload.button ?? 'left' });
          break;
        case 'type':
          if (!payload.text) throw new Error("dispatchInput type: text required");
          await entry.page.keyboard.type(payload.text);
          break;
        case 'scroll':
          // mouse.move + mouse.wheel mirrors existing service.scroll() semantics.
          await entry.page.mouse.move(payload.x ?? 0, payload.y ?? 0);
          await entry.page.mouse.wheel(payload.deltaX ?? 0, payload.deltaY ?? 0);
          break;
        case 'mousemove':
          if (payload.x == null || payload.y == null) {
            throw new Error("dispatchInput mousemove: x and y required");
          }
          await entry.page.mouse.move(payload.x, payload.y);
          break;
        case 'keypress':
          if (!payload.key) throw new Error("dispatchInput keypress: key required");
          await entry.page.keyboard.press(payload.key);
          break;
        default:
          throw new Error(`dispatchInput: unknown action '${action}'`);
      }
      // getOrCreate already touched activity; the action is a real interaction
      // so the entry's lastActivity stays fresh.
    },

    async describeFocusedField(id) {
      const entry = contexts.get(id);
      // Nessun contesto: la domanda non ha oggetto. Di proposito NON si crea
      // (a differenza di dispatchInput): questa è una lettura accessoria, e far
      // nascere un Chromium per sapere che tastiera aprire sarebbe assurdo.
      if (!entry) return null;
      // La pagina può stare navigando proprio adesso (il click che ha preceduto
      // questa lettura è il candidato numero uno), e allora `evaluate` aspetta
      // il documento nuovo. Ma la risposta serve MENTRE la tastiera sale: se
      // tarda, tanto vale non averla. Quindi la corsa contro un timer corto.
      const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), FOCUSED_FIELD_TIMEOUT_MS));
      const read = (async (): Promise<RemoteField | null> => {
        // Il fuoco può stare dentro un iframe, anche di un'altra origine, dove
        // `document.activeElement` del frame principale mostra solo l'<iframe>.
        // Playwright però parla con ogni frame, e `document.hasFocus()` dice
        // quale dei documenti tiene davvero il fuoco: si chiede a tutti e si
        // prende la prima risposta piena.
        for (const frame of entry.page.frames().slice(0, MAX_FOCUS_FRAMES)) {
          const field = await frame.evaluate(FOCUSED_FIELD_FN).catch(() => null);
          if (field) return field as RemoteField;
        }
        return null;
      })();
      return await Promise.race([read, deadline]).catch(() => null);
    },

    // T1 DOM co-browse — enable DOM render mode for a context. Binds rrweb (once),
    // (re)starts recording on the current page, and returns the bootstrap burst
    // [meta, full, ...incrementals] for the requesting viewer. Resets the buffer
    // first so the wait blocks on the FRESH FullSnapshot (recording emits it a tick
    // after the script tag runs, via the exposed binding's async round-trip), never
    // a stale one from a prior enable.
    async enableDomMode(id) {
      const entry = await service.getOrCreate(id);
      const ok = await ensureDomBinding(entry, id);
      if (!ok) return null;
      entry.domEmit = true;
      entry.dom = { meta: null, full: null, inc: [] };
      try {
        await startRecordingNow(entry);
      } catch (err) {
        console.warn(`[BrowserService] rrweb start failed for ${id}:`, (err as Error)?.message);
        return null;
      }
      // Wait up to ~2s for the FullSnapshot (type 2) to land in the buffer.
      for (let i = 0; i < 40 && !entry.dom?.full; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Nav-aware second chance: the pane sends set_render:'dom' and its first
      // nav back-to-back, so the injection can land on a document the in-flight
      // goto is about to swap — the snapshot dies with it and a hard fail here
      // would force the viewer to video with no retry (the 'load' re-arm keeps
      // recording, but the viewer already left DOM mode). If the page is still
      // loading, ride the navigation out and re-inject; if it settled and the
      // snapshot is still missing, re-inject once anyway (our instrumented doc
      // may have been swapped right after injection).
      if (!entry.dom?.full) {
        try {
          await entry.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
          await startRecordingNow(entry);
          for (let i = 0; i < 40 && !entry.dom?.full; i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
        } catch { /* fall through to the unsupported path */ }
      }
      // No FullSnapshot even after the nav settled → treat DOM mode as
      // UNSUPPORTED for this page and return null, so the caller forces 'video'
      // cleanly. A partial bootstrap (Meta only) is worse than useless: rrweb's
      // Replayer can't build a mirror without a FullSnapshot, so the DOM overlay
      // would stay transparent and the paused video would bleed through it — the
      // exact "DOM mode still shows video" symptom.
      if (!entry.dom?.full) {
        console.warn(`[BrowserService] rrweb produced no FullSnapshot for ${id} — DOM mode unsupported here`);
        return null;
      }
      return [entry.dom.meta, entry.dom.full, ...entry.dom.inc].filter((e) => e != null);
    },

    // Gate emission. Turning it OFF also DETACHES the recorder (RRWEB_STOP stops the
    // MutationObservers) so an unwatched page carries zero DOM instrumentation — the
    // 'load' re-arm is a no-op while domEmit is false, so future navigations stay clean.
    setDomEmit(id, on) {
      const entry = contexts.get(id);
      if (!entry) return;
      entry.domEmit = on;
      if (!on && entry.domInjected) {
        entry.page.evaluate(RRWEB_STOP).catch(() => { /* page gone / navigating */ });
      }
    },

    // Phase 30 BROWSER-CHAT-03 — agent_active broadcast over /ws/browser/:contextId.
    // Server.ts wires opts.broadcastToBrowserWs (no-op when absent).
    broadcastAgentActive(contextId, active) {
      // Read-then-retain the action hint on entry; clear it on exit so a later
      // call without a fresh setAgentAction can't leak a stale label.
      const action = active ? agentActionHints.get(contextId) : undefined;
      if (!active) agentActionHints.delete(contextId);
      if (!opts.broadcastToBrowserWs) return;
      try {
        opts.broadcastToBrowserWs(contextId, { type: 'agent_active', active, ...(action ? { action } : {}) });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[BrowserService] broadcastAgentActive failed for ${contextId}:`, msg);
      }
    },
    setAgentAction(contextId, action) {
      if (action) agentActionHints.set(contextId, action);
      else agentActionHints.delete(contextId);
    },

    // Phase 30 BROWSER-CHAT-03 — DOM walker indexing interactive elements.
    // Pattern: Browser Use bounding-box index (https://browser-use.com).
    // Selector list mirrors the agent-tool-readable surface of the page:
    // buttons, links, inputs, role-based interactive nodes, [onclick], [tabindex].
    // Side effect: writes data-topics-idx="N" on each element (cleaned by
    // captureAnnotatedScreenshot's finally block).
    async extractIndexedElements(contextId, observeOpts) {
      const entry = await service.getOrCreate(contextId);
      // Shared page-portable walker (browser-dom-walker.ts) — identical logic
      // is reused by the Electron CDP path so observe targets the same DOM.
      const elements = await extractIndexedElementsOnPage(entry.page, observeOpts?.maxElements);
      touchActivity(entry);
      return elements;
    },

    // Phase 30 BROWSER-CHAT-03 — annotated screenshot via overlay injection.
    // Pattern: Browser Use server-side overlay (one container div with one
    // absolute-positioned colored box per indexed element + numeric label
    // badge). Color rotation green/yellow/red cycled by `(id-1) % 3`.
    // Cleanup is in finally — overlay container removed, data-topics-idx
    // attributes stripped. Cleanup errors are swallowed (best effort).
    async captureAnnotatedScreenshot(contextId, elements, screenshotOpts) {
      const entry = await service.getOrCreate(contextId);
      // Shared page-portable annotated-screenshot helper (browser-dom-walker.ts).
      const b64 = await captureAnnotatedScreenshotOnPage(entry.page, elements, screenshotOpts?.quality ?? 70);
      touchActivity(entry);
      return b64;
    },

    // Phase 30 BROWSER-CHAT-04 — DOM info at a point for select-element mode.
    // Returns null when the context is missing or no element resolves at the
    // given coords. Pure read; no DOM mutation. The page evaluate walks the
    // ancestor chain to build an XPath-like path and constructs a short CSS
    // selector (tag + #id + up to 3 classes).
    async resolveElementAtPoint(contextId, point) {
      const entry = contexts.get(contextId);
      if (!entry) return null;
      const page = entry.page;
      try {
        const result = await page.evaluate((p: { x: number; y: number }) => {
          const target = document.elementFromPoint(p.x, p.y);
          if (!target) return null;

          // Build an XPath-like path of [tag][index] segments up to <html>.
          const segments: string[] = [];
          let cur: Element | null = target;
          while (cur && cur !== document.documentElement) {
            const parent: Element | null = cur.parentElement;
            const siblings = parent
              ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
              : [];
            const idx = parent ? siblings.indexOf(cur) + 1 : 1;
            segments.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
            cur = parent;
          }
          const path = '/html/' + segments.join('/');

          const tag = target.tagName.toLowerCase();
          const idAttr = target.id ? `#${target.id}` : '';
          let classes = '';
          const classAttr = target.getAttribute('class');
          if (classAttr) {
            const parts = classAttr.split(/\s+/).filter(Boolean).slice(0, 3);
            if (parts.length > 0) classes = '.' + parts.join('.');
          }
          const cssPath = `${tag}${idAttr}${classes}`;

          const r = target.getBoundingClientRect();
          const txt = (target.textContent || '').trim();
          const text = txt.length > 0 ? txt.slice(0, 80) : undefined;

          return {
            path,
            cssPath,
            bbox: {
              x: Math.round(r.left),
              y: Math.round(r.top),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            text,
          };
        }, point);
        touchActivity(entry);
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[BrowserService] resolveElementAtPoint failed for ${contextId}:`, msg);
        return null;
      }
    },

    // 4.2 — click-to-edit pieno. La sonda (`DESCRIBE_ELEMENT_FN`, condivisa con
    // la pane nativa) fa UNA sola evaluate; il ritaglio è UNO solo screenshot
    // con `clip`. Due round-trip in tutto: questo endpoint lo chiama il CLICK,
    // non l'hover — l'hover continua a passare da `resolveElementAtPoint`.
    async describeElementAtPoint(contextId, point, opts) {
      const entry = contexts.get(contextId);
      if (!entry) return null;
      const page = entry.page;
      let described: ElementDescription | null;
      try {
        described = await page.evaluate(DESCRIBE_ELEMENT_FN, { x: point.x, y: point.y });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[BrowserService] describeElementAtPoint failed for ${contextId}:`, msg);
        return null;
      }
      touchActivity(entry);
      if (!described) return null;
      if (opts?.screenshot === false) return described;

      // Il ritaglio con un filo di margine: un bottone tagliato al pixel non
      // dice dove sta, e il contorno è metà dell'informazione visiva.
      // `clip` di Playwright, con fullPage false, è in CSS px RELATIVI AL
      // VIEWPORT — le stesse coordinate di getBoundingClientRect, quindi la
      // bbox ci va dentro così com'è.
      const PAD = 8;
      const vw = described.viewport.w || 1280;
      const vh = described.viewport.h || 720;
      const cx = Math.max(0, Math.floor(described.bbox.x - PAD));
      const cy = Math.max(0, Math.floor(described.bbox.y - PAD));
      const cw = Math.min(vw - cx, Math.ceil(described.bbox.w + PAD * 2));
      const ch = Math.min(vh - cy, Math.ceil(described.bbox.h + PAD * 2));
      if (cw < 2 || ch < 2) return described; // elemento a superficie nulla: niente da ritagliare

      try {
        // PNG per i ritagli piccoli (testo di UI: il JPEG lo impasta), JPEG per
        // le selezioni grosse, dove il peso conta più del bordo netto.
        const lossless = cw * ch <= 640 * 640;
        const buf = await page.screenshot({
          type: lossless ? "png" : "jpeg",
          ...(lossless ? {} : { quality: 80 }),
          clip: { x: cx, y: cy, width: cw, height: ch },
        });
        return {
          ...described,
          screenshot: {
            dataUrl: `data:image/${lossless ? "png" : "jpeg"};base64,${buf.toString("base64")}`,
            w: cw,
            h: ch,
          },
        };
      } catch (err: unknown) {
        // Uno screenshot fallito (navigazione a metà, pagina che si chiude) non
        // deve buttare via la descrizione: si consegna senza immagine.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[BrowserService] ritaglio non riuscito per ${contextId}:`, msg);
        return described;
      }
    },
  };

  // Start the reaper now — the server uses lazy launch and never calls
  // launch(), so this is the only thing that arms context + Chromium cleanup.
  startCleanup();

  // La spazzata dei Chromium che una MORTE SPORCA del server precedente ha
  // lasciato in giro. gracefulShutdown copre l'uscita pulita; questo copre
  // SIGKILL, i crash e i riavvii che non arrivano al gestore, dove il browser
  // sopravvive reparentato a launchd e nessuno lo riconosce più come nostro.
  // Gira PRIMA di qualunque lancio, ed è il presupposto della regola: un
  // browser marchiato col nostro pid, adesso, può solo essere un residuo di un
  // server morto di cui il sistema ha riciclato il numero.
  if (opts.sweepOrphansAtBoot) reapOrphanBrowsersAtBoot();

  return service;
}
