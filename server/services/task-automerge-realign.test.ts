/**
 * Il land su un ramo che ha INVECCHIATO, provato su repo git veri.
 *
 * Un runner finto qui non proverebbe niente: la domanda è cosa fa git quando si
 * riporta `main` dentro un ramo vecchio, e la risposta la sa solo git. Ogni test
 * costruisce due o tre commit su un repo temporaneo e guarda il risultato sul
 * repo, non sulle chiamate.
 *
 * Il caso da cui nasce tutto (misurato la notte del 12/08 landando `ddf66270`):
 * la card aspetta la review, main guadagna una migration, e da quel momento il
 * tasto «Landa su main» rifiutava per sempre. Due difetti in fila — il cancello
 * migration leggeva i nomi a timestamp come se il numero fosse «202», e nessuno
 * riallineava il ramo.
 *
 * @covers LAND-04
 */
import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskAutoMerge, type AutoMergeDeps, type TaskMergeTarget } from "./task-automerge";
import { RESIDUE_SUBJECT } from "./worktree-residue";
import { slackMs } from "../../tests/helpers/time-slack";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BRANCH = "topics/ramo-vecchio";

/**
 * Questi test fanno girare git VERO: init, commit, `worktree add`, merge. Sotto
 * la suite intera (600+ file in parallelo) i 5 secondi di default di `bun test`
 * non bastano, e il timeout arriva a metà di un merge: un rosso che non parla
 * del land ma della macchina. Il tetto resta perché un test che non finisce MAI
 * va comunque interrotto.
 *
 * The 30 s are written for a QUIET machine and widened by the round's factor
 * (tests/helpers/time-slack.ts): under a fleet the manifest test alone went red
 * here at ~4.6 s of real work on an idle box, which is the shape that helper
 * was built for on 2026-09-07 - a red that describes the load, not the land.
 */
const WITH_REAL_GIT = slackMs(30_000);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

/** Scrive un file (creando le cartelle) e lo committa. */
function commit(cwd: string, path: string, body: string, message: string): void {
  const abs = join(cwd, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

/**
 * Un repo con `main` e un ramo di card nato PRIMA che main avanzasse: cioè lo
 * stato in cui finisce ogni consegna che aspetta la review più di qualche ora.
 */
function repoWithOldBranch(opts: {
  /** Files that exist BEFORE the branch is born (besides radice.txt). */
  radice?: Array<[string, string]>;
  /** File che main aggiunge dopo che il ramo è nato. */
  avanzamentoMain: Array<[string, string]>;
  /** File che il ramo aggiunge (o cambia) per conto suo. */
  lavoroDelRamo: Array<[string, string]>;
  /** Su quale ramo resta il checkout condiviso. Default `main`. */
  checkoutSu?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "land-realign-"));
  created.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, "radice.txt", "radice\n", "radice");
  for (const [path, body] of opts.radice ?? []) commit(dir, path, body, `radice: ${path}`);

  git(dir, "switch", "-q", "-c", BRANCH);
  for (const [path, body] of opts.lavoroDelRamo) commit(dir, path, body, `ramo: ${path}`);

  git(dir, "switch", "-q", "main");
  for (const [path, body] of opts.avanzamentoMain) commit(dir, path, body, `main: ${path}`);

  if (opts.checkoutSu && opts.checkoutSu !== "main") git(dir, "switch", "-q", "-c", opts.checkoutSu);
  return dir;
}

function landOn(repoPath: string, extra: Partial<AutoMergeDeps> = {}) {
  const target: TaskMergeTarget = { repoPath, branch: BRANCH, defaultBranch: "main" };
  return createTaskAutoMerge({ resolveTaskMerge: () => target, ...extra });
}

/** I titoli dei commit raggiungibili da un ref, dal più recente. */
function log(repoPath: string, ref: string): string[] {
  return git(repoPath, "log", "--format=%s", ref).split("\n").filter(Boolean);
}

