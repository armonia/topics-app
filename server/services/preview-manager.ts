// Review-ready previews: spin up a live preview server from a task's worktree
// when it reaches review, point the task's output_url at the LOCAL deep-link
// (never a prod URL for undeployed code), attach a screenshot as evidence, and
// tear the server down when the task lands or is closed.
//
// Design (v1, 2026-07-20 — Attilio):
//   • ONE preview server per task, on demand, from the task's own branch
//     worktree (its cwd). No multi-branch merge-preview (overkill for v1).
//   • Port from a small pool (default 3400–3450), one per live preview.
//   • The command comes from the host (env override or a package.json heuristic)
//     via the injected `resolveCommand` — this module owns the LIFECYCLE only
//     (port pick, spawn, health-wait, screenshot orchestration, teardown), so
//     it stays pure and unit-testable with injected spawn/probe/screenshot.
//   • MAI un URL di prod: if we can't boot a preview and the task already carries
//     a non-local output_url, we CLEAR it and leave a review-note — the defect
//     that started this work (every output_url pointed at prod without the code).
//   • The screenshot + status land as `review-note` comments, a channel that does
//     NOT wake the agent (unlike a human POST /comments, which reject+resumes).
//
// v2 (2026-08-11 — due cancelli, dopo il rilievo «24 card su 47 mostrano due
// immagini che non sono il loro lavoro»):
//   • IDENTITÀ — «qualcuno risponde sulla porta» non vuol dire «è il mio
//     server». Le prime porte del pool erano occupate da due dev server di un
//     ALTRO progetto e 10 card hanno fotografato la sua pagina di login. Chi
//     ASCOLTA sulla porta dev'essere il figlio spawnato (o un suo discendente,
//     riconosciuto dal cwd = worktree del task): `listenerPid` + `processCwd`.
//     Non verificabile ⇒ per il RIUSO di un url altrui si rifiuta, per il
//     proprio figlio (vivo, appena spawnato) si accetta e si logga.
//   • CONTENUTO — un placeholder o un errore non è evidenza. 14 card hanno
//     fotografato il 503 «Bundle not built yet» di un worktree senza `public/`.
//     Si guarda la pagina PRIMA di fotografarla (`fetchPage`), e se non è
//     evidenza si AZZERA l'anteprima e si scrive perché.

import { join } from "path";
import net from "net";

/**
 * Every note about the preview opens with this, and that is what makes them ONE
 * slot instead of a pile.
 *
 * The manager runs again on every review transition and on every comment with
 * attachments, and each run appended a new note. Worse, the screenshot always
 * writes the same file (`<taskId8>.png`), so the OLD notes ended up showing the
 * NEW image: the thread did not just grow, it lied about what the card looked
 * like at the time. One shared prefix lets the store replace the previous note
 * instead of stacking another, which is why all four messages start with it,
 * the failures included.
 */
export const PREVIEW_NOTE_PREFIX = "Anteprima:";

/**
 * The openings this slot used BEFORE it was a slot.
 *
 * A card already carrying a note written by yesterday's code did not recognise
 * today's wording as the same thing, so the two sat one under the other: the
 * exact duplicate the slot exists to remove, reintroduced by the rewording that
 * created the slot. Measured on a035f945 and b673a253 within an hour of
 * shipping it. These stay listed until no card carries one.
 */
export const LEGACY_PREVIEW_PREFIXES = [
  "Anteprima viva",
  "Anteprima non allegata",
  "⚠️ Nessuna anteprima allegata",
  "⚠️ output_url rimosso",
];

/** Every opening this slot answers to. */
export const PREVIEW_NOTE_SLOT = [PREVIEW_NOTE_PREFIX, ...LEGACY_PREVIEW_PREFIXES];

/** The task's branch worktree — the cwd the preview server runs in. */
export interface PreviewWorktree {
  id: string;
  absPath: string;
  branchName: string | null;
  projectId: string;
  mode: string;
}

/** Minimal handle over a spawned child (injectable so tests never spawn). */
export interface PreviewProcess {
  readonly pid: number | null;
  /** True while the process is still running. */
  alive(): boolean;
  kill(): void;
}

export interface PreviewCommand {
  /** argv to spawn (e.g. ["bun", "run", "dev"]). */
  cmd: string[];
  /** Path appended to http://localhost:<port> for the deep-link (default "/"). */
  deepLinkPath: string;
  /** Extra env for the child (merged over PORT). */
  env?: Record<string, string>;
}

