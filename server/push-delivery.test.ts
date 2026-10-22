/**
 * @covers PUSH-05
 *
 * The wire of a web push, measured against a FAKE push service on loopback:
 * the request is really signed (VAPID, ES256) and really encrypted
 * (aes128gcm), and the test checks both the way Apple and the phone would:
 * it verifies the JWT with the public key and decrypts the body with the
 * subscriber's private key. No real push service and no real device is ever
 * contacted.
 *
 * Plus the log: one line per delivery, per failure (with the push service's
 * own reason) and per expired subscription, and a line when there is nobody
 * to send to, which is the state this install sat in with 0 rows.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { deliverPush, type DeliveryTarget, type VapidDetails } from "./push-delivery";
import { initDatabase, closeDatabase, getDatabase } from "./db";

// The decryptor web-push itself is built on, resolved from web-push's own
// location: it is what a receiving device does with the body.
const httpContentEncoding = createRequire(require.resolve("web-push"))("http_ece") as {
  decrypt: (buf: Buffer, params: { version: string; privateKey: ReturnType<typeof createECDH>; authSecret: Buffer }) => Buffer;
};

type Received = { path: string; method: string; headers: Headers; body: Buffer };
const received: Received[] = [];
/** What the fake push service answers, per path prefix. */
const answers: Record<string, { status: number; body: string }> = {
  "/ok/": { status: 201, body: "" },
  "/gone/": { status: 410, body: "" },
  "/broken/": { status: 403, body: '{"reason":"BadJwtToken"}' },
};

let fakeService: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  fakeService = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      received.push({ path, method: req.method, headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
      const prefix = Object.keys(answers).find((p) => path.startsWith(p));
      const a = prefix ? answers[prefix] : { status: 500, body: "unexpected path" };
      return new Response(a.body, { status: a.status });
    },
  });
  base = `http://127.0.0.1:${fakeService.port}`;
});

afterAll(() => {
  fakeService.stop(true);
});

beforeEach(() => {
  received.length = 0;
});

function subscriber() {
  const keyPair = createECDH("prime256v1");
  keyPair.generateKeys();
  const auth = randomBytes(16);
  return { keyPair, auth, p256dh: keyPair.getPublicKey().toString("base64url"), authB64: auth.toString("base64url") };
}

function vapid(): VapidDetails {
  const k = webpush.generateVAPIDKeys();
  return { subject: "mailto:push-test@example.com", publicKey: k.publicKey, privateKey: k.privateKey };
}

async function verifyVapidJwt(authorization: string, publicKey: string): Promise<Record<string, unknown>> {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(authorization);
  if (!m) throw new Error(`not a VAPID header: ${authorization}`);
  const [jwt, k] = [m[1], m[2]];
  expect(k).toBe(publicKey);
  const [h, p, s] = jwt.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(publicKey, "base64url"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(s, "base64url"),
    new TextEncoder().encode(`${h}.${p}`),
  );
  expect(ok).toBe(true);
  expect(JSON.parse(Buffer.from(h, "base64url").toString())).toMatchObject({ alg: "ES256", typ: "JWT" });
  return JSON.parse(Buffer.from(p, "base64url").toString());
}