describe("il land riallinea il ramo su main da sé", () => {
  test("ramo indietro di 2 commit, fusione pulita → landa, e dice cosa ha riallineato", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["main-uno.txt", "uno\n"], ["main-due.txt", "due\n"]],
      lavoroDelRamo: [["ramo.txt", "lavoro della card\n"]],
    });
    expect(git(repo, "rev-list", "--count", `${BRANCH}..main`).trim()).toBe("2");

    const res = await landOn(repo).tryMerge("t1", "Card che ha aspettato");

    expect(res.status).toBe("merged");
    if (res.status !== "merged") return;
    // La frase per il thread NOMINA il riallineamento e quanti commit erano.
    expect(res.realigned).toContain("2 commit");
    expect(res.realigned).toContain("nessun conflitto");
    // Il lavoro della card è su main, e main non ha perso i suoi due commit.
    expect(log(repo, "main")).toContain("ramo: ramo.txt");
    expect(log(repo, "main")).toContain("main: main-due.txt");
    // Il riallineamento è un MERGE dentro il ramo, non una riscrittura: quel
    // commit compare nella storia del ramo, e del ramo non resta niente fuori
    // da main (`main` ha in più il solo merge del land).
    expect(log(repo, BRANCH)).toContain("Riporta main nel ramo prima del land");
    expect(git(repo, "rev-list", "--count", `main..${BRANCH}`).trim()).toBe("0");
    // Nessun worktree usa-e-getta lasciato in giro.
    expect(git(repo, "worktree", "list")).not.toContain("_scratch");
  }, WITH_REAL_GIT);

  test("il ramo era già aggiornato → nessun merge in più, e niente da dire", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [], lavoroDelRamo: [["ramo.txt", "x\n"]] });

    const res = await landOn(repo).tryMerge("t1", "Card fresca");

    expect(res.status).toBe("merged");
    if (res.status !== "merged") return;
    expect(res.realigned).toBeNull();
    // Un solo merge su main: quello del land. Nessuna fusione nel ramo.
    expect(log(repo, BRANCH).filter((s) => s.startsWith("Riporta main"))).toHaveLength(0);
  }, WITH_REAL_GIT);

  /**
   * A generated baseline in conflict is not a conflict: both sides recorded
   * their own growth in the same file, and the reconciliation is mechanical —
   * main's ceilings, then the branch's sizes rewritten by the script that owns
   * the format. On 2026-09-04 card 38d903e5 would have gone back to its agent
   * for `scripts/bloat-baseline.json` alone: a whole turn for a file nobody
   * writes by hand.
   */
  test("conflitto SOLO su una baseline generata: la rigenera dai tetti di main e landa", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["scripts/bloat-baseline.json", '{"server.ts": 5716}\n']],
      lavoroDelRamo: [["scripts/bloat-baseline.json", '{"server.ts": 5508, "ramo.ts": 900}\n'], ["ramo.txt", "x\n"]],
    });
    const seen: string[] = [];
    const res = await landOn(repo, {
      regenerateBaseline: async (cwd, file) => {
        // What the real script does: read the tree it sits in, rewrite the file.
        seen.push(readFileSync(join(cwd, file), "utf8"));
        writeFileSync(join(cwd, file), '{"server.ts": 5716, "ramo.ts": 900}\n');
        return { code: 0, stdout: "", stderr: "" };
      },
    }).tryMerge("t1", "Card con baseline");

    expect(res.status).toBe("merged");
    if (res.status !== "merged") return;
    // The script started from MAIN's ceilings, not from the branch's copy.
    expect(seen).toEqual(['{"server.ts": 5716}\n']);
    expect(res.realigned).toContain("baseline generata");
    expect(res.realigned).toContain("scripts/bloat-baseline.json");
    expect(git(repo, "show", "main:scripts/bloat-baseline.json")).toBe('{"server.ts": 5716, "ramo.ts": 900}\n');
    expect(log(repo, "main")).toContain("ramo: ramo.txt");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "worktree", "list")).not.toContain("_scratch");
  }, WITH_REAL_GIT);

  test("baseline in conflitto ACCANTO a un file di codice: torna all'agent, tutto intero", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["scripts/bloat-baseline.json", '{"a": 1}\n'], ["contesa.txt", "main\n"]],
      lavoroDelRamo: [["scripts/bloat-baseline.json", '{"a": 2}\n'], ["contesa.txt", "ramo\n"]],
    });
    let regenerations = 0;
    const res = await landOn(repo, {
      regenerateBaseline: async () => { regenerations++; return { code: 0, stdout: "", stderr: "" }; },
    }).tryMerge("t1", "Card mista");

    expect(res.status).toBe("conflict");
    if (res.status !== "conflict") return;
    expect(res.realignConflict?.files).toEqual(["contesa.txt", "scripts/bloat-baseline.json"]);
    expect(regenerations).toBe(0);
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, WITH_REAL_GIT);

  test("la rigenerazione fallisce (worktree senza dipendenze): conflitto come prima, albero pulito", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["scripts/bloat-baseline.json", '{"a": 1}\n']],
      lavoroDelRamo: [["scripts/bloat-baseline.json", '{"a": 2}\n'], ["ramo.txt", "x\n"]],
    });
    const mainPrima = git(repo, "rev-parse", "main").trim();
    const res = await landOn(repo, {
      regenerateBaseline: async () => ({ code: 1, stdout: "", stderr: "Cannot find module 'jscpd'" }),
    }).tryMerge("t1", "Card senza node_modules");

    expect(res.status).toBe("conflict");
    if (res.status !== "conflict") return;
    expect(res.realignConflict?.files).toEqual(["scripts/bloat-baseline.json"]);
    expect(git(repo, "rev-parse", "main").trim()).toBe(mainPrima);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "worktree", "list")).not.toContain("_scratch");
  }, WITH_REAL_GIT);

  /**
   * The same realign, on its own, for the pre-review checks: the gate must
   * measure the tree that lands. Three cards on 2026-09-04 burnt a turn each on
   * a bloat baseline main had already moved while their branch sat behind.
   */
  test("realign() da solo: porta main nel ramo e lo dice; su conflitto risponde con i file, main fermo", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["main-uno.txt", "uno\n"], ["main-due.txt", "due\n"]],
      lavoroDelRamo: [["ramo.txt", "x\n"]],
    });
    const mainPrima = git(repo, "rev-parse", "main").trim();
    const done = await landOn(repo).realign("t1");
    expect(done).toEqual({ ok: true, note: expect.stringContaining("2 commit") });
    expect(log(repo, BRANCH)).toContain("Riporta main nel ramo prima del land");
    expect(git(repo, "rev-parse", "main").trim()).toBe(mainPrima);
    // Already inside: nothing to do, nothing to say.
    expect(await landOn(repo).realign("t1")).toEqual({ ok: true, note: null });

    const contested = repoWithOldBranch({
      avanzamentoMain: [["contesa.txt", "main\n"]],
      lavoroDelRamo: [["contesa.txt", "ramo\n"]],
    });
    const refused = await landOn(contested).realign("t1");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.files).toEqual(["contesa.txt"]);
    expect(refused.reason).toContain("contesa.txt");
    expect(git(contested, "status", "--porcelain")).toBe("");
  }, WITH_REAL_GIT);

  /**
   * Two cards each add a migration: `merge=union` keeps both manifest lines,
   * in arrival order. On 2026-09-04 card 230bdc3f spent a turn regenerating
   * the manifest by hand after the realign; now the merge commit carries the
   * script's version, and it is still ONE merge commit.
   */
  test("una migration per lato: il manifest viene rigenerato dallo script dentro il merge di riallineamento", async () => {
    const MANIFEST = "server/db/migrations-embedded.ts";
    const repo = repoWithOldBranch({
      radice: [[".gitattributes", `${MANIFEST} merge=union\n`], [MANIFEST, "import a from './migrations/001-a.sql';\n"], ["server/db/migrations/001-a.sql", "-- a\n"]],
      avanzamentoMain: [["server/db/migrations/003-c.sql", "-- c\n"], [MANIFEST, "import a from './migrations/001-a.sql';\nimport c from './migrations/003-c.sql';\n"]],
      lavoroDelRamo: [["server/db/migrations/002-b.sql", "-- b\n"], [MANIFEST, "import a from './migrations/001-a.sql';\nimport b from './migrations/002-b.sql';\n"]],
    });
    const seen: string[] = [];
    const res = await landOn(repo, {
      regenerateManifest: async (cwd) => {
        seen.push(readFileSync(join(cwd, MANIFEST), "utf8"));
        writeFileSync(join(cwd, MANIFEST), "import a from './migrations/001-a.sql';\nimport b from './migrations/002-b.sql';\nimport c from './migrations/003-c.sql';\n");
        return { code: 0, stdout: "", stderr: "" };
      },
    }).realign("t1");
    expect(res).toEqual({ ok: true, note: expect.stringContaining("2 commit") });
    // The script saw the union merge (both lines, arrival order) and wrote the sorted one.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("002-b");
    expect(seen[0]).toContain("003-c");
    expect(git(repo, "show", `${BRANCH}:${MANIFEST}`)).toBe("import a from './migrations/001-a.sql';\nimport b from './migrations/002-b.sql';\nimport c from './migrations/003-c.sql';\n");
    expect(log(repo, BRANCH).filter((s) => s.startsWith("Riporta main"))).toHaveLength(1);
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, WITH_REAL_GIT);

  test("conflitto VERO nel riallineamento: si ferma, nomina i file, e main non si muove", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["contesa.txt", "la versione di main\n"]],
      lavoroDelRamo: [["contesa.txt", "la versione del ramo\n"], ["solo-mio.txt", "x\n"]],
    });
    const mainPrima = git(repo, "rev-parse", "main").trim();

    const res = await landOn(repo).tryMerge("t1", "Card in conflitto");

    expect(res.status).toBe("conflict");
    if (res.status !== "conflict") return;
    expect(res.realignConflict?.behind).toBe(1);
    expect(res.realignConflict?.files).toEqual(["contesa.txt"]);
    // Non ha landato a caso: main è esattamente dov'era.
    expect(git(repo, "rev-parse", "main").trim()).toBe(mainPrima);
    // E non ha lasciato il ramo a metà fusione, né un worktree appeso.
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "worktree", "list")).not.toContain("_scratch");
  }, WITH_REAL_GIT);

  test("checkout condiviso su un altro ramo: riallinea e atterra su main comunque", async () => {
    // Il caso normale di notte: il server gira da un checkout parcheggiato su un
    // ramo di sessione, quindi il land atterra in un worktree usa-e-getta su
    // main — e il ramo della card va riallineato in un ALTRO worktree ancora.
    const repo = repoWithOldBranch({
      avanzamentoMain: [["main-uno.txt", "uno\n"]],
      lavoroDelRamo: [["ramo.txt", "x\n"]],
      checkoutSu: "topics/sessione-viva",
    });

    const res = await landOn(repo).tryMerge("t1", "Card di notte");

    expect(res.status).toBe("merged");
    if (res.status !== "merged") return;
    expect(res.landedNotLive).toBe(true);
    expect(res.checkoutBranch).toBe("topics/sessione-viva");
    expect(res.realigned).toContain("1 commit");
    expect(log(repo, "main")).toContain("ramo: ramo.txt");
  }, WITH_REAL_GIT);

  test("il ramo è aperto in un worktree con WIP → non si riallinea, e non si fonde la WIP di nessuno", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["main-uno.txt", "uno\n"]],
      lavoroDelRamo: [["ramo.txt", "x\n"]],
      checkoutSu: "topics/sessione-viva",
    });
    const wt = join(repo, "..", `wt-${Date.now()}`);
    created.push(wt);
    git(repo, "worktree", "add", "-q", wt, BRANCH);
    writeFileSync(join(wt, "ramo.txt"), "modifica non committata\n");

    const res = await landOn(repo).tryMerge("t1", "Card col worktree sporco");

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("realign-blocked");
    expect(res.reason).toContain("ramo.txt");
    expect(log(repo, "main")).not.toContain("ramo: ramo.txt");
  }, WITH_REAL_GIT);

  test("il merge non parte nemmeno (un file non tracciato sarebbe sovrascritto) → non è un conflitto", async () => {
    // Un merge fallito senza NESSUN file in conflitto non ha niente da
    // riconciliare: mandarlo all'agente come «conflitto» lo farebbe cercare
    // marcatori che non ci sono. Qui il file non tracciato è proprio uno di
    // quelli che il cancello della WIP ignora (`graphify-out/`), quindi il
    // riallineamento parte e si schianta contro git.
    const repo = repoWithOldBranch({
      avanzamentoMain: [["graphify-out/graph.json", "{\"da\":\"main\"}\n"]],
      lavoroDelRamo: [["ramo.txt", "x\n"]],
      checkoutSu: "topics/sessione-viva",
    });
    const wt = join(repo, "..", `wt-untracked-${Date.now()}`);
    created.push(wt);
    git(repo, "worktree", "add", "-q", wt, BRANCH);
    mkdirSync(join(wt, "graphify-out"), { recursive: true });
    writeFileSync(join(wt, "graphify-out", "graph.json"), "{\"da\":\"agente\"}\n");

    const res = await landOn(repo).tryMerge("t1", "Card col file di troppo");

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("realign-blocked");
    expect(res.reason).toContain("nessun file in conflitto");
    expect(log(repo, "main")).not.toContain("ramo: ramo.txt");
  }, WITH_REAL_GIT);

  test("i rifiuti degli agenti non sono WIP: col ramo aperto e pulito il riallineamento passa", async () => {
    // `graphify-out/` e `.claude-task-summary.md` li scrive la strumentazione,
    // non la card: se contassero come lavoro non committato, il riallineamento
    // sarebbe bloccato su ogni ramo che un agente ha davvero usato.
    const repo = repoWithOldBranch({
      avanzamentoMain: [["main-uno.txt", "uno\n"]],
      lavoroDelRamo: [["ramo.txt", "x\n"]],
      checkoutSu: "topics/sessione-viva",
    });
    const wt = join(repo, "..", `wt-junk-${Date.now()}`);
    created.push(wt);
    git(repo, "worktree", "add", "-q", wt, BRANCH);
    mkdirSync(join(wt, "graphify-out"), { recursive: true });
    writeFileSync(join(wt, "graphify-out", "graph.json"), "{}\n");
    writeFileSync(join(wt, ".claude-task-summary.md"), "riassunto\n");

    const res = await landOn(repo).tryMerge("t1", "Card col worktree vivo");

    expect(res.status).toBe("merged");
    // Il merge è avvenuto NEL worktree dove il ramo vive (git non ne concede un
    // secondo sullo stesso branch), e il ramo ora contiene main.
    expect(log(repo, BRANCH)).toContain("Riporta main nel ramo prima del land");
    expect(log(repo, "main")).toContain("ramo: ramo.txt");
  }, WITH_REAL_GIT);
});

