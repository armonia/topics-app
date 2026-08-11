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

export interface AutoMergeDeps {
  /**
   * Resolve a task to its merge target. `null` ⇒ nothing to merge (the task ran
   * in-place with no worktree, or its worktree isn't a `branch`-mode one).
   */
  resolveTaskMerge: (taskId: string) => TaskMergeTarget | null;
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
          `il ramo del worktree vivo — se la consegna aveva commit solo lì, NON sono su main`,
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
    const target = deps.resolveTaskMerge(taskId);
    if (!target) {
      return { status: "skipped", code: "no-branch", reason: "nessun worktree/branch per il task (in-place o non dispatchato)" };
    }
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
            return {
              status: "skipped", code: "foreign-commits",
              reason:
                `il branch '${branch}' porterebbe su '${defaultBranch}' ${total} commit, ma solo ${mine} ${mine === 1 ? "è" : "sono"} di questo task: ` +
                `gli altri ${total - mine} arrivano dal branch su cui era il checkout quando la card è partita, e sono lavoro di qualcun altro. ` +
                `Non li pubblico. Prendi il lavoro del task con un cherry-pick (\`git log --oneline ${defaultBranch}..${branch} --not ${others.join(" ")}\`), ` +
                `oppure landa prima quel branch`,
            };
          }
        }

        // Fast path: the shared checkout is ALREADY on main → merge in place, so a
        // hot-reload/rebuild makes the landing live immediately. Requires a clean
        // tree: never fold a concurrent session's WIP into the merge.
        if (cur === defaultBranch) {
          const st = await runGit(repoPath, ["status", "--porcelain"]);
          if (st.stdout.trim() !== "") {
            return { status: "skipped", code: "dirty-checkout", reason: `il checkout è su '${defaultBranch}' con WIP non committata — mergia a mano o pulisci il checkout` };
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
          const merge = await runGit(wtPath, ["merge", "--no-ff", "-m", mergeMsg, branch]);
          if (merge.code === 0) return await finishMerged(wtPath, /*live*/ false, cur || "detached HEAD");
          await runGit(wtPath, ["merge", "--abort"]).catch(() => undefined);
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
