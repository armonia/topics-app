/**
 * Protocollo bidirezionale di `/ws/browser/:contextId` — union discriminata,
 * UNA dichiarazione per i due lati del filo.
 *
 * Direzioni:
 *   - frame, agent_active, console, download, engine, webrtc_answer,
 *     render_mode, dom_event, focus_field, viewers:  server → client
 *   - input, take_control, resize, set_engine, set_stream, set_watching,
 *     set_render, webrtc_offer, focus_query: client → server
 *   - nav, webrtc_ice:         entrambe (richiesta da un lato, broadcast dall'altro)
 *
 * Fino al 29/07 questo schema esisteva DUE volte — `server/browser-ws-messages.ts`
 * e `client/src/types/browser-ws-messages.ts` — con in testa, su entrambi, un
 * "KEEP IN SYNC: quando aggiungi una variante modifica ENTRAMBI i file" e la
 * motivazione "TS6307 vieta l'import cross-progetto". Quella motivazione è
 * scaduta: `shared/` è inclusa da entrambi i progetti TS (vedi
 * `shared/ws-outbound.ts`). Aggiungere una variante ora si fa in un posto solo,
 * e non c'è più un secondo file che può restare indietro.
 *
 * Idioma `zod/mini` perché il modulo finisce nel bundle client, dove la variante
 * method-heavy pesa nel chunk d'ingresso: `z.optional(x)` sta per `x.optional()`,
 * `.safeParse` è identico.
 */
import { z } from 'zod/mini';
import { remoteFieldSchema } from './browser-keyboard-field';

const inputActionSchema = z.enum(['click', 'type', 'scroll', 'mousemove', 'keypress']);
const inputButtonSchema = z.enum(['left', 'right', 'middle']);

const inputPayloadSchema = z.object({
  x: z.optional(z.number()),
  y: z.optional(z.number()),
  text: z.optional(z.string()),
  key: z.optional(z.string()),
  deltaX: z.optional(z.number()),
  deltaY: z.optional(z.number()),
  button: z.optional(inputButtonSchema),
});

const frameMetadataSchema = z.object({
  timestamp: z.number(),
  pageScaleFactor: z.optional(z.number()),
  deviceWidth: z.optional(z.number()),
  deviceHeight: z.optional(z.number()),
});

const frameMessageSchema = z.object({
  type: z.literal('frame'),
  data: z.string(),
  metadata: frameMetadataSchema,
});

const inputMessageSchema = z.object({
  type: z.literal('input'),
  action: inputActionSchema,
  payload: inputPayloadSchema,
});

const navMessageSchema = z.object({
  type: z.literal('nav'),
  url: z.string(),
  // 'error' (server -> client): goto/launch failed; `error` carries the short
  // reason the panel renders with Retry (BRW-REL-02). Mirrors server schema.
  phase: z.enum(['request', 'response', 'error']),
  error: z.optional(z.string()),
});

const agentActiveMessageSchema = z.object({
  type: z.literal('agent_active'),
  active: z.boolean(),
  /** What the agent is doing (e.g. "Clicca", "Naviga su example.com"). active=true only. */
  action: z.optional(z.string()),
});

const consoleMessageSchema = z.object({
  type: z.literal('console'),
  level: z.enum(['log', 'warn', 'error']),
  text: z.string(),
});

const takeControlMessageSchema = z.object({
  type: z.literal('take_control'),
});

/** Client -> server: real pane size (CSS px) + devicePixelRatio. See the
 *  canonical server schema for the deviceScaleFactor immutability note. */
const resizeMessageSchema = z.object({
  type: z.literal('resize'),
  // Vincoli veri, non decorativi: una `width` a 0 o frazionaria arriva fino a
  // CDP e rompe il viewport. Erano solo lato server — lo specchio del client
  // accettava `-1` e lo spediva comunque.
  width: z.int().check(z.positive()),
  height: z.int().check(z.positive()),
  deviceScaleFactor: z.optional(z.number().check(z.minimum(1), z.maximum(3))),
});

