/**
 * The two exemptions, which are the reason this predicate is safe to apply to
 * four routes at once. Refusing loopback would break the folder picker of the
 * app running on this machine; refusing an agent would break a worktree
 * checkout. Neither of them gains anything from the gate: both already run
 * commands here.
 *
 * @covers PROJECT-11
 */
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientProjectPathRefused } from "./client-project-path";

const OUTSIDE = "/private/etc";
const ctx = {
  requestIdentity: (req: Request) =>
    req.headers.get("x-test-paired") ? { role: "owner" as const, deviceId: "dev-1" } : null,
  resolveProjectPath: () => null,
};

// L'agente si presenta col token del demone, scritto in TOPICS_HOME.
const AGENT_TOKEN = "a".repeat(64);
const homeBefore = process.env.TOPICS_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "client-project-path-"));
  writeFileSync(join(home, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = home;
});
afterEach(() => {
  if (homeBefore === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = homeBefore;
  rmSync(home, { recursive: true, force: true });
});

describe("clientProjectPathRefused", () => {
  it("refuses a path outside every known project when a paired device asks", () => {
    const req = new Request("http://x/api/projects", { headers: { "x-test-paired": "1" } });
    expect(clientProjectPathRefused(req, OUTSIDE, ctx)).toBe(true);
  });

  it("lets loopback through: no device id, no gate", () => {
    expect(clientProjectPathRefused(new Request("http://x/api/projects"), OUTSIDE, ctx)).toBe(false);
  });

  it("lets an agent through on its token", () => {
    const req = new Request("http://x/api/projects", {
      headers: { "x-test-paired": "1", "x-daemon-token": AGENT_TOKEN },
    });
    expect(clientProjectPathRefused(req, OUTSIDE, ctx)).toBe(false);
  });

  it("a wrong token is not a token", () => {
    const req = new Request("http://x/api/projects", {
      headers: { "x-test-paired": "1", "x-daemon-token": "b".repeat(64) },
    });
    expect(clientProjectPathRefused(req, OUTSIDE, ctx)).toBe(true);
  });
});
