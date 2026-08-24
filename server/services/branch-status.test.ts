import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  branchExistsInRepo,
  branchStatusFromRepo,
  commitIsAncestor,
  commitStatusFromRepo,
  countCommitsAhead,
  filterUniqueSourceFiles,
  worktreeDiffStat,
} from "./branch-status";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

describe("filterUniqueSourceFiles", () => {
  test("drops lockfiles, package.json, version manifests and build output", () => {
    expect(
      filterUniqueSourceFiles([
        "client/src/App.tsx",
        "bun.lock",
        "client/bun.lock",
        "package.json",
        "desktop-tauri/src-tauri/tauri.conf.json",
        "public/index-abc.js",
        "dist/x.js",
        "Cargo.toml",
        "server/foo.ts",
        "   ",
      ]),
    ).toEqual(["client/src/App.tsx", "server/foo.ts"]);
  });
});

describe("branchStatusFromRepo", () => {
  let repo: string;

  // Timeout esplicito: questo hook fa una ventina di `git` SINCRONI per montare
  // il repo di prova, e i 5s di default di bun li copre solo a macchina scarica.
  // Quando la suite gira insieme a un build o a un E2E, ogni spawn scivola a
  // qualche centinaio di ms e l'hook sfora — un rosso che non dice niente sul
  // codice sotto test. Il vero limite di questo test è la durata degli spawn,
  // non la logica, quindi il tetto sta largo.
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "bstat-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");

    // main advances: adds shared.txt=hello and sets ev.txt=NEW
    writeFileSync(join(repo, "shared.txt"), "hello\n");
    writeFileSync(join(repo, "ev.txt"), "NEW\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "main advance");

    // squash-landed: from base, add shared.txt=hello (identical content, own commit)
    git(repo, "checkout", "-q", "-b", "squash", base);
    writeFileSync(join(repo, "shared.txt"), "hello\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "add shared");

    // superseded: from base, ev.txt=OLD while main has NEW
    git(repo, "checkout", "-q", "-b", "superseded", base);
    writeFileSync(join(repo, "ev.txt"), "OLD\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "ev old");

    // genuine unlanded: uniq.txt only on the branch
    git(repo, "checkout", "-q", "-b", "unlanded", base);
    writeFileSync(join(repo, "uniq.txt"), "unique\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "uniq");

    // noise-only: change package.json (version) only, no source
    git(repo, "checkout", "-q", "-b", "noiseonly", base);
    writeFileSync(join(repo, "package.json"), '{"version":"9.9.9"}\n');
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "bump");

    // ancestor: points at main's tip
    git(repo, "checkout", "-q", "-b", "ancestor", "main");

    git(repo, "checkout", "-q", "main");
  }, 60_000);

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("ancestor of main → merged", async () => {
    expect(await branchStatusFromRepo(repo, "ancestor")).toBe("merged");
  });
  test("squash-landed (content already on main) → merged", async () => {
    expect(await branchStatusFromRepo(repo, "squash")).toBe("merged");
  });
  test("superseded (main evolved the same file) → unmerged (kept, not reaped)", async () => {
    expect(await branchStatusFromRepo(repo, "superseded")).toBe("unmerged");
  });
  test("genuine unlanded work → unmerged (kept, not reaped)", async () => {
    expect(await branchStatusFromRepo(repo, "unlanded")).toBe("unmerged");
  });
  test("noise-only diff (version bump) → merged", async () => {
    expect(await branchStatusFromRepo(repo, "noiseonly")).toBe("merged");
  });
  test("missing branch → gone", async () => {
    expect(await branchStatusFromRepo(repo, "does-not-exist")).toBe("gone");
  });
  test("null branch → gone", async () => {
    expect(await branchStatusFromRepo(repo, null)).toBe("gone");
  });
});

/**
 * Il verdetto su un COMMIT di consegna, contro un repo vero.
 *
 * Il guasto dell'11/08: la domanda era quella dei BRANCH (`main...<ref>`), che
 * su un ramo nato dall'HEAD del checkout condiviso ingloba i commit di
 * un'altra sessione. Il confronto trovava le differenze DEGLI ALTRI e timbrava
 * `unlanded` su lavoro che su main c'era — il semaforo diceva rosso anche sul
 * verde, e ha smesso di voler dire qualcosa.
 */
