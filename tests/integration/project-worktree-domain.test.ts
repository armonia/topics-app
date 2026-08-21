/**
 * Phase A integration test — exercises the full Project + Worktree
 * domain end-to-end against a fresh SQLite + a real on-disk git repo.
 *
 * Runs via `bun test tests/integration/project-worktree-domain.test.ts`.
 *
 * Why bun:test rather than Playwright: this layer is below the renderer
 * (no UI, no WS roundtrip needed for the domain logic). The hooks for
 * subscribing to broadcasts are independently exercised at the unit
 * level; here we focus on the server-side state machine, FK cascades,
 * and the materialise-to-disk flow that has the most invariants worth
 * pinning. Six Playwright spec files (10.1-10.6 in tasks.md) cover the
 * UI flows in a follow-up.
 *
 * The test isolates state by setting DATA_DIR and TOPICS_WORKTREES_DIR
 * to /tmp before importing utils.ts, which is when the singleton db is
 * resolved. Each describe block resets the directories so tests don't
 * cross-contaminate.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { PROJECT_ROOT, testTmpDir } from "./helpers";

/* DATA_DIR E' AMBIENTE CONDIVISO, e questo file lo scrive.
 *
 * `server/db.ts:17` risolve la cartella dati come `process.env.DATA_DIR ||
 * join(dataRoot, "data")`: l'ambiente vince sull'argomento esplicito. Bun
 * carica piu' file di test nello STESSO processo, quindi una scrittura non
 * restituita decide dove finisce il database di tutti i file caricati dopo.
 * Misurato il 21/08: due file lanciati insieme aprivano quattro volte lo
 * stesso db temporaneo di uno dei due, mentre da soli ne creavano di propri.
 * Qui la variabile serve davvero (non si passa da `initDatabase`), quindi si
 * RESTITUISCE invece di toglierla. */
const DATA_DIR_PRIMA = process.env.DATA_DIR;


// Isolation: must set env before the first import that calls initDatabase.
const TEST_REPO = testTmpDir("phase-a-repo");
const TEST_DATA = testTmpDir("phase-a-data");
const TEST_WT = testTmpDir("phase-a-wt");

function rmAll() {
  fs.rmSync(TEST_REPO, { recursive: true, force: true });
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  fs.rmSync(TEST_WT, { recursive: true, force: true });
}

