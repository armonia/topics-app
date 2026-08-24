/**
 * Lo stato Discord, pubblicato da Topics.
 *
 * ── COSA SOSTITUISCE ────────────────────────────────────────────────────────
 * Un daemon a parte (`~/Projects/claude-discord-presence`, launchd) che ogni
 * 15s lanciava `ps`, contava i processi `claude`, ne campionava il delta di CPU
 * per un secondo e da lì INDOVINAVA quante sessioni stessero lavorando. Aveva
 * due errori strutturali, non di taratura: contava processi che non sono
 * sessioni di lavoro, e non vedeva le chat via API, che non lanciano nessun
 * processo. Topics non indovina — sa quali turni sta trasmettendo e quali task
 * la board ha in mano.
 *
 * ── PERCHÉ IL SERVIZIO È UNA MACCHINA A STATI E NON UN `setInterval` ────────
 * Ci sono tre cose che possono essere diverse a ogni giro: l'interruttore, il
 * filo con Discord, e ciò che c'è da dire. Tenerle in un unico tick significa
 * che spegnere l'interruttore PULISCE la presence (e non la lascia appesa), che
 * Discord chiuso non è un errore ma uno stato da cui si esce da soli, e che un
 * Application ID sbagliato non produce una tempesta di tentativi: quel
 * fallimento non passa col tempo, quindi si rallenta.
 *
 * ── NIENTE È GLOBALE QUI DENTRO ─────────────────────────────────────────────
 * Snapshot, impostazioni, connettore e orologio arrivano iniettati: il test fa
 * girare il servizio contro un finto Discord in tmpdir e contro uno snapshot
 * scritto a mano, senza toccare né il DB né l'app vera. Il singleton — che
 * serve, perché il filo è uno solo per processo — sta in fondo, ed è dieci
 * righe.
 */

import type {
  DiscordConnectionState,
  DiscordDetailLevel,
  DiscordPresenceStatus,
  OutputLanguage,
} from "../../shared/types";
import {
  DiscordIpcError,
  handshake,
  netConnector,
  sendActivity,
  type IpcConnector,
  type IpcSocket,
} from "./discord-ipc";
import { buildActivity, type DiscordActivity, type PresenceSnapshot } from "./discord-activity";

/**
 * L'Application ID di Discord sotto cui compare la card.
 *
 * Non è un segreto — è pubblico per costruzione, sta nel client di chiunque
 * veda la tua presence — quindi vive nel codice e non fra le chiavi. L'env
 * serve a chi vuole la propria app (il nome in cima alla card è quello
 * dell'applicazione, quindi chi non usa la nostra vedrà scritto il suo).
 */
export const DEFAULT_CLIENT_ID = "1467514747988611174";

/** L'immagine grande della card. Un URL diretto: i client recenti lo
 *  risolvono senza dover caricare un art-asset nel Developer Portal. */
/**
 * L'immagine grande della presence.
 *
 * NON SERVE CARICARE NIENTE SUL PORTALE: qui c'era scritto il contrario, ed
 * era falso. La versione precedente di questo commento sosteneva che Discord
 * onora un `large_image` esterno solo per le app che hanno gia' un Rich
 * Presence asset caricato. Interrogato l'IPC direttamente (24/08), con
 * l'applicazione a ZERO asset:
 *
 *   - questo URL viene ACCETTATO e Discord lo riscrive come
 *     `mp:external/<hash>/https/raw.githubusercontent.com/...`, cioe' l'ha
 *     preso in carico e proxato sulla sua CDN;
 *   - quell'indirizzo, chiesto a `media.discordapp.net`, risponde 200 con il
 *     PNG 128x128 giusto (5.351 byte, le due nuvolette bianche su blu);
 *   - una chiave inventata (`chiave_che_non_esiste`) sparisce invece dalla
 *     risposta, e cosi' pure l'hash dell'icona dell'applicazione: quel campo
 *     vuole una chiave di ASSET, che e' un'altra cosa.
 *
 * Il controllo negativo e' la parte che conta: se Discord scartasse gli URL
 * esterni, questo campo sparirebbe come sparisce la chiave inventata. Resta,
 * quindi vale.
 *
 * La «T» che si vede nell'anteprima del pannello e' un'altra faccenda: quella
 * e' l'ANTEPRIMA disegnata da noi, non la card di Discord.
 *
 * Il nome in cima alla card e' quello dell'APPLICAZIONE, non `large_text`:
 * l'IPC lo rimanda indietro come `name: "Jarvis"`. Per farlo leggere «Topics»
 * si rinomina l'applicazione sul portale — quello si', richiede il login.
 *
 * Si sovrascrive con `DISCORD_PRESENCE_IMAGE` senza ricompilare.
 */
export const DEFAULT_LARGE_IMAGE =
  "https://raw.githubusercontent.com/armonia/topics-app/main/desktop-tauri/src-tauri/icons/128x128.png";

