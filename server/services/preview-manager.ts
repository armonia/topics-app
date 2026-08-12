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
  /** Add a `review-note` comment (does NOT wake the agent). */
  addReviewNote(taskId: string, args: { content: string; media?: string[] }): void;
  /** Surface the preview in the Processes panel (Stop button + logs). Optional. */
  registerProcess?(entry: { taskId: string; port: number; pid: number | null; command: string; cwd: string }): void;
  unregisterProcess?(taskId: string): void;
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

export interface PreviewManager {
  /**
   * Full delivery flow: (re)use or boot the preview, set output_url to the local
   * deep-link, capture a screenshot → previewImage + review-note. Enforces the
   * no-prod-url guard when no preview is possible. Best-effort — never throws.
   */
  prepareForReview(taskId: string): Promise<void>;
  /** Boot (or reuse) a preview server for the task. null ⇒ couldn't. */
  ensurePreview(taskId: string): Promise<{ url: string; port: number } | null>;
  /** Kill + forget the task's preview server. Idempotent, never throws. */
  teardown(taskId: string): Promise<void>;
  /** Tear every preview down (shutdown). */
  teardownAll(): Promise<void>;
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

  function usedPorts(): Set<number> {
    return new Set(Array.from(live.values()).map((p) => p.port));
  }

  async function pickPort(): Promise<number | null> {
    const used = usedPorts();
    for (let port = range[0]; port <= range[1]; port++) {
      if (used.has(port)) continue;
      if (await portFree(port)) return port;
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
    return cwd.replace(/\/+$/, "") === expect.cwd.replace(/\/+$/, "") ? "own" : "foreign";
  }

  async function ensurePreview(taskId: string): Promise<{ url: string; port: number } | null> {
    // Reuse a still-alive server (re-review after a reject+fix).
    const existing = live.get(taskId);
    if (existing) {
      if (existing.proc.alive()) return { url: existing.url, port: existing.port };
      live.delete(taskId); // dead — fall through and recreate
      try { deps.unregisterProcess?.(taskId); } catch { /* ignore */ }
    }

    const wt = deps.worktreeOf(taskId);
    if (!wt || wt.mode !== "branch") return null;

    const command = deps.resolveCommand(taskId, wt);
    if (!command || command.cmd.length === 0) return null;

    const port = await pickPort();
    if (port == null) { log(`[preview] no free port in ${range[0]}-${range[1]} for ${taskId}`); return null; }

    let proc: PreviewProcess;
    try {
      deps.ensureMediaDir();
      proc = deps.spawn(command.cmd, {
        cwd: wt.absPath,
        env: { PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", ...(command.env ?? {}) },
      });
    } catch (err) {
      log(`[preview] spawn failed for ${taskId}`, err);
      return null;
    }

    const probeUrl = `http://127.0.0.1:${port}/`;
    const ready = await waitReady(probeUrl, proc);
    if (!ready) {
      log(`[preview] server for ${taskId} never became ready on :${port} — killing`);
      try { proc.kill(); } catch { /* ignore */ }
      return null;
    }

    // Risponde: ma è LUI? Un dev server estraneo già in ascolto sulla porta del
    // pool verrebbe adottato in silenzio come anteprima del task.
    const owns = await ownership(port, { pid: proc.pid, cwd: wt.absPath });
    if (owns === "foreign") {
      log(`[preview] :${port} answers but belongs to another process — refusing to adopt it for ${taskId}`);
      try { proc.kill(); } catch { /* ignore */ }
      return null;
    }
    if (owns === "unknown") log(`[preview] owner of :${port} unverified for ${taskId} (child alive — accepting)`);

    const deepLink = command.deepLinkPath && command.deepLinkPath.startsWith("/") ? command.deepLinkPath : "/";
    const url = `http://localhost:${port}${deepLink}`;
    live.set(taskId, { taskId, port, url, proc, worktreePath: wt.absPath, startedAt: now() });
    try {
      deps.registerProcess?.({ taskId, port, pid: proc.pid, command: command.cmd.join(" "), cwd: wt.absPath });
    } catch { /* panel registration is best-effort */ }
    return { url, port };
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

  async function prepareForReview(taskId: string): Promise<void> {
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
      if (cur && isLocalUrl(cur) && (await deps.probe(cur))) {
        if (await reusable(taskId, cur)) url = cur;
        else refusedLocal = true;
      }
      if (!url) {
        const res = await ensurePreview(taskId);
        if (res) { url = res.url; deps.setOutputUrl(taskId, url); }
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
        }
        return;
      }

      // Cancello sul CONTENUTO: si guarda la pagina PRIMA di fotografarla. Un
      // placeholder o un errore non è evidenza — e un'evidenza falsa è peggio
      // di nessuna evidenza, quindi qui si AZZERA anche l'anteprima vecchia.
      const page = deps.fetchPage ? await deps.fetchPage(url).catch(() => null) : null;
      if (page && !isEvidencePage(page)) {
        try { deps.setPreviewImage(taskId, ""); } catch (err) { log(`[preview] clearPreviewImage failed for ${taskId}`, err); }
        const why = page.status >= 400
          ? `ha risposto ${page.status}`
          : "mostra una pagina di placeholder (nessun contenuto del task)";
        deps.addReviewNote(taskId, {
          content: `⚠️ Nessuna anteprima allegata: ${url} ${why}. ` +
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
        deps.addReviewNote(taskId, { content: `Anteprima viva pronta: ${url}`, media: [outPath] });
      } else {
        deps.addReviewNote(taskId, { content: `Anteprima viva su ${url} (screenshot non catturato).` });
      }
    } catch (err) {
      log(`[preview] prepareForReview failed for ${taskId}`, err);
    }
  }

  async function teardown(taskId: string): Promise<void> {
    const p = live.get(taskId);
    if (!p) return;
    live.delete(taskId);
    try { p.proc.kill(); } catch (err) { log(`[preview] kill failed for ${taskId}`, err); }
    try { deps.unregisterProcess?.(taskId); } catch { /* ignore */ }
  }

  async function teardownAll(): Promise<void> {
    for (const taskId of Array.from(live.keys())) await teardown(taskId);
  }

  function listPreviews() {
    return Array.from(live.values()).map((p) => ({ taskId: p.taskId, port: p.port, url: p.url }));
  }

  return { prepareForReview, ensurePreview, teardown, teardownAll, list: listPreviews };
}
