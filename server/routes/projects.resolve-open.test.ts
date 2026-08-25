/**
 * @covers PROJECT-10
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createProjectsRouter } from "./projects";

/**
 * `GET /api/projects/resolve-open` — la porta di «Apri con Topics».
 *
 * Il guscio consegna un path e basta; la domanda «che tab apro» ha una
 * risposta sola, e questa rotta è dove il client la va a prendere. Qui si
 * prova sul filesystem VERO: la sonda si prova a parte con un disco finto
 * (`server/lib/os-open-path.test.ts`), ma il giro completo deve dimostrare che
 * la rotta esiste, risponde JSON, e non viene mangiata dal matcher di
 * `/api/projects/:id` che le sta sotto.
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

let root: string;
let db: Database;
let projects: Array<{ id: string; path: string; archived?: number }> = [];
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;

function resolveOpen(path: string): Promise<Response | null> {
  const url = new URL(`http://x/api/projects/resolve-open?path=${encodeURIComponent(path)}`);
  return router(new Request(url), url, "/api/projects/resolve-open", "GET");
}

async function target(path: string) {
  const res = (await resolveOpen(path))!;
  expect(res.status).toBe(200);
  return (await res.json()).target;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resolve-open-"));
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT)`);
  projects = [];
  const ctx = {
    db,
    OPENCLAW_DIR: join(root, ".openclaw"),
    loadTopics: () => ({ topics: {} }),
    worktreeStore: { list: () => [] },
    projectStore: { list: () => projects },
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

describe("GET /api/projects/resolve-open", () => {
  test("una cartella si apre come progetto", async () => {
    const dir = join(root, "app");
    mkdirSync(dir, { recursive: true });
    expect(await target(dir)).toEqual({ kind: "project", key: dir });
  });

  test("un file apre il progetto che lo contiene, con il file a fuoco", async () => {
    const dir = join(root, "app");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    const file = join(dir, "src", "index.ts");
    writeFileSync(file, "export {};\n");
    expect(await target(file)).toEqual({ kind: "file", key: file, projectPath: dir });
  });

  test("un progetto già registrato vince sul marcatore più vicino", async () => {
    const mono = join(root, "mono");
    const pkg = join(mono, "packages", "ui");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{}\n");
    mkdirSync(join(mono, ".git"), { recursive: true });
    const file = join(pkg, "src", "a.ts");
    writeFileSync(file, "export {};\n");

    // Senza registro: la radice col `.git`.
    expect(await target(file)).toMatchObject({ projectPath: mono });

    // Con il pacchetto già aperto in app: quello, o la sidebar si riempie di
    // due righe per la stessa cosa.
    projects = [{ id: "p1", path: pkg }];
    expect(await target(file)).toMatchObject({ projectPath: pkg });
  });

  test("un path inesistente risponde null, non conia una cartella", async () => {
    expect(await target(join(root, "mai-esistito"))).toBeNull();
  });

  test("senza path è 400", async () => {
    const url = new URL("http://x/api/projects/resolve-open");
    const res = (await router(new Request(url), url, "/api/projects/resolve-open", "GET"))!;
    expect(res.status).toBe(400);
  });
});
