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
 *  · pane NON attiva → è dentro un guscio `display:none` (PaneKeepAlive), quindi
 *    il redraw non costa layout né paint, ma il lavoro DOM in JS lo fa lo
 *    stesso. Nessuno può vederla: cadenza bassa, zero perdita.
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
  flushMs?: number;
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
      if (timer === null) timer = setTimer(() => { timer = null; flush(); }, flushMs);
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
