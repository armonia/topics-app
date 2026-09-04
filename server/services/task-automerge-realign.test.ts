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

const BRANCH = "topics/ramo-vecchio";

/**
 * Questi test fanno girare git VERO: init, commit, `worktree add`, merge. Sotto
 * la suite intera (600+ file in parallelo) i 5 secondi di default di `bun test`
 * non bastano, e il timeout arriva a metà di un merge: un rosso che non parla
 * del land ma della macchina. Il tetto resta perché un test che non finisce MAI
 * va comunque interrotto.
 */
const WITH_REAL_GIT = 30_000;

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
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
    expect(git(repo, "worktree", "list")).not.toContain("topics-realign");
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
    expect(git(repo, "worktree", "list")).not.toContain("topics-realign");
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
    expect(git(repo, "worktree", "list")).not.toContain("topics-realign");
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
    expect(git(repo, "worktree", "list")).not.toContain("topics-realign");
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