export interface PreviewManagerDeps {
  /** Resolve the task's branch worktree, or null (no worktree ⇒ no preview). */
  worktreeOf(taskId: string): PreviewWorktree | null;
  /**
   * Decide HOW to start the preview for this worktree: argv + deep-link path.
   * null ⇒ this project can't be previewed (no start script / no override) —
   * the manager then skips spin-up and only enforces the no-prod-url guard.
   */
  resolveCommand(taskId: string, wt: PreviewWorktree): PreviewCommand | null;
  /** Spawn the command detached in `cwd` with `env`. Injected for tests. */
  spawn(cmd: string[], opts: { cwd: string; env: Record<string, string> }): PreviewProcess;
  /**
   * HTTP GET a url; resolve true if the server answered (any status).
   * NON è una prova d'identità: dice solo che la porta parla. Vedi
   * `listenerPid`/`processCwd` per «e chi parla è il mio server?».
   */
  probe(url: string): Promise<boolean>;
  /**
   * PID del processo che ASCOLTA su `port` (loopback), null se sconosciuto
   * (nessun listener, oppure il sistema non sa dirlo). Iniettabile: i test
   * non hanno processi veri.
   */
  listenerPid?(port: number): Promise<number | null>;
  /**
   * cwd del processo `pid`, null se sconosciuto. Serve perché il figlio che
   * spawniamo (`bun run dev`) di solito NON è quello che ascolta: ascolta un
   * suo discendente, che però eredita il cwd = worktree del task.
   */
  processCwd?(pid: number): Promise<string | null>;
  /**
   * Il path CANONICO di una cartella, symlink risolti. Serve al cancello
   * d'identità e non è un dettaglio: `lsof` risponde sempre col path REALE,
   * mentre il worktree porta con sé il path con cui è stato creato. Su macOS
   * `/tmp` è un link a `/private/tmp`, quindi le due stringhe divergono per la
   * stessa cartella e l'anteprima appena avviata veniva scambiata per un
   * processo estraneo e uccisa. Assente ⇒ confronto fra stringhe (il vecchio
   * comportamento).
   */
  realPath?(p: string): Promise<string | null>;
  /**
   * Scarica la pagina per il cancello sul CONTENUTO: `{ status, body }`, o
   * null se irraggiungibile. Assente ⇒ cancello disattivato (si fotografa).
   */
  fetchPage?(url: string): Promise<{ status: number; body: string } | null>;
  /** Render a PNG of `url` at `width` px to `outPath`. Best-effort → boolean. */
  screenshot(url: string, outPath: string, opts: { width: number }): Promise<boolean>;
  /** The task's current output_url (to detect a prod URL we must not keep). */
  currentOutputUrl(taskId: string): string | null;
  setOutputUrl(taskId: string, url: string | null): void;
  /** Path assoluto dell'anteprima; stringa vuota = AZZERA (evidenza ritirata). */
  setPreviewImage(taskId: string, absPath: string): void;
  /**
   * Toglie l'anteprima e scrive sulla CARD perché — lo stato che la nota nel
   * thread non sa aggiornare (`shared/preview-retirement.ts`). Opzionale: se
   * l'host non lo fornisce si ricade su `setPreviewImage(taskId, "")`, cioè il
   * comportamento di prima.
   */
  retirePreview?(taskId: string, reason: string): void;
  /** Add a `review-note` comment (does NOT wake the agent).
   *  `replaces`: a content prefix whose previous notes (same author, same
   *  kind) are removed before writing, so a state note is ONE slot, not a pile. */
  /**
   * Una riga nel thread della card.
   *
   * `kind` decide DOVE finisce, e non è cosmetica: `review-note` sta in
   * evidenza (è una cosa che una persona deve leggere), `service` cade nel
   * raggruppamento che il thread già fa. La distinzione serve perché la stessa
   * frase può essere una scoperta o una condizione strutturale — vedi
   * `prepareForReview`.
   */
  addReviewNote(taskId: string, args: { content: string; media?: string[]; kind?: "review-note" | "service"; replaces?: string | string[] }): void;
  /** Surface the preview in the Processes panel (Stop button + logs). Optional. */
  registerProcess?(entry: { taskId: string; port: number; pid: number | null; command: string; cwd: string }): void;
  unregisterProcess?(taskId: string): void;
  /**
   * Chiude un pid E TUTTI I SUOI DISCENDENTI (SIGTERM, poi un SIGKILL protetto
   * dall'identita').
   *
   * NON e' un lusso: chi spawniamo e' `bun run dev`, un LANCIATORE, e chi
   * ascolta sulla porta e' un suo discendente. `proc.kill()` sul solo wrapper
   * lasciava il server vivo con la porta occupata, e il pool si prosciugava
   * finche' una card in review non aveva piu' una porta su cui nascere.
   * Assente ⇒ si ricade sul solo `proc.kill()` (il comportamento vecchio).
   */
  killTree?(pid: number): Promise<void>;
  /**
   * I worktree che questa macchina conosce, path assoluti. Serve alla spazzata
   * d'avvio: un processo che ascolta su una porta del pool e ha per cwd un
   * worktree e' un'anteprima rimasta indietro da un server morto, e nessuno
   * l'avrebbe mai ritirata. Assente ⇒ la spazzata non fa niente (non si uccide
   * mai un processo che non si e' saputo riconoscere).
   */
  knownWorktreePaths?(): string[];
  /**
   * I pid che QUALCUN ALTRO su questa macchina rivendica, e i loro discendenti.
   *
   * La spazzata riconosce un residuo dal cwd — «ascolta su una porta del pool e
   * sta in un worktree conosciuto» — e un dev server che un agente ha acceso nel
   * SUO worktree con `run_script` risponde parola per parola a quella
   * descrizione. Il pannello Processi sa già chi è (pid, cwd, bottone Stop): non
   * consultarlo significava che la spazzata non poteva distinguere il lavoro di
   * un agente da un rifiuto di un server morto, e sbagliare qui uccide un
   * processo vivo che qualcuno sta guardando.
   *
   * Assente ⇒ non si protegge nessuno (il comportamento vecchio).
   */
  protectedPids?(): Promise<Set<number>> | Set<number>;
  /** Dir for screenshots (allowlisted): ~/.openclaw/media/task-previews. */
  mediaDir: string;
  /** Ensure `mediaDir` exists (injected so tests skip real fs). */
  ensureMediaDir(): void;
  /** [low, high] inclusive pool. Default [3400, 3450]. */
  portRange?: [number, number];
  /** Ms to wait for the server to answer before giving up. Default 40000. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for readiness. Default 500. */
  readyPollMs?: number;
  /** True if `port` is free to bind. Default: a real TCP connect probe. */
  portFree?(port: number): Promise<boolean>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  log?(msg: string, err?: unknown): void;
}

