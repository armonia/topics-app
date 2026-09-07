/**
 * THE SYNC, measured where it is supposed to hurt: how many times it goes to
 * the network, and what it says when the network says no.
 *
 * The fetch is replaced with a counter, so "pull, not a timer" stops being a
 * sentence in a comment and becomes a number: two reads inside the freshness
 * window are ONE request.
 *
 * @covers CAL-01, CAL-02
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, initDatabase } from "../db";
import { updateAppSettings } from "./app-settings";
import { agendaFrom, getAgenda, normalizeFeedUrl, probeFeed, resetCalendarCache } from "./calendar-feed";

let tmpRoot: string;
const realFetch = globalThis.fetch;

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "X-WR-CALNAME:Personal",
  "BEGIN:VEVENT",
  "UID:review@example.com",
  "SUMMARY:Design review",
  "DTSTART:20260908T090000Z",
  "DTEND:20260908T100000Z",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const NOW = Date.UTC(2026, 8, 8, 8, 0);

/** Count the calls and decide the answer, one case at a time. */
function stubFetch(answer: () => Response | Promise<Response>): { calls: () => number } {
  let calls = 0;
  // `as unknown as`: a stub answers the ONE overload the code under test uses,
  // and the full `typeof fetch` carries members (`preconnect`) that a stub has
  // no business implementing.
  globalThis.fetch = (async () => {
    calls++;
    return await answer();
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "calendar-feed-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  initDatabase(tmpRoot);
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

describe("the address", () => {
  test("webcal is the same feed under a scheme browsers invented", () => {
    expect(normalizeFeedUrl("webcal://calendar.example.com/basic.ics"))
      .toBe("https://calendar.example.com/basic.ics");
  });

  test("anything that is not http(s) is refused before it reaches the network", () => {
    expect(normalizeFeedUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeFeedUrl("not a url")).toBeNull();
    expect(normalizeFeedUrl("   ")).toBeNull();
  });
});

describe("nothing configured", () => {
  test("no request leaves the machine, and the answer says so", async () => {
    const stub = stubFetch(() => new Response(FEED));
    const agenda = await getAgenda({ now: NOW });
    expect(stub.calls()).toBe(0);
    expect(agenda.configured).toBe(false);
    expect(agenda.events).toHaveLength(0);
  });

  test("an address with the switch off is still off", async () => {
    updateAppSettings({ calendarFeedUrl: "https://calendar.example.com/basic.ics" });
    const stub = stubFetch(() => new Response(FEED));
    expect((await getAgenda({ now: NOW })).configured).toBe(false);
    expect(stub.calls()).toBe(0);
  });
});

describe("pull, not a timer", () => {
  beforeEach(() => {
    updateAppSettings({
      calendarEnabled: true,
      calendarFeedUrl: "https://calendar.example.com/basic.ics",
      calendarRefreshMinutes: 15,
      calendarHorizonDays: 7,
    });
  });

  test("two reads inside the window cost ONE request", async () => {
    const stub = stubFetch(() => new Response(FEED));
    const first = await getAgenda({ now: NOW });
    const second = await getAgenda({ now: NOW + 60_000 });
    expect(stub.calls()).toBe(1);
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
  });

  test("past the configured age it reads again", async () => {
    const stub = stubFetch(() => new Response(FEED));
    await getAgenda({ now: NOW });
    await getAgenda({ now: NOW + 16 * 60_000 });
    expect(stub.calls()).toBe(2);
  });

  test("a forced read skips the freshness check and nothing else", async () => {
    const stub = stubFetch(() => new Response(FEED));
    await getAgenda({ now: NOW });
    const forced = await getAgenda({ now: NOW + 60_000, force: true });
    expect(stub.calls()).toBe(2);
    expect(forced.events).toHaveLength(1);
  });

  test("a failure keeps the agenda already read, and says why", async () => {
    stubFetch(() => new Response(FEED));
    const good = await getAgenda({ now: NOW });
    expect(good.error).toBeNull();
    stubFetch(() => new Response("nope", { status: 503 }));
    const bad = await getAgenda({ now: NOW + 16 * 60_000 });
    expect(bad.events).toHaveLength(1);
    expect(bad.error).toContain("503");
    // The stamp is the last SUCCESSFUL read: a surface saying "as of 08:00" is
    // telling the truth, one showing the failure time would not be.
    expect(bad.syncedAt).toBe(good.syncedAt);
  });

  test("a page that is not a calendar is a reason, not a silent empty agenda", async () => {
    stubFetch(() => new Response("<html>sign in</html>"));
    const agenda = await getAgenda({ now: NOW });
    expect(agenda.error).toContain("calendar feed");
    expect(agenda.events).toHaveLength(0);
  });

  test("the feed URL never travels in the answer", async () => {
    stubFetch(() => new Response(FEED));
    const agenda = await getAgenda({ now: NOW });
    expect(JSON.stringify(agenda)).not.toContain("calendar.example.com");
  });
});

describe("the horizon", () => {
  test("it is the window the agenda is cut to", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:soon@example.com",
      "SUMMARY:Tomorrow",
      "DTSTART:20260909T090000Z",
      "DTEND:20260909T100000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:later@example.com",
      "SUMMARY:Next month",
      "DTSTART:20261001T090000Z",
      "DTEND:20261001T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(agendaFrom(feed, NOW, 7).events.map((e) => e.title)).toEqual(["Tomorrow"]);
    expect(agendaFrom(feed, NOW, 30).events.map((e) => e.title)).toEqual(["Tomorrow", "Next month"]);
  });
});

describe("testing an address before saving it", () => {
  test("a good feed answers with its own name and how much is in it", async () => {
    stubFetch(() => new Response(FEED));
    const probe = await probeFeed("https://calendar.example.com/basic.ics", NOW);
    expect(probe).toMatchObject({ ok: true, name: "Personal", events: 1 });
  });

  test("a bad address is a reason, and never a request", async () => {
    const stub = stubFetch(() => new Response(FEED));
    const probe = await probeFeed("file:///etc/passwd", NOW);
    expect(probe.ok).toBe(false);
    expect(stub.calls()).toBe(0);
  });
});
