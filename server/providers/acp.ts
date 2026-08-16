/**
 * AcpProvider — UN provider per TUTTI gli agenti che parlano Agent Client
 * Protocol (3.2).
 *
 * Il problema che chiude: oggi ogni agente costa un provider intero. Tre
 * agenti, tre parser di eventi, tre macchine a stati, tre posti dove sbagliare
 * la stessa cosa — e il quarto costa quanto il primo. ACP è il protocollo che
 * Zed ha messo in mezzo proprio per questo: l'agente espone JSON-RPC su stdio,
 * il client ne sa una sola forma. Da qui in poi «supportare Gemini CLI»
 * significa aggiungere una riga in `acp/agents.ts`.
 *
 * Com'è fatto, e perché così:
 *
 *  • **Il provider è un guscio.** Trasporto (`acp/jsonrpc.ts`) e traduzione
 *    (`acp/translate.ts`) sono puri e testati da soli. Qui restano solo le tre
 *    cose che hanno bisogno del mondo vero: il processo, la sessione, il
 *    dispatch verso lo `StreamHandler` della chat.
 *
 *  • **Un processo, N sessioni.** È il modello di ACP e non è un dettaglio:
 *    l'alternativa (un processo per chat) moltiplica la RAM per il numero di
 *    tab aperte, che è esattamente ciò che Topics evita altrove.
 *
 *  • **La sessione dell'agente si ricorda su disco** (`provider_sessions`,
 *    migration 063). Senza, ogni riavvio del server aprirebbe di nascosto una
 *    conversazione vuota sotto una chat piena di messaggi: la UI mostra tutto,
 *    il modello non ricorda niente. Errore che non dà errore.
 *
 *  • **I permessi si concedono.** Alla richiesta `session/request_permission`
 *    rispondiamo con l'opzione più permissiva offerta. Non è pigrizia: è la
 *    decisione già presa nel piano (Fase 2 scartata) — Topics serve a lavorare
 *    anche fuori dalla sessione, e un prompt di permesso che nessuno guarda
 *    blocca un agente headless per sempre. Una politica diversa si mette QUI,
 *    in una funzione sola.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import type {
  AcpProviderConfig,
  AIProvider,
  ChatMessage,
  CompletionResult,
  ProviderCapability,
  ProviderContextStrategy,
  ProviderDiagnostic,
  ProviderDoneMessage,
  ProviderRequirement,
  StreamHandler,
} from "./types";
import { probeBinaryPath } from "../utils/executable";
import { getDatabase } from "../db";
import { classifyTurnError, isAcpStopReason, type TurnEndInfo } from "./stop-reason";
import { getTopicWorkspaceForSession } from "./claude-code";
import { JsonRpcPeer, JsonRpcRemoteError, RPC_METHOD_NOT_FOUND } from "./acp/jsonrpc";
import {
  newTranslateState,
  translateSessionUpdate,
  type AcpSessionUpdate,
  type AcpTranslateState,
} from "./acp/translate";
import {
  forgetProviderSession,
  readProviderSession,
  sessionMatchesCwd,
  writeProviderSession,
} from "./acp/session-store";

// Il config vive in `./types` insieme agli altri (fa parte di `ProviderConfig`);
// si ri-esporta qui perché è di questo provider che parla.
export type { AcpProviderConfig };

// ============ Costanti ============

/** Versione di protocollo che sappiamo parlare. ACP v1 è quella stabile. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Il prefisso con cui muore una connessione verso un agente che parla una
 * versione che non sappiamo parlare. Prefisso e non messaggio libero perché è
 * la stessa convenzione di `PROCESS_DIED_*`: `classifyTurnError` instrada per
 * prefisso, e il testo che segue è il numero che l'agente ha dichiarato.
 */
export const ACP_VERSION_UNSUPPORTED = "ACP_VERSION_UNSUPPORTED";

const CLIENT_INFO = { name: "topics", title: "Topics", version: "1" };

/**
 * Cosa il client sa fare. Dichiariamo `false` su filesystem e terminale di
 * proposito: sono superfici che l'agente sa già raggiungere da sé (gira sulla
 * stessa macchina, con lo stesso utente), e dichiararle vorrebbe dire diventare
 * il canale di ogni sua lettura e scrittura senza aggiungere niente.
 */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

/** Tetto duro di un turno. Il watchdog dello stream è più fine; questo è la rete. */
const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

const KILL_GRACE_MS = 3_000;

/**
 * Quanto si aspetta un `session/set_model`. È una richiesta di CONFIGURAZIONE,
 * non un turno: se l'agente non risponde in fretta, il turno parte comunque sul
 * modello che c'è. Aspettare a lungo qui bloccherebbe il lavoro per una leva.
 */
const SET_MODEL_TIMEOUT_MS = 10_000;