describe("il cancello migration dopo il riallineamento", () => {
  const stamp = (name: string) => [`server/db/migrations/${name}`, "SELECT 1;\n"] as [string, string];

  test("due migration a TIMESTAMP diverso non sono una collisione: il land passa", async () => {
    // Il guasto misurato su `ddf66270`: il cancello prendeva il numero con
    // `slice(0, 3)`, leggeva «202» su ogni nome a timestamp, e QUALUNQUE coppia
    // fra main e il ramo diventava una collisione. Il messaggio era ottimo e
    // sbagliato, e il tasto restava rotto per sempre.
    const repo = repoWithOldBranch({
      avanzamentoMain: [stamp("20260812094300-notification-log.sql")],
      lavoroDelRamo: [stamp("20260812120000-preview-retired.sql")],
    });

    const res = await landOn(repo).tryMerge("t1", "Card con migration");

    expect(res.status).toBe("merged");
    expect(log(repo, "main")).toContain("ramo: server/db/migrations/20260812120000-preview-retired.sql");
  }, WITH_REAL_GIT);

  test("due CONTATORI uguali restano una collisione, anche dopo che il ramo ha inglobato main", async () => {
    // Il controllo del test qui sopra. Riportare main dentro il ramo mette
    // entrambi i file DALLO STESSO LATO: un cancello che guardasse un lato per
    // volta non vedrebbe più niente, e la seconda 089 arriverebbe su main.
    const repo = repoWithOldBranch({
      avanzamentoMain: [stamp("089-retirements.sql")],
      lavoroDelRamo: [stamp("089-task-dispatch-weight.sql")],
    });

    const res = await landOn(repo).tryMerge("t1", "Card con contatore");

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.reason).toContain("089");
    expect(res.reason).toContain("Rinumera");
    expect(log(repo, "main")).not.toContain("ramo: server/db/migrations/089-task-dispatch-weight.sql");
  }, WITH_REAL_GIT);
});