describe("commitStatusFromRepo", () => {
  let repo: string;
  let ereditato = "";   // consegna su un ramo che porta anche lavoro altrui, contenuto SU main
  let ricopiato = "";   // consegna atterrata con un cherry-pick: altro sha, stesso autore/oggetto
  let assente = "";     // consegna che su main non c'è, in nessuna forma
  let radice = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "cstat-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "base");
    radice = git(repo, "rev-list", "--max-parents=0", "HEAD");
    const base = git(repo, "rev-parse", "HEAD");

    // ── Il ramo di una card che è NATO dal ramo di un'altra sessione ─────────
    // Prima i commit ereditati (tanti file, mai su main), poi il commit SUO.
    git(repo, "checkout", "-q", "-b", "altra-sessione");
    for (const f of ["x1.txt", "x2.txt", "x3.txt"]) {
      writeFileSync(join(repo, f), "lavoro di un altro\n");
      git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", `altrui ${f}`);
    }
    git(repo, "checkout", "-q", "-b", "topics/card");
    writeFileSync(join(repo, "mio.txt"), "il lavoro della card\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "il lavoro della card");
    ereditato = git(repo, "rev-parse", "HEAD");

    // Su main quel contenuto ARRIVA (rimesso a mano, sha diverso e oggetto diverso).
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "mio.txt"), "il lavoro della card\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "rimesso a mano");

    // ── La consegna RICOPIATA dal land (`cherry-pick -C`) ────────────────────
    git(repo, "checkout", "-q", "-b", "topics/copia", base);
    writeFileSync(join(repo, "copiato.txt"), "sorgente\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "il commit che il land ricopia (con parentesi)");
    ricopiato = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "cherry-pick", ricopiato);
    // …e poi main EVOLVE quel file: senza il riconoscimento della copia, il
    // confronto per contenuto direbbe di nuovo `unmerged`.
    writeFileSync(join(repo, "copiato.txt"), "sorgente, poi cambiata da un'altra card\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "evoluzione successiva");

    // ── La consegna che non è mai atterrata ──────────────────────────────────
    git(repo, "checkout", "-q", "-b", "topics/persa", base);
    writeFileSync(join(repo, "persa.txt"), "lavoro mai landato\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "lavoro mai landato");
    assente = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
  }, 30_000);

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("consegna su un ramo che porta lavoro ALTRUI, contenuto su main → merged", async () => {
    // Il guasto misurato: qui `main...<commit>` differisce per i 3 file
    // dell'altra sessione, e la vecchia domanda rispondeva `unmerged`.
    expect(await commitStatusFromRepo(repo, ereditato)).toBe("merged");
  });

  test("il controllo: la stessa forma senza il contenuto su main → unmerged", async () => {
    expect(await commitStatusFromRepo(repo, assente)).toBe("unmerged");
  });

  test("consegna RICOPIATA dal land (altro sha) → merged, anche dopo che main ha evoluto quel file", async () => {
    expect(await commitStatusFromRepo(repo, ricopiato)).toBe("merged");
  });

  test("commit RADICE (nessun padre) → si guarda comunque il suo contenuto", async () => {
    expect(await commitStatusFromRepo(repo, radice)).toBe("merged");
  });

  test("commit non più nel repo, o assente → gone, mai «non atterrato»", async () => {
    expect(await commitStatusFromRepo(repo, "0".repeat(40))).toBe("gone");
    expect(await commitStatusFromRepo(repo, null)).toBe("gone");
  });
});

/**
 * I due fatti su cui si regge il messaggio di abbandono (task `5770b9de`): il
 * ref risolve, sì o no, e quanto porta oltre main. Un errore qui rimette in
 * circolo la rassicurazione falsa, quindi si misura contro un repo vero.
 */
