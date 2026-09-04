/**
 * @covers LAND-02
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  commitIsIn,
  countOwnCommits,
  deliveryPointer,
  listOwnCommits,
  mergeNameStatus,
  otherLocalBranches,
  splitAheadCommits,
  type GitRunResult,
} from "./own-commits";
import { deriveKind } from "../../shared/task-labels";
import { RESIDUE_SUBJECT } from "./worktree-residue";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, body: string, msg: string): void {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
}

const subject = (repo: string, sha: string) => git(repo, "log", "-1", "--format=%s", sha);

/**
 * I flag che `rangeArgs` antepone SEMPRE per togliere i commit di residuo della
 * potatura. Stanno qui in una costante e non copiati in ogni attesa: cosi' i
 * test che seguono continuano a parlare di cio' che verificano davvero, cioe'
 * il `--not` e il numero di `rev-list`, invece di ripetere il filtro tre volte.
 */
const SENZA_RESIDUI = ["--fixed-strings", `--grep=${RESIDUE_SUBJECT}`, "--invert-grep"];

/**
 * Un repo VERO, montato come si monta il difetto: una sessione umana che lavora
 * sul checkout condiviso, e i branch delle card che nascono da lì e quindi
 * ereditano i suoi commit.
 *
 *   main    base
 *   dev     base ← A            (l'altra sessione)
 *   card    base ← A ← M        (eredita A, produce M)
 *   doppia  base ← A ← M1 ← M2  (eredita A, produce due commit)
 *   vuota   base ← A            (eredita e basta: non ha prodotto niente)
 */