describe("la PUNTA del ramo è la consegna, il commit registrato è solo dove era arrivata", () => {
  test("commit di consegna ANTENATO della punta → si pubblica la punta, e lo si dice", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["main-uno.txt", "uno\n"]],
      lavoroDelRamo: [["ramo.txt", "prima\n"]],
    });
    const consegnato = git(repo, "rev-parse", BRANCH).trim();
    // Il ramo va avanti DOPO la consegna: è ciò che succede quando un umano (o
    // l'agente) aggiunge un commit al ramo mentre la card aspetta.
    const wt = join(repo, "..", `wt-punta-${Date.now()}`);
    created.push(wt);
    git(repo, "worktree", "add", "-q", wt, BRANCH);
    commit(wt, "dopo.txt", "aggiunto dopo\n", "ramo: dopo.txt");

    const res = await landOn(repo).tryMerge("t1", "Card cresciuta", { branch: BRANCH, commit: consegnato });

    expect(res.status).toBe("merged");
    if (res.status !== "merged") return;
    expect(res.deliveryDrift).toContain("DOPO la consegna");
    expect(log(repo, "main")).toContain("ramo: dopo.txt");
  }, WITH_REAL_GIT);
});

describe("l'atterraggio automatico non riallinea (noRealign)", () => {
  test("ramo indietro su main → skipped/realign-needed, e main non si muove", async () => {
    const repo = repoWithOldBranch({
      avanzamentoMain: [["main-uno.txt", "uno\n"]],
      lavoroDelRamo: [["ramo.txt", "lavoro\n"]],
    });
    const before = git(repo, "rev-parse", "main").trim();
    const tip = git(repo, "rev-parse", BRANCH).trim();

    const res = await landOn(repo).tryMerge("t1", "Card verde", { branch: BRANCH, commit: tip, noRealign: true });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("realign-needed");
    // Nothing merged anywhere: neither main nor the branch moved.
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
    expect(git(repo, "rev-parse", BRANCH).trim()).toBe(tip);
  }, WITH_REAL_GIT);

  test("ramo aggiornato → noRealign non disturba: landa", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [], lavoroDelRamo: [["ramo.txt", "lavoro\n"]] });
    const tip = git(repo, "rev-parse", BRANCH).trim();

    const res = await landOn(repo).tryMerge("t1", "Card aggiornata", { branch: BRANCH, commit: tip, noRealign: true });

    expect(res.status).toBe("merged");
    expect(log(repo, "main")).toContain("ramo: ramo.txt");
  }, WITH_REAL_GIT);

  test("senza noRealign lo stesso ramo indietro atterra riallineato (il gesto della persona non cambia)", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [["main-uno.txt", "uno\n"]], lavoroDelRamo: [["ramo.txt", "lavoro\n"]] });
    const res = await landOn(repo).tryMerge("t1", "Card riallineata");
    expect(res.status).toBe("merged");
  }, WITH_REAL_GIT);

  test("realign() senza worktree usa il ramo dichiarato dalla card (consegna piantata da un altro nodo)", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [["main-uno.txt", "uno\n"]], lavoroDelRamo: [["ramo.txt", "lavoro\n"]] });
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: () => ({ repoPath: repo, branch: BRANCH }),
    });

    const out = await am.realign("t1");

    expect(out.ok).toBe(true);
    // The branch now carries main: the next land has nothing to realign.
    expect(git(repo, "merge-base", "--is-ancestor", "main", BRANCH)).toBe("");
  }, WITH_REAL_GIT);
});

