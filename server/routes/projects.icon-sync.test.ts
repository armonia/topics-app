/**
 * @covers PROJECT-14
 *
 * The icon routes carry the icon's VERSION, and asking for an icon is what
 * starts watching it.
 *
 *  - `GET /api/projects/icon` answers with an ETag (the version); the URL of the
 *    current version (`&v=`) may be kept for good, any other one is revalidated.
 *  - `POST /api/projects/icon-versions` tells a window, in one request, the
 *    version of every project it draws, behind the same gate as the GET.
 *  - Once a project has been asked about, a change on disk leaves as one
 *    `project:icon` frame, through the fan-out that only reaches the sockets
 *    seeing the project (`broadcastToProjectViewers`; who receives it is checked in
 *    tests/integration/project-broadcast-visibility.test.ts).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createProjectsRouter } from "./projects";
import { slackMs } from "../../tests/helpers/time-slack";

const BUDGET_MS = Math.min(slackMs(8_000), 25_000);
const POKE_MS = 400;

async function until(cond: () => boolean, poke?: () => void): Promise<boolean> {
  const deadline = Date.now() + BUDGET_MS;
  let nextPoke = Date.now() + POKE_MS;
  while (Date.now() < deadline) {
    if (cond()) return true;
    // A macOS folder watch is armed asynchronously: repeat the write instead
    // of hoping the first one landed after it.
    if (poke && Date.now() >= nextPoke) { poke(); nextPoke = Date.now() + POKE_MS; }
    await Bun.sleep(20);
  }
  return cond();
}

const svg = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"/>`;

let root: string;
let db: Database;
let topicPaths: string[];
/** How many times the known-project allowlist was built (each build reads the topics). */
let allowlistBuilds: number;
let frames: Array<Record<string, unknown>>;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "icon-sync-")));
  db = new Database(":memory:");
  db.run(`CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)`);
  db.run(`CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT)`);
  topicPaths = [];
  allowlistBuilds = 0;
  frames = [];
  const ctx = {
    db,
    OPENCLAW_DIR: join(root, ".openclaw"),
    loadTopics: () => (allowlistBuilds++, { topics: Object.fromEntries(topicPaths.map((p, i) => [`t${i}`, { projectPath: p }])) }),
    worktreeStore: { list: () => [] },
    projectStore: { list: () => [], getByPath: () => null },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute: () => null,
    errorResponse: (status: number, error: string) =>
      new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } }),
    broadcastToAll: () => {},
    broadcastToProjectViewers: (m: Record<string, unknown>) => { frames.push(m); },
  } as unknown as AppContext;
  router = createProjectsRouter(ctx) as typeof router;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function knownProject(name: string): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  topicPaths.push(p);
  return p;
}

function getIcon(dir: string, opts: { v?: string; ifNoneMatch?: string } = {}): Promise<Response | null> {
  const url = new URL(`http://x/api/projects/icon?path=${encodeURIComponent(dir)}${opts.v ? `&v=${opts.v}` : ""}`);
  const headers = opts.ifNoneMatch ? { "if-none-match": opts.ifNoneMatch } : undefined;
  return router(new Request(url, { headers }), url, "/api/projects/icon", "GET");
}

function versions(paths: unknown): Promise<Response | null> {
  const url = new URL("http://x/api/projects/icon-versions");
  const req = new Request(url, { method: "POST", body: JSON.stringify({ paths }), headers: { "content-type": "application/json" } });
  return router(req, url, "/api/projects/icon-versions", "POST");
}

describe("GET /api/projects/icon carries the version", () => {
  test("ETag = version; the versioned URL is immutable, the bare one is revalidated, and a match is a 304", async () => {
    const p = knownProject("app");
    writeFileSync(join(p, "favicon.svg"), svg(16));

    const bare = (await getIcon(p))!;
    expect(bare.status).toBe(200);
    const entityTag = bare.headers.get("etag")!;
    expect(entityTag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(bare.headers.get("cache-control")).toBe("no-cache");

    const version = entityTag.slice(1, -1);
    const pinned = (await getIcon(p, { v: version }))!;
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const stale = (await getIcon(p, { v: "0000000000000000" }))!;
    expect(stale.headers.get("cache-control")).toBe("no-cache");

    const revalidated = (await getIcon(p, { ifNoneMatch: entityTag }))!;
    expect(revalidated.status).toBe(304);

    writeFileSync(join(p, "favicon.svg"), svg(32));
    const changed = (await getIcon(p, { ifNoneMatch: entityTag }))!;
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(entityTag);
  });

  test("a project without an icon answers 204 that the browser may not keep", async () => {
    const p = knownProject("plain");
    const res = (await getIcon(p))!;
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("POST /api/projects/icon-versions", () => {
  test("folders outside the known projects cost one allowlist rebuild per request, not one each", async () => {
    knownProject("known");
    const strangers = Array.from({ length: 20 }, (_, i) => {
      const d = join(root, `stranger-${i}`);
      mkdirSync(d);
      return d;
    });
    const res = (await versions(strangers))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versions: {} });
    // One build from the cold cache, one forced rebuild for the misses.
    expect(allowlistBuilds).toBeLessThanOrEqual(2);
  });

  test("one answer for many projects, behind the same gate as the GET", async () => {
    const withIcon = knownProject("with-icon");
    writeFileSync(join(withIcon, "favicon.svg"), svg(16));
    const without = knownProject("without");
    const stranger = join(root, "stranger");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "favicon.svg"), svg(16));
    const missing = join(root, "missing");

    const res = (await versions([withIcon, without, stranger, missing, 42, "relative/path"]))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: Record<string, string | null> };
    const entityTag = (await getIcon(withIcon))!.headers.get("etag");
    expect(body.versions).toEqual({ [withIcon]: entityTag!.slice(1, -1), [without]: null, [missing]: null });
  });

  test("a body without paths is a 400", async () => {
    const url = new URL("http://x/api/projects/icon-versions");
    const req = new Request(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect((await router(req, url, "/api/projects/icon-versions", "POST"))!.status).toBe(400);
  });
});

describe("asking for an icon starts watching it", () => {
  test("after a GET, a favicon added on disk is pushed as project:icon, and its removal too", async () => {
    const p = knownProject("live");
    expect((await getIcon(p))!.status).toBe(204);

    // Only this project's frames: the router of an earlier test is still
    // watching ITS folder, which afterEach has just deleted.
    const mine = () => frames.filter((f) => f.path === p);
    const icon = join(p, "favicon.svg");
    let w = 16;
    writeFileSync(icon, svg(w));
    expect(await until(() => mine().some((f) => f.type === "project:icon" && f.version), () => writeFileSync(icon, svg(++w)))).toBe(true);

    unlinkSync(icon);
    expect(await until(() => mine().at(-1)?.version === null)).toBe(true);
    expect(mine().at(-1)).toEqual({ type: "project:icon", path: p, version: null });
  });

  test("the batch call watches too: a project never fetched by GET still gets its push", async () => {
    const p = knownProject("from-cache");
    await versions([p]);
    const icon = join(p, "favicon.svg");
    let w = 16;
    writeFileSync(icon, svg(w));
    expect(await until(() => frames.some((f) => f.type === "project:icon" && f.path === p), () => writeFileSync(icon, svg(++w)))).toBe(true);
  });
});