describe("own-commits — su git vero", () => {
  let repo: string;
  let shaA: string;
  let shaM: string;

  // Timeout largo: l'hook fa una ventina di `git` SINCRONI e i 5s di default di
  // bun li coprono solo a macchina scarica (stessa ragione di branch-status).
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "own-commits-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    commit(repo, "a.txt", "base\n", "base");

    git(repo, "checkout", "-q", "-b", "dev");
    commit(repo, "wip.txt", "roba di un altro\n", "WIP di un'altra sessione");
    shaA = git(repo, "rev-parse", "dev");

    git(repo, "checkout", "-q", "-b", "topics/card", "dev");
    commit(repo, "mio.txt", "il mio lavoro\n", "il mio lavoro");
    shaM = git(repo, "rev-parse", "topics/card");

    git(repo, "checkout", "-q", "-b", "topics/doppia", "dev");
    commit(repo, "uno.txt", "1\n", "primo mio");
    commit(repo, "due.txt", "2\n", "secondo mio");

    // Nessun commit suo: la punta è il lavoro dell'altra sessione.
    git(repo, "checkout", "-q", "-b", "topics/vuota", "dev");
    // Un branch usa-e-getta, cancellato dentro il test che ne ha bisogno.
    git(repo, "checkout", "-q", "-b", "topics/potata", "dev");
    commit(repo, "potata.txt", "lavoro poi potato\n", "lavoro della potata");
    git(repo, "checkout", "-q", "main");
  }, 60_000);

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("il ramo che porta anche lavoro altrui consegna SOLO i suoi commit", async () => {
    // Il controllo che rende il test capace di fallire: il ramo è avanti di DUE
    // commit su main, quindi «tutto ciò che main non ha» sarebbe la risposta
    // sbagliata, e la punta del ramo è un modo di darla.
    expect(git(repo, "rev-list", "--count", "main..topics/card")).toBe("2");

    const own = await listOwnCommits(repo, "topics/card");
    expect(own).toEqual([shaM]);
    expect(own).not.toContain(shaA);
    expect(subject(repo, own![0])).toBe("il mio lavoro");
    expect(await countOwnCommits(repo, "topics/card")).toBe(1);

    const ptr = await deliveryPointer(repo, "topics/card");
    expect(ptr).toEqual({ branch: "topics/card", commit: shaM });
  });

  test("il ramo di un tentativo precedente della STESSA card non e' lavoro altrui: `ownRefs` lo toglie dalla sottrazione", async () => {
    // 1929291c, 2026-09-04: the previous attempt's branch stayed in refs/heads
    // with no worktree after the card got a new one, and the new branch
    // continued it. Nothing else reaches those commits.
    git(repo, "checkout", "-q", "-b", "topics/prima", "main");
    commit(repo, "prima.txt", "primo tentativo\n", "primo tentativo della card");
    git(repo, "checkout", "-q", "-b", "topics/seconda", "topics/prima");
    commit(repo, "seconda.txt", "secondo tentativo\n", "secondo tentativo della card");
    git(repo, "checkout", "-q", "main");

    const declared = await otherLocalBranches(repo, "topics/seconda", { ownRefs: ["topics/prima"] });
    expect(declared).not.toContain("refs/heads/topics/prima");
    expect(await countOwnCommits(repo, "topics/seconda", { others: declared! })).toBe(2);
    // Without the declaration the subtraction stays as it was: the old branch is foreign.
    const all = await otherLocalBranches(repo, "topics/seconda");
    expect(all).toContain("refs/heads/topics/prima");
    expect(await countOwnCommits(repo, "topics/seconda", { others: all! })).toBe(1);
  });

  test("i commit propri arrivano dal più recente: il primo è il puntatore di consegna", async () => {
    const own = await listOwnCommits(repo, "topics/doppia");
    expect(own?.map((sha) => subject(repo, sha))).toEqual(["secondo mio", "primo mio"]);
    expect(await countOwnCommits(repo, "topics/doppia")).toBe(2);
    const ptr = await deliveryPointer(repo, "topics/doppia");
    expect(subject(repo, ptr!.commit!)).toBe("secondo mio");
  });

  test("nessun commit proprio → [] verificato, e la consegna è un puntatore VUOTO", async () => {
    // «Non ho prodotto codice» è un'informazione; un puntatore al lavoro altrui
    // manda chi rivede a leggere il diff sbagliato (dd2aa40d → 987cd8ae, 10/08).
    expect(await listOwnCommits(repo, "topics/vuota")).toEqual([]);
    expect(await countOwnCommits(repo, "topics/vuota")).toBe(0);

    const ptr = await deliveryPointer(repo, "topics/vuota");
    expect(ptr).toEqual({ branch: "topics/vuota", commit: null });
    // Esplicito: NON la punta del ramo, che qui è il commit dell'altra sessione.
    expect(ptr!.commit).not.toBe(shaA);
  });

  test("le due liste insieme: cosa porterebbe il land, e quanto di quello è suo", async () => {
    const split = await splitAheadCommits(repo, "topics/card");
    expect(split!.ahead).toEqual([shaM, shaA]);   // tutto ciò che main non ha
    expect(split!.own).toEqual([shaM]);           // di suo, uno solo
    // Il commit estraneo più recente è ciò che il doctor mostra come causa
    // condivisa: esce dalla differenza fra le due liste, non da una terza domanda.
    expect(split!.ahead.find((sha) => !split!.own.includes(sha))).toBe(shaA);
    expect(split!.others).toContain("refs/heads/dev");
    expect(split!.others).not.toContain("refs/heads/topics/card");
  });

  test("le due liste non divergono da `listOwnCommits`: è la STESSA sottrazione", async () => {
    for (const branch of ["topics/card", "topics/doppia", "topics/vuota"]) {
      const split = await splitAheadCommits(repo, branch);
      expect(split!.own).toEqual((await listOwnCommits(repo, branch))!);
      expect(await countOwnCommits(repo, branch)).toBe(split!.own.length);
    }
  });

  test("le due liste, quando non si può guardare → null (mai `ahead` senza `own`)", async () => {
    expect(await splitAheadCommits(repo, "topics/mai-esistito")).toBeNull();
    expect(await splitAheadCommits(repo, "topics/card", { mainRef: "ramo-che-non-esiste" })).toBeNull();
  });

  test("branch cancellato o mai esistito → null, che non è «non ha niente»", async () => {
    expect(await listOwnCommits(repo, "topics/mai-esistito")).toBeNull();
    expect(await countOwnCommits(repo, "topics/mai-esistito")).toBeNull();
    // Nessuna fotografia: una consegna già registrata non si cancella perché il
    // branch è stato potato.
    expect(await deliveryPointer(repo, "topics/mai-esistito")).toBeNull();

    git(repo, "branch", "-q", "-D", "topics/potata");
    expect(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/topics/potata")).toBe("");
    expect(await listOwnCommits(repo, "topics/potata")).toBeNull();
    expect(await deliveryPointer(repo, "topics/potata")).toBeNull();
  });

  test("commitIsIn: dentro, fuori, e «non lo so» — tre risposte distinte", async () => {
    const base = git(repo, "rev-parse", "main");
    // DENTRO: il commit di main è antenato di se stesso.
    expect(await commitIsIn(repo, base, "main")).toBe(true);
    // FUORI, verificato: il lavoro della card non è ancora atterrato.
    expect(await commitIsIn(repo, shaM, "main")).toBe(false);
    expect(await commitIsIn(repo, shaA, "main")).toBe(false);
    // NON CONTABILE: sha sconosciuto, ref inesistente, cartella che non è un
    // repo, stringa vuota. Nessuno di questi è un `false` — chi chiama chiude
    // una card sul `true` e sull'ignoranza non deve toccare niente.
    expect(await commitIsIn(repo, "0".repeat(40), "main")).toBeNull();
    expect(await commitIsIn(repo, base, "ramo-che-non-esiste")).toBeNull();
    expect(await commitIsIn(repo, "   ", "main")).toBeNull();
    const nonRepo = mkdtempSync(join(tmpdir(), "own-commits-nonrepo-"));
    try { expect(await commitIsIn(nonRepo, base, "main")).toBeNull(); }
    finally { rmSync(nonRepo, { recursive: true, force: true }); }
  });

  test("commitIsIn risponde anche quando il RAMO non c'è più", async () => {
    // È la ragione per cui la domanda si fa sul commit: dopo il land il ramo
    // viene potato, e chiedere di lui direbbe «non c'è» su lavoro atterrato.
    // Il giro completo su un ramo usa-e-getta, per non muovere il fixture che
    // gli altri test leggono: si consegna, si fonde, si pota.
    git(repo, "checkout", "-q", "-b", "topics/landata", "main");
    commit(repo, "landata.txt", "lavoro atterrato\n", "lavoro poi landato");
    const shaL = git(repo, "rev-parse", "topics/landata");
    git(repo, "checkout", "-q", "-b", "integrazione", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "land della card", "topics/landata");
    git(repo, "branch", "-q", "-D", "topics/landata");
    git(repo, "checkout", "-q", "main");

    expect(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/topics/landata")).toBe("");
    // Il ramo non è più contabile…
    expect(await listOwnCommits(repo, "topics/landata", { mainRef: "integrazione" })).toBeNull();
    // …il commit sì, e dice che il lavoro è dentro.
    expect(await commitIsIn(repo, shaL, "integrazione")).toBe(true);
    // E su `main`, dove il land non è arrivato, resta fuori: la risposta è del
    // ref, non un sì d'ufficio.
    expect(await commitIsIn(repo, shaL, "main")).toBe(false);
    git(repo, "branch", "-q", "-D", "integrazione");
  });

  test("main inesistente, o una cartella che non è un repo → null", async () => {
    expect(await countOwnCommits(repo, "topics/card", { mainRef: "ramo-che-non-esiste" })).toBeNull();
    expect(await listOwnCommits(repo, "topics/card", { mainRef: "ramo-che-non-esiste" })).toBeNull();

    const nonRepo = mkdtempSync(join(tmpdir(), "own-commits-vuoto-"));
    try {
      expect(await otherLocalBranches(nonRepo, "topics/card")).toBeNull();
      expect(await listOwnCommits(nonRepo, "topics/card")).toBeNull();
      expect(await deliveryPointer(nonRepo, "topics/card")).toBeNull();
    } finally { rmSync(nonRepo, { recursive: true, force: true }); }
  });

  test("gli altri branch locali: tutti tranne sé stesso e quello d'integrazione", async () => {
    const others = await otherLocalBranches(repo, "topics/card");
    expect(others).toContain("refs/heads/dev");
    expect(others).toContain("refs/heads/topics/vuota");
    expect(others).not.toContain("refs/heads/topics/card");
    expect(others).not.toContain("refs/heads/main");
    // Il nome si accetta anche già in forma di ref: è come lo passa la consegna.
    expect(await otherLocalBranches(repo, "refs/heads/topics/card")).toEqual(others!);
  });

  test("un nome di branch che è anche un file non rende ambigua la domanda", async () => {
    // `main..a.txt` sarebbe ambiguo per git: la normalizzazione a refs/heads/
    // esiste per questo, e senza risposta il puntatore sarebbe nullo per il
    // motivo sbagliato («git ha sbagliato» invece di «non ha commit propri»).
    git(repo, "branch", "-q", "a.txt", "topics/card");
    try {
      expect(await countOwnCommits(repo, "a.txt")).toBe(0); // stessa punta di topics/card
      expect(await listOwnCommits(repo, "a.txt")).toEqual([]);
    } finally { git(repo, "branch", "-q", "-D", "a.txt"); }
  });
});

