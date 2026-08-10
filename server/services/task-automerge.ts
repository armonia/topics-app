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
    }
  | { status: "conflict"; branch: string }
  | { status: "nothing"; branch: string }
  | { status: "skipped"; reason: string };

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

  async function tryMerge(taskId: string, title: string): Promise<AutoMergeResult> {
    const target = deps.resolveTaskMerge(taskId);
    if (!target) {
      return { status: "skipped", reason: "nessun worktree/branch per il task (in-place o non dispatchato)" };
    }
    const { repoPath, branch, defaultBranch } = target;

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
          const n = file.slice(0, 3);
          if (/^\d{3}$/.test(n)) out.set(n, file);
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

        // Does the branch exist and have commits main doesn't? (Refs are shared
        // across every worktree, so this reads the same from the shared checkout.)
        const ahead = await runGit(repoPath, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
        if (ahead.code !== 0) {
          return { status: "skipped", reason: `branch '${branch}' non trovato o non confrontabile con '${defaultBranch}'` };
        }
        if (ahead.stdout.trim() === "0") {
          return { status: "nothing", branch };
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
        // Il worktree di una card nasce da `baseRef: "HEAD"` (server.ts), cioè
        // dall'HEAD del checkout CONDIVISO — che quando qualcuno sta lavorando
        // non è main ma il suo branch. Il branch del task eredita quindi tutti i
        // commit di quella linea, e questo merge li porterebbe su main insieme
        // ai suoi: «Landa su main» pubblicherebbe lavoro non finito di un'altra
        // sessione, con un click che sembra innocuo.
        //
        // Successo davvero il 2026-08-09: card dispatchata con il checkout su
        // `topics/gruppi-spazi-pulizia`, e il suo branch portava 13 commit che
        // main non aveva, sei dei quali di un'altra sessione viva. Si è visto
        // solo perché il merge è finito in conflitto — fortuna, non progetto.
        //
        // Il discrimine non ha bisogno di ricordare da dove il worktree è nato:
        // un commit EREDITATO è raggiungibile anche da un ALTRO branch locale,
        // uno fatto dentro questo worktree no. Quindi `--not <gli altri branch>`
        // lascia esattamente i commit del task.
        /** Quando il branch porta anche commit non suoi: si prendono solo i suoi. */
        let onlyOwn: { total: number; mine: number; others: string[] } | null = null;
        const refs = await runGit(repoPath, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
        const others = refs.stdout.split("\n").map((r) => r.trim()).filter(
          (r) => r && r !== `refs/heads/${branch}` && r !== `refs/heads/${defaultBranch}`,
        );
        if (others.length > 0) {
          const own = await runGit(repoPath, ["rev-list", "--count", `${defaultBranch}..${branch}`, "--not", ...others]);
          if (own.code === 0) {
            const total = Number(ahead.stdout.trim());
            const mine = Number(own.stdout.trim());
            if (Number.isFinite(total) && Number.isFinite(mine) && total > mine) {
              if (mine === 0) {
                return {
                  status: "skipped",
                  reason:
                    `il branch '${branch}' porterebbe ${total} commit su '${defaultBranch}' e NESSUNO è di questa card: ` +
                    "non c'è niente da landare che sia suo",
                };
              }
              // Solo i commit DELLA CARD. Rifiutarsi e basta — la prima versione —
              // teneva main pulito e lasciava il lavoro in un limbo: misurato,
              // 12 consegne accettate vivevano solo sul loro branch, fra cui uno
              // scorporo da 800 righe e una rimozione da 21.775. «Accettata» deve
              // voler dire «atterrata», altrimenti la board misura il lavoro fatto
              // e non quello arrivato.
              onlyOwn = { total, mine, others };
            }
          }
        }

        // Fast path: the shared checkout is ALREADY on main → merge in place, so a
        // hot-reload/rebuild makes the landing live immediately. Requires a clean
        // tree: never fold a concurrent session's WIP into the merge.
        if (cur === defaultBranch) {
          const st = await runGit(repoPath, ["status", "--porcelain"]);
          if (st.stdout.trim() !== "") {
            return { status: "skipped", reason: `il checkout è su '${defaultBranch}' con WIP non committata — mergia a mano o pulisci il checkout` };
          }
          if (onlyOwn) {
            const picked = await pickOwnCommits(repoPath, onlyOwn);
            if (picked.ok) return finishMerged(repoPath, /*live*/ true, cur);
            if (picked.conflict) return conflictOrDependency(picked.missingBase, picked.dependsOn);
            return { status: "skipped", reason: `non sono riuscito a isolare i ${onlyOwn.mine} commit di questa card su '${branch}'` };
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
          return { status: "skipped", reason: `impossibile creare il worktree di land su '${defaultBranch}': ${(add.stderr || add.stdout).trim().slice(-200) || "git worktree add fallito"}` };
        }
        try {
          if (onlyOwn) {
            const picked = await pickOwnCommits(wtPath, onlyOwn);
            if (picked.ok) return await finishMerged(wtPath, /*live*/ false, cur || "detached HEAD");
            if (!picked.conflict) {
              return { status: "skipped", reason: `non sono riuscito a isolare i ${onlyOwn.mine} commit di questa card su '${branch}'` };
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
        return { status: "skipped", reason: `errore interno durante il merge: ${e instanceof Error ? e.message : String(e)}` };
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