const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "TZ", "USER", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  // Credenziali degli agenti ACP noti. Senza queste il child parte e muore al
  // primo turno con un errore di autenticazione: `gemini` legge la chiave da
  // `GEMINI_API_KEY` (o dalle credenziali Google se si è fatto il login
  // interattivo, che invece stanno in ~/.gemini e passano già da HOME).
  "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
]);

// ============ Stato per sessione ============

interface AcpSessionState {
  /** L'id che ci ha dato l'agente con `session/new`. */
  acpSessionId: string;
  cwd: string | null;
  handler?: StreamHandler;
  translate: AcpTranslateState;
  /** Testo accumulato: `onTextDelta` vuole anche il cumulato. */
  fullText: string;
  /** Qualcuno ha chiesto lo stop: il `cancelled` che tornerà è nostro. */
  aborting?: "user" | "watchdog";
  promptInFlight: boolean;
  /**
   * L'ultimo modello che abbiamo CHIESTO all'agente per questa sessione.
   *
   * Serve a non rifare la stessa richiesta a ogni turno: la sessione ACP vive
   * dentro un demone condiviso e il modello, una volta impostato, ci resta.
   * `null` = non l'abbiamo mai toccato, quindi vale quello scelto dall'agente.
   */
  model: string | null;
  /** L'ultimo effort di ragionamento che abbiamo chiesto per questa sessione. */
  effort: string | null;
}

// ============ Provider ============

export class AcpProvider implements AIProvider {
  readonly name: string;
  readonly capabilities = new Set<ProviderCapability>([
    "streaming",
    "tools",
    "thinking",
    "sessions",
    "abort",
  ]);
  /**
   * L'agente tiene la storia per conto suo (è il senso di `session/new`), quindi
   * i blocchi di sistema vanno inlinati nel turno come per la CLI di Claude.
   */
  readonly contextStrategy: ProviderContextStrategy = "inline-system";

  private readonly config: AcpProviderConfig;
  private child: ChildProcess | null = null;
  private peer: JsonRpcPeer | null = null;
  private connecting: Promise<JsonRpcPeer> | null = null;
  private agentCapabilities: Record<string, unknown> = {};
  private stopped = false;
  private binaryMissingLogged = false;
  /**
   * Questo agente non conosce `session/set_model`: si è già provato una volta e
   * ha risposto «metodo sconosciuto». È una proprietà dell'AGENTE e non del
   * turno, quindi la si ricorda invece di ripetere la domanda (e l'avviso) a
   * ogni singolo prompt.
   */
  private setModelUnsupported = false;
  /**
   * I modelli annunciati dall'agente, presi dai `configOptions` di
   * `session/new`. Vive sul PROVIDER e non sulla sessione: è una proprietà
   * dell'agente, e il selettore la chiede senza avere una sessione in mano.
   */
  private knownModels: string[] = [];
  /**
   * Il modello su cui l'agente dice di girare ADESSO. Alimenta `defaultModel()`,
   * cioè il badge del contesto: si tiene aggiornato da ciò che l'agente rimanda,
   * mai da ciò che gli abbiamo chiesto.
   */
  private activeModel: string | null = null;
  /**
   * L'agente non sa cambiare l'effort di ragionamento, o l'ha rifiutato in modo
   * definitivo. Stessa logica di `setModelUnsupported`: è una proprietà
   * dell'agente, non del turno.
   */
  private setEffortUnsupported = false;
  /**
   * L'agente ha risposto con una versione di protocollo che non sappiamo
   * parlare. Non è uno stato transitorio da riprovare: finché il binario resta
   * quello, ogni `initialize` risponderà lo stesso numero. Si tiene qui perché
   * deve spegnere il provider (`connected`), fermare i tentativi di
   * riconnessione e comparire nel `diagnose()` con dentro il numero visto.
   */
  private versionMismatch: { agentVersion: number; reason: string } | null = null;

  /** sessionKey → stato. */
  private readonly sessions = new Map<string, AcpSessionState>();
  /** acpSessionId → sessionKey. Le notifiche arrivano con l'id dell'agente. */
  private readonly bySessionId = new Map<string, string>();

  constructor(config: AcpProviderConfig) {
    this.config = config;
    this.name = config.name;
  }

  /**
   * «Possiamo servire una chat?», non «c'è un processo vivo adesso»: il processo
   * si accende al primo turno (spawnarlo al boot per una tab che magari nessuno
   * apre è RAM regalata). Con l'eseguibile al suo posto la risposta è sì, e il
   * selettore del default non ha motivo di scartarci.
   */
  get connected(): boolean {
    if (this.stopped) return false;
    // Un peer che parla una versione che non sappiamo parlare non è «connesso a
    // metà»: è inservibile. Dirlo qui lo toglie dalla graduatoria del default e
    // impedisce che una chat ci finisca contro per poi morire in modo opaco.
    if (this.versionMismatch) return false;
    if (this.child) return this.child.exitCode === null && !this.child.killed;
    return this.resolveBinary() !== null;
  }

