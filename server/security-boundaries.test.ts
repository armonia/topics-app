/**
 * Actual file routes and application context, with an isolated database and
 * project. The assertions inspect the outside directory as well as the reply:
 * refusing a request after writing outside the boundary is still a failure.
 *
 * @covers AUTHGATE-02
 * @covers PROJECT-11
 * @covers GUEST-03
 * @covers WIRE-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { AppContext, WSData } from "./types";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import { createFilesRouter } from "./routes/files";
import { upgradeWebSocket } from "./lib/ws-upgrade";
import { deviceP, dropGrant, hasGrant, putGrant } from "./lib/grants-query";
import { principalsRev } from "./lib/principals";

let root: string;
let project: string;
let outside: string;
let ctx: AppContext;
let files: ReturnType<typeof createFilesRouter>;
const envKeys = ["DATA_DIR", "TOPICS_DATA_DIR", "APP_DATA_DIR", "TOPICS_HOME", "GATEWAY_TOKEN"] as const;
const previous = new Map<string, string | undefined>();

beforeAll(() => {
  closeDatabase();
  root = realpathSync(mkdtempSync(join(tmpdir(), "topics-boundaries-")));
  for (const key of envKeys) previous.set(key, process.env[key]);
  process.env.DATA_DIR = join(root, "data");
  process.env.TOPICS_DATA_DIR = join(root, "state");
  process.env.APP_DATA_DIR = join(root, "appdata");
  process.env.TOPICS_HOME = join(root, "home");
  process.env.GATEWAY_TOKEN = "isolated-test-placeholder";
  project = join(root, "project");
  outside = join(root, "outside");
  mkdirSync(project); mkdirSync(outside);
  symlinkSync(outside, join(project, "escape"), "dir");
  ctx = createAppContext(join(import.meta.dir, ".."));
  ctx.projectStore.create({ name: "Fixture", slug: "fixture", path: project });
  files = createFilesRouter(ctx);
});

afterAll(() => {
  closeDatabase();
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function fileRequest(path: string, body: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return (await files(req, new URL(req.url), path, "POST"))!;
}

async function upload(relativePath?: string, emptyDirs: string[] = [], targetDir = project) {
  const form = new FormData();
  form.set("targetDir", targetDir);
  form.set("emptyDirs", JSON.stringify(emptyDirs));
  if (relativePath) {
    form.set("relativePaths", JSON.stringify([relativePath]));
    form.append("files", new File(["fixture-content"], "upload.txt"));
  }
  const req = new Request("http://localhost/api/files/upload", { method: "POST", body: form });
  return (await files(req, new URL(req.url), "/api/files/upload", "POST"))!;
}

describe("project filesystem boundary", () => {
  test("a new file under an escaping symlink is refused before creation", async () => {
    const res = await fileRequest("/api/files/create", { path: join(project, "escape", "new.txt") });
    expect(res.status).toBe(400);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });

  test("a new directory under an escaping symlink is refused", async () => {
    const res = await fileRequest("/api/files/create", { path: join(project, "escape", "nested", "dir"), type: "dir" });
    expect(res.status).toBe(400);
    expect(existsSync(join(outside, "nested"))).toBe(false);
  });

  test("rename refuses an escaping new destination and retains the source", async () => {
    const source = join(project, "rename-source.txt");
    writeFileSync(source, "keep");
    const res = await fileRequest("/api/files/rename", { oldPath: source, newPath: join(project, "escape", "renamed.txt") });
    expect(res.status).toBe(400);
    expect(readFileSync(source, "utf8")).toBe("keep");
    expect(existsSync(join(outside, "renamed.txt"))).toBe(false);
  });

  test("a dangling ancestor and a non-directory ancestor cannot become creation paths", async () => {
    symlinkSync(join(outside, "missing-directory"), join(project, "dangling-dir"), "dir");
    expect(ctx.resolveProjectPath(join(project, "dangling-dir", "new.txt"))).toBeNull();
    writeFileSync(join(project, "regular-file"), "keep");
    expect(ctx.resolveProjectPath(join(project, "regular-file", "new.txt"))).toBeNull();
    expect(existsSync(join(outside, "missing-directory"))).toBe(false);
  });

  test("upload refuses symlink destinations for files and empty directories", async () => {
    expect((await upload("escape/upload.txt")).status).toBe(400);
    expect(existsSync(join(outside, "upload.txt"))).toBe(false);
    expect((await upload(undefined, ["escape/upload-dir"])).status).toBe(400);
    expect(existsSync(join(outside, "upload-dir"))).toBe(false);
  });

  test("an upload conflict cannot redirect its generated filename through a dangling symlink", async () => {
    writeFileSync(join(project, "conflict.txt"), "keep");
    symlinkSync(join(outside, "conflict-target.txt"), join(project, "conflict (1).txt"), "file");
    expect((await upload("conflict.txt")).status).toBe(400);
    expect(readFileSync(join(project, "conflict.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(outside, "conflict-target.txt"))).toBe(false);
  });

  test("normal new descendants, internal symlinks and ordinary name conflicts still work", async () => {
    mkdirSync(join(project, "inside"));
    symlinkSync(join(project, "inside"), join(project, "internal-link"), "dir");
    expect((await fileRequest("/api/files/create", { path: join(project, "internal-link", "nested", "new.txt") })).status).toBe(200);
    expect(existsSync(join(project, "inside", "nested", "new.txt"))).toBe(true);
    expect((await upload("nested/upload.txt", ["empty"], join(project, "internal-link"))).status).toBe(200);
    expect((await upload("nested/upload.txt", [], join(project, "internal-link"))).status).toBe(200);
    expect(readFileSync(join(project, "inside", "nested", "upload (1).txt"), "utf8")).toBe("fixture-content");
    expect(existsSync(join(project, "inside", "empty"))).toBe(true);
  });
});

describe("device revocation across WebSocket transports", () => {
  test("every upgrade keeps its device, and revocation closes only that device on every transport", () => {
    const sockets: Array<{ data: WSData; closed: boolean; close: () => void }> = [];
    const server = {
      upgrade: (_req: Request, options: { data?: WSData }) => {
        const ws = { data: options.data!, closed: false, close() { ws.closed = true; } };
        sockets.push(ws);
        return true;
      },
    };
    for (const path of ["/ws", "/ws/terminal/fixture", "/ws/browser/fixture"]) {
      const req = new Request(`http://localhost${path}`);
      expect(upgradeWebSocket(req, path, server, { deviceId: "revoked", role: "owner" }, true)).toBeUndefined();
    }
    upgradeWebSocket(new Request("http://localhost/ws"), "/ws", server, { deviceId: "other", role: "owner" }, true);
    upgradeWebSocket(new Request("http://localhost/ws/terminal/local"), "/ws/terminal/local", server, null, false);
    try {
      for (const ws of sockets) ctx.deviceSockets.add(ws as unknown as ServerWebSocket<WSData>);
      ctx.wsClients.add(sockets[0] as unknown as ServerWebSocket<WSData>);
      expect(sockets.slice(0, 3).map(ws => ws.data.deviceId)).toEqual(["revoked", "revoked", "revoked"]);
      expect(ctx.closeDeviceSockets("revoked")).toBe(3);
      expect(sockets.map(ws => ws.closed)).toEqual([true, true, true, false, false]);
      expect(ctx.wsClients.size).toBe(1); // Non-chat transports never receive chat broadcasts.
    } finally {
      for (const ws of sockets) {
        ctx.deviceSockets.delete(ws as unknown as ServerWebSocket<WSData>);
        ctx.wsClients.delete(ws as unknown as ServerWebSocket<WSData>);
      }
    }
  });

  test("a reconnected guest keeps the downgraded role and a failed upgrade remains a failure", () => {
    let data: WSData | undefined;
    const server = { upgrade: (_req: Request, options: { data?: WSData }) => { data = options.data; return false; } };
    const req = new Request("http://localhost/ws");
    expect(upgradeWebSocket(req, "/ws", server, { deviceId: "guest", role: "guest" }, true)?.status).toBe(400);
    expect(data?.deviceRole).toBe("guest");
    expect(data?.deviceId).toBe("guest");
    expect(upgradeWebSocket(req, "/ws/browser/", server, null, false)?.status).toBe(400);
    expect(upgradeWebSocket(req, "/api/topics", server, null, false)).toBeNull();
  });
});

describe("multiplayer stream query cost", () => {
  test("only interested guests pay authorization queries, without losing legacy/focus delivery or revocation", () => {
    let reads = 0;
    const measuredDb = { query: new Proxy(ctx.db.query, {
      apply(query, _receiver, args) { reads++; return Reflect.apply(query, ctx.db, args); },
    }) };
    const topicId = "runtime-cost-topic";
    const subject = { kind: "device" as const, id: "runtime-cost-guest" };
    putGrant(ctx.db, subject, "topic", topicId, { grantedAt: 1 });
    ctx.setGuestBroadcastFilter({
      mayReceiveFrame: () => false, // Control frames stay private to owners.
      mayReadTopic(deviceId, id) {
        principalsRev(measuredDb); // The production filter reads this revision even with a warm principal cache.
        return hasGrant(measuredDb, deviceP(deviceId), "topic", id);
      },
    });
    const sockets: Array<{ data: WSData; readyState: number; sent: number; send: () => number }> = [];
    const socket = (id: string, options: Partial<WSData> = {}) => {
      const ws = { data: { id, deviceId: subject.id, deviceRole: "guest", focusedTopicId: null,
        lastPong: 0, openTopicIds: new Set<string>(), ...options } as WSData,
        readyState: 1, sent: 0, send() { ws.sent++; return 1; } };
      sockets.push(ws); ctx.wsClients.add(ws as unknown as ServerWebSocket<WSData>); return ws;
    };
    try {
      for (let i = 0; i < 100; i++) socket(`uninterested-${i}`);
      const opened = socket("opened", { openTopicIds: new Set([topicId]) });
      const denied = socket("denied", { deviceId: "runtime-cost-no-grant", openTopicIds: new Set([topicId]) });
      const legacy = socket("legacy", { openTopicIds: undefined });
      const focused = socket("focused", { focusedTopicId: topicId });
      const owner = socket("owner", { deviceId: null, deviceRole: null });
      const frame = { type: "stream:content_chunk" as const, topicId, sessionKey: "runtime-cost", content: "delta" };
      for (let i = 0; i < 10; i++) ctx.broadcastToTopicSubscribers(topicId, frame);
      console.log("RUNTIME-COST guest-filter", { guests: 104, frames: 10, authorizationReads: reads });
      expect([opened.sent, denied.sent, legacy.sent, focused.sent, owner.sent]).toEqual([10, 0, 10, 10, 0]);
      expect(sockets.slice(0, 100).every(ws => ws.sent === 0)).toBe(true);
      const readsBeforeRevoke = reads;
      dropGrant(ctx.db, subject, "topic", topicId);
      ctx.broadcastToTopicSubscribers(topicId, frame);
      expect([opened.sent, denied.sent, legacy.sent, focused.sent]).toEqual([10, 0, 10, 10]);
      ctx.broadcastToAll({ type: "presence:windows", windows: [] });
      expect(owner.sent).toBe(1); // Control broadcasts remain independent of topic subscriptions.
      expect(readsBeforeRevoke).toBe(80); // Four interested guests, two indexed reads, ten chunks.
    } finally {
      for (const ws of sockets) ctx.wsClients.delete(ws as unknown as ServerWebSocket<WSData>);
      ctx.setGuestBroadcastFilter(null);
      dropGrant(ctx.db, subject, "topic", topicId);
    }
  });
});
