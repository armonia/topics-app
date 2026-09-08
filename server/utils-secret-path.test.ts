/**
 * Installation credentials stay private even when the state root is an open
 * project. Exercise the real path gates and file/media routers on a temp DB;
 * no listener, provider request, or real credential is used.
 * @covers MP-SETUP-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "./db";
import { unwatchProjectFiles } from "./file-watcher";
import { createFilesRouter } from "./routes/files";
import { createMediaRouter } from "./routes/media";
import { saveApiProviderKey } from "./services/api-provider-credentials";
import type { AppContext, RouteHandler } from "./types";
import { createAppContext } from "./utils";

const envKeys = ["TOPICS_DATA_DIR", "DATA_DIR", "TOPICS_HOME", "APP_DATA_DIR", "OPENCLAW_DIR", "GATEWAY_TOKEN"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let root: string;
let ctx: AppContext;
let files: RouteHandler;
let media: RouteHandler;
let secretFile: string;
let mediaAlias: string;
const fakeCredential = "fixture-private-marker-never-a-real-key";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "topics-secret-path-")));
  process.env.TOPICS_DATA_DIR = root;
  process.env.DATA_DIR = join(root, "data");
  process.env.TOPICS_HOME = join(root, "topics-home");
  process.env.APP_DATA_DIR = join(root, "app-data");
  process.env.OPENCLAW_DIR = join(root, "app-data");
  process.env.GATEWAY_TOKEN = "fixture-gateway-token";
  closeDatabase();
  ctx = createAppContext(root);
  ctx.db.run("INSERT INTO ui_state (key, value) VALUES (?, ?)", [
    "secret-path-project", JSON.stringify({ id: `project:${root}` }),
  ]);
  saveApiProviderKey("openai", fakeCredential, root);
  secretFile = join(root, ".topics-secrets", "providers.json");
  writeFileSync(join(root, ".topics-secrets", "providers-pending.tmp"), fakeCredential);
  writeFileSync(join(root, "public-note.txt"), "public-marker\n");
  mkdirSync(join(root, ".topics-secrets-example"));
  writeFileSync(join(root, ".topics-secrets-example", "note.txt"), "public-marker\n");
  symlinkSync(secretFile, join(root, "credentials-alias.json"));
  symlinkSync(join(root, ".topics-secrets"), join(root, "private-alias"), "dir");
  mkdirSync(ctx.UPLOADS_DIR, { recursive: true });
  mediaAlias = join(ctx.UPLOADS_DIR, "image.json");
  symlinkSync(secretFile, mediaAlias);
  writeFileSync(join(ctx.UPLOADS_DIR, "note.txt"), "public-marker\n");
  files = createFilesRouter(ctx);
  media = createMediaRouter(ctx);
});

afterAll(() => {
  if (root) unwatchProjectFiles(root);
  closeDatabase();
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function get(router: RouteHandler, pathname: string, path: string, extra: Record<string, string> = {}): Promise<Response> {
  const url = new URL(pathname, "http://fixture.invalid");
  url.search = new URLSearchParams({ path, ...extra }).toString();
  const response = await router(new Request(url), url, pathname, "GET");
  if (!response) throw new Error(`Route did not handle ${pathname}`);
  return response;
}

describe("private Topics credentials at the shared file boundary", () => {
  test("denies the store, temporary writes, case variants, and symlink aliases", () => {
    for (const path of [
      secretFile,
      join(root, ".topics-secrets"),
      join(root, ".topics-secrets", "providers-pending.tmp"),
      join(root, ".topics-secrets", "new-file.json"),
      join(root, ".TOPICS-SECRETS", "providers.json"),
      join(root, "credentials-alias.json"),
      join(root, "private-alias", "providers.json"),
      mediaAlias,
    ]) {
      expect(ctx.resolveProjectPath(path)).toBeNull();
      expect(ctx.resolveSafePath(path, [root])).toBeNull();
      // Preview accepts the union of project and media paths. Both gates
      // must deny; rejecting only the first would leave the same file served.
      expect(ctx.isPathAllowed(path)).toBe(false);
    }
  });

  test("ordinary project and media files retain their existing access", () => {
    const note = join(root, "public-note.txt");
    expect(ctx.resolveProjectPath(note)).toBe(note);
    expect(ctx.resolveSafePath(note, [root])).toBe(note);
    expect(ctx.resolveProjectPath(join(root, ".topics-secrets-example", "note.txt"))).not.toBeNull();
    expect(ctx.isPathAllowed(join(ctx.UPLOADS_DIR, "note.txt"))).toBe(true);
    expect(ctx.isPathAllowed(join(ctx.UPLOADS_DIR, "future", "image.png"))).toBe(true);
    expect(ctx.resolveProjectPath(join(root, "future", "note.txt"))).not.toBeNull();
    expect(ctx.resolveSafePath(join(root, "future", "note.txt"), [root])).not.toBeNull();
  });

  test("file content and media return no credential bytes", async () => {
    for (const path of [secretFile, join(root, "credentials-alias.json"), mediaAlias]) {
      const content = await get(files, "/api/files/content", path);
      expect(content.status).toBe(400);
      expect(await content.text()).not.toContain(fakeCredential);
      const asset = await get(media, "/api/media", path);
      expect(asset.status).toBe(403);
      expect(await asset.text()).not.toContain(fakeCredential);
    }
    expect(await (await get(files, "/api/files/content", join(root, "public-note.txt"))).text()).toBe("public-marker\n");
    expect((await get(media, "/api/media", join(ctx.UPLOADS_DIR, "future.png"))).status).toBe(404);
  });

  test("recursive search cannot return secrets through the store or aliases", async () => {
    const response = await get(files, "/api/files/search", root, { q: fakeCredential });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
    const ordinary = await get(files, "/api/files/search", root, { q: "public-marker" });
    const body = await ordinary.json() as { results: Array<{ file: string }> };
    expect(body.results.map((result) => result.file)).toContain("public-note.txt");
    expect(body.results.map((result) => result.file)).toContain(".topics-secrets-example/note.txt");
  });

  test("file listings hide the reserved directory independently of gitignore", async () => {
    const response = await get(files, "/api/files", root, { depth: "1" });
    const entries = await response.json() as Array<{ name: string }>;
    expect(entries.map((entry) => entry.name)).not.toContain(".topics-secrets");
    expect(entries.map((entry) => entry.name)).toContain(".topics-secrets-example");
  });
});
