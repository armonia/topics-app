/**
 * Il provider nativo: Topics che parla col modello senza intermediari.
 *
 * COSA CAMBIA RISPETTO AGLI ALTRI. `claude-code`, `codex` e gli agenti ACP sono
 * tutti la stessa forma — un processo esterno da spawnare, un protocollo da
 * parlarci, uno stato da tenere allineato. `claude-code.ts` sono 3640 righe
 * quasi tutte dedicate a quel mestiere: pool di processi, riattacchi, broker,
 * heartbeat, scansione dello store. Qui non c'è niente di tutto ciò, perché non
 * c'è nessun processo: una sessione è un array di messaggi, e il turno è una
 * chiamata HTTP che noi guidiamo.
 *
 * DICHIARA `history`, ed è la differenza che conta nel registro. I provider CLI
 * tengono la conversazione per conto loro e ignorano `options.history`; questo è
 * STATELESS verso l'esterno come lo sono `claude` e `openai` — ogni turno
 * rimanda la storia. La tiene in memoria per sessione, così le chat continuano
 * senza rileggere il DB a ogni giro, ma se la memoria si perde (riavvio) la
 * storia arriva comunque dal chiamante.
 *
 * COSA NON FA, detto qui invece di lasciarlo scoprire. Non sopravvive al
 * riavvio del server: un turno in volo muore col processo che lo ospita, mentre
 * `claude-code` in modalità broker lo ritrova. È il prezzo dell'essere
 * in-process, ed è pagato consapevolmente — il riattacco vale la pena solo
 * quando il turno costa un processo intero, e qui costa un array.
 */

import { runAgentTurn, type Message } from "./agent-loop";
import { CODING_TOOLS } from "./tools";
import { hasCredentials, getAccessToken, readCredentials } from "./auth";
import { getTopicWorkspaceForSession } from "../claude-code";
import type {
  AIProvider,
  ChatMessage,
  CompletionResult,
  ProviderCapability,
  ProviderContextStrategy,
  ProviderDiagnostic,
  StreamHandler,
} from "../types";
import { recordTurnEnd } from "../turn-end-registry";

/** Il modello di partenza quando nessuno ne chiede uno. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Cosa si dice all'agente quando la topic non ha un progetto.
 *
 * Serve perché senza tool il modello non sa PERCHÉ non li ha: proverebbe a
 * descrivere comandi da eseguire a mano, o peggio affermerebbe di aver fatto
 * cose. Dirglielo lo rende utile lo stesso — risponde, spiega, ma non finge.
 */
const NO_WORKSPACE_NOTE =
  "Questa conversazione non ha un progetto collegato, quindi non hai strumenti per leggere o " +
  "modificare file. Rispondi a voce; se serve lavorare su un progetto, di' all'utente di " +
  "collegarne uno alla conversazione.";

/**
 * I modelli che questo runtime sa usare.
 *
 * Lista dichiarata e non scoperta: l'API non espone un catalogo sull'endpoint
 * OAuth, e inventarne uno interrogando `/v1/models` con credenziali da
 * abbonamento darebbe una lista che non corrisponde a ciò che l'abbonamento
 * copre. Meglio pochi nomi veri che un elenco lungo e sbagliato.
 */
const MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

interface NativeSession {
  history: Message[];
  /** `null` = questa topic non ha un progetto: niente tool di file. */
  workspace: string | null;
  abort?: AbortController;
  model?: string;
}

export interface NativeProviderConfig {
  type: "native";
  /** Radice usata quando una sessione non ha un progetto suo. */
  defaultWorkspace?: string;
  model?: string;
}

export class NativeProvider implements AIProvider {
  readonly name = "topics";
  readonly capabilities = new Set<ProviderCapability>([
    "streaming",
    "tools",
    "thinking",
    "sessions",
    "abort",
    // Stateless verso l'esterno: vedi l'intestazione.
    "history",
  ]);
  /**
   * La storia la teniamo NOI, quindi i blocchi di sistema vanno inlinati nel
   * turno come per le CLI: `inline-system` è la strategia giusta.
   */
  readonly contextStrategy: ProviderContextStrategy = "inline-system";

  private readonly config: NativeProviderConfig;
  private sessions = new Map<string, NativeSession>();
  private stopped = false;

  constructor(config: NativeProviderConfig) {
    this.config = config;
  }

  /**
   * «Possiamo servire una chat?» — cioè: c'è una credenziale su questa
   * macchina. Non si verifica che sia VALIDA: richiederebbe una chiamata di
   * rete a ogni domanda (il registro la fa spesso), e un token scaduto si
   * rinnova da solo al primo turno. Un file assente invece è definitivo.
   */
  get connected(): boolean {
    return !this.stopped && hasCredentials();
  }

  start(): void { this.stopped = false; }

  stop(): void {
    this.stopped = true;
    for (const s of this.sessions.values()) {
      try { s.abort?.abort(); } catch { /* già finito */ }
    }
    this.sessions.clear();
  }

  /** Vedi `resolveTurnAlive`: si parla solo per le proprie sessioni. */
  ownsSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Un turno in volo su questa sessione?
   *
   * Qui «vivo» non è un processo ma una richiesta HTTP aperta: l'AbortController
   * esiste per la durata del turno e sparisce alla fine. È la risposta onesta
   * alla domanda che il dispatcher fa davvero — «sta ancora lavorando?».
   */
  isTurnProcessAlive(sessionKey: string): boolean {
    return Boolean(this.sessions.get(sessionKey)?.abort);
  }