describe("branchExistsInRepo / countCommitsAhead", () => {
  let repo: string;

  // Stesso motivo del timeout sopra: il costo è negli spawn di git, non nella logica.
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "bexist-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "base");

    // vivo: due commit propri oltre main
    git(repo, "checkout", "-q", "-b", "topics/vivo");
    writeFileSync(join(repo, "b.txt"), "1\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "uno");
    writeFileSync(join(repo, "b.txt"), "2\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "due");

    // fermo sulla punta di main: esiste ma non porta niente
    git(repo, "checkout", "-q", "-b", "topics/fermo", "main");
    git(repo, "checkout", "-q", "main");
  }, 60_000);

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("branch presente → true, e i commit oltre main sono contati", async () => {
    expect(await branchExistsInRepo(repo, "topics/vivo")).toBe(true);
    expect(await countCommitsAhead(repo, "topics/vivo")).toBe(2);
  });

  test("branch presente ma fermo su main → 0 commit (esiste, non porta niente)", async () => {
    expect(await branchExistsInRepo(repo, "topics/fermo")).toBe(true);
    expect(await countCommitsAhead(repo, "topics/fermo")).toBe(0);
  });

  // Il caso del task: il ref nominato nel messaggio non esiste.
  test("branch inesistente → false, e il conteggio è null (MAI 0)", async () => {
    expect(await branchExistsInRepo(repo, "topics/vibrant-creek")).toBe(false);
    expect(await countCommitsAhead(repo, "topics/vibrant-creek")).toBeNull();
  });

  test("branch null → false / null", async () => {
    expect(await branchExistsInRepo(repo, null)).toBe(false);
    expect(await countCommitsAhead(repo, null)).toBeNull();
  });

  test("repo non raggiungibile → false e null, mai un numero inventato", async () => {
    const nowhere = join(tmpdir(), "bexist-non-esiste-affatto");
    expect(await branchExistsInRepo(nowhere, "topics/vivo")).toBe(false);
    expect(await countCommitsAhead(nowhere, "topics/vivo")).toBeNull();
  });

  test("main inesistente → il conteggio si arrende invece di mentire", async () => {
    expect(await countCommitsAhead(repo, "topics/vivo", "ramo-che-non-esiste")).toBeNull();
  });
});

/**
 * Il numero con cui l'umano sceglie il vincitore del fan-out. Il difetto che
 * chiude questo blocco: il worktree di un tentativo nasce da `HEAD` del checkout
 * CONDIVISO, quindi il vecchio `merge-base(main, HEAD)..HEAD` gli attribuiva
 * anche i commit dell'altra sessione parcheggiata lì.
 *
 *   main         base
 *   dev          base ← A          (l'altra sessione: 40 righe in wip.txt)
 *   topics/card  base ← A ← M      (eredita A, produce M: 3 righe in mio.txt)
 *   topics/vuota base ← A          (eredita e basta)
 */
