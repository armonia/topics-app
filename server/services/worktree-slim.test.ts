/**
 * Il contratto di `worktree-slim`: si butta SOLO ciò che è provabilmente
 * rigenerabile, e cancellarlo non può cambiare una riga di `git status`.
 *
 * I due cancelli sono collaudati separatamente (funzioni pure) e insieme su un
 * repo git VERO con un worktree vero — perché la promessa che conta («l'albero
 * resta pulito, il ramo resta») è una promessa su git, non su una lista di
 * stringhe, e si verifica solo chiedendola a git.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  directorySizeBytes,
  formatMb,
  isSlimmableDirName,
  parseSlimSkip,
  pickSlimTargets,
  slimWorktree,
} from "./worktree-slim";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

const never = () => false;
const always = () => true;

describe("isSlimmableDirName — primo cancello", () => {
  test("i nomi non ambigui passano da soli", () => {
    for (const n of ["node_modules", ".next", ".turbo", "__pycache__"]) {
      expect(isSlimmableDirName(n, never)).toBe(true);
    }
  });

  // 12 GB su 27 il 16/08, quasi tutti sotto quadra dove la UAT gira con video e
  // trace accesi. Il GC ci passava sopra senza vederli.
  test("gli artefatti di Playwright passano, `videos` no", () => {
    expect(isSlimmableDirName("test-results", never)).toBe(true);
    expect(isSlimmableDirName("playwright-report", never)).toBe(true);
    // Fuori apposta: il nome non dice di chi e', e una cartella di video puo'
    // essere l'unica copia di qualcosa. Pesa, e si lascia stare lo stesso.
    expect(isSlimmableDirName("videos", never)).toBe(false);
    expect(isSlimmableDirName("videos", always)).toBe(false);
  });

  test("`target` passa solo con il CACHEDIR.TAG di cargo", () => {
    expect(isSlimmableDirName("target", never)).toBe(false);
    expect(isSlimmableDirName("target", (f) => f === "CACHEDIR.TAG")).toBe(true);
  });

  test("chi è nella lista dei risparmiati non passa più", () => {
    const skip = parseSlimSkip("target, node_modules");
    expect(isSlimmableDirName("target", always, skip)).toBe(false);
    expect(isSlimmableDirName("node_modules", always, skip)).toBe(false);
    expect(isSlimmableDirName(".next", always, skip)).toBe(true);
  });

  test("i nomi generici NON passano, nemmeno con un marker addosso", () => {
    // `dist`, `build`, `data`, `out` sono fuori dalla lista apposta: il loro
    // nome non promette niente su cosa contengono.
    for (const n of ["dist", "build", "out", "data", "coverage", ".env"]) {
      expect(isSlimmableDirName(n, always)).toBe(false);
    }
  });
});

describe("pickSlimTargets — secondo cancello", () => {
  const cands = ["node_modules", "client/node_modules", ".next"];

  test("passa solo ciò che git dichiara ignorato", () => {
    const v = pickSlimTargets(cands, new Set(["node_modules"]), new Set());
    expect(v.purge).toEqual(["node_modules"]);
    expect(v.refused.map((r) => r.reason)).toEqual(["non ignorato da git", "non ignorato da git"]);
  });

  test("un file tracciato batte tutto, anche un percorso dichiarato ignorato", () => {
    const v = pickSlimTargets([".next"], new Set([".next"]), new Set([".next"]));
    expect(v.purge).toEqual([]);
    expect(v.refused).toEqual([{ relPath: ".next", reason: "contiene file tracciati" }]);
  });

  test("ignorato MA con file tracciati dentro → si rifiuta", () => {
    const v = pickSlimTargets(cands, new Set(cands), new Set([".next"]));
    expect(v.purge).toEqual(["node_modules", "client/node_modules"]);
    expect(v.refused).toEqual([{ relPath: ".next", reason: "contiene file tracciati" }]);
  });

  test("nessun candidato ⇒ nessuna decisione", () => {
    expect(pickSlimTargets([], new Set(), new Set())).toEqual({ purge: [], refused: [] });
  });
});

describe("slimWorktree — su un worktree git vero", () => {
  let repo: string;
  let wt: string;
  let before: { status: string; branch: string; head: string };
  let result: Awaited<ReturnType<typeof slimWorktree>>;

  // Come in `branch-status.test.ts`: l'hook monta un repo con una ventina di
  // spawn sincroni, e i 5s di default di bun li coprono solo a macchina scarica.
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "wtslim-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(
      join(repo, ".gitignore"),
      // `.next/` e `dist/` sono ignorati entrambi: solo il primo è nella lista
      // degli artefatti. `segreti/` è ignorato e NON è un artefatto — è il caso
      // che dimostra perché il cancello dei nomi esiste.
      "node_modules/\n.next/\ndist/\ntarget/\nsegreti/\n",
    );
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");

    wt = join(repo, "..", `wtslim-tree-${process.pid}`);
    git(repo, "worktree", "add", "-q", "-b", "topics/prova", wt, "main");

    // Dipendenze e cache di build, a più livelli.
    mkdirSync(join(wt, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "left-pad", "index.js"), "x".repeat(4096));
    mkdirSync(join(wt, "client", "node_modules", "react"), { recursive: true });
    writeFileSync(join(wt, "client", "node_modules", "react", "index.js"), "y".repeat(2048));
    mkdirSync(join(wt, "target"), { recursive: true });
    writeFileSync(join(wt, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    writeFileSync(join(wt, "target", "big.rlib"), "z".repeat(8192));

    // Ignorato ma NON un artefatto: deve sopravvivere.
    mkdirSync(join(wt, "segreti"), { recursive: true });
    writeFileSync(join(wt, "segreti", "chiave.pem"), "PRIVATE\n");
    // Ignorato, nome generico fuori lista: deve sopravvivere.
    mkdirSync(join(wt, "dist"), { recursive: true });
    writeFileSync(join(wt, "dist", "bundle.js"), "bundle\n");

    // Artefatto per nome, MA con dentro un file tracciato a forza: il secondo
    // cancello lo deve fermare, o `git status` direbbe "deleted".
    mkdirSync(join(wt, ".next"), { recursive: true });
    writeFileSync(join(wt, ".next", "tenuto.txt"), "tracciato a forza\n");
    git(wt, "add", "-f", ".next/tenuto.txt");
    git(wt, "commit", "-qm", "un file tracciato sotto un percorso ignorato");

    // Lavoro non committato: non è un artefatto, non si tocca.
    writeFileSync(join(wt, "app.ts"), "export const x = 2;\n");

    before = {
      status: git(wt, "status", "--porcelain"),
      branch: git(repo, "rev-parse", "--verify", "refs/heads/topics/prova"),
      head: git(wt, "rev-parse", "HEAD"),
    };
    result = await slimWorktree(wt);
  }, 30_000);

  afterAll(() => {
    try { git(repo, "worktree", "remove", "--force", wt); } catch { /* best-effort */ }
    rmSync(repo, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  test("gli artefatti spariscono, a ogni livello", () => {
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    expect(existsSync(join(wt, "client", "node_modules"))).toBe(false);
    expect(existsSync(join(wt, "target"))).toBe(false);
    expect(result.removed.map((r) => r.relPath).sort()).toEqual(["client/node_modules", "node_modules", "target"]);
    expect(result.errors).toEqual([]);
  });

  test("i byte liberati sono contati, non stimati", () => {
    // 4 KB + 2 KB + 8 KB di contenuto, più i blocchi delle directory: il totale
    // non può essere zero e non può essere assurdo.
    expect(result.bytes).toBeGreaterThan(14 * 1024);
    expect(result.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(result.removed.every((r) => r.bytes > 0)).toBe(true);
  });

  test("ciò che è ignorato ma non è un artefatto resta dov'è", () => {
    expect(existsSync(join(wt, "segreti", "chiave.pem"))).toBe(true);
    expect(existsSync(join(wt, "dist", "bundle.js"))).toBe(true);
  });

  test("un artefatto con dentro un file TRACCIATO viene rifiutato", () => {
    expect(existsSync(join(wt, ".next", "tenuto.txt"))).toBe(true);
    expect(result.refused).toEqual([{ relPath: ".next", reason: "contiene file tracciati" }]);
  });

  test("BARRA — `git status` identico a prima, e pulito dove lo era", () => {
    expect(git(wt, "status", "--porcelain")).toBe(before.status);
    // L'unica riga sporca è il lavoro non committato che c'era già (`git()`
    // fa `.trim()`, quindi lo spazio iniziale di ` M` non arriva fin qui).
    expect(git(wt, "status", "--porcelain")).toBe("M app.ts");
  });

  test("BARRA — il branch e il commit sono ancora lì", () => {
    expect(git(repo, "rev-parse", "--verify", "refs/heads/topics/prova")).toBe(before.branch);
    expect(git(wt, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("topics/prova");
  });

  test("il lavoro non committato sopravvive intatto", () => {
    expect(Bun.file(join(wt, "app.ts")).text()).resolves.toBe("export const x = 2;\n");
  });

  test("una seconda passata non trova più niente da fare", async () => {
    const again = await slimWorktree(wt);
    expect(again.removed).toEqual([]);
    expect(again.bytes).toBe(0);
  });

  test("una radice che non esiste non è un errore", async () => {
    expect(await slimWorktree(join(wt, "non-esiste"))).toEqual({ removed: [], bytes: 0, refused: [], errors: [] });
  });
});

describe("parseSlimSkip", () => {
  test("vuoto o assente = non risparmiare niente", () => {
    expect(parseSlimSkip(undefined).size).toBe(0);
    expect(parseSlimSkip("  ,, ").size).toBe(0);
  });

  test("lista separata da virgole, spazi tollerati", () => {
    expect([...parseSlimSkip(" target , .next ")]).toEqual(["target", ".next"]);
  });
});

describe("directorySizeBytes / formatMb", () => {
  test("una cartella assente vale zero", async () => {
    expect(await directorySizeBytes(join(tmpdir(), `manca-${process.pid}`))).toBe(0);
  });

  test("formatMb arrotonda a una cifra", () => {
    expect(formatMb(0)).toBe("0.0 MB");
    expect(formatMb(260 * 1_048_576)).toBe("260.0 MB");
  });
});
