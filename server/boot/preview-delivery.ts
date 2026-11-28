/**
 * Card previews, auto-merge, worktree cleanup and the delivery references a card's branch is read through.
 */
import { join } from "path";
import { mkdirSync, readFileSync, statSync, readlinkSync, realpathSync } from "fs";
import { createTaskAutoMerge, declaredDeliveryFor, worktreeRealDirt } from "../services/task-automerge";
import { imageShape, isBlankLikeImage } from "../services/image-shape";
import { createPreviewManager, type PreviewProcess } from "../services/preview-manager";
import { createPreviewBrowser } from "../services/preview-browser";
import { recordServerSpawn } from "../lib/spawn-metrics";
import { registerPreviewProcess, unregisterPreviewProcess, trackedScriptPidTrees } from "../routes/processes";
import { killProcessTree } from "../lib/process-tree";
import { resolvePreviewCommand } from "../services/preview-command";
import { branchExistsInRepo, resolveCommit, worktreeDiffStat } from "../services/branch-status";
import { deliveryPointer } from "../services/own-commits";
import { collectCardOwnBranches } from "../services/card-own-branches";
import { subagentBranchesOf } from "../lib/subagent-store";
import { getDatabase } from "../db";
import { resolveDeliveryBranch, type DeliveryBranchDeps } from "../services/delivery-branch-ref";
import { buildProjectCandidates, resolveProjectPath } from "../services/project-path-resolver";
import { ownBranchFiles, ownCommitFiles } from "../routes/tasks";
import { createDeliveryCapture } from "../services/task-delivery-capture";
import { backfillDeliveries as backfillDeliveriesPass } from "../services/delivery-backfill";
import { keepDeliveryCommit } from "../services/delivery-ref-keep";
import { auditOneLanding as auditOneLandingPass, type AuditWiring } from "../services/landing-audit-pass";
import type { AfterQuiescence } from "./scope";
import { late } from "./late";

