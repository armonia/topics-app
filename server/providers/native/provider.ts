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

import { runAgentTurn, type AgentMessage } from "./agent-loop";
import { recordTurnUsage } from "../native-usage-registry";
import { CODING_TOOLS } from "./tools";
import { pruneDanglingToolUses } from "./history-repair";
import { rehydrateHistory } from "./history-rehydrate";
import { levelFor } from "./permissions";
import { topicsToolSpecs, type TopicsToolContext } from "./topics-tools";
import { hasCredentials, getAccessToken, readCredentials } from "./auth";
import { getTopicWorkspaceForSession, topicsAppBaseUrl } from "../claude-code";
import type {
  AbortReason,
  AIProvider,
  ChatMessage,
  CompletionResult,
  ProviderCapability,
  ProviderContextStrategy,
  ProviderDiagnostic,
  StreamHandler,
} from "../types";
import { recordTurnEnd } from "../turn-end-registry";
import { cancelled, type StopCause } from "../stop-reason";

/**
 * Il modello di partenza quando nessuno ne chiede uno.
 *
 * Stesso gradino di prima (sonnet, non opus: è il default, non la scelta), ma
 * della generazione corrente. Era fermo a `claude-sonnet-4-6`, e siccome la
 * guardia in `routes/chat.ts` scartava ogni override alla famiglia 5, questo
 * valore non era il default: era il modello di TUTTI.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * DA QUANTO FERMA UNA SESSIONE PUÒ ESSERE SFRATTATA DALLA MEMORIA.
 *
 * `sessions` non veniva svuotata mai: solo `resetSession` e `stop()` toglievano
 * qualcosa, quindi OGNI topic che aveva avuto un turno teneva la sua
 * conversazione intera nel processo finché il server non ripartiva. Con 127
 * topic nati in un giorno sul runtime nativo è crescita senza fondo.
 *
 * LA PROVA È IL CODICE, NON UNA LETTURA DI RSS — e vale la pena dirlo perché la
 * prima stesura di questo commento affermava il contrario. Su una finestra di 40
 * secondi il server sembrava tenere 2.220 MB senza scendere quando un agente
 * finiva; su una finestra di dieci minuti lo stesso processo oscilla fra 284 MB
 * e 2 GB seguendo il carico, e quel 2.220 era un picco, non un trattenimento.
 * Due campioni non sono una tendenza. Ciò che regge è la lettura del codice:
 * non esisteva NESSUNA strada che togliesse una sessione ferma, quindi la
 * crescita è senza fondo per costruzione, che il picco di ieri fosse quello o un
 * altro.
 *
 * Sfrattare è sicuro PER COSTRUZIONE, e non è un compromesso:
 *
 *  · `sessionFor` ricostruisce la storia dal DB (`rehydrateHistory`) quando la
 *    sessione non c'è. È la stessa strada che si percorre a ogni riavvio del
 *    server, cioè decine di volte al giorno su questa macchina.
 *  · il modello arriva con OGNI turno (`routes/chat.ts` mette `sendOptions.model`
 *    dall'override della topic), quindi non si perde.
 *  · la radice si ri-deriva da `getTopicWorkspaceForSession`.
 *  · `ownsSession` dirà «non è mia», e `resolveTurnAlive` risponde `null` invece
 *    di `false`: «non lo so» al posto di «è morto», che è la risposta più
 *    prudente delle due (vedi il commento di `resolveTurnAlive`).
 *
 * Una sessione con un TURNO VIVO non si sfratta mai: la guardia è l'`abort`,
 * che esiste per la durata del turno e sparisce alla fine.
 */
const SESSION_TTL_MS = Math.max(1, Number(process.env.TOPICS_NATIVE_SESSION_TTL_MIN) || 15) * 60_000;
/** Ogni quanto si passa a guardare. Non serve precisione: serve che accada. */
const SESSION_SWEEP_MS = 60_000;

/**
 * Questa sessione si può togliere dalla memoria?
 *
 * Pura e esportata apposta: la regola dello sfratto è la cosa che deve essere
 * MISURATA, non il timer che la chiama. Due condizioni, ed entrambe contano —
 * un turno vivo non si tocca mai, e «ferma» vuol dire ferma da più del tetto.
 */
