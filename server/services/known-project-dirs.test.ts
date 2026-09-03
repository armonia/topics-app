/**
 * @covers PROJECT-11
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownProjectDirs, isInsideKnownProject } from "./known-project-dirs";

/**
 * L'UNIONE è il confine di ogni rotta che accetta un `path` dal client (icona,
 * file). Due modi di sbagliarla, ed entrambi sono già successi:
 *  - troppo stretta → sparisce l'icona di progetti veri (403 su roba che
 *    l'utente vede in lista);
 *  - troppo larga → enumerazione del disco sulla nostra origine.
 * Qui si fissa COSA ci entra, sorgente per sorgente, e soprattutto che si
 * RICALCOLA: una lista congelata trasforma un ritardo in un diniego.
 */

let root: string;
let workspaceDir: string;
let db: Database;

function ctxBase() {
  return {
    db: db as any,
    loadTopics: () => ({ topics: {} as Record<string, unknown> }),
    worktreeStore: { list: () => [] as unknown[] },
    workspaceDir,
  };
}

/** Cartella nel workspace: con marcatore è un progetto, senza è una husk. */
function wsDir(name: string, marker = true) {
  const dir = join(workspaceDir, name);
  mkdirSync(dir, { recursive: true });
  if (marker) writeFileSync(join(dir, "package.json"), "{}\n");
  return dir;
}

beforeEach(() => {
  // realpath sulla radice: il Set esce già risolto (su macOS `/var/folders/…`
  // è un symlink per `/private/var/folders/…`), e senza questo il confronto
  // fallirebbe per il symlink, non per la logica.
  root = realpathSync(mkdtempSync(join(tmpdir(), "known-dirs-")));
  workspaceDir = join(root, ".openclaw", "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  db = new Database(":memory:");
  db.run(`CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)`);
  db.run(`CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT)`);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("knownProjectDirs — le sorgenti", () => {
  test("sorgente 6: i progetti enumerati nel workspace (marcatore obbligatorio)", () => {
    const vero = wsDir("dashboard");
    const husk = wsDir("husk", false);
    const dirs = knownProjectDirs(ctxBase());
    expect(dirs.has(vero)).toBe(true);
    // Una husk (artefatti di runtime di un giro catch-all) non è un progetto:
    // l'indice della board non la mostra, e il confine non deve aprirla.
    expect(dirs.has(husk)).toBe(false);
  });

  test("senza `workspaceDir` esplicito si deduce dall'ambiente (le rotte dei file non ce l'hanno)", () => {
    const prevApp = process.env.APP_DATA_DIR;
    const prevOc = process.env.OPENCLAW_DIR;
    process.env.APP_DATA_DIR = join(root, ".openclaw");
    delete process.env.OPENCLAW_DIR;
    try {
      const vero = wsDir("dancerooms");
      const { workspaceDir: _omesso, ...senza } = ctxBase();
      expect(knownProjectDirs(senza).has(vero)).toBe(true);
    } finally {
      if (prevApp === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = prevApp;
      if (prevOc !== undefined) process.env.OPENCLAW_DIR = prevOc;
    }
  });

  test("le altre sorgenti: topic, worktree, cwd dei terminali, token `project:` in ui_state", () => {
    const mk = (name: string) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
    const daTopic = mk("da-topic"), daWorktree = mk("da-worktree"), daTerm = mk("da-terminale");
    const daPane = mk("da-pane"), daSidebar = mk("da-sidebar");
    db.run("INSERT INTO terminal_sessions (id, cwd) VALUES (?, ?)", ["s1", daTerm]);
    // Le due codifiche che circolano davvero: il pane id percent-encoda, la
    // sidebar tiene il path grezzo.
    db.run("INSERT INTO ui_state (key, value) VALUES (?, ?)", [
      "panes", JSON.stringify({ id: `project:${encodeURIComponent(daPane)}` }),
    ]);
    db.run("INSERT INTO ui_state (key, value) VALUES (?, ?)", [
      "sidebar", JSON.stringify({ expandedNodes: [`project:${daSidebar}`] }),
    ]);

    const dirs = knownProjectDirs({
      ...ctxBase(),
      loadTopics: () => ({ topics: { t1: { projectPath: daTopic } } }),
      worktreeStore: { list: () => [{ absPath: daWorktree }] },
    });
    for (const d of [daTopic, daWorktree, daTerm, daPane, daSidebar]) expect(dirs.has(d)).toBe(true);
    expect(dirs.has(join(root, "estranea"))).toBe(false);
  });

  test("HOME, its ancestors and `/` never become a root, whichever source carries them", () => {
    // A terminal opened without `cwd` is stored with the HOME default, and a
    // root at HOME makes every file under home "inside a known project":
    // measured 2026-09-03, `/preview/Users/<me>/.ssh/known_hosts` answered
    // 200 from loopback. The rule is on the entry point, so a project pane
    // opened on `~` (source 5) or a topic bound to `~` (source 2) is dropped
    // the same way, while a real project under HOME stays.
    const prevHome = process.env.HOME;
    const home = join(root, "home");
    const project = join(home, "Projects", "app");
    mkdirSync(project, { recursive: true });
    process.env.HOME = home;
    try {
      db.run("INSERT INTO terminal_sessions (id, cwd) VALUES (?, ?)", ["s-home", home]);
      db.run("INSERT INTO terminal_sessions (id, cwd) VALUES (?, ?)", ["s-root", "/"]);
      db.run("INSERT INTO terminal_sessions (id, cwd) VALUES (?, ?)", ["s-ancestor", root]);
      db.run("INSERT INTO terminal_sessions (id, cwd) VALUES (?, ?)", ["s-project", project]);
      db.run("INSERT INTO ui_state (key, value) VALUES (?, ?)", [
        "panes", JSON.stringify({ id: `project:${encodeURIComponent(home)}` }),
      ]);
      const dirs = knownProjectDirs({
        ...ctxBase(),
        loadTopics: () => ({ topics: { t1: { projectPath: home } } }),
      });
      expect(dirs.has(project)).toBe(true);
      for (const broad of [home, root, "/"]) {
        expect(`${broad}:${dirs.has(broad)}`).toBe(`${broad}:false`);
      }
      expect(isInsideKnownProject(join(home, ".ssh", "known_hosts"), dirs)).toBe(false);
      expect(isInsideKnownProject(join(project, "src", "a.ts"), dirs)).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    }
  });

  test("si RICALCOLA: ciò che diventa un progetto dopo un diniego entra al giro dopo", () => {
    const dir = join(workspaceDir, "nuovo");
    mkdirSync(dir, { recursive: true });
    expect(knownProjectDirs(ctxBase()).has(dir)).toBe(false);
    writeFileSync(join(dir, "CLAUDE.md"), "# nuovo\n");
    // Nessuna memoizzazione dentro la funzione: chi la mette in cache (le rotte
    // dei file, 5s di TTL) deve saperla rinfrescare PRIMA di negare.
    expect(knownProjectDirs(ctxBase()).has(dir)).toBe(true);
  });
});

describe("isInsideKnownProject — il separatore è load-bearing", () => {
  test("la dir stessa e i suoi discendenti sì, il fratello col prefisso in comune no", () => {
    const allowed = new Set(["/Users/me/proj"]);
    expect(isInsideKnownProject("/Users/me/proj", allowed)).toBe(true);
    expect(isInsideKnownProject("/Users/me/proj/src/a.ts", allowed)).toBe(true);
    expect(isInsideKnownProject("/Users/me/proj-segreto", allowed)).toBe(false);
  });
});
