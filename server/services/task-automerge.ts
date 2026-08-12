// Auto-merge a task's worktree branch into its project's main checkout on approve.
//
// Opt-in per board (board_settings.dispatch_auto_merge, default OFF). The review
// route calls tryMerge() after a human approves (review → done). Philosophy:
// programmatic when it's a CLEAN merge (the common case for short-lived task
// branches — zero AI, zero tokens), AI only when there's a real CONFLICT to
// resolve (handed back to the task's own agent, which has the context of what it
// changed).
//
// Git safety (deliberate):
//   • NEVER touch a dirty working tree — a concurrent human/agent session may have
//     uncommitted WIP in the shared main checkout. We refuse (skip) rather than
//     stash someone else's work or fold it into a merge commit.
//   • NEVER merge INTO the shared checkout when it isn't on `main`. Its HEAD is a
//     dev branch — a session is working there. Instead we land in a SEPARATE,
//     throwaway worktree pinned to `main`: the shared `main` ref advances (git
//     worktrees share one object DB + refs) while the dev branch is left untouched.
//     This is the whole point — a single checkout used to serve both the running
//     server AND live dev sessions no longer makes a land fail (or force someone's
//     branch to move) just because a session is parked on a feature branch.
//   • NO push — landing is local only; the release pipeline stays the sole pusher.
//   • On any non-zero merge we `merge --abort`, so main is never left mid-conflict.
//   • Serialized per repo path, so two approvals on the same project can't race.

import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { countOwnCommits, otherLocalBranches } from "./own-commits";

export type AutoMergeResult =
  | {
      status: "merged"; commit: string; branch: string; repoPath: string;
      /** Landing introduced files under client/ → the served bundle is stale until a rebuild. */
      touchedClient: boolean;
      /** Landing touched server code (server/ or server.ts) → live process needs a restart. */
      touchedServer: boolean;
      /** Landing touched desktop-tauri/ → the native shell needs a cargo rebuild + relaunch. */
      touchedNative: boolean;
      /**
       * The merge landed on `main` but the SHARED checkout (which the live server
       * runs from) is parked on another branch — so the landed code is on main yet
       * NOT running. The caller must say so loudly (and must NOT rebuild/relaunch
       * off the shared checkout, whose working tree is that other branch, not main).
       */
      landedNotLive: boolean;
      /** Branch the shared checkout is currently on (the live branch). */
      checkoutBranch: string;
      /**
       * Ciò che è stato pubblicato NON coincide con la consegna che il reviewer
       * ha approvato (ramo diverso, commit aggiunti dopo, commit di consegna
       * riscritto): frase pronta per il thread. `null` = pubblicato esattamente
       * lo scatto della consegna, non c'è niente da dire.
       */
      deliveryDrift: string | null;
    }
  | { status: "conflict"; branch: string }
  | { status: "nothing"; branch: string; deliveryDrift?: string | null }
  | { status: "skipped"; reason: string; code?: LandSkipCode };

/**
 * PERCHÉ il land non ha atterrato niente. La frase (`reason`) è per l'umano; il
 * codice è per la macchina, e serve a una decisione sola: dove finisce la card.
 *
 * Senza di lui «non c'era un branch da landare» (la card è chiusa e va bene) e
 * «non so quali commit siano suoi» (la card è chiusa col codice FUORI da main)
 * erano la STESSA risposta — e la board le mostrava tutte e due in Done. Misurato
 * l'11/08 sulla card `2e6964cb`: il thread diceva «Land NON riuscito … il branch
 * NON è su main», lo stato diceva `done`, e il lavoro è sopravvissuto solo perché
 * qualcuno ha riletto il thread prima che il GC potasse il ramo.
 */
export type LandSkipCode =
  /** Niente worktree/branch: non c'era proprio niente da atterrare. L'unico che lascia la card chiusa. */
  | "no-branch"
  /** Il branch non esiste più o non è confrontabile con l'integrazione. */
  | "branch-missing"
  /** La card DICHIARA un ramo, ma non si trova il checkout del suo progetto: il ramo resta fuori da main. */
  | "repo-unresolved"
  /** Non si sa QUALI commit siano della card: la sottrazione non ha risposto, o ha risposto vuoto. */
  | "unisolable"
  /** Si sa che il branch porta anche lavoro di un'altra sessione: non lo si pubblica. */
  | "foreign-commits"
  /** Il checkout condiviso ha WIP: non si fonde il lavoro non committato di nessuno. */
  | "dirty-checkout"
  /** Il worktree usa-e-getta su cui atterrare non si è potuto creare. */
  | "worktree-add-failed"
  /** Eccezione durante il land. */
  | "internal-error";