/**
 * Lo stato del filo e la sua fotografia stanno in `shared/types.ts`, non qui:
 * `GET /api/profile/discord` li manda al pannello tali e quali, e una seconda
 * dichiarazione lato client sarebbe uno specchio destinato a divergere
 * (`tests/unit/no-type-mirrors.test.ts`).
 *
 * E da qui non si ri-esportano: questo modulo li USA, non è la loro porta.
 * Un `export type { … }` di comodo qui darebbe alla stessa forma due indirizzi,
 * nessuno importerebbe il secondo, e `check:deadcode` lo conterebbe morto —
 * che è esattamente ciò che ha rimandato indietro questa card.
 */

export interface DiscordPresenceSettings {
  enabled: boolean;
  level: DiscordDetailLevel;
  language: OutputLanguage;
}

export interface DiscordPresenceDeps {
  /** Lo stato vero, chiesto a ogni giro: è ciò che rende i numeri esatti. */
  getSnapshot: () => PresenceSnapshot;
  /** Le impostazioni, rilette a ogni giro: così un interruttore mosso da
   *  un'altra finestra vale senza che nessuno debba avvisare questo servizio. */
  getSettings: () => DiscordPresenceSettings;
  clientId?: string;
  largeImage?: string | null;
  connect?: IpcConnector;
  candidates?: string[];
  /** Ogni quanto si guarda se è cambiato qualcosa. */
  refreshMs?: number;
  /** Quanto si aspetta il READY. Un Discord che accetta la connessione e poi
   *  tace è raro ma reale (avvio in corso), e senza un tetto il tick resterebbe
   *  appeso a quel filo — cioè la presence smetterebbe di aggiornarsi senza che
   *  niente lo dica. */
  handshakeTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Quanto si aspetta prima di ritentare, per tipo di fallimento. Discord chiuso
 *  è una condizione che cambia da sola in fretta (lo apri); un ID rifiutato
 *  NON cambia col tempo, quindi ritentarlo ogni 15s è solo rumore.
 *
 *  Effetto collaterale da conoscere, misurato su sei riavvii del server: se il
 *  PRIMO tentativo riesce la presence è viva in ~3s, se fallisce (Discord non
 *  ha ancora riaperto il socket) si aspetta il minuto pieno di `socket_error`
 *  e la ripresa arriva a ~50-60s. In mezzo lo stato è `error`, che a guardarlo
 *  sembra un guasto e invece è l'attesa che funziona: chi diagnostica dopo un
 *  riavvio guardi due volte a un minuto di distanza prima di dire «rotta». */
const RETRY_MS: Record<string, number> = {
  no_socket: 30_000,
  timeout: 60_000,
  socket_error: 60_000,
  handshake_refused: 300_000,
};

export interface DiscordPresenceService {
  start(): void;
  stop(): Promise<void>;
  /** Un giro subito, senza aspettare il timer. La chiama chi muove
   *  l'interruttore: una spunta che impiega quindici secondi a fare effetto si
   *  legge come una spunta rotta. */
  tick(): Promise<void>;
  status(): DiscordPresenceStatus;
  /** L'attività che verrebbe pubblicata ORA con un dato livello — l'anteprima
   *  della card in Impostazioni. Non tocca il filo: si può chiamare con
   *  l'interruttore spento, ed è il punto (si guarda prima di accendere). */
  preview(level?: DiscordDetailLevel): DiscordActivity | null;
}

export function createDiscordPresence(deps: DiscordPresenceDeps): DiscordPresenceService {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((msg: string) => console.log(`[discord] ${msg}`));
  const refreshMs = deps.refreshMs ?? 15_000;
  const clientId = deps.clientId ?? process.env.DISCORD_CLIENT_ID?.trim() ?? DEFAULT_CLIENT_ID;
  const largeImage =
    deps.largeImage === undefined
      ? (process.env.DISCORD_PRESENCE_IMAGE?.trim() || DEFAULT_LARGE_IMAGE)
      : deps.largeImage;

  let socket: IpcSocket | null = null;
  let connection: DiscordConnectionState = "off";
  let user: DiscordPresenceStatus["user"] = null;
  let lastError: string | null = null;
  let lastPublishedAt: number | null = null;
  let published: DiscordActivity | null = null;
  /** La chiave di ciò che è già sul filo: si scrive solo quando CAMBIA. Discord
   *  limita la frequenza dei SET_ACTIVITY, e riscrivere lo stesso stato ogni
   *  quindici secondi è il modo di finire limitati per niente. */
  let publishedKey = "";
  let nextAttemptAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Un solo giro per volta: un tick lento (handshake in corso) non deve
   *  accavallarsi con quello del timer e aprire due fili. */
  let inFlight: Promise<void> | null = null;

  function dropSocket(): void {
    if (!socket) return;
    try { socket.destroy(); } catch { /* già morto */ }
    socket = null;
    publishedKey = "";
    published = null;
    user = null;
  }

  async function ensureConnected(): Promise<boolean> {
    if (socket) return true;
    if (now() < nextAttemptAt) return false;
    connection = "connecting";
    try {
      const res = await handshake({
        clientId,
        connect: deps.connect ?? netConnector,
        candidates: deps.candidates,
        timeoutMs: deps.handshakeTimeoutMs,
        onClose: (why) => {
          // Il filo è caduto: si riparte dal prossimo giro, senza timer propri
          // (un tick c'è già, e due orologi che si rincorrono sono il modo in
          // cui il daemon vecchio si era ritrovato a impilare socket).
          if (!socket) return;
          dropSocket();
          connection = "connecting";
          lastError = `filo caduto (${why.slice(0, 120)})`;
          log(`filo caduto: ${why.slice(0, 200)}`);
        },
      });
      socket = res.socket;
      user = res.user;
      connection = "connected";
      lastError = null;
      nextAttemptAt = 0;
      log(`collegato su ${res.socketPath}${res.user?.username ? ` (utente ${res.user.username})` : ""}`);
      return true;
    } catch (err) {
      const code = err instanceof DiscordIpcError ? err.code : "socket_error";
      connection = code === "no_socket" ? "no_discord" : "error";
      lastError = (err as Error)?.message ?? String(err);
      nextAttemptAt = now() + (RETRY_MS[code] ?? 60_000);
      return false;
    }
  }

  function write(activity: DiscordActivity | null): void {
    if (!socket) return;
    const key = activity ? JSON.stringify(activity) : "__clear__";
    if (key === publishedKey) return;
    try {
      sendActivity(socket, process.pid, activity);
      publishedKey = key;
      published = activity;
      lastPublishedAt = now();
    } catch (err) {
      lastError = `scrittura fallita: ${(err as Error)?.message ?? err}`;
      dropSocket();
      connection = "error";
    }
  }

  function currentActivity(level: DiscordDetailLevel, language: OutputLanguage): DiscordActivity | null {
    return buildActivity(deps.getSnapshot(), level, language, largeImage);
  }

  async function runTick(): Promise<void> {
    const settings = deps.getSettings();

    if (!settings.enabled) {
      if (socket) {
        // Spegnere PULISCE: uno stato appeso dopo che hai tolto il consenso è
        // la cosa peggiore che questo servizio possa fare.
        write(null);
        dropSocket();
      }
      connection = "off";
      lastError = null;
      published = null;
      return;
    }

    if (!(await ensureConnected())) return;
    write(currentActivity(settings.level, settings.language));
  }

  function tick(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = runTick()
      .catch((err) => {
        lastError = (err as Error)?.message ?? String(err);
        connection = "error";
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, refreshMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      void tick();
    },
    async stop(): Promise<void> {
      if (timer) { clearInterval(timer); timer = null; }
      await inFlight?.catch(() => { /* la chiusura non fallisce per un tick */ });
      if (socket) { write(null); dropSocket(); }
      connection = "off";
    },
    tick,
    status(): DiscordPresenceStatus {
      const s = deps.getSettings();
      return {
        enabled: s.enabled,
        level: s.level,
        connection,
        user,
        lastError,
        lastPublishedAt,
        activity: published,
      };
    },
    preview(level?: DiscordDetailLevel): DiscordActivity | null {
      const s = deps.getSettings();
      return currentActivity(level ?? s.level, s.language);
    },
  };
}

// ── Il singleton, perché il filo è uno solo per processo ───────────────────

let servizio: DiscordPresenceService | null = null;

/** Innesta il servizio (lo fa `server.ts`, una volta) e lo avvia. */
export function startDiscordPresence(deps: DiscordPresenceDeps): DiscordPresenceService {
  servizio?.stop().catch(() => { /* il vecchio se ne va comunque */ });
  servizio = createDiscordPresence(deps);
  servizio.start();
  return servizio;
}

/** Il servizio vivo, se c'è. `null` in ogni contesto ridotto (i test delle
 *  rotte, un server senza questo pezzo): chi legge deve saperlo gestire, e la
 *  rotta lo fa dicendo «spento» invece di rompersi. */
export function getDiscordPresence(): DiscordPresenceService | null {
  return servizio;
}

/**
 * Un giro SUBITO perché le impostazioni sono cambiate.
 *
 * La chiama la rotta che scrive l'interruttore. Senza questo, accendere la
 * presence avrebbe effetto al prossimo tick — fino a quindici secondi di
 * pannello che dice «acceso» e profilo che non mostra niente, cioè un
 * interruttore che sembra rotto.
 */
export async function reconcileDiscordPresence(): Promise<void> {
  await servizio?.tick();
}