interface LivePreview {
  taskId: string;
  port: number;
  url: string;
  proc: PreviewProcess;
  worktreePath: string;
  startedAt: number;
}

/**
 * `explain: true` = l'ha chiesto una PERSONA («Ricattura evidenza» su una card
 * già in review), non la consegna. Cambia una cosa sola, e per un motivo: chi ha
 * cliccato deve ricevere una risposta comunque, quindi anche il ramo «niente
 * anteprima possibile» — che alla consegna resta muto per non mettere un ⚠️ su
 * ogni card senza superficie — qui scrive la sua review-note col motivo.
 */
export interface PrepareOptions {
  explain?: boolean;
}

export interface PreviewManager {
  /**
   * Full delivery flow: (re)use or boot the preview, set output_url to the local
   * deep-link, capture a screenshot → previewImage + review-note. Enforces the
   * no-prod-url guard when no preview is possible. Best-effort — never throws.
   */
  prepareForReview(taskId: string, opts?: PrepareOptions): Promise<void>;
  /** Boot (or reuse) a preview server for the task. null ⇒ couldn't. */
  ensurePreview(taskId: string): Promise<{ url: string; port: number } | null>;
  /** Kill + forget the task's preview server. Idempotent, never throws. */
  teardown(taskId: string): Promise<void>;
  /** Tear every preview down (shutdown). */
  teardownAll(): Promise<void>;
  /**
   * Spazzata d'AVVIO: chiude le anteprime rimaste in piedi da un server morto.
   * Torna le porte ripulite. Idempotente, non lancia mai.
   */
  sweepOrphans(): Promise<number[]>;
  /** Introspection (tests / status). */
  list(): { taskId: string; port: number; url: string }[];
}

const DEFAULT_RANGE: [number, number] = [3400, 3450];

