/**
 * The two calendar routes, and the settings that feed them.
 *
 * What is proven here is the SHAPE of the answers a client draws from -- an
 * unconfigured calendar answers "not configured" instead of 404, a bad address
 * answers 200 with the reason instead of a 500 -- plus the two rules a person
 * can break from Settings: a dial out of its set, and turning the sync off
 * without losing the address.
 *
 * @covers CAL-01, CAL-05
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, initDatabase } from "../db";
import { getAppSettings, updateAppSettings } from "../services/app-settings";
import { resetCalendarCache } from "../services/calendar-feed";
import { createAppSettingsRouter } from "./app-settings";
import { createCalendarRouter } from "./calendar";
import type { AppContext } from "../types";

let tmpRoot: string;
let calendar: ReturnType<typeof createCalendarRouter>;
let settings: ReturnType<typeof createAppSettingsRouter>;
const realFetch = globalThis.fetch;

const FEED = [
  "BEGIN:VCALENDAR",
  "X-WR-CALNAME:Personal",
  "BEGIN:VEVENT",
  "UID:one@example.com",
  "SUMMARY:Design review",
  "DTSTART:20260908T090000Z",
  "DTEND:20260908T100000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function fakeCtx(): AppContext {
  return {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    broadcastToAll: () => {},
  } as unknown as AppContext;
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const req = new Request(`http://localhost${path}`);
  const url = new URL(req.url);
  const res = await calendar(req, url, url.pathname, "GET");
  if (!res) throw new Error("the route did not answer");
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const req = new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });
  const url = new URL(req.url);
  const res = await calendar(req, url, url.pathname, "POST");
  if (!res) throw new Error("the route did not answer");
  return { status: res.status, body: await res.json() };
}

async function put(body: unknown): Promise<{ status: number; body: any }> {
  const req = new Request("http://localhost/api/app-settings", { method: "PUT", body: JSON.stringify(body) });
  const res = await settings(req, new URL(req.url), "/api/app-settings", "PUT");
  if (!res) throw new Error("the route did not answer");
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "calendar-route-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  initDatabase(tmpRoot);
  calendar = createCalendarRouter(fakeCtx());
  settings = createAppSettingsRouter(fakeCtx());
});

afterAll(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* gone */ }
});

beforeEach(() => {
  resetCalendarCache();
  updateAppSettings({
    calendarEnabled: null, calendarFeedUrl: null,
    calendarRefreshMinutes: null, calendarHorizonDays: null,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("GET /api/calendar/agenda", () => {
  test("nothing configured is an answer, not an error", async () => {
    const r = await get("/api/calendar/agenda");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: false, events: [], error: null });
  });

  test("configured: the events come back without the address that produced them", async () => {
    globalThis.fetch = (async () => new Response(FEED)) as unknown as typeof fetch;
    await put({ calendarFeedUrl: "https://calendar.example.com/basic.ics", calendarEnabled: true, calendarHorizonDays: 30 });
    const r = await get("/api/calendar/agenda");
    expect(r.body.configured).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("calendar.example.com");
  });
});

describe("POST /api/calendar/probe", () => {
  test("a reachable feed answers with the calendar's own name", async () => {
    globalThis.fetch = (async () => new Response(FEED)) as unknown as typeof fetch;
    const r = await post("/api/calendar/probe", { url: "https://calendar.example.com/basic.ics" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, name: "Personal" });
  });

  test("a feed that refuses is 200 with the reason: the reason is the point of the button", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const r = await post("/api/calendar/probe", { url: "https://calendar.example.com/basic.ics" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain("404");
  });

  test("no address is a 400", async () => {
    const r = await post("/api/calendar/probe", {});
    expect(r.status).toBe(400);
  });
});

describe("the settings behind it", () => {
  test("a scheme that is not http is refused at the write, so it never reaches the network", async () => {
    const r = await put({ calendarFeedUrl: "file:///etc/passwd" });
    expect(r.status).toBe(400);
    expect(getAppSettings().calendarFeedUrl).toBeNull();
  });

  test("webcal is normalised on the way in", async () => {
    await put({ calendarFeedUrl: "webcal://calendar.example.com/basic.ics" });
    expect(getAppSettings().calendarFeedUrl).toBe("https://calendar.example.com/basic.ics");
  });

  test("a dial outside its set is refused instead of written and then disregarded", async () => {
    const r = await put({ calendarRefreshMinutes: 1 });
    expect(r.status).toBe(400);
    expect(getAppSettings().calendarRefreshMinutes).toBeNull();
  });

  test("turning the sync off does not throw the address away", async () => {
    await put({ calendarFeedUrl: "https://calendar.example.com/basic.ics", calendarEnabled: true });
    await put({ calendarEnabled: false });
    expect(getAppSettings().calendarEnabled).toBe(false);
    expect(getAppSettings().calendarFeedUrl).toBe("https://calendar.example.com/basic.ics");
  });

  test("a new address cannot be answered out of the previous calendar", async () => {
    globalThis.fetch = (async () => new Response(FEED)) as unknown as typeof fetch;
    await put({ calendarFeedUrl: "https://calendar.example.com/basic.ics", calendarEnabled: true, calendarHorizonDays: 30 });
    expect((await get("/api/calendar/agenda")).body.events.length).toBe(1);
    globalThis.fetch = (async () => new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR")) as unknown as typeof fetch;
    await put({ calendarFeedUrl: "https://calendar.example.com/other.ics" });
    expect((await get("/api/calendar/agenda")).body.events).toHaveLength(0);
  });
});
