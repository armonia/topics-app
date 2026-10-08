/**
 * A GUEST socket does not receive the picture sizes that `message:new` carries
 * for the owner, for files it could not read itself.
 *
 * `withFrameMediaSizes` (`server/utils.ts`) reads the size of every picture a
 * `message:new` names and puts it on the frame, before the fan-out filters the
 * sockets. `message:new` is in the guests' allowlist (`GUEST_SAFE_FRAMES`), so
 * a guest holding the chat receives the frame. The guest cannot fetch the
 * picture: `/uploads/` is not in `isGuestAllowedPath`, nor is `/api/media`. The
 * sizes would add what the guest could not read: that the file exists on the
 * owner's disk, and its size (verification V3, defect D2). `broadcastToAll`
 * sends guests the frame without `mediaSizes`.
 *
 * Positive control on the same event: the owner socket still receives the
 * sizes, and the guest socket receives the frame (so its silence on the sizes
 * is not a broadcast that never fired).
 *
 * @covers GUEST-04, CHAT-MEDIA-BOX-01
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { AppContext, WSData } from "./types";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import { frameResource, isGuestAllowedPath, isGuestSafeFrameType } from "./lib/grants";
import { deviceP, hasGrant, putGrant } from "./lib/grants-query";

let root: string;
let ctx: AppContext;
const envKeys = ["DATA_DIR", "TOPICS_DATA_DIR", "APP_DATA_DIR", "TOPICS_HOME", "GATEWAY_TOKEN"] as const;
const previous = new Map<string, string | undefined>();

/** The 33 bytes of a PNG that `imageShape` reads: signature and IHDR. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = 6;
  return b;
}

beforeAll(() => {
  closeDatabase();
  root = realpathSync(mkdtempSync(join(tmpdir(), "topics-guest-media-")));
  for (const key of envKeys) previous.set(key, process.env[key]);
  process.env.DATA_DIR = join(root, "data");
  process.env.TOPICS_DATA_DIR = join(root, "state");
  process.env.APP_DATA_DIR = join(root, "appdata");
  process.env.TOPICS_HOME = join(root, "home");
  process.env.GATEWAY_TOKEN = "isolated-test-placeholder";
  ctx = createAppContext(join(import.meta.dir, ".."));
});

afterAll(() => {
  closeDatabase();
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a guest holding the chat does not learn the size of a picture it cannot fetch", () => {
  mkdirSync(ctx.UPLOADS_DIR, { recursive: true });
  writeFileSync(join(ctx.UPLOADS_DIR, "owner-private.png"), pngHeader(1234, 567));
  const picture = "/uploads/owner-private.png";
  expect(isGuestAllowedPath(picture), "precondition: a guest cannot GET the picture").toBe(false);

  const topicId = "guest-media-topic";
  const guest = { kind: "device" as const, id: "guest-media-device" };
  putGrant(ctx.db, guest, "topic", topicId, { grantedAt: 1 });
  // The production rule (`guestMayReceiveFrame` in server.ts): type allowlist, then grant on the entity.
  ctx.setGuestBroadcastFilter({
    mayReceiveFrame(deviceId, message) {
      const type = (message as { type?: unknown }).type;
      if (typeof type !== "string" || !isGuestSafeFrameType(type)) return false;
      const resource = frameResource(message);
      return !!resource && hasGrant(ctx.db, deviceP(deviceId), resource.type, resource.id);
    },
    mayReadTopic: (deviceId, id) => hasGrant(ctx.db, deviceP(deviceId), "topic", id),
  });
  const received = new Map<string, string[]>();
  const socket = (id: string, data: Partial<WSData>) => {
    received.set(id, []);
    const ws = {
      data: { id, focusedTopicId: null, lastPong: 0, openTopicIds: new Set<string>(), ...data } as WSData,
      readyState: 1,
      send(payload: string) { received.get(id)!.push(String(payload)); return 1; },
    };
    ctx.wsClients.add(ws as unknown as ServerWebSocket<WSData>);
    return ws;
  };
  const owner = socket("owner", { deviceId: null, deviceRole: null });
  const guestWs = socket("guest", { deviceId: guest.id, deviceRole: "guest" });
  try {
    ctx.broadcastToAll({
      type: "message:new", topicId, sessionKey: "guest-media", role: "assistant", messageId: "m1",
      content: `here is the screenshot\nMEDIA:${picture}`, preview: "here is the screenshot",
    });
    const parse = (id: string) => (received.get(id) ?? []).map((p) => JSON.parse(p) as { type: string; mediaSizes?: unknown });
    const ownerFrame = parse("owner").find((f) => f.type === "message:new");
    const guestFrame = parse("guest").find((f) => f.type === "message:new");
    console.log("[guest-media-sizes] owner mediaSizes:", JSON.stringify(ownerFrame?.mediaSizes), "guest mediaSizes:", JSON.stringify(guestFrame?.mediaSizes));
    expect(ownerFrame, "control: the owner receives the frame").toBeDefined();
    expect(ownerFrame?.mediaSizes, "the owner still receives the sizes").toEqual({ [picture]: [1234, 567] });
    expect(guestFrame, "control: the guest holding the chat receives the frame").toBeDefined();
    expect(guestFrame?.mediaSizes, "the guest learned existence and size of a file it cannot fetch").toBeUndefined();
  } finally {
    ctx.wsClients.delete(owner as unknown as ServerWebSocket<WSData>);
    ctx.wsClients.delete(guestWs as unknown as ServerWebSocket<WSData>);
    ctx.setGuestBroadcastFilter(null);
  }
});