describe("deliverPush: the request a push service receives", () => {
  test("is a POST signed with the VAPID key and encrypted for this one device", async () => {
    const sub = subscriber();
    const keys = vapid();
    const payload = { title: "Rifai lo schema", body: "Claude ha finito di rispondere", tag: "chat-end-t1", url: "/topic/t1", whenOpen: "native" };
    const lines: string[] = [];
    const target: DeliveryTarget = {
      endpoint: `${base}/ok/device-1`,
      keys_p256dh: sub.p256dh,
      keys_auth: sub.authB64,
      body: JSON.stringify(payload),
      label: "iPhone",
    };

    const summary = await deliverPush([target], { tag: "chat-end-t1", vapid: keys, onExpired: () => {}, log: (l) => lines.push(l) });

    expect(summary).toEqual({ delivered: 1, failed: 0, expired: [] });
    expect(received).toHaveLength(1);
    const req = received[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/ok/device-1");
    expect(req.headers.get("content-encoding")).toBe("aes128gcm");
    expect(req.headers.get("ttl")).toBe("86400");

    // The push service's check: the JWT verifies with the public key the
    // device subscribed with, and names this service as its audience.
    const claims = await verifyVapidJwt(req.headers.get("authorization") ?? "", keys.publicKey);
    expect(claims.aud).toBe(base);
    expect(claims.sub).toBe(keys.subject);
    expect(Number(claims.exp)).toBeGreaterThan(Date.now() / 1000);

    // The device's check: only its private key opens the body, and the body
    // is the payload the trigger built.
    const clear = httpContentEncoding.decrypt(req.body, { version: "aes128gcm", privateKey: sub.keyPair, authSecret: sub.auth });
    expect(JSON.parse(clear.toString("utf8"))).toEqual(payload);

    expect(lines).toContain(`[Push] delivered tag=chat-end-t1 to="iPhone" via=127.0.0.1:${fakeService.port} status=201`);
    expect(lines.at(-1)).toBe("[Push] tag=chat-end-t1 delivered 1/1");
  });

  test("a refusal is logged with the push service's own reason, and does not stop the other devices", async () => {
    const a = subscriber();
    const b = subscriber();
    const lines: string[] = [];
    const summary = await deliverPush([
      { endpoint: `${base}/broken/x`, keys_p256dh: a.p256dh, keys_auth: a.authB64, body: "{}", label: "iPhone" },
      { endpoint: `${base}/ok/y`, keys_p256dh: b.p256dh, keys_auth: b.authB64, body: "{}", label: "Mac" },
    ], { tag: "task-review-t9", vapid: vapid(), onExpired: () => {}, log: (l) => lines.push(l) });

    expect(summary.delivered).toBe(1);
    expect(summary.failed).toBe(1);
    expect(lines.some((l) => l.startsWith('[Push] FAILED tag=task-review-t9 to="iPhone"') && l.includes('status=403 reason={"reason":"BadJwtToken"}'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[Push] delivered tag=task-review-t9 to="Mac"'))).toBe(true);
    expect(lines.at(-1)).toBe("[Push] tag=task-review-t9 delivered 1/2, failed 1");
  });

  test("a subscription the service declares gone (410) is handed back for removal", async () => {
    const s = subscriber();
    const lines: string[] = [];
    const gone: string[] = [];
    const summary = await deliverPush(
      [{ endpoint: `${base}/gone/z`, keys_p256dh: s.p256dh, keys_auth: s.authB64, body: "{}", label: null }],
      { tag: "t", vapid: vapid(), onExpired: (e) => gone.push(e), log: (l) => lines.push(l) },
    );
    expect(gone).toEqual([`${base}/gone/z`]);
    expect(summary.expired).toEqual([`${base}/gone/z`]);
    expect(lines.some((l) => l.startsWith('[Push] expired tag=t to="unknown device"') && l.includes("status=410"))).toBe(true);
  });

  test("an unreachable push service is a logged failure, never a throw", async () => {
    const s = subscriber();
    const lines: string[] = [];
    const summary = await deliverPush(
      [{ endpoint: "http://127.0.0.1:1/unreachable", keys_p256dh: s.p256dh, keys_auth: s.authB64, body: "{}", label: "iPhone" }],
      { tag: "t", vapid: vapid(), onExpired: () => {}, log: (l) => lines.push(l) },
    );
    expect(summary.failed).toBe(1);
    expect(lines.some((l) => l.startsWith('[Push] FAILED tag=t to="iPhone" via=127.0.0.1:1 error='))).toBe(true);
  });

  test("with nobody subscribed it SAYS so, instead of returning in silence", async () => {
    const lines: string[] = [];
    const summary = await deliverPush([], { tag: "chat-end-t1", vapid: vapid(), onExpired: () => {}, log: (l) => lines.push(l) });
    expect(summary).toEqual({ delivered: 0, failed: 0, expired: [] });
    expect(lines).toEqual(["[Push] not sent tag=chat-end-t1: no subscribed device (push_subscriptions has no deliverable row)"]);
    expect(received).toHaveLength(0);
  });
});

describe("sendPushToAll: from the table to the wire", () => {
  let tmpRoot = "";
  const savedDataDir = process.env.TOPICS_DATA_DIR;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "push-delivery-test-"));
    // VAPID keys land in the state dir: keep them out of the checkout.
    process.env.TOPICS_DATA_DIR = tmpRoot;
    const migDir = join(tmpRoot, "server", "db", "migrations");
    mkdirSync(migDir, { recursive: true });
    const realMigDir = join(import.meta.dir, "db", "migrations");
    for (const f of readdirSync(realMigDir)) {
      if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
    }
    initDatabase(tmpRoot);
  });

  afterAll(() => {
    try { closeDatabase(); } catch {}
    if (savedDataDir === undefined) delete process.env.TOPICS_DATA_DIR;
    else process.env.TOPICS_DATA_DIR = savedDataDir;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("each enabled device gets its own payload with its own when-open preference; a gone one leaves the table", async () => {
    const { sendPushToAll } = await import("./push-service");
    const phone = subscriber();
    const mac = subscriber();
    const off = subscriber();
    const old = subscriber();
    const db = getDatabase();
    db.run("DELETE FROM push_subscriptions");
    const insert = (endpoint: string, s: ReturnType<typeof subscriber>, device: string, label: string, enabled: number, whenOpen: string) =>
      db.run(
        "INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, device_id, device_label, enabled, when_open) VALUES (?,?,?,?,?,?,?)",
        [endpoint, s.p256dh, s.authB64, device, label, enabled, whenOpen],
      );
    insert(`${base}/ok/phone`, phone, "dev-phone", "iPhone", 1, "native");
    insert(`${base}/ok/mac`, mac, "dev-mac", "Mac", 1, "in-app");
    insert(`${base}/ok/off`, off, "dev-off", "iPad", 0, "native");
    insert(`${base}/gone/old`, old, "dev-old", "iPhone", 1, "native");

    await sendPushToAll({ title: "💬 Rifai lo schema", body: "Claude ha finito di rispondere", tag: "chat-end-t1", url: "/topic/t1" });

    const byPath = new Map(received.map((r) => [r.path, r]));
    expect([...byPath.keys()].sort()).toEqual(["/gone/old", "/ok/mac", "/ok/phone"]);
    const open = (path: string, s: ReturnType<typeof subscriber>) =>
      JSON.parse(httpContentEncoding.decrypt(byPath.get(path)!.body, { version: "aes128gcm", privateKey: s.keyPair, authSecret: s.auth }).toString("utf8"));
    expect(open("/ok/phone", phone)).toEqual({ title: "💬 Rifai lo schema", body: "Claude ha finito di rispondere", tag: "chat-end-t1", url: "/topic/t1", whenOpen: "native" });
    expect(open("/ok/mac", mac).whenOpen).toBe("in-app");

    const left = (db.query("SELECT device_id FROM push_subscriptions ORDER BY device_id").all() as { device_id: string }[]).map((r) => r.device_id);
    expect(left).toEqual(["dev-mac", "dev-off", "dev-phone"]);
  });

  test("the first-boot VAPID keys, generated without web-push, are keys web-push accepts", async () => {
    // `initVapid` no longer loads the library at boot: it makes the pair itself
    // with node:crypto. Here the real library's validators read it back, and
    // the delivery test above has already signed and encrypted with it.
    const { initVapid, getVapidPublicKey } = await import("./push-service");
    const keys = initVapid();
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);
    expect(() => webpush.setVapidDetails("mailto:admin@example.com", keys.publicKey, keys.privateKey)).not.toThrow();
    expect(getVapidPublicKey()).toBe(keys.publicKey);
  });
});
