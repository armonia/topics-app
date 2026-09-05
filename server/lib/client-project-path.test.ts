/**
 * The two exemptions, which are the reason this predicate is safe to apply to
 * four routes at once. Refusing loopback would break the folder picker of the
 * app running on this machine; refusing an agent would break a worktree
 * checkout. Neither of them gains anything from the gate: both already run
 * commands here.
 *
 * @covers PROJECT-11
 */
import { describe, expect, it, afterEach } from "bun:test";
import { clientProjectPathRefused } from "./client-project-path";

const OUTSIDE = "/private/etc";
const ctx = {
  requestIdentity: (req: Request) =>
    req.headers.get("x-test-paired") ? { role: "owner" as const, deviceId: "dev-1" } : null,
  resolveProjectPath: () => null,
};

const tokenBefore = process.env.GATEWAY_TOKEN;
afterEach(() => {
  if (tokenBefore === undefined) delete process.env.GATEWAY_TOKEN;
  else process.env.GATEWAY_TOKEN = tokenBefore;
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
    process.env.GATEWAY_TOKEN = "a-token-for-the-bridge";
    const req = new Request("http://x/api/projects", {
      headers: { "x-test-paired": "1", "x-gateway-token": "a-token-for-the-bridge" },
    });
    expect(clientProjectPathRefused(req, OUTSIDE, ctx)).toBe(false);
  });

  it("a wrong token is not a token", () => {
    process.env.GATEWAY_TOKEN = "a-token-for-the-bridge";
    const req = new Request("http://x/api/projects", {
      headers: { "x-test-paired": "1", "x-gateway-token": "nope" },
    });
    expect(clientProjectPathRefused(req, OUTSIDE, ctx)).toBe(true);
  });
});
