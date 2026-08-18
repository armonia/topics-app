// AI Bridge client — the ONE server-side socket to the detached ai-bridge
// daemon (server/ai-bridge.mjs). Modeled on the terminal PTY-bridge client
// (server/routes/terminal.ts): a singleton connection, spawn-the-daemon-if-
// absent, reconnect-on-close, ping/pong watchdog. The daemon owns the `claude`
// children, so this client can disconnect (server restart) and a fresh client
// reconnects and re-attaches to the still-running turns.
//
// Purpose-built API (spawn/attach/write/signal/kill + per-session frame
// routing) rather than a literal port — the AI protocol is stream-json over
// offset-addressed `data` frames, not terminal bytes.
import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { augmentPath } from "../utils/path-env";
import { resolveStateDir } from "./data-dir";
import { registerFleetSocket } from "./fleet-usage";

export interface SpawnOpts {
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface SessionHandlers {
  /** A stdout NDJSON chunk arrived at byte `offset` in the durable store. */
  onData: (chunk: Buffer, offset: number) => void;
  /** A stderr chunk (rate-limit / missing-session detection lives in the provider). */
  onStderr?: (chunk: Buffer) => void;
  /** The child exited (crash/normal). `exitCode` null = signal/error. */
  onExit?: (exitCode: number | null) => void;
}
export interface AttachResult {
  endOffset: number;
  alive: boolean;
  exitCode: number | null;
  /** True when the daemon had no session for this id (nothing to re-attach). */
  missing?: boolean;
}
export interface SessionInfo {
  id: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  endOffset: number;
  createdAt: number;
}

/**
 * Quanto si aspetta un ack, per tipo di richiesta.
 *
 * Erano 5 secondi per tutti, ed era la cifra sbagliata due volte. Un `list` è un
 * giro di andata e ritorno dentro il daemon: se non risponde in 5s è rotto.
 * Uno `spawn` deve forkare un processo `claude` — sotto carico (dieci pane vive,
 * un `bun test` in corso) 5 secondi si superano senza che niente sia guasto, e
 * il turno moriva con «ack timeout» a schermo. Ora ogni richiesta ha il suo
 * tempo, e — cosa che conta di più — un socket caduto NON aspetta più il
 * timeout: fallisce subito e si riprova (vedi `request`).
 */
// Env overrides for tests — production never sets these.
// TOPICS_AI_BRIDGE_ACK_MS, TOPICS_AI_BRIDGE_WATCHDOG_MS, TOPICS_AI_BRIDGE_PONG_MS,
// TOPICS_AI_BRIDGE_STALL_TICK_MS let a test shrink the wait windows without
// sitting through the real production timers.
const ACK_TIMEOUT_MS = Number(process.env.TOPICS_AI_BRIDGE_ACK_MS) || 5_000;
const SPAWN_ACK_TIMEOUT_MS = Number(process.env.TOPICS_AI_BRIDGE_SPAWN_ACK_MS) || 20_000;
const ATTACH_ACK_TIMEOUT_MS = Number(process.env.TOPICS_AI_BRIDGE_ATTACH_ACK_MS) || 15_000;
const WATCHDOG_EVERY_MS = Number(process.env.TOPICS_AI_BRIDGE_WATCHDOG_MS) || 15_000;
const PONG_TIMEOUT_MS = Number(process.env.TOPICS_AI_BRIDGE_PONG_MS) || 45_000;

/**
 * I tempi qui sopra sono deadline sul SILENZIO, non sul totale.
 *
 * Misurato (`scripts/ai-bridge-replay-bench.ts`): sei sessioni con store da
 * 7 MB che riattaccano insieme mettono in coda ~44 MB su UN socket, e le
 * risposte escono a scaletta — 0,2s, 2,0s, 3,4s, 4,4s, 4,9s, 5,2s. Il daemon
 * risponde a un ping in 4 ms per tutto il tempo (sonda fuori processo) e
 * l'event loop del server non si ferma mai oltre i 7 ms: nessuno dei due è
 * bloccato. Ciò che scade è l'attesa di chi sta DIETRO ai megabyte degli
 * altri sullo stesso tubo. Un `list` da 5s scade così, e a venti sessioni ci
 * finisce anche il `pong` — con l'effetto peggiore di tutti, perché il
 * watchdog lo legge come «daemon morto», ricicla il socket, e il riciclo
 * stacca ogni attacco → `onReconnect` riattacca tutto → altri megabyte in
 * coda. È il moltiplicatore che in produzione ha prodotto 51 timeout di fila.
 *
 * Quindi: finché ARRIVANO BYTE dal daemon, il ponte non è morto — è occupato.
 * Un tetto assoluto resta, perché «occupato per sempre» va comunque chiuso.
 */
const MAX_ACK_WAIT_MS = 90_000;
/** Ogni quanto il waiter si sveglia per chiedersi se il ponte è ancora muto. */
const STALL_TICK_MS = Number(process.env.TOPICS_AI_BRIDGE_STALL_TICK_MS) || 1_000;
/**
 * Un timer che scatta MOLTO più tardi del dovuto non racconta il ponte:
 * racconta noi, fermi (un fold lungo, una GC, la macchina sotto carico). Quel
 * ritardo non va addebitato al daemon, o basterebbe un blocco nostro per
 * dichiarare perso un ack che stava per arrivare.
 */
const LOOP_STALL_FORGIVENESS_MS = 2_000;
/** Tentativi totali per una richiesta (il primo più i ritentativi). */
const REQUEST_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;

/**
 * How many daemons may be spawned, and in what window, before we declare a
 * failure instead of spawning more. See the use site in `ensureConnected`:
 * without a cap that branch is a fork bomb.
 *
 * The budget is PER SOCKET, not per process. The brawl that sank the machine on
 * 2026-08-13 was between daemons fighting over one socket, and a global cap
 * would punish a second client talking to a completely different socket (other
 * cwd, so other hash) just for living in the same process. It is also what
 * keeps the cap invisible to tests, which open many isolated bridges in a row.
 */
const SPAWN_WINDOW_MS = 60_000;
const SPAWN_MAX = 3;
const recentSpawns = new Map<string, number[]>();

/**
 * Il guasto è la CONNESSIONE, non il daemon.
 *
 * Distinguerli è ciò che rende sensato un secondo tentativo: se il frame non è
 * mai partito (socket appena caduto, riaggancio in corso) riprovare è corretto e
 * risolve; se invece il daemon ha ricevuto e tace, riprovare raddoppia solo
 * l'attesa. Le tre richieste del ponte — spawn, attach, list — sono tutte
 * idempotenti per costruzione (uno `spawn` su una sessione viva la RIPRENDE,
 * un `attach` rirende dallo stesso offset), quindi il secondo tentativo è
 * sicuro.
 */
export class BridgeConnectionLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConnectionLost";
  }
}