  // ── Ciclo di vita ────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    // Un `start()` è l'unico modo per riprovare dopo un rifiuto di versione: lo
    // fa chi ri-registra il provider, cioè chi ha appena cambiato il binario o
    // la configurazione. Riprovare da soli, senza che nulla sia cambiato,
    // significherebbe rispawnare l'agente a ogni turno per riottenere lo stesso
    // numero.
    this.versionMismatch = null;
    if (!this.resolveBinary() && !this.binaryMissingLogged) {
      this.binaryMissingLogged = true;
      console.warn(`[ACP:${this.name}] eseguibile "${this.config.command}" non trovato nel PATH`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.teardown("ACP_PROVIDER_STOPPED");
  }

  private teardown(reason: string): void {
    const child = this.child;
    this.peer?.close(reason);
    this.peer = null;
    this.connecting = null;
    this.child = null;
    this.dropSessions();
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch { /* già morto */ }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* già morto */ }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  private resolveBinary(): string | null {
    const cmd = this.config.command;
    // Un percorso (`/opt/jcode/bin/jcode`, `./agente`) si prende per buono solo
    // se il file c'è DAVVERO. Prima bastava che contenesse una barra: il
    // provider si dichiarava `connected`, entrava nella graduatoria del default
    // e la prima chat moriva su `ACP_BINARY_NOT_FOUND` — un guasto che si vede
    // solo quando qualcuno prova a parlarci, cioè nel momento peggiore.
    //
    // Il caso non è teorico: `ACP_AGENTS` esiste apposta per puntare a un
    // binario in un posto suo, e un percorso vecchio dopo un aggiornamento è il
    // modo normale in cui quella riga smette di essere vera.
    if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
    return Bun.which(cmd) ?? null;
  }

  // ── Connessione ──────────────────────────────────────────────────────────

  /**
   * Spawna e negozia, una volta sola. La promise è memoizzata perché due chat
   * che partono insieme devono trovare LO STESSO processo: due `initialize` in
   * parallelo darebbero due agenti, e il secondo non saprebbe niente delle
   * sessioni del primo.
   */
  private ensureConnection(): Promise<JsonRpcPeer> {
    // Rifiuto di versione già accertato: si fallisce SUBITO, con lo stesso
    // motivo della prima volta. Rispawnare l'agente per farsi ridire lo stesso
    // numero costerebbe un processo per turno e nasconderebbe la causa dietro
    // un timeout.
    if (this.versionMismatch) return Promise.reject(new Error(this.versionMismatch.reason));
    if (this.peer && !this.peer.isClosed) return Promise.resolve(this.peer);
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().catch((err) => {
      this.connecting = null;
      throw err;
    });
    return this.connecting;
  }

  private async connect(): Promise<JsonRpcPeer> {
    const bin = this.resolveBinary();
    if (!bin) throw new Error(`ACP_BINARY_NOT_FOUND: ${this.config.command}`);

    const env: Record<string, string> = {};
    for (const key of ENV_ALLOWLIST) {
      const v = process.env[key];
      if (v) env[key] = v;
    }
    Object.assign(env, this.config.env ?? {});

    const child = spawn(bin, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this.config.defaultWorkspace || process.env.HOME || "/tmp",
    });
    this.child = child;

    const peer = new JsonRpcPeer({
      write: (line) => { child.stdin?.write(line + "\n"); },
      onTransportError: (msg, raw) => {
        // Su stdout di un agente finisce di tutto: si logga corto e si tira avanti.
        console.warn(`[ACP:${this.name}] ${msg}${raw ? ` — ${raw.slice(0, 200)}` : ""}`);
      },
    });
    this.peer = peer;

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => peer.feed(chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[ACP:${this.name}] stderr: ${text.slice(0, 500)}`);
    });

    const onDeath = (detail: string) => {
      if (this.peer !== peer) return; // già sostituito da una riconnessione
      this.peer = null;
      this.connecting = null;
      this.child = null;
      this.dropSessions();
      // `close()` rigetta le `session/prompt` in volo con questo motivo, e
      // `classifyTurnError` riconosce il prefisso `PROCESS_DIED`: l'errore
      // arriva alla chat da UNA strada sola, quella normale.
      peer.close(detail);
    };
    child.on("exit", (code, signal) => onDeath(`PROCESS_DIED_${code ?? signal ?? "unknown"}`));
    child.on("error", (err) => onDeath(`PROCESS_DIED_${err.message}`));

    peer.onNotification("session/update", (params) => this.onSessionUpdate(params));
    peer.onRequest("session/request_permission", (params) => this.onPermissionRequest(params));

    const result = (await peer.request<Record<string, unknown>>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      // v1 lo chiama `clientCapabilities`, la bozza v2 `capabilities` + `info`.
      // Mandarli entrambi costa due campi ignorati e ci fa parlare con tutti e due.
      capabilities: CLIENT_CAPABILITIES,
      info: CLIENT_INFO,
    })) ?? {};

    // LA VERSIONE CHE L'AGENTE HA SCELTO, non quella che abbiamo chiesto.
    //
    // La spec è esplicita: se l'agente non supporta la versione richiesta
    // risponde con l'ULTIMA che supporta, e un client che non la supporta
    // dovrebbe chiudere e dirlo. Finora `result.protocolVersion` veniva
    // buttato via — quindi il giorno che un agente risponde `2` continuavamo a
    // parlare v1 su un peer v2. Non un errore netto: una `session/new` che
    // risponde storto e una chat che muore senza motivo leggibile.
    //
    // Un numero PIÙ BASSO (o assente) non è un problema: è retro-compatibilità,
    // l'agente sta dicendo «parliamo la tua». Solo un numero più alto significa
    // che non ha potuto scendere fino a noi.
    const negotiated = result.protocolVersion;
    if (typeof negotiated === "number" && Number.isFinite(negotiated) && negotiated > ACP_PROTOCOL_VERSION) {
      const reason = `${ACP_VERSION_UNSUPPORTED}_${negotiated}`;
      this.versionMismatch = { agentVersion: negotiated, reason };
      console.warn(
        `[ACP:${this.name}] l'agente parla ACP v${negotiated}, noi v${ACP_PROTOCOL_VERSION}: chiudo la connessione`,
      );
      // `teardown` chiude il peer con questo motivo, quindi le richieste in volo
      // (non ce ne sono a questo punto, ma la strada è una sola) muoiono con lo
      // stesso testo che l'utente legge nel diagnose.
      this.teardown(reason);
      throw new Error(reason);
    }