describe("own-commits — il runner iniettato", () => {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
    calls.push(args);
    if (args[0] === "for-each-ref") return { code: 0, stdout: "refs/heads/main\nrefs/heads/altro\nrefs/heads/mio\n", stderr: "" };
    return { code: 0, stdout: args.includes("--count") ? "1\n" : "a".repeat(40) + "\n", stderr: "" };
  };

  test("gli `others` già noti non fanno ripetere il for-each-ref", async () => {
    calls.length = 0;
    const n = await countOwnCommits("/repo", "mio", { runGit: run, others: ["refs/heads/altro"] });
    expect(n).toBe(1);
    expect(calls.some((c) => c[0] === "for-each-ref")).toBe(false);
    expect(calls[0]).toEqual(["rev-list", "--count", ...SENZA_RESIDUI, "refs/heads/main..refs/heads/mio", "--not", "refs/heads/altro"]);
  });

  test("senza altri branch il `--not` non compare affatto", async () => {
    calls.length = 0;
    await listOwnCommits("/repo", "mio", { runGit: run, others: [] });
    expect(calls[0]).toEqual(["rev-list", ...SENZA_RESIDUI, "refs/heads/main..refs/heads/mio"]);
  });

  test("le due liste: `--not` solo se c'è da sottrarre, e una `rev-list` sola quando non c'è", async () => {
    calls.length = 0;
    const withOther = await splitAheadCommits("/repo", "mio", { runGit: run, others: ["refs/heads/altro"] });
    expect(calls.map((c) => c.join(" "))).toEqual([
      `rev-list ${SENZA_RESIDUI.join(" ")} refs/heads/main..refs/heads/mio`,
      `rev-list ${SENZA_RESIDUI.join(" ")} refs/heads/main..refs/heads/mio --not refs/heads/altro`,
    ]);
    expect(withOther!.others).toEqual(["refs/heads/altro"]);

    calls.length = 0;
    const senza = await splitAheadCommits("/repo", "mio", { runGit: run, others: [] });
    expect(calls).toHaveLength(1); // niente da sottrarre: la seconda domanda non si paga
    expect(senza!.own).toEqual(senza!.ahead);
  });

  test("se `for-each-ref` fallisce non si ripiega su main..branch: null", async () => {
    // Il ripiego sarebbe esattamente il difetto — rivendicare i commit ereditati
    // perché non si è potuto sapere di chi fossero.
    const rotto = async (_cwd: string, args: string[]): Promise<GitRunResult> =>
      args[0] === "for-each-ref" ? { code: 128, stdout: "", stderr: "not a git repository" } : { code: 0, stdout: "beef\n", stderr: "" };
    expect(await listOwnCommits("/repo", "mio", { runGit: rotto })).toBeNull();
    expect(await countOwnCommits("/repo", "mio", { runGit: rotto })).toBeNull();
    expect(await deliveryPointer("/repo", "mio", { runGit: rotto })).toBeNull();
  });

  test("un conteggio che non è un numero vale null, non zero", async () => {
    const strano = async (_cwd: string, args: string[]): Promise<GitRunResult> =>
      args[0] === "for-each-ref" ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: "boh\n", stderr: "" };
    expect(await countOwnCommits("/repo", "mio", { runGit: strano })).toBeNull();
  });
});