/** A url whose host is loopback — the only kind safe to advertise for a preview. */
export function isLocalUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * Pagine che NON sono evidenza: il server risponde, ma quello che si vede non è
 * il lavoro del task. Il caso che ha aperto il rilievo è il 503 del bundle mai
 * costruito (worktree fresco senza `public/`), fotografato su 14 card.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /bundle not built/i,
  /cd client && bun run build/i,
  /cannot (get|find) \//i,
  /\bERR_CONNECTION_REFUSED\b/i,
  /this site can[’']t be reached/i,
];

/** True se il corpo della pagina è un placeholder/errore — niente da mostrare. */
export function isPlaceholderPage(body: string): boolean {
  const text = body.trim();
  if (!text) return true; // pagina vuota: una card bianca non prova nulla
  return PLACEHOLDER_PATTERNS.some((re) => re.test(text));
}

/** Cancello sul CONTENUTO: solo una pagina servita OK e non-placeholder è evidenza. */
export function isEvidencePage(page: { status: number; body: string }): boolean {
  if (page.status >= 400) return false;
  return !isPlaceholderPage(page.body);
}

/** Porta di un url locale, o null se non si legge. */
function portOf(raw: string): number | null {
  try {
    const u = new URL(raw);
    const p = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

/** Default TCP-connect port probe: free ⇒ nothing is listening. */
function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    const done = (free: boolean) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(free); };
    sock.once("connect", () => done(false)); // something answered ⇒ taken
    sock.once("error", () => done(true));      // refused ⇒ free
    setTimeout(() => done(true), 300);
  });
}

