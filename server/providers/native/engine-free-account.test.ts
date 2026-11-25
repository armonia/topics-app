/**
 * The account engine's own word on whether a request can be served
 * (`engineHasFreeAccount`): the question that lifts a plan hold read off one
 * spent account while the engine rotates to another (18/11).
 *
 * @covers RESUME-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { engineHasFreeAccount } from "./base-url";

const saved = {
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  TOPICS_SWITCHBOARD_URL: process.env.TOPICS_SWITCHBOARD_URL,
};
let profiles: unknown = [];
let status = 200;
let engine: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  engine = Bun.serve({
    port: 0,
    fetch: (req) => new URL(req.url).pathname === "/api/profiles"
      ? new Response(JSON.stringify({ profiles }), { status })
      : new Response("not found", { status: 404 }),
  });
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  process.env.TOPICS_SWITCHBOARD_URL = `http://127.0.0.1:${engine.port}`;
});

afterAll(() => {
  engine.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// As the engine's `/api/profiles` lists them on 18/11: `limited` is its own
// selector's verdict (an account at 99% of its week is limited there, while
// `/api/proxy-status` still calls it available).
const noCap = { over: false };
const spent = { limited: true, blockKind: "quota-7d", disabled: false, expired: false, cap: noCap };
const free = { limited: false, blockKind: null, disabled: false, expired: false, cap: noCap };

describe("engineHasFreeAccount", () => {
  test("one spent account and one free: the engine can serve", async () => {
    profiles = [spent, free];
    status = 200;
    expect(await engineHasFreeAccount()).toBe(true);
  });

  test("every account spent, expired, disabled or over its cap: it cannot", async () => {
    profiles = [spent, { ...free, expired: true }, { ...free, disabled: true }, { ...free, cap: { over: true } }];
    status = 200;
    expect(await engineHasFreeAccount()).toBe(false);
  });

  test("an engine that answers an error or lists no account decides nothing", async () => {
    status = 500;
    expect(await engineHasFreeAccount()).toBeNull();
    status = 200;
    profiles = [];
    expect(await engineHasFreeAccount()).toBeNull();
  });

  test("a base URL off this machine has no local engine to ask", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    profiles = [free];
    expect(await engineHasFreeAccount()).toBeNull();
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  });
});