    this.agentCapabilities =
      (result.agentCapabilities as Record<string, unknown>) ??
      (result.capabilities as Record<string, unknown>) ??
      {};
    return peer;
  }

  /**
   * Le sessioni dell'agente muoiono col processo. Si svuota la mappa in memoria
   * — l'id su disco NO: serve a `session/load` al giro dopo, ed è tutto il senso
   * della migration 063.
   */
  private dropSessions(): void {
    for (const [, state] of this.sessions) state.promptInFlight = false;
    this.sessions.clear();
    this.bySessionId.clear();
  }

  // ── Sessioni ─────────────────────────────────────────────────────────────

  private workspaceFor(sessionKey: string): string {
    return (
      getTopicWorkspaceForSession(sessionKey) ||
      this.config.defaultWorkspace ||
      process.env.HOME ||
      "/tmp"
    );
  }

  /**
   * La sessione ACP per questa chat: quella già viva, quella ricordata su disco
   * (se l'agente sa ricaricarle), o una nuova.
   */
  private async ensureSession(peer: JsonRpcPeer, sessionKey: string): Promise<AcpSessionState> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const cwd = this.workspaceFor(sessionKey);
    const remembered = this.readRemembered(sessionKey, cwd);

    if (remembered && this.canLoadSession()) {
      try {
        await peer.request("session/load", {
          sessionId: remembered,
          cwd,
          mcpServers: [],
        });
        return this.registerSession(sessionKey, remembered, cwd);
      } catch (err) {
        // Sessione sparita lato agente (file cancellato, versione cambiata):
        // si dimentica e si riparte, invece di lasciare la chat morta.
        console.warn(`[ACP:${this.name}] session/load fallita, ne apro una nuova: ${errText(err)}`);
        this.forgetRemembered(sessionKey);
      }
    }

    const res = (await peer.request<Record<string, unknown>>("session/new", {
      cwd,
      mcpServers: [],
    })) ?? {};
    const id = typeof res.sessionId === "string" ? res.sessionId : "";
    if (!id) throw new Error("ACP_NO_SESSION_ID");
    this.absorbConfigOptions(res);
    this.rememberSession(sessionKey, id, cwd);
    return this.registerSession(sessionKey, id, cwd);
  }

  /**
   * Prende dai `configOptions` di una risposta ciò che l'agente dice di sé.
   *
   * Oggi serve per una cosa sola — l'elenco dei modelli, che senza questo il
   * selettore non avrebbe mai (vedi `listModels`) — ma la forma è quella:
   * l'agente si DESCRIVE, e noi leggiamo invece di indovinare. Silenziosa e
   * senza effetti se la risposta non ha quel campo: `session/new` non è
   * obbligata ad averlo, e un agente che non lo manda non è un agente rotto.
   */
  private absorbConfigOptions(res: Record<string, unknown> | undefined): void {
    const opts = res?.configOptions;
    if (!Array.isArray(opts)) return;
    const model = opts.find(
      (o): o is Record<string, unknown> =>
        !!o && typeof o === "object" && (o as Record<string, unknown>).id === "model",
    );
    const list = model?.options;
    if (!Array.isArray(list)) return;
    const names = list
      .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).value : null))
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (names.length > 0) this.knownModels = names;
    const cur = this.currentModelFrom(res);
    if (cur) this.activeModel = cur;
  }

  /**
   * Porta la sessione sull'effort di ragionamento chiesto per questo topic.
   *
   * Perché è separato dal modello. L'effort è la leva più CARA che Topics ha:
   * sullo stesso lavoro `medium` ha misurato 61,1k token e `xhigh` 108,8k. La
   * board lo sceglie per task esattamente come il modello, e su claude-code
   * finisce nei flag di spawn — quindi ignorarlo qui vorrebbe dire che
   * dispacciare su jcode fa saltare il freno del costo senza dirlo.
   *
   * Perché il valore non arriva da `sendChat`. L'effort non è nelle opzioni del
   * turno: vive sulla riga del topic (migrazione 033) e ogni provider se lo va
   * a leggere. Si fa lo stesso, con la stessa lettura stretta di claude-code.
   *
   * Degrada come il modello, e qui il ripiego è più probabile: `set_reasoning_effort`
   * vale solo per i modelli che espongono il thinking di Anthropic, quindi il
   * rifiuto è NORMALE su tutti gli altri e non deve sporcare il log a ogni
   * turno né fermare niente.
   */
  private async applyEffort(
    peer: JsonRpcPeer,
    state: AcpSessionState,
    sessionKey: string,
  ): Promise<void> {
    if (this.setEffortUnsupported) return;
    const effort = readTopicEffort(sessionKey);
    if (!effort || effort === state.effort) return;
    try {
      await withTimeout(
        peer.request("session/set_reasoning_effort", {
          sessionId: state.acpSessionId,
          effort,
        }),
        SET_MODEL_TIMEOUT_MS,
        "ACP_SET_EFFORT_TIMEOUT",
      );
      state.effort = effort;
    } catch (err) {
      if (isMethodNotFound(err)) {
        this.setEffortUnsupported = true;
        console.warn(
          `[ACP:${this.name}] non sa cambiare l'effort (session/set_reasoning_effort assente): ` +
          `i turni girano sull'effort scelto dall'agente`,
        );
        return;
      }
      // Rifiuto del VALORE: succede per i modelli che non espongono il
      // thinking, ed è normale. Si segna comunque come applicato per non
      // ripetere la richiesta (e l'avviso) a ogni turno della sessione.
      state.effort = effort;
      console.warn(`[ACP:${this.name}] effort "${effort}" non applicato: ${errText(err)}`);
    }
  }

  /** Il modello che l'agente dichiara ATTIVO in una risposta con `configOptions`. */
  private currentModelFrom(res: Record<string, unknown> | undefined): string | null {
    const opts = res?.configOptions;
    if (!Array.isArray(opts)) return null;
    const model = opts.find(
      (o): o is Record<string, unknown> =>
        !!o && typeof o === "object" && (o as Record<string, unknown>).id === "model",
    );
    const cur = model?.currentValue;
    return typeof cur === "string" && cur ? cur : null;
  }

  private registerSession(sessionKey: string, acpSessionId: string, cwd: string | null): AcpSessionState {
    const state: AcpSessionState = {
      acpSessionId,
      cwd,
      translate: newTranslateState(),
      fullText: "",
      promptInFlight: false,
      model: null,
      effort: null,
    };
    this.sessions.set(sessionKey, state);
    this.bySessionId.set(acpSessionId, sessionKey);
    return state;
  }

  /**
   * Porta la sessione sul modello CHIESTO da chi apre il turno.
   *
   * Perché esiste. Su Topics il modello non è una preferenza globale: la board
   * lo sceglie PER TASK (`task.model`, o il classificatore automatico), ed è
   * una leva di costo — lo stesso lavoro su un modello grosso e su uno piccolo
   * non costa uguale. Il provider ACP però riceveva `_options` e lo buttava
   * via: ogni sessione girava sul modello di default dell'agente, in silenzio.
   * Su una board dispacciata significa che «questo task su haiku» non veniva
   * onorato e nessuno se ne accorgeva, perché il turno riesce lo stesso.
   *
   * Perché così. ACP v1 non standardizza il cambio di modello, quindi non lo si
   * dà per scontato: si chiede `session/set_model` e si accetta che l'agente
   * non lo conosca (`-32601`). In quel caso si degrada in modo esplicito — un
   * avviso una volta sola per agente — invece di fingere che sia andata.
   *
   * Perché non fallisce il turno. Un modello non applicato è un turno che gira
   * su un altro modello: peggio del previsto, ma è lavoro fatto. Farlo morire
   * qui trasformerebbe una degradazione in un guasto.
   */
  private async applyModel(
    peer: JsonRpcPeer,
    state: AcpSessionState,
    model: string | undefined,
  ): Promise<void> {
    if (!model || model === state.model) return;
    if (this.setModelUnsupported) return;
    try {
      const res = await withTimeout(
        peer.request<Record<string, unknown>>("session/set_model", {
          sessionId: state.acpSessionId,
          model,
        }),
        SET_MODEL_TIMEOUT_MS,
        "ACP_SET_MODEL_TIMEOUT",
      );
      // La risposta rimanda i `configOptions` aggiornati: si legge da lì invece
      // di dare per buono ciò che abbiamo chiesto. Un agente che accetta la
      // chiamata ma tiene un altro modello (nome normalizzato, alias, fallback)
      // deve risultare per quello che HA, non per quello che gli è stato detto.
      this.absorbConfigOptions(res);
      state.model = this.currentModelFrom(res) ?? model;
    } catch (err) {
      // Metodo assente = questo agente non sa cambiare modello. È una proprietà
      // dell'agente, non di questo turno: si smette di chiederglielo.
      if (isMethodNotFound(err)) {
        this.setModelUnsupported = true;
        console.warn(
          `[ACP:${this.name}] non sa cambiare modello (session/set_model assente): ` +
          `i turni girano sul modello scelto dall'agente, la scelta per task non si applica`,
        );
        return;
      }
      // Modello rifiutato (nome sconosciuto, non disponibile su questo account):
      // vale per QUESTO nome, non per il metodo — un altro task con un altro
      // modello deve poter riprovare.
      console.warn(`[ACP:${this.name}] modello "${model}" non applicato: ${errText(err)}`);
    }
  }

  private canLoadSession(): boolean {
    const caps = this.agentCapabilities;
    if (caps.loadSession === true) return true;
    const session = caps.session;
    return !!session && typeof session === "object" && (session as Record<string, unknown>).load !== undefined;
  }

  private readRemembered(sessionKey: string, cwd: string | null): string | null {
    try {
      const row = readProviderSession(getDatabase(), this.name, sessionKey);
      if (!row) return null;
      if (!sessionMatchesCwd(row, cwd)) {
        this.forgetRemembered(sessionKey);
        return null;
      }
      return row.providerSessionId;
    } catch {
      return null;
    }
  }

  private rememberSession(sessionKey: string, id: string, cwd: string | null): void {
    try {
      writeProviderSession(getDatabase(), this.name, sessionKey, id, cwd);
    } catch (err) {
      // Perdere la memoria è un degrado (contesto perso al riavvio), non un guasto.
      console.warn(`[ACP:${this.name}] non ho potuto ricordare la sessione: ${errText(err)}`);
    }
  }

  private forgetRemembered(sessionKey: string): void {
    try {
      forgetProviderSession(getDatabase(), this.name, sessionKey);
    } catch { /* niente da dimenticare */ }
  }

  // ── Eventi in arrivo ─────────────────────────────────────────────────────

  private onSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const sessionKey = this.bySessionId.get(sessionId);
    if (!sessionKey) return;
    const state = this.sessions.get(sessionKey);
    const handler = state?.handler;
    if (!state || !handler) return;

    const update = params.update as AcpSessionUpdate | undefined;
    for (const ev of translateSessionUpdate(update, state.translate)) {
      switch (ev.kind) {
        case "text":
          state.fullText += ev.text;
          handler.onTextDelta(ev.text, state.fullText);
          break;
        case "thinking":
          handler.onThinkingDelta?.(ev.text);
          break;
        case "tool_start":
          handler.onToolStart(ev.toolCallId, ev.name, ev.args);
          break;
        case "tool_args":
          handler.onToolArgsUpdate?.(ev.toolCallId, ev.args);
          break;
        case "plan":
          handler.onPlan?.(ev.steps);
          break;
        case "tool_update":
          handler.onToolUpdate?.(ev.toolCallId, ev.partialResult);
          break;
        case "tool_result":
          handler.onToolResult(ev.toolCallId, ev.result, ev.isError);
          break;
        case "context":
          handler.onContextSize?.(ev.tokens, this.config.name, ev.windowTokens);
          break;
      }
    }
  }

  /**
   * Politica dei permessi: si concede. Vedi l'intestazione — è una decisione
   * del piano, non una scorciatoia, ed è isolata qui per poterla cambiare in
   * un punto solo il giorno che serva.
   */
  private onPermissionRequest(params: Record<string, unknown>): Record<string, unknown> {
    const options = Array.isArray(params.options) ? params.options : [];
    const pick =
      findOption(options, "allow_always") ??
      findOption(options, "allow_once") ??
      (options[0] as Record<string, unknown> | undefined);
    const optionId = pick && typeof pick.optionId === "string" ? pick.optionId : null;
    if (!optionId) {
      // Nessuna opzione utilizzabile: dire «annullato» è l'unica risposta onesta.
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId } };
  }

  // ── Chat ─────────────────────────────────────────────────────────────────

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[] },
  ): Promise<{ runId?: string }> {
    let state: AcpSessionState | undefined;
    try {
      const peer = await this.ensureConnection();
      state = await this.ensureSession(peer, sessionKey);
      // Il modello si applica PRIMA del prompt: dopo sarebbe il turno
      // successivo, e chi ha scelto «questo task su haiku» avrebbe pagato
      // comunque il modello grosso su questo.
      await this.applyModel(peer, state, options?.model);
      await this.applyEffort(peer, state, sessionKey);
      state.handler = handler;
      state.fullText = "";
      state.aborting = undefined;
      state.promptInFlight = true;

      const stopReason = await withTimeout(
        peer.request<Record<string, unknown>>("session/prompt", {
          sessionId: state.acpSessionId,
          prompt: [{ type: "text", text: message }],
        }),
        PROMPT_TIMEOUT_MS,
        "ACP_PROMPT_TIMEOUT",
      );

      state.promptInFlight = false;
      const raw = stopReason?.stopReason;
      const end: TurnEndInfo = isAcpStopReason(raw)
        ? { end: raw, ...(raw === "cancelled" ? { cause: state.aborting ?? "user" } : {}) }
        : { end: "end_turn" };
      const done: ProviderDoneMessage = { result: state.fullText, turnEnd: end };
      if (end.end === "cancelled") handler.onAborted?.(done);
      else handler.onDone(done);
    } catch (err) {
      if (state) state.promptInFlight = false;
      const info = classifyTurnError(err, state?.aborting ?? "provider-error");
      if (info.end === "cancelled") {
        handler.onAborted?.({ result: state?.fullText ?? "", turnEnd: info });
      } else {
        handler.onError(info.detail || errText(err));
      }
    }
    return {};
  }

  async abort(sessionKey: string, _runId?: string, reason: "user" | "watchdog" = "user"): Promise<void> {
    const state = this.sessions.get(sessionKey);
    if (!state) return;
    state.aborting = reason;
    // Notifica, non richiesta: la conferma arriva come `stopReason: "cancelled"`
    // sulla `session/prompt` che è ancora in volo.
    this.peer?.notify("session/cancel", { sessionId: state.acpSessionId });
  }

  /**
   * Questa sessione è nostra?
   *
   * Serve a `resolveTurnAlive`: la domanda «il turno è vivo?» va fatta al
   * provider che quella sessione la sta servendo, e chiunque altro deve dire
   * «non lo so» invece di tirare a indovinare. Senza questo cancello un
   * provider ACP risponderebbe sulla salute del PROPRIO processo anche per una
   * sessione di claude-code — e viceversa, che è il bug da cui questa funzione
   * nasce.
   */
  ownsSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Il processo che serve questa sessione è vivo?
   *
   * Il `sessionKey` non si guarda ed è corretto così: in ACP le sessioni
   * vivono TUTTE dentro lo stesso figlio (è il senso del demone condiviso), e
   * la salute del figlio è la salute di tutte. A filtrare per proprietà ci
   * pensa `ownsSession`, che il chiamante interroga prima.
   */
  isTurnProcessAlive(_sessionKey: string): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * Completion senza streaming, su una sessione usa-e-getta. Serve alle cose di
   * servizio (titoli, digest): mandarle nella sessione della chat le farebbe
   * entrare nel contesto del turno vero.
   */
  async complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult> {
    const peer = await this.ensureConnection();
    const cwd = this.config.defaultWorkspace || process.env.HOME || "/tmp";
    const res = (await peer.request<Record<string, unknown>>("session/new", {
      cwd,
      mcpServers: [],
    })) ?? {};
    const sessionId = typeof res.sessionId === "string" ? res.sessionId : "";
    if (!sessionId) throw new Error("ACP_NO_SESSION_ID");
    this.absorbConfigOptions(res);

    const key = `__complete__:${sessionId}`;
    const state = this.registerSession(key, sessionId, cwd);
    // Vale anche qui, e qui il risparmio è il punto: titoli e digest sono il
    // lavoro che si vuole mandare sul modello PICCOLO. Ignorare la richiesta
    // significava pagarli sul modello di default dell'agente.
    await this.applyModel(peer, state, options?.model);
    let text = "";
    state.handler = {
      onTextDelta: (chunk) => { text += chunk; },
      onToolStart: () => {},
      onToolResult: () => {},
      onDone: () => {},
      onError: () => {},
    };
    try {
      await withTimeout(
        peer.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: flattenMessages(messages) }],
        }),
        PROMPT_TIMEOUT_MS,
        "ACP_PROMPT_TIMEOUT",
      );
    } finally {
      this.sessions.delete(key);
      this.bySessionId.delete(sessionId);
    }
    return { content: text };
  }

  // ── Diagnostica ──────────────────────────────────────────────────────────

  async diagnose(): Promise<ProviderDiagnostic> {
    const bin = this.resolveBinary();
    const probe = bin ? await probeBinaryPath(bin) : { available: false, path: undefined, version: undefined };
    const requirements: ProviderRequirement[] = [
      {
        key: `${this.name}-binary`,
        label: `Eseguibile "${this.config.command}" disponibile`,
        present: probe.available || !!bin,
        hint: bin ? undefined : `Installa "${this.config.command}" o dichiaralo in ACP_AGENTS`,
      },
      {
        key: `${this.name}-handshake`,
        label: "Handshake ACP completato",
        present: !!this.peer && !this.peer.isClosed,
        hint: this.peer ? undefined : "Si negozia al primo messaggio",
      },
      {
        key: `${this.name}-protocol`,
        label: `Protocollo ACP v${ACP_PROTOCOL_VERSION}`,
        present: !this.versionMismatch,
        hint: this.versionMismatch
          ? `L'agente parla ACP v${this.versionMismatch.agentVersion}: aggiorna Topics o installa una versione dell'agente che parli v${ACP_PROTOCOL_VERSION}`
          : undefined,
      },
    ];
    return {
      name: this.name,
      // L'handshake avviene al primo turno: non averlo ancora fatto non è un
      // guasto. Conta solo l'eseguibile — e la versione, quando l'agente ne ha
      // già dichiarata una che non sappiamo parlare: lì l'eseguibile c'è ed è
      // proprio il motivo per cui non serve a niente.
      status: this.versionMismatch ? "unavailable" : bin ? "ready" : "unavailable",
      binaryPath: probe.path ?? bin ?? undefined,
      version: probe.version,
      requirements,
      lastError: this.versionMismatch?.reason,
    };
  }

  /**
   * I modelli che l'agente dice di avere.
   *
   * ACP v1 non ha un metodo per elencarli, ed era il motivo per cui qui si
   * tornava una lista vuota: meglio niente che una lista inventata. Ma non
   * inventarli non vuol dire non SAPERLI — `session/new` risponde con i suoi
   * `configOptions`, e lì dentro c'è l'opzione `model` con l'elenco completo
   * (jcode ne annuncia 105). Quella lista arriva dall'agente, non da noi.
   *
   * Resta vuota finché non si è aperta almeno una sessione: senza aver mai
   * parlato con l'agente non abbiamo niente di suo da riportare, e riempirla di
   * ipotesi sarebbe di nuovo inventare. Il selettore la ripesca al giro dopo —
   * lo snapshot dei provider si ricalcola.
   */
  async listModels(): Promise<string[]> {
    return [...this.knownModels];
  }

  /**
   * Su quale modello gira davvero questo agente, se l'ha detto.
   *
   * Non è cosmetica: il badge del contesto e il conto dei token partono da qui
   * (`routes/context.ts`, `routes/chat.ts`), e senza una risposta la UI tira a
   * indovinare — mostra il primo della lista, che è un modello qualunque. Su
   * jcode il primo della lista e quello attivo sono cose diverse, quindi la
   * finestra dichiarata sarebbe quella di un altro modello.
   *
   * `null` finché l'agente non l'ha detto: è la risposta onesta, e chi la
   * riceve sa già come trattarla.
   */
  defaultModel(): string | null {
    return this.activeModel;
  }
}