/** Server -> client: a headless-page download saved under our origin. */
const downloadMessageSchema = z.object({
  type: z.literal('download'),
  filename: z.string(),
  href: z.string(),
  size: z.optional(z.number()),
  state: z.enum(['started', 'completed', 'failed']),
});

/** Client -> server: request this pane run on a different engine (native ↔
 *  chromium). Ignored by servers without the TOPICS_CHROMIUM_ENGINE flag. */
const setEngineMessageSchema = z.object({
  type: z.literal('set_engine'),
  engine: z.enum(['native', 'chromium']),
});

/** Server -> client: the engine this pane now runs on (+ extension count for the
 *  toolbar badge). Mirrors the canonical server schema. */
const engineMessageSchema = z.object({
  type: z.literal('engine'),
  engine: z.enum(['native', 'chromium']),
  extensions: z.optional(z.int().check(z.nonnegative())),
});

/** Client -> server (task 052f53ef): pause/resume this viewer's screencast while
 *  the WS stays open (sent when the pane switches to/from native iframe mode). */
const setStreamMessageSchema = z.object({
  type: z.literal('set_stream'),
  active: z.boolean(),
});

/** Client -> server: is this viewer's pane ON SCREEN?
 *
 *  Deliberately NOT `set_stream`. That one is about the pixel transport, and a
 *  pane pauses the screencast for reasons that have nothing to do with looking
 *  away: WebRTC took over the pixels (the DEFAULT transport), DOM co-browse is
 *  carrying the page, a native <iframe> is showing it. Using it as "is anyone
 *  watching" made a phone streaming over WebRTC invisible to the cross-device
 *  viewer count — so the Mac's 'auto' pane never joined the shared session.
 *
 *  This frame carries only that one fact, and it is what
 *  `GET /api/browsers/:id/viewers` counts. Absent ⇒ watching (a viewer that
 *  never sends it — an older client — keeps the pre-frame behaviour). */
const setWatchingMessageSchema = z.object({
  type: z.literal('set_watching'),
  active: z.boolean(),
});

/**
 * Server -> client: how many shared-session viewers this context has NOW.
 *
 * The same number `GET /api/browsers/:id/viewers` returns, pushed to every
 * socket of the context whenever it changes (join, leave, `set_watching`,
 * `register_native_executor`, heartbeat reap) and once to a socket that just
 * opened. It exists because the auto-share decision used to POLL that route
 * every 2s per pane: measured on the live log, 44% of all API requests for a
 * value that only moves on those events. The poll survives as a 30s safety
 * net for a pane whose socket is down (`useSharedViewerCount`).
 */
const viewersMessageSchema = z.object({
  type: z.literal('viewers'),
  count: z.int().check(z.nonnegative()),
});

/** Client -> server (T1 DOM co-browse): how this pane renders — 'video' (JPEG/
 *  WebRTC pixels, default) or 'dom' (rrweb DOM stream, reconstructed natively).
 *  Paired with set_stream:false to pause the screencast while in DOM mode. */
const setRenderMessageSchema = z.object({
  type: z.literal('set_render'),
  mode: z.enum(['video', 'dom']),
});

/** Server -> client: the render mode now in effect (ack, or forced 'video'
 *  fallback when DOM mode is unsupported for this context). Mirrors server schema. */
const renderModeMessageSchema = z.object({
  type: z.literal('render_mode'),
  mode: z.enum(['video', 'dom']),
});

/** Server -> client (T1 DOM co-browse): one opaque rrweb event fed straight to
 *  the pane's Replayer (NOT deep-validated — rrweb owns its event shape). */
const domEventMessageSchema = z.object({
  type: z.literal('dom_event'),
  event: z.unknown(),
});

/**
 * Server -> client: che campo ha preso il fuoco nella pagina remota dopo
 * l'ultimo click di QUESTO spettatore.
 *
 * Sul ramo video non c'è nessun mirror da interrogare: il pane vede pixel, e
 * senza questa risposta la tastiera del telefono può solo essere quella
 * generica. Dopo il click relayato il server legge `document.activeElement` e
 * ne manda gli attributi; il client li applica al proprio campo di cattura, che
 * è quello che decide la tastiera che iOS apre.
 *
 * `field` assente = nessun campo scrivibile a fuoco (hai toccato un bottone, un
 * link, il vuoto): il client toglie il fuoco e la tastiera rientra.
 *
 * Va SOLO al socket che ha mandato il click. In una sessione condivisa gli
 * altri spettatori non hanno toccato niente, e far salire una tastiera sul
 * telefono di qualcun altro sarebbe un difetto, non una funzione.
 */