/** Cosa succede alla CARD quando il land non atterra. */
export interface LandFallout {
  /**
   * Dove finisce la card. `null` = resta chiusa, ed è legittimo: non c'era
   * niente da atterrare. Ogni altro codice la TOGLIE da Done, perché Done è
   * l'unica colonna che si guarda quando si tira una riga e una card lì dentro
   * col codice fuori da main è lavoro che nessuno cerca più.
   */
  status: "in_progress" | "review" | null;
  /**
   * La causa, destinata alla riga di STORICO (`statusReason`), non al solo
   * thread: il thread lo si legge aprendo la card, lo stato lo si vede dalla
   * board. Il guasto era esattamente questo — thread onesto, stato che diceva
   * il contrario.
   */
  reason: string;
  /**
   * L'istruzione con cui ri-svegliare l'agente. Presente solo dove è il RAMO a
   * essere sbagliato e quindi c'è qualcosa che l'agente può fare (rifare la
   * base sul main aggiornato). Assente = il guasto è dell'ospite (albero
   * sporco, worktree non creabile, git in errore): l'agente non può ripararlo,
   * e la card torna all'umano.
   */
  resume?: string;
}

/** L'istruzione per l'agente quando è il suo ramo a non essere pubblicabile. */
const REBASE_INSTRUCTION =
  "Il land del tuo branch su main non è riuscito: dal ramo non si riesce a isolare il lavoro di questa card " +
  "(porta anche commit che non sono suoi, o non se ne distingue nessuno). Rifai la BASE del tuo ramo sul main " +
  "aggiornato (`git fetch` se serve, poi `git rebase main`), NON un merge di main dentro il ramo: dopo la rebase " +
  "il ramo deve portare SOLO i tuoi commit. Poi rimetti in review con update_task(status=\"review\"). " +
  "Resta vietato toccare main: niente push, niente merge verso main.";

/**
 * Dal perché-non-è-atterrato a dove-finisce-la-card. Pura, così la regola si
 * prova senza un repo e senza una board.
 *
 * Il conflitto aveva già la risposta giusta (torna all'agente); lo `skipped` no,
 * e trattava allo stesso modo l'unico caso innocuo e tutti quelli in cui il
 * codice resta fuori da main. Un codice sconosciuto (un `skipped` costruito
 * altrove, o uno nuovo aggiunto senza passare di qui) vale come fallito: sbaglia
 * verso il rimandare indietro una card, mai verso il chiuderla.
 */
export function landFallout(code: LandSkipCode | undefined): LandFallout {
  switch (code) {
    case "no-branch":
      return { status: null, reason: "" };
    case "unisolable":
      return { status: "in_progress", reason: "il land non ha saputo isolare i commit della card", resume: REBASE_INSTRUCTION };
    case "foreign-commits":
      return { status: "in_progress", reason: "il ramo porta anche commit di un'altra sessione", resume: REBASE_INSTRUCTION };
    case "branch-missing":
      return { status: "review", reason: "il ramo consegnato non è più confrontabile con main" };
    case "repo-unresolved":
      return { status: "review", reason: "non si trova il checkout del progetto su cui atterrare il ramo consegnato" };
    case "dirty-checkout":
      return { status: "review", reason: "il checkout condiviso ha lavoro non committato" };
    case "worktree-add-failed":
      return { status: "review", reason: "il worktree su cui atterrare non si è potuto creare" };
    default:
      return { status: "review", reason: "il land non è riuscito e il codice non è su main" };
  }
}