/**
 * I due punti in cui il server fotografa la consegna vivono dentro `server.ts`,
 * che non si può montare in un test: senza questo cancello nessuno si accorge se
 * uno dei due torna a leggere la PUNTA del ramo — che è esattamente la
 * regressione da cui nasce questo file.
 */
describe("own-commits — il cablaggio della consegna in server.ts", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "server.ts"), "utf8");
  // IL BACKFILL HA TRASLOCATO il 18/08 (`services/delivery-backfill.ts`), quando
  // il cancello di dimensione ha protestato su `server.ts`. Il cancello segue il
  // codice: la domanda che sorveglia — «si chiede il commit PROPRIO, mai la
  // punta» — non e' cambiata di una virgola, e sarebbe stata la cosa peggiore
  // lasciarlo puntato a un blocco ormai vuoto, dove sarebbe passato verde a
  // vuoto per sempre.
  const backfillSrc = readFileSync(join(import.meta.dir, "delivery-backfill.ts"), "utf8");

  function blockIn(testo: string, from: string, to: string): string {
    const start = testo.indexOf(from);
    expect(start, `ancora non trovata: ${from}`).toBeGreaterThan(-1);
    const end = to ? testo.indexOf(to, start) : testo.length;
    expect(end).toBeGreaterThan(start);
    return testo.slice(start, end);
  }
  const block = (from: string, to: string) => blockIn(src, from, to);
  /** Il corpo della passata, ovunque viva adesso. */
  const backfill = () => blockIn(backfillSrc, "export async function backfillDeliveries", "");

  test("la cattura in review chiede il commit PROPRIO, non la punta", () => {
    // L'ANCORA E' CAMBIATA IL 18/08, e vale la pena dire perche': i due sguardi
    // sul worktree vivevano dentro l'oggetto delle opzioni di
    // `createTasksRouter`, quindi solo la ROTTA poteva fotografare una consegna
    // — e la consegna forzata dal sistema, che passa dal dispatcher, diceva
    // sempre «nessun ramo e nessun file toccato». Adesso sono due const, usate
    // da entrambi. Il cancello non cambia: quello che sorveglia e' che si
    // continui a chiedere il commit PROPRIO.
    const capture = block("const taskDeliveryRef = async (taskId: string)", "const taskCheckoutRef");
    expect(capture).toContain("deliveryPointer(");
    expect(capture).not.toContain("resolveCommit(");
  });

  test("il backfill periodico dell'audit fa la stessa domanda", () => {
    // Altrimenti ogni 30 minuti riscriverebbe la punta del ramo sopra le card
    // senza consegna registrata, disfacendo la cattura.
    const corpo = backfill();
    expect(corpo).toContain("deliveryPointer(");
    expect(corpo).not.toContain("resolveCommit(");
  });

  /**
   * IL RIPIEGO CHE SEMBRA OVVIO E RIFÀ IL DANNO.
   *
   * `delivery_commit` resta NULL su parecchie card, e la cura che viene in mente
   * guardando la colonna vuota è «e allora prendi la punta del ramo». Il 18/08
   * quella cura è arrivata fin dentro `server.ts`, in tutt'e due i punti.
   *
   * Ma `commit: null` non è un buco: è la risposta «verificato, questa card non
   * ha prodotto niente di suo», e la punta in quel caso è di qualcun altro.
   * Misurato sulla card `5bfd7356` (worktree `mossy-marble`, zero commit
   * propri): `HEAD` è `27d9ebca4`, «Le missioni: compiti a preset…», commit di
   * un'altra card e su main da una settimana. Registrarlo manda il reviewer a
   * leggere il diff sbagliato e stampa all'audit un «atterrato» falso, cioè
   * proprio il guasto per cui l'audit esiste (`landing-audit.ts`).
   *
   * Il buco vero era un altro e sta chiuso altrove: senza worktree non si
   * risaliva più al ramo (`delivery-branch-ref.ts`).
   */
  test("nessuno dei due punti ripiega sulla PUNTA quando i commit propri sono zero", () => {
    const punte = [
      /rev-parse["'\s,\]]+.{0,20}HEAD/s,   // `["rev-parse", "HEAD"]` in ogni spaziatura
      /symbolic-ref/,
      /\bHEAD\b["']/,
    ];
    for (const [nome, testo] of [
      ["la cattura in review", block("const taskDeliveryRef = async (taskId: string)", "const taskCheckoutRef")],
      ["il backfill", backfill()],
    ] as const) {
      const codice = testo.split("\n").filter((r) => !r.trim().startsWith("//")).join("\n");
      for (const p of punte) expect(`${nome}: ${codice}`).not.toMatch(p);
    }
  });
});