export function sessionIsEvictable(
  s: { abort?: unknown; lastUsedAt: number },
  now: number,
  ttlMs: number = SESSION_TTL_MS,
): boolean {
  if (s.abort) return false;
  return now - s.lastUsedAt > ttlMs;
}



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
 *
 * ── Perché la famiglia 5 è arrivata in ritardo, e cosa è costata ──────────
 * Questa lista non è cosmetica: `routes/chat.ts` la usa come GUARDIA. Un
 * modello richiesto che non compare qui viene scartato con
 * `Dropping stale model override`, e la sessione cade su {@link DEFAULT_MODEL}.
 *
 * Finché la lista si è fermata alla generazione 4-6, ogni card della board che
 * chiedeva `claude-opus-5[1m]` — cioè tutte — è girata in silenzio su
 * `claude-sonnet-4-6`. Il picker diceva Opus 5, la barra sotto al composer
 * diceva Opus 5, e il turno era Sonnet. Il 18/08 quella riga di scarto compare
 * a raffica nel log, e `agent-loop.ts` sapeva già eseguire il suffisso `[1m]`
 * (vedi `long-window.ts`, atterrato il 17/08): mancava solo il permesso.
 *
 * Gli id qui sotto sono PROVATI, non dedotti: una richiesta da 1 token per id
 * sull'endpoint OAuth con gli stessi header del loop, tutti 200 (19/08/2026).
 * Se un domani se ne aggiunge uno, si prova allo stesso modo prima di scriverlo.
 */