function gitInit(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  fs.writeFileSync(`${dir}/README.md`, "# test\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
}

beforeAll(() => {
  rmAll();
  gitInit(TEST_REPO);
  process.env.DATA_DIR = TEST_DATA;
  process.env.TOPICS_WORKTREES_DIR = TEST_WT;
});
afterAll(() => {
  rmAll();
});

// Defer imports until env is set so initDatabase respects DATA_DIR.
// I nomi sono elencati invece di tenere il namespace del modulo: un `import()`
// il cui risultato non finisce in una destrutturazione è OPACO per il cancello
// sul codice morto, che da lì in poi considera usato ogni export di questi
// quattro moduli (10 in tutto). Il momento in cui la promessa parte non cambia:
// resta la valutazione di questo file. Guardia:
// `bun run check:deadcode-blindspots`.
const utilsPromise = (async () => {
  const { createAppContext } = await import("../../server/utils");
  return { createAppContext };
})();
const projectsRoutePromise = (async () => {
  const { createProjectsRouter } = await import("../../server/routes/projects");
  return { createProjectsRouter };
})();
const worktreesRoutePromise = (async () => {
  const { createWorktreesRouter } = await import("../../server/routes/worktrees");
  return { createWorktreesRouter };
})();
const namingPromise = (async () => {
  const { generateWorktreeName, NAME_REGEX } = await import("../../server/utils/worktree-naming");
  return { generateWorktreeName, NAME_REGEX };
})();

describe("Phase A · Project + Worktree domain", () => {

  describe("schema migrations applied", () => {
    test("projects + worktrees + topics.worktree_id columns exist", async () => {
      const { createAppContext } = await utilsPromise;
      const ctx = createAppContext(PROJECT_ROOT);
      const tableInfo = (table: string) =>
        ctx.db.query(`PRAGMA table_info('${table}')`).all() as { name: string }[];
      expect(tableInfo("projects").map(c => c.name)).toContain("slug");
      expect(tableInfo("worktrees").map(c => c.name)).toContain("abs_path");
      expect(tableInfo("topics").map(c => c.name)).toContain("worktree_id");
      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });
  });

  describe("ProjectStore", () => {
    test("creates a project, looks up by slug + path, lists active", async () => {
      const { createAppContext } = await utilsPromise;
      const ctx = createAppContext(PROJECT_ROOT);
      const project = ctx.projectStore.create({
        name: "Foo",
        slug: "foo-proj",
        path: TEST_REPO,
      });
      expect(project.id).toBeDefined();
      expect(project.archived).toBe(false);
      expect(ctx.projectStore.getBySlug("foo-proj")?.id).toBe(project.id);
      expect(ctx.projectStore.getByPath(TEST_REPO)?.id).toBe(project.id);
      expect(ctx.projectStore.list().length).toBeGreaterThan(0);
      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });

    test("rejects duplicate slug with SlugConflictError", async () => {
      const { createAppContext } = await utilsPromise;
      const { SlugConflictError } = await import("../../server/services/project-store");
      const ctx = createAppContext(PROJECT_ROOT);
      ctx.projectStore.create({ name: "Bar", slug: "dup-slug", path: TEST_REPO });
      expect(() =>
        ctx.projectStore.create({ name: "Bar2", slug: "dup-slug", path: TEST_REPO }),
      ).toThrow(SlugConflictError);
      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });

    test("archive / restore round-trip", async () => {
      const { createAppContext } = await utilsPromise;
      const ctx = createAppContext(PROJECT_ROOT);
      const project = ctx.projectStore.create({
        name: "Arc", slug: "arc-proj", path: TEST_REPO,
      });
      const archived = ctx.projectStore.archive(project.id);
      expect(archived?.archived).toBe(true);
      const restored = ctx.projectStore.restore(project.id);
      expect(restored?.archived).toBe(false);
      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });
  });

  describe("WorktreeManager — create → ready → delete", () => {
    test("full happy-path flow", async () => {
      const { createAppContext } = await utilsPromise;
      const ctx = createAppContext(PROJECT_ROOT);
      const project = ctx.projectStore.create({
        name: "Happy", slug: "happy-proj", path: TEST_REPO,
      });

      const wt = await ctx.worktreeManager.create({
        projectId: project.id,
        mode: "branch",
        baseRef: "main",
      });
      expect(wt.status).toBe("pending");
      expect(wt.branchName).toMatch(/^topics\//);

      const ready = await ctx.worktreeManager.awaitMaterialisation(wt.id, 8_000);
      expect(ready.status).toBe("ready");
      expect(fs.existsSync(ready.absPath)).toBe(true);

      const branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: ready.absPath, encoding: "utf-8",
      }).trim();
      expect(branch).toBe(ready.branchName!);

      const removed = await ctx.worktreeManager.delete(ready.id);
      expect(removed).toBe(true);
      expect(fs.existsSync(ready.absPath)).toBe(false);
      expect(ctx.worktreeStore.get(ready.id)).toBeNull();

      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });

    test("refuses creation from inside an existing worktree", async () => {
      const { createAppContext } = await utilsPromise;
      const { WorktreeRefusalError } = await import("../../server/services/worktree-manager");
      const ctx = createAppContext(PROJECT_ROOT);
      const parent = ctx.projectStore.create({
        name: "Parent", slug: "parent-proj", path: TEST_REPO,
      });
      const wt = await ctx.worktreeManager.create({
        projectId: parent.id, mode: "branch", baseRef: "main",
      });
      const ready = await ctx.worktreeManager.awaitMaterialisation(wt.id, 8_000);

      const nested = ctx.projectStore.create({
        name: "Nested", slug: "nested-proj", path: ready.absPath,
      });
      await expect(
        ctx.worktreeManager.create({ projectId: nested.id, mode: "branch", baseRef: "main" }),
      ).rejects.toThrow(WorktreeRefusalError);

      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });
  });

  describe("FK cascade + topic.worktree_id", () => {
    // @spec PROJECT-02
    // @spec WORKTREE-05
    test("deleting a worktree NULLs topics.worktree_id (FK ON DELETE SET NULL)", async () => {
      const { createAppContext } = await utilsPromise;
      const ctx = createAppContext(PROJECT_ROOT);

      const project = ctx.projectStore.create({
        name: "Cascade", slug: "cascade-proj", path: TEST_REPO,
      });
      const wt = await ctx.worktreeManager.create({
        projectId: project.id, mode: "branch", baseRef: "main",
      });
      const ready = await ctx.worktreeManager.awaitMaterialisation(wt.id, 8_000);

      // Insert a topic bound to this worktree using the existing
      // saveSingleTopic path via loadTopics + saveTopics (the same path
      // routes/topics.ts uses).
      const data = ctx.loadTopics();
      const topicId = crypto.randomUUID();
      data.topics[topicId] = {
        id: topicId, name: "T", slug: "t", parentId: null, links: [],
        sessionKey: "topic:" + topicId.slice(0, 8),
        color: "#fff", icon: "💬",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
        projectPath: TEST_REPO,
        worktreeId: ready.id,
      };
      ctx.saveTopics(data);

      const before = ctx.db
        .query("SELECT worktree_id FROM topics WHERE id = ?")
        .get(topicId) as { worktree_id: string };
      expect(before.worktree_id).toBe(ready.id);

      await ctx.worktreeManager.delete(ready.id);

      const after = ctx.db
        .query("SELECT worktree_id FROM topics WHERE id = ?")
        .get(topicId) as { worktree_id: string | null };
      expect(after.worktree_id).toBeNull();

      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });

    test("resolveTopicCwd prefers worktree.absPath when ready, else projectPath", async () => {
      const { createAppContext } = await utilsPromise;
      const ctx = createAppContext(PROJECT_ROOT);

      const project = ctx.projectStore.create({
        name: "Cwd", slug: "cwd-proj", path: TEST_REPO,
      });
      const wt = await ctx.worktreeManager.create({
        projectId: project.id, mode: "branch", baseRef: "main",
      });
      const ready = await ctx.worktreeManager.awaitMaterialisation(wt.id, 8_000);

      const boundTopic = {
        id: "t1", name: "T1", slug: "t1", parentId: null, links: [],
        sessionKey: "topic:t1", color: "#fff", icon: "💬",
        createdAt: "", updatedAt: "", archived: false,
        projectPath: TEST_REPO,
        worktreeId: ready.id,
      };
      const unboundTopic = { ...boundTopic, id: "t2", worktreeId: null };

      expect(ctx.resolveTopicCwd(boundTopic)).toBe(ready.absPath);
      expect(ctx.resolveTopicCwd(unboundTopic)).toBe(TEST_REPO);
      expect(ctx.resolveTopicCwd(null)).toBeNull();

      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });
  });

  describe("REST routes — happy + validation", () => {
    // @spec PROJECT-03
    test("POST /api/projects validates name+path, emits broadcast, returns 201", async () => {
      const { createAppContext } = await utilsPromise;
      const { createProjectsRouter } = await projectsRoutePromise;
      const ctx = createAppContext(PROJECT_ROOT);
      const captured: any[] = [];
      // `project:new` esce da `broadcastProject` (fan-out per socket, 092): il
      // frame è lo stesso, la porta no.
      (ctx as any).broadcastProject = (type: string, project: unknown) => captured.push({ type, project });
      (ctx as any).broadcastToAll = (m: any) => captured.push(m);
      const route = createProjectsRouter(ctx);

      const url = new URL("http://h/api/projects");
      const ok = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Route Test", path: TEST_REPO }),
      });
      const resp = await route(ok, url, "/api/projects", "POST");
      expect(resp?.status).toBe(201);

      const noPath = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      });
      const bad = await route(noPath, url, "/api/projects", "POST");
      expect(bad?.status).toBe(400);

      expect(captured.find(c => c.type === "project:new")).toBeDefined();
      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });

    test("POST /api/worktrees with invalid mode → 400; valid mode → 202 pending", async () => {
      const { createAppContext } = await utilsPromise;
      const { createProjectsRouter } = await projectsRoutePromise;
      const { createWorktreesRouter } = await worktreesRoutePromise;
      const ctx = createAppContext(PROJECT_ROOT);
      (ctx as any).broadcastToAll = () => {};
      const projects = createProjectsRouter(ctx);
      const worktrees = createWorktreesRouter(ctx);

      // Create a project first.
      const projUrl = new URL("http://h/api/projects");
      const projResp = await projects(
        new Request(projUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "WT Route", path: TEST_REPO }),
        }),
        projUrl,
        "/api/projects",
        "POST",
      );
      const project = (await projResp!.json()) as { id: string };

      const wtUrl = new URL("http://h/api/worktrees");
      const bad = await worktrees(
        new Request(wtUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project_id: project.id, mode: "fork", base_ref: "main" }),
        }),
        wtUrl,
        "/api/worktrees",
        "POST",
      );
      expect(bad?.status).toBe(400);

      const ok = await worktrees(
        new Request(wtUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project_id: project.id, mode: "branch", base_ref: "main" }),
        }),
        wtUrl,
        "/api/worktrees",
        "POST",
      );
      expect(ok?.status).toBe(202);

      // Wait for the background `git worktree add` to finish before
      // afterAll's `rmAll()` deletes TEST_REPO. Without this the materialise
      // promise races with cleanup and `git worktree add` fails with
      // "fatal: Unable to read current working directory" — the error is
      // caught by the manager and only surfaces as console noise.
      const okBody = (await ok!.json()) as { id: string };
      try {
        await ctx.worktreeManager.awaitMaterialisation(okBody.id, 5_000);
      } catch {
        // Swallow timeout / git failure — this test only asserts the HTTP
        // contract (400 vs 202); the materialise path is covered elsewhere.
      }

      const { closeDatabase } = await import("../../server/db");
      closeDatabase();
    });
  });

  describe("Naming generator (regression coverage)", () => {
    test("generates filesystem-safe names, NAME_REGEX-compliant", async () => {
      const { generateWorktreeName, NAME_REGEX } = await namingPromise;
      for (let i = 0; i < 200; i++) {
        const name = generateWorktreeName();
        expect(name).toMatch(NAME_REGEX);
        expect(name.length).toBeLessThan(31);
      }
    });
  });
});

afterAll(() => {
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_PRIMA;
});