/** Where a task's work lives, resolved from its dispatch topic → worktree → project. */
export interface TaskMergeTarget {
  /** Absolute path of the project's MAIN checkout (the merge target). */
  repoPath: string;
  /** The task's worktree branch, e.g. `topics/lyrical-cobra`. */
  branch: string;
  /** Branch to merge INTO (the integration branch). */
  defaultBranch: string;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Cosa la card ha CONSEGNATO: il ramo e il commit registrati quando è entrata in
 * review (`tasks.delivery_branch` / `delivery_commit`). È l'unica descrizione di
 * ciò che il reviewer ha guardato prima di cliccare «Landa su main» — il
 * worktree vivo della card può nel frattempo puntare altrove.
 */
export interface DeliverySnapshot {
  branch: string | null;
  commit: string | null;
}

/**
 * Ciò che la CARD dichiara di aver consegnato, letto dalla card e non
 * dall'agente: il ramo (`tasks.delivery_branch`) e il checkout del suo
 * progetto. Sopravvive al rilascio dell'agente, che è il punto.
 */
export interface DeclaredDelivery {
  /** Checkout principale del progetto della card. `null` = non risolto. */
  repoPath: string | null;
  /** Il ramo registrato alla consegna. `null` = la card non ne dichiara uno. */
  branch: string | null;
}

/** Il ramo scelto per il land, o il perché non ce n'è uno. */
export type MergeTargetChoice =
  | { target: TaskMergeTarget; via: "worktree" | "delivery" }
  | { target: null; code: LandSkipCode; reason: string };

/**
 * Dove atterra il lavoro della card. Pura: la regola si prova senza un repo.
 *
 * Il land risolveva il ramo SOLO attraverso l'agente (card → `assigned_topic_id`
 * → topic → worktree → branch). L'agente però viene rilasciato di routine — a
 * fine turno, e ogni volta che lo si ferma a mano — e da quel momento la
 * consegna diventava non-landabile: `resolveTaskMerge` rispondeva `null`, il
 * land rispondeva `no-branch` (l'unico codice che LASCIA la card chiusa) e la
 * card restava in Done col ramo intatto lì accanto. Misurato la notte del 12/08
 * su `ee5ebbb4`: `delivery_branch = topics/transient-berry` esisteva, il suo
 * worktree esisteva, mancava solo `assigned_topic_id` — e il messaggio diceva
 * «nessun worktree/branch», che era falso.
 *
 * Quindi l'agente è UN MODO di trovare il ramo, non l'unico: se la card
 * dichiara un ramo di consegna, quello basta. E il caso che lascia la card
 * chiusa torna a essere solo quello vero — nessun worktree E nessun ramo
 * dichiarato.
 */
export function chooseMergeTarget(
  live: TaskMergeTarget | null,
  declared: DeclaredDelivery | null | undefined,
  defaultBranch = "main",
): MergeTargetChoice {
  if (live) return { target: live, via: "worktree" };

  const branch = declared?.branch?.trim() || null;
  if (!branch) {
    return {
      target: null, code: "no-branch",
      reason: "la card non ha un worktree e non dichiara un ramo di consegna: non c'è niente da atterrare (girata in-place, o mai dispatchata)",
    };
  }
  const repoPath = declared?.repoPath?.trim() || null;
  if (!repoPath) {
    return {
      target: null, code: "repo-unresolved",
      reason: `la card consegna il ramo \`${branch}\` ma non si trova il checkout del suo progetto: il ramo NON è su main`,
    };
  }
  return { target: { repoPath, branch, defaultBranch }, via: "delivery" };
}

export interface AutoMergeDeps {
  /**
   * Resolve a task to its merge target. `null` ⇒ nothing to merge (the task ran
   * in-place with no worktree, or its worktree isn't a `branch`-mode one).
   */
  resolveTaskMerge: (taskId: string) => TaskMergeTarget | null;
  /**
   * Il ripiego che non passa dall'agente: ciò che la CARD dichiara di aver
   * consegnato. Consultato solo quando `resolveTaskMerge` non risolve nulla.
   */
  declaredDelivery?: (taskId: string) => DeclaredDelivery | null;
  /** Injected for tests. Default: real `git` via Bun.spawn (never throws — returns the code). */
  runGit?: (cwd: string, args: string[]) => Promise<GitRunResult>;
  /**
   * Injected for tests. Default: `bun run build:client` via Bun.spawn with a
   * 5-minute kill switch (a wedged vite must never pin the approve queue).
   */
  runBuild?: (cwd: string) => Promise<GitRunResult>;
  log?: (msg: string, err?: unknown) => void;
}

async function defaultRunGit(cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** La firma del «manca un pezzo sotto» nell'output di git. */
const MISSING_BASE = /modify\/delete|deleted in|does not exist|no such file/i;

/** Dove vivono le migration numerate (il gate qui sotto le confronta per NUMERO). */
const MIGRATIONS_DIR = "server/db/migrations";

const BUILD_TIMEOUT_MS = 5 * 60_000;

async function defaultRunBuild(cwd: string): Promise<GitRunResult> {
  try {
    const proc = Bun.spawn(["bun", "run", "build:client"], { cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, BUILD_TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

export function createTaskAutoMerge(deps: AutoMergeDeps) {
  const runGit = deps.runGit ?? defaultRunGit;
  const runBuild = deps.runBuild ?? defaultRunBuild;
  const log = deps.log ?? (() => {});

  // Serialize per repo path so two approvals on the same project never run
  // overlapping git operations against the same working tree.
  const queues = new Map<string, Promise<unknown>>();
  function chain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    queues.set(key, tail);
    return next;
  }

  /**
   * Il ramo da pubblicare, e cosa dire se non è lo scatto della consegna.
   *
   * Il land risolve il ramo dal worktree VIVO della card (`resolveTaskMerge`),
   * ma una card che è stata ri-dispatchata più volte ha avuto PIÙ worktree e più
   * rami: il binding vivo non è per forza quello che il reviewer ha approvato.
   * Misurato l'11/08 sulla card `e54a9be6`: consegnata su `topics/cheery-shepherd`
   * (dove l'umano aveva anche aggiunto il commit che rimetteva `lint` a 0), il
   * land ha mergiato `topics/gilded-galleon` — un altro ramo della STESSA card,
   * con una copia più vecchia dello stesso lavoro — e poi l'ha potato. Su main è
   * atterrata la copia vecchia, `lint` è tornato rosso, e il thread non ha detto
   * niente perché per il land era un merge riuscito come tutti gli altri.
   *
   * Quindi: si pubblica il ramo CONSEGNATO quando esiste, e ogni scostamento
   * dallo scatto della consegna (ramo diverso, commit aggiunti dopo, commit di
   * consegna riscritto da un rebase) diventa una riga nel thread.
   */
  async function resolveLanding(
    repoPath: string,
    liveBranch: string,
    delivery: DeliverySnapshot | undefined,
  ): Promise<{ branch: string; drift: string | null }> {
    const notes: string[] = [];
    let branch = liveBranch;

    const delBranch = delivery?.branch?.trim() || null;
    if (delBranch && delBranch !== liveBranch) {
      const exists = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${delBranch}^{commit}`]);
      if (exists.code === 0 && exists.stdout.trim() !== "") {
        branch = delBranch;
        notes.push(
          `pubblico il ramo CONSEGNATO \`${delBranch}\`, non \`${liveBranch}\` a cui punta il worktree vivo della card: ` +
          `la card ha avuto più rami e quello approvato è il primo`,
        );
      } else {
        notes.push(
          `il ramo consegnato \`${delBranch}\` non esiste più (potato o rinominato): pubblico \`${liveBranch}\`, ` +
          `il ramo del worktree vivo. Se la consegna aveva commit solo lì, NON sono su main`,
        );
      }
    }

    const delCommit = delivery?.commit?.trim() || null;
    if (delCommit) {
      const reachable = await runGit(repoPath, ["merge-base", "--is-ancestor", delCommit, branch]);
      if (reachable.code === 0) {
        const after = await runGit(repoPath, ["rev-list", "--count", `${delCommit}..${branch}`]);
        const n = Number(after.stdout.trim());
        if (after.code === 0 && Number.isFinite(n) && n > 0) {
          notes.push(
            `il ramo porta ${n} commit ${n === 1 ? "aggiunto" : "aggiunti"} DOPO la consegna ` +
            `(lo scatto approvato era \`${delCommit.slice(0, 8)}\`): ${n === 1 ? "lo pubblico" : "li pubblico"} anch${n === 1 ? "e lui" : "e loro"}`,
          );
        }
      } else {
        notes.push(
          `il commit consegnato \`${delCommit.slice(0, 8)}\` non è raggiungibile da \`${branch}\` ` +
          `(ribasato o riscritto dopo la consegna): pubblico la punta del ramo, che può non essere ciò che hai approvato`,
        );
      }
    }

    return { branch, drift: notes.length > 0 ? notes.join("; ") : null };
  }

  async function tryMerge(taskId: string, title: string, delivery?: DeliverySnapshot): Promise<AutoMergeResult> {
    const choice = chooseMergeTarget(
      deps.resolveTaskMerge(taskId),
      deps.declaredDelivery?.(taskId) ?? null,
    );
    if (!choice.target) {
      return { status: "skipped", code: choice.code, reason: choice.reason };
    }
    const target = choice.target;
    const { repoPath, defaultBranch } = target;

    // Riempiti da `resolveLanding` prima di qualunque merge: `branch` è il ramo
    // che si pubblica davvero, `drift` la frase da mettere nel thread.
    let branch = target.branch;
    let drift: string | null = null;

    const mergeMsg = `merge task ${taskId}: ${title}`.replace(/\s+/g, " ").slice(0, 200);

    // First-parent diff = exactly what this landing introduced on main. `cwd` is
    // wherever the merge happened (the shared checkout, or the throwaway main
    // worktree). The caller reacts per area: client/ → rebuild the served bundle,
    // server → restart, desktop-tauri → native rebuild.
    async function finishMerged(cwd: string, live: boolean, checkoutBranch: string): Promise<AutoMergeResult> {
      const rev = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
      const diff = await runGit(cwd, ["diff", "--name-only", "HEAD^1", "HEAD"]);
      const files = diff.code === 0 ? diff.stdout.split("\n").filter(Boolean) : [];
      return {
        status: "merged", commit: rev.stdout.trim(), branch, repoPath,
        touchedClient: files.some((f) => f.startsWith("client/")),
        touchedServer: files.some((f) => f.startsWith("server/") || f === "server.ts"),
        touchedNative: files.some((f) => f.startsWith("desktop-tauri/")),
        landedNotLive: !live, checkoutBranch,
        deliveryDrift: drift,
      };
    }

    /**
     * Porta su `cwd` SOLO i commit della card, in ordine, con `cherry-pick`.
     *
     * Serve quando il branch del task e' nato dall'HEAD del checkout condiviso e
     * porta anche il lavoro di chi ci stava lavorando: mergiare il branch
     * pubblicherebbe roba di altri, rifiutarsi lascia la consegna in un limbo.
     * Si prende la terza strada — i suoi commit e basta.
     */
    /**
     * «Conflitto» e «manca un pezzo sotto» sono due cose diverse, e all'agente
     * servono due risposte diverse: nel primo caso deve riconciliare, nel
     * secondo non c'è niente da riconciliare — il suo lavoro poggia su commit
     * di un'altra sessione che non sono ancora su main, e finché non ci
     * arrivano il pick fallirà uguale ogni volta che riprova.
     */
    function conflictOrDependency(missingBase?: boolean, dependsOn?: number): AutoMergeResult {
      // Che ci siano commit estranei non prova niente: il pick selettivo parte
      // PROPRIO perché ce ne sono. La prova è la natura del fallimento — git
      // dice `modify/delete` quando il file che il commit modifica non esiste
      // di qua, ed è la firma del pezzo mancante. Un conflitto di CONTENUTO
      // resta un conflitto, e torna all'agente come prima.
      if (!missingBase || !dependsOn) return { status: "conflict", branch };
      return {
        status: "skipped",
        reason:
          `il lavoro di questa card poggia su ${dependsOn} commit che stanno sul branch ` +
          `'${branch}' ma NON sono suoi e non sono ancora su '${defaultBranch}': ` +
          "non è un conflitto da riconciliare, manca un pezzo sotto. " +
          "Landa prima quel lavoro, oppure ribasa la card su " + defaultBranch + ".",
      };
    }

    /**
     * Un numero di migration presente su ENTRAMBI i rami ma con nomi diversi.
     * Torna la ragione da mostrare, o null se non c'e' collisione.
     */
    async function migrationCollision(): Promise<string | null> {
      const read = async (ref: string): Promise<Map<string, string>> => {
        const r = await runGit(repoPath, ["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_DIR]);
        const out = new Map<string, string>();
        if (r.code !== 0) return out;
        for (const path of r.stdout.split("\n")) {
          const file = path.trim().split("/").pop() ?? "";
          // Il numero e' la RUN di cifre davanti al trattino, non i primi tre
          // caratteri. Le due forme convivono: il contatore storico (`089-`) e il
          // timestamp introdotto il 12/08 (`20260812094300-`), che e' la cura alle
          // collisioni. Leggere `slice(0, 3)` mandava OGNI migration del 2026
          // sotto la stessa chiave `202`: due rami con timestamp diversi si
          // dichiaravano in collisione, e il cancello rifiutava ogni land in cui
          // main e il ramo non avessero esattamente le stesse migration. Misurato
          // stanotte su `ddf66270` e `b06bb837`, e con 18 consegne ferme fuori da
          // main. Un cancello che scatta sempre non protegge: si aggira.
          const m = /^(\d+)-/.exec(file);
          if (m) out.set(m[1]!, file);
        }
        return out;
      };
      const [base, mine] = await Promise.all([read(defaultBranch), read(branch)]);
      const clash: string[] = [];
      for (const [n, file] of mine) {
        const other = base.get(n);
        if (other && other !== file) clash.push(`${n}: '${defaultBranch}' ha ${other}, il ramo ha ${file}`);
      }
      if (clash.length === 0) return null;
      return (
        `collisione di numeri di migration (${clash.join(" · ")}). Il registro conta i NUMERI e il ` +
        "runner salta in silenzio: la seconda non si applicherebbe mai, e il codice che la presuppone " +
        "atterrerebbe lo stesso. Rinumera la migration del RAMO (mai quelle gia' applicate) e rigenera il manifest."
      );
    }

    /**
     * Quanti commit sul branch NON sono di questa card e non sono ancora su
     * main. Sono le sue DIPENDENZE possibili: il worktree nasce dall'HEAD del
     * checkout condiviso, quindi il lavoro della card può poggiare su commit di
     * un'altra sessione che il pick selettivo esclude per non pubblicarli.
     *
     * Quando succede, il pick fallisce su un file che su main non esiste ancora
     * — ed è un'informazione diversa da «conflitto»: non c'è niente da
     * riconciliare, manca un pezzo sotto. Dirlo cambia cosa fa l'agente.
     */
    async function unlandedForeign(cwd: string, mine: number): Promise<number> {
      const tot = await runGit(cwd, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
      const n = Number.parseInt(tot.stdout.trim(), 10);
      return Number.isFinite(n) && n > mine ? n - mine : 0;
    }

    async function pickOwnCommits(
      cwd: string,
      own: { others: string[] },
    ): Promise<{ ok: boolean; conflict: boolean; dependsOn?: number; missingBase?: boolean }> {
      const list = await runGit(cwd, ["rev-list", "--reverse", `${defaultBranch}..${branch}`, "--not", ...own.others]);
      const all = list.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
      if (list.code !== 0 || all.length === 0) return { ok: false, conflict: false };
      // Un commit già landato resta nel range: `rev-list` guarda la discendenza,
      // e il land RICOPIA invece di fondere, quindi la copia atterrata ha un altro
      // sha. Rilandare la stessa card aggiungeva un commit VUOTO a main — successo
      // apparente, e una storia che dice «landato due volte».
      //
      // Non si riconosce dal patch-id (`git cherry`): il pick ADATTA il commit al
      // main del momento, quindi la copia atterrata ha un patch-id diverso
      // dall'originale. Nemmeno dalla patch a rovescio: appena qualcun altro tocca
      // quei file, le righe di contorno non combaciano più. Misurato il 10/08:
      // entrambe le strade hanno lasciato passare lo stesso commit, comparso
      // QUATTRO volte su main.
      //
      // La domanda giusta la sa rispondere solo il merge di git: si applica il
      // commit SENZA committare e si guarda se resta qualcosa. Niente in stage =
      // quel contenuto è già nell'albero, comunque ci sia arrivato.
      let brought = 0;
      for (const sha of all) {
        const r = await runGit(cwd, ["cherry-pick", "-n", "--allow-empty", sha]);
        if (r.code !== 0) {
          // `--quit` lascia l'albero com'è, poi lo si riporta a HEAD: `--abort`
          // da solo non basta dopo un `-n` andato male.
          await runGit(cwd, ["cherry-pick", "--quit"]).catch(() => undefined);
          await runGit(cwd, ["reset", "--hard", "HEAD"]).catch(() => undefined);
          return {
            ok: false, conflict: true,
            missingBase: MISSING_BASE.test(`${r.stderr}\n${r.stdout}`),
            dependsOn: await unlandedForeign(cwd, all.length),
          };
        }
        const staged = await runGit(cwd, ["diff", "--cached", "--quiet", "HEAD"]);
        if (staged.code === 0) {
          // Niente da portare: già applicato. Si pulisce e si passa oltre.
          await runGit(cwd, ["cherry-pick", "--quit"]).catch(() => undefined);
          await runGit(cwd, ["reset", "--hard", "HEAD"]).catch(() => undefined);
          continue;
        }
        // `-C` tiene messaggio E autore dell'originale: il lavoro resta di chi
        // l'ha fatto, non di chi ha premuto «landa».
        const c = await runGit(cwd, ["commit", "--no-edit", "-C", sha]);
        if (c.code !== 0) {
          await runGit(cwd, ["cherry-pick", "--quit"]).catch(() => undefined);
          await runGit(cwd, ["reset", "--hard", "HEAD"]).catch(() => undefined);
          return { ok: false, conflict: true, dependsOn: await unlandedForeign(cwd, all.length) };
        }
        brought++;
      }
      // Zero portati = era già tutto su main. È una consegna riuscita, non un
      // fallimento da rimandare all'agente.
      if (brought === 0) return { ok: true, conflict: false };
      return { ok: true, conflict: false };
    }

    return chain(repoPath, async (): Promise<AutoMergeResult> => {
      try {
        const head = await runGit(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
        const cur = head.stdout.trim();

        // Quale ramo si pubblica, e cosa dire se non è lo scatto della consegna.
        // PRIMA di ogni controllo: tutto quello che segue (ahead, commit propri,
        // merge) deve parlare del ramo che atterrerà davvero.
        const landing = await resolveLanding(repoPath, branch, delivery);
        branch = landing.branch;
        drift = landing.drift;

        // Does the branch exist and have commits main doesn't? (Refs are shared
        // across every worktree, so this reads the same from the shared checkout.)
        const ahead = await runGit(repoPath, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
        if (ahead.code !== 0) {
          return { status: "skipped", code: "branch-missing", reason: `branch '${branch}' non trovato o non confrontabile con '${defaultBranch}'` };
        }
        if (ahead.stdout.trim() === "0") {
          return { status: "nothing", branch, deliveryDrift: drift };
        }

        // ── Numeri di migration: due card in parallelo se li prendono uguali ──
        //
        // `schema_migrations.version` e' CHIAVE PRIMARIA INTERA e il runner fa
        // `if (applied.has(version)) continue` (server/db.ts): salta per NUMERO e
        // in silenzio. Due file `089-*.sql` diversi vogliono dire che il secondo
        // non si applica MAI — nemmeno ai riavvii — mentre il codice che lo
        // presuppone atterra lo stesso. Il guasto non si vede al land: si vede in
        // produzione, come una query su colonne che non esistono.
        //
        // Misurato il 10/08: DUE collisioni in una sera. Con N card in parallelo
        // e' l'esito normale di due migration scritte lo stesso giorno, non la
        // sfortuna di qualcuno — quindi il posto giusto e' un cancello, non la
        // memoria di chi rivede.
        const collision = await migrationCollision();
        if (collision) return { status: "skipped", reason: collision };

        // ── Il branch porta SOLO il lavoro di questo task? ──────────────────
        //
        // Il worktree di una card NASCEVA da `baseRef: "HEAD"` (server.ts), cioè
        // dall'HEAD del checkout CONDIVISO — che quando qualcuno sta lavorando
        // non è main ma il suo branch. Il branch del task ereditava quindi tutti
        // i commit di quella linea, e questo merge li porterebbe su main insieme
        // ai suoi: «Landa su main» pubblicherebbe lavoro non finito di un'altra
        // sessione, con un click che sembra innocuo.
        //
        // Alla radice ora si parte da `main` (`worktree-base-ref.ts`), ma questo
        // controllo RESTA: i rami nati prima portano ancora quell'eredità, il
        // ripiego su HEAD sopravvive nei repo senza `main`, e un worktree in
        // modo `reuse` parte da un branch che l'umano ha scelto.
        //
        // Successo davvero il 2026-08-09: card dispatchata con il checkout su
        // `topics/gruppi-spazi-pulizia`, e il suo branch portava 13 commit che
        // main non aveva, sei dei quali di un'altra sessione viva. Si è visto
        // solo perché il merge è finito in conflitto — fortuna, non progetto.
        //
        // Il discrimine non ha bisogno di ricordare da dove il worktree è nato:
        // un commit EREDITATO è raggiungibile anche da un ALTRO branch locale,
        // uno fatto dentro questo worktree no. Quindi `--not <gli altri branch>`
        // lascia esattamente i commit del task — la sottrazione vive in
        // `own-commits.ts`, perché è la STESSA domanda che si fa la consegna
        // quando registra cosa ha prodotto la card: due copie divergerebbero, e
        // la copia sbagliata è quella che pubblica il lavoro di un altro.
        //
        // Tre risposte, non due. `own-commits.ts` distingue già «verificato: non
        // ne ha» (`0`) da «non contabile» (`null`), e QUI quella distinzione va
        // tenuta: il land ha un solo modo di dire «non faccio niente» e finché
        // ci finiscono dentro sia «è già tutto su main» sia «non so quali siano
        // i suoi», la card resta in Done in entrambi i casi. Il secondo è il
        // caso in cui il codice NON è su main.
        //
        //   · `null`  — git non ha risposto: non si tocca niente (`unisolable`).
        //   · `0` con il branch AVANTI — la sottrazione ha tolto tutto, cioè
        //     ogni commit del ramo è raggiungibile anche da un altro ramo
        //     locale. Normalissimo (un ramo nato da un altro, due card vicine),
        //     e NON vuol dire «niente da portare»: vuol dire che di quel ramo
        //     non si sa cosa sia suo (`unisolable`). «Niente da portare» è
        //     `ahead === 0`, ed è già uscito sopra come `nothing`.
        //   · `0 < mine < total` — si sa, ed è misto: `foreign-commits`.
        //
        // E quando si SA e il ramo è misto, non ci si ferma: si atterrano SOLO
        // i suoi (`onlyOwn` → `pickOwnCommits`). Rifiutarsi e basta teneva main
        // pulito lasciando il lavoro in un limbo — misurato: 12 consegne
        // accettate vivevano solo sul loro branch, fra cui uno scorporo da 800
        // righe e una rimozione da 21.775.
        /** Quando il branch porta anche commit non suoi: si prendono solo i suoi. */
        let onlyOwn: { total: number; mine: number; others: string[] } | null = null;
        const others = await otherLocalBranches(repoPath, branch, { mainRef: defaultBranch, runGit });
        if (others === null) {
          return {
            status: "skipped", code: "unisolable",
            reason:
              `non ho potuto elencare i branch di '${repoPath}', quindi non so quali commit di '${branch}' siano di questa card: ` +
              "non pubblico un ramo che potrebbe portare lavoro di un'altra sessione",
          };
        }
        if (others.length > 0) {
          const mine = await countOwnCommits(repoPath, branch, { mainRef: defaultBranch, runGit, others });
          const total = Number(ahead.stdout.trim());
          if (mine === null) {
            return {
              status: "skipped", code: "unisolable",
              reason: `git non ha saputo dire quali dei commit di '${branch}' siano di questa card: non pubblico un ramo che non so leggere`,
            };
          }
          if (Number.isFinite(total) && total > 0 && mine === 0) {
            return {
              status: "skipped", code: "unisolable",
              reason:
                `il branch '${branch}' porta ${total} commit che '${defaultBranch}' non ha, ma togliendo quelli raggiungibili dagli altri ` +
                `${others.length} branch locali non ne resta NESSUNO: non è «niente da portare» (quello sarebbe zero commit avanti), ` +
                "è «non so quali siano i suoi». Succede quando il ramo della card è raggiungibile anche da un altro ramo. " +
                `Guarda con \`git log --oneline ${defaultBranch}..${branch}\`, poi cancella il ramo di troppo o cherry-picka a mano`,
            };
          }
          if (Number.isFinite(total) && total > mine) {
            // Si sa QUALI sono i suoi (`mine > 0`): il ramo è misto ma leggibile.
            // Qui main si fermava con `foreign-commits`, che è una diagnosi
            // giusta e una conseguenza sbagliata — il lavoro della card resta
            // sul branch finché qualcuno non lo cherry-picka a mano, e nessuno
            // lo fa. Si portano i suoi e basta.
            onlyOwn = { total, mine, others };
          }
        }

        // Fast path: the shared checkout is ALREADY on main → merge in place, so a
        // hot-reload/rebuild makes the landing live immediately. Requires a clean
        // tree: never fold a concurrent session's WIP into the merge.
        if (cur === defaultBranch) {
          const st = await runGit(repoPath, ["status", "--porcelain"]);
          if (st.stdout.trim() !== "") {
            return { status: "skipped", code: "dirty-checkout", reason: `il checkout è su '${defaultBranch}' con WIP non committata. Mergia a mano o pulisci il checkout` };
          }
          if (onlyOwn) {
            const picked = await pickOwnCommits(repoPath, onlyOwn);
            if (picked.ok) return finishMerged(repoPath, /*live*/ true, cur);
            if (picked.conflict) return conflictOrDependency(picked.missingBase, picked.dependsOn);
            return {
              status: "skipped", code: "unisolable",
              reason: `non sono riuscito a isolare i ${onlyOwn.mine} commit di questa card su '${branch}'`,
            };
          }
          // --no-ff keeps a merge commit so the landing is auditable even for a FF.
          const merge = await runGit(repoPath, ["merge", "--no-ff", "-m", mergeMsg, branch]);
          if (merge.code === 0) return finishMerged(repoPath, /*live*/ true, cur);
          await runGit(repoPath, ["merge", "--abort"]).catch(() => undefined);
          return { status: "conflict", branch };
        }

        // The shared checkout is parked on a dev branch (a live session). Land in a
        // throwaway worktree pinned to main: the shared `main` ref advances, the dev
        // branch is untouched, nobody's branch has to move. The landing is on main
        // but NOT running yet (the live server serves `cur`) → landedNotLive.
        const wtPath = join(tmpdir(), "topics-land", createHash("sha1").update(repoPath).digest("hex").slice(0, 16));
        // Clear any leftover from a previous crashed land before re-adding.
        await runGit(repoPath, ["worktree", "remove", "--force", wtPath]).catch(() => undefined);
        await runGit(repoPath, ["worktree", "prune"]).catch(() => undefined);
        const add = await runGit(repoPath, ["worktree", "add", wtPath, defaultBranch]);
        if (add.code !== 0) {
          return { status: "skipped", code: "worktree-add-failed", reason: `impossibile creare il worktree di land su '${defaultBranch}': ${(add.stderr || add.stdout).trim().slice(-200) || "git worktree add fallito"}` };
        }
        try {
          if (onlyOwn) {
            const picked = await pickOwnCommits(wtPath, onlyOwn);
            if (picked.ok) return await finishMerged(wtPath, /*live*/ false, cur || "detached HEAD");
            if (!picked.conflict) {
              return {
              status: "skipped", code: "unisolable",
              reason: `non sono riuscito a isolare i ${onlyOwn.mine} commit di questa card su '${branch}'`,
            };
            }
            return conflictOrDependency(picked.missingBase, picked.dependsOn);
          } else {
          const merge = await runGit(wtPath, ["merge", "--no-ff", "-m", mergeMsg, branch]);
          if (merge.code === 0) return await finishMerged(wtPath, /*live*/ false, cur || "detached HEAD");
          await runGit(wtPath, ["merge", "--abort"]).catch(() => undefined);
          }
          return { status: "conflict", branch };
        } finally {
          await runGit(repoPath, ["worktree", "remove", "--force", wtPath]).catch(() => undefined);
          await runGit(repoPath, ["worktree", "prune"]).catch(() => undefined);
        }
      } catch (e) {
        log(`[automerge] tryMerge failed for ${taskId}`, e);
        // Best-effort cleanup, then report as a skip so the approve never breaks.
        await runGit(repoPath, ["merge", "--abort"]).catch(() => undefined);
        return { status: "skipped", code: "internal-error", reason: `errore interno durante il merge: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
  }

  /**
   * Rebuild the served client bundle after a landing that touched client/.
   * Rides the same per-repo queue as tryMerge, so a build never overlaps a
   * merge (or another build) on the same checkout.
   */
  function buildClient(repoPath: string): Promise<GitRunResult> {
    return chain(repoPath, () => runBuild(repoPath));
  }

  /**
   * Run `fn` only after every git operation currently queued on `repoPath`
   * has drained. Used to schedule the post-landing self-restart: an exit that
   * fires while a LATER approval's merge is mid-flight would leave the main
   * checkout mid-merge.
   */
  function whenIdle(repoPath: string, fn: () => void): void {
    void chain(repoPath, async () => { fn(); });
  }

  return { tryMerge, buildClient, whenIdle };
}

export type TaskAutoMerge = ReturnType<typeof createTaskAutoMerge>;

/**
 * Generated artifacts that agent tooling drops into a worktree — never part of
 * the deliverable, never a reason to refuse a review or keep a worktree alive.
 */
const WORKTREE_JUNK = [/^\.topics-daemon\//, /^graphify-out\//, /^\.claude-task-summary\.md$/];

/**
 * Paths with REAL uncommitted changes in `path` (tracked modifications plus
 * non-junk untracked files). Empty array = the worktree's work is fully
 * committed (or the status call failed — the caller must not hard-fail on a
 * git hiccup). Used as the structural review gate: an agent that "delivers"
 * with work still sitting uncommitted in its worktree gets a 409 coaching it
 * to commit first — the failure mode prompts alone never fixed.
 */
export async function worktreeRealDirt(
  path: string,
  runGit: (cwd: string, args: string[]) => Promise<GitRunResult> = defaultRunGit,
): Promise<string[]> {
  const st = await runGit(path, ["status", "--porcelain"]);
  if (st.code !== 0) return [];
  return st.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .filter((p) => !WORKTREE_JUNK.some((rx) => rx.test(p)));
}