export function createPreviewManager(deps: PreviewManagerDeps): PreviewManager {
  const live = new Map<string, LivePreview>();
  const range = deps.portRange ?? DEFAULT_RANGE;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 40_000;
  const readyPollMs = deps.readyPollMs ?? 500;
  const now = deps.now ?? (() => Date.now());
  const portFree = deps.portFree ?? defaultPortFree;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});

  /**
   * Le porte PRENOTATE: scelte da `pickPort` ma non ancora in `live`.
   *
   * Fra le due cose passa tutto l'avvio — lo spawn, fino a 40 s di `waitReady`,
   * la sonda d'identità — e in quella finestra la porta non risultava «mia» a
   * nessuno. La spazzata ci cammina sopra e ammazza per cwd: un'anteprima che
   * stava nascendo veniva chiusa dalla spazzata d'avvio, che parte a T+10 s
   * proprio mentre la prima consegna sta bootando. La prenotazione chiude la
   * finestra; il `finally` di `bootPreview` la rilascia su OGNI uscita.
   */
  const reserved = new Set<number>();

  function usedPorts(): Set<number> {
    const used = new Set(Array.from(live.values()).map((p) => p.port));
    for (const p of reserved) used.add(p);
    return used;
  }

  async function pickPort(): Promise<number | null> {
    const used = usedPorts();
    for (let port = range[0]; port <= range[1]; port++) {
      if (used.has(port)) continue;
      if (await portFree(port)) {
        reserved.add(port);
        return port;
      }
    }
    return null;
  }

  /**
   * Attesa di prontezza CON identità minima: se il nostro figlio è morto, chi
   * risponde sulla porta non è lui. È il caso più comune del guasto — la porta
   * del pool è di un altro progetto, il figlio esce subito (EADDRINUSE) e la
   * risposta dello sconosciuto passava per «server pronto».
   */
  async function waitReady(url: string, proc: PreviewProcess): Promise<boolean> {
    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      if (!proc.alive()) return false;
      if (await deps.probe(url)) return proc.alive();
      await sleep(readyPollMs);
    }
    return false;
  }

  /**
   * Chi ascolta su `port`: il nostro (`own`), uno sconosciuto (`foreign`) o non
   * si sa (`unknown`, deps non iniettate / lsof muto). `unknown` non è
   * un'assoluzione: chi chiama decide quanto costa sbagliarsi.
   */
  async function ownership(port: number, expect: { pid: number | null; cwd: string | null }): Promise<"own" | "foreign" | "unknown"> {
    if (!deps.listenerPid) return "unknown";
    let pid: number | null = null;
    try { pid = await deps.listenerPid(port); } catch { return "unknown"; }
    if (pid == null) return "unknown";
    if (expect.pid != null && pid === expect.pid) return "own";
    if (!deps.processCwd || !expect.cwd) return "foreign";
    let cwd: string | null = null;
    try { cwd = await deps.processCwd(pid); } catch { return "foreign"; }
    if (!cwd) return "foreign";
    // Il listener è quasi sempre un DISCENDENTE del figlio (`bun run dev` →
    // server): non condivide il pid, ma eredita il cwd = worktree del task.
    // Il confronto è fra path CANONICI, non fra stringhe: `lsof` risponde col
    // path reale e il worktree con quello di creazione, e due nomi della stessa
    // cartella non sono un intruso.
    const [a, b] = await Promise.all([canonical(cwd), canonical(expect.cwd)]);
    return a === b ? "own" : "foreign";
  }

  /** Path senza slash finali e con i symlink risolti, quando si può. */
  async function canonical(p: string): Promise<string> {
    const trimmed = p.replace(/\/+$/, "");
    if (!deps.realPath) return trimmed;
    try { return (await deps.realPath(trimmed))?.replace(/\/+$/, "") ?? trimmed; }
    catch { return trimmed; }
  }

  /**
   * `ensurePreview` col MOTIVO del no. Il null nudo bastava finché a leggerlo
   * era solo la consegna (che sul niente tace); quando a chiedere è una persona,
   * «non è stato possibile» senza il perché non è una risposta.
   */
  async function bootPreview(taskId: string): Promise<{ preview: { url: string; port: number } | null; reason: string | null }> {
    const no = (reason: string) => ({ preview: null, reason });

    // Reuse a still-alive server (re-review after a reject+fix).
    const existing = live.get(taskId);
    if (existing) {
      if (existing.proc.alive()) return { preview: { url: existing.url, port: existing.port }, reason: null };
      live.delete(taskId); // dead — fall through and recreate
      try { deps.unregisterProcess?.(taskId); } catch { /* ignore */ }
    }

    const wt = deps.worktreeOf(taskId);
    if (!wt) return no("il task non ha un worktree (nessuna cartella da cui avviare un'anteprima)");
    if (wt.mode !== "branch") return no(`il worktree del task è in modalità \`${wt.mode}\`, non \`branch\`: non c'è un checkout da avviare`);

    const command = deps.resolveCommand(taskId, wt);
    if (!command || command.cmd.length === 0) return no("nessun comando di avvio riconosciuto per questo progetto (né script `dev`/`start` né override)");

    const port = await pickPort();
    if (port == null) {
      log(`[preview] no free port in ${range[0]}-${range[1]} for ${taskId}`);
      return no(`nessuna porta libera nel pool ${range[0]}-${range[1]} (troppe anteprime vive insieme)`);
    }

    // La prenotazione della porta vale finché non è in `live` (o finché non si
    // rinuncia): il `finally` è l'unico punto che la rilascia, così nessuna
    // uscita nuova può dimenticarsene.
    try {
      let proc: PreviewProcess;
      try {
        deps.ensureMediaDir();
        proc = deps.spawn(command.cmd, {
          cwd: wt.absPath,
          env: { PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", ...(command.env ?? {}) },
        });
      } catch (err) {
        log(`[preview] spawn failed for ${taskId}`, err);
        return no(`avvio fallito: \`${command.cmd.join(" ")}\` non è partito`);
      }

      const probeUrl = `http://127.0.0.1:${port}/`;
      const ready = await waitReady(probeUrl, proc);
      if (!ready) {
        log(`[preview] server for ${taskId} never became ready on :${port} — killing`);
        await spegniAlbero(proc, taskId);
        return no(`\`${command.cmd.join(" ")}\` non ha risposto su :${port} entro ${Math.round(readyTimeoutMs / 1000)}s (dipendenze non installate? build mancante?)`);
      }

      // Risponde: ma è LUI? Un dev server estraneo già in ascolto sulla porta del
      // pool verrebbe adottato in silenzio come anteprima del task.
      const owns = await ownership(port, { pid: proc.pid, cwd: wt.absPath });
      if (owns === "foreign") {
        log(`[preview] :${port} answers but belongs to another process — refusing to adopt it for ${taskId}`);
        await spegniAlbero(proc, taskId);
        return no(`su :${port} risponde un processo che non è di questo worktree, e non lo adotto come anteprima`);
      }
      if (owns === "unknown") log(`[preview] owner of :${port} unverified for ${taskId} (child alive — accepting)`);

      const deepLink = command.deepLinkPath && command.deepLinkPath.startsWith("/") ? command.deepLinkPath : "/";
      const url = `http://localhost:${port}${deepLink}`;
      live.set(taskId, { taskId, port, url, proc, worktreePath: wt.absPath, startedAt: now() });
      try {
        deps.registerProcess?.({ taskId, port, pid: proc.pid, command: command.cmd.join(" "), cwd: wt.absPath });
      } catch { /* panel registration is best-effort */ }
      return { preview: { url, port }, reason: null };
    } finally {
      reserved.delete(port);
    }
  }

  async function ensurePreview(taskId: string): Promise<{ url: string; port: number } | null> {
    return (await bootPreview(taskId)).preview;
  }

  /** L'url che risponde è davvero dell'anteprima di QUESTO task? */
  async function reusable(taskId: string, url: string): Promise<boolean> {
    const mine = live.get(taskId);
    if (mine && mine.url === url && mine.proc.alive()) return true;
    const port = portOf(url);
    if (port == null) return false;
    const cwd = deps.worktreeOf(taskId)?.absPath ?? null;
    const owns = await ownership(port, { pid: mine?.proc.pid ?? null, cwd });
    if (owns !== "own") {
      log(`[preview] refusing to reuse ${url} for ${taskId}: listener is ${owns} (not this task's preview)`);
      return false;
    }
    return true;
  }

  async function prepareForReview(taskId: string, opts?: PrepareOptions): Promise<void> {
    const explain = opts?.explain === true;
    try {
      const cur = deps.currentOutputUrl(taskId);

      // If the agent already left a LIVE local server (its own run_script dev
      // server), reuse it instead of double-booting — and don't override its
      // deep-link. Only fall through to our own preview when there's nothing
      // reachable to point at.
      //
      // «Risponde» NON basta più: un output_url vecchio resta puntato su una
      // porta che nel frattempo può essere di chiunque. Si riusa solo se è la
      // NOSTRA anteprima viva, o se chi ascolta su quella porta ha per cwd il
      // worktree del task. Non verificabile ⇒ non si riusa: costa un boot, non
      // una consegna con l'evidenza di un altro progetto.
      let url: string | null = null;
      let refusedLocal = false;
      let bootFailure: string | null = null;
      if (cur && isLocalUrl(cur) && (await deps.probe(cur))) {
        if (await reusable(taskId, cur)) url = cur;
        else refusedLocal = true;
      }
      // Chi ha scelto questo indirizzo? Cambia il PESO di ciò che si dice dopo:
      // un url messo da una persona che smette di rispondere è una notizia; una
      // porta che abbiamo aperto noi in un worktree senza bundle è la normalità.
      let nostro = false;
      if (!url) {
        const res = await bootPreview(taskId);
        if (res.preview) { url = res.preview.url; nostro = true; deps.setOutputUrl(taskId, url); }
        else bootFailure = res.reason;
      }

      if (!url) {
        // No preview possible. Never leave a prod URL standing for undeployed
        // code — né un url locale di cui abbiamo appena stabilito che chi
        // risponde NON è questo task (è così che nasce l'evidenza di un altro
        // progetto: la porta risponde, quindi «c'è l'anteprima»).
        if (cur && !isLocalUrl(cur)) {
          deps.setOutputUrl(taskId, null);
          deps.addReviewNote(taskId, {
            content: `⚠️ output_url rimosso: puntava a ${cur}, ma il codice di questo task non è deployato lì. Nessuna anteprima viva disponibile per questo worktree.`,
          });
        } else if (refusedLocal) {
          deps.setOutputUrl(taskId, null);
          deps.addReviewNote(taskId, {
            content: `⚠️ output_url rimosso: su ${cur} risponde un processo che non è l'anteprima di questo task. Nessuna anteprima viva disponibile per questo worktree.`,
          });
        } else if (explain) {
          // Nessun url da ritirare, quindi alla consegna qui non si direbbe
          // nulla. Ma la richiesta è di una persona: il no va motivato.
          deps.addReviewNote(taskId, {
            content: `⚠️ Ricattura evidenza: nessuna anteprima possibile. Motivo: ${bootFailure ?? "il progetto non è avviabile da questo worktree"}. Allega tu l'anteprima, oppure rimanda il task all'agente.`,
          });
        }
        return;
      }

      // Cancello sul CONTENUTO: si guarda la pagina PRIMA di fotografarla. Un
      // placeholder o un errore non è evidenza — e un'evidenza falsa è peggio
      // di nessuna evidenza, quindi qui si AZZERA anche l'anteprima vecchia.
      const page = deps.fetchPage ? await deps.fetchPage(url).catch(() => null) : null;
      if (page && !isEvidencePage(page)) {
        const why = page.status >= 400
          ? `ha risposto ${page.status}`
          : "mostra una pagina di placeholder (nessun contenuto del task)";
        // Il ritiro va sulla CARD (motivo compreso), non solo nel thread: una
        // nota resterebbe a dire «non c'è anteprima» anche dopo che ne è
        // arrivata una nuova.
        try {
          if (deps.retirePreview) deps.retirePreview(taskId, `l'anteprima viva ${why}`);
          else deps.setPreviewImage(taskId, "");
        } catch (err) { log(`[preview] clearPreviewImage failed for ${taskId}`, err); }
        // IL PESO DELLA FRASE SEGUE CHI HA APERTO LA PORTA.
        //
        // Quando l'indirizzo è nostro — l'abbiamo appena avviato noi nel
        // worktree — un 503 non è una scoperta: è un worktree senza bundle
        // costruito, cioè la condizione normale di quasi ogni card. Scritta come
        // `review-note` diventava l'ULTIMA riga del thread di OGNI consegna,
        // sopra il riassunto dell'agente: misurato il 19/08 su sette card in
        // review su sette, tutte con lo stesso avviso in coda. Una nota che
        // compare sempre non informa nessuno, e occupa il posto in cui l'umano
        // cerca «cos'è stato fatto».
        //
        // Se invece l'indirizzo l'aveva messo una persona (`output_url`) e
        // adesso non risponde, quella è una notizia e resta in evidenza.
        deps.addReviewNote(taskId, {
          kind: nostro ? "service" : "review-note",
          replaces: PREVIEW_NOTE_SLOT,
          content: nostro
            ? `${PREVIEW_NOTE_PREFIX} non allegata. ${url} ${why}. Il worktree probabilmente non ha un bundle costruito (\`cd client && bun run build\`).`
            : `${PREVIEW_NOTE_PREFIX} ⚠️ nessuna evidenza allegata. ${url} ${why}. ` +
              "Un'evidenza falsa è peggio di nessuna evidenza. Se il worktree serve un bundle, costruiscilo (`cd client && bun run build`) e allega tu l'anteprima.",
        });
        return;
      }

      // Evidence: screenshot at 1440px → previewImage (card thumb) + review-note.
      const outPath = join(deps.mediaDir, `${taskId.slice(0, 8)}.png`);
      let shot = false;
      try {
        deps.ensureMediaDir();
        shot = await deps.screenshot(url, outPath, { width: 1440 });
      } catch (err) { log(`[preview] screenshot failed for ${taskId}`, err); }

      if (shot) {
        try { deps.setPreviewImage(taskId, outPath); } catch (err) { log(`[preview] setPreviewImage failed for ${taskId}`, err); }
        deps.addReviewNote(taskId, {
          content: `${PREVIEW_NOTE_PREFIX} viva e pronta su ${url}`,
          media: [outPath],
          replaces: PREVIEW_NOTE_SLOT,
        });
      } else {
        deps.addReviewNote(taskId, {
          content: `${PREVIEW_NOTE_PREFIX} viva su ${url}, screenshot non catturato.`,
          replaces: PREVIEW_NOTE_SLOT,
        });
      }
    } catch (err) {
      log(`[preview] prepareForReview failed for ${taskId}`, err);
    }
  }

  /**
   * SPEGNE L'ALBERO, non l'handle.
   *
   * `proc.kill()` uccide il WRAPPER (`bun run dev`, `npm run dev`), non il dev
   * server che ha generato: quello viene reparentato a init e resta vivo con la
   * porta presa e la CPU accesa. E' esattamente cio' che il commento di
   * `teardown` spiega qui sotto, e le due uscite di errore di `bootPreview` lo
   * facevano lo stesso — cioe' proprio dove il server e' mezzo avviato e
   * nessuno lo sta piu' guardando. Il pool 3400-3450 si consuma cosi', finche'
   * una card in review non ha piu' dove nascere («nessuna porta libera»), che e'
   * il messaggio d'errore che il codice stesso prevede.
   */
  async function spegniAlbero(proc: PreviewProcess, taskId: string): Promise<void> {
    if (proc.pid && deps.killTree) {
      try { await deps.killTree(proc.pid); } catch (err) { log(`[preview] killTree failed for ${taskId}`, err); }
    }
    try { proc.kill(); } catch { /* ignore */ }
  }

  async function teardown(taskId: string): Promise<void> {
    const p = live.get(taskId);
    if (!p) return;
    live.delete(taskId);
    // L'ALBERO, non il wrapper, e PRIMA di lui. `deps.spawn` lancia
    // `bun run dev`: il processo che ASCOLTA e' un suo discendente, e segnalare
    // solo il padre lo lasciava vivo con la porta occupata per sempre.
    // L'ordine e' misurato, non estetico: uccidere prima il wrapper spezza
    // l'albero — il figlio viene reparentato a init e da quel momento nessuna
    // discendenza lo ritrova. Quindi si chiude l'albero (che comprende il
    // wrapper) e solo dopo si chiude l'handle, per i casi in cui la
    // discendenza non si e' potuta leggere.
    const pid = p.proc.pid;
    if (pid && deps.killTree) {
      try { await deps.killTree(pid); } catch (err) { log(`[preview] killTree failed for ${taskId}`, err); }
    }
    try { p.proc.kill(); } catch (err) { log(`[preview] kill failed for ${taskId}`, err); }
    try { deps.unregisterProcess?.(taskId); } catch { /* ignore */ }
  }

  async function teardownAll(): Promise<void> {
    for (const taskId of Array.from(live.keys())) await teardown(taskId);
  }

  /**
   * Le anteprime che nessuno ha mai ritirato.
   *
   * Il registro delle anteprime vive e' in MEMORIA: se il server muore (o
   * ricarica) mentre una e' su, il suo albero resta in piedi e la porta del pool
   * resta occupata per sempre — e con un pool di 51 porte bastano poche morti
   * per lasciare una card in review senza evidenza. Nessun altro le raccoglie:
   * il rilevatore del pannello attribuisce per ALBERO di una PTY claude, e
   * un'anteprima non e' figlia di nessuna PTY.
   *
   * Il riconoscimento e' lo stesso del cancello d'identita': chi ascolta su una
   * porta del pool con per cwd un worktree conosciuto e' una nostra anteprima.
   * Un dev server di un'altra cartella non viene toccato, mai — un falso
   * positivo qui ammazzerebbe il lavoro di una persona.
   */
  async function sweepOrphans(): Promise<number[]> {
    if (!deps.listenerPid || !deps.processCwd || !deps.knownWorktreePaths || !deps.killTree) return [];
    let roots: string[];
    try { roots = deps.knownWorktreePaths(); } catch { return []; }
    if (!roots.length) return [];
    const known = new Set(await Promise.all(roots.map(canonical)));
    // I pid rivendicati dal pannello Processi si leggono UNA volta, prima del
    // giro: un dev server acceso da un agente nel suo worktree è
    // indistinguibile da un residuo se si guarda solo il cwd.
    let protectedPids = new Set<number>();
    if (deps.protectedPids) {
      try { protectedPids = await deps.protectedPids(); } catch { protectedPids = new Set(); }
    }
    const cleared: number[] = [];
    for (let port = range[0]; port <= range[1]; port++) {
      // `usedPorts()` SI RILEGGE A OGNI PORTA, e non è pignoleria: il giro fa un
      // `lsof` per porta su 51 porte, e un'anteprima che nasce nel frattempo non
      // esisteva nello snapshot preso all'inizio. Con la prenotazione a
      // `pickPort`, la sua porta è già «mia» prima ancora dello spawn.
      if (usedPorts().has(port)) continue; // e' un'anteprima VIVA (o in avvio) di questo processo
      let pid: number | null = null;
      try { pid = await deps.listenerPid(port); } catch { continue; }
      if (pid == null || pid <= 0) continue;
      if (protectedPids.has(pid)) {
        log(`[preview] sweep: :${port} tenuta da ${pid}, che il pannello Processi rivendica — non la tocco`);
        continue;
      }
      let cwd: string | null = null;
      try { cwd = await deps.processCwd(pid); } catch { continue; }
      if (!cwd) continue;
      if (!known.has(await canonical(cwd))) continue;
      log(`[preview] sweep: :${port} tenuta da ${pid} in un worktree senza anteprima viva — la chiudo`);
      try { await deps.killTree(pid); cleared.push(port); }
      catch (err) { log(`[preview] sweep: killTree failed on :${port}`, err); }
    }
    return cleared;
  }

  function listPreviews() {
    return Array.from(live.values()).map((p) => ({ taskId: p.taskId, port: p.port, url: p.url }));
  }

  return { prepareForReview, ensurePreview, teardown, teardownAll, sweepOrphans, list: listPreviews };
}
