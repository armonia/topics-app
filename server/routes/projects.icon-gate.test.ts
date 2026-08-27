/**
 * @covers PROJECT-05
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createProjectsRouter } from "./projects";

/**
 * IL CANCELLO DI `GET /api/projects/icon`.
 *
 * La rotta serve un file preso da una cartella che il CLIENT nomina, quindi
 * senza allowlist è enumerazione del disco sulla nostra origine. Con
 * un'allowlist troppo stretta, invece, sparisce l'icona di progetti veri: è già
 * successo due volte, ed è la ragione per cui il confine è un'UNIONE
 * (`services/known-project-dirs.ts`) e non `projectStore`.
 *
 * Il caso che questo file inchioda — misurato il 2026-08-07 sul server vivo, su
 * cinque progetti del workspace di OpenClaw:
 *
 *     open-carousel  204   match-compass  204   generale  204
 *     dashboard      403   dancerooms     403
 *
 * I tre 204 («questo progetto non ha un'icona», esito legittimo) erano coperti
 * da `ui_state` o dal `projectPath` di un topic. Gli altri due comparivano
 * NELL'INDICE della board — cioè l'utente li vedeva in lista — ma non stavano
 * in nessuna delle cinque sorgenti dell'allowlist, perché la sesta (i progetti
 * enumerati nel workspace) viveva solo dentro l'indice. Visti e negati.
 *
 * Non era una cache: questa rotta l'allowlist la ricalcola a ogni richiesta.
 * Il test lo dimostra dal comportamento, non dal codice — lo STESSO router,
 * senza ricrearlo, passa da 403 a 200 appena il progetto diventa noto.
 */

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"), xp = pathname.split("/");
  if (pp.length !== xp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

// Un PNG 1x1 vero: il resolver accetta il file per estensione, ma la risposta
// deve poter essere confrontata byte a byte con ciò che c'è su disco.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let root: string;
let openclawDir: string;
let workspaceDir: string;
let db: Database;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;
// Sorgenti dell'allowlist mutabili DOPO la creazione del router: è il punto del
// file — il confine si rilegge a ogni richiesta, non si congela all'avvio.
let topicPaths: string[] = [];

/** Un progetto nel workspace: marcatore + favicon. Senza marcatore è una husk. */
function makeWorkspaceProject(name: string, opts: { marker?: boolean; icon?: boolean } = {}) {
  const dir = join(workspaceDir, name);
  mkdirSync(dir, { recursive: true });
  if (opts.marker !== false) writeFileSync(join(dir, "CLAUDE.md"), `# ${name}\n`);
  if (opts.icon !== false) writeFileSync(join(dir, "favicon.png"), PNG_1x1);
  return dir;
}

function icon(dir: string): Promise<Response | null> {
  const url = new URL(`http://x/api/projects/icon?path=${encodeURIComponent(dir)}`);
  return router(new Request(url), url, "/api/projects/icon", "GET");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "icon-gate-"));
  openclawDir = join(root, ".openclaw");
  workspaceDir = join(openclawDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  db = new Database(":memory:");
  db.run(`CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)`);
  db.run(`CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT)`);

  topicPaths = [];
  const ctx = {
    db,
    OPENCLAW_DIR: openclawDir,
    loadTopics: () => ({ topics: Object.fromEntries(topicPaths.map((p, i) => [`t${i}`, { projectPath: p }])) }),
    worktreeStore: { list: () => [] },
    projectStore: { list: () => [] },
    json: (data: any, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute,
    errorResponse: (status: number, error: string) =>
      new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } }),
    broadcastToAll: () => {},
  } as unknown as AppContext;
  router = createProjectsRouter(ctx) as typeof router;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/projects/icon — il cancello", () => {
  test("un progetto che diventa noto DOPO un diniego serve la sua icona (nessun diniego in cache)", async () => {
    const dir = join(workspaceDir, "dancerooms");
    mkdirSync(dir, { recursive: true });
    // Cartella nuda: nessuna sorgente la conosce ancora.
    expect((await icon(dir))!.status).toBe(403);

    // Ora diventa un progetto vero (marcatore + icona), senza toccare il
    // router: è il caso «l'ho appena aperto e l'icona non arriva».
    writeFileSync(join(dir, "CLAUDE.md"), "# dancerooms\n");
    writeFileSync(join(dir, "favicon.png"), PNG_1x1);

    const res = (await icon(dir))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_1x1));
  });

  test("noto e senza icona = 204, non 403: «non ne ha» è una risposta riuscita", async () => {
    const dir = makeWorkspaceProject("open-carousel", { icon: false });
    const res = (await icon(dir))!;
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("max-age=120");
  });

  test("noto anche per le altre sorgenti: il progetto di un topic, la cwd di un terminale", async () => {
    // Fuori dal workspace: qui il progetto entra solo dalle sorgenti 2 e 4.
    const daTopic = join(root, "progetti", "da-topic");
    const fromTerminal = join(root, "progetti", "da-terminale");
    for (const d of [daTopic, fromTerminal]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "favicon.png"), PNG_1x1);
    }
    expect((await icon(daTopic))!.status).toBe(403);
    expect((await icon(fromTerminal))!.status).toBe(403);

    topicPaths.push(daTopic);
    db.run("INSERT INTO terminal_sessions (id, cwd) VALUES (?, ?)", ["s1", fromTerminal]);

    expect((await icon(daTopic))!.status).toBe(200);
    expect((await icon(fromTerminal))!.status).toBe(200);
  });

  test("il confine NON è «qualunque cosa dentro il workspace»: una husk senza marcatore resta negata", async () => {
    // Una cartella che il workspace si ritrova addosso (artefatti di runtime di
    // un giro catch-all) non è un progetto: l'indice della board non la mostra,
    // e l'icona non deve leggerne i file.
    const husk = makeWorkspaceProject("husk", { marker: false });
    expect((await icon(husk))!.status).toBe(403);
  });

  test("una sottocartella di un progetto noto non è un progetto noto (match esatto)", async () => {
    const proj = makeWorkspaceProject("dashboard");
    const dentro = join(proj, "public");
    mkdirSync(dentro, { recursive: true });
    writeFileSync(join(dentro, "favicon.png"), PNG_1x1);
    expect((await icon(proj))!.status).toBe(200);
    expect((await icon(dentro))!.status).toBe(403);
  });

  test("una cartella qualunque del disco resta 403, e una inesistente 404", async () => {
    const estranea = join(root, "estranea");
    mkdirSync(estranea, { recursive: true });
    writeFileSync(join(estranea, "favicon.png"), PNG_1x1);
    expect((await icon(estranea))!.status).toBe(403);
    expect((await icon(join(root, "non-esiste")))!.status).toBe(404);
  });
});