const focusFieldMessageSchema = z.object({
  type: z.literal('focus_field'),
  field: z.optional(remoteFieldSchema),
});

/**
 * Client -> server: «chi ha il fuoco adesso?». Stessa risposta di un click
 * relayato (`focus_field`, solo a chi chiede), chiesta a voce.
 *
 * Esiste perché il click ha cambiato strada. Da quando l'input del ramo video
 * viaggia sul DataChannel della PeerConnection, va dal pane al sidecar a CDP e
 * il server non lo vede passare: la lettura del campo, che era agganciata al
 * click sul WS, non partiva più e dal telefono tornava su la tastiera generica.
 *
 * Il click resta dov'è, sul canale veloce. Qui viaggia solo la domanda sulla
 * tastiera, che il round trip col server lo pagava già prima e non è nel
 * percorso che il punto 6 voleva accorciare.
 */
const focusQueryMessageSchema = z.object({
  type: z.literal('focus_query'),
});

/** Client -> server (webrtc shared-session transport): viewer SDP offer. */
const webrtcOfferMessageSchema = z.object({
  type: z.literal('webrtc_offer'),
  sdp: z.string(),
  stream: z.optional(z.string()),
});

/** Server -> client: sidecar SDP answer for a prior webrtc_offer. */
const webrtcAnswerMessageSchema = z.object({
  type: z.literal('webrtc_answer'),
  sdp: z.string(),
  stream: z.optional(z.string()),
});

/** Both directions: a trickle ICE candidate (belt-and-suspenders on LAN). */
const webrtcIceMessageSchema = z.object({
  type: z.literal('webrtc_ice'),
  candidate: z.string(),
  sdpMid: z.optional(z.nullable(z.string())),
  sdpMLineIndex: z.optional(z.nullable(z.number())),
  stream: z.optional(z.string()),
});

export const browserWsMessageSchema = z.discriminatedUnion('type', [
  frameMessageSchema,
  inputMessageSchema,
  navMessageSchema,
  agentActiveMessageSchema,
  consoleMessageSchema,
  takeControlMessageSchema,
  resizeMessageSchema,
  downloadMessageSchema,
  setEngineMessageSchema,
  engineMessageSchema,
  setStreamMessageSchema,
  setWatchingMessageSchema,
  viewersMessageSchema,
  setRenderMessageSchema,
  renderModeMessageSchema,
  domEventMessageSchema,
  focusFieldMessageSchema,
  focusQueryMessageSchema,
  webrtcOfferMessageSchema,
  webrtcAnswerMessageSchema,
  webrtcIceMessageSchema,
]);

export type BrowserWsMessage = z.infer<typeof browserWsMessageSchema>;

export type ParseResult =
  | { ok: true; data: BrowserWsMessage }
  | { ok: false; error: string };

/**
 * Validate and parse a value as a BrowserWsMessage. Use this at every WS
 * receive boundary instead of `as BrowserWsMessage` unsafe casts.
 */
export function parseBrowserWsMessage(value: unknown): ParseResult {
  const result = browserWsMessageSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const error = result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
  return { ok: false, error };
}

/**
 * Type guard booleano, retrocompatibile. Il codice nuovo preferisca
 * `parseBrowserWsMessage`, che porta con sé il contesto dell'errore.
 */
export function isBrowserWsMessage(value: unknown): value is BrowserWsMessage {
  return browserWsMessageSchema.safeParse(value).success;
}

/** Serializza e spedisce: va bene sia sul ServerWebSocket di Bun sia sul WebSocket del browser. */
export function sendBrowserWsMessage<T extends { send: (data: string) => void }>(
  ws: T,
  msg: BrowserWsMessage,
): void {
  ws.send(JSON.stringify(msg));
}