describe("l'atterraggio automatico pubblica SOLO il commit misurato (noRealign)", () => {
  test("un commit aggiunto sul ramo dopo la consegna → skipped/not-as-measured, main non si muove", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [], lavoroDelRamo: [["ramo.txt", "lavoro\n"]] });
    const measured = git(repo, "rev-parse", BRANCH).trim();
    // The agent keeps working after the delivery was measured.
    git(repo, "switch", "-q", BRANCH);
    commit(repo, "dopo.txt", "non misurato\n", "ramo: dopo.txt");
    git(repo, "switch", "-q", "main");
    const before = git(repo, "rev-parse", "main").trim();

    const res = await landOn(repo).tryMerge("t1", "Card che continua", { branch: BRANCH, commit: measured, noRealign: true });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("not-as-measured");
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
    expect(log(repo, "main")).not.toContain("ramo: dopo.txt");
  }, WITH_REAL_GIT);

  test("il ramo consegnato non esiste più → niente ripiego sul ramo del worktree vivo", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [], lavoroDelRamo: [["ramo.txt", "lavoro\n"]] });
    const tip = git(repo, "rev-parse", BRANCH).trim();
    const before = git(repo, "rev-parse", "main").trim();

    const res = await landOn(repo).tryMerge("t1", "Card col ramo sparito", { branch: "topics/sparito", commit: tip, noRealign: true });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("not-as-measured");
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
  }, WITH_REAL_GIT);

  test("un ramo con commit di altri → non si ricopiano i suoi: l'albero non sarebbe quello misurato", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [], lavoroDelRamo: [["a.txt", "a\n"], ["b.txt", "b\n"]] });
    const tip = git(repo, "rev-parse", BRANCH).trim();
    // A second card's branch is born from the first commit: that one is not this card's own.
    git(repo, "branch", "topics/altra", `${BRANCH}~1`);
    const before = git(repo, "rev-parse", "main").trim();

    const res = await landOn(repo).tryMerge("t1", "Card mista", { branch: BRANCH, commit: tip, noRealign: true });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("not-as-measured");
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
  }, WITH_REAL_GIT);
});