describe("worktreeDiffStat", () => {
  let repo: string;
  let shaM: string;

  // Timeout largo per la stessa ragione dei blocchi sopra: sono spawn di git.
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "wtstat-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "base");

    git(repo, "checkout", "-q", "-b", "dev");
    writeFileSync(join(repo, "wip.txt"), Array.from({ length: 40 }, (_, i) => `altrui ${i}\n`).join(""));
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "WIP di un'altra sessione");

    git(repo, "checkout", "-q", "-b", "topics/card", "dev");
    writeFileSync(join(repo, "mio.txt"), "uno\ndue\ntre\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "il mio lavoro");
    shaM = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-q", "-b", "topics/vuota", "dev");

    // Nato dalla radice: il commit più vecchio proprio non ha un padre.
    git(repo, "checkout", "-q", "--orphan", "topics/orfana");
    git(repo, "rm", "-rq", "--cached", ".");
    rmSync(join(repo, "wip.txt"), { force: true });
    rmSync(join(repo, "a.txt"), { force: true });
    writeFileSync(join(repo, "solo.txt"), "x\ny\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "radice");

    git(repo, "checkout", "-q", "main");
  }, 60_000);

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("conta SOLO il lavoro proprio, non i commit ereditati dall'altra sessione", async () => {
    // Il controllo che rende il test capace di fallire: dal merge-base con main
    // il ramo mostra DUE file e 43 righe, cioè la vecchia risposta sbagliata.
    expect(git(repo, "diff", "--numstat", "main", "topics/card").split("\n").length).toBe(2);

    const stat = await worktreeDiffStat(repo, { branch: "topics/card" });
    expect(stat).toEqual({ commit: shaM, filesChanged: 1, insertions: 3, deletions: 0 });
  });

  test("il branch si legge da HEAD quando il chiamante non lo passa", async () => {
    git(repo, "checkout", "-q", "topics/card");
    try {
      expect(await worktreeDiffStat(repo)).toEqual({ commit: shaM, filesChanged: 1, insertions: 3, deletions: 0 });
    } finally { git(repo, "checkout", "-q", "main"); }
  });

  test("solo lavoro ereditato → zero MISURATO, non il diff di un altro", async () => {
    expect(await worktreeDiffStat(repo, { branch: "topics/vuota" }))
      .toEqual({ commit: null, filesChanged: 0, insertions: 0, deletions: 0 });
  });

  test("commit proprio senza padre (radice) → si misura dall'albero vuoto", async () => {
    const stat = await worktreeDiffStat(repo, { branch: "topics/orfana" });
    expect(stat).toMatchObject({ filesChanged: 1, insertions: 2, deletions: 0 });
    expect(stat?.commit).toBe(git(repo, "rev-parse", "topics/orfana"));
  });

  test("HEAD staccato → null: senza branch non si sa cosa è suo", async () => {
    git(repo, "checkout", "-q", "--detach", "topics/card");
    try {
      expect(await worktreeDiffStat(repo)).toBeNull();
    } finally { git(repo, "checkout", "-q", "main"); }
  });

  test("branch o repo non contabili → null, MAI uno zero", async () => {
    expect(await worktreeDiffStat(repo, { branch: "topics/non-esiste" })).toBeNull();
    expect(await worktreeDiffStat(repo, { branch: "topics/card", mainRef: "ramo-che-non-esiste" })).toBeNull();
    expect(await worktreeDiffStat(join(tmpdir(), "wtstat-non-esiste-affatto"), { branch: "topics/card" })).toBeNull();
  });
});

/**
 * LA PROVA CHE UN LAND HA ATTERRATO, e la ragione per cui non basta il codice
 * di uscita di `git merge`: il 13/08 tre card sono passate a `done` col ramo
 * mai arrivato su main. Una fusione riuscita dice che una fusione è riuscita,
 * non su quale ramo — qui si chiede a main, con un repo vero.
 */
describe("commitIsAncestor", () => {
  let repo: string;
  let suMain: string;
  let fuori: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "anc-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "base");
    suMain = git(repo, "rev-parse", "HEAD");

    // Un commit su un ALTRO ramo: è esattamente il caso del land che fonde su
    // un checkout parcheggiato altrove, o su un worktree mai ricucito.
    git(repo, "checkout", "-q", "-b", "topics/altrove");
    writeFileSync(join(repo, "b.txt"), "lavoro\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "fuso ma non su main");
    fuori = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
  });

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("dentro main = true · fuori da main = false", async () => {
    expect(await commitIsAncestor(repo, suMain, "main")).toBe(true);
    expect(await commitIsAncestor(repo, fuori, "main")).toBe(false);
  });

  test("git che non sa rispondere vale «non lo so», non un no", async () => {
    // Il no e il non-lo-so si comportano in modo diverso a valle: il no ferma il
    // land, il non-lo-so lascia il verdetto «non verificabile». Confonderli
    // rimetterebbe in circolo un'accusa (o un'assoluzione) inventata.
    expect(await commitIsAncestor(repo, "0".repeat(40), "main")).toBeNull();
    expect(await commitIsAncestor(repo, suMain, "ramo-che-non-esiste")).toBeNull();
    expect(await commitIsAncestor(join(tmpdir(), "anc-non-esiste-affatto"), suMain, "main")).toBeNull();
  });
});
