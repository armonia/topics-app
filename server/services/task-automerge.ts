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
import { commitIsIn, countOwnCommits, otherLocalBranches } from "./own-commits";
import { gitEnvFor } from "../lib/git-identity";
import { MIGRATIONS_DIR, findNumberCollisions } from "../../shared/migration-numbers";
import { makeSerialQueue } from "../lib/serial-queue";

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
      /**
       * Il ramo era INDIETRO su main e il land l'ha riallineato da se': frase
       * pronta per il thread. `null` = era gia' aggiornato, non c'e' niente da
       * dire. Chi legge deve sapere che sul ramo e' comparso un merge che non
       * ha fatto lui.
       */
      realigned: string | null;
    }
  | {
      status: "conflict"; branch: string;
      /**
       * Il conflitto e' nato RIPORTANDO main nel ramo, non pubblicando il ramo
       * su main: sono due lavori diversi per l'agente, e i file sono l'unica
       * cosa che gli dice dove guardare. Assente = conflitto del land.
       */
      realignConflict?: { behind: number; files: string[] };
    }
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
  /**
   * Il ramo è indietro su main e il riallineamento non si è potuto nemmeno
   * PROVARE (il worktree del ramo ha WIP, o non si è potuto crearne uno). Non è
   * un conflitto: nessuno ha ancora tentato una fusione.
   */
  | "realign-blocked"
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
    case "realign-blocked":
      return { status: "review", reason: "il ramo è indietro su main e il riallineamento non si è potuto provare" };
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
    // L'identità di chi firma, e solo dove manca: il land CREA commit (i due
    // merge e i cherry-pick), e git senza identità esce 128 prima di toccare
    // l'albero. Il perché e la regola del ripiego stanno in `git-identity.ts`.
    const env = await gitEnvFor(cwd);
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
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
  // overlapping git operations against the same working tree (task e33820da).
  const repoQueue = makeSerialQueue();
  function chain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return repoQueue.enqueue(key, fn);
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
    /** Riempita dal riallineamento, se c'è stato: la frase per il thread. */
    let realigned: string | null = null;

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
        realigned,
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
     * Il worktree in cui il ramo è già CHECKOUTATO, se ce n'è uno. `null` = il
     * ramo non è aperto da nessuna parte (l'agente è stato rilasciato e il suo
     * worktree potato), e allora ne serve uno usa-e-getta.
     *
     * Serve perché `git worktree add <path> <branch>` rifiuta un branch già
     * checkoutato altrove: la scelta fra «fondo dove il ramo vive» e «me ne
     * creo uno» non è un'ottimizzazione, è l'unico modo di non fallire.
     */
    async function branchWorktree(): Promise<string | null> {
      const r = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
      if (r.code !== 0) return null;
      let path: string | null = null;
      for (const raw of r.stdout.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim() || null;
        else if (line === `branch refs/heads/${branch}`) return path;
      }
      return null;
    }

    /**
     * Riporta `main` DENTRO il ramo, quando il ramo è indietro.
     *
     * Il perché: con N agenti in parallelo main avanza mentre la card aspetta la
     * review, e un ramo che invecchia comincia a non essere più valutabile —
     * misurato la notte del 12/08 su `ddf66270`, dove il rimedio (un merge
     * pulito, zero conflitti) l'ha dovuto fare un umano a mano nel checkout
     * perché dalla card non c'era nessun modo di dirlo. Nessuno dovrebbe fare a
     * mano una fusione che non ha conflitti.
     *
     * Le stesse cautele del land, dall'altro verso:
     *   • si fonde solo su un albero PULITO (i rifiuti degli agenti non contano,
     *     `worktreeRealDirt` li conosce): mai inglobare la WIP di qualcuno;
     *   • su conflitto `merge --abort` e si NOMINANO i file, così l'agente sa
     *     dove guardare invece di sentirsi dire «conflitto»;
     *   • niente push, niente rebase: la storia del ramo non si riscrive sotto
     *     chi la sta guardando, ci si aggiunge un merge.
     */
    async function realignOnMain(): Promise<AutoMergeResult | null> {
      // `merge-base --is-ancestor` invece di contare: una domanda sola, e la
      // risposta «main è già dentro» è quella del caso normale.
      const ancestor = await runGit(repoPath, ["merge-base", "--is-ancestor", defaultBranch, branch]);
      if (ancestor.code === 0) return null;
      const cnt = await runGit(repoPath, ["rev-list", "--count", `${branch}..${defaultBranch}`]);
      const behind = Number.parseInt(cnt.stdout.trim(), 10);
      // Non un numero = git non ha risposto (e non che il ramo sia a posto): si
      // lascia fare al land di prima, che ha già i suoi cancelli per dirlo.
      if (!Number.isFinite(behind) || behind <= 0) return null;

      const live = await branchWorktree();
      const wtPath = live ?? join(tmpdir(), "topics-realign", createHash("sha1").update(`${repoPath}\n${branch}`).digest("hex").slice(0, 16));
      if (live) {
        const dirt = await worktreeRealDirt(live, runGit);
        if (dirt.length > 0) {
          return {
            status: "skipped", code: "realign-blocked",
            reason:
              `il ramo '${branch}' è indietro di ${behind} commit su '${defaultBranch}' e va riallineato, ma il suo ` +
              `worktree (${live}) ha ${dirt.length} file non committati (${dirt.slice(0, 3).join(", ")}): ` +
              "riportare main dentro il ramo li ingloberebbe nella fusione. Committa o scarta quel lavoro, poi rilancia il land",
          };
        }
      } else {
        await runGit(repoPath, ["worktree", "remove", "--force", wtPath]).catch(() => undefined);
        await runGit(repoPath, ["worktree", "prune"]).catch(() => undefined);
        const add = await runGit(repoPath, ["worktree", "add", wtPath, branch]);
        if (add.code !== 0) {
          return {
            status: "skipped", code: "realign-blocked",
            reason:
              `il ramo '${branch}' è indietro di ${behind} commit su '${defaultBranch}' e va riallineato, ma non si è ` +
              `potuto creare un worktree su cui fonderlo: ${(add.stderr || add.stdout).trim().slice(-200) || "git worktree add fallito"}`,
          };
        }
      }

      try {
        const msg = `Riporta ${defaultBranch} nel ramo prima del land`;
        const merge = await runGit(wtPath, ["merge", "--no-edit", "-m", msg, defaultBranch]);
        if (merge.code !== 0) {
          const unmerged = await runGit(wtPath, ["diff", "--diff-filter=U", "--name-only"]);
          const files = unmerged.code === 0 ? unmerged.stdout.split("\n").map((f) => f.trim()).filter(Boolean) : [];
          await runGit(wtPath, ["merge", "--abort"]).catch(() => undefined);
          // Un merge può fallire SENZA conflitti: git si rifiuta di partire
          // perché sovrascriverebbe un file non tracciato, o l'albero non è
          // pronto. Non c'è niente da riconciliare e mandarlo all'agente come
          // «conflitto» gli farebbe cercare marcatori che non esistono: si dice
          // quello che git ha detto, e la card torna all'umano.
          if (files.length === 0) {
            return {
              status: "skipped", code: "realign-blocked",
              reason:
                `il ramo '${branch}' è indietro di ${behind} commit su '${defaultBranch}' e riportare main dentro il ramo ` +
                `non è nemmeno partito (nessun file in conflitto): ${(merge.stderr || merge.stdout).trim().slice(-300) || "git merge fallito"}`,
            };
          }
          return { status: "conflict", branch, realignConflict: { behind, files } };
        }
        realigned = `il ramo era indietro di ${behind} commit su '${defaultBranch}': ci ho riportato main dentro (fusione pulita, nessun conflitto) prima di valutare i cancelli`;
        return null;
      } finally {
        if (!live) {
          await runGit(repoPath, ["worktree", "remove", "--force", wtPath]).catch(() => undefined);
          await runGit(repoPath, ["worktree", "prune"]).catch(() => undefined);
        }
      }
    }

    /**
     * Un NUMERO di migration rivendicato da due nomi diversi. Torna la ragione
     * da mostrare, o null se non c'e' collisione.
     *
     * La regola non e' scritta qui: sta in shared/migration-numbers.ts, la
     * stessa che esegue `bun run check:migrations`. Prima ne esisteva una copia
     * locale che prendeva il numero con `file.slice(0, 3)`, e sui nomi nuovi a
     * timestamp (`20260812094300-…`) leggeva sempre «202»: ogni ramo che
     * aggiungeva una migration dopo il cambio di nomenclatura collideva con
     * qualunque migration timestamp di main. Misurato la notte del 12/08 su
     * `ddf66270` — il tasto «Landa su main» rifiutava per sempre e l'unica
     * uscita era fondere a mano. Una domanda, una risposta.
     */
    async function migrationCollision(): Promise<string | null> {
      const read = async (ref: string): Promise<string[]> => {
        const r = await runGit(repoPath, ["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_DIR]);
        // I nomi grezzi: chi decide cosa sia una collisione e' `findNumberCollisions`
        // in `shared/migration-numbers.ts`, che legge la RUN di cifre davanti al
        // trattino ed esclude del tutto i file col prefisso timestamp.
        //
        // Prima il numero si leggeva qui con `file.slice(0, 3)`, e col prefisso
        // timestamp introdotto il 12/08 ogni migration del 2026 finiva sotto la
        // stessa chiave `202`: bastava che main e il ramo avessero migration
        // diverse perche' il land venisse rifiutato per una collisione
        // inesistente. Costo letto sul posto: 18 turni di agente, $27,50, spesi a
        // rifare lavoro gia' su main. Un cancello che scatta sempre non protegge:
        // si aggira.
        return r.code === 0 ? r.stdout.split("\n").filter((l) => l.trim() !== "") : [];
      };
      const [base, mine] = await Promise.all([read(defaultBranch), read(branch)]);
      const clash = findNumberCollisions(mine, base);
      if (clash.length === 0) return null;
      const detail = clash.map((c) => `${c.version}: ${c.files.join(" e ")}`).join(" · ");
      return (
        `collisione di numeri di migration (${detail}). Due file con lo stesso contatore vogliono dire che ` +
        "almeno uno dei due l'ha scelto credendolo libero: l'ordine che qualcuno si aspettava e' gia' saltato. " +
        "Rinumera la migration del RAMO col prefisso timestamp (`bun run migration:new <slug>`, mai le migration " +
        "gia' applicate su main) e rigenera il manifest."
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
      // `--no-merges`: un commit di FUSIONE non si ricopia con un cherry-pick
      // (git chiede `-m` e senza di quello esce non-zero), e non c'è niente da
      // ricopiare — il contenuto che porta sta nei commit dei suoi due rami, che
      // questa lista già enumera o esclude di proposito. Diventa obbligatorio da
      // quando il land riallinea il ramo su main da sé: quel merge è il primo
      // commit di fusione che compare di routine fra i commit «propri» del ramo.
      const list = await runGit(cwd, ["rev-list", "--reverse", "--no-merges", `${defaultBranch}..${branch}`, "--not", ...own.others]);
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
        let ahead = await runGit(repoPath, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
        if (ahead.code !== 0) {
          // Il ramo non c'è più, e NON vuol dire che il lavoro non sia atterrato:
          // dopo un land riuscito il ramo viene POTATO. Da quel momento ogni
          // tentativo di chiudere la card faceva ripartire un land che non
          // trovava più niente e la rispediva in review. Misurato il 12/08 su
          // `d0777424`: contenuto su main (`c2d20879`, antenato di main), ramo
          // `topics/ardent-grouse` inesistente, e la card rimbalzava a ogni
          // chiusura. Una card che non si può chiudere resta in review a sembrare
          // una decisione che non è.
          //
          // La prova la porta il COMMIT della consegna, che sopravvive al ramo: se
          // è dentro il ramo di destinazione non c'è niente da landare, ed è lo
          // stesso esito di un ramo senza commit propri (il caso qui sotto).
          //
          // La domanda sta in `commitIsIn` e non qui: il cancello del dispatch
          // decide sulla STESSA affermazione (non ripartire su lavoro già
          // atterrato), e due copie che divergono vorrebbero dire ridispacciare
          // proprio ciò che questo ramo ha appena chiuso.
          const sha = delivery?.commit?.trim();
          if (sha && (await commitIsIn(repoPath, sha, defaultBranch, { runGit })) === true) {
            return { status: "nothing", branch, deliveryDrift: drift };
          }
          return { status: "skipped", code: "branch-missing", reason: `branch '${branch}' non trovato o non confrontabile con '${defaultBranch}'` };
        }
        if (ahead.stdout.trim() === "0") {
          return { status: "nothing", branch, deliveryDrift: drift };
        }

        // ── Il ramo è INDIETRO? Prima si riallinea, poi si giudica ───────────
        //
        // Ogni cancello qui sotto confronta il ramo con main, e su un ramo
        // vecchio confronta un'istantanea che non esiste più da nessuna parte.
        // Riportare main dentro il ramo è il gesto che rende la domanda sensata,
        // ed è un gesto meccanico quando la fusione è pulita: farlo fare a mano
        // vuol dire che il tasto «Landa su main» resta rotto per sempre su ogni
        // card che aspetta la review più di qualche ora (misurato: main ha
        // guadagnato una migration in mezz'ora la notte del 12/08).
        //
        // DOPO il controllo qui sopra, non prima: se il ramo non porta niente
        // non c'è nessun land da salvare, e riallinearlo sarebbe un merge
        // gratuito su un ramo che sta per essere potato.
        const realign = await realignOnMain();
        if (realign) return realign;
        if (realigned) {
          // Il ramo si è mosso: tutto ciò che segue deve contare i commit di
          // ADESSO. Senza questa riletura i cancelli girerebbero sulla misura
          // precedente al merge, cioè su un ramo che non esiste più.
          ahead = await runGit(repoPath, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
          if (ahead.code !== 0) {
            return { status: "skipped", code: "branch-missing", reason: `branch '${branch}' non più confrontabile con '${defaultBranch}' dopo il riallineamento` };
          }
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
 * Come `worktreeRealDirt`, ma dice anche SE ha potuto guardare.
 *
 * `worktreeRealDirt` collassa due fatti diversi nella stessa risposta: «l'albero
 * è pulito» e «non sono riuscito a chiederlo». Per il cancello della review va
 * bene fallire aperto — un singhiozzo di git non deve bloccare una consegna. Per
 * il GC no: lì la stessa risposta vuota diventa il permesso di CANCELLARE una
 * cartella che, per quel che ne sappiamo, contiene l'unica copia di un lavoro.
 * Un `git status` che esce non-zero (repo bloccato da un index.lock, filesystem
 * che non risponde, cartella smontata a metà) apriva il reap invece di fermarlo.
 *
 * Chi distrugge usa questa e tratta `ok: false` come sporco; chi solo consiglia
 * continua a usare `worktreeRealDirt`.
 */
export async function worktreeDirtProbe(
  path: string,
  runGit: (cwd: string, args: string[]) => Promise<GitRunResult> = defaultRunGit,
): Promise<{ ok: boolean; paths: string[] }> {
  let st: GitRunResult;
  try {
    st = await runGit(path, ["status", "--porcelain"]);
  } catch {
    return { ok: false, paths: [] };
  }
  if (st.code !== 0) return { ok: false, paths: [] };
  return { ok: true, paths: parseDirtLines(st.stdout) };
}

function parseDirtLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .filter((p) => !WORKTREE_JUNK.some((rx) => rx.test(p)));
}

/**
 * Paths with REAL uncommitted changes in `path` (tracked modifications plus
 * non-junk untracked files). Empty array = the worktree's work is fully
 * committed (or the status call failed — the caller must not hard-fail on a
 * git hiccup). Used as the structural review gate: an agent that "delivers"
 * with work still sitting uncommitted in its worktree gets a 409 coaching it
 * to commit first — the failure mode prompts alone never fixed.
 *
 * FALLISCE APERTO di proposito, ed e' il motivo per cui chi CANCELLA non deve
 * usarla: per quello c'e' `worktreeDirtProbe`, che distingue «pulito» da «non
 * ho potuto guardare».
 */
export async function worktreeRealDirt(
  path: string,
  runGit: (cwd: string, args: string[]) => Promise<GitRunResult> = defaultRunGit,
): Promise<string[]> {
  const probe = await worktreeDirtProbe(path, runGit);
  return probe.paths;
}