describe("il commit di residuo della potatura non esce dal conto del land automatico (noRealign)", () => {
  /**
   * `listOwnCommits` leaves out the commit the pruning writes to save a dirty
   * worktree, but the merge carries it. With no other local branch the "total vs
   * own" gate used to be skipped altogether, and what the merge brought was a
   * tree nobody measured (verifier, 09/11: auth.ts landed beside a harmless file).
   */
  test("ramo con un commit di residuo e nessun altro ramo locale -> skipped/not-as-measured", async () => {
    const repo = repoWithOldBranch({ avanzamentoMain: [], lavoroDelRamo: [["server/lib/a.ts", "a\n"]] });
    git(repo, "switch", "-q", BRANCH);
    commit(repo, "server/routes/auth.ts", "residuo\n", RESIDUE_SUBJECT);
    git(repo, "switch", "-q", "main");
    const tip = git(repo, "rev-parse", BRANCH).trim();
    const before = git(repo, "rev-parse", "main").trim();

    const res = await landOn(repo).tryMerge("t1", "Card col residuo", { branch: BRANCH, commit: tip, noRealign: true });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("not-as-measured");
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
  }, WITH_REAL_GIT);
});

describe("l'atterraggio automatico con un origin vero (noRealign)", () => {
  /**
   * The merge lands on the LOCAL main, which usually holds commits origin does
   * not have yet. A branch that contains `origin/main` but not the local tip was
   * measured against a tree that is not the one that would land. The tests above
   * have no remote at all, which is why they could not see it.
   */
  function repoWithOrigin(): { repo: string; tip: string } {
    const root = mkdtempSync(join(tmpdir(), "land-origin-"));
    created.push(root);
    const bare = join(root, "origin.git");
    const repo = join(root, "work");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "clone", "-q", bare, repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "switch", "-q", "-c", "main");
    commit(repo, "r.txt", "radice\n", "radice");
    git(repo, "push", "-q", "-u", "origin", "main");
    // The card's branch is born from the published main...
    git(repo, "switch", "-q", "-c", "topics/b");
    commit(repo, "b.txt", "lavoro\n", "ramo: b.txt");
    git(repo, "switch", "-q", "main");
    // ...and the local main gains a commit nobody published.
    commit(repo, "a.txt", "locale\n", "main locale: a.txt");
    return { repo, tip: git(repo, "rev-parse", "topics/b").trim() };
  }
  const landB = (repo: string) =>
    createTaskAutoMerge({ resolveTaskMerge: () => ({ repoPath: repo, branch: "topics/b", defaultBranch: "main" }) });

  test("il ramo contiene origin/main ma non il main locale non pubblicato -> skipped/realign-needed", async () => {
    const { repo, tip } = repoWithOrigin();
    const before = git(repo, "rev-parse", "main").trim();

    const res = await landB(repo).tryMerge("t1", "Card verde", { branch: "topics/b", commit: tip, noRealign: true });

    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") return;
    expect(res.code).toBe("realign-needed");
    expect(git(repo, "rev-parse", "main").trim()).toBe(before);
    expect(log(repo, "main")).not.toContain("ramo: b.txt");
  }, WITH_REAL_GIT);

  test("il ramo contiene anche il main locale -> landa", async () => {
    const { repo } = repoWithOrigin();
    git(repo, "switch", "-q", "topics/b");
    git(repo, "merge", "-q", "--no-edit", "main");
    git(repo, "switch", "-q", "main");
    const tip = git(repo, "rev-parse", "topics/b").trim();

    const res = await landB(repo).tryMerge("t1", "Card allineata", { branch: "topics/b", commit: tip, noRealign: true });

    expect(res.status).toBe("merged");
    expect(log(repo, "main")).toContain("ramo: b.txt");
  }, WITH_REAL_GIT);
});