// ============ Helper ============

function findOption(options: unknown[], kind: string): Record<string, unknown> | undefined {
  return options.find(
    (o): o is Record<string, unknown> =>
      !!o && typeof o === "object" && (o as Record<string, unknown>).kind === kind,
  );
}

function flattenMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => (m.role === "user" ? m.content : `[${m.role}] ${m.content}`))
    .join("\n\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number, marker: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(marker)), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "errore sconosciuto");
}

/**
 * L'effort di ragionamento scelto per il topic di questa sessione, se c'è.
 *
 * Lettura stretta sulla riga, come fa `claude-code` per gli stessi override
 * (migrazione 033): passare da `getTopicBySessionKey` creerebbe un import
 * circolare con utils.ts. Best-effort per costruzione — senza board, senza
 * riga o con la tabella assente la risposta è `null`, cioè «l'agente tenga il
 * suo», e un turno non deve mai morire per una preferenza.
 */
function readTopicEffort(sessionKey: string): string | null {
  try {
    const row = getDatabase()
      .prepare("SELECT effort FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { effort?: string | null } | undefined;
    const raw = (row?.effort ?? "").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

/**
 * L'agente ha detto «questo metodo non ce l'ho» (JSON-RPC -32601)?
 *
 * Si guarda il CODICE e non il testo: il messaggio lo scrive l'agente e cambia
 * da implementazione a implementazione, mentre -32601 è nello standard. Serve a
 * distinguere «non so fare questa cosa» (proprietà permanente dell'agente, si
 * smette di chiedere) da «questa volta è andata male» (si riproverà).
 */
function isMethodNotFound(err: unknown): boolean {
  return err instanceof JsonRpcRemoteError && err.code === RPC_METHOD_NOT_FOUND;
}