/**
 * Il ponte è rimasto MUTO oltre la deadline: né l'ack né un solo byte per
 * nessun'altra sessione.
 *
 * Separato da `BridgeConnectionLost` perché racconta un guasto diverso — lì il
 * frame non è mai partito, qui è partito e non è tornato niente — ma condivide
 * con esso l'unica proprietà che conta per chi lo cattura: si può RIPROVARE.
 * Prima questa era una `Error` nuda, e nuda voleva dire definitiva: un solo ack
 * scaduto e il turno moriva con «Riadozione del turno non riuscita» in chat,
 * anche quando il figlio `claude` stava lavorando benissimo dentro il daemon.
 */
export class BridgeAckStalled extends Error {
  /**
   * Rimandare il frame ha senso? SÌ quando il ponte taceva davvero — NO quando
   * a scadere è il tetto assoluto mentre i byte scorrevano ancora: lì rimandare
   * un `attach` significa rifare da capo lo stesso replay da megabyte che stava
   * già arrivando, cioè aggiungere benzina alla coda che ha causato l'attesa.
   */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "BridgeAckStalled";
    this.retryable = retryable;
  }
}

/** Vale la pena rimandare il frame? Vero per i due guasti di TRASPORTO — mai
 *  per un `error` applicativo del daemon, che una seconda volta risponderebbe
 *  la stessa cosa. */