/**
 * A pull request squash-merged on GitHub, after which main kept editing the same file. The
 * tip of main no longer matches the branch, so the realign used to conflict and pull a done
 * card back to In Progress (card 360127d1, 2026-11-15, PR #1106).
 */
describe("a branch squash-merged before main moved on is not landed again", () => {
  function squashedThenEdited(branchBody: string, mainLater = "one\ntwo (card)\nthree, then main\n"): string {
    const repo = repoWithOldBranch({
      radice: [["shared.txt", "one\ntwo\nthree\n"]],
      avanzamentoMain: [],
      lavoroDelRamo: [["shared.txt", "one\ntwo (card)\nthree\n"], ["card.txt", "card\n"]],
    });
    // The squash: the branch's content as one commit on main.
    writeFileSync(join(repo, "shared.txt"), branchBody);
    writeFileSync(join(repo, "card.txt"), "card\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Card work (#1106)");
    // Main then edits the same file, on a line next to the card's: the realign conflicts.
    commit(repo, "shared.txt", mainLater, "main: later edit");
    return repo;
  }

  test("content was on main at the squash: nothing to land, no realign merge in the branch", async () => {
    const repo = squashedThenEdited("one\ntwo (card)\nthree\n");
    const branchBefore = git(repo, "rev-parse", BRANCH).trim();
    const mainBefore = git(repo, "rev-parse", "main").trim();

    const res = await landOn(repo).tryMerge("t1", "Card already squashed");

    expect(res.status).toBe("nothing");
    expect(git(repo, "rev-parse", BRANCH).trim()).toBe(branchBefore);
    expect(git(repo, "rev-parse", "main").trim()).toBe(mainBefore);
  }, WITH_REAL_GIT);

  test("main never held the branch's content: still a realign conflict", async () => {
    const repo = squashedThenEdited("one\ntwo (something else)\nthree\n", "one\ntwo (card, then main)\nthree\n");

    const res = await landOn(repo).tryMerge("t1", "Card not on main");

    expect(res.status).toBe("conflict");
    if (res.status !== "conflict") return;
    expect(res.realignConflict?.files).toEqual(["shared.txt"]);
  }, WITH_REAL_GIT);

  test("main reverted the squash: the work is gone from main, so landing again is real", async () => {
    const repo = repoWithOldBranch({
      radice: [["shared.txt", "one\ntwo\nthree\n"]],
      avanzamentoMain: [],
      lavoroDelRamo: [["shared.txt", "one\ntwo (card)\nthree\n"], ["card.txt", "card\n"]],
    });
    writeFileSync(join(repo, "shared.txt"), "one\ntwo (card)\nthree\n");
    writeFileSync(join(repo, "card.txt"), "card\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Card work (#1106)");
    git(repo, "revert", "--no-edit", "HEAD");

    const res = await landOn(repo).tryMerge("t1", "Card reverted on main");

    expect(res.status).not.toBe("nothing");
    expect(res.status).toBe("merged");
    expect(git(repo, "show", "main:card.txt")).toBe("card\n");
  }, WITH_REAL_GIT);

  test("main took back ONE of the branch's two edits in a file: that edit is real work, not «nothing»", async () => {
    const lines = (a: string, b: string) => ["a", a, "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", b, "z"].join("\n") + "\n";
    const repo = repoWithOldBranch({
      radice: [["shared.txt", lines("fix", "feature")]],
      avanzamentoMain: [],
      lavoroDelRamo: [["shared.txt", lines("fix (card)", "feature (card)")]],
    });
    // The squash, then main removes only the feature edit.
    commit(repo, "shared.txt", lines("fix (card)", "feature (card)"), "Card work (#1106)");
    commit(repo, "shared.txt", lines("fix (card)", "feature"), "main: drop the feature");

    const res = await landOn(repo).tryMerge("t1", "Card partly reverted on main");

    expect(res.status).not.toBe("nothing");
  }, WITH_REAL_GIT);

  test("the revert also edits a line next to the edit it takes back: still not «nothing»", async () => {
    const lines = (a: string, near: string, b: string) =>
      ["l1", a, "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", near, b, "l13", "l14", "l15"].join("\n") + "\n";
    const repo = repoWithOldBranch({
      radice: [["shared.txt", lines("l2", "l11", "l12")]],
      avanzamentoMain: [],
      lavoroDelRamo: [["shared.txt", lines("2A", "l11", "12B")]],
    });
    commit(repo, "shared.txt", lines("2A", "l11", "12B"), "Card work (#1106)");
    // One commit takes 12B back AND rewrites line 11, inside the hunk's context.
    commit(repo, "shared.txt", lines("2A", "11x", "l12"), "main: drop 12B, tweak 11");

    const res = await landOn(repo).tryMerge("t1", "Card partly reverted, context moved");

    expect(res.status).not.toBe("nothing");
  }, WITH_REAL_GIT);

  test("one hunk changes a line AND adds a new one, main drops only the new one: not «nothing»", async () => {
    const body = (t: string, extra: string[]) =>
      ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", `const t = ${t}`, "l11", "l12", "l13", ...extra, "l14", "l15"].join("\n") + "\n";
    const repo = repoWithOldBranch({
      radice: [["shared.ts", body("5", [])]],
      avanzamentoMain: [],
      lavoroDelRamo: [["shared.ts", body("10", ["log(t)"])]],
    });
    commit(repo, "shared.ts", body("10", ["log(t)"]), "Card work (#1106)");
    commit(repo, "shared.ts", body("10", []), "main: drop the log");

    const res = await landOn(repo).tryMerge("t1", "Card's new line taken back");

    expect(res.status).not.toBe("nothing");
  }, WITH_REAL_GIT);

  test("git puts an inserted line before a replaced one, main drops the inserted one: not «nothing»", async () => {
    const repo = repoWithOldBranch({
      radice: [["shared.ts", 'import a from "a"\nrest\n']],
      avanzamentoMain: [],
      lavoroDelRamo: [["shared.ts", 'import b from "b"\nimport a from "a2"\nrest\n']],
    });
    commit(repo, "shared.ts", 'import b from "b"\nimport a from "a2"\nrest\n', "Card work (#1106)");
    commit(repo, "shared.ts", 'import a from "a2"\nrest\n', "main: drop import b");

    const res = await landOn(repo).tryMerge("t1", "Card's import taken back");

    expect(res.status).not.toBe("nothing");
  }, WITH_REAL_GIT);

  test("the card's only line is a common one, main moves it elsewhere: cannot tell, not «nothing»", async () => {
    const f = (inF: boolean, inG: boolean) =>
      ["function f() {", "  a();", ...(inF ? ["  return null;"] : []), "}", "", "function g() {", "  b();", ...(inG ? ["  return null;"] : []), "}", "",
        "function h() {", "  c();", "  return null;", "}"].join("\n") + "\n";
    const repo = repoWithOldBranch({
      radice: [["shared.ts", f(false, false)]],
      avanzamentoMain: [],
      lavoroDelRamo: [["shared.ts", f(true, false)]],
    });
    commit(repo, "shared.ts", f(true, false), "Card work (#1106)");
    // One commit drops the card's line from f() and adds the same line in g(): same count.
    commit(repo, "shared.ts", f(false, true), "main: move it");

    const res = await landOn(repo).tryMerge("t1", "Card's common line moved");

    expect(res.status).not.toBe("nothing");
  }, WITH_REAL_GIT);
});

