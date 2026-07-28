// Per-session "activity energy" + a shared animation ticker for the working
// aura (see components/AuraWave.tsx).
//
// Producers — chat streaming (useChat.appendToLastMessage) and PTY output
// (SingleTerminalPane) — call bumpAura(id) on each unit of work. The aura's
// render loop reads readAuraEnergy(id) every frame to drive how fast the wave
// travels: a fast stream keeps energy high (wave speeds up), a lull lets it
// decay (wave slows). Energy falls with a ~0.7s half-life, so the response is
// smooth and self-limiting without any explicit "stop" signal.
//
// A SINGLE shared requestAnimationFrame drives every mounted aura, matching the
// app's one-rAF perf ethos, and PARKS itself whenever nobody can see the wave —
// see the ticker's own comment below for why an idle rAF is anything but free.
// Nothing here touches React state — producers are on hot paths.

const HALF_LIFE = 0.7; // seconds

interface Cell {
  e: number; // current energy (undecayed at time t)
  t: number; // performance.now() timestamp of last update
}

const cells = new Map<string, Cell>();

function decay(c: Cell, now: number): number {
  const dt = (now - c.t) / 1000;
  if (dt > 0) {
    c.e *= Math.pow(0.5, dt / HALF_LIFE);
    c.t = now;
  }
  return c.e;
}

/** Add a unit of activity for `id`. Energy is capped so a burst (e.g. a PTY
 *  scrollback dump) can't pin the wave at max for longer than the half-life. */
export function bumpAura(id: string | undefined, weight = 0.28): void {
  if (!id) return;
  const now = performance.now();
  const c = cells.get(id);
  if (c) {
    decay(c, now);
    c.e = Math.min(1.5, c.e + weight);
  } else {
    cells.set(id, { e: Math.min(1.5, weight), t: now });
  }
}

/** Current decayed energy for `id`, clamped to 0..1. Prunes cold entries. */
export function readAuraEnergy(id: string | undefined): number {
  if (!id) return 0;
  const c = cells.get(id);
  if (!c) return 0;
  const e = decay(c, performance.now());
  if (e < 0.002) {
    cells.delete(id);
    return 0;
  }
  return e > 1 ? 1 : e;
}

// ── shared rAF ticker ───────────────────────────────────────────────────────

/**
 * Perché questo ticker si PARCHEGGIA e non si limita a saltare il disegno.
 *
 * Un rAF in coda non costa "quasi niente": costa un RENDERING UPDATE completo di
 * WebKit, ogni frame. E un rendering update non è solo il nostro callback — è
 * anche `OpacityCaretAnimator::updateAnimationProperties()`, che per ridisegnare
 * il cursore di testo chiama `recomputeCaretRect()` → `canonicalPosition()` →
 * `Document::updateLayout()`: un LAYOUT SINCRONO dell'intero documento. Con
 * l'albero di pane (flex annidati 10+ livelli) quel layout costa millisecondi, e
 * lo paghiamo DUE volte per frame (quello forzato dal caret e quello del
 * rendering update stesso).
 *
 * Misurato con `sample` sul WebContent in produzione, app VISIBILE ma non in
 * primo piano, agenti al lavoro: main thread 3426 campioni, di cui 2832 in
 * `RemoteLayerTreeDrawingArea::updateRendering()` — 1055 sotto l'animatore del
 * caret e 1432 nel layout finale. Il nostro disegno su canvas: 23. Il 71% della
 * CPU del renderer era conseguenza del rAF in coda, non del lavoro dell'aura.
 *
 * Quindi: quando nessuno può vedere l'onda, il loop non si schedula affatto.
 * Tre livelli, dal più al meno stringente:
 *  · documento nascosto (minimizzato/occluso) → parcheggio, sveglia su
 *    `visibilitychange`;
 *  · nessuna aura che INTERSECHI il viewport (tutte dentro un guscio
 *    `display:none` o fuori schermo) → parcheggio, sveglia via
 *    `wakeAuraTicker()` dall'IntersectionObserver di AuraWave;
 *  · finestra visibile ma non a fuoco → NON congelo (le pane native rubano il
 *    fuoco: congelare un'onda che l'utente sta guardando sarebbe un bug
 *    visibile), ma scendo a ~12Hz. L'onda resta viva, i rendering update
 *    calano di 5×.
 */