export function isRetryableBridgeError(e: unknown): boolean {
  if (e instanceof BridgeConnectionLost) return true;
  return e instanceof BridgeAckStalled && e.retryable;
}

/**
 * Il verdetto del watchdog, estratto perché è UNA riga con due modi di
 * sbagliare e nessuno dei due si può aspettare 45 secondi in un test.
 *
 * Un pong in ritardo NON basta a dichiarare morto il ponte: viaggia sulla
 * stessa coda del resto e durante un riattacco pesante finisce dietro decine
 * di MB di replay. Se nel frattempo sono arrivati BYTE, il daemon è vivo — e
 * riciclare il socket lì è la mossa peggiore possibile, perché stacca ogni
 * attacco e fa ripartire tutti i replay da capo.
 */
export function shouldRecycleSocket(now: number, lastPongAt: number, lastByteAt: number, pongTimeoutMs: number): boolean {
  return now - lastPongAt > pongTimeoutMs && now - lastByteAt > pongTimeoutMs;
}

type Waiter = {
  pred: (m: any) => boolean;
  resolve: (m: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Da quando questo waiter considera il ponte muto. Riparte a ogni byte che
   *  arriva dal daemon, e ogni volta che il ritardo del timer dimostra che a
   *  essere fermi eravamo noi. */
  silentSince: number;
};

export class AiBridgeClient {
  private socket: net.Socket | null = null;
  private ready = false;
  private connecting = false;
  private readyResolvers: Array<() => void> = [];
  private readonly handlers = new Map<string, SessionHandlers>();
  private readonly waiters: Waiter[] = [];
  private readonly reconnectCbs = new Set<() => void>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  /** Ultimo byte ricevuto dal daemon, di chiunque fosse. Vedi `setupReader`. */
  private lastByteAt = 0;
  private disposed = false;

  readonly socketPath: string;
  readonly storeDir: string;

  constructor() {
    this.socketPath = computeSocketPath();
    this.storeDir = join(resolveStateDir(process.cwd()), "ai-bridge");
    // Detached daemon: it outlives this server and is reparented to launchd, so
    // only its command line ties it back to us. Declaring the socket is what puts
    // it (and its children) into the RAM/CPU figure the status bar shows.
    registerFleetSocket("ai-bridge", this.socketPath);
  }

  // --- connection ---

  async ensureConnected(): Promise<void> {
    // Un client CHIUSO non riapre niente. La guardia stava solo dentro
    // l'handler `close` — cioè al momento della chiusura, non al momento
    // dell'uso — e da quando `request` riprova su un guasto di connessione
    // quella distinzione conta: un `dispose()` mentre una richiesta è in volo
    // le faceva catturare `BridgeConnectionLost`, riconnettere, e — se il
    // socket del daemon era già sparito — SPAWNARE UN DAEMON NUOVO, detached,
    // vivo per mezz'ora e su un socket a cui nessuno si riconnetterà mai. È la
    // classe di daemon randagi che `ai-bridge.mjs` racconta di aver già trovato
    // 28 volte, e contraddiceva il contratto scritto su `dispose()` stesso.
    if (this.disposed) throw new Error("ai-bridge: client chiuso");
    if (this.ready && this.socket && !this.socket.destroyed) return;
    if (this.connecting) return new Promise<void>((r) => this.readyResolvers.push(r));
    this.connecting = true;
    try {
      if (await this.tryConnect()) return;
      // SPAWN CAP, and it is not theoretical. If the connection never succeeds,
      // this branch spawns a detached daemon every ~3 seconds, forever.
      // Multiplied by the processes running the same loop, on 2026-08-13 it
      // produced 1612 daemons on one socket in twelve minutes: 36 GB of swap and
      // an unusable machine. Past the cap we fail LOUDLY, which is noisy in chat
      // but does not sink the box, and the window expires on its own so a
      // transient fault does not mute us forever.
      const now = Date.now();
      const recent = (recentSpawns.get(this.socketPath) ?? []).filter((t) => now - t < SPAWN_WINDOW_MS);
      if (recent.length >= SPAWN_MAX) {
        recentSpawns.set(this.socketPath, recent);
        throw new Error(
          `ai-bridge: already spawned ${recent.length} daemons on ${this.socketPath} in the last ${SPAWN_WINDOW_MS / 1000}s without connecting. Refusing to spawn more.`,
        );
      }
      recent.push(now);
      recentSpawns.set(this.socketPath, recent);
      // No daemon — spawn one (detached, survives our restart). Bun-native:
      // process.execPath is the same bun the server runs under. augmentPath so a
      // launchd-minimal PATH still resolves `claude` for the children later.
      try { fs.mkdirSync(this.storeDir, { recursive: true }); } catch { /* best effort */ }
      // Daemon stderr → a log file in the store dir, never "inherit": an
      // inherited fd survives in the detached daemon and holds OUR stderr open,
      // so a piped parent (test runner, `| tee`) never sees EOF and hangs. The
      // file fd is ours to close as soon as the child owns a copy.
      let logFd: number | null = null;
      try { logFd = fs.openSync(join(this.storeDir, "daemon.log"), "a"); } catch { /* log is optional */ }
      // --parent-pid is how the daemon knows we died: it CANNOT read that from
      // process.ppid, which Bun never refreshes after reparenting to init (Node
      // does). Without it the daemon's orphan monitor is dead code and every
      // abandoned daemon lives forever — 28 of them, up to 3 days old, were
      // found on one machine. See the monitor in ai-bridge.mjs.
      const child = spawn(
        process.execPath,
        [
          resolve(import.meta.dir, "../ai-bridge.mjs"),
          "--socket", this.socketPath,
          "--store-dir", this.storeDir,
          "--parent-pid", String(process.pid),
        ],
        { detached: true, stdio: ["ignore", "ignore", logFd ?? "ignore"], env: { ...process.env, PATH: augmentPath() } },
      );
      child.unref();
      if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* already closed */ } }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        if (fs.existsSync(this.socketPath) && (await this.tryConnect())) break;
      }
      if (!this.ready) throw new Error("ai-bridge: failed to connect after spawning daemon");
    } finally {
      this.connecting = false;
      this.readyResolvers.forEach((r) => r());
      this.readyResolvers = [];
    }
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((res) => {
      if (!fs.existsSync(this.socketPath)) { res(false); return; }
      const socket = net.connect(this.socketPath, () => {
        this.socket = socket;
        this.ready = true;
        this.lastPongAt = Date.now();
        this.setupReader(socket);
        this.startWatchdog();
        console.log("[AI Bridge] Connected to daemon");
        res(true);
      });
      socket.on("error", () => res(false));
      setTimeout(() => { if (!this.ready) { socket.destroy(); res(false); } }, 1000);
    });
  }

  private setupReader(socket: net.Socket): void {
    // Il byte grezzo, non il frame: durante un replay lungo il daemon ci sta
    // versando addosso megabyte e l'ack che aspettiamo è in fondo alla coda.
    // Questo è il segnale «il ponte è VIVO» che distingue «tutto lento» da
    // «daemon morto» — per i waiter (vedi `arm`) e per il watchdog.
    socket.on("data", () => { this.lastByteAt = Date.now(); });
    const rl = createInterface({ input: socket });
    rl.on("line", (line: string) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      this.handleFrame(msg);
    });
    socket.on("close", () => {
      this.ready = false;
      this.socket = null;
      if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
      // Chi stava aspettando un ack su QUESTO socket non lo riceverà mai: la
      // risposta sarebbe arrivata da qui. Svegliarli subito è ciò che evita il
      // caso peggiore osservato — un hot-reload chiude il socket, un waiter
      // resta appeso al suo timer, e cinque secondi dopo un turno appena
      // cominciato muore con «ack timeout» in chat. L'errore è di CLASSE
      // connessione, quindi `request` lo ritenta invece di propagarlo.
      this.failWaiters(new BridgeConnectionLost("ai-bridge: connessione al daemon caduta"));
      if (this.disposed) return; // shut down deliberately — do NOT respawn
      console.log("[AI Bridge] socket closed — reconnecting");
      setTimeout(() => {
        this.ensureConnected()
          .then(() => { for (const cb of this.reconnectCbs) { try { cb(); } catch { /* handler own errors */ } } })
          .catch(() => { /* next call retries */ });
      }, 500);
    });
    socket.on("error", () => { /* 'close' follows */ });
  }

  private handleFrame(msg: any): void {
    // Satisfy any ack waiter first (spawned/attached/list/error/pong).
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].pred(msg)) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
    if (msg.type === "pong") { this.lastPongAt = Date.now(); return; }
    const id = msg.id as string | undefined;
    if (!id) return;
    const h = this.handlers.get(id);
    if (!h) return;
    switch (msg.type) {
      case "data": h.onData(Buffer.from(msg.chunk ?? "", "base64"), msg.offset ?? 0); break;
      case "stderr": h.onStderr?.(Buffer.from(msg.chunk ?? "", "base64")); break;
      case "exit": h.onExit?.(typeof msg.exitCode === "number" ? msg.exitCode : null); break;
    }
  }

  /**
   * Arma un waiter e restituisce anche la maniglia per ucciderlo: serve quando
   * il frame non parte, per non lasciarlo a scadere a vuoto.
   *
   * La deadline è sul SILENZIO. Il timer non è più un colpo solo a `timeoutMs`:
   * si sveglia ogni secondo e si chiede due cose prima di dichiarare perso
   * l'ack — il daemon ha mandato QUALCOSA di recente (anche per un'altra
   * sessione: è la prova che è vivo e sta solo smaltendo la coda)? e questo
   * risveglio è arrivato in orario, o eravamo fermi NOI? Solo se il ponte tace
   * davvero per `timeoutMs` il waiter rigetta — e rigetta con un errore
   * RITENTABILE, non più con una `Error` nuda che uccideva il turno.
   */
  private arm(pred: (m: any) => boolean, timeoutMs: number, what: string): { promise: Promise<any>; cancel: (e: Error) => void } {
    let entry!: Waiter;
    const promise = new Promise<any>((res, rej) => {
      const armedAt = Date.now();
      const hardDeadline = armedAt + Math.max(MAX_ACK_WAIT_MS, timeoutMs);
      let dueAt = armedAt + STALL_TICK_MS;
      const tick = (): void => {
        const now = Date.now();
        // Il risveglio è in ritardo oltre ogni tolleranza ⇒ il processo era
        // bloccato. Quel tempo non è silenzio del daemon: azzera il conto.
        if (now - dueAt > LOOP_STALL_FORGIVENESS_MS) entry.silentSince = now;
        dueAt = now + STALL_TICK_MS;
        const mute = now - Math.max(entry.silentSince, this.lastByteAt);
        if (mute < timeoutMs && now < hardDeadline) { entry.timer = setTimeout(tick, STALL_TICK_MS); return; }
        this.dropWaiter(entry);
        const muto = mute >= timeoutMs;
        const why = muto ? `muto da ${Math.round(mute / 1000)}s` : `tetto ${Math.round((hardDeadline - armedAt) / 1000)}s`;
        rej(new BridgeAckStalled(`ai-bridge: ack timeout (${what}, ${why})`, muto));
      };
      entry = { pred, resolve: res, reject: rej, timer: setTimeout(tick, STALL_TICK_MS), silentSince: armedAt };
      this.waiters.push(entry);
    });
    return {
      promise,
      cancel: (e: Error) => { this.dropWaiter(entry); clearTimeout(entry.timer); entry.reject(e); },
    };
  }

  private dropWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  /** Chiude e dimentica il socket corrente, così il prossimo `ensureConnected`
   *  ne apre davvero uno nuovo. Il riaggancio automatico dell'evento `close`
   *  resta: questo serve a chi non può aspettarlo. */
  private dropSocket(): void {
    const s = this.socket;
    this.socket = null;
    this.ready = false;
    try { s?.destroy(); } catch { /* già andato */ }
  }

  /** Rigetta TUTTI i waiter in volo (socket caduto). */
  private failWaiters(err: Error): void {
    for (const w of this.waiters.splice(0, this.waiters.length)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /**
   * Manda un frame e aspetta il suo ack, con UN solo secondo tentativo se il
   * guasto è di connessione.
   *
   * Prima ogni chiamante faceva `ensureConnected()` → `waitFor()` → `send()`, e
   * `send()` su socket nullo scartava il frame IN SILENZIO con il waiter già
   * armato: nessuno avrebbe mai risposto, e l'unico esito possibile era il
   * timeout. La fessura fra l'ensureConnected e il write è larga quanto un
   * hot-reload del server, cioè quanto capita ogni giorno.
   */
  private async request(frame: object, pred: (m: any) => boolean, timeoutMs: number, what: string): Promise<any> {
    let last: Error | null = null;
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
      await this.ensureConnected();
      const w = this.arm(pred, timeoutMs, what);
      if (!this.send(frame)) {
        w.cancel(new BridgeConnectionLost(`ai-bridge: ${what} non è partito (socket caduto)`));
      }
      try {
        return await w.promise;
      } catch (err: any) {
        // Un ack scaduto non è più un verdetto. Le tre richieste del ponte —
        // spawn, attach, list — sono idempotenti per costruzione (uno `spawn`
        // su una sessione viva la RIPRENDE, un `attach` rirende dallo stesso
        // offset), quindi rimandarle è sicuro; e visto che il waiter rigetta
        // solo dopo un silenzio VERO, qui non si arriva mai per lentezza.
        if (!isRetryableBridgeError(err) || attempt === REQUEST_ATTEMPTS - 1) throw err;
        last = err;
        console.warn(`[AI Bridge] ${what}: ${err.message} — riprovo (${attempt + 1}/${REQUEST_ATTEMPTS - 1})`);
        // Il socket va BUTTATO prima di riprovare. `ensureConnected` si fida
        // di `ready` e di `destroyed`, e un socket può essere rotto senza
        // essere nessuno dei due (write che fallisce, peer sparito senza
        // FIN): senza questo, il secondo tentativo tornerebbe a scrivere
        // sullo stesso tubo morto e il ritentativo sarebbe finto.
        this.dropSocket();
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }
    throw last ?? new Error(`ai-bridge: ${what} fallito`);
  }

  /** `true` se il frame è davvero uscito sul filo. Un `false` va gestito dal
   *  chiamante: scartarlo in silenzio è come non averlo mai mandato. */
  private send(msg: object): boolean {
    const s = this.socket;
    if (!s || s.destroyed || !this.ready) return false;
    try { s.write(JSON.stringify(msg) + "\n"); return true; } catch { return false; }
  }

  /**
   * Il ping/pong esiste per accorgersi di un daemon MORTO. Il pong però viaggia
   * sulla stessa coda di tutto il resto: durante un riattacco pesante può
   * restare dietro decine di MB di replay e non tornare per un minuto, e il
   * watchdog leggeva quel ritardo come una morte.
   *
   * Il riciclo che ne seguiva era il moltiplicatore della raffica: buttare il
   * socket stacca OGNI attacco lato daemon, `onReconnect` li riattacca tutti
   * insieme, il nuovo socket si riempie degli stessi megabyte, e il pong
   * successivo ritarda di nuovo. Nel log di produzione questo anello gira due
   * volte dentro la raffica da 51 timeout.
   *
   * Un byte ricevuto di recente è la prova che serviva: il ponte c'è.
   */
  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.ready) return;
      const now = Date.now();
      if (shouldRecycleSocket(now, this.lastPongAt, this.lastByteAt, PONG_TIMEOUT_MS)) {
        console.warn("[AI Bridge] watchdog: né pong né byte — riciclo il socket");
        try { this.socket?.destroy(); } catch { /* 'close' handles reconnect */ }
        return;
      }
      this.send({ type: "ping" });
    }, WATCHDOG_EVERY_MS);
    this.watchdog.unref?.();
  }

  // --- session ops ---

  registerHandlers(id: string, handlers: SessionHandlers): void { this.handlers.set(id, handlers); }
  unregister(id: string): void { this.handlers.delete(id); }

  /** Spawn (or, if a live session for `id` already exists, resume) a child. */
  async spawn(id: string, opts: SpawnOpts): Promise<{ pid: number; resumed: boolean }> {
    const m = await this.request(
      { type: "spawn", id, cliPath: opts.cliPath, args: opts.args, cwd: opts.cwd, env: opts.env },
      (f) => (f.type === "spawned" || f.type === "error") && f.id === id,
      SPAWN_ACK_TIMEOUT_MS,
      `spawn ${id}`,
    );
    if (m.type === "error") throw new Error(`ai-bridge spawn: ${m.error}`);
    return { pid: m.pid, resumed: m.resumed === true };
  }

  /** Re-attach to an existing session, replaying the store from `fromOffset`. */
  async attach(id: string, fromOffset: number): Promise<AttachResult> {
    const m = await this.request(
      { type: "attach", id, fromOffset },
      (f) => f.type === "attached" && f.id === id,
      ATTACH_ACK_TIMEOUT_MS,
      `attach ${id}`,
    );
    return { endOffset: m.endOffset, alive: m.alive, exitCode: m.exitCode ?? null, missing: m.missing === true };
  }

  /**
   * Attach to an already-live session WITHOUT replaying its store: only what
   * the child emits from now on. `attach` has no "live-only" offset of its own
   * (and `fromOffset` is int32-coerced daemon-side, so a sentinel like
   * MAX_SAFE_INTEGER would wrap to 0 and replay everything) — so we read the
   * current `endOffset` from `list` and attach there. Bytes appended between
   * the two round-trips are still delivered: `attach` replays [from, endOffset]
   * as of when it lands.
   */
  async attachLive(id: string): Promise<AttachResult & { fromOffset: number }> {
    const info = (await this.list()).find((s) => s.id === id);
    const fromOffset = info?.endOffset ?? 0;
    return { ...(await this.attach(id, fromOffset)), fromOffset };
  }

  /**
   * I frame SENZA ack. Non aspettano risposta, quindi non passano da `request` —
   * ma «non aspetta risposta» non vuol dire «non importa se parte».
   *
   * `send()` torna `false` quando il socket è caduto, e scartare quel `false`
   * qui costava caro in due modi:
   *  · `signal("SIGINT")` è l'abort dell'utente. Il chiamante ha un catch
   *    dichiarato «load-bearing» (`claude-code.ts`, «a failed SIGINT means the
   *    turn is NOT actually cancelled») che non scattava MAI, perché `signal`
   *    non lanciava: chi premeva Stop non fermava niente e nessuno lo diceva.
   *  · `kill` cancellava l'handler anche a frame mai partito: il figlio `claude`
   *    restava vivo nel daemon, senza padrone né dal lato client né dal lato
   *    provider, per tutta la vita del server.
   *
   * Ora tornano un booleano onesto e `throwOnDrop` lo trasforma in eccezione per
   * chi ha una rete pronta a riceverla.
   */
  write(id: string, data: string): void { this.throwOnDrop(this.send({ type: "write", id, data }), `write ${id}`); }
  detach(id: string): void { this.send({ type: "detach", id }); }
  signal(id: string, sig: string): void { this.throwOnDrop(this.send({ type: "signal", id, signal: sig }), `signal ${sig} ${id}`); }

  kill(id: string): void {
    if (this.send({ type: "kill", id })) { this.handlers.delete(id); return; }
    // Il frame non è uscito: l'handler NON si cancella ancora, o il figlio
    // resterebbe vivo e irraggiungibile. Si riaggancia e si rimanda una volta.
    void this.ensureConnected()
      .then(() => { if (this.send({ type: "kill", id })) this.handlers.delete(id); })
      .catch(() => { /* client chiuso o daemon irraggiungibile: lo raccoglie il monitor orfani */ });
  }

  private throwOnDrop(uscito: boolean, cosa: string): void {
    if (!uscito) throw new BridgeConnectionLost(`ai-bridge: ${cosa} non è partito (socket caduto)`);
  }

  async list(): Promise<SessionInfo[]> {
    const m = await this.request({ type: "list" }, (f) => f.type === "list", ACK_TIMEOUT_MS, "list");
    return (m.sessions ?? []) as SessionInfo[];
  }

  /** True if the daemon holds a session for `id` whose child is still alive. */
  async hasLiveSession(id: string): Promise<boolean> {
    try { return (await this.list()).some((s) => s.id === id && s.alive); }
    catch { return false; }
  }

  /** Called after a socket reconnect so the provider re-attaches live sessions. */
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => this.reconnectCbs.delete(cb);
  }

  /** Tear down the connection WITHOUT triggering the auto-reconnect (which would
   *  otherwise respawn the daemon). For a deliberate shutdown / test teardown. */
  dispose(): void {
    this.disposed = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.socket = null;
    this.ready = false;
    // Anche senza un evento `close` (socket già nullo) nessuno risponderà più:
    // lasciare i waiter appesi terrebbe in vita il processo di test fino al
    // timeout più lungo.
    this.failWaiters(new BridgeConnectionLost("ai-bridge: client chiuso"));
  }
}