describe("static gates on the realign merge, before the land goes on", () => {
  const aged = () => repoWithOldBranch({ avanzamentoMain: [["main-uno.txt", "uno\n"]], lavoroDelRamo: [["ramo.txt", "work\n"]] });

  test("a red gate on the merge: nothing lands, the branch is back where it was, the reason names the gate", async () => {
    const repo = aged();
    const [tipBefore, mainBefore] = [BRANCH, "main"].map((ref) => git(repo, "rev-parse", ref).trim());
    const seen: string[] = [];
    const res = await landOn(repo, {
      staticGates: async (cwd) => {
        seen.push(readFileSync(join(cwd, "main-uno.txt"), "utf8").trim()); // the MERGED tree
        return "bun run lint:design-system (exit 1): 4 raw controls";
      },
    }).tryMerge("t1", "Card with a red merge");
    expect(res.status).toBe("skipped");
    expect(res).toMatchObject({ code: "realign-gates-red", reason: expect.stringContaining("lint:design-system") });
    expect(seen).toEqual(["uno"]);
    expect([BRANCH, "main"].map((ref) => git(repo, "rev-parse", ref).trim())).toEqual([tipBefore, mainBefore]);
  }, WITH_REAL_GIT);

  test("a green gate on the merge lands as before; an up-to-date branch is not measured", async () => {
    let calls = 0;
    const staticGates = async () => { calls += 1; return null; };
    expect((await landOn(aged(), { staticGates }).tryMerge("t1", "Green merge")).status).toBe("merged");
    expect(calls).toBe(1);
    const fresh = repoWithOldBranch({ avanzamentoMain: [], lavoroDelRamo: [["ramo.txt", "x\n"]] });
    expect((await landOn(fresh, { staticGates }).tryMerge("t2", "Fresh card")).status).toBe("merged");
    expect(calls).toBe(1);
  }, WITH_REAL_GIT);
});