/** Ritorna true se questo tick ha davvero disegnato (aura visibile). */
type Tick = (now: number) => boolean;
const subscribers = new Set<Tick>();
let rafId = 0;
let timerId: ReturnType<typeof setTimeout> | null = null;

/** Cadenza quando la finestra è visibile ma non a fuoco. */
const UNFOCUSED_INTERVAL_MS = 80;
/**
 * Cadenza quando la finestra È a fuoco: ~30fps, non il refresh del display.
 *
 * Prima qui c'era `requestAnimationFrame` nudo, cioè un frame OGNI frame — su un
 * pannello a 100Hz, cento disegni al secondo per un'onda di fumo sfocata. Misurato
 * nell'app vera (sonda in lib/devLayoutProbe.ts, 2026-07-28) questo ticker era il
 * primo consumatore di rAF rimasto: 549 chiamate in 15s, 37/s. E il costo non è
 * il disegno — il canvas è a 1/3 di risoluzione — ma il rAF stesso: obbliga
 * WebKit a un rendering update completo, e lì dentro gira il layout.
 *
 * 30fps su un'onda che si muove lentamente e sfocata non si distingue dai 100:
 * è l'unico punto dove limitare il frame rate è la scelta GIUSTA e non una pezza,
 * perché qui i frame in più non li vede nessuno. Ovunque altro la strada resta
 * togliere il lavoro per frame, non i frame.
 */
const FOCUSED_INTERVAL_MS = 33;

function parked(): boolean {
  return rafId === 0 && timerId === null;
}

function disarm(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

/**
 * Arma UNA sola continuazione: attesa + rAF, con la cadenza che dipende dal
 * fuoco. Il rAF serve solo ad allineare il disegno al vsync — è l'ATTESA a
 * decidere quanti frame chiediamo, e fra un tick e l'altro non resta niente in
 * coda, così il renderer può stare fermo davvero.
 */
function schedule(): void {
  if (subscribers.size === 0 || document.hidden) return;
  if (rafId || timerId !== null) return;
  const wait = document.hasFocus() ? FOCUSED_INTERVAL_MS : UNFOCUSED_INTERVAL_MS;
  timerId = setTimeout(() => {
    timerId = null;
    if (subscribers.size === 0 || document.hidden) return;
    rafId = requestAnimationFrame(loop);
  }, wait);
}

function loop(now: number): void {
  rafId = 0;
  if (document.hidden) return; // sveglia su visibilitychange
  let anyVisible = false;
  for (const fn of subscribers) {
    if (fn(now)) anyVisible = true;
  }
  // Nessuna onda sullo schermo: smetti di chiedere frame. `wakeAuraTicker()`
  // rianima il loop non appena una torna a intersecare il viewport.
  if (!anyVisible) return;
  schedule();
}

/**
 * Rianima il ticker. Chiamalo quando un'aura torna visibile (o si monta): il
 * loop può essersi parcheggiato perché nessuna intersecava il viewport.
 */
export function wakeAuraTicker(): void {
  if (parked()) schedule();
}

if (typeof document !== 'undefined') {
  // Nascosto → parcheggio; tornato visibile → riparto. Il `blur`/`focus`
  // cambiano solo la CADENZA: disarmo la continuazione in volo così la nuova
  // parte subito con quella giusta invece di aspettare il tick vecchio.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) disarm();
    else wakeAuraTicker();
  });
  const recadence = (): void => {
    if (parked()) return;
    disarm();
    schedule();
  };
  window.addEventListener('focus', recadence);
  window.addEventListener('blur', recadence);
}

/** Register a per-frame callback. The rAF loop runs only while ≥1 aura is
 *  mounted AND at least one of them is on screen. Returns an unsubscribe that
 *  stops the loop when the last one goes. */
export function subscribeAuraTick(fn: Tick): () => void {
  subscribers.add(fn);
  schedule();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) disarm();
  };
}