  private sessionFor(sessionKey: string): NativeSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;
    // La radice: il progetto della topic, poi quella dichiarata a config.
    //
    // `process.cwd()` NON è nella catena, ed è una scelta pagata: era il
    // ripiego ovvio, e il ripiego ovvio è la directory da cui è partito il
    // server — cioè il codice di Topics stesso. Un agente aperto su una topic
    // senza progetto si ritrovava a lavorare NEL REPO DELL'APPLICAZIONE
    // credendo di essere altrove: ha cercato il file che gli avevo chiesto con
    // un `find /` (osservato il 2026-08-16), e la volta che lo trova lo
    // modifica pure. Meglio un turno che fallisce con un motivo leggibile.
    const workspace =
      getTopicWorkspaceForSession(sessionKey)
      || this.config.defaultWorkspace
      || null;
    const fresh: NativeSession = { history: [], workspace };
    this.sessions.set(sessionKey, fresh);
    return fresh;
  }

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[]; systemPrompt?: string },
  ): Promise<{ runId?: string }> {
    const session = this.sessionFor(sessionKey);

    // La storia del CHIAMANTE vince su quella in memoria: è lui che sa cosa è
    // successo davvero (riavvii, rami, modifiche). La nostra è una comodità,
    // non la verità.
    if (options?.history && options.history.length > 0) {
      session.history = options.history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
      }));
    }
    session.history.push({ role: "user", content: message });

    const abort = new AbortController();
    session.abort = abort;
    if (options?.model) session.model = options.model;

    try {
      // Senza una radice i tool di file non si offrono nemmeno: un agente che
      // riceve `read_file` e non ha una workspace prova a indovinare dove sia
      // il progetto, e indovinare significa toccare file a caso. Resta una
      // chat, che è la cosa onesta da essere.
      const workspace = session.workspace;
      const out = await runAgentTurn(
        {
          model: session.model ?? this.config.model ?? DEFAULT_MODEL,
          system: workspace
            ? options?.systemPrompt
            : [options?.systemPrompt, NO_WORKSPACE_NOTE].filter(Boolean).join("\n\n"),
          history: session.history,
          tools: workspace ? CODING_TOOLS : [],
          toolContext: { workspace: workspace ?? "" },
          signal: abort.signal,
        },
        handler,
      );
      // Il perché della fine si deposita dove il resto del server lo cerca:
      // è lo stesso registro che usano le CLI, e senza questo un turno
      // dispacciato non saprebbe dire com'è finito.
      recordTurnEnd(sessionKey, out.turnEnd);
      return {};
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Un abort chiesto da noi non è un guasto: è la risposta a uno stop.
      if (abort.signal.aborted) {
        recordTurnEnd(sessionKey, { end: "cancelled", cause: "user" });
        handler.onAborted?.({ result: "" });
        return {};
      }
      handler.onError(detail);
      recordTurnEnd(sessionKey, { end: "error", cause: "provider-error", detail });
      return {};
    } finally {
      session.abort = undefined;
    }
  }

  async abort(sessionKey: string, _runId?: string, reason: "user" | "watchdog" = "user"): Promise<void> {
    const s = this.sessions.get(sessionKey);
    if (!s?.abort) return;
    void reason;
    s.abort.abort();
  }

  /**
   * Completion senza tool e fuori dalla sessione: titoli, digest, le cose di
   * servizio. Una storia usa-e-getta, così non entra nel contesto del turno
   * vero — stesso patto degli altri provider.
   */
  async complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult> {
    const history: Message[] = messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));
    let text = "";
    const out = await runAgentTurn(
      {
        model: options?.model ?? this.config.model ?? DEFAULT_MODEL,
        history,
        tools: [],
        toolContext: { workspace: this.config.defaultWorkspace ?? "" },
      },
      {
        onTextDelta: (c) => { text += c; },
        onToolStart: () => {},
        onToolResult: () => {},
        onDone: () => {},
        onError: () => {},
      },
    );
    return { content: out.text || text };
  }

  async resetSession(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }

  async listModels(): Promise<string[]> {
    return [...MODELS];
  }

  defaultModel(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }

  async diagnose(): Promise<ProviderDiagnostic> {
    const creds = readCredentials();
    const requirements = [
      {
        key: "claude-oauth",
        label: "Credenziali Claude",
        present: Boolean(creds),
        hint: creds
          ? undefined
          : "Nessun login trovato. Esegui `claude` e fai /login una volta: il runtime legge quel file.",
      },
    ];
    if (!creds) {
      return { name: this.name, status: "unavailable", requirements, lastError: "nessuna credenziale" };
    }
    // Qui la validità si verifica DAVVERO, al contrario di `connected`: la
    // diagnostica la chiede una persona che vuole sapere se funziona, e vale
    // la chiamata di rete.
    try {
      const tok = await getAccessToken();
      return {
        name: this.name,
        status: tok ? "ready" : "unavailable",
        requirements,
        lastError: tok ? undefined : "token non rinnovabile: rifai /login con la CLI",
      };
    } catch (err) {
      return {
        name: this.name,
        status: "unavailable",
        requirements,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