/**
 * `mergeNameStatus` contro l'uscita VERA di git, non contro una stringa che mi
 * sono scritto da solo: il parser esiste per leggere `--name-status`, e una
 * fixture inventata proverebbe che so scrivere la fixture.
 */
describe("mergeNameStatus — il flag «nato qui», su git vero", () => {
  let repo: string;
  const show = (sha: string) =>
    git(repo, "show", "--name-status", "--format=", "--no-renames", sha);

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "name-status-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    commit(repo, "vecchio.ts", "c'ero già\n", "base");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("`A` è nato qui, `M` no", () => {
    commit(repo, "nato.ts", "nuovo\n", "aggiungo");
    const sha = git(repo, "rev-parse", "HEAD");
    expect(mergeNameStatus([show(sha)])).toEqual([{ path: "nato.ts", added: true }]);

    commit(repo, "vecchio.ts", "modificato\n", "modifico");
    const sha2 = git(repo, "rev-parse", "HEAD");
    expect(mergeNameStatus([show(sha2)])).toEqual([{ path: "vecchio.ts", added: false }]);
  });

  test("nato in un commit e modificato nel successivo resta NATO QUI", () => {
    // Il motivo per cui non basta guardare l'ultimo commit: su due passaggi
    // l'ultimo dice `M`, e la card diventerebbe un `bugfix` invece di una feature.
    const nascita = git(repo, "log", "--format=%H", "-1", "--diff-filter=A", "--", "nato.ts");
    const modifica = git(repo, "rev-parse", "HEAD");
    commit(repo, "nato.ts", "nuovo, ma ritoccato\n", "ritocco");
    const ritocco = git(repo, "rev-parse", "HEAD");
    // Dal più recente al più vecchio, come li elenca `listOwnCommits`.
    const merged = mergeNameStatus([show(ritocco), show(modifica), show(nascita)]);
    expect(merged.find((f) => f.path === "nato.ts")).toEqual({ path: "nato.ts", added: true });
    expect(merged.find((f) => f.path === "vecchio.ts")).toEqual({ path: "vecchio.ts", added: false });
  });

  test("un file CANCELLATO non è un file nuovo", () => {
    rmSync(join(repo, "vecchio.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "cancello");
    const sha = git(repo, "rev-parse", "HEAD");
    expect(mergeNameStatus([show(sha)])).toEqual([{ path: "vecchio.ts", added: false }]);
  });

  test("LA CATENA INTERA: da git a `deriveKind`, senza fixture in mezzo", () => {
    // Questo è il punto in cui il pezzo o funziona o no: se il parser sbaglia
    // colonna, `added` è sempre falso e ogni consegna esce `bugfix`.
    git(repo, "checkout", "-q", "-b", "feat");
    commit(repo, "client-src-nuovo.ts", "roba\n", "feature");
    const feat = git(repo, "rev-parse", "HEAD");
    expect(deriveKind(mergeNameStatus([show(feat)]))).toBe("feature");

    commit(repo, "client-src-nuovo.ts", "roba corretta\n", "fix");
    const fix = git(repo, "rev-parse", "HEAD");
    expect(deriveKind(mergeNameStatus([show(fix)]))).toBe("bugfix");
  });
});

