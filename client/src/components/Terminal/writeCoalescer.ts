/**
 * Coalescer di scrittura per xterm.
 *
 * Perché esiste. Il renderer DOM di xterm ridisegna al massimo una volta per
 * frame, ma UNA scrittura basta a schedularlo: un TUI che gira (lo spinner di
 * claude-code) scrive a ogni frame, quindi ogni terminale montato ricostruisce
 * le proprie righe 60 volte al secondo. Ricostruirle non è gratis — WebKit
 * distrugge e ricrea i renderer delle righe (`replaceChildren` →
 * `tearDownRenderers`), il che si porta dietro uno style resolve, il layout
 * della riga di testo (rimisurando i glifi) e il repaint. Misurato con `sample`
 * sul processo WebContent dell'app in produzione, a riposo, con 8 finestre
 * progetto aperte e l'app NEMMENO in primo piano: main thread occupato al 43%,
 * di cui layout 445 campioni, style 199, paint 240 — tutto a valle dei redraw
 * dei terminali.
 *
 * Cosa fa. Scrive subito solo quando quel terminale è davvero guardato; negli
 * altri casi accumula e scarica a bassa cadenza. Due casi coperti:
 *
 *  · pane NON attiva → è dentro un guscio `display:none` (PaneKeepAlive). Qui
 *    l'assunzione scritta prima ("il redraw non costa layout né paint, solo
 *    lavoro DOM in JS") era SBAGLIATA, ed è il caso peggiore, non il migliore.
 *    Il renderer DOM misura la larghezza dei glifi con `offsetWidth` su uno
 *    `span` nascosto, e `WidthCache.get` **non memorizza una misura pari a 0**
 *    (`if (width > 0)`, xterm v6). Dentro `display:none` ogni misura torna 0,
 *    quindi la cache non si popola MAI: ogni scarico rimisura ogni glifo di ogni
 *    riga, per sempre, e ogni misura è una lettura che sporca stile e layout.
 *    Misurato nell'app vera (sonda in lib/devLayoutProbe.ts, 2026-07-28): 643
 *    `offsetWidth` forzati in 15 secondi, primo costo dell'app mentre si scrive
 *    in un terminale. Per questo una pane SENZA LAYOUT non viene scaricata a
 *    tempo: si accumula e si scarica quando torna visibile (o al tetto di byte).
 *    Nessuno può vederla: zero perdita di contenuto, ordine dei byte intatto.
 *  · app non a fuoco o nascosta → è la condizione NORMALE di un'app companion,
 *    ed è la stessa soglia che `useAnimationPause` usa già per fermare le
 *    animazioni CSS. Il terminale resta VIVO (aggiorna 4 volte al secondo, non
 *    si congela): cala la cadenza, non il contenuto.
 *
 * L'ordine dei byte è preservato in ogni caso — i chunk escono nella sequenza in
 * cui sono arrivati, e ogni scrittura diretta (banner di sessione chiusa, ecc.)
 * passa da qui, altrimenti scavalcherebbe la coda e romperebbe lo stato ANSI.
 */

export type TerminalChunk = string | Uint8Array;

/** Cadenza di scarico quando nessuno sta guardando (~4Hz). */
export const BACKGROUND_FLUSH_MS = 250;

/**
 * Cadenza per un terminale VISIBILE ma senza il fuoco della tastiera (~15Hz).
 *
 * Perché esiste una terza cadenza. La scrittura immediata serve a UNA cosa sola:
 * l'eco di quello che stai battendo. Un terminale che non ha il cursore non ha
 * nessun eco da rendere immediato — sta solo mostrando output — e in uno split
 * con più gruppi ce ne sono diversi "attivi" insieme, ognuno dei quali
 * ricostruiva le proprie righe a ogni frame. Ogni ricostruzione sporca il
 * layout, e l'animatore del caret (misurato al 24% del main thread) forza un
 * layout SINCRONO dell'intero documento a ogni frame per ridisegnare il cursore:
 * più righe sporche ci trova, più costa quel layout. 15Hz su un log che scorre
 * è indistinguibile dai 60, ma divide per quattro le righe sporche per frame.
 */