const MODELS = [
  "claude-opus-5[1m]",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

interface NativeSession {
  history: AgentMessage[];
  /** `null` = questa topic non ha un progetto: niente tool di file. */
  workspace: string | null;
  abort?: AbortController;
  /**
   * PERCHÉ è stato annullato questo turno — scritto da chi ha chiamato
   * `abort()`, letto da chi raccoglie i cocci in `sendChat`.
   *
   * `AbortController` porta il SEGNALE e non la ragione: quando `sendChat`
   * scopre `abort.signal.aborted` sa solo CHE qualcuno ha annullato, e prima
   * di questo campo tirava a indovinare — scriveva sempre `cause: "user"`. Su
   * uno spegnimento del server quell'indovinello era falso, e la falsità
   * costava il cartello: `finalizeStream` su `cancelled/user` tace, perché chi
   * ha premuto stop non ha bisogno che gli si spieghi cos'ha premuto.
   */
  abortCause?: StopCause;
  model?: string;
  /** Quando questa sessione è stata toccata l'ultima volta. Serve allo sfratto. */
  lastUsedAt: number;
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

  /** Il passaggio periodico dello sfratto. `unref` così non tiene su il processo. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.stopped = false;
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try { this.sweepIdleSessions(); } catch { /* meglio non sfrattare che rompere un turno */ }
    }, SESSION_SWEEP_MS);
    // Un timer che tiene vivo il processo trasformerebbe uno spegnimento pulito
    // in un'attesa di un minuto.
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    for (const s of this.sessions.values()) {
      // LA RAGIONE VIAGGIA CON L'ANNULLAMENTO, anche qui.
      //
      // Un turno nativo vive DENTRO questo processo: quando il server si
      // spegne non resta nessun figlio nel broker da riadottare, quindi
      // questo `abort()` è la fine definitiva di quel turno, non una pausa.
      // Senza la causa, `sendChat` scriveva `cancelled/user` e a valle tutto
      // — registro della fine, `activity_log`, il cartello in chat — dava la
      // colpa a un utente che non aveva toccato niente. Misurato il 20/08 su
      // topic:9f9e9629: risposta troncata a metà frase, zero spiegazioni.
      s.abortCause = "server-shutdown";
      try { s.abort?.abort(); } catch { /* già finito */ }
    }
    this.sessions.clear();
  }

  /**
   * Il contesto per i mestieri di Topics, o `null` se questa sessione non ne
   * ha diritto.
   *
   * Il PROFILO segue la stessa regola delle CLI (`writeMcpConfigForSession`):
   * un agente dispacciato con `mcp_policy = 'bridge-only'` prende il set
   * ridotto, perche' gli schemi dei tool viaggiano nel contesto di OGNI
   * chiamata e per un agente che lavora un task solo sono una tassa in token.
   * Regola duplicata? No: la stessa domanda, la stessa risposta, presa dalla
   * stessa colonna. Riscriverla diversamente sarebbe il modo di farle divergere.
   */
  private topicsContext(sessionKey: string): TopicsToolContext | null {
    try {
      const { getDatabase } = require("../../db");
      const row = getDatabase()
        .prepare("SELECT mcp_policy FROM topics WHERE session_key = ? LIMIT 1")
        .get(sessionKey) as { mcp_policy?: string | null } | undefined;
      // Nessuna riga = nessuna topic: e' il caso di `complete` e dei test, dove
      // i mestieri di Topics non c'entrano niente.
      if (!row) return null;
      return {
        baseUrl: topicsAppBaseUrl(),
        sessionKey,
        gatewayToken: process.env.GATEWAY_TOKEN,
        profile: row.mcp_policy === "bridge-only" ? "dispatch" : undefined,
      };
    } catch {
      // Senza database si resta un agente che sa programmare e basta: meglio
      // meno strumenti che un turno che non parte.
      return null;
    }
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

  /**
   * Toglie dalla memoria le sessioni ferme da più di {@link SESSION_TTL_MS}.
   * Mai quelle con un turno in volo. Vedi il commento della costante per il
   * perché è sicuro.
   */
  private sweepIdleSessions(): number {
    const ora = Date.now();
    let tolte = 0;
    for (const [k, s] of this.sessions) {
      if (!sessionIsEvictable(s, ora)) continue;
      this.sessions.delete(k);
      tolte++;
    }
    return tolte;
  }

  private sessionFor(sessionKey: string): NativeSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) { existing.lastUsedAt = Date.now(); return existing; }
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
    // UNA SESSIONE FRESCA NON È UNA CONVERSAZIONE NUOVA.
    //
    // Questa Map muore col processo, e su una macchina con
    // `TOPICS_SERVER_WATCH=1` il processo si riavvia a ogni salvataggio in
    // `server/`. Partire da `history: []` significava che, dopo un riavvio, la
    // stessa chat ricominciava da zero senza dirlo a nessuno: il 2026-08-18 su
    // topic:9fe7a291 l'utente ha chiesto «fammi un report di fine giornata» in
    // una conversazione che conteneva un'analisi da 2.396 caratteri e si è
    // sentito rispondere «Non ho trovato messaggi nel topic "New Chat"». Non era
    // un modello che sbaglia: era un modello a cui non era stato dato niente.
    //
    // La rotta non ce la manda, la storia, e ha ragione lei: `contextStrategy`
    // qui è `inline-system`, cioè «me la ricordo io». Quella promessa vale
    // finché il processo vive; oltre, l'unico posto dove la conversazione è
    // sopravvissuta è il DB. Si va a prenderla lì — una volta sola, quando la
    // sessione nasce, non a ogni turno.
    const fresh: NativeSession = { history: rehydrateHistory(sessionKey), workspace, lastUsedAt: Date.now() };
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
    // Se in coda c'è già un `user`, il messaggio nuovo ci si FONDE invece di
    // accodarsi. Succede solo in un caso, ed è quello che conta: la storia
    // ricostruita dal DB può finire con una domanda rimasta senza risposta
    // (turno morto a metà, riavvio), e `historyFromPersistedThread` la lascia lì
    // apposta — buttarla via sarebbe perdere proprio ciò che l'utente non ha mai
    // ottenuto. In esercizio normale l'ultimo turno è sempre dell'assistente,
    // quindi questo ramo non scatta. Fondere tiene anche l'alternanza dei ruoli.
    const tail = session.history[session.history.length - 1];
    if (tail && tail.role === "user" && typeof tail.content === "string") {
      tail.content = `${tail.content}\n\n${message}`;
    } else {
      session.history.push({ role: "user", content: message });
    }
    // ── LA STORIA SI RIPARA PRIMA DI PARTIRE, NON SI SPERA CHE SIA SANA ──────
    //
    // Un turno morto a meta' (processo riavviato, rete caduta, stop) lascia in
    // memoria un `assistant` che chiede dei tool e nessuno che risponde. Quella
    // storia veniva rimandata IDENTICA al turno dopo, e l'API la rifiuta
    // sempre: «`tool_use` ids were found without `tool_result` blocks
    // immediately after». Nessun ritentativo la sblocca, quindi il dispatcher
    // bruciava i suoi due tentativi contro lo stesso muro e consegnava
    // all'umano una card senza niente sotto.
    //
    // Misurato il 17/08 sul db vivo: 20 turni cosi', 2 sessioni, dalle 16:57
    // alle 20:15. Una e' `5cf58e29`, arrivata in review vuota.
    //
    // Qui e non in `agent-loop`: il loop e' gia' corretto quando arriva in
    // fondo: e' la SOPRAVVIVENZA della storia fra un turno e l'altro il punto
    // in cui si rompe, e questo e' l'unico posto che entrambe le sorgenti (la
    // memoria e la storia del chiamante) attraversano. Vedi `history-repair.ts`
    // per perche' si pota invece di inventare risultati finti.
    session.history = pruneDanglingToolUses(session.history);

    const abort = new AbortController();
    session.abort = abort;
    if (options?.model) session.model = options.model;

    try {
      // Senza una radice i tool di file non si offrono nemmeno: un agente che
      // riceve `read_file` e non ha una workspace prova a indovinare dove sia
      // il progetto, e indovinare significa toccare file a caso. Resta una
      // chat, che è la cosa onesta da essere.
      const workspace = session.workspace;
      // I due elenchi si UNISCONO: un agente che sa programmare ma non sa
      // muovere la card che sta lavorando e' meta' agente, ed e' esattamente
      // com'era prima di questa riga.
      const topics = this.topicsContext(sessionKey);
      const tools = [
        ...(workspace ? CODING_TOOLS : []),
        ...(topics ? topicsToolSpecs(topics.profile) : []),
      ];
      const out = await runAgentTurn(
        {
          model: session.model ?? this.config.model ?? DEFAULT_MODEL,
          system: workspace
            ? options?.systemPrompt
            : [options?.systemPrompt, NO_WORKSPACE_NOTE].filter(Boolean).join("\n\n"),
          history: session.history,
          tools,
          toolContext: { workspace: workspace ?? "" },
          topics: topics ?? undefined,
          // Il livello di autonomia si RILEGGE a ogni turno, non si memorizza
          // sulla sessione: chi lo cambia in chat si aspetta che valga dal
          // messaggio dopo, non dalla prossima chat.
          autonomy: levelFor(readTopicAutonomy(sessionKey)),
          signal: abort.signal,
          // La ragione si chiede QUANDO serve, non quando si parte: al momento
          // dell'invio nessuno ha ancora annullato niente.
          abortCause: () => session.abortCause,
          // L'USO SI DEPOSITA A OGNI GIRO, non a fine turno.
          //
          // Il registro è quello che il dispatcher rilegge ogni quattro secondi
          // per il chip vivo della card. Depositando solo il totale finale, quel
          // chip restava fermo per l'intero turno — che su un agente dispacciato
          // sono decine di minuti — e al primo turno mostrava zero token: i token
          // «non scorrevano più». Un giro alla volta il numero cresce mentre il
          // lavoro succede, ed è anche l'unico modo di contare un turno che
          // finisce annullato o in errore, dove il totale non torna a nessuno.
          onRoundUsage: (u) => recordTurnUsage(sessionKey, u),
        },
        handler,
      );
      // Il perché della fine si deposita dove il resto del server lo cerca:
      // è lo stesso registro che usano le CLI, e senza questo un turno
      // dispacciato non saprebbe dire com'è finito.
      recordTurnEnd(sessionKey, out.turnEnd);
      // L'uso NON si deposita qui: ci ha già pensato `onRoundUsage`, giro per
      // giro. Sommare anche `out.usage` — che di quei giri è la somma —
      // conterebbe ogni token due volte.
      return {};
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Un abort chiesto da noi non è un guasto: è la risposta a uno stop.
      // CHI l'ha chiesto lo dice `abortCause`, scritto da `abort()`/`stop()`.
      // Prima qui c'era `cause: "user"` fisso, e su uno spegnimento del server
      // era una bugia che si portava via il cartello in chat.
      if (abort.signal.aborted) {
        const end = cancelled(session.abortCause ?? "user");
        recordTurnEnd(sessionKey, end);
        handler.onAborted?.({ result: "", turnEnd: end });
        return {};
      }
      handler.onError(detail);
      recordTurnEnd(sessionKey, { end: "error", cause: "provider-error", detail });
      return {};
    } finally {
      session.abort = undefined;
      session.abortCause = undefined;
    }
  }

  async abort(sessionKey: string, _runId?: string, reason: AbortReason = "user"): Promise<void> {
    const s = this.sessions.get(sessionKey);
    if (!s?.abort) return;
    // La ragione si DEPOSITA prima di annullare: chi raccoglie i cocci
    // (`sendChat`, nel suo catch) legge da qui. Farlo dopo sarebbe una corsa
    // con il proprio `catch`, che è sincrono rispetto all'`abort()`.
    // Nessuna traduzione: `AbortReason` è per costruzione un sottoinsieme di
    // `StopCause`, ed è per questo che è definito come tale — due vocabolari
    // per la stessa cosa avrebbero avuto bisogno di una tabella, e una tabella
    // è un posto in cui divergere.
    s.abortCause = reason;
    s.abort.abort();
  }

  /**
   * Completion senza tool e fuori dalla sessione: titoli, digest, le cose di
   * servizio. Una storia usa-e-getta, così non entra nel contesto del turno
   * vero — stesso patto degli altri provider.
   */
  async complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult> {
    const history: AgentMessage[] = messages.map((m) => ({
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

/**
 * Il livello di autonomia scritto sul topic di questa sessione.
 *
 * Lettura stretta sulla riga, come fa `claude-code` per gli stessi override:
 * passare da `getTopicBySessionKey` creerebbe un import circolare con utils.ts.
 *
 * Un errore qui NON deve alzare i permessi: si torna `null`, che `levelFor`
 * traduce nel default (`auto-apply`). Il verso giusto in cui sbagliare è verso
 * il basso — una tabella assente non può diventare un lasciapassare.
 */
function readTopicAutonomy(sessionKey: string): string | null {
  try {
    const { getDatabase } = require("../../db");
    const row = getDatabase()
      .prepare("SELECT autonomy_level FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { autonomy_level?: string | null } | undefined;
    return row?.autonomy_level ?? null;
  } catch {
    return null;
  }
}