/**
 * IL COMMIT DI RESIDUO NON CONTA COME CONSEGNA.
 *
 * Quando la potatura trova un worktree sporco committa le modifiche da sola,
 * per non perderle. Quel commit finiva fra i «commit propri» del branch, e da
 * lì la card dichiarava un debito che non aveva: tre card reali il 21/08
 * mostravano la pastiglia «non è su main» con quel commit come consegna.
 *
 *   main      base
 *   solo-res  base ← R          (SOLO un residuo: zero commit propri)
 *   mista     base ← M ← R      (un commit vero più un residuo)
 */
describe("own-commits — il residuo della potatura non è un commit proprio", () => {
  let repo: string;
  let shaM: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "own-residuo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "T");
    commit(repo, "base.txt", "base", "base");

    git(repo, "checkout", "-q", "-b", "solo-res");
    commit(repo, "sporco.txt", "wip", RESIDUE_SUBJECT);

    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "-b", "mista");
    commit(repo, "vero.txt", "lavoro", "Il lavoro vero della card");
    shaM = git(repo, "rev-parse", "HEAD");
    commit(repo, "sporco2.txt", "wip", RESIDUE_SUBJECT);
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("un branch che porta SOLO un residuo non ha commit propri", async () => {
    expect(await listOwnCommits(repo, "solo-res", { others: [] })).toEqual([]);
    expect(await countOwnCommits(repo, "solo-res", { others: [] })).toBe(0);
  });

  test("su un branch misto resta il commit vero, e il puntatore di consegna è quello", async () => {
    const own = await listOwnCommits(repo, "mista", { others: [] });
    expect(own).toEqual([shaM]);
    expect(subject(repo, own![0])).toBe("Il lavoro vero della card");
    expect(await countOwnCommits(repo, "mista", { others: [] })).toBe(1);
  });

  test("il soggetto è filtrato come TESTO, non come regex", () => {
    // Se un metacarattere del soggetto venisse interpretato, il filtro
    // cambierebbe in silenzio ciò che toglie. `--fixed-strings` lo impedisce.
    expect(RESIDUE_SUBJECT).toBe("Residuo non committato, messo al sicuro dalla potatura");
  });
});