export const VISIBLE_FLUSH_MS = 66;

/**
 * Tetto della coda. Superato, si scarica SUBITO invece di scartare: buttare via
 * dei byte in mezzo a una sequenza di escape lascerebbe il terminale in uno
 * stato ANSI corrotto (colori incollati, cursore perso). Meglio un redraw in più
 * che un buffer sbagliato.
 */
export const MAX_PENDING_BYTES = 512 * 1024;

export interface WriteCoalescer {
  /** Accoda un chunk (o lo scrive subito se il terminale è guardato). */
  push(chunk: TerminalChunk): void;
  /** Scarica subito tutto l'arretrato. Idempotente. */
  flush(): void;
  /** Ferma il timer e libera la coda. Da chiamare allo smontaggio. */
  dispose(): void;
  /** Byte in attesa — per i test. */
  readonly pendingBytes: number;
}

export interface WriteCoalescerOptions {
  /** Dove finiscono i chunk: `term.write` in produzione. */
  write: (chunk: TerminalChunk) => void;
  /** True quando quel terminale è davvero guardato ⇒ scrittura immediata. */
  isWatched: () => boolean;
  /**
   * True se il terminale ha un box nel layout (non è dentro un `display:none`).
   * Quando è false lo scarico a tempo è SOSPESO: ridisegnare senza layout non
   * mostra niente a nessuno e costa il doppio (vedi la nota sulla WidthCache in
   * testa al file). L'arretrato esce al ritorno della visibilità — chi possiede
   * il terminale chiama `flush()` — o al tetto di byte. Assente ⇒ sempre true,
   * così il comportamento storico resta invariato per chi non lo passa.
   */
  hasLayout?: () => boolean;
  /** Cadenza di scarico. Può essere una funzione: la si rilegge a ogni arming,
   *  così cambiare stato (visibile ↔ in secondo piano) cambia la cadenza senza
   *  ricreare il coalescer. */
  flushMs?: number | (() => number);
  maxPendingBytes?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

function byteLength(chunk: TerminalChunk): number {
  return typeof chunk === 'string' ? chunk.length : chunk.byteLength;
}

export function createWriteCoalescer({
  write,
  isWatched,
  hasLayout = () => true,
  flushMs = BACKGROUND_FLUSH_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: WriteCoalescerOptions): WriteCoalescer {
  let pending: TerminalChunk[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function disarm() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function flush() {
    disarm();
    if (pending.length === 0) return;
    // Svuota PRIMA di scrivere: `write` può rientrare (un handler di xterm che
    // reagisce all'output e scrive a sua volta), e trovare la coda già vuota
    // evita di riscrivere due volte gli stessi byte.
    const queued = pending;
    pending = [];
    bytes = 0;
    for (const chunk of queued) write(chunk);
  }

  return {
    push(chunk: TerminalChunk) {
      if (disposed) return;
      if (isWatched()) {
        // Un arretrato può esistere se la pane è appena tornata visibile e il
        // chunk nuovo arriva prima del flush: esce comunque in ordine.
        flush();
        write(chunk);
        return;
      }
      pending.push(chunk);
      bytes += byteLength(chunk);
      if (bytes >= maxPendingBytes) {
        flush();
        return;
      }
      // Senza layout non si scarica a tempo: si aspetta il ritorno della
      // visibilità. Un timer già armato viene disinnescato — la pane può essere
      // stata nascosta DOPO che era partito.
      if (!hasLayout()) {
        disarm();
        return;
      }
      if (timer === null) {
        const ms = typeof flushMs === 'function' ? flushMs() : flushMs;
        timer = setTimer(() => { timer = null; flush(); }, ms);
      }
    },
    flush() {
      if (disposed) return;
      flush();
    },
    dispose() {
      disposed = true;
      disarm();
      pending = [];
      bytes = 0;
    },
    get pendingBytes() {
      return bytes;
    },
  };
}
