/**
 * Chi conta come SPETTATORE di una sessione condivisa.
 *
 * È il numero che `GET /api/browsers/:id/viewers` restituisce, ed è l'unico
 * ingresso della decisione auto-share sul desktop (`computeAutoShared`): una
 * pane Tauri in 'auto' disegna la WKWebView nativa quando è sola e passa alla
 * sessione condivisa appena un ALTRO dispositivo guarda lo stesso contesto.
 * Sbagliare questo conteggio non dà un errore: dà una pane che rimbalza fra
 * nativa e condivisa, o un telefono che nessuno vede.
 *
 * Due esclusioni, e nessun'altra:
 *
 *  - IL DELEGATO NATIVO. Una pane nativa tiene comunque un socket
 *    `/ws/browser/:id` (le serve per ricevere le tool-call dell'agente), ma non
 *    guarda un bel niente della sessione condivisa. Contarla voleva dire che
 *    ogni pane nativa vedeva se stessa come «un altro dispositivo» e passava a
 *    condivisa a ogni poll — «il browser si resetta ogni 2 secondi».
 *
 *  - CHI HA LA PANE FUORI DALLO SCHERMO (`set_watching:false`). Un telefono con
 *    la scheda in secondo piano non è un motivo per tenere il Mac nella
 *    sessione condivisa.
 *
 * E in particolare NON si guarda `set_stream`. Quella è la pausa del
 * TRANSPORT, e una pane la manda per ragioni che non c'entrano con lo
 * spettatore: il WebRTC ha preso in carico i pixel (ed è il transport di
 * default), il co-browse DOM sta portando la pagina, un <iframe> nativo la sta
 * mostrando. Il campo che c'era prima (`_streamActive`) prometteva questa
 * esclusione nel commento, non veniva scritto da nessuno — e cablarlo a
 * `set_stream` sarebbe stato peggio del campo morto: avrebbe reso invisibile
 * proprio il telefono che guarda via WebRTC, cioè il caso per cui l'auto-share
 * esiste.
 *
 * Assente ⇒ spettatore. Un client che non manda mai `set_watching` (versione
 * vecchia, o un socket dell'agente) resta contato com'era prima del frame.
 */

/** I soli due campi del `ws.data` che decidono. Tenuto stretto apposta: questa
 *  funzione non deve poter leggere altro. */
export interface ViewerFlags {
  /** Registrato con `register_native_executor`: esegue, non guarda. */
  _nativeDelegate?: boolean;
  /** Ultimo `set_watching` ricevuto. Assente = sta guardando. */
  _watching?: boolean;
}

/** Questo socket è uno spettatore vivo della sessione condivisa? */
export function isSharedViewer(data: ViewerFlags | undefined | null): boolean {
  if (!data) return false;
  if (data._nativeDelegate) return false;
  return data._watching !== false;
}

/** Quanti spettatori ha il contesto. `undefined` (nessun socket) ⇒ 0. */
/**
 * How many OTHER sockets watch the shared session. `except` is the socket the
 * number is for: a pane must never be told a count that includes itself.
 * Between its open and its `register_native_executor` frame a native pane
 * is undeclared, i.e. counted; told "1 viewer" it flipped to the shared
 * render, unmounted its own socket, and reopened: measured on 2026-09-03 as
 * one register/destroy round every two seconds, per pane, all evening.
 */
export function countSharedViewers(
  clients: Iterable<{ data: ViewerFlags }> | undefined | null,
  except?: { data: ViewerFlags } | null,
): number {
  if (!clients) return 0;
  let n = 0;
  for (const c of clients) if (c !== except && isSharedViewer(c.data)) n++;
  return n;
}

/**
 * Who pushes the count to the panes, and when.
 *
 * The count only moves on a handful of server-side events (a socket opens or
 * closes, `set_watching`, `register_native_executor`, the heartbeat reap), so
 * the panes hear about it from the server instead of asking every 2s. This
 * remembers the last value each context was told and sends only when the
 * value differs: the reap calls it for every context on every tick, and a
 * steady context must cost nothing on the wire.
 *
 * Pure on purpose: how to count and how to send are injected, so the rule
 * "a change is published once, a non-change never" can fail in a unit test.
 */
export interface ViewerCountPublisher {
  /** Publish the current count of `contextId` if it differs from the last one
   *  sent; returns the count when a frame went out, `null` otherwise. */
  /** `except`: a socket the change is not sent to (it gets its own count, see `countSharedViewers`). */
  publish(contextId: string, except?: { data: ViewerFlags } | null): number | null;
  /** The context is gone (last socket closed): drop its memory so a context
   *  that comes back with the same count is told again. */
  forget(contextId: string): void;
  /** What the context was last told, for a socket that joins late. */
  last(contextId: string): number | undefined;
}

export function createViewerCountPublisher(
  count: (contextId: string) => number,
  send: (contextId: string, count: number, except?: { data: ViewerFlags } | null) => void,
): ViewerCountPublisher {
  const published = new Map<string, number>();
  return {
    publish(contextId, except) {
      const n = count(contextId);
      if (published.get(contextId) === n) return null;
      published.set(contextId, n);
      send(contextId, n, except);
      return n;
    },
    forget(contextId) {
      published.delete(contextId);
    },
    last(contextId) {
      return published.get(contextId);
    },
  };
}