export function bootPreviewDelivery(scope: AfterQuiescence) {
  const { DISPATCH_WORKSPACE_DIR, broadcastToAll, ctx, dispatchExtraPaths, dispatcherSvc, scheduledCardsTimer, taskAttemptStore, worktreeOfTask } = scope;
  scheduledCardsTimer.unref?.();


  // ── Review-ready previews ──────────────────────────────────────────────────
  // One preview server per task, booted from its branch worktree at review-time.
  // `previewManager` owns the lifecycle; the host wires HOW to start/probe/shoot.
  // La cartella dell'anteprima deve stare DENTRO l'allowlist che poi la serve
  // (`isPathAllowed` → `${APP_DATA_DIR}/media/`). Scritta con `homedir()` le due
  // coincidevano solo finché `APP_DATA_DIR` restava al default:
  // spostata la cartella dati, il file veniva scritto dove nessuno può leggerlo e
  // la card mostrava un'immagine rotta.
  const PREVIEW_MEDIA_DIR = join(ctx.APP_DATA_DIR, "media", "task-previews");

  const previewBrowser = createPreviewBrowser();


  /** `lsof` per le domande d'identità sulla porta (macOS non lo ha sempre nel PATH). */
  function lsofBin(): string { return Bun.which("lsof") ?? "/usr/sbin/lsof"; }


  /** stdout di un comando breve, "" se fallisce o sfora `ms`. Best-effort by design. */
  async function previewCmdOutput(cmd: string[], ms = 2000): Promise<string> {
    try {
      if (cmd[0]?.endsWith("lsof")) recordServerSpawn("lsof", "previewIdentity");
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const t = setTimeout(() => { try { proc.kill(); } catch { /* già uscito */ } }, ms);
      try { return await new Response(proc.stdout).text(); } finally { clearTimeout(t); }
    } catch { return ""; }
  }


  /** Last ~4 KB of a stream, to say why a child died. */
  function collectTail(stream: ReadableStream<Uint8Array> | null | undefined, sink: { text: string }): void {
    if (!stream) return;
    void (async () => {
      try {
        const decoder = new TextDecoder();
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          sink.text = (sink.text + decoder.decode(chunk, { stream: true })).slice(-4096);
        }
      } catch { /* the child is closed: the tail stays as it is */ }
    })();
  }


  late.previewManager = createPreviewManager({
    worktreeOf: (taskId) => {
      const wt = worktreeOfTask(taskId);
      if (!wt) return null;
      return { id: wt.id, absPath: wt.absPath, branchName: wt.branchName, projectId: wt.projectId, mode: wt.mode };
    },
    // How the command is chosen (env override, preview:worktree, package.json
    // heuristic) lives in `resolvePreviewCommand`. The server honours PORT (injected
    // by the manager) so the pool port sticks.
    resolveCommand: (_taskId, wt) => resolvePreviewCommand(wt.absPath),
    readDeepLink: (file) => {
      try { return readFileSync(file, "utf-8").trim() || null; } catch { return null; }
    },
    spawn: (cmd, opts): PreviewProcess => {
      const child = Bun.spawn(cmd, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const out = { text: "" };
      collectTail(child.stdout, out);
      collectTail(child.stderr, out);
      return {
        get pid() { return child.pid ?? null; },
        alive() { return child.exitCode === null && !child.killed; },
        kill() { try { child.kill(); } catch { /* already gone */ } },
        tail() { return out.text; },
      };
    },
    runStep: async (cmd, opts) => {
      try {
        const child = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        const out = { text: "" };
        collectTail(child.stdout, out);
        collectTail(child.stderr, out);
        const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, opts.timeoutMs);
        try {
          const code = await child.exited;
          return { ok: code === 0, tail: out.text };
        } finally { clearTimeout(timer); }
      } catch (err) {
        return { ok: false, tail: String(err instanceof Error ? err.message : err) };
      }
    },
    probe: async (url) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        try { await fetch(url, { signal: ctrl.signal, redirect: "manual" }); return true; }
        finally { clearTimeout(t); }
      } catch { return false; }
    },
    // Cancello d'IDENTITÀ. `probe` dice solo che la porta parla; queste due dicono
    // CHI parla. Il listener è quasi sempre un discendente del figlio che
    // spawniamo (`bun run dev` → server), quindi il pid da solo non basta: il cwd
    // ereditato (= worktree del task) è ciò che lo riconosce.
    listenerPid: async (port) => {
      const out = await previewCmdOutput([lsofBin(), "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      const pid = out.split(/\s+/).map(Number).find((n) => Number.isFinite(n) && n > 0);
      return pid ?? null;
    },
    processCwd: async (pid) => {
      if (process.platform === "linux") {
        try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* lsof fallback */ }
      }
      const out = await previewCmdOutput([lsofBin(), "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const line = out.split("\n").find((l) => l.startsWith("n/"));
      return line ? line.slice(1) : null;
    },
    // `lsof` risponde col path REALE, il worktree porta quello con cui è nato: su
    // macOS `/tmp` è un link a `/private/tmp`, e senza risolverli il cancello
    // d'identità legge due nomi della stessa cartella come due cartelle diverse.
    realPath: async (p) => { try { return realpathSync(p); } catch { return null; } },
    // Cancello sul CONTENUTO: la pagina si LEGGE prima di fotografarla, così un
    // 503 «Bundle not built yet» non finisce sulla card come evidenza del lavoro.
    // Una foto riuscita puo' essere una pagina bianca: si guarda la densita' del
    // file, che per un PNG dice se e' stato disegnato qualcosa. Il pavimento e'
    // misurato, non scelto (vedi image-shape.ts).
    blankShot: (path) => {
      try {
        const forma = imageShape(path);
        if (!forma) return false;
        return isBlankLikeImage({ bytes: statSync(path).size, width: forma.width, height: forma.height, vector: forma.vector });
      } catch { return false; }
    },
    fetchPage: async (url) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
          return { status: res.status, body: (await res.text()).slice(0, 200_000) };
        } finally { clearTimeout(t); }
      } catch { return null; }
    },
    // `blankShot` reads bytes; this reads the DOM the SPA drew, which is the
    // only place "the app has no topic open" is visible. "Welcome to Topics" is
    // the literal string PanelGrid renders when no topic is selected — see
    // client/src/components/Layout/PanelGrid.tsx.
    // Both captures run on the preview's own WebKit, never on the remote
    // browser's Chromium (KANBAN-119, server/services/preview-browser.ts).
    emptyAppShell: (url) => previewBrowser.emptyAppShell(url),
    // Viewport, not full page: the card draws the preview with `object-cover`,
    // and an image taller than `PREVIEW_CARD_MAX_RATIO` (0.70) times its width
    // gets CROPPED instead of scaled — 1440×760 = 0.528 fits with margin.
    screenshot: (url, outPath, opts) => previewBrowser.screenshot(url, outPath, opts),
    screenshotFailure: () => previewBrowser.lastFailure(),
    currentOutputUrl: (taskId) => dispatcherSvc.get(taskId)?.task.outputUrl ?? null,
    currentPreviewImage: (taskId) => dispatcherSvc.get(taskId)?.task.previewImage ?? null,
    setOutputUrl: (taskId, url) => {
      const projectId = dispatcherSvc.get(taskId)?.task.projectId;
      if (!projectId) return;
      try {
        const t = dispatcherSvc.update({ taskId, actor: "agent", by: "verifier", patch: { outputUrl: url }, projectId });
        ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch (err) { console.error("[preview] setOutputUrl", err); }
    },
    setPreviewImage: (taskId, absPath) => {
      const projectId = dispatcherSvc.get(taskId)?.task.projectId;
      if (!projectId) return;
      try {
        const t = dispatcherSvc.update({ taskId, actor: "agent", by: "verifier", patch: { previewImage: absPath }, projectId });
        ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch (err) { console.error("[preview] setPreviewImage", err); }
    },
    // THE RETIREMENT WAS NEVER WIRED. `retirePreview` is optional in
    // `PreviewManagerDeps` and was not passed: both content gates (placeholder or
    // error, and blank page) fell through to `setPreviewImage(taskId, "")`, which
    // by contract turns no state on. Measured on 2026-08-23: four cards in review
    // carrying the "Anteprima: ritirata" note in the thread, all with
    // `preview_retired_at` NULL and the rejected shot still on them.
    retirePreview: (taskId, reason) => {
      const projectId = dispatcherSvc.get(taskId)?.task.projectId;
      if (!projectId) return;
      try {
        const t = dispatcherSvc.retirePreview({ taskId, reason });
        ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch (err) { console.error("[preview] retirePreview", err); }
    },
    addReviewNote: (taskId, { content, media, kind, replaces }) => {
      const projectId = dispatcherSvc.get(taskId)?.task.projectId;
      try {
        dispatcherSvc.addComment({ taskId, author: "verifier", content, media, projectId, kind: kind ?? "review-note", replaces });
        const t = dispatcherSvc.get(taskId)?.task;
        if (t) ctx.broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch (err) { console.error("[preview] addReviewNote", err); }
    },
    registerProcess: (entry) => registerPreviewProcess(entry),
    unregisterProcess: (taskId) => unregisterPreviewProcess(taskId),
    // Chi ASCOLTA sulla porta e' un DISCENDENTE di `bun run dev`, non il figlio
    // che spawniamo: senza l'albero il teardown lasciava il server vivo con la
    // porta occupata. Stessa primitiva del bottone Stop del pannello.
    killTree: (pid) => killProcessTree(pid),
    // I worktree che questa macchina conosce: e' il riconoscimento della spazzata
    // d'avvio ("chi tiene questa porta del pool e' una nostra anteprima?").
    knownWorktreePaths: () => ctx.worktreeStore.list().map((w) => w.absPath).filter(Boolean),
    // Chi il pannello Processi rivendica non e' un residuo: il dev server che un
    // agente ha acceso col `run_script` nel SUO worktree ascolta su una porta e
    // sta in una cartella conosciuta, cioe' e' identico a un'anteprima orfana per
    // tutto cio' che la spazzata sa guardare.
    protectedPids: () => trackedScriptPidTrees(),
    mediaDir: PREVIEW_MEDIA_DIR,
    ensureMediaDir: () => { try { mkdirSync(PREVIEW_MEDIA_DIR, { recursive: true }); } catch { /* ignore */ } },
    log: (msg, err) => console.error(msg, err ?? ""),
  });


  // SPAZZATA D'AVVIO delle anteprime rimaste in piedi. Il registro delle anteprime
  // vive sta in MEMORIA: un server morto (o ricaricato) mentre una era su lascia il
  // suo albero acceso e la porta del pool occupata PER SEMPRE, e nessun altro le
  // raccoglie — il rilevatore del pannello attribuisce per albero di una PTY
  // claude, e un'anteprima non e' figlia di nessuna PTY. Con 51 porte bastano
  // poche morti per lasciare una card in review senza evidenza. Differita e
  // best-effort: un `lsof` per porta non deve stare sulla strada del boot.
  // SPAZZATA D'AVVIO delle card in review rimaste senza anteprima: la scheda di
  // consegna nasce sulla transizione verso review, e le card gia' ferme li' non
  // ne attraversano piu' nessuna. Senza questa passata resterebbero cieche per
  // sempre (erano 9 su 16 il 20/08). Differita e best-effort come la spazzata
  // delle anteprime vive qui sotto.
  setTimeout(() => {
    try {
      const n = dispatcherSvc.sweepReviewPreviews();
      if (n) console.log(`[preview] spazzata d'avvio: ${n} card in review hanno di nuovo un'anteprima`);
    } catch (err) { console.error("[preview] spazzata delle anteprime in review fallita", err); }
  }, 8_000).unref?.();


  setTimeout(() => {
    late.previewManager?.sweepOrphans()
      .then((ports) => { if (ports.length) console.log(`[preview] spazzata d'avvio: liberate le porte ${ports.join(", ")}`); })
      .catch((err) => console.error("[preview] spazzata d'avvio fallita", err));
  }, 10_000).unref?.();


  const taskAutoMerge = createTaskAutoMerge({
    resolveTaskMerge: (taskId) => {
      const wt = worktreeOfTask(taskId);
      if (!wt || wt.mode !== "branch" || !wt.branchName) return null;
      const repoPath = ctx.projectStore.get(wt.projectId)?.path;
      if (!repoPath) return null;
      return { repoPath, branch: wt.branchName, defaultBranch: "main" };
    },
    // Il ripiego che NON passa dall'agente. `worktreeOfTask` risolve attraverso
    // `assigned_topic_id`, che si svuota ogni volta che l'agente viene rilasciato
    // — cosa di routine — e da lì in poi una consegna col ramo intatto diventava
    // non-landabile. La card però il ramo lo dichiara da sé (`delivery_branch`,
    // registrato quando è entrata in review), e il checkout del suo progetto si
    // ricava dal board id come fa l'audit: invertendo l'hash del percorso.
    // Attempt branches plus the card's own delivery/prior pointers: an old delivery
    // branch of the same card is its history, never "another session".
    ownBranches: (taskId) => cardOwnBranches(taskId),
    // A card that ran on another machine declares its branch as `priorBranch`.
    declaredDelivery: declaredDeliveryFor({
      getTask: (taskId) => dispatcherSvc.get(taskId)?.task,
      resolveRepoPath: (projectId) => resolveProjectPath(
        projectId,
        buildProjectCandidates({
          projectStore: ctx.projectStore,
          workspaceDir: DISPATCH_WORKSPACE_DIR,
          extraPaths: dispatchExtraPaths,
        }),
      )?.path ?? null,
      log: (msg, err) => console.warn(msg, err),
    }),
    log: (msg, err) => console.error(msg, err ?? ""),
  });



  /**
   * I DUE SGUARDI SUL WORKTREE DI UNA CARD, estratti dall'oggetto della rotta
   * perche' adesso li usa anche il DISPATCHER.
   *
   * `taskDeliveryRef` e `taskCheckoutRef` vivevano dentro le opzioni di
   * `createTasksRouter`, quindi solo la rotta poteva fotografare una consegna. La
   * consegna forzata dal sistema — che passa dal dispatcher — leggeva percio'
   * colonne che nessuno aveva scritto e concludeva sempre «nessun ramo e nessun
   * file toccato», anche su card che avevano committato (misurato il 18/08 su
   * `cf15dea6`, ramo con commit `af248dcf9`).
   */
  /**
   * DOVE e SU QUALE RAMO chiedere della consegna di una card, in un posto solo.
   *
   * Il worktree quando c'è, il ramo scritto sulla card quando non c'è più. Il
   * perché sta in `services/delivery-branch-ref.ts`: la catena
   * `task → assignedTopicId → topic.worktreeId → worktrees` si spezza da sola per
   * strada, e da lì in poi la consegna non si poteva più fotografare.
   *
   * È lo stesso ripiego che il land già si era costruito per sé
   * (`declaredDelivery`, più in alto): quello serve a decidere se c'è qualcosa da
   * pubblicare, questo a registrare cosa è stato consegnato. La risposta alla
   * domanda «quale ramo» ora è una sola.
   *
   * `candidati` si passa da chi CICLA: costruirli scandisce la cartella di lavoro,
   * e il backfill ne farebbe una scansione per card.
   */
  const deliveryBranchDeps = (candidati?: ReturnType<typeof buildProjectCandidates>): DeliveryBranchDeps => ({
    worktreeOfTask: (id) => worktreeOfTask(id),
    storeRepoPath: (projectId) => ctx.projectStore.get(projectId)?.path ?? null,
    recordedDelivery: (id) => {
      const t = dispatcherSvc.get(id)?.task;
      return t ? { projectId: t.projectId, deliveryBranch: t.deliveryBranch ?? null } : null;
    },
    boardRepoPath: (boardProjectId) => {
      try {
        const lista = candidati ?? buildProjectCandidates({
          projectStore: ctx.projectStore,
          workspaceDir: DISPATCH_WORKSPACE_DIR,
          extraPaths: dispatchExtraPaths,
        });
        return resolveProjectPath(boardProjectId, lista)?.path ?? null;
      } catch { return null; }
    },
    branchExists: (repoPath, branch) => branchExistsInRepo(repoPath, branch),
  });


  /**
   * The card's own branch history: attempt branches plus its delivery and earlier delivery
   * pointers. An old branch of the same card is its history, never "another session", and
   * both the land and the delivery capture must leave it out of the subtraction: the capture
   * did not, so a re-delivery on a fresh branch whose commits were all reachable from the
   * card's previous branch recorded "no commit of its own", got no checks and sat in review
   * (14/11, 19d684fb and 30f7c880).
   */
  function cardOwnBranches(taskId: string): string[] {
    const task = dispatcherSvc.get(taskId)?.task;
    const db = getDatabase();
    return collectCardOwnBranches({
      attemptBranches: taskAttemptStore.list(taskId).map((a) => a.branch),
      deliveryBranches: [task?.deliveryBranch, task?.priorBranch, ...(task?.pastDeliveryBranches ?? []), worktreeOfTask(taskId)?.branchName],
      // The chat the dispatcher holds is cleared on release, `chatId` keeps the last one.
      agentSessionKeys: [task?.assignedTopicId, task?.chatId].map((id) => (id ? ctx.getTopicById(id)?.sessionKey : null)),
      childBranchesOf: (key) => subagentBranchesOf(db, key),
    });
  }


  const taskDeliveryRef = async (taskId: string) => {
      const ref = await resolveDeliveryBranch(deliveryBranchDeps(), taskId).catch(() => null);
      if (!ref) return null;
      // NON la punta del ramo: l'ultimo commit SUO. Un ramo che eredita il lavoro
      // di chi stava sul checkout condiviso ha una punta che non è della card, e
      // chi rivede finirebbe a leggere il diff di un altro (misurato il 10/08).
      // `deliveryPointer` è la stessa domanda che si fa l'automerge: una fonte sola.
      //
      // E `commit: null` NON si ripiega sulla punta. È la tentazione ovvia quando
      // si vede una colonna vuota, ed è il difetto stesso: `own = []` vuol dire
      // «verificato, questa card non ha prodotto niente di suo», e sovrascriverlo
      // con `HEAD` intesta a lei il lavoro di un altro. Misurato il 18/08 sulla
      // card `5bfd7356` (worktree `mossy-marble`, zero commit propri): la sua
      // punta è `27d9ebca4`, «Le missioni: compiti a preset…», di un'altra card e
      // già su main da una settimana. Registrarla avrebbe fatto leggere al
      // reviewer il diff sbagliato e all'audit un «atterrato» falso, che è
      // esattamente il guasto per cui l'audit esiste.
      const pointer = await deliveryPointer(ref.repoPath, ref.branch, { ownRefs: cardOwnBranches(taskId) }).catch(() => null);
      if (!pointer) return null;
      // QUANTO lavoro c'è dentro, misurato QUI e non a ogni render della board.
      //
      // La colonna review chiedeva «Approva» senza dire cosa si approvasse: il
      // diff esisteva solo dietro l'apertura del drawer, una card alla volta.
      // Calcolarlo nel feed sarebbe stato tre comandi git per card a ogni push
      // WebSocket; calcolarlo alla consegna è una volta sola, quando il fatto
      // accade. `worktreeDiffStat` misura dal PADRE del commit più vecchio SUO,
      // cioè lo stesso perimetro di `deliveryPointer`: non eredita il lavoro di
      // chi stava parcheggiato sul checkout condiviso.
      //
      // Senza cartella si misura dal checkout del progetto: la domanda è tutta sui
      // ref, che i worktree di un repo condividono, e l'albero di lavoro non entra
      // nella risposta (`worktreeDiffStat` confronta due commit).
      //
      // Best-effort come tutto il resto di questa funzione: se git inciampa la
      // consegna passa lo stesso, senza misura (NULL, che non è zero).
      const stat = await worktreeDiffStat(ref.worktreePath ?? ref.repoPath, { branch: ref.branch }).catch(() => null);
      // `repoPath` travels with the snapshot because the capture plants
      // `refs/consegne/<taskId>` on the delivered sha before writing the column
      // (`services/delivery-ref-keep.ts`): the land squashes and then deletes the
      // branch, and without that ref the commit is reachable from nowhere.
      return stat
        ? { ...pointer, repoPath: ref.repoPath, filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions }
        : { ...pointer, repoPath: ref.repoPath };
  };


  const taskCheckoutRef = async (taskId: string) => {
      const wt = worktreeOfTask(taskId);
      if (!wt || wt.mode !== "branch") return null;
      const commit = await resolveCommit(wt.absPath, "HEAD");
      return { cwd: wt.absPath, commit };
  };


  /**
   * La fotografia di consegna, UNA implementazione per tre chiamanti (rotta,
   * scelta del fan-out, dispatcher). Vedi `services/task-delivery-capture.ts`.
   */
  late.capturaConsegna = createDeliveryCapture({
    svc: dispatcherSvc,
    taskDeliveryRef,
    taskCheckoutRef,
    ownCommitFiles,
    keepDeliveryCommit,
    ownBranchFiles: (repoPath, branch) => ownBranchFiles(repoPath, branch),
  });


  // Stessa sonda che il pannello delle modifiche usa gia' (`taskWorktreeDirt`):
  // il junk e' gia' escluso li' dentro, quindi la card non nomina un
  // `node_modules`. `null` = non misurabile, ed e' diverso da «pulito».
  late.sondaLavoroNonCommittato = async (taskId: string) => {
    const wt = worktreeOfTask(taskId);
    if (!wt || wt.mode !== "branch") return null;
    try { return await worktreeRealDirt(wt.absPath); } catch { return null; }
  };


  // ── Landing audit: "done" must mean "è nel prodotto" ───────────────────────
  // The GC above decides what is safe to DESTROY; this decides what has actually
  // ARRIVED. They are different questions, and the 19/07 loss lived in the gap:
  // the task said done, the branch was gone, the code was nowhere.
  //
  // Two steps per pass:
  //  1. BACKFILL — any review/done task with a live branch worktree but no
  //     recorded delivery gets its own most recent commit recorded now. Covers the
  //     paths that bypass the route PATCH (system-delivery from the dispatcher) and
  //     every task that predates the delivery snapshot.
  //  2. AUDIT — compare each recorded commit against main by CONTENT and stamp
  //     the verdict; the edge into `unlanded` posts a comment on the task.
  /**
   * Il cablaggio della passata di backfill: il COSA sta in
   * `services/delivery-backfill.ts`, qui restano solo le dipendenze vere.
   */
  function backfillDeliveries(): Promise<void> {
    return backfillDeliveriesPass({
      db: ctx.db,
      projectStore: ctx.projectStore,
      svc: dispatcherSvc,
      workspaceDir: DISPATCH_WORKSPACE_DIR,
      extraPaths: dispatchExtraPaths,
      buildProjectCandidates,
      deliveryBranchDeps,
      resolveDeliveryBranch,
      deliveryPointer,
      worktreeDiffStat,
      keepDeliveryCommit,
    });
  }


  /**
   * Il cablaggio dell'audit: il COSA sta in `services/landing-audit-pass.ts`, qui
   * restano i cinque riferimenti che vivono davvero in questo file.
   */
  const auditWiring: AuditWiring = {
    projectStore: ctx.projectStore,
    workspaceDir: DISPATCH_WORKSPACE_DIR,
    extraPaths: dispatchExtraPaths,
    svc: dispatcherSvc as unknown as AuditWiring["svc"],
    broadcast: (msg) => broadcastToAll(msg as Parameters<typeof broadcastToAll>[0]),
    backfill: backfillDeliveries,
  };

  const auditOneLanding = (taskId: string) => auditOneLandingPass(auditWiring, taskId);

  return { auditOneLanding, auditWiring, deliveryBranchDeps, previewBrowser, taskAutoMerge, taskCheckoutRef, taskDeliveryRef };
}