/** Socket path: isolated per data-instance so a test server never touches prod's
 *  ai-bridge (mirrors terminal.ts getSocketPath). TOPICS_AI_BRIDGE_SOCKET is the
 *  E2E override. */
function computeSocketPath(): string {
  const override = process.env.TOPICS_AI_BRIDGE_SOCKET;
  if (override) return override;
  const dataDir = process.env.DATA_DIR;
  const basis = dataDir ? `${process.cwd()}\0${dataDir}` : process.cwd();
  const hash = createHash("md5").update(basis).digest("hex").slice(0, 8);
  return `/tmp/topics-ai-bridge-${hash}.sock`;
}

let singleton: AiBridgeClient | null = null;
export function getAiBridgeClient(): AiBridgeClient {
  if (!singleton) singleton = new AiBridgeClient();
  return singleton;
}

/** Test-only: drop the cached singleton so the next getAiBridgeClient() picks up
 *  a fresh socket/store from the current env. Prevents a prior test file's client
 *  (with a different TOPICS_AI_BRIDGE_SOCKET) leaking into a later one when many
 *  broker tests share one `bun test` process. No-op effect in production. */
export function __resetAiBridgeClientForTests(): void {
  try { singleton?.dispose(); } catch { /* best effort */ }
  singleton = null;
}
