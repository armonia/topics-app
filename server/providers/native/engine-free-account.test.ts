/**
 * The account engine's own word on whether a request can be served
 * (`engineHasFreeAccount`): the question that lifts a plan hold read off one
 * spent account while the engine rotates to another (18/11).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { engineHasFreeAccount } from "./base-url";

const saved = {
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  TOPICS_SWITCHBOARD_URL: process.env.TOPICS_SWITCHBOARD_URL,
};
let accounts: unknown = [];
let status = 200;
let engine: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  engine = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ accounts, recentEvents: [] }), { status }),
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

const spent = { available: false, limited: true, expired: false };
const free = { available: true, limited: false, expired: false };

describe("engineHasFreeAccount", () => {
  test("one spent account and one free: the engine can serve", async () => {
    accounts = [spent, free];
    status = 200;
    expect(await engineHasFreeAccount()).toBe(true);
  });

  test("every account spent or expired: it cannot", async () => {
    accounts = [spent, { available: true, limited: false, expired: true }];
    status = 200;
    expect(await engineHasFreeAccount()).toBe(false);
  });

  test("an engine that answers an error or lists no account decides nothing", async () => {
    status = 500;
    expect(await engineHasFreeAccount()).toBeNull();
    status = 200;
    accounts = [];
    expect(await engineHasFreeAccount()).toBeNull();
  });

  test("a base URL off this machine has no local engine to ask", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    accounts = [free];
    expect(await engineHasFreeAccount()).toBeNull();
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  });
});
