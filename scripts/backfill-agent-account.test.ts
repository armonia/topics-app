// @covers AGENTS-REG-01
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { backfillAgentAccounts } from "./backfill-agent-account";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("backfillAgentAccounts", () => {
  test("writes the account only where it is missing, backed up", () => {
    const home = mkdtempSync(join(tmpdir(), "agents-registry-"));
    dirs.push(home);
    writeFileSync(join(home, "engine.json"), JSON.stringify({
      agents: { a: { workspace: "/ws/a" }, b: { workspace: "/ws/b", account: "already-own" } },
    }));

    const written = backfillAgentAccounts(home, { a: "sesta", b: "ignored-has-one-already" });

    expect(written).toEqual({ a: "sesta" });
    const engine = JSON.parse(readFileSync(join(home, "engine.json"), "utf8"));
    expect(engine.agents.a.account).toBe("sesta");
    expect(engine.agents.b.account).toBe("already-own");
    expect(readdirSync(join(home, "backups")).some((f) => f.startsWith("engine.json."))).toBe(true);
  });

  test("an unknown agent id is rejected, nothing written", () => {
    const home = mkdtempSync(join(tmpdir(), "agents-registry-"));
    dirs.push(home);
    writeFileSync(join(home, "engine.json"), JSON.stringify({ agents: { a: { workspace: "/ws/a" } } }));

    expect(() => backfillAgentAccounts(home, { ghost: "nope" })).toThrow("not found");
    const engine = JSON.parse(readFileSync(join(home, "engine.json"), "utf8"));
    expect(engine.agents.a.account).toBeUndefined();
  });
});
