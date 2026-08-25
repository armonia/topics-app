/**
 * PATCH task con preview_image che punta a un file inesistente: deve tornare 400.
 *
 * Causa: la route accettava un path valido nell'allowlist ma non presente sul
 * disco. Il file passava allowlist + tipo mostrabile, ma il file non c'era:
 * la card mostrava un'icona rotta e pareva "consegnata".
 *
 * Il fix aggiunge il controllo `existsSync(raw)` nella funzione `acceptPreview`
 * di server/routes/tasks.ts, dopo i due controlli esistenti (allowlist + tipo).
 *
 * Questo test verifica che:
 *  - PATCH con un path inesistente (ma nell'allowlist) torni 400 con la ragione
 *  - PATCH con stringa vuota torni 200 (azzerare e' lecito)
 *  - PATCH con un path esistente torni 200
  * @covers KANBAN-23
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "../../server/routes/tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../../server/db/test-schema";
import type { RouteHandler } from "../../server/types";

const PROJECT_ID = "proj-test-preview";
const TASK_ID = "task-test-preview-1";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASKS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS board_settings (
    project_id TEXT PRIMARY KEY, auto_dispatch INTEGER NOT NULL DEFAULT 0,
    dispatch_retry_cap INTEGER, review_checks TEXT,
    max_agents INTEGER DEFAULT 5, max_agents_auto INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worktree_id TEXT, topic_id TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL DEFAULT 'running',
    diff_files INTEGER, diff_insertions INTEGER, diff_deletions INTEGER,
    own_commits TEXT, delivery_branch TEXT
  )`);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, created_at, updated_at)
     VALUES (?, ?, 'test task', 'todo', 2, 0, '2026-01-01', '2026-01-01')`,
    [TASK_ID, PROJECT_ID],
  );
  return db;
}

function makeRouter(db: Database, homeDir: string): RouteHandler {
  function isPathAllowed(p: string): boolean {
    // Simula l'allowlist: accetta path sotto ~/.topics/media e ~/.openclaw/media
    return p.startsWith(join(homeDir, ".topics", "media")) ||
           p.startsWith(join(homeDir, ".openclaw", "media"));
  }

  return createTasksRouter({
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => req.json().catch(() => null),
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const patternParts = pattern.split("/");
      const pathParts = pathname.split("/");
      if (patternParts.length !== pathParts.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(":")) {
          params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        } else if (patternParts[i] !== pathParts[i]) {
          return null;
        }
      }
      return params;
    },
    broadcast: () => {},
    broadcastToAll: () => {},
    getTopicBySessionKey: () => null,
    requestIdentity: () => null,
    isPathAllowed,
  } as never);
}

async function patchPreviewImage(
  router: RouteHandler,
  previewImage: unknown,
): Promise<Response> {
  const url = new URL(`http://127.0.0.1:3333/api/boards/${PROJECT_ID}/tasks/${TASK_ID}`);
  const req = new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewImage }),
  });
  const resp = await router(req, url, url.pathname, "PATCH");
  return resp ?? new Response("null", { status: 404 });
}

describe("PATCH preview_image: il file deve esistere sul disco", () => {
  let tmpDir: string;
  let mediaDir: string;

  // Usa una cartella temporanea per simulare HOME
  test("setup", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "preview-test-"));
    mediaDir = join(tmpDir, ".topics", "media");
    mkdirSync(mediaDir, { recursive: true });
  });

  test("path nell'allowlist ma inesistente sul disco: 400 con ragione", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "preview-patch-test-"));
    const mediaPath = join(tmpBase, ".topics", "media");
    mkdirSync(mediaPath, { recursive: true });
    const db = freshDb();
    const router = makeRouter(db, tmpBase);

    // Path nell'allowlist, estensione .png corretta, ma il file NON esiste
    const nonExistentPath = join(mediaPath, "task-previews", "ghost.png");
    const resp = await patchPreviewImage(router, nonExistentPath);
    const body = await resp.json() as { error?: string };

    expect(resp.status, "deve tornare 400, non 200").toBe(400);
    expect(body.error ?? "", "il messaggio deve nominare il campo previewImage").toContain("previewImage");

    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("stringa vuota: 200 (azzerare e' lecito)", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "preview-patch-empty-"));
    const db = freshDb();
    const router = makeRouter(db, tmpBase);

    const resp = await patchPreviewImage(router, "");
    expect(resp.status, "stringa vuota deve passare: azzeramento esplicito").toBe(200);

    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("path esistente nell'allowlist: 200", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "preview-patch-exists-"));
    const mediaPath = join(tmpBase, ".topics", "media");
    mkdirSync(mediaPath, { recursive: true });
    const db = freshDb();
    const router = makeRouter(db, tmpBase);

    // Crea il file reale
    const realPath = join(mediaPath, "task-preview-real.png");
    writeFileSync(realPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header

    const resp = await patchPreviewImage(router, realPath);
    expect(resp.status, "file esistente deve passare: 200").toBe(200);

    rmSync(tmpBase, { recursive: true, force: true });
  });
});
